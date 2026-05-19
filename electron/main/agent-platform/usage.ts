import type { RuntimeUsage, RuntimeUsageTotals } from '../../../shared/types';
import { nowIso } from '../../../shared/utils';

interface AiSdkUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
}

interface ClaudeSdkUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface OpenAiUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

interface NormalizeOptions {
  provider?: string;
  model?: string;
  recordedAt?: string;
}

function safeNumber(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export function normalizeAiSdkUsage(usage: AiSdkUsageLike | null | undefined, options: NormalizeOptions = {}): RuntimeUsage | null {
  if (!usage) {
    return null;
  }

  const inputTokens = safeNumber(usage.inputTokens);
  const outputTokens = safeNumber(usage.outputTokens);
  const cacheReadTokens = safeNumber(usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens);
  const cacheCreationTokens = safeNumber(usage.inputTokenDetails?.cacheWriteTokens);
  const reportedTotal = safeNumber(usage.totalTokens);
  const totalTokens = reportedTotal > 0
    ? reportedTotal
    : inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

  if (totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
    cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    totalTokens,
    recordedAt: options.recordedAt ?? nowIso(),
    provider: options.provider,
    model: options.model
  };
}

export function normalizeOpenAiUsage(raw: unknown, options: NormalizeOptions = {}): RuntimeUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const usage = raw as OpenAiUsageLike;
  const inputTokens = safeNumber(usage.prompt_tokens);
  const outputTokens = safeNumber(usage.completion_tokens);
  const cacheReadTokens = safeNumber(usage.prompt_tokens_details?.cached_tokens);
  const reportedTotal = safeNumber(usage.total_tokens);
  const totalTokens = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;

  if (totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    cacheCreationTokens: undefined,
    totalTokens,
    recordedAt: options.recordedAt ?? nowIso(),
    provider: options.provider,
    model: options.model
  };
}

export function normalizeClaudeSdkUsage(usage: ClaudeSdkUsageLike | null | undefined, options: NormalizeOptions = {}): RuntimeUsage | null {
  if (!usage) {
    return null;
  }

  const inputTokens = safeNumber(usage.input_tokens);
  const outputTokens = safeNumber(usage.output_tokens);
  const cacheCreationTokens = safeNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = safeNumber(usage.cache_read_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

  if (totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
    cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    totalTokens,
    recordedAt: options.recordedAt ?? nowIso(),
    provider: options.provider,
    model: options.model
  };
}

export function emptyUsageTotals(): RuntimeUsageTotals {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  };
}

export function accumulateUsage(totals: RuntimeUsageTotals, usage: RuntimeUsage): RuntimeUsageTotals {
  return {
    turns: totals.turns + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheCreationTokens: totals.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    totalTokens: totals.totalTokens + usage.totalTokens
  };
}
