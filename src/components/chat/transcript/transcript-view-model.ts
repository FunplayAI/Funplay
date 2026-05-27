import type { AgentCoreMessagePart, AgentPermissionImpact } from '../../../../shared/types';
import { orderAgentCoreParts } from './message-plain-text';
import type { ToolExecutionEntry } from '../tool/tool-types';
import { getToolActivityKind } from '../tool/tool-formatters';

export type TranscriptViewItemStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TranscriptViewItemRole = 'assistant' | 'tool' | 'system';
export type TranscriptToolStepKind = 'explore' | 'edit' | 'command' | 'engine' | 'asset' | 'task' | 'mixed' | 'other';
export interface TranscriptToolStepSummary {
  zhCN: string;
  enUS: string;
}
export type TranscriptViewItemDisplayKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'user_input'
  | 'todo'
  | 'context'
  | 'system'
  | 'error';
export type TranscriptViewItemDetailView = 'none' | 'inline' | 'overlay' | 'developer';

export interface TranscriptRenderContract {
  id: string;
  role: TranscriptViewItemRole;
  displayKind: TranscriptViewItemDisplayKind;
  status: TranscriptViewItemStatus;
  timestamp: string;
  compactSummary: string;
  copyText: string;
  rawDebugText: string;
  detailView: TranscriptViewItemDetailView;
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
      stepKind: TranscriptToolStepKind;
      stepSummary: TranscriptToolStepSummary;
      failureCount: number;
      runningCount: number;
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
        role: 'assistant',
        displayKind: 'text',
        kind: 'assistant_text',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: part.text.trim().slice(0, 120),
        copyText: part.text,
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'none',
        text: part.text,
        final: Boolean(part.final)
      });
      continue;
    }

    if (part.kind === 'assistant_thinking') {
      rawItems.push({
        id: part.id,
        role: 'assistant',
        displayKind: 'thinking',
        kind: 'assistant_thinking',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: part.title ?? 'Thinking',
        copyText: part.thinking,
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'developer',
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
        role: 'assistant',
        displayKind: 'permission',
        kind: 'permission_request',
        status: 'pending',
        timestamp: part.createdAt,
        compactSummary: part.reason ?? part.toolName,
        copyText: [part.toolName, part.reason].filter(Boolean).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'inline',
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
        role: 'assistant',
        displayKind: 'user_input',
        kind: 'user_input_request',
        status: 'pending',
        timestamp: part.createdAt,
        compactSummary: part.question,
        copyText: part.question,
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'inline',
        requestId: part.requestId,
        question: part.question,
        options: part.options ?? []
      });
      continue;
    }

    if (part.kind === 'todo_update') {
      rawItems.push({
        id: part.id,
        role: 'system',
        displayKind: 'todo',
        kind: 'todo_update',
        status: part.items.some((item) => item.status === 'in_progress') ? 'running' : 'completed',
        timestamp: part.createdAt,
        compactSummary: `Todo ${part.items.length}`,
        copyText: part.items.map((item) => `${item.status} · ${item.title}`).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'inline',
        items: part.items
      });
      continue;
    }

    if (part.kind === 'context_summary') {
      rawItems.push({
        id: part.id,
        role: 'system',
        displayKind: 'context',
        kind: 'context_summary',
        status: 'completed',
        timestamp: part.createdAt,
        compactSummary: 'Context summary',
        copyText: part.summary,
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'inline',
        summary: part.summary
      });
      continue;
    }

    if (part.kind === 'system_event') {
      const display = formatSystemEvent(part);
      rawItems.push({
        id: part.id,
        role: 'system',
        displayKind: 'system',
        kind: 'system_event',
        status: systemEventStatus(part.state),
        timestamp: part.createdAt,
        compactSummary: [display.title, display.summary].filter(Boolean).join(' · '),
        copyText: [display.title, display.summary].filter(Boolean).join('\n'),
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'developer',
        title: display.title,
        summary: display.summary,
        state: part.state
      });
      continue;
    }

    if (part.kind === 'run_error') {
      rawItems.push({
        id: part.id,
        role: 'assistant',
        displayKind: 'error',
        kind: 'run_error',
        status: 'failed',
        timestamp: part.createdAt,
        compactSummary: part.error,
        copyText: part.error,
        rawDebugText: JSON.stringify(part, null, 2),
        detailView: 'inline',
        error: part.error,
        recoverable: part.recoverable,
        diagnosticCode: part.diagnosticCode
      });
    }
  }

  return groupTranscriptToolItems(rawItems);
}

