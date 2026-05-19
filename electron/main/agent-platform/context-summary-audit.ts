import type { ChatContentBlock, ChatMessage, ContextSummaryAudit } from '../../../shared/types';

const MAX_AUDIT_ITEMS = 12;
const MAX_AUDIT_ITEM_CHARS = 220;

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string): string {
  return value.length > MAX_AUDIT_ITEM_CHARS ? `${value.slice(0, MAX_AUDIT_ITEM_CHARS).trimEnd()}...` : value;
}

function blockText(block: ChatContentBlock): string {
  if (block.type === 'text' || block.type === 'fallback') {
    return block.text;
  }
  if (block.type === 'tool_use') {
    return `Tool ${block.name} input ${JSON.stringify(block.input ?? {})}`;
  }
  if (block.type === 'tool_result') {
    return block.content;
  }
  return '';
}

function messageText(message: ChatMessage): string {
  if (message.contentBlocks?.length) {
    return message.contentBlocks.map(blockText).filter(Boolean).join('\n');
  }
  return message.content;
}

function candidateLines(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    messageText(message)
      .split(/\n+|(?<=[。！？.!?])\s+/)
      .map((line) => compact(line))
      .filter((line) => line.length >= 8)
      .map((line) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${truncate(line)}`)
  );
}

function collectMatches(lines: string[], pattern: RegExp): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!pattern.test(line)) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(line);
    if (matches.length >= MAX_AUDIT_ITEMS) {
      break;
    }
  }
  return matches;
}

export function buildContextSummaryAudit(messages: ChatMessage[]): ContextSummaryAudit {
  const lines = candidateLines(messages);
  return {
    generatedAt: new Date().toISOString(),
    sourceMessageIds: messages.map((message) => message.id),
    decisions: collectMatches(lines, /(decision|decided|choose|chosen|approved|采用|决定|选定|确认|结论|路线)/i),
    constraints: collectMatches(lines, /(must|should|never|always|required|constraint|limit|only|不能|不要|必须|需要|只读|权限|约束|规则|不允许)/i),
    openTasks: collectMatches(lines, /(todo|next|pending|blocked|unfinished|remaining|follow up|待办|下一步|未完成|阻塞|继续|还需要|计划)/i)
  };
}

export function formatContextSummaryAudit(audit: ContextSummaryAudit | undefined): string {
  if (!audit || (!audit.decisions.length && !audit.constraints.length && !audit.openTasks.length)) {
    return '';
  }
  return [
    'Context summary audit:',
    audit.decisions.length ? ['Decisions:', ...audit.decisions.map((item) => `- ${item}`)].join('\n') : '',
    audit.constraints.length ? ['Constraints:', ...audit.constraints.map((item) => `- ${item}`)].join('\n') : '',
    audit.openTasks.length ? ['Unfinished tasks:', ...audit.openTasks.map((item) => `- ${item}`)].join('\n') : ''
  ].filter(Boolean).join('\n');
}

export function appendContextSummaryAudit(summary: string, audit: ContextSummaryAudit | undefined, maxLength: number): string {
  const auditText = formatContextSummaryAudit(audit);
  if (!auditText) {
    return summary;
  }
  const combined = `${summary.trim()}\n\n${auditText}`;
  return combined.length > maxLength ? `${combined.slice(0, maxLength).trimEnd()}...` : combined;
}
