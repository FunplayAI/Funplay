import type {
  AgentCoreProviderStepResult,
  AgentCoreStateMachineSnapshot,
  AgentOperationStatus,
  AgentRunKind,
  AgentRuntimeEvent,
  AgentRuntimeStatus,
  AgentRuntimeTimelineEntry,
  AgentRuntimeToolBoundary,
  AgentLifecycleHookEvaluationResult,
  AgentSkillActivation,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentToolTransactionSummary,
  RuntimeUsage,
  RuntimeUsageTotals
} from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import {
  deleteRuntimeRun,
  getRuntimeRun,
  listRuntimeRuns,
  type PersistedRuntimeRunRequest,
  upsertRuntimeRun
} from '../store';
import { accumulateUsage, emptyUsageTotals } from './usage';
import {
  createAgentTaskGraph,
  finalizeAgentTaskGraph,
  updateAgentTaskGraphFromSubagentResult,
  updateAgentTaskGraphFromTimelineEntry,
  updateAgentTaskGraphFromToolResult,
  updateAgentTaskGraphFromToolUse
} from './task-graph';
import { createVerificationReport, finalizeVerificationReport, updateVerificationReportFromTimelineEntry, updateVerificationReportFromToolResult } from './verification-loop';

export interface ActiveAgentRun extends AgentRuntimeStatus {
  controller?: AbortController;
  request: PersistedRuntimeRunRequest;
}

const activeRunsById = new Map<string, ActiveAgentRun>();
const MAX_RUNTIME_EVENTS = 240;
const MAX_RUNTIME_DELTA_PREVIEW_CHARS = 1600;

function appendRuntimeEvent(
  run: ActiveAgentRun,
  event: Omit<AgentRuntimeEvent, 'id' | 'createdAt'>
): AgentRuntimeEvent[] {
  return [
    ...(run.events ?? []),
    {
      id: makeId('arevt'),
      createdAt: nowIso(),
      ...event
    }
  ].slice(-MAX_RUNTIME_EVENTS);
}

function compactRuntimeDeltaText(value: string): {
  preview: string;
  truncated: boolean;
} {
  if (value.length <= MAX_RUNTIME_DELTA_PREVIEW_CHARS) {
    return {
      preview: value,
      truncated: false
    };
  }
  return {
    preview: `[truncated ${value.length - MAX_RUNTIME_DELTA_PREVIEW_CHARS} chars]\n${value.slice(-MAX_RUNTIME_DELTA_PREVIEW_CHARS)}`,
    truncated: true
  };
}

function upsertRuntimeDeltaEvent(
  run: ActiveAgentRun,
  event: Omit<AgentRuntimeEvent, 'id' | 'createdAt'>
): AgentRuntimeEvent[] {
  const events = run.events ?? [];
  const last = events.at(-1);
  if (last?.type !== event.type) {
    return appendRuntimeEvent(run, event);
  }
  const streamDelta = event.streamDelta;
  if (!streamDelta) {
    return appendRuntimeEvent(run, event);
  }

  return [
    ...events.slice(0, -1),
    {
      ...last,
      status: event.status,
      streamDelta: {
        ...streamDelta,
        eventCount: (last.streamDelta?.eventCount ?? 1) + 1
      },
      metadata: {
        ...last.metadata,
        ...event.metadata,
        updatedAt: nowIso()
      }
    }
  ].slice(-MAX_RUNTIME_EVENTS);
}

function persistRuntimeRun(run: ActiveAgentRun): void {
  upsertRuntimeRun({
    id: run.id,
    kind: run.kind,
    projectId: run.projectId,
    sessionId: run.sessionId,
    streamId: run.streamId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    statusMessage: run.statusMessage,
    checkpointSnapshotId: run.checkpointSnapshotId,
    inputPreview: run.inputPreview,
    request: run.request,
    lastError: run.lastError,
    resumedFromRunId: run.resumedFromRunId,
    timeline: run.timeline,
    lastToolBoundary: run.lastToolBoundary,
    resumeStrategy: run.resumeStrategy,
    taskGraph: run.taskGraph,
    verification: run.verification,
    usage: run.usage,
    events: run.events
  });
}