export function collapseCompletedToolGroups(items: TranscriptViewItem[]): TranscriptViewItem[] {
  const toolGroups = items.filter((item): item is Extract<TranscriptViewItem, { kind: 'tool_group' }> => item.kind === 'tool_group');
  if (toolGroups.length <= 1 || toolGroups.some((item) => item.status === 'running' || item.status === 'pending')) {
    return items;
  }

  const firstToolGroupIndex = items.findIndex((item) => item.kind === 'tool_group');
  if (firstToolGroupIndex < 0) {
    return items;
  }

  const tools = toolGroups.flatMap((item) => item.tools);
  const firstGroup = toolGroups[0];
  const hasAssistantTextAfterSummary = items
    .slice(firstToolGroupIndex + 1)
    .some((item) => item.kind === 'assistant_text');
  const mergedToolGroup = createToolGroupItem({
    id: toolGroups.map((item) => item.id).join(':'),
    timestamp: firstGroup.timestamp,
    tools,
    collapseBeforeAssistantText: hasAssistantTextAfterSummary
  });

  const collapsed: TranscriptViewItem[] = [];
  let insertedMergedGroup = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'tool_group') {
      collapsed.push(item);
      continue;
    }
    if (!insertedMergedGroup) {
      collapsed.push(mergedToolGroup);
      insertedMergedGroup = true;
    }
  }
  return collapsed;
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
    grouped.push(createToolGroupItem({
      id,
      timestamp: item.timestamp,
      tools,
      collapseBeforeAssistantText
    }));
  }

  return grouped;
}

function createToolGroupItem(input: {
  id: string;
  timestamp: string;
  tools: ToolExecutionEntry[];
  collapseBeforeAssistantText: boolean;
}): Extract<TranscriptViewItem, { kind: 'tool_group' }> {
  const failureCount = input.tools.filter((tool) => tool.status === 'failed' || tool.result?.isError).length;
  const runningCount = input.tools.filter((tool) => tool.status === 'running' || tool.status === 'pending').length;
  const status = failureCount
    ? 'failed'
    : runningCount
      ? 'running'
      : 'completed';
  const stepSummary = buildToolStepSummary(input.tools, runningCount > 0);
  const compactSummary = input.tools
    .map((tool) => tool.activity ?? tool.summary ?? tool.title ?? tool.name)
    .filter(Boolean)
    .join(' · ');
  return {
    id: input.id,
    role: 'tool',
    displayKind: 'tool',
    kind: 'tool_group',
    status,
    timestamp: input.timestamp,
    compactSummary,
    copyText: input.tools.map((tool) => [
      tool.title ?? tool.name,
      tool.summary,
      tool.result?.content
    ].filter(Boolean).join('\n')).join('\n\n'),
    rawDebugText: JSON.stringify(input.tools, null, 2),
    detailView: 'overlay',
    tools: input.tools,
    collapseBeforeAssistantText: input.collapseBeforeAssistantText,
    stepKind: resolveToolStepKind(input.tools),
    stepSummary,
    failureCount,
    runningCount
  };
}

