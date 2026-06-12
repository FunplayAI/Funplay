import type {
  AssistantContent,
  ModelMessage,
  ToolContent
} from 'ai';
import { ensureProjectSessions } from '../../../shared/project-sessions';
import type { AgentCoreMessagePart, ChatMessage, Project, ProjectSession, PromptAttachment } from '../../../shared/types';
import { filterNativeMessagesAfterSummaryBoundary } from './native/context-handoff';

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type ToolContentPart = ToolContent[number];

export interface BuildModelMessagesOptions {
  project: Project;
  sessionId?: string;
  currentPrompt: string;
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

function formatPromptAttachmentsForModel(attachments: PromptAttachment[] | undefined): string {
  if (!attachments?.length) {
    return '';
  }

  const lines = attachments.map((attachment, index) => {
    const targetPath = attachment.relativePath || attachment.path;
    const meta = [
      attachment.kind,
      attachment.mimeType,
      `${attachment.size} bytes`
    ].filter(Boolean).join(', ');
    return `${index + 1}. ${attachment.name} -> ${targetPath}${meta ? ` (${meta})` : ''}`;
  });

  return [
    'Attached files staged for this message:',
    ...lines,
    '',
    'Use the listed paths when reading or referencing these attachments. Only import them into the project when the user asks to save or add them as project assets.'
  ].join('\n');
}

function getUserMessageText(message: ChatMessage): string {
  const attachmentText = formatPromptAttachmentsForModel(message.metadata?.promptAttachments);
  return [message.content, attachmentText].filter(hasText).join('\n\n');
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

// Budget-driven retention: the transcript after the compaction boundary is
// replayed verbatim — no fixed message caps and no always-on lossy squeeze.
// Trimming happens exclusively through the native context handoff (compaction at
// the 0.68 context-budget ratio), which records a coverage boundary and a summary.
export function buildNativeToolLoopMessages(options: BuildModelMessagesOptions): ModelMessage[] {
  const session = selectProjectSession(options.project, options.sessionId);
  const nativeContextSummary = session?.runtimeOverrides?.nativeContextSummary?.trim();
  const history = nativeContextSummary
    ? filterNativeMessagesAfterSummaryBoundary(session?.chat ?? [], session?.runtimeOverrides?.nativeContextSummaryCoverage)
    : (session?.chat ?? []);
  const messages = [
    ...(nativeContextSummary
      ? [{
          role: 'user' as const,
          content: `Native runtime long-context summary:\n${nativeContextSummary}`
        }]
      : []),
    ...buildModelMessagesFromChat(history)
  ];

  // The per-turn dynamic block stays a separate tail message: merging it into the
  // last transcript user message would rewrite an already-emitted prefix and
  // defeat provider prompt caching across turns.
  messages.push({
    role: 'user',
    content: options.currentPrompt
  });

  return messages;
}
