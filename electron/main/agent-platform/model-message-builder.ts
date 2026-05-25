import type {
  AssistantContent,
  ModelMessage,
  ToolContent
} from 'ai';
import { ensureProjectSessions } from '../../../shared/project-sessions';
import type { AgentCoreMessagePart, ChatMessage, Project, ProjectSession } from '../../../shared/types';
import { filterNativeMessagesAfterSummaryBoundary } from './native/context-handoff';

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type ToolContentPart = ToolContent[number];

const DEFAULT_MAX_HISTORY_MESSAGES = 24;
const DEFAULT_FULL_DETAIL_RECENT_MESSAGES = 8;
const MAX_COMPRESSED_HISTORY_CHARS = 8000;
const MAX_COMPRESSED_TEXT_CHARS = 420;
const MAX_COMPRESSED_TOOL_INPUT_CHARS = 360;
const MAX_COMPRESSED_TOOL_RESULT_CHARS = 700;

export interface BuildModelMessagesOptions {
  project: Project;
  sessionId?: string;
  currentPrompt: string;
  maxHistoryMessages?: number;
  compressOlderToolResults?: boolean;
  fullDetailRecentMessages?: number;
}

function hasText(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

function selectProjectSession(project: Project, sessionId?: string): ProjectSession | undefined {
  const ensured = ensureProjectSessions(project);
  return (
    (sessionId ? ensured.sessions.find((session) => session.id === sessionId) : undefined) ??
    ensured.sessions.find((session) => session.id === ensured.activeSessionId) ??
    ensured.sessions[0]
  );
}

function appendUserMessage(messages: ModelMessage[], text: string): void {
  if (!hasText(text)) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string') {
    lastMessage.content = [lastMessage.content, text].filter(hasText).join('\n\n');
    return;
  }

  messages.push({
    role: 'user',
    content: text
  });
}

function appendAssistantText(messages: ModelMessage[], text: string): void {
  if (!hasText(text)) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
    lastMessage.content = [lastMessage.content, text].filter(hasText).join('\n\n');
    return;
  }

  if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push({
      type: 'text',
      text
    });
    return;
  }

  messages.push({
    role: 'assistant',
    content: text
  });
}

function appendAssistantParts(messages: ModelMessage[], parts: AssistantContentPart[]): void {
  if (parts.length === 0) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(...parts);
    return;
  }

  if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
    messages[messages.length - 1] = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: lastMessage.content
        },
        ...parts
      ]
    };
    return;
  }

  messages.push({
    role: 'assistant',
    content: [...parts]
  });
}

function appendToolResult(messages: ModelMessage[], part: ToolContentPart): void {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'tool') {
    lastMessage.content.push(part);
    return;
  }

  messages.push({
    role: 'tool',
    content: [part]
  });
}

function getUserMessageText(message: ChatMessage): string {
  return message.content;
}

function sortAgentCoreParts(parts: AgentCoreMessagePart[] | undefined): AgentCoreMessagePart[] {
  return parts?.length
    ? [...parts].sort((left, right) => {
        if (left.sequence !== right.sequence) {
          return left.sequence - right.sequence;
        }
        return left.createdAt.localeCompare(right.createdAt);
      })
    : [];
}

function getAssistantMessageAgentCoreParts(message: ChatMessage): AgentCoreMessagePart[] {
  return message.role === 'assistant'
    ? sortAgentCoreParts(message.metadata?.agentCoreParts)
    : [];
}

function createTextPart(text: string): AssistantContentPart {
  return {
    type: 'text',
    text
  };
}

