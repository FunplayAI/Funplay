import type { ChatMediaBlock } from '../../../../shared/types';
import type { GenericAgentRuntimeParams } from '../types';

export interface ClaudeCollectorContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown> | string;
  tool_use_id?: string;
  content?: string | ClaudeCollectorContentBlock[];
  is_error?: boolean;
}

export interface ClaudeCollectorState {
  text: string;
  thinking: string;
  seenAssistantEvents: Set<string>;
  seenToolUses: Set<string>;
  seenToolResults: Set<string>;
  toolNamesByUseId: Map<string, string>;
  resultText: string;
  lastAssistantText: string;
  resultSessionId?: string;
  resultIsError?: boolean;
}

export interface ClaudeStreamCollector {
  state: ClaudeCollectorState;
  applyAssistantEvent(event: {
    uuid?: string;
    message?: {
      id?: string;
      content?: ClaudeCollectorContentBlock[];
    };
  }): void;
  applyUserEvent(event: {
    message?: {
      content?: ClaudeCollectorContentBlock[] | string;
    };
  }): void;
  applyStreamEvent(event: {
    event?: {
      type?: string;
      delta?: {
        text?: string;
        thinking?: string;
      };
    };
  }): void;
  applyResultEvent(event: {
    result?: string;
    session_id?: string;
    is_error?: boolean;
  }): void;
}

function getCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findSuffixPrefixOverlap(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let length = limit; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function shouldReplaceWithCorrectedFullText(current: string, incoming: string): boolean {
  const minLength = Math.min(current.length, incoming.length);
  const maxLength = Math.max(current.length, incoming.length);
  if (minLength < 8) {
    return false;
  }

  const commonPrefixLength = getCommonPrefixLength(current, incoming);
  const relativePrefixThreshold = Math.floor(minLength * 0.6);
  const prefixThreshold = Math.min(160, Math.max(12, relativePrefixThreshold));
  if (commonPrefixLength < prefixThreshold) {
    return false;
  }

  const lengthDelta = Math.abs(current.length - incoming.length);
  return lengthDelta <= Math.max(240, Math.floor(maxLength * 0.35));
}

function getCommonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[left.length - index - 1] === right[right.length - index - 1]) {
    index += 1;
  }
  return index;
}

