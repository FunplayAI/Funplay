import type {
  AssistantContent,
  ModelMessage,
  ToolContent
} from 'ai';
import { ensureProjectSessions } from '../../../shared/project-sessions';
import type { ChatContentBlock, ChatMessage, Project, ProjectSession } from '../../../shared/types';
import {
  compactNativeToolResultBlock,
  filterNativeMessagesAfterSummaryBoundary
} from './native/context-handoff';

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
  if (!message.contentBlocks?.length) {
    return message.content;
  }

  const text = message.contentBlocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }

      if (block.type === 'fallback') {
        return block.text;
      }

      return '';
    })
    .filter(hasText)
    .join('\n\n');

  return text || message.content;
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

function summarizeToolResult(block: Extract<ChatContentBlock, { type: 'tool_result' }>): string {
  const content = compactWhitespace(block.content);
  const mediaText = block.media?.length ? ` media=${block.media.length}` : '';
  const status = block.isError ? 'error' : 'ok';
  return `${status}${mediaText}: ${truncateMiddle(content || '(empty)', MAX_COMPRESSED_TOOL_RESULT_CHARS)}`;
}

function summarizeAssistantTextBlocks(blocks: ChatContentBlock[]): string {
  const text = blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'fallback') return block.text;
      return '';
    })
    .filter(hasText)
    .map(compactWhitespace)
    .filter(Boolean)
    .join(' ');

  return truncateMiddle(text, MAX_COMPRESSED_TEXT_CHARS);
}

function summarizeAssistantTools(blocks: ChatContentBlock[]): string[] {
  const toolUses = new Map<string, Extract<ChatContentBlock, { type: 'tool_use' }>>();
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolUses.set(block.toolUseId, block);
    }
  }

  return blocks
    .filter((block): block is Extract<ChatContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => {
      const toolUse = toolUses.get(block.toolUseId);
      const toolName = toolUse?.name ?? `unknown:${block.toolUseId}`;
      return `- ${toolName} input=${summarizeToolInput(toolUse?.input)} result=${summarizeToolResult(block)}`;
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

    if (!message.contentBlocks?.length) {
      lines.push(`Assistant: ${truncateMiddle(compactWhitespace(message.content), MAX_COMPRESSED_TEXT_CHARS)}`);
      continue;
    }

    const assistantText = summarizeAssistantTextBlocks(message.contentBlocks);
    if (assistantText) {
      lines.push(`Assistant: ${assistantText}`);
    }

    const toolLines = summarizeAssistantTools(message.contentBlocks);
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
    if (!message.contentBlocks?.some((block) => block.type === 'tool_result')) {
      return message;
    }
    return {
      ...message,
      contentBlocks: message.contentBlocks.map((block) =>
        block.type === 'tool_result' ? compactNativeToolResultBlock(block) : block
      )
    };
  });
}

function createOrphanToolResultText(block: Extract<ChatContentBlock, { type: 'tool_result' }>): AssistantContentPart {
  return createTextPart(
    [
      `[Unmatched Tool Result] ${block.toolUseId}`,
      block.isError ? 'Status: error' : '',
      block.content
    ]
      .filter(hasText)
      .join('\n')
  );
}

function createIncompleteToolResult(block: Extract<ChatContentBlock, { type: 'tool_use' }>): ToolContentPart {
  const status = block.status ?? 'pending';
  return {
    type: 'tool-result',
    toolCallId: block.toolUseId,
    toolName: block.name,
    output: {
      type: 'text',
      value: [
        '[Error]',
        `Tool call ${block.name} did not return a recorded result before the run was interrupted.`,
        `Recorded status: ${status}.`,
        'Treat this prior tool call as failed; retry it only if the user request still requires it.'
      ].join('\n')
    }
  };
}

function appendAssistantMessageFromBlocks(
  messages: ModelMessage[],
  blocks: ChatContentBlock[],
  toolCallNames: Map<string, string>
): void {
  const completedToolUseIds = new Set(
    blocks
      .filter((block): block is Extract<ChatContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
      .map((block) => block.toolUseId)
  );
  let assistantParts: AssistantContentPart[] = [];

  const flushAssistantParts = () => {
    appendAssistantParts(messages, assistantParts);
    assistantParts = [];
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      if (hasText(block.text)) {
        assistantParts.push(createTextPart(block.text));
      }
      continue;
    }

    if (block.type === 'fallback') {
      if (hasText(block.text)) {
        assistantParts.push(createTextPart(block.text));
      }
      continue;
    }

    if (block.type === 'thinking') {
      if (hasText(block.thinking)) {
        assistantParts.push(createReasoningPart(block.thinking));
      }
      continue;
    }

    if (block.type === 'tool_use') {
      toolCallNames.set(block.toolUseId, block.name);
      assistantParts.push({
        type: 'tool-call',
        toolCallId: block.toolUseId,
        toolName: block.name,
        input: block.input ?? {}
      });
      if (!completedToolUseIds.has(block.toolUseId)) {
        flushAssistantParts();
        appendToolResult(messages, createIncompleteToolResult(block));
      }
      continue;
    }

    const toolName = toolCallNames.get(block.toolUseId);
    if (!toolName) {
      assistantParts.push(createOrphanToolResultText(block));
      continue;
    }

    flushAssistantParts();
    appendToolResult(messages, {
      type: 'tool-result',
      toolCallId: block.toolUseId,
      toolName,
      output: {
        type: 'text',
        value: block.isError ? `[Error]\n${block.content}` : block.content
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

    if (!message.contentBlocks?.length) {
      appendAssistantText(messages, message.content);
      continue;
    }

    const beforeLength = messages.length;
    appendAssistantMessageFromBlocks(messages, message.contentBlocks, toolCallNames);

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
