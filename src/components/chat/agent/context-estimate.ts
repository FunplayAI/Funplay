import type { AgentCoreMessagePart, AiProvider, ChatMessage, PromptAttachment } from '../../../../shared/types';
import { resolveProviderTokenLimits } from '../../../../shared/provider-catalog';
import { agentCorePartsToPlainText } from '../../../../shared/agent-core-v2';
import { localize, type UiLanguage } from '../../../i18n';
import type { AgentContextUsageSummary } from '../ChatComposer';
import type { AgentPromptStreamState } from './agent-stream-state';

const TOKEN_ESTIMATE_CACHE_LIMIT = 5000;
const messageTokenEstimateByObject = new WeakMap<ChatMessage, {
  signature: string;
  tokens: number;
}>();
const messageTokenEstimateBySignature = new Map<string, number>();
const streamTokenEstimateBySignature = new Map<string, number>();

export function estimateCurrentSessionContextUsage(input: {
  messages: ChatMessage[];
  stream: AgentPromptStreamState | null;
  draft: string;
  attachments: PromptAttachment[];
  modelLabel: string;
  provider: AiProvider | null;
  language: UiLanguage;
}): AgentContextUsageSummary {
  const sessionTokens = input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const streamTokens = input.stream ? estimateStreamTokens(input.stream) : 0;
  const draftTokens = estimateTextTokens(input.draft);
  const attachmentTokens = estimateAttachmentTokens(input.attachments);
  const tokenBudget = resolveContextTokenBudget(input.modelLabel, input.provider);
  const usedTokens = Math.max(0, sessionTokens + streamTokens + draftTokens + attachmentTokens);
  const budgetLabel = describeContextBudget({
    language: input.language,
    modelLabel: input.modelLabel,
    provider: input.provider,
    tokenBudget
  });

  return {
    usedTokens,
    tokenBudget,
    percent: tokenBudget > 0 ? usedTokens / tokenBudget : 0,
    sessionTokens,
    draftTokens,
    attachmentTokens,
    streamTokens,
    messageCount: input.messages.length + (input.stream ? 1 : 0),
    modelLabel: input.modelLabel || 'model',
    budgetLabel
  };
}

function estimateMessageTokens(message: ChatMessage): number {
  const signature = createMessageTokenEstimateSignature(message);
  const cachedObject = messageTokenEstimateByObject.get(message);
  if (cachedObject?.signature === signature) {
    return cachedObject.tokens;
  }
  const cachedSignature = messageTokenEstimateBySignature.get(signature);
  if (typeof cachedSignature === 'number') {
    messageTokenEstimateByObject.set(message, {
      signature,
      tokens: cachedSignature
    });
    return cachedSignature;
  }

  const tokens = estimateTextTokens(getMessageTextForTokenEstimate(message)) + 4;
  rememberTokenEstimate(messageTokenEstimateBySignature, signature, tokens);
  messageTokenEstimateByObject.set(message, {
    signature,
    tokens
  });
  return tokens;
}

function getMessageTextForTokenEstimate(message: ChatMessage): string {
  if (message.role === 'assistant' && message.metadata?.agentCoreParts?.length) {
    return agentCorePartsToPlainText(message.metadata.agentCoreParts);
  }

  return message.content;
}

function estimateStreamTokens(stream: AgentPromptStreamState): number {
  const signature = createStreamTokenEstimateSignature(stream);
  const cached = streamTokenEstimateBySignature.get(signature);
  if (typeof cached === 'number') {
    return cached;
  }

  const tokens = estimateTextTokens(getStreamTextForTokenEstimate(stream));
  rememberTokenEstimate(streamTokenEstimateBySignature, signature, tokens);
  return tokens;
}

function getStreamTextForTokenEstimate(stream: AgentPromptStreamState): string {
  if (stream.agentCoreParts?.length) {
    return [
      stream.prompt,
      agentCorePartsToPlainText(stream.agentCoreParts)
    ].filter(Boolean).join('\n\n');
  }

  return [
    stream.prompt,
    stream.content,
    stream.thinkingContent,
    ...stream.toolUses.map((tool) => `${tool.name}\n${tool.input ? safeStringify(tool.input) : ''}`),
    ...stream.toolResults.map((result) => result.content)
  ].filter(Boolean).join('\n\n');
}

function rememberTokenEstimate(cache: Map<string, number>, signature: string, tokens: number): void {
  cache.set(signature, tokens);
  while (cache.size > TOKEN_ESTIMATE_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) {
      return;
    }
    cache.delete(firstKey);
  }
}

function createMessageTokenEstimateSignature(message: ChatMessage): string {
  const contentSignature = message.role === 'assistant' && message.metadata?.agentCoreParts?.length
    ? createAgentCorePartsTokenEstimateSignature(message.metadata.agentCoreParts)
    : createTextTokenEstimateSignature(message.content);
  return [
    message.id,
    message.role,
    message.createdAt,
    contentSignature
  ].join(':');
}