export function registerActiveRun(params: {
  kind: AgentRunKind;
  projectId: string;
  sessionId?: string;
  streamId?: string;
  checkpointSnapshotId?: string;
  inputPreview?: string;
  request: PersistedRuntimeRunRequest;
  controller?: AbortController;
  resumedFromRunId?: string;
}): ActiveAgentRun {
  const timestamp = nowIso();
  const runId = makeId('arun');
  const taskGraph = createAgentTaskGraph({
    runId,
    kind: params.kind,
    goal: params.inputPreview ?? params.request.inputPreview ?? params.request.message,
    createdAt: timestamp,
    checkpointSnapshotId: params.checkpointSnapshotId
  });
  const verification = createVerificationReport({
    runId,
    createdAt: timestamp
  });
  const run: ActiveAgentRun = {
    id: runId,
    kind: params.kind,
    projectId: params.projectId,
    sessionId: params.sessionId,
    runtimeId: params.request.runtimeId ?? (params.request.kind === 'execute-plan' ? 'execute-plan' : undefined),
    providerId: params.request.providerId,
    model: params.request.model,
    permissionMode: params.request.permissionMode,
    streamId: params.streamId,
    startedAt: timestamp,
    updatedAt: timestamp,
    status: 'running',
    statusMessage: undefined,
    checkpointSnapshotId: params.checkpointSnapshotId,
    canResume: false,
    inputPreview: params.inputPreview,
    resumedFromRunId: params.resumedFromRunId,
    taskGraph,
    verification,
    events: [],
    controller: params.controller,
    request: params.request
  };
  run.events = appendRuntimeEvent(run, {
    type: 'run_registered',
    status: 'running',
    statusMessage: run.statusMessage,
    metadata: {
      kind: run.kind,
      streamId: run.streamId,
      resumedFromRunId: run.resumedFromRunId,
      checkpointSnapshotId: run.checkpointSnapshotId
    }
  });

  activeRunsById.set(run.id, run);
  persistRuntimeRun(run);
  return run;
}

export function unregisterActiveRun(
  runId: string,
  options?: {
    finalStatus?: 'completed' | 'interrupted' | 'failed';
    error?: string;
  }
): void {
  const active = activeRunsById.get(runId) ?? getRuntimeRun(runId);
  activeRunsById.delete(runId);

  if (!active) {
    return;
  }

  const persistedStatus = options?.finalStatus ?? 'completed';
  const updatedAt = nowIso();
  const taskGraph = finalizeAgentTaskGraph(active.taskGraph, persistedStatus, updatedAt);
  const verification = finalizeVerificationReport(active.verification, persistedStatus, updatedAt);
  const eventType =
    persistedStatus === 'completed'
      ? 'run_completed'
      : persistedStatus === 'interrupted'
        ? 'run_interrupted'
        : 'run_failed';
  const events = appendRuntimeEvent(active, {
    type: eventType,
    status: persistedStatus,
    statusMessage: active.statusMessage,
    error: options?.error
  });

  upsertRuntimeRun({
    id: active.id,
    kind: active.kind,
    projectId: active.projectId,
    sessionId: active.sessionId,
    streamId: active.streamId,
    status: persistedStatus,
    startedAt: active.startedAt,
    updatedAt,
    statusMessage: active.statusMessage,
    checkpointSnapshotId: active.checkpointSnapshotId,
    inputPreview: active.inputPreview,
    request: active.request,
    lastError: options?.error,
    resumedFromRunId: active.resumedFromRunId,
    timeline: active.timeline,
    lastToolBoundary: active.lastToolBoundary,
    resumeStrategy: active.resumeStrategy,
    taskGraph,
    verification,
    usage: active.usage,
    events
  });
}

