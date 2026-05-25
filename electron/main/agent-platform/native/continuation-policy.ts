import { ensureProjectSessions } from '../../../../shared/project-sessions';
import type { AgentCoreMessagePart, Project, ProjectSession } from '../../../../shared/types';
import {
  createAgentIncompleteTodoContinuationPrompt,
  createAgentLengthContinuationPrompt,
  createAgentPartialWriteContinuationPrompt,
  isAgentLengthLimitedFinishReason,
  looksLikeAgentTodoContinuationReply,
  looksLikeUnfinishedAgentWriteReply
} from '../../../../shared/agent-continuation-policy';
import type { OpenAiCompatibleToolCall } from '../../openai-compatible-client';
import type { GenericAgentRuntimeParams } from '../types';
import type { NativeWorkspaceToolOutput } from './tool-executor';

export type NativeTodoItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface NativeTodoItemSnapshot {
  id?: string;
  content: string;
  status: NativeTodoItemStatus;
  priority?: 'high' | 'medium' | 'low';
}

export interface NativeTodoSnapshot {
  items: NativeTodoItemSnapshot[];
  incompleteItems: NativeTodoItemSnapshot[];
  hasInProgress: boolean;
}

export interface NativeEditFailureRecovery {
  toolName: string;
  path?: string;
  summary: string;
  failureKind?: string;
  recoveryHint?: string;
}

function normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function truncateToolArgumentPreview(value: string, maxLength = 1200): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

export function shouldContinueAfterPartialWriteReply(input: {
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  assistantMessage: string;
}): boolean {
  if (!input.includeWriteTools || input.permissionMode === 'read-only') {
    return false;
  }
  return looksLikeUnfinishedAgentWriteReply(input.assistantMessage);
}

export function createPartialWriteContinuationPrompt(assistantMessage: string): string {
  return createAgentPartialWriteContinuationPrompt(assistantMessage);
}

function isEditRecoveryToolName(toolName: string): boolean {
  return toolName === 'edit_file' || toolName === 'multi_edit' || toolName === 'patch_file';
}

function formatEditRecoveryPath(input: Record<string, unknown>): string | undefined {
  return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
}

export function collectEditFailureRecovery(toolCall: OpenAiCompatibleToolCall, toolResult: NativeWorkspaceToolOutput): NativeEditFailureRecovery | undefined {
  if (!toolResult.isError || !isEditRecoveryToolName(toolCall.name) || !toolResult.edit || toolResult.edit.preflight !== 'failed') {
    return undefined;
  }
  return {
    toolName: toolCall.name,
    path: formatEditRecoveryPath(toolCall.arguments),
    summary: toolResult.summary ?? '编辑工具失败。',
    failureKind: toolResult.edit.failureKind,
    recoveryHint: toolResult.edit.recoveryHint
  };
}

export function createEditFailureRecoveryPrompt(recoveries: NativeEditFailureRecovery[]): string {
  const lines = recoveries.slice(0, 6).map((recovery, index) => {
    const path = recovery.path ? ` ${recovery.path}` : '';
    const failureKind = recovery.failureKind ? ` (${recovery.failureKind})` : '';
    const hint = recovery.recoveryHint ? `；建议：${recovery.recoveryHint}` : '';
    return `${index + 1}. ${recovery.toolName}${path}${failureKind}: ${truncateToolArgumentPreview(recovery.summary, 500)}${hint}`;
  });
  const paths = [...new Set(recoveries.map((recovery) => recovery.path).filter((path): path is string => Boolean(path)))];
  return [
    '上一轮文件编辑工具失败，失败的工具没有修改项目文件。下一步必须按恢复流程继续，不要把失败当成功。',
    '',
    '失败详情：',
    ...lines,
    '',
    '恢复规则：',
    paths.length
      ? `- 先重新读取失败文件的最新相关片段：${paths.map((path) => `read_file ${path}`).join('；')}。`
      : '- 先用 read_file 重新读取失败文件的最新相关片段。',
    '- 不要复用刚才失败的 oldText；新的 oldText 必须从最新 read_file 输出中逐字复制，并且能唯一匹配。',
    '- 如果目标变更跨多处、上下文不确定，优先使用 preview_patch 预检 unified diff，再用 patch_file 应用。',
    '- 不要调用 edits 为空的 multi_edit；multi_edit 至少需要 1 个有效编辑操作。',
    '- 修复后继续完成用户原始任务，并在最终答复里只总结实际成功写入的内容。'
  ].join('\n');
}

function normalizeTodoStatus(value: unknown): NativeTodoItemStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled' ? value : undefined;
}

function normalizeTodoPriority(value: unknown): NativeTodoItemSnapshot['priority'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

function createTodoSnapshot(items: NativeTodoItemSnapshot[]): NativeTodoSnapshot | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const incompleteItems = items.filter((item) => item.status === 'pending' || item.status === 'in_progress');
  return {
    items,
    incompleteItems,
    hasInProgress: incompleteItems.some((item) => item.status === 'in_progress')
  };
}

