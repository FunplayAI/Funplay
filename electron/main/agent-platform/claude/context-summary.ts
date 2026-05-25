import { generateText } from 'ai';
import {
  buildSessionConversationTurns
} from '../../../../shared/project-sessions';
import {
  type AgentCoreMessagePart,
  type AiProvider,
  type ClaudeContextSummaryCoverage,
  type ChatMessage,
  type ProjectSession
} from '../../../../shared/types';
import { createLanguageModel } from '../../ai-provider';
import { generateOpenAiCompatibleText } from '../../openai-compatible-client';
import { normalizeProviderContextWindowTokens } from '../../provider-runtime-options';
import type { GenericAgentRuntimeParams } from '../types';
import { appendContextSummaryAudit, buildContextSummaryAudit } from '../context-summary-audit';
import {
  CLAUDE_CONTEXT_COMPACT_MIN_MESSAGES,
  CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP,
  CLAUDE_CONTEXT_COMPACT_TRIGGER_CHARS,
  CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CLAUDE_CONTEXT_COMPACT_TARGET_RATIO,
  CLAUDE_CONTEXT_MESSAGE_MAX_CHARS,
  CLAUDE_CONTEXT_SUMMARY_MAX_CHARS,
  CLAUDE_CONTEXT_SUMMARY_VERSION,
  CLAUDE_CONTEXT_COMPRESSION_MAX_FAILURES,
  CLAUDE_MODEL_CONTEXT_WINDOWS,
  CLAUDE_CONTEXT_LOOKUP_KEYS,
  claudeContextCompressionFailures,
  getClaudeRuntimeSession
} from './constants';
import { resolveClaudeCodeProvider } from './runtime';

export function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function compactLongText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.max(160, Math.floor(maxLength * 0.58));
  const tailLength = Math.max(120, maxLength - headLength - 64);
  return `${value.slice(0, headLength).trimEnd()}\n...[compact ${value.length - headLength - tailLength} chars]...\n${value.slice(-tailLength).trimStart()}`;
}

