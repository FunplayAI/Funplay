import { nowIso } from '../../../shared/utils';
import type {
  AgentCoreProviderStepResult,
  AgentCoreState,
  AgentCoreStateMachineSnapshot,
  AgentRuntimeEvent
} from '../../../shared/types';
import type { GenericAgentRuntimeParams } from './types';
import type { StageEvent, StreamContext } from './stream-types';
import {
  recordActiveRunAgentCoreState,
  recordActiveRunContextSummary,
  recordActiveRunTimelineEntry,
  recordActiveRunToolResult,
  recordActiveRunToolUse,
  recordActiveRunTodoUpdate,
  recordActiveRunUsage,
  updateActiveRunToolBoundary
} from './run-registry';

const AGENT_CORE_STATES = new Set<AgentCoreState>([
  'initializing',
  'loading_context',
  'building_model_input',
  'streaming_model_step',
  'collecting_tool_calls',
  'awaiting_permission',
  'executing_tools',
  'awaiting_user_input',
  'recording_tool_results',
  'continuing_after_tools',
  'compacting_context',
  'verifying_work',
  'completed',
  'failed',
  'cancelled',
  'interrupted_resumable'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAgentCoreStateMachineSnapshot(value: unknown): value is AgentCoreStateMachineSnapshot {
  if (!isRecord(value) || typeof value.state !== 'string' || !AGENT_CORE_STATES.has(value.state as AgentCoreState)) {
    return false;
  }
  return Array.isArray(value.history);
}

function getAgentCoreStateFromStage(stage: StageEvent): AgentCoreStateMachineSnapshot | undefined {
  const coreState = stage.input?.coreState;
  return isAgentCoreStateMachineSnapshot(coreState) ? coreState : undefined;
}

function getProviderStepFromStage(stage: StageEvent): AgentCoreProviderStepResult | undefined {
  const providerStep = stage.input?.providerStep;
  if (!isRecord(providerStep) || typeof providerStep.finishReason !== 'string' || !Array.isArray(providerStep.toolCalls)) {
    return undefined;
  }
  return providerStep as unknown as AgentCoreProviderStepResult;
}

function getContextSummaryFromStage(stage: StageEvent): NonNullable<AgentRuntimeEvent['contextSummary']> | undefined {
  const summary = stage.input?.contextSummary;
  if (typeof summary !== 'string' || !summary.trim()) {
    return undefined;
  }
  const coverage = stage.input?.contextSummaryCoverage;
  return {
    summary,
    coverage: isRecord(coverage) ? coverage : undefined,
    runtimeId: stage.runtimeId,
    sourceStageId: stage.stageId
  };
}

function parseJsonAlias(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeTodoStatus(value: unknown): NonNullable<AgentRuntimeEvent['todoUpdate']>['items'][number]['status'] | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
    ? value
    : undefined;
}

function getTodoItemsFromInput(tool: Parameters<NonNullable<GenericAgentRuntimeParams['onToolUse']>>[0]): NonNullable<AgentRuntimeEvent['todoUpdate']> | undefined {
  if (tool.name !== 'update_todo_list') {
    return undefined;
  }
  const input = tool.input ?? {};
  const candidates = [
    input.todos,
    input.items,
    parseJsonAlias(input.todos)
  ];
  for (const candidate of candidates) {
    const rawItems = Array.isArray(candidate)
      ? candidate
      : isRecord(candidate) && Array.isArray(candidate.items)
        ? candidate.items
        : isRecord(candidate) && Array.isArray(candidate.todos)
          ? candidate.todos
          : undefined;
    const items = rawItems
      ?.map((item, index) => {
        if (!isRecord(item)) {
          return undefined;
        }
        const title = typeof item.content === 'string' && item.content.trim()
          ? item.content.trim()
          : typeof item.title === 'string' && item.title.trim()
            ? item.title.trim()
            : undefined;
        const status = normalizeTodoStatus(item.status);
        if (!title || !status) {
          return undefined;
        }
        return {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `todo_${index + 1}`,
          title,
          status
        };
      })
      .filter((item): item is NonNullable<NonNullable<AgentRuntimeEvent['todoUpdate']>['items'][number]> => Boolean(item));
    if (items?.length) {
      return {
        toolUseId: tool.toolUseId,
        items
      };
    }
  }
  return undefined;
}

export function makeToolUseHandler(ctx: StreamContext): NonNullable<GenericAgentRuntimeParams['onToolUse']> {
  return (tool) => {
    ctx.toolNamesByUseId.set(tool.toolUseId, tool.name);
    recordActiveRunToolUse(ctx.activeRunId, tool);
    const todoUpdate = getTodoItemsFromInput(tool);
    if (todoUpdate) {
      recordActiveRunTodoUpdate(ctx.activeRunId, todoUpdate);
    }
    ctx.dispatchEvent({
      type: 'tool_use',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      toolUseId: tool.toolUseId,
      name: tool.name,
      input: tool.input,
      status: tool.status,
      startedAt: ctx.startedAt
    });
  };
}

export function makeToolResultHandler(ctx: StreamContext): NonNullable<GenericAgentRuntimeParams['onToolResult']> {
  return (result) => {
    const completedAt = nowIso();
    const toolName = result.toolName ?? ctx.toolNamesByUseId.get(result.toolUseId);
    recordActiveRunToolResult(ctx.activeRunId, {
      toolUseId: result.toolUseId,
      toolName,
      content: result.content,
      isError: result.isError,
      changedFiles: result.changedFiles,
      command: result.command,
      terminal: result.terminal,
      browser: result.browser,
      edit: result.edit,
      mcp: result.mcp,
      artifacts: result.artifacts,
      transaction: result.transaction
    });
    updateActiveRunToolBoundary(ctx.activeRunId, {
      toolUseId: result.toolUseId,
      toolName,
      phase: 'tool_result',
      status: result.isError ? 'failed' : 'completed',
      checkpointSnapshotId: ctx.checkpointSnapshotId,
      completedAt,
      summary: result.content.slice(0, 600),
      transaction: result.transaction
    });
    ctx.dispatchEvent({
      type: 'tool_result',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      toolUseId: result.toolUseId,
      content: result.content,
      isError: result.isError,
      media: result.media,
      changedFiles: result.changedFiles,
      command: result.command,
      terminal: result.terminal,
      browser: result.browser,
      edit: result.edit,
      mcp: result.mcp,
      artifacts: result.artifacts,
      transaction: result.transaction,
      startedAt: ctx.startedAt
    });
  };
}

export function makeStageHandler(
  ctx: StreamContext,
  opts?: {
    updateMetadata?: (stage: StageEvent) => void;
    extraDispatchFields?: (stage: StageEvent) => Record<string, unknown>;
    onAfterDispatch?: (stage: StageEvent) => void;
  }
): NonNullable<GenericAgentRuntimeParams['onStage']> {
  return (stage) => {
    opts?.updateMetadata?.(stage);
    const coreState = getAgentCoreStateFromStage(stage);
    if (coreState) {
      recordActiveRunAgentCoreState(ctx.activeRunId, {
        coreState,
        providerStep: getProviderStepFromStage(stage)
      });
    }
    const contextSummary = getContextSummaryFromStage(stage);
    if (contextSummary) {
      recordActiveRunContextSummary(ctx.activeRunId, contextSummary);
    }
    recordActiveRunTimelineEntry(ctx.activeRunId, {
      id: stage.stageId,
      phase: stage.phase,
      title: stage.title,
      target: stage.target,
      status: stage.status,
      summary: stage.summary,
      errorMessage: stage.errorMessage
    });
    const extraFields = opts?.extraDispatchFields?.(stage) ?? {};
    ctx.dispatchEvent({
      type: 'stage',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      stageId: stage.stageId,
      phase: stage.phase,
      title: stage.title,
      target: stage.target,
      status: stage.status,
      input: stage.input,
      summary: stage.summary,
      errorMessage: stage.errorMessage,
      transaction: stage.transaction,
      startedAt: ctx.startedAt,
      ...extraFields
    });
    opts?.onAfterDispatch?.(stage);
  };
}

export function makeUsageHandler(ctx: StreamContext): NonNullable<GenericAgentRuntimeParams['onUsage']> {
  return (usage) => {
    const totals = recordActiveRunUsage(ctx.activeRunId, usage);
    if (!totals) {
      return;
    }
    ctx.dispatchEvent({
      type: 'usage',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      usage,
      totals,
      startedAt: ctx.startedAt
    });
  };
}
