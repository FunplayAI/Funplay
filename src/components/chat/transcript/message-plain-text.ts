import type { AgentCoreMessagePart, ChatMessage } from '../../../../shared/types';

const PSEUDO_TOOL_TEXT_LINE_PATTERNS = [
  /^\s*\[Previous tool call\](?:\s|$)/i,
  /^\s*\[Previous tool result\](?:\s|$)/i,
  /^\s*Previous tool call\b/i,
  /^\s*Previous tool result\b/i,
  /^\s*\[Tool\]\s+\S+/i,
  /^\s*\[Tool Result\](?:\s|$)/i
];

export function orderAgentCoreParts(parts: AgentCoreMessagePart[]): AgentCoreMessagePart[] {
  return [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function getMessagePlainText(message: ChatMessage, includeToolDetails = true): string {
  if (message.role === 'assistant' && message.metadata?.agentCoreParts?.length) {
    const agentCoreText = getAgentCorePartsPlainText(message.metadata.agentCoreParts, includeToolDetails);
    if (agentCoreText.trim() || isPseudoToolTextForDisplay(message.content)) {
      return agentCoreText;
    }
  }

  return getRenderableMessageFallbackContent(message);
}

function isPseudoToolTextLine(value: string): boolean {
  return PSEUDO_TOOL_TEXT_LINE_PATTERNS.some((pattern) => pattern.test(value));
}

function isPseudoToolTextForDisplay(value: string): boolean {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => isPseudoToolTextLine(line));
}

function stripPseudoToolTextForDisplay(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n');
  const firstNonEmptyLine = normalized.split('\n').find((line) => line.trim());
  if (firstNonEmptyLine && isPseudoToolTextLine(firstNonEmptyLine)) {
    return '';
  }
  return normalized
    .split('\n')
    .filter((line) => !isPseudoToolTextLine(line))
    .join('\n')
    .trim();
}

export function getRenderableMessageFallbackContent(message: ChatMessage): string {
  if (message.role !== 'assistant') {
    return message.content;
  }
  return stripPseudoToolTextForDisplay(message.content);
}

function getAgentCorePartsPlainText(parts: AgentCoreMessagePart[], includeToolDetails: boolean): string {
  return orderAgentCoreParts(parts)
    .map((part) => getAgentCorePartPlainText(part, includeToolDetails))
    .filter(Boolean)
    .join('\n\n');
}

function getAgentCorePartPlainText(part: AgentCoreMessagePart, includeToolDetails: boolean): string {
  if (part.kind === 'assistant_text') {
    return stripPseudoToolTextForDisplay(part.text);
  }
  if (part.kind === 'assistant_thinking') {
    return includeToolDetails ? part.thinking : '';
  }
  if (part.kind === 'tool_call') {
    return includeToolDetails
      ? `${part.name}\n${part.input ? JSON.stringify(part.input, null, 2) : ''}`.trim()
      : '';
  }
  if (part.kind === 'tool_result') {
    return includeToolDetails ? part.content : '';
  }
  if (part.kind === 'tool_error') {
    return includeToolDetails ? part.error : '';
  }
  if (part.kind === 'context_summary') {
    return part.summary;
  }
  if (part.kind === 'todo_update') {
    return part.items.map((item) => `${item.status} · ${item.title}`).join('\n');
  }
  if (part.kind === 'run_error') {
    return part.error;
  }
  if (part.kind === 'system_event') {
    return includeToolDetails || part.metadata?.type === 'skill_activation'
      ? [part.title, part.summary].filter(Boolean).join('\n')
      : '';
  }
  if (part.kind === 'permission_request') {
    return includeToolDetails ? [part.toolName, part.reason].filter(Boolean).join('\n') : '';
  }
  if (part.kind === 'user_input_request') {
    return includeToolDetails ? part.question : '';
  }
  return '';
}
