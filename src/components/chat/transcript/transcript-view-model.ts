import type { AgentCoreMessagePart, AgentPermissionImpact } from '../../../../shared/types';
import { orderAgentCoreParts } from './message-plain-text';
import type { ToolExecutionEntry } from '../tool/tool-types';

export type TranscriptViewItemStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TranscriptRenderContract {
  id: string;
  status: TranscriptViewItemStatus;
  timestamp: string;
  compactSummary: string;
  copyText: string;
  rawDebugText: string;
}

export type TranscriptViewItem =
  | (TranscriptRenderContract & {
      kind: 'assistant_text';
      text: string;
      final: boolean;
    })
  | (TranscriptRenderContract & {
      kind: 'assistant_thinking';
      thinking: string;
      title: string;
    })
  | (TranscriptRenderContract & {
      kind: 'tool_group';
      tools: ToolExecutionEntry[];
      collapseBeforeAssistantText: boolean;
    })
  | (TranscriptRenderContract & {
      kind: 'permission_request';
      requestId: string;
      toolName: string;
      risk: 'low' | 'medium' | 'high';
      reason?: string;
      impact?: AgentPermissionImpact;
    })
  | (TranscriptRenderContract & {
      kind: 'user_input_request';
      requestId: string;
      question: string;
      options: Array<{ id: string; label: string }>;
    })
  | (TranscriptRenderContract & {
      kind: 'todo_update';
      items: Extract<AgentCoreMessagePart, { kind: 'todo_update' }>['items'];
    })
  | (TranscriptRenderContract & {
      kind: 'context_summary';
      summary: string;
    })
  | (TranscriptRenderContract & {
      kind: 'system_event';
      title: string;
      summary?: string;
      state?: Extract<AgentCoreMessagePart, { kind: 'system_event' }>['state'];
    })
  | (TranscriptRenderContract & {
      kind: 'run_error';
      error: string;
      recoverable: boolean;
      diagnosticCode?: string;
    });

interface ToolDraft {
  key: string;
  timestamp: string;
  tool: ToolExecutionEntry;
}

export function buildToolExecutionsFromAgentCoreParts(parts: AgentCoreMessagePart[] | undefined): ToolExecutionEntry[] {
  return buildToolEntriesFromAgentCoreParts(parts).map((entry) => entry.tool);
}

export function buildTranscriptViewItems(parts: AgentCoreMessagePart[]): TranscriptViewItem[] {
  const orderedParts = orderAgentCoreParts(parts);
  const rawItems: Array<TranscriptViewItem | ToolDraft> = [];
  const toolsById = new Map<string, ToolDraft>();

  for (const part of orderedParts) {
    if (part.kind === 'assistant_text') {
      rawItems.push({
        id: part.id,
        kind: 'assistant_text',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: part.text.trim().slice(0, 120),
        copyText: part.text,
        rawDebugText: JSON.stringify(part, null, 2),
        text: part.text,
        final: Boolean(part.final)
      });
      continue;
    }

    if (part.kind === 'assistant_thinking') {
      rawItems.push({
        id: part.id,
        kind: 'assistant_thinking',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: part.title ?? 'Thinking',
        copyText: part.thinking,
        rawDebugText: JSON.stringify(part, null, 2),
        thinking: part.thinking,
        title: part.title ?? 'Thinking'
      });
      continue;
    }

    if (part.kind === 'tool_call') {
      const draft: ToolDraft = {
        key: part.id,
        timestamp: part.createdAt,
        tool: {
          id: part.toolUseId,
          name: part.name,
          title: part.title,
          summary: part.summary,
          activity: part.activity,
          status: part.status,
          input: part.input
        }
      };
      toolsById.set(part.toolUseId, draft);
      rawItems.push(draft);
      continue;
    }

    if (part.kind === 'tool_result' || part.kind === 'tool_error') {
      const existing = toolsById.get(part.toolUseId);
      const draft = existing ?? {
        key: part.id,
        timestamp: part.createdAt,
        tool: {
          id: part.toolUseId,
          name: part.toolName ?? part.toolUseId,
          status: part.kind === 'tool_error' ? 'failed' as const : 'completed' as const
        }
      };
      draft.tool.status = part.kind === 'tool_error' ? 'failed' : 'completed';
      draft.tool.result = {
        content: part.kind === 'tool_error' ? part.error : part.content,
        isError: part.kind === 'tool_error',
        changedFiles: part.changedFiles,
        browser: part.browser,
        edit: part.edit,
        mcp: part.mcp,
        artifacts: part.artifacts,
        transaction: part.transaction
      };
      if (!existing) {
        toolsById.set(part.toolUseId, draft);
        rawItems.push(draft);
      }
      continue;
    }

    if (part.kind === 'permission_request') {
      rawItems.push({
        id: part.id,
        kind: 'permission_request',
        status: 'pending',
        timestamp: part.createdAt,
        compactSummary: part.reason ?? part.toolName,
        copyText: [part.toolName, part.reason].filter(Boolean).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        requestId: part.requestId,
        toolName: part.toolName,
        risk: part.risk,
        reason: part.reason,
        impact: part.impact as AgentPermissionImpact | undefined
      });
      continue;
    }

    if (part.kind === 'user_input_request') {
      rawItems.push({
        id: part.id,
        kind: 'user_input_request',
        status: 'pending',
        timestamp: part.createdAt,
        compactSummary: part.question,
        copyText: part.question,
        rawDebugText: JSON.stringify(part, null, 2),
        requestId: part.requestId,
        question: part.question,
        options: part.options ?? []
      });
      continue;
    }

    if (part.kind === 'todo_update') {
      rawItems.push({
        id: part.id,
        kind: 'todo_update',
        status: part.items.some((item) => item.status === 'in_progress') ? 'running' : 'completed',
        timestamp: part.createdAt,
        compactSummary: `Todo ${part.items.length}`,
        copyText: part.items.map((item) => `${item.status} · ${item.title}`).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        items: part.items
      });
      continue;
    }

    if (part.kind === 'context_summary') {
      rawItems.push({
        id: part.id,
        kind: 'context_summary',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: 'Context summary',
        copyText: part.summary,
        rawDebugText: JSON.stringify(part, null, 2),
        summary: part.summary
      });
      continue;
    }

    if (part.kind === 'system_event') {
      const display = formatSystemEvent(part);
      rawItems.push({
        id: part.id,
        kind: 'system_event',
        status: systemEventStatus(part.state),
        timestamp: part.createdAt,
        compactSummary: [display.title, display.summary].filter(Boolean).join(' · '),
        copyText: [display.title, display.summary].filter(Boolean).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        title: display.title,
        summary: display.summary,
        state: part.state
      });
      continue;
    }

    if (part.kind === 'run_error') {
      rawItems.push({
        id: part.id,
        kind: 'run_error',
        status: 'failed',
        timestamp: part.createdAt,
        compactSummary: part.error,
        copyText: part.error,
        rawDebugText: JSON.stringify(part, null, 2),
        error: part.error,
        recoverable: part.recoverable,
        diagnosticCode: part.diagnosticCode
      });
    }
  }

  return groupTranscriptToolItems(rawItems);
}

