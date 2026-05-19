import type { AssistantContent, ModelMessage, ToolContent } from 'ai';
import type { AgentCoreMessagePart } from '../../../shared/types';
import type { OpenAiCompatibleToolCall, OpenAiCompatibleToolMessage } from '../openai-compatible-types';

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type ToolContentPart = ToolContent[number];

export interface AgentCoreReplayCursor {
  strategy: 'resume_after_last_completed_tool' | 'restart_prompt';
  partId?: string;
  toolUseId?: string;
  sequence?: number;
  createdAt?: string;
}

export interface AgentCoreReplaySnapshot {
  cursor: AgentCoreReplayCursor;
  stableParts: AgentCoreMessagePart[];
  pendingToolUseIds: string[];
  completedToolUseIds: string[];
  openAiCompatibleMessages: OpenAiCompatibleToolMessage[];
  aiSdkModelMessages: ModelMessage[];
}

function orderedParts(parts: AgentCoreMessagePart[]): AgentCoreMessagePart[] {
  return [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function hasText(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

function stringifyInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return input ?? {};
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatStructuredList(title: string, items: string[] | undefined): string[] {
  if (!items?.length) {
    return [];
  }
  return [
    `${title}:`,
    ...items.map((item) => `- ${item}`)
  ];
}

function formatContextSummaryPart(part: Extract<AgentCoreMessagePart, { kind: 'context_summary' }>): string {
  const structured = part.structured;
  if (!structured) {
    return `Context summary:\n${part.summary}`;
  }
  return [
    'Context summary:',
    part.summary,
    structured.goal ? `Goal: ${structured.goal}` : '',
    ...formatStructuredList('Completed work', structured.completedWork),
    ...formatStructuredList('Unfinished work', structured.unfinishedWork),
    ...formatStructuredList('Changed files', structured.changedFiles),
    ...formatStructuredList('Decisions', structured.decisions),
    ...formatStructuredList('Constraints', structured.constraints),
    ...formatStructuredList('Failed tools', structured.failedTools),
    structured.nextStep ? `Next step: ${structured.nextStep}` : ''
  ].filter(Boolean).join('\n');
}

function resolveToolResultId(part: AgentCoreMessagePart): string | undefined {
  return part.kind === 'tool_result' || part.kind === 'tool_error' ? part.toolUseId : undefined;
}

function resolveToolCallIds(part: AgentCoreMessagePart): string[] {
  if (part.kind !== 'tool_call') {
    return [];
  }
  return [part.toolUseId, part.providerCallId].filter((value): value is string => Boolean(value));
}

export function buildAgentCoreReplaySnapshot(parts: AgentCoreMessagePart[]): AgentCoreReplaySnapshot {
  const ordered = orderedParts(parts);
  const completedToolUseIds = ordered
    .map(resolveToolResultId)
    .filter((value): value is string => Boolean(value));
  const completedSet = new Set(completedToolUseIds);
  const pendingToolUseIds = ordered
    .filter((part) => part.kind === 'tool_call' && !resolveToolCallIds(part).some((id) => completedSet.has(id)))
    .map((part) => part.kind === 'tool_call' ? part.toolUseId : '')
    .filter(Boolean);
  const cursorPart = [...ordered]
    .reverse()
    .find((part) => part.kind === 'tool_result' || part.kind === 'tool_error');
  const cursor: AgentCoreReplayCursor = cursorPart
    ? {
        strategy: 'resume_after_last_completed_tool',
        partId: cursorPart.id,
        toolUseId: cursorPart.kind === 'tool_result' || cursorPart.kind === 'tool_error' ? cursorPart.toolUseId : undefined,
        sequence: cursorPart.sequence,
        createdAt: cursorPart.createdAt
      }
    : {
        strategy: 'restart_prompt'
      };
  const stableParts = typeof cursor.sequence === 'number'
    ? ordered.filter((part) => part.sequence <= cursor.sequence!)
    : ordered.filter((part) => part.kind !== 'tool_call' || !pendingToolUseIds.includes(part.toolUseId));

  return {
    cursor,
    stableParts,
    pendingToolUseIds,
    completedToolUseIds,
    openAiCompatibleMessages: agentCorePartsToOpenAiCompatibleMessages(stableParts),
    aiSdkModelMessages: agentCorePartsToAiSdkModelMessages(stableParts)
  };
}

export function agentCorePartsToOpenAiCompatibleMessages(parts: AgentCoreMessagePart[]): OpenAiCompatibleToolMessage[] {
  const messages: OpenAiCompatibleToolMessage[] = [];
  const assistantText: string[] = [];
  const assistantThinking: string[] = [];
  const assistantToolCalls: OpenAiCompatibleToolCall[] = [];
  const flushAssistant = (): void => {
    const content = assistantText.filter(hasText).join('\n\n').trim();
    const reasoningContent = assistantThinking.filter(hasText).join('\n\n').trim();
    if (!content && !reasoningContent && assistantToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: 'assistant',
      content: content || undefined,
      reasoningContent: reasoningContent || undefined,
      toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls.splice(0) : undefined
    });
    assistantText.length = 0;
    assistantThinking.length = 0;
  };
  const appendUserContext = (content: string): void => {
    flushAssistant();
    if (hasText(content)) {
      messages.push({
        role: 'user',
        content
      });
    }
  };

  for (const part of orderedParts(parts)) {
    if (part.kind === 'assistant_text') {
      assistantText.push(part.text);
      continue;
    }
    if (part.kind === 'assistant_thinking') {
      assistantThinking.push(part.thinking);
      continue;
    }
    if (part.kind === 'tool_call') {
      assistantToolCalls.push({
        id: part.providerCallId ?? part.toolUseId,
        name: part.name,
        arguments: stringifyInput(part.input)
      });
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      flushAssistant();
      messages.push({
        role: 'tool',
        toolCallId: part.toolUseId,
        name: part.toolName,
        content: part.kind === 'tool_error' ? part.error : part.content
      });
      continue;
    }
    if (part.kind === 'context_summary') {
      appendUserContext(formatContextSummaryPart(part));
      continue;
    }
    if (part.kind === 'run_error') {
      appendUserContext(`[Run error]\n${part.error}`);
    }
  }

  flushAssistant();
  return messages;
}

export function agentCorePartsToAiSdkModelMessages(parts: AgentCoreMessagePart[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const assistantParts: AssistantContentPart[] = [];
  const flushAssistant = (): void => {
    if (assistantParts.length === 0) {
      return;
    }
    messages.push({
      role: 'assistant',
      content: assistantParts.splice(0)
    });
  };
  const appendToolResult = (part: ToolContentPart): void => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'tool') {
      lastMessage.content.push(part);
      return;
    }
    messages.push({
      role: 'tool',
      content: [part]
    });
  };
  const appendUserContext = (content: string): void => {
    flushAssistant();
    if (hasText(content)) {
      messages.push({
        role: 'user',
        content
      });
    }
  };

  for (const part of orderedParts(parts)) {
    if (part.kind === 'assistant_text') {
      assistantParts.push({
        type: 'text',
        text: part.text
      });
      continue;
    }
    if (part.kind === 'assistant_thinking') {
      assistantParts.push({
        type: 'reasoning',
        text: part.thinking
      });
      continue;
    }
    if (part.kind === 'tool_call') {
      assistantParts.push({
        type: 'tool-call',
        toolCallId: part.providerCallId ?? part.toolUseId,
        toolName: part.name,
        input: stringifyInput(part.input)
      });
      continue;
    }
    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      flushAssistant();
      appendToolResult({
        type: 'tool-result',
        toolCallId: part.toolUseId,
        toolName: part.toolName ?? part.toolUseId,
        output: {
          type: 'text',
          value: part.kind === 'tool_error' ? part.error : stringifyToolOutput(part.content)
        }
      });
      continue;
    }
    if (part.kind === 'context_summary') {
      appendUserContext(formatContextSummaryPart(part));
      continue;
    }
    if (part.kind === 'run_error') {
      appendUserContext(`[Run error]\n${part.error}`);
    }
  }

  flushAssistant();
  return messages;
}