function parseTodoInputAlias(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function resolveTodoInputItems(input: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!input) {
    return undefined;
  }
  const candidates = [
    input.items,
    parseTodoInputAlias(input.todos)
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items;
      }
      if (Array.isArray(record.todos)) {
        return record.todos;
      }
    }
  }
  return undefined;
}

function parseTodoSnapshotFromInput(input: Record<string, unknown> | undefined): NativeTodoSnapshot | undefined {
  const rawItems = resolveTodoInputItems(input);
  if (!rawItems) {
    return undefined;
  }
  const items = rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item): NativeTodoItemSnapshot | undefined => {
      const status = normalizeTodoStatus(item.status);
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!status || !content) {
        return undefined;
      }
      return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
        content,
        status,
        priority: normalizeTodoPriority(item.priority)
      };
    })
    .filter((item): item is NativeTodoItemSnapshot => Boolean(item));
  return createTodoSnapshot(items);
}

function parseTodoSnapshotFromSummary(summary: string): NativeTodoSnapshot | undefined {
  const items = summary
    .split('\n')
    .map((line): NativeTodoItemSnapshot | undefined => {
      const match = line.match(/^-\s+\[(pending|in_progress|completed|cancelled)]\s+(.+?)(?:\s+\((high|medium|low)\))?:\s+(.+)$/);
      if (!match) {
        return undefined;
      }
      return {
        id: match[2]?.trim() || undefined,
        content: match[4]?.trim() || '',
        status: match[1] as NativeTodoItemStatus,
        priority: normalizeTodoPriority(match[3])
      };
    })
    .filter((item): item is NativeTodoItemSnapshot => Boolean(item?.content));
  return createTodoSnapshot(items);
}

export function resolveTodoSnapshotFromToolResult(input: {
  toolName: string;
  toolInput?: Record<string, unknown>;
  summary: string;
  isError?: boolean;
}): NativeTodoSnapshot | undefined {
  if (input.toolName !== 'update_todo_list' || input.isError) {
    return undefined;
  }
  return parseTodoSnapshotFromInput(input.toolInput) ?? parseTodoSnapshotFromSummary(input.summary);
}

function selectNativeToolLoopSession(project: Project, sessionId?: string): ProjectSession | undefined {
  const ensured = ensureProjectSessions(project);
  return sessionId
    ? ensured.sessions.find((session) => session.id === sessionId)
    : ensured.sessions.find((session) => session.id === ensured.activeSessionId) ?? ensured.sessions[0];
}

function resolveLatestTodoSnapshotFromAgentCoreParts(parts: AgentCoreMessagePart[] | undefined): NativeTodoSnapshot | undefined {
  if (!parts?.length) {
    return undefined;
  }
  const toolInputs = new Map<string, {
    name: string;
    input?: Record<string, unknown>;
  }>();
  let latestSnapshot: NativeTodoSnapshot | undefined;
  for (const part of [...parts].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  })) {
    if (part.kind === 'tool_call') {
      toolInputs.set(part.toolUseId, {
        name: part.name,
        input: normalizeToolInput(part.input)
      });
      continue;
    }
    if (part.kind !== 'tool_result' && part.kind !== 'tool_error') {
      continue;
    }
    const toolUse = toolInputs.get(part.toolUseId);
    const snapshot = resolveTodoSnapshotFromToolResult({
      toolName: toolUse?.name ?? part.toolName ?? '',
      toolInput: toolUse?.input,
      summary: part.kind === 'tool_error' ? part.error : part.content,
      isError: part.kind === 'tool_error'
    });
    if (snapshot) {
      latestSnapshot = snapshot;
    }
  }
  return latestSnapshot;
}

export function resolveLatestTodoSnapshotFromHistory(params: Pick<GenericAgentRuntimeParams, 'project' | 'context'>): NativeTodoSnapshot | undefined {
  const session = selectNativeToolLoopSession(params.project, params.context.activeSessionId);
  const chat = session?.chat ?? [];
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index];
    const snapshot = resolveLatestTodoSnapshotFromAgentCoreParts(message?.metadata?.agentCoreParts);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

export function shouldContinueAfterIncompleteTodo(input: {
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  latestTodoSnapshot?: NativeTodoSnapshot;
  assistantMessage: string;
}): boolean {
  if (!input.includeWriteTools || input.permissionMode === 'read-only') {
    return false;
  }
  const incompleteItems = input.latestTodoSnapshot?.incompleteItems ?? [];
  if (incompleteItems.length === 0) {
    return false;
  }
  if (!input.assistantMessage.trim()) {
    return true;
  }
  if (input.latestTodoSnapshot?.hasInProgress) {
    return true;
  }
  return looksLikeUnfinishedAgentWriteReply(input.assistantMessage) || looksLikeAgentTodoContinuationReply(input.assistantMessage);
}

export function createIncompleteTodoContinuationPrompt(snapshot: NativeTodoSnapshot, assistantMessage: string): string {
  return createAgentIncompleteTodoContinuationPrompt(snapshot, assistantMessage);
}

export function isLengthLimitedFinishReason(finishReason?: string): boolean {
  return isAgentLengthLimitedFinishReason(finishReason);
}

export function createLengthContinuationPrompt(assistantMessage: string): string {
  return createAgentLengthContinuationPrompt(assistantMessage);
}