function normalizeStreamingComparableText(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[，。,.!?！？：:；;、（）()【】[\]`"'“”‘’]/g, '')
    .replace(/^我(?=会|将|已经|已|先|现在|接下来|继续|主要|核心|开始|正在|准备|保持|保留|把|用|做|确认|处理|检查|看|读取|修改|补|完成)/, '');
}

function isLikelyTrailingRevision(existingTail: string, incoming: string): boolean {
  const left = normalizeStreamingComparableText(existingTail);
  const right = normalizeStreamingComparableText(incoming);
  const minLength = Math.min(left.length, right.length);
  const maxLength = Math.max(left.length, right.length);
  if (minLength < 8) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (right.endsWith(left) && left.length / right.length >= 0.72) {
    return true;
  }
  if (left.endsWith(right) && right.length / left.length >= 0.82) {
    return true;
  }

  const commonPrefixLength = getCommonPrefixLength(left, right);
  const commonSuffixLength = getCommonSuffixLength(left, right);
  const coverage = (commonPrefixLength + commonSuffixLength) / maxLength;
  const lengthDelta = Math.abs(left.length - right.length);
  return coverage >= 0.86 && lengthDelta <= Math.max(12, Math.floor(maxLength * 0.18));
}

function collectTrailingRevisionStarts(current: string, incomingLength: number): number[] {
  const starts = new Set<number>();
  const windowStart = Math.max(0, current.length - Math.max(1600, incomingLength * 2 + 64));
  if (current.length <= incomingLength + 64) {
    starts.add(0);
  }
  starts.add(Math.max(0, current.length - incomingLength - 16));
  starts.add(Math.max(0, current.length - incomingLength));

  for (let index = windowStart; index < current.length; index += 1) {
    const previous = current[index - 1];
    if (index === 0 || previous === '\n' || previous === '。' || previous === '！' || previous === '？' || previous === '!' || previous === '?') {
      starts.add(index);
    }
  }

  return [...starts]
    .filter((start) => start >= 0 && start < current.length)
    .sort((left, right) => right - left);
}

function replaceTrailingRevision(current: string, incoming: string): string | undefined {
  const trimmedCurrent = current.trimEnd();
  const trailingWhitespace = current.slice(trimmedCurrent.length);
  const trimmedIncoming = incoming.trim();
  if (!trimmedCurrent || !trimmedIncoming) {
    return undefined;
  }

  for (const start of collectTrailingRevisionStarts(trimmedCurrent, trimmedIncoming.length)) {
    const existingTail = trimmedCurrent.slice(start).trimStart();
    if (isLikelyTrailingRevision(existingTail, trimmedIncoming)) {
      const leadingWhitespace = trimmedCurrent.slice(start).match(/^\s*/)?.[0] ?? '';
      return `${trimmedCurrent.slice(0, start)}${leadingWhitespace}${incoming}${trailingWhitespace}`;
    }
  }

  return undefined;
}

function mergeIncrementalText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  if (current.endsWith(incoming)) return current;
  if (shouldReplaceWithCorrectedFullText(current, incoming)) return incoming;
  const trailingRevision = replaceTrailingRevision(current, incoming);
  if (trailingRevision) return trailingRevision;
  const overlapLength = findSuffixPrefixOverlap(current, incoming);
  if (overlapLength >= Math.min(80, Math.floor(incoming.length * 0.4))) {
    return `${current}${incoming.slice(overlapLength)}`;
  }
  return `${current}${incoming}`;
}

export function createClaudeStreamCollector(options: {
  onTextDelta?: GenericAgentRuntimeParams['onTextDelta'];
  onThinkingDelta?: GenericAgentRuntimeParams['onThinkingDelta'];
  onToolUse?: GenericAgentRuntimeParams['onToolUse'];
  onToolResult?: GenericAgentRuntimeParams['onToolResult'];
  normalizeToolInput?: (input: ClaudeCollectorContentBlock['input']) => Record<string, unknown> | undefined;
  extractToolResult?: (block: ClaudeCollectorContentBlock) => {
    content: string;
    media?: ChatMediaBlock[];
  };
}): ClaudeStreamCollector {
  const state: ClaudeCollectorState = {
    text: '',
    thinking: '',
    seenAssistantEvents: new Set<string>(),
    seenToolUses: new Set<string>(),
    seenToolResults: new Set<string>(),
    toolNamesByUseId: new Map<string, string>(),
    resultText: '',
    lastAssistantText: ''
  };

  const applyToolResultBlock = (block: ClaudeCollectorContentBlock, index: number): void => {
    const toolUseId = block.tool_use_id ?? `claude_tool_result_${index}`;
    if (state.seenToolResults.has(toolUseId)) {
      return;
    }

    state.seenToolResults.add(toolUseId);
    const extracted = options.extractToolResult?.(block) ?? {
      content: block.is_error ? 'Tool execution failed.' : 'Tool execution completed.'
    };
    const toolName = state.toolNamesByUseId.get(toolUseId);
    const result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0] = {
      toolUseId,
      content: extracted.content,
      isError: block.is_error,
      media: extracted.media
    };
    if (toolName) {
      result.toolName = toolName;
    }
    options.onToolResult?.(result);
    options.onToolUse?.({
      toolUseId,
      name: toolName ?? 'claude_tool',
      status: block.is_error ? 'failed' : 'completed'
    });
  };

  return {
    state,
    applyAssistantEvent(event) {
      const eventId = event.uuid ?? event.message?.id;
      if (eventId && state.seenAssistantEvents.has(eventId)) {
        return;
      }
      if (eventId) {
        state.seenAssistantEvents.add(eventId);
      }

      let nextText = state.text;
      let nextThinking = state.thinking;
      const assistantTextParts: string[] = [];
      for (const [index, block] of (event.message?.content ?? []).entries()) {
        if (block.type === 'text' && block.text) {
          assistantTextParts.push(block.text);
          nextText = mergeIncrementalText(nextText, block.text);
          continue;
        }
        if (block.type === 'thinking' && block.thinking) {
          nextThinking = mergeIncrementalText(nextThinking, block.thinking);
          continue;
        }
        if (block.type === 'tool_use') {
          const toolUseId = block.id ?? `claude_tool_${index}`;
          if (!state.seenToolUses.has(toolUseId)) {
            state.seenToolUses.add(toolUseId);
            const toolName = block.name ?? 'claude_tool';
            state.toolNamesByUseId.set(toolUseId, toolName);
            options.onToolUse?.({
              toolUseId,
              name: toolName,
              input: options.normalizeToolInput?.(block.input),
              status: 'running'
            });
          }
          continue;
        }
        if (block.type === 'tool_result') {
          applyToolResultBlock(block, index);
        }
      }

      if (nextThinking.length > state.thinking.length) {
        const delta = nextThinking.slice(state.thinking.length);
        state.thinking = nextThinking;
        options.onThinkingDelta?.(delta, nextThinking);
      }
      if (nextText !== state.text) {
        const delta = nextText.startsWith(state.text) ? nextText.slice(state.text.length) : nextText;
        state.text = nextText;
        options.onTextDelta?.(delta, nextText);
      }
      const assistantText = assistantTextParts.join('\n\n').trim();
      if (assistantText) {
        state.lastAssistantText = assistantText;
      }
    },
    applyUserEvent(event) {
      const content = event.message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const [index, block] of content.entries()) {
        if (block.type === 'tool_result') {
          applyToolResultBlock(block, index);
        }
      }
    },
    applyStreamEvent(event) {
      const delta = event.event?.delta;
      if (event.event?.type !== 'content_block_delta' || !delta) {
        return;
      }
      if (delta.text) {
        const nextText = mergeIncrementalText(state.text, delta.text);
      if (nextText !== state.text) {
        const textDelta = nextText.startsWith(state.text) ? nextText.slice(state.text.length) : nextText;
        state.text = nextText;
        options.onTextDelta?.(textDelta, nextText);
      }
      }
      if (delta.thinking) {
        const nextThinking = mergeIncrementalText(state.thinking, delta.thinking);
        if (nextThinking.length > state.thinking.length) {
          const thinkingDelta = nextThinking.slice(state.thinking.length);
          state.thinking = nextThinking;
          options.onThinkingDelta?.(thinkingDelta, nextThinking);
        }
      }
    },
    applyResultEvent(event) {
      state.resultText = event.result?.trim() ?? state.resultText;
      state.resultSessionId = event.session_id ?? state.resultSessionId;
      state.resultIsError = event.is_error ?? state.resultIsError;
    }
  };
}

export function resolveClaudeCollectorFinalText(state: ClaudeCollectorState): string {
  const resultText = state.resultText.trim();
  if (resultText) {
    return resultText;
  }

  const streamedText = state.text.trim();
  const lastAssistantText = state.lastAssistantText.trim();
  if (lastAssistantText && streamedText && streamedText !== lastAssistantText && streamedText.endsWith(lastAssistantText)) {
    return lastAssistantText;
  }

  return streamedText || lastAssistantText;
}
