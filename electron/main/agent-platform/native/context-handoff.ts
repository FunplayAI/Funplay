import { generateText } from 'ai';
import { ensureProjectSessions, getActiveProjectSession, replaceProjectSession } from '../../../../shared/project-sessions';
import { getProviderPresetDefaults, resolveProviderUpstreamModel } from '../../../../shared/provider-catalog';
import type { AgentCoreMessagePart, AiProvider, ChatMessage, NativeContextSummaryCoverage, Project, ProjectSession } from '../../../../shared/types';
import { createLanguageModel } from '../../ai-provider';
import { generateOpenAiCompatibleText } from '../../openai-compatible-client';
import { normalizeProviderContextWindowTokens } from '../../provider-runtime-options';
import { appendContextSummaryAudit, buildContextSummaryAudit } from '../context-summary-audit';

const NATIVE_CONTEXT_SUMMARY_VERSION = 1;
const NATIVE_CONTEXT_RECENT_MESSAGE_COUNT = 8;
const NATIVE_CONTEXT_AUTO_BUDGET_RATIO = 0.68;
const NATIVE_CONTEXT_COMPRESSION_FAILURE_LIMIT = 3;
const EXTRACTIVE_SUMMARY_MAX_CHARS = 18_000;
const EXTRACTIVE_MESSAGE_MAX_CHARS = 900;

const compressionFailuresBySession = new Map<string, number>();

export interface NativeContextHandoffResult {
  summary: string;
  coverage: NativeContextSummaryCoverage;
  patch: Partial<NonNullable<ProjectSession['runtimeOverrides']>>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const marker = `...[${value.length - maxLength} chars omitted]...`;
  const headLength = Math.max(0, Math.ceil((maxLength - marker.length) * 0.65));
  const tailLength = Math.max(0, maxLength - marker.length - headLength);
  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ''}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function agentCorePartSummaryText(part: AgentCoreMessagePart): string {
  if (part.kind === 'assistant_text') {
    return part.text;
  }
  if (part.kind === 'tool_call') {
    return `[tool_use:${part.name}] ${JSON.stringify(part.input ?? {})}`;
  }
  if (part.kind === 'tool_result') {
    return `[tool_result:${part.toolUseId}] ${part.content}`;
  }
  if (part.kind === 'tool_error') {
    return `[tool_result:${part.toolUseId}] [error] ${part.error}`;
  }
  if (part.kind === 'run_error') {
    return `[run_error] ${part.error}`;
  }
  return '';
}

function messageText(message: ChatMessage): string {
  const parts = message.metadata?.agentCoreParts;
  if (!parts?.length) {
    return message.content;
  }

  const textParts = parts
    .map(agentCorePartSummaryText)
    .filter(Boolean);

  return textParts.join('\n');
}

function summarizeMessage(message: ChatMessage): string {
  const prefix = message.role === 'user' ? 'User' : 'Assistant';
  const text = truncateMiddle(compactWhitespace(messageText(message)), EXTRACTIVE_MESSAGE_MAX_CHARS);
  const markers = [
    message.storageRowId !== undefined ? `rowid=${message.storageRowId}` : undefined,
    message.ordinal !== undefined ? `ordinal=${message.ordinal}` : undefined
  ].filter(Boolean).join(', ');
  return `- ${prefix}${markers ? ` (${markers})` : ''}: ${text || '(empty)'}`;
}

function countTurns(messages: ChatMessage[]): number {
  const userCount = messages.filter((message) => message.role === 'user').length;
  return Math.max(1, userCount);
}

function hasAnyStorageRowId(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.storageRowId !== undefined);
}

function isMessageAfterCoverageBoundary(
  message: ChatMessage,
  coverage: NativeContextSummaryCoverage | undefined,
  useRowIdBoundary: boolean
): boolean {
  if (!coverage) {
    return true;
  }

  if (useRowIdBoundary && coverage.boundaryRowId !== undefined) {
    return message.storageRowId === undefined || message.storageRowId > coverage.boundaryRowId;
  }

  if (coverage.boundaryOrdinal !== undefined) {
    return message.ordinal === undefined || message.ordinal > coverage.boundaryOrdinal;
  }

  return true;
}

export function filterNativeMessagesAfterSummaryBoundary(
  messages: ChatMessage[],
  coverage?: NativeContextSummaryCoverage
): ChatMessage[] {
  const useRowIdBoundary = hasAnyStorageRowId(messages);
  return messages.filter((message) => isMessageAfterCoverageBoundary(message, coverage, useRowIdBoundary));
}