function buildToolStepSummary(tools: ToolExecutionEntry[], running: boolean): TranscriptToolStepSummary {
  const counts = {
    read: 0,
    search: 0,
    write: 0,
    command: 0,
    engine: 0,
    asset: 0,
    mcp: 0,
    task: 0,
    other: 0
  };

  for (const tool of tools) {
    const stepKind = resolveSingleToolStepKind(tool);
    if (stepKind === 'asset') {
      counts.asset += 1;
      continue;
    }
    if (stepKind === 'engine') {
      counts.engine += 1;
      continue;
    }
    const activityKind = getToolActivityKind(tool);
    counts[activityKind] += 1;
  }

  const zhSegments = [
    counts.read ? `探索 ${counts.read} 个文件` : '',
    counts.search ? `搜索 ${counts.search} 次` : '',
    counts.write ? `编辑 ${counts.write} 个文件` : '',
    counts.command ? `运行 ${counts.command} 条命令` : '',
    counts.engine ? `处理 ${counts.engine} 个引擎工具` : '',
    counts.asset ? `处理 ${counts.asset} 个素材工具` : '',
    counts.mcp ? `调用 ${counts.mcp} 个 MCP 工具` : '',
    counts.task ? `更新 ${counts.task} 次任务清单` : '',
    counts.other ? `处理 ${counts.other} 个工具` : ''
  ].filter(Boolean);
  const completedEnSegments = [
    counts.read ? `Explored ${counts.read} ${counts.read === 1 ? 'file' : 'files'}` : '',
    counts.search ? `${counts.search} ${counts.search === 1 ? 'search' : 'searches'}` : '',
    counts.write ? `edited ${counts.write} ${counts.write === 1 ? 'file' : 'files'}` : '',
    counts.command ? `ran ${counts.command} ${counts.command === 1 ? 'command' : 'commands'}` : '',
    counts.engine ? `checked ${counts.engine} engine ${counts.engine === 1 ? 'tool' : 'tools'}` : '',
    counts.asset ? `handled ${counts.asset} asset ${counts.asset === 1 ? 'tool' : 'tools'}` : '',
    counts.mcp ? `called ${counts.mcp} MCP ${counts.mcp === 1 ? 'tool' : 'tools'}` : '',
    counts.task ? `updated task list ${counts.task} ${counts.task === 1 ? 'time' : 'times'}` : '',
    counts.other ? `handled ${counts.other} ${counts.other === 1 ? 'tool' : 'tools'}` : ''
  ].filter(Boolean);
  const runningEnSegments = [
    counts.read ? `Exploring ${counts.read} ${counts.read === 1 ? 'file' : 'files'}` : '',
    counts.search ? `${counts.search} ${counts.search === 1 ? 'search' : 'searches'}` : '',
    counts.write ? `editing ${counts.write} ${counts.write === 1 ? 'file' : 'files'}` : '',
    counts.command ? `running ${counts.command} ${counts.command === 1 ? 'command' : 'commands'}` : '',
    counts.engine ? `checking ${counts.engine} engine ${counts.engine === 1 ? 'tool' : 'tools'}` : '',
    counts.asset ? `handling ${counts.asset} asset ${counts.asset === 1 ? 'tool' : 'tools'}` : '',
    counts.mcp ? `calling ${counts.mcp} MCP ${counts.mcp === 1 ? 'tool' : 'tools'}` : '',
    counts.task ? `updating task list ${counts.task} ${counts.task === 1 ? 'time' : 'times'}` : '',
    counts.other ? `handling ${counts.other} ${counts.other === 1 ? 'tool' : 'tools'}` : ''
  ].filter(Boolean);
  return {
    zhCN: `${running ? '正在' : '已'}${zhSegments.join('，') || '处理工具'}`,
    enUS: (running ? runningEnSegments : completedEnSegments).join(', ') || (running ? 'Running tool activity' : 'Completed tool activity')
  };
}

function resolveToolStepKind(tools: ToolExecutionEntry[]): TranscriptToolStepKind {
  const buckets = new Set<TranscriptToolStepKind>();
  for (const tool of tools) {
    buckets.add(resolveSingleToolStepKind(tool));
  }
  if (buckets.size === 0) {
    return 'other';
  }
  if (buckets.has('asset') && buckets.size === 1) {
    return 'asset';
  }
  if (buckets.has('engine') && buckets.size === 1) {
    return 'engine';
  }
  if (buckets.has('task') && buckets.size === 1) {
    return 'task';
  }
  if (buckets.has('edit')) {
    return 'edit';
  }
  if (buckets.has('command')) {
    return 'command';
  }
  if (buckets.size === 1 && buckets.has('explore')) {
    return 'explore';
  }
  if (buckets.size === 1 && buckets.has('other')) {
    return 'other';
  }
  return 'mixed';
}

function resolveSingleToolStepKind(tool: ToolExecutionEntry): TranscriptToolStepKind {
  const label = [tool.name, tool.title, tool.summary, tool.activity]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(asset|media|image|audio|sound|mesh|model|texture|sprite)\b|生成素材|素材生成|media_attach|generate_asset|open_asset|replicate|comfyui|meshy|elevenlabs|stability/.test(label)) {
    return 'asset';
  }
  if (/\b(engine|unity|cocos|godot|unreal|mcp|bridge)\b|open_engine_project|diagnose_engine_status|refresh_engine_runtime/.test(label)) {
    return 'engine';
  }
  const activityKind = getToolActivityKind(tool);
  if (activityKind === 'read' || activityKind === 'search') {
    return 'explore';
  }
  if (activityKind === 'write') {
    return 'edit';
  }
  if (activityKind === 'command') {
    return 'command';
  }
  if (activityKind === 'task') {
    return 'task';
  }
  return 'other';
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
