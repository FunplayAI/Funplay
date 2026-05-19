import type { ProjectSessionEffort } from '../../../../shared/types';

export type ClaudeThinkingConfig =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted'; [key: string]: unknown }
  | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted'; [key: string]: unknown }
  | { type: 'disabled'; [key: string]: unknown };

export interface ClaudeModelOptionsInput {
  model?: string;
  thinking?: Record<string, unknown>;
  effort?: ProjectSessionEffort | string;
  context1m?: boolean;
}

export interface ClaudeModelOptionsOutput {
  thinking?: ClaudeThinkingConfig;
  effort?: string;
  applyContext1mBeta: boolean;
  isOpus47: boolean;
}

const OPUS_4_7_PATTERN = /opus-?4-?7/i;

export function isOpus47Model(model?: string): boolean {
  return Boolean(model?.trim() && OPUS_4_7_PATTERN.test(model));
}

function normalizeThinking(value?: Record<string, unknown>): ClaudeThinkingConfig | undefined {
  const type = typeof value?.type === 'string' ? value.type : undefined;
  if (type === 'adaptive' || type === 'enabled' || type === 'disabled') {
    return value as ClaudeThinkingConfig;
  }
  return undefined;
}

export function sanitizeClaudeModelOptions(input: ClaudeModelOptionsInput): ClaudeModelOptionsOutput {
  const isOpus47 = isOpus47Model(input.model);
  let thinking = normalizeThinking(input.thinking);

  if (isOpus47 && thinking) {
    if (thinking.type === 'enabled') {
      thinking = { type: 'adaptive', display: 'summarized' };
    } else if (thinking.type === 'adaptive' && !thinking.display) {
      thinking = { ...thinking, display: 'summarized' };
    }
  }

  return {
    thinking,
    effort: input.effort && input.effort !== 'auto' ? String(input.effort) : undefined,
    applyContext1mBeta: Boolean(input.context1m && !isOpus47),
    isOpus47
  };
}