export function truncateSummaryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}...`;
}

export function getClaudeMessageOrdinal(message: ChatMessage, fallbackIndex: number): number {
  return typeof message.ordinal === 'number' && Number.isFinite(message.ordinal)
    ? Math.floor(message.ordinal)
    : fallbackIndex;
}

export function getClaudeMessageStorageRowId(message: ChatMessage): number | undefined {
  return typeof message.storageRowId === 'number' && Number.isFinite(message.storageRowId) && message.storageRowId > 0
    ? Math.floor(message.storageRowId)
    : undefined;
}

export function getClaudeRelevantMessages(session: ProjectSession): ChatMessage[] {
  return session.chat.filter((message) => message.role === 'user' || message.role === 'assistant');
}

export function resolveClaudeSummaryBoundaryRowId(session: ProjectSession, coverageOverride?: ClaudeContextSummaryCoverage): number | undefined {
  const coverage = coverageOverride ?? session.runtimeOverrides?.claudeContextSummaryCoverage;
  if (typeof coverage?.boundaryRowId === 'number' && Number.isFinite(coverage.boundaryRowId) && coverage.boundaryRowId > 0) {
    return Math.floor(coverage.boundaryRowId);
  }

  if (coverage?.toMessageId) {
    const matched = getClaudeRelevantMessages(session).find((message) => message.id === coverage.toMessageId);
    return matched ? getClaudeMessageStorageRowId(matched) : undefined;
  }

  return undefined;
}

export function resolveClaudeSummaryBoundaryOrdinal(session: ProjectSession, coverageOverride?: ClaudeContextSummaryCoverage): number | undefined {
  const coverage = coverageOverride ?? session.runtimeOverrides?.claudeContextSummaryCoverage;
  const messages = getClaudeRelevantMessages(session);
  if (typeof coverage?.boundaryOrdinal === 'number' && Number.isFinite(coverage.boundaryOrdinal)) {
    return Math.floor(coverage.boundaryOrdinal);
  }

  if (coverage?.toMessageId) {
    const index = messages.findIndex((message) => message.id === coverage.toMessageId);
    if (index >= 0) {
      return getClaudeMessageOrdinal(messages[index], index);
    }
  }

  if (coverage?.messageCount && coverage.messageCount > 0) {
    const index = Math.min(messages.length - 1, coverage.messageCount - 1);
    if (index >= 0) {
      return getClaudeMessageOrdinal(messages[index], index);
    }
  }

  const turnCount = session.runtimeOverrides?.claudeContextSummaryTurnCount;
  if (turnCount && turnCount > 0) {
    const index = Math.min(messages.length - 1, Math.max(0, turnCount * 2 - 1));
    if (index >= 0) {
      return getClaudeMessageOrdinal(messages[index], index);
    }
  }

  return undefined;
}

export function filterClaudeMessagesAfterSummaryBoundary(session: ProjectSession, coverageOverride?: ClaudeContextSummaryCoverage): ChatMessage[] {
  const messages = getClaudeRelevantMessages(session);
  const boundaryOrdinal = resolveClaudeSummaryBoundaryOrdinal(session, coverageOverride);
  const boundaryRowId = resolveClaudeSummaryBoundaryRowId(session, coverageOverride);
  if (boundaryOrdinal === undefined || (!coverageOverride && !session.runtimeOverrides?.claudeContextSummary?.trim())) {
    if (boundaryRowId !== undefined && (coverageOverride || session.runtimeOverrides?.claudeContextSummary?.trim())) {
      return messages.filter((message) => {
        const rowId = getClaudeMessageStorageRowId(message);
        return rowId === undefined || rowId > boundaryRowId;
      });
    }
    return messages;
  }

  return messages.filter((message, index) => getClaudeMessageOrdinal(message, index) > boundaryOrdinal);
}

export function normalizeClaudeHistoryPart(part: AgentCoreMessagePart, maxLength: number): string {
  if (part.kind === 'assistant_text') {
    return compactLongText(part.text, maxLength);
  }

  if (part.kind === 'assistant_thinking') {
    const text = compactLongText(part.thinking, Math.min(maxLength, 900));
    return `<prior-reasoning>${text}</prior-reasoning>`;
  }

  if (part.kind === 'tool_call') {
    const input = part.input ? compactLongText(JSON.stringify(part.input), Math.min(maxLength, 1200)) : '';
    return `<prior-tool-call id="${part.toolUseId}" name="${part.name}">${input}</prior-tool-call>`;
  }

  if (part.kind === 'tool_result' || part.kind === 'tool_error') {
    const content = compactLongText(part.kind === 'tool_error' ? part.error : part.content, Math.min(maxLength, 1200));
    return `<prior-tool-result tool_use_id="${part.toolUseId}" is_error="${part.kind === 'tool_error' ? 'true' : 'false'}">${content}</prior-tool-result>`;
  }

  if (part.kind === 'run_error') {
    return `<prior-run-error>${compactLongText(part.error, Math.min(maxLength, 1200))}</prior-run-error>`;
  }

  return '';
}

export function normalizeClaudeHistoryMessageContent(message: ChatMessage, indexFromEnd = 0): string {
  const maxLength = indexFromEnd <= 8 ? 5000 : 1400;
  const parts = message.metadata?.agentCoreParts;
  if (parts?.length) {
    return [...parts]
      .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt))
      .map((part) => normalizeClaudeHistoryPart(part, maxLength))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  return compactLongText(message.content, maxLength).trim();
}

export function formatClaudeSummaryMessage(message: ChatMessage): string {
  const role = message.role === 'assistant' ? 'Assistant' : 'User';
  const content = normalizeSummaryText(
    compactLongText(normalizeClaudeHistoryMessageContent(message), CLAUDE_CONTEXT_MESSAGE_MAX_CHARS)
  );

  if (!content) {
    return '';
  }

  return `- ${role}: ${content}`;
}

export function buildClaudeContextSummaryForSession(session: ProjectSession, options: {
  keepRecentMessages?: number;
  maxSummaryChars?: number;
} = {}): string | undefined {
  const keepRecentMessages = options.keepRecentMessages ?? CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP;
  const maxSummaryChars = options.maxSummaryChars ?? CLAUDE_CONTEXT_SUMMARY_MAX_CHARS;
  const previousSummary = session.runtimeOverrides?.claudeContextSummary?.trim();
  const previousCoverage = session.runtimeOverrides?.claudeContextSummaryCoverage;
  const previouslySummarizedMessages = Math.max(
    0,
    previousCoverage?.coveredMessageCount ??
      previousCoverage?.messageCount ??
      (session.runtimeOverrides?.claudeContextSummaryTurnCount ?? 0) * 2
  );
  const unsummarizedMessages = filterClaudeMessagesAfterSummaryBoundary(session);
  const olderMessages = unsummarizedMessages.slice(0, Math.max(0, unsummarizedMessages.length - keepRecentMessages));

  if (olderMessages.length < 4) {
    return previousSummary || undefined;
  }

  const lines = [
    `Summarized ${previouslySummarizedMessages + olderMessages.length} earlier chat messages for a fresh Claude runtime session.`,
    'Use this as continuity context; the most recent messages are still provided separately.'
  ];

  if (previousSummary) {
    lines.push('', 'Previous runtime summary:', truncateSummaryText(previousSummary, Math.floor(maxSummaryChars / 3)));
  }

  lines.push('', 'Earlier conversation highlights:');
  for (const message of olderMessages.slice(-40)) {
    const line = formatClaudeSummaryMessage(message);
    if (line) {
      lines.push(line);
    }
  }

  return appendContextSummaryAudit(
    truncateSummaryText(lines.join('\n'), maxSummaryChars),
    buildContextSummaryAudit(olderMessages),
    maxSummaryChars
  );
}

export function buildClaudeContextCoverage(session: ProjectSession, strategy: ClaudeContextSummaryCoverage['strategy']): ClaudeContextSummaryCoverage | undefined {
  const messages = getClaudeRelevantMessages(session);
  const previousCoverage = session.runtimeOverrides?.claudeContextSummaryCoverage;
  const previousCoveredCount = Math.max(
    0,
    previousCoverage?.coveredMessageCount ??
      previousCoverage?.messageCount ??
      (session.runtimeOverrides?.claudeContextSummaryTurnCount ?? 0) * 2
  );
  const previousBoundaryOrdinal = resolveClaudeSummaryBoundaryOrdinal(session);
  const previousBoundaryRowId = resolveClaudeSummaryBoundaryRowId(session);
  const uncoveredMessages = filterClaudeMessagesAfterSummaryBoundary(session);
  const messageCount = Math.max(0, uncoveredMessages.length - CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP);
  if (messageCount <= 0) {
    return session.runtimeOverrides?.claudeContextSummaryCoverage;
  }

  const coveredMessages = uncoveredMessages.slice(0, messageCount);
  const boundaryOrdinal = Math.max(
    previousBoundaryOrdinal ?? -1,
    ...coveredMessages.map((message) => getClaudeMessageOrdinal(message, messages.findIndex((item) => item.id === message.id)))
  );
  const coveredRowIds = coveredMessages
    .map(getClaudeMessageStorageRowId)
    .filter((value): value is number => typeof value === 'number');
  const boundaryRowId = coveredRowIds.length > 0
    ? Math.max(previousBoundaryRowId ?? -1, ...coveredRowIds)
    : previousBoundaryRowId;
  const coveredMessageCount = previousCoveredCount + coveredMessages.length;
  return {
    version: CLAUDE_CONTEXT_SUMMARY_VERSION,
    strategy,
    sourceRuntimeSessionId: session.runtimeOverrides?.claudeCodeSessionId,
    fromMessageId: coveredMessages[0]?.id,
    toMessageId: coveredMessages.at(-1)?.id,
    boundaryRowId: boundaryRowId && boundaryRowId > 0 ? boundaryRowId : undefined,
    boundaryOrdinal: Number.isFinite(boundaryOrdinal) ? boundaryOrdinal : undefined,
    coveredMessageCount,
    summaryInputMessageIds: coveredMessages.map((message) => message.id),
    messageCount: coveredMessageCount,
    turnCount: Math.ceil(coveredMessageCount / 2),
    generatedAt: new Date().toISOString(),
    audit: buildContextSummaryAudit(coveredMessages)
  };
}

export function buildClaudeProviderSummaryPrompt(session: ProjectSession, extractiveSummary: string): string {
  return [
    'Compress the following Funplay Claude runtime context for a future resumed coding session.',
    'Return a concise but complete engineering handoff summary. Preserve concrete files, decisions, TODOs, failures, and user preferences.',
    'Do not include markdown tables. Do not invent information.',
    '',
    'Existing extractive summary:',
    extractiveSummary,
    '',
    'Recent unsummarized messages are not included here and will be sent separately.'
  ].join('\n');
}

export function getClaudeCompressionKey(session: ProjectSession): string {
  return session.id;
}

export function canUseProviderContextCompressor(session: ProjectSession): boolean {
  return (claudeContextCompressionFailures.get(getClaudeCompressionKey(session)) ?? 0) < CLAUDE_CONTEXT_COMPRESSION_MAX_FAILURES;
}

export function recordClaudeContextCompressionFailure(session: ProjectSession): void {
  const key = getClaudeCompressionKey(session);
  claudeContextCompressionFailures.set(key, (claudeContextCompressionFailures.get(key) ?? 0) + 1);
}

export function recordClaudeContextCompressionSuccess(session: ProjectSession): void {
  claudeContextCompressionFailures.delete(getClaudeCompressionKey(session));
}

export function resetClaudeContextCompressionState(sessionId?: string): void {
  if (sessionId) {
    claudeContextCompressionFailures.delete(sessionId);
    return;
  }
  claudeContextCompressionFailures.clear();
}

export async function buildClaudeContextSummaryForSessionWithProvider(session: ProjectSession, options: {
  providerSummary?: (prompt: string) => Promise<string | undefined>;
  maxSummaryChars?: number;
} = {}): Promise<{
  summary: string;
  coverage?: ClaudeContextSummaryCoverage;
}> {
  const extractiveSummary = buildClaudeContextSummaryForSession(session, {
    maxSummaryChars: options.maxSummaryChars
  });
  if (!extractiveSummary) {
    return {
      summary: '',
      coverage: session.runtimeOverrides?.claudeContextSummaryCoverage
    };
  }

  if (options.providerSummary && canUseProviderContextCompressor(session)) {
    try {
      const providerSummary = (await options.providerSummary(buildClaudeProviderSummaryPrompt(session, extractiveSummary)))?.trim();
      if (providerSummary) {
        const coverage = buildClaudeContextCoverage(session, 'provider');
        recordClaudeContextCompressionSuccess(session);
        return {
          summary: appendContextSummaryAudit(
            truncateSummaryText(providerSummary, options.maxSummaryChars ?? CLAUDE_CONTEXT_SUMMARY_MAX_CHARS),
            coverage?.audit,
            options.maxSummaryChars ?? CLAUDE_CONTEXT_SUMMARY_MAX_CHARS
          ),
          coverage
        };
      }
      recordClaudeContextCompressionFailure(session);
    } catch {
      recordClaudeContextCompressionFailure(session);
      // Provider compression is best-effort; extractive summary is deterministic fallback.
    }
  }

  return {
    summary: extractiveSummary,
    coverage: buildClaudeContextCoverage(session, 'extractive')
  };
}

export function resolveClaudeContextSummary(params: GenericAgentRuntimeParams, override?: string): string | undefined {
  const overrideSummary = override?.trim();
  if (overrideSummary) {
    return overrideSummary;
  }

  return getClaudeRuntimeSession(params).runtimeOverrides?.claudeContextSummary?.trim() || undefined;
}

export function buildClaudeRecentTurnsForPrompt(params: GenericAgentRuntimeParams, coverageOverride?: ClaudeContextSummaryCoverage) {
  const session = getClaudeRuntimeSession(params);
  const uncoveredMessages = filterClaudeMessagesAfterSummaryBoundary(session, coverageOverride);
  const recentMessages = uncoveredMessages
    .slice(-CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP)
    .map((message, index, array) => ({
      ...message,
      content: normalizeClaudeHistoryMessageContent(message, array.length - 1 - index)
    }));
  return buildSessionConversationTurns(recentMessages, 6);
}

export function shouldUseProviderContextSummary(params: GenericAgentRuntimeParams): boolean {
  return Boolean(params.provider && process.env.FUNPLAY_CLAUDE_CONTEXT_SUMMARY_PROVIDER !== '0');
}

export function createProviderSummaryCallback(params: GenericAgentRuntimeParams): ((prompt: string) => Promise<string | undefined>) | undefined {
  if (!shouldUseProviderContextSummary(params) || !params.provider) {
    return undefined;
  }

  return async (prompt: string): Promise<string | undefined> => {
    if (params.provider?.protocol === 'openai-compatible') {
      const result = await generateOpenAiCompatibleText({
        provider: params.provider,
        system: 'You compress long coding-agent conversations into concise continuation summaries.',
        prompt,
        maxOutputTokens: 1600,
        abortSignal: params.abortSignal ? AbortSignal.any([params.abortSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
      });
      return result.text.trim() || undefined;
    }

    const result = await generateText({
      model: createLanguageModel(params.provider!),
      system: 'You compress long coding-agent conversations into concise continuation summaries.',
      prompt,
      maxOutputTokens: 1600,
      abortSignal: params.abortSignal ? AbortSignal.any([params.abortSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
    });
    return result.text.trim() || undefined;
  };
}

export function estimateClaudeTokenCount(value: string): number {
  if (!value) {
    return 0;
  }
  const asciiChars = value.replace(/[^\x00-\x7F]/g, '').length;
  const nonAsciiChars = value.length - asciiChars;
  return Math.ceil(asciiChars / 4 + nonAsciiChars * 0.9);
}

export function lookupClaudeContextWindow(model: string | undefined): number | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (CLAUDE_MODEL_CONTEXT_WINDOWS[normalized] !== undefined) {
    return CLAUDE_MODEL_CONTEXT_WINDOWS[normalized];
  }
  const matchedKey = CLAUDE_CONTEXT_LOOKUP_KEYS.find((key) => normalized.includes(key));
  return matchedKey ? CLAUDE_MODEL_CONTEXT_WINDOWS[matchedKey] : undefined;
}

export function resolveClaudeContextWindowTokens(provider?: AiProvider, options: { context1m?: boolean } = {}): number {
  if (options.context1m || process.env.FUNPLAY_CLAUDE_CONTEXT_1M === '1') {
    return 1_000_000;
  }
  const configured = normalizeProviderContextWindowTokens(provider?.contextWindowTokens);
  if (configured) {
    return configured;
  }

  const resolved = resolveClaudeCodeProvider(provider);
  const catalogMatch = provider?.availableModels?.find((entry) => {
    const modelId = entry.modelId.trim();
    const upstreamModelId = entry.upstreamModelId?.trim();
    return modelId === resolved.model || upstreamModelId === resolved.model || modelId === resolved.upstreamModel || upstreamModelId === resolved.upstreamModel;
  });
  if (catalogMatch?.capabilities?.contextWindow && catalogMatch.capabilities.contextWindow > 0) {
    return catalogMatch.capabilities.contextWindow;
  }
  return lookupClaudeContextWindow(resolved.roleModels.default) ??
    lookupClaudeContextWindow(resolved.upstreamModel) ??
    lookupClaudeContextWindow(resolved.model) ??
    lookupClaudeContextWindow(provider?.model) ??
    CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function estimateClaudeRelevantMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateClaudeTokenCount(normalizeClaudeHistoryMessageContent(message)),
    0
  );
}

export function shouldPrepareClaudeContextHandoff(params: GenericAgentRuntimeParams, options: {
  force?: boolean;
  promptCharCount?: number;
}): boolean {
  if (options.force) {
    return true;
  }

  const session = getClaudeRuntimeSession(params);
  const uncoveredMessages = filterClaudeMessagesAfterSummaryBoundary(session);
  const compactableMessages = uncoveredMessages.slice(0, Math.max(0, uncoveredMessages.length - CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP));
  if (compactableMessages.length < 4) {
    return false;
  }

  const contextWindow = resolveClaudeContextWindowTokens(params.provider, {
    context1m: Boolean(session.runtimeOverrides?.context1m)
  });
  const promptTokens = estimateClaudeTokenCount(params.message) + estimateClaudeTokenCount(params.context.runtimeSummary ?? '') +
    estimateClaudeTokenCount(params.context.executionPlanSummary ?? '') +
    estimateClaudeTokenCount(params.context.archivedSummary ?? '') +
    Math.ceil((options.promptCharCount ?? 0) / 4);
  const uncoveredTokens = estimateClaudeRelevantMessageTokens(uncoveredMessages);
  const compactableTokens = estimateClaudeRelevantMessageTokens(compactableMessages);
  const projectedTokens = promptTokens + uncoveredTokens;
  const tokenPressure = projectedTokens >= Math.floor(contextWindow * CLAUDE_CONTEXT_COMPACT_TARGET_RATIO);
  const backlogPressure =
    compactableTokens >= Math.min(12000, Math.floor(contextWindow * 0.08)) ||
    uncoveredMessages.length >= CLAUDE_CONTEXT_COMPACT_MIN_MESSAGES ||
    (options.promptCharCount ?? 0) >= CLAUDE_CONTEXT_COMPACT_TRIGGER_CHARS;

  return tokenPressure || backlogPressure;
}

export async function prepareClaudeContextHandoff(params: GenericAgentRuntimeParams, cwd: string, resumeSessionId: string | undefined, options: {
  force?: boolean;
  promptCharCount?: number;
} = {}): Promise<{
  summary: string;
  patch: Partial<NonNullable<ProjectSession['runtimeOverrides']>>;
} | undefined> {
  if (!shouldPrepareClaudeContextHandoff(params, options)) {
    return undefined;
  }

  const session = getClaudeRuntimeSession(params);
  const summaryResult = await buildClaudeContextSummaryForSessionWithProvider(session, {
    providerSummary: createProviderSummaryCallback(params)
  });
  const summary = summaryResult.summary;
  if (!summary) {
    return undefined;
  }

  return {
    summary,
    patch: {
      claudeCodeSessionId: '',
      claudeCodeSessionCwd: cwd,
      claudeContextSummary: summary,
      claudeContextSummaryUpdatedAt: new Date().toISOString(),
      claudeContextSummaryCoverage: summaryResult.coverage,
      claudeContextSummaryTurnCount: Math.max(
        session.runtimeOverrides?.claudeContextSummaryTurnCount ?? 0,
        summaryResult.coverage?.turnCount ?? Math.ceil(Math.max(0, getClaudeRelevantMessages(session).length - CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP) / 2)
      )
    }
  };
}