function createReasoningPart(text: string): AssistantContentPart {
  return {
    type: 'reasoning',
    text
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const marker = `…[${value.length - maxLength} chars omitted]…`;
  const headLength = Math.max(0, Math.ceil((maxLength - marker.length) * 0.65));
  const tailLength = Math.max(0, maxLength - marker.length - headLength);
  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ''}`;
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) {
    return '{}';
  }

  try {
    return truncateMiddle(JSON.stringify(input), MAX_COMPRESSED_TOOL_INPUT_CHARS);
  } catch {
    return '[unserializable input]';
  }
}

function summarizeToolResultPart(part: Extract<AgentCoreMessagePart, { kind: 'tool_result' | 'tool_error' }>): string {
  const content = compactWhitespace(part.kind === 'tool_error' ? part.error : part.content);
  const mediaText = part.artifacts?.length ? ` artifacts=${part.artifacts.length}` : '';
  const status = part.kind === 'tool_error' ? 'error' : 'ok';
  return `${status}${mediaText}: ${truncateMiddle(content || '(empty)', MAX_COMPRESSED_TOOL_RESULT_CHARS)}`;
}

function summarizeAssistantTextParts(parts: AgentCoreMessagePart[]): string {
  const text = parts
    .map((part) => part.kind === 'assistant_text' ? part.text : '')
    .filter(hasText)
    .map(compactWhitespace)
    .filter(Boolean)
    .join(' ');

  return truncateMiddle(text, MAX_COMPRESSED_TEXT_CHARS);
}

function summarizeAssistantTools(parts: AgentCoreMessagePart[]): string[] {
  const toolUses = new Map<string, Extract<AgentCoreMessagePart, { kind: 'tool_call' }>>();
  for (const part of parts) {
    if (part.kind === 'tool_call') {
      toolUses.set(part.toolUseId, part);
    }
  }

  return parts
    .filter((part): part is Extract<AgentCoreMessagePart, { kind: 'tool_result' | 'tool_error' }> =>
      part.kind === 'tool_result' || part.kind === 'tool_error'
    )
    .map((part) => {
      const toolUse = toolUses.get(part.toolUseId);
      const toolName = toolUse?.name ?? part.toolName ?? `unknown:${part.toolUseId}`;
      return `- ${toolName} input=${summarizeToolInput(toolUse?.input)} result=${summarizeToolResultPart(part)}`;
    });
}

function buildCompressedHistorySummary(chat: ChatMessage[]): string | undefined {
  if (chat.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    '早期会话和工具摘要：以下内容由较早轮次压缩而来，近期消息仍以完整 tool-call/tool-result 形式保留。'
  ];
  let turnIndex = 0;
  let currentUserText = '';

  const flushUserOnlyTurn = () => {
    if (!currentUserText) {
      return;
    }
    turnIndex += 1;
    lines.push(`## Turn ${turnIndex}`);
    lines.push(`User: ${truncateMiddle(currentUserText, MAX_COMPRESSED_TEXT_CHARS)}`);
    currentUserText = '';
  };

  for (const message of chat) {
    if (message.role === 'user') {
      flushUserOnlyTurn();
      currentUserText = compactWhitespace(getUserMessageText(message));
      continue;
    }

    turnIndex += 1;
    lines.push(`## Turn ${turnIndex}`);
    if (currentUserText) {
      lines.push(`User: ${truncateMiddle(currentUserText, MAX_COMPRESSED_TEXT_CHARS)}`);
      currentUserText = '';
    }

    const assistantParts = getAssistantMessageAgentCoreParts(message);
    if (!assistantParts.length) {
      lines.push(`Assistant: ${truncateMiddle(compactWhitespace(message.content), MAX_COMPRESSED_TEXT_CHARS)}`);
      continue;
    }

    const assistantText = summarizeAssistantTextParts(assistantParts);
    if (assistantText) {
      lines.push(`Assistant: ${assistantText}`);
    }

    const toolLines = summarizeAssistantTools(assistantParts);
    if (toolLines.length > 0) {
      lines.push('Tools:');
      lines.push(...toolLines.slice(0, 12));
      if (toolLines.length > 12) {
        lines.push(`- ... ${toolLines.length - 12} more tool result(s) omitted`);
      }
    }
  }

  flushUserOnlyTurn();
  const summary = lines.join('\n');
  return summary.length > MAX_COMPRESSED_HISTORY_CHARS
    ? `${summary.slice(0, MAX_COMPRESSED_HISTORY_CHARS)}\n\n[早期会话摘要已截断：超过 ${MAX_COMPRESSED_HISTORY_CHARS} 字符]`
    : summary;
}

function compactOlderNativeToolResults(chat: ChatMessage[]): ChatMessage[] {
  return chat.map((message) => {
    const parts = message.metadata?.agentCoreParts;
    if (!parts?.some((part) => part.kind === 'tool_result' || part.kind === 'tool_error')) {
      return message;
    }
    return {
      ...message,
      metadata: {
        ...message.metadata,
        agentCoreParts: parts.map(compactNativeToolResultPart)
      }
    };
  });
}

function compactNativeToolResultPart(part: AgentCoreMessagePart): AgentCoreMessagePart {
  if (part.kind === 'tool_result') {
    return {
      ...part,
      content: [
        '[Native tool result compacted]',
        truncateMiddle(compactWhitespace(part.content) || '(empty)', 700)
      ].join(' ')
    };
  }
  if (part.kind === 'tool_error') {
    return {
      ...part,
      error: [
        '[Native tool result compacted]',
        'status=error',
        truncateMiddle(compactWhitespace(part.error) || '(empty)', 700)
      ].join(' ')
    };
  }
  return part;
}

function createOrphanToolResultText(part: Extract<AgentCoreMessagePart, { kind: 'tool_result' | 'tool_error' }>): AssistantContentPart {
  const content = part.kind === 'tool_error' ? part.error : part.content;
  return createTextPart(
    [
      `[Unmatched Tool Result] ${part.toolUseId}`,
      part.kind === 'tool_error' ? 'Status: error' : '',
      content
    ]
      .filter(hasText)
      .join('\n')
  );
}