export function recordActiveRunAgentCoreState(runId: string, input: {
  coreState: AgentCoreStateMachineSnapshot;
  providerStep?: AgentCoreProviderStepResult;
}): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso(),
    coreState: input.coreState
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'agent_core_state',
    status: updated.status,
    coreState: input.coreState,
    providerStep: input.providerStep,
    statusMessage: input.coreState.history.at(-1)?.reason
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunContextSummary(runId: string, input: NonNullable<AgentRuntimeEvent['contextSummary']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'context_summary',
    status: updated.status,
    statusMessage: 'Context summary recorded.',
    contextSummary: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunTodoUpdate(runId: string, input: NonNullable<AgentRuntimeEvent['todoUpdate']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'todo_update',
    status: updated.status,
    statusMessage: `Todo list updated: ${input.items.length} item(s).`,
    todoUpdate: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunPermissionRequest(runId: string, input: NonNullable<AgentRuntimeEvent['permissionRequest']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'permission_request',
    status: updated.status,
    statusMessage: `Permission requested: ${input.title}`,
    permissionRequest: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunPermissionResolved(runId: string, input: NonNullable<AgentRuntimeEvent['permissionResponse']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'permission_resolved',
    status: updated.status,
    statusMessage: `Permission ${input.decision}.`,
    permissionResponse: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunUserInputRequest(runId: string, input: NonNullable<AgentRuntimeEvent['userInputRequest']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'user_input_request',
    status: updated.status,
    statusMessage: `User input requested: ${input.question}`,
    userInputRequest: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunUserInputResolved(runId: string, input: NonNullable<AgentRuntimeEvent['userInputResponse']>): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'user_input_resolved',
    status: updated.status,
    statusMessage: input.cancelled ? 'User input was cancelled.' : 'User input was resolved.',
    userInputResponse: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunSkillActivation(runId: string, input: AgentSkillActivation): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'skill_activation',
    status: updated.status,
    statusMessage: `Skill activated: ${input.name}`,
    skillActivation: input
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunLifecycleHook(runId: string, input: AgentLifecycleHookEvaluationResult): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  const failed = input.status === 'blocked' ||
    input.status === 'permission_denied' ||
    input.status === 'command_failed';
  updated.events = appendRuntimeEvent(updated, {
    type: 'hook',
    status: failed ? 'failed' : updated.status,
    statusMessage: input.summary,
    hook: input,
    metadata: {
      hookId: input.id,
      ruleId: input.ruleId,
      event: input.event,
      actionType: input.actionType,
      hookStatus: input.status
    }
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function findActiveRunBySession(sessionId: string): ActiveAgentRun | undefined {
  return [...activeRunsById.values()].find((run) => run.sessionId === sessionId);
}

export function findActiveRunByStream(streamId: string): ActiveAgentRun | undefined {
  return [...activeRunsById.values()].find((run) => run.streamId === streamId);
}

export function findActiveRunByProject(projectId: string, kind?: AgentRunKind): ActiveAgentRun | undefined {
  return [...activeRunsById.values()].find((run) => run.projectId === projectId && (!kind || run.kind === kind));
}

export function updateActiveRunStatus(runId: string, statusMessage?: string): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso(),
    statusMessage
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'status',
    status: 'running',
    statusMessage
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunTimelineEntry(runId: string, entry: {
  id: string;
  phase?: string;
  title: string;
  target: string;
  status: AgentOperationStatus;
  summary?: string;
  errorMessage?: string;
}): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const timestamp = nowIso();
  const existingTimeline = run.timeline ?? [];
  const existingIndex = existingTimeline.findIndex((item) => item.id === entry.id);
  const existing = existingIndex >= 0 ? existingTimeline[existingIndex] : undefined;
  const nextEntry: AgentRuntimeTimelineEntry = {
    id: entry.id,
    phase: entry.phase ?? existing?.phase,
    title: entry.title,
    target: entry.target,
    status: entry.status,
    startedAt: existing?.startedAt ?? timestamp,
    finishedAt: entry.status === 'completed' || entry.status === 'failed' || entry.status === 'skipped'
      ? timestamp
      : existing?.finishedAt,
    summary: entry.summary ?? existing?.summary,
    errorMessage: entry.errorMessage ?? existing?.errorMessage
  };
  const timeline =
    existingIndex >= 0
      ? existingTimeline.map((item, index) => (index === existingIndex ? nextEntry : item))
      : [...existingTimeline, nextEntry];
  const taskGraph = updateAgentTaskGraphFromTimelineEntry(run.taskGraph, nextEntry, timestamp);
  const verification = updateVerificationReportFromTimelineEntry(run.verification, nextEntry, timestamp);
  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: timestamp,
    timeline,
    taskGraph,
    verification
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'timeline',
    status: updated.status,
    timelineEntry: nextEntry
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunUsage(runId: string, usage: RuntimeUsage): RuntimeUsageTotals | undefined {
  const run = activeRunsById.get(runId);
  if (!run) {
    return undefined;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso(),
    usage: accumulateUsage(run.usage ?? emptyUsageTotals(), usage)
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'usage',
    status: updated.status,
    usage,
    usageTotals: updated.usage
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
  return updated.usage;
}

export function recordActiveRunStreamDelta(runId: string, input: {
  kind: 'text' | 'thinking';
  delta?: string;
  content: string;
}): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const compactContent = compactRuntimeDeltaText(input.content);
  const compactDelta = input.delta ? compactRuntimeDeltaText(input.delta) : undefined;
  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.events = upsertRuntimeDeltaEvent(updated, {
    type: input.kind === 'thinking' ? 'thinking_delta' : 'text_delta',
    status: updated.status,
    streamDelta: {
      deltaPreview: compactDelta?.preview,
      deltaLength: input.delta?.length,
      contentPreview: compactContent.preview,
      contentLength: input.content.length,
      truncated: compactContent.truncated || compactDelta?.truncated || undefined,
      eventCount: 1
    }
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunToolUse(runId: string, tool: {
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso()
  };
  updated.taskGraph = updateAgentTaskGraphFromToolUse(updated.taskGraph, tool, updated.updatedAt);
  updated.events = appendRuntimeEvent(updated, {
    type: 'tool_use',
    status: updated.status,
    toolUse: tool
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function recordActiveRunToolResult(runId: string, result: {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
  transaction?: AgentToolTransactionSummary;
}): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updatedAt = nowIso();
  const verification = updateVerificationReportFromToolResult(run.verification, result, updatedAt);
  const taskGraph = updateAgentTaskGraphFromToolResult(
    updateAgentTaskGraphFromSubagentResult(run.taskGraph, result, updatedAt),
    result,
    updatedAt
  );
  const updated: ActiveAgentRun = {
    ...run,
    updatedAt,
    taskGraph,
    verification
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'tool_result',
    status: updated.status,
    toolResult: {
      toolUseId: result.toolUseId,
      toolName: result.toolName,
      contentPreview: result.content.slice(0, 1200),
      isError: result.isError,
      changedFiles: result.changedFiles,
      command: result.command,
      terminal: result.terminal,
      browser: result.browser,
      edit: result.edit,
      mcp: result.mcp,
      artifacts: result.artifacts,
      transaction: result.transaction
    }
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function updateActiveRunToolBoundary(runId: string, boundary: AgentRuntimeToolBoundary): void {
  const run = activeRunsById.get(runId);
  if (!run) {
    return;
  }

  const updated: ActiveAgentRun = {
    ...run,
    updatedAt: nowIso(),
    lastToolBoundary: boundary,
    resumeStrategy: boundary.status === 'completed' ? 'resume_after_last_completed_tool' : run.resumeStrategy ?? 'restart_prompt'
  };
  updated.events = appendRuntimeEvent(updated, {
    type: 'tool_boundary',
    status: updated.status,
    toolBoundary: boundary
  });
  activeRunsById.set(runId, updated);
  persistRuntimeRun(updated);
}

export function interruptActiveRun(runId: string): { success: true } {
  const run = activeRunsById.get(runId);
  if (!run?.controller) {
    return { success: true };
  }

  run.controller.abort();
  return { success: true };
}

export function listActiveRuns(projectId?: string): AgentRuntimeStatus[] {
  return listRuntimeRuns(projectId);
}

export function getActiveOrPersistedRun(runId: string): ActiveAgentRun | undefined {
  return activeRunsById.get(runId) ?? getRuntimeRun(runId);
}

export function removePersistedRun(runId: string): void {
  activeRunsById.delete(runId);
  deleteRuntimeRun(runId);
}