function createAgentCorePartsTokenEstimateSignature(parts: AgentCoreMessagePart[]): string {
  return parts
    .map((part) => `${part.id}:${part.kind}:${part.sequence}:${part.createdAt}:${createUnknownTokenEstimateSignature(part)}`)
    .join('|');
}

function createStreamTokenEstimateSignature(stream: AgentPromptStreamState): string {
  if (stream.agentCoreParts?.length) {
    return [
      stream.streamId,
      createTextTokenEstimateSignature(stream.prompt),
      createAgentCorePartsTokenEstimateSignature(stream.agentCoreParts)
    ].join(':');
  }

  return [
    stream.streamId,
    createTextTokenEstimateSignature(stream.prompt),
    createTextTokenEstimateSignature(stream.content),
    createTextTokenEstimateSignature(stream.thinkingContent),
    stream.toolUses.map((tool) => `${tool.toolUseId}:${tool.name}:${tool.status}:${createUnknownTokenEstimateSignature(tool.input)}`).join('|'),
    stream.toolResults.map((result) => `${result.toolUseId}:${result.isError ? '1' : '0'}:${createTextTokenEstimateSignature(result.content)}`).join('|')
  ].join(':');
}

function createTextTokenEstimateSignature(value: string): string {
  return `${value.length}:${value.slice(0, 16)}:${value.slice(-16)}`;
}

function createUnknownTokenEstimateSignature(value: unknown, depth = 0): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return `s:${createTextTokenEstimateSignature(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) {
    if (depth >= 2) return `array:${value.length}`;
    return `array:${value.length}:${value.slice(0, 8).map((item) => createUnknownTokenEstimateSignature(item, depth + 1)).join(',')}`;
  }
  if (typeof value === 'object') {
    if (depth >= 2) return 'object';
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([key, item]) => `${key}:${createUnknownTokenEstimateSignature(item, depth + 1)}`)
      .join(',');
  }
  return typeof value;
}

function estimateAttachmentTokens(attachments: PromptAttachment[]): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind === 'image') {
      return total + 1600;
    }
    return total + Math.min(6000, Math.ceil(attachment.size / 6));
  }, 0);
}

function estimateTextTokens(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const asciiChars = [...trimmed].filter((char) => char.charCodeAt(0) <= 0x7f).length;
  const nonAsciiChars = trimmed.length - asciiChars;
  return Math.ceil(asciiChars / 3.8 + nonAsciiChars / 1.6);
}

function resolveContextTokenBudget(modelLabel: string, provider: AiProvider | null): number {
  const resolvedLimits = provider ? resolveProviderTokenLimits(provider) : null;
  if (resolvedLimits?.effectiveContextWindowTokens) {
    return resolvedLimits.effectiveContextWindowTokens;
  }
  const model = modelLabel.toLowerCase();
  if (model.includes('gemini-1.5') || model.includes('gemini-2.5')) {
    return 1_048_576;
  }
  if (model.includes('gpt-4.1')) {
    return 1_047_576;
  }
  if (model.includes('gpt-5.4')) {
    return 1_050_000;
  }
  if (model.includes('gpt-5')) {
    return 400_000;
  }
  if (model.includes('claude')) {
    return 200_000;
  }
  if (model.includes('glm-5.1') || model.includes('glm-4.6')) {
    return 200_000;
  }
  if (model.includes('mimo-v2.5-pro') || model.includes('mimo-v2.5')) {
    return 1_000_000;
  }
  if (model.includes('mimo-v2-pro')) {
    return 131_072;
  }
  if (model.includes('mimo-v2-flash')) {
    return 65_536;
  }
  if (model.includes('mimo-v2-omni')) {
    return 32_768;
  }
  if (model.includes('deepseek')) {
    return 1_000_000;
  }
  if (model.includes('qwen') || model.includes('llama')) {
    return 128_000;
  }
  return 128_000;
}

function describeContextBudget(input: {
  language: UiLanguage;
  modelLabel: string;
  provider: AiProvider | null;
  tokenBudget: number;
}): string {
  const resolvedLimits = input.provider ? resolveProviderTokenLimits(input.provider) : null;
  const matchedLabel = resolvedLimits?.displayName || resolvedLimits?.modelId || input.modelLabel;
  const formattedBudget = formatCompactTokenLimit(input.tokenBudget);
  if (resolvedLimits?.configuredContextWindowTokens) {
    return localize(
      input.language,
      `上下文窗口按 Provider 自定义 ${formattedBudget} 估算`,
      `context window uses provider custom ${formattedBudget}`
    );
  }
  if (resolvedLimits?.presetContextWindowTokens) {
    return localize(
      input.language,
      `上下文窗口按 ${matchedLabel} 预设 ${formattedBudget} 估算`,
      `context window uses ${matchedLabel} preset ${formattedBudget}`
    );
  }
  return localize(
    input.language,
    `模型窗口按 ${input.modelLabel} 估算`,
    `window estimated for ${input.modelLabel}`
  );
}

function formatCompactTokenLimit(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