function getCompressibleMessages(session: ProjectSession): ChatMessage[] {
  const chat = session.chat ?? [];
  const coverage = session.runtimeOverrides?.nativeContextSummaryCoverage;
  const useRowIdBoundary = hasAnyStorageRowId(chat);
  return chat.filter((message) => {
    if (useRowIdBoundary && message.storageRowId === undefined) {
      return false;
    }
    return isMessageAfterCoverageBoundary(message, coverage, useRowIdBoundary);
  });
}

function resolveBoundary(messages: ChatMessage[]): Pick<NativeContextSummaryCoverage, 'boundaryRowId' | 'boundaryOrdinal' | 'toMessageId'> {
  const last = messages[messages.length - 1];
  return {
    boundaryRowId: last?.storageRowId,
    boundaryOrdinal: last?.ordinal,
    toMessageId: last?.id
  };
}

function resolveFromMessageId(messages: ChatMessage[]): string | undefined {
  return messages[0]?.id;
}

function resolveModelCandidates(provider?: AiProvider, session?: ProjectSession): string[] {
  return [
    session?.runtimeOverrides?.upstreamModel,
    session?.runtimeOverrides?.model,
    provider?.upstreamModel,
    provider?.model,
    provider ? resolveProviderUpstreamModel(provider) : undefined
  ]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];
}

export function resolveNativeContextWindowTokens(provider?: AiProvider, session?: ProjectSession): number {
  if (session?.runtimeOverrides?.context1m) {
    return 1_000_000;
  }
  const configured = normalizeProviderContextWindowTokens(provider?.contextWindowTokens);
  if (configured) {
    return configured;
  }

  const candidates = resolveModelCandidates(provider, session);
  const defaults = provider ? getProviderPresetDefaults(provider) : undefined;
  const modelCatalog = [
    ...(provider?.availableModels ?? []),
    ...(defaults?.availableModels ?? [])
  ];

  for (const candidate of candidates) {
    const match = modelCatalog.find((entry) => entry.modelId === candidate || entry.upstreamModelId === candidate);
    if (match?.capabilities?.contextWindow) {
      return match.capabilities.contextWindow;
    }
  }

  const marker = candidates.join(' ').toLowerCase();
  if (marker.includes('opus-4-7') || marker.includes('opus-4-8')) {
    return 1_000_000;
  }
  if (marker.includes('gpt-5.4')) {
    return 1_050_000;
  }
  if (marker.includes('gpt-5')) {
    return 400_000;
  }
  if (marker.includes('gpt-4.1')) {
    return 1_047_576;
  }
  if (marker.includes('gemini-1.5') || marker.includes('gemini-2.5') || marker.includes('gemini-3')) {
    return 1_048_576;
  }
  if (marker.includes('glm-5.1') || marker.includes('glm-4.6')) {
    return 200_000;
  }
  if (marker.includes('mimo-v2.5-pro') || marker.includes('mimo-v2.5')) {
    return 1_000_000;
  }
  if (marker.includes('mimo-v2-pro')) {
    return 131_072;
  }
  if (marker.includes('mimo-v2-flash')) {
    return 65_536;
  }
  if (marker.includes('mimo-v2-omni')) {
    return 32_768;
  }
  if (marker.includes('deepseek')) {
    return 1_000_000;
  }
  if (marker.includes('claude') || marker.includes('sonnet') || marker.includes('haiku') || marker.includes('opus')) {
    return 200_000;
  }
  return 128_000;
}

function estimateSessionContextTokens(session: ProjectSession, currentPrompt: string): number {
  const coverage = session.runtimeOverrides?.nativeContextSummaryCoverage;
  const summary = session.runtimeOverrides?.nativeContextSummary ?? '';
  const remaining = filterNativeMessagesAfterSummaryBoundary(session.chat ?? [], coverage);
  const historyText = remaining.map(messageText).join('\n\n');
  return estimateTokens([summary, historyText, currentPrompt].filter(Boolean).join('\n\n'));
}

export function shouldPrepareNativeContextHandoff(options: {
  session: ProjectSession;
  provider?: AiProvider;
  currentPrompt: string;
}): boolean {
  const windowTokens = resolveNativeContextWindowTokens(options.provider, options.session);
  const estimatedTokens = estimateSessionContextTokens(options.session, options.currentPrompt);
  return estimatedTokens >= Math.floor(windowTokens * NATIVE_CONTEXT_AUTO_BUDGET_RATIO);
}