function createIncompleteToolResult(part: Extract<AgentCoreMessagePart, { kind: 'tool_call' }>): ToolContentPart {
  const status = part.status ?? 'pending';
  return {
    type: 'tool-result',
    toolCallId: part.toolUseId,
    toolName: part.name,
    output: {
      type: 'text',
      value: [
        '[Error]',
        `Tool call ${part.name} did not return a recorded result before the run was interrupted.`,
        `Recorded status: ${status}.`,
        'Treat this prior tool call as failed; retry it only if the user request still requires it.'
      ].join('\n')
    }
  };
}

function appendAssistantMessageFromAgentCoreParts(
  messages: ModelMessage[],
  parts: AgentCoreMessagePart[],
  toolCallNames: Map<string, string>
): void {
  const completedToolUseIds = new Set(
    parts
      .filter((part): part is Extract<AgentCoreMessagePart, { kind: 'tool_result' | 'tool_error' }> =>
        part.kind === 'tool_result' || part.kind === 'tool_error'
      )
      .map((part) => part.toolUseId)
  );
  let assistantParts: AssistantContentPart[] = [];

  const flushAssistantParts = () => {
    appendAssistantParts(messages, assistantParts);
    assistantParts = [];
  };

  for (const part of parts) {
    if (part.kind === 'assistant_text') {
      if (hasText(part.text)) {
        assistantParts.push(createTextPart(part.text));
      }
      continue;
    }

    if (part.kind === 'assistant_thinking') {
      if (hasText(part.thinking)) {
        assistantParts.push(createReasoningPart(part.thinking));
      }
      continue;
    }

    if (part.kind === 'tool_call') {
      toolCallNames.set(part.toolUseId, part.name);
      assistantParts.push({
        type: 'tool-call',
        toolCallId: part.toolUseId,
        toolName: part.name,
        input: part.input ?? {}
      });
      if (!completedToolUseIds.has(part.toolUseId)) {
        flushAssistantParts();
        appendToolResult(messages, createIncompleteToolResult(part));
      }
      continue;
    }

    if (part.kind !== 'tool_result' && part.kind !== 'tool_error') {
      if (part.kind === 'run_error' && hasText(part.error)) {
        assistantParts.push(createTextPart(`[Run Error]\n${part.error}`));
      }
      continue;
    }

    const toolName = toolCallNames.get(part.toolUseId) ?? part.toolName;
    if (!toolName) {
      assistantParts.push(createOrphanToolResultText(part));
      continue;
    }

    flushAssistantParts();
    appendToolResult(messages, {
      type: 'tool-result',
      toolCallId: part.toolUseId,
      toolName,
      output: {
        type: 'text',
        value: part.kind === 'tool_error' ? `[Error]\n${part.error}` : part.content
      }
    });
  }

  flushAssistantParts();
}

export function buildModelMessagesFromChat(chat: ChatMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolCallNames = new Map<string, string>();

  for (const message of chat) {
    if (message.role === 'user') {
      appendUserMessage(messages, getUserMessageText(message));
      continue;
    }

    const assistantParts = getAssistantMessageAgentCoreParts(message);
    if (!assistantParts.length) {
      appendAssistantText(messages, message.content);
      continue;
    }

    const beforeLength = messages.length;
    appendAssistantMessageFromAgentCoreParts(messages, assistantParts, toolCallNames);

    if (messages.length === beforeLength && hasText(message.content)) {
      appendAssistantText(messages, message.content);
    }
  }

  return messages;
}

export function buildNativeToolLoopMessages(options: BuildModelMessagesOptions): ModelMessage[] {
  const session = selectProjectSession(options.project, options.sessionId);
  const maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const nativeContextSummary = session?.runtimeOverrides?.nativeContextSummary?.trim();
  const filteredChat = nativeContextSummary
    ? filterNativeMessagesAfterSummaryBoundary(session?.chat ?? [], session?.runtimeOverrides?.nativeContextSummaryCoverage)
    : (session?.chat ?? []);
  const history = filteredChat.slice(-maxHistoryMessages);
  const shouldCompressOlderHistory = options.compressOlderToolResults ?? true;
  const fullDetailRecentMessages = Math.max(1, Math.min(
    options.fullDetailRecentMessages ?? DEFAULT_FULL_DETAIL_RECENT_MESSAGES,
    maxHistoryMessages
  ));
  const splitIndex = shouldCompressOlderHistory
    ? Math.max(0, history.length - fullDetailRecentMessages)
    : 0;
  const olderHistory = shouldCompressOlderHistory
    ? compactOlderNativeToolResults(history.slice(0, splitIndex))
    : history.slice(0, splitIndex);
  const messages = [
    ...(nativeContextSummary
      ? [{
          role: 'user' as const,
          content: `Native runtime long-context summary:\n${nativeContextSummary}`
        }]
      : []),
    ...buildModelMessagesFromChat([
      ...olderHistory,
      ...history.slice(splitIndex)
    ])
  ];

  appendUserMessage(messages, options.currentPrompt);

  if (messages.length === 0) {
    return [
      {
        role: 'user',
        content: options.currentPrompt
      }
    ];
  }

  return messages;
}