function buildToolEntriesFromAgentCoreParts(parts: AgentCoreMessagePart[] | undefined): ToolDraft[] {
  if (!parts?.length) {
    return [];
  }
  return buildTranscriptViewItems(parts)
    .filter((item): item is Extract<TranscriptViewItem, { kind: 'tool_group' }> => item.kind === 'tool_group')
    .flatMap((item) => item.tools.map((tool) => ({ key: item.id, timestamp: item.timestamp, tool })));
}

function groupTranscriptToolItems(items: Array<TranscriptViewItem | ToolDraft>): TranscriptViewItem[] {
  const grouped: TranscriptViewItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isToolDraft(item)) {
      grouped.push(item);
      continue;
    }

    const tools = [item.tool];
    const id = item.key;
    while (isToolDraft(items[index + 1])) {
      index += 1;
      tools.push((items[index] as ToolDraft).tool);
    }

    const collapseBeforeAssistantText = items
      .slice(index + 1)
      .some((futureItem) => !isToolDraft(futureItem) && futureItem.kind === 'assistant_text');
    const status = tools.some((tool) => tool.status === 'failed' || tool.result?.isError)
      ? 'failed'
      : tools.some((tool) => tool.status === 'running' || tool.status === 'pending')
        ? 'running'
        : 'completed';
    const compactSummary = tools
      .map((tool) => tool.activity ?? tool.summary ?? tool.title ?? tool.name)
      .filter(Boolean)
      .join(' · ');
    grouped.push({
      id,
      kind: 'tool_group',
      status,
      timestamp: item.timestamp,
      compactSummary,
      copyText: tools.map((tool) => [
        tool.title ?? tool.name,
        tool.summary,
        tool.result?.content
      ].filter(Boolean).join('\n')).join('\n\n'),
      rawDebugText: JSON.stringify(tools, null, 2),
      tools,
      collapseBeforeAssistantText
    });
  }

  return grouped;
}

function isToolDraft(item: TranscriptViewItem | ToolDraft | undefined): item is ToolDraft {
  return Boolean(item && 'tool' in item);
}

function systemEventStatus(state: Extract<AgentCoreMessagePart, { kind: 'system_event' }>['state']): TranscriptViewItemStatus {
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'failed';
  if (state === 'completed') return 'completed';
  if (!state) return 'completed';
  return 'running';
}

function formatSystemEvent(part: Extract<AgentCoreMessagePart, { kind: 'system_event' }>): { title: string; summary?: string } {
  if (part.metadata?.type === 'skill_activation') {
    const skillName = typeof part.metadata.skillName === 'string' ? part.metadata.skillName : undefined;
    return {
      title: '已激活 Skill',
      summary: [skillName, part.summary].filter(Boolean).join('\n')
    };
  }
  return {
    title: part.title,
    summary: part.summary
  };
}