function buildExtractiveNativeSummary(options: {
  previousSummary?: string;
  messages: ChatMessage[];
}): string {
  const lines = [
    options.previousSummary?.trim()
      ? `Previous native runtime long-context summary:\n${options.previousSummary.trim()}`
      : 'Native runtime long-context summary:',
    '',
    `Summarized ${options.messages.length} earlier chat message(s). Recent messages remain available in full detail.`,
    ...options.messages.map(summarizeMessage)
  ].filter((line) => line !== undefined);
  const summary = lines.join('\n');
  return summary.length > EXTRACTIVE_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, EXTRACTIVE_SUMMARY_MAX_CHARS)}\n\n[Native context summary truncated: exceeded ${EXTRACTIVE_SUMMARY_MAX_CHARS} chars]`
    : summary;
}

export function buildNativeContextSummaryForSession(options: {
  session: ProjectSession;
  provider?: AiProvider;
  currentPrompt?: string;
  force?: boolean;
  recentMessageCount?: number;
}): NativeContextHandoffResult | undefined {
  const recentMessageCount = Math.max(2, options.recentMessageCount ?? NATIVE_CONTEXT_RECENT_MESSAGE_COUNT);
  const compressible = getCompressibleMessages(options.session);
  const summaryBoundaryIndex = Math.max(0, compressible.length - recentMessageCount);
  const messagesToSummarize = compressible.slice(0, summaryBoundaryIndex);

  if (messagesToSummarize.length === 0) {
    return undefined;
  }

  if (!options.force && !shouldPrepareNativeContextHandoff({
    session: options.session,
    provider: options.provider,
    currentPrompt: options.currentPrompt ?? ''
  })) {
    return undefined;
  }

  const previousCoverage = options.session.runtimeOverrides?.nativeContextSummaryCoverage;
  const boundary = resolveBoundary(messagesToSummarize);
  if (
    previousCoverage?.boundaryRowId !== undefined &&
    boundary.boundaryRowId !== undefined &&
    boundary.boundaryRowId <= previousCoverage.boundaryRowId
  ) {
    return undefined;
  }
  if (
    previousCoverage?.boundaryRowId === undefined &&
    previousCoverage?.boundaryOrdinal !== undefined &&
    boundary.boundaryOrdinal !== undefined &&
    boundary.boundaryOrdinal <= previousCoverage.boundaryOrdinal
  ) {
    return undefined;
  }

  const previousSummary = options.session.runtimeOverrides?.nativeContextSummary;
  const audit = buildContextSummaryAudit(messagesToSummarize);
  const summary = appendContextSummaryAudit(buildExtractiveNativeSummary({
    previousSummary,
    messages: messagesToSummarize
  }), audit, EXTRACTIVE_SUMMARY_MAX_CHARS);
  const coveredMessageCount = (previousCoverage?.coveredMessageCount ?? previousCoverage?.messageCount ?? 0) + messagesToSummarize.length;
  const coverage: NativeContextSummaryCoverage = {
    version: NATIVE_CONTEXT_SUMMARY_VERSION,
    strategy: 'extractive',
    fromMessageId: resolveFromMessageId(messagesToSummarize),
    toMessageId: boundary.toMessageId,
    boundaryRowId: boundary.boundaryRowId,
    boundaryOrdinal: boundary.boundaryOrdinal,
    coveredMessageCount,
    summaryInputMessageIds: messagesToSummarize.map((message) => message.id),
    messageCount: coveredMessageCount,
    turnCount: (previousCoverage?.turnCount ?? 0) + countTurns(messagesToSummarize),
    generatedAt: new Date().toISOString(),
    audit
  };

  return {
    summary,
    coverage,
    patch: {
      nativeContextSummary: summary,
      nativeContextSummaryUpdatedAt: coverage.generatedAt,
      nativeContextSummaryCoverage: coverage,
      nativeContextSummaryTurnCount: coverage.turnCount
    }
  };
}

export function prepareNativeContextHandoff(options: {
  project: Project;
  sessionId?: string;
  provider?: AiProvider;
  currentPrompt: string;
  force?: boolean;
}): NativeContextHandoffResult | undefined {
  const ensured = ensureProjectSessions(options.project);
  const session =
    (options.sessionId ? ensured.sessions.find((item) => item.id === options.sessionId) : undefined) ??
    getActiveProjectSession(ensured);
  if (!session) {
    return undefined;
  }

  if (!options.force && (compressionFailuresBySession.get(session.id) ?? 0) >= NATIVE_CONTEXT_COMPRESSION_FAILURE_LIMIT) {
    return undefined;
  }

  try {
    const result = buildNativeContextSummaryForSession({
      session,
      provider: options.provider,
      currentPrompt: options.currentPrompt,
      force: options.force
    });
    if (result) {
      compressionFailuresBySession.delete(session.id);
    }
    return result;
  } catch (error) {
    compressionFailuresBySession.set(session.id, (compressionFailuresBySession.get(session.id) ?? 0) + 1);
    if (options.force) {
      throw error;
    }
    return undefined;
  }
}

const NATIVE_PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS = 1600;
const NATIVE_PROVIDER_SUMMARY_TIMEOUT_MS = 20_000;

export function shouldUseNativeProviderContextSummary(provider?: AiProvider): boolean {
  // Opt-in for now: default stays on the reliable extractive summary so existing
  // behavior and tests are unchanged. Enable model-generated summaries with
  // FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER=1 once eval confirms the quality win,
  // mirroring the claude-code-sdk runtime's provider summary path.
  return Boolean(provider && process.env.FUNPLAY_NATIVE_CONTEXT_SUMMARY_PROVIDER === '1');
}

function buildNativeProviderSummaryPrompt(extractiveSummary: string): string {
  return [
    'Rewrite the following extractive log of an earlier coding-agent conversation into a concise, faithful continuation summary.',
    'Preserve concrete facts: decisions made, files created or changed, commands run, current state, and any unfinished tasks.',
    'Do not invent details that are not present. Output only the summary text.',
    '',
    extractiveSummary
  ].join('\n');
}

async function generateNativeProviderSummary(
  provider: AiProvider,
  prompt: string,
  abortSignal?: AbortSignal
): Promise<string | undefined> {
  const system = 'You compress long coding-agent conversations into concise, faithful continuation summaries.';
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(NATIVE_PROVIDER_SUMMARY_TIMEOUT_MS)])
    : AbortSignal.timeout(NATIVE_PROVIDER_SUMMARY_TIMEOUT_MS);
  if (provider.protocol === 'openai-compatible') {
    const result = await generateOpenAiCompatibleText({
      provider,
      system,
      prompt,
      maxOutputTokens: NATIVE_PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS,
      abortSignal: signal
    });
    return result.text.trim() || undefined;
  }
  const result = await generateText({
    model: createLanguageModel(provider),
    system,
    prompt,
    maxOutputTokens: NATIVE_PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS,
    abortSignal: signal
  });
  return result.text.trim() || undefined;
}

// Async variant of prepareNativeContextHandoff that, when enabled, replaces the
// extractive summary with a model-generated one (strategy: 'provider'). Any
// failure falls back to the extractive result, so this never regresses the
// reliable path.
export async function prepareNativeContextHandoffWithModelSummary(options: {
  project: Project;
  sessionId?: string;
  provider?: AiProvider;
  currentPrompt: string;
  force?: boolean;
  abortSignal?: AbortSignal;
}): Promise<NativeContextHandoffResult | undefined> {
  const extractive = prepareNativeContextHandoff(options);
  if (!extractive || !options.provider || !shouldUseNativeProviderContextSummary(options.provider)) {
    return extractive;
  }
  try {
    const modelSummary = await generateNativeProviderSummary(
      options.provider,
      buildNativeProviderSummaryPrompt(extractive.summary),
      options.abortSignal
    );
    if (!modelSummary) {
      return extractive;
    }
    const summary = appendContextSummaryAudit(modelSummary, extractive.coverage.audit, EXTRACTIVE_SUMMARY_MAX_CHARS);
    const coverage: NativeContextSummaryCoverage = { ...extractive.coverage, strategy: 'provider' };
    return {
      summary,
      coverage,
      patch: {
        ...extractive.patch,
        nativeContextSummary: summary,
        nativeContextSummaryCoverage: coverage
      }
    };
  } catch {
    return extractive;
  }
}

export function applyNativeContextPatchToProject(
  project: Project,
  sessionId: string,
  patch: Partial<NonNullable<ProjectSession['runtimeOverrides']>>
): Project {
  const ensured = ensureProjectSessions(project);
  const session = ensured.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return ensured;
  }
  return replaceProjectSession(
    ensured,
    {
      ...session,
      runtimeOverrides: {
        ...session.runtimeOverrides,
        ...patch
      }
    },
    sessionId
  );
}

export function resetNativeContextCompressionState(sessionId?: string): void {
  if (sessionId) {
    compressionFailuresBySession.delete(sessionId);
    return;
  }
  compressionFailuresBySession.clear();
}

export function hasNativeContextCompressionCircuitOpen(sessionId: string): boolean {
  return (compressionFailuresBySession.get(sessionId) ?? 0) >= NATIVE_CONTEXT_COMPRESSION_FAILURE_LIMIT;
}
