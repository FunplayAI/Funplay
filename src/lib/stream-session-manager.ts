import type {
  AgentRunKind,
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentToolTransactionSummary,
  AgentPermissionImpact,
  AgentUserInputOption,
  ChatMediaBlock,
  ChatMessageProcessActivity,
  ProjectSessionRuntimeId,
  PromptStreamEvent,
  PromptStreamPhase,
  RuntimeRecoveryAction,
  RuntimeUsage,
  RuntimeUsageTotals
} from '../../shared/types';

export interface StreamPermissionState {
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  impact?: AgentPermissionImpact;
}

export interface StreamUserInputState {
  requestId: string;
  title: string;
  question: string;
  detail?: string;
  options?: AgentUserInputOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  placeholder?: string;
  toolName?: string;
}

export interface StreamToolUseState {
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface StreamToolResultState {
  toolUseId: string;
  content: string;
  isError?: boolean;
  media?: ChatMediaBlock[];
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
  transaction?: AgentToolTransactionSummary;
}

export interface StreamStageState {
  stageId: string;
  phase?: string;
  title: string;
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  transaction?: AgentToolTransactionSummary;
}

export type StreamActivityItem = ChatMessageProcessActivity;

export interface StreamSessionState {
  streamId: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  content: string;
  thinkingContent: string;
  toolUses: StreamToolUseState[];
  toolResults: StreamToolResultState[];
  stages: StreamStageState[];
  activityItems: StreamActivityItem[];
  agentCoreParts?: AgentCoreMessagePart[];
  lastUsage?: RuntimeUsage;
  usageTotals?: RuntimeUsageTotals;
  pendingPermission?: StreamPermissionState;
  pendingUserInput?: StreamUserInputState;
  phase: PromptStreamPhase;
  statusMessage: string;
  startedAt: string;
  kind?: AgentRunKind;
}

export interface StreamSessionLabels {
  streaming: string;
  reasoning: string;
  toolRunning: (name: string) => string;
  toolCompleted: string;
  toolFailed: string;
  waitingPermission: string;
  waitingUserInput: string;
  permissionAllowed: string;
  permissionAllowedSession: string;
  permissionDenied: string;
  userInputSubmitted: string;
  completed: string;
}

type Listener = () => void;

const streamsKey = '__funplay_stream_sessions__' as const;
const listenersKey = '__funplay_stream_session_listeners__' as const;
const textSmoothingKey = '__funplay_stream_text_smoothing__' as const;
const MAX_STREAM_ACTIVITY_ITEMS = 80;

interface StreamTextSmoothingState {
  targetContent: string;
  timer?: ReturnType<typeof setTimeout>;
}

function getStreams(): Map<string, StreamSessionState> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[streamsKey]) {
    globalState[streamsKey] = new Map<string, StreamSessionState>();
  }
  return globalState[streamsKey] as Map<string, StreamSessionState>;
}

function getListeners(): Set<Listener> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[listenersKey]) {
    globalState[listenersKey] = new Set<Listener>();
  }
  return globalState[listenersKey] as Set<Listener>;
}

function getTextSmoothingStates(): Map<string, StreamTextSmoothingState> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[textSmoothingKey]) {
    globalState[textSmoothingKey] = new Map<string, StreamTextSmoothingState>();
  }
  return globalState[textSmoothingKey] as Map<string, StreamTextSmoothingState>;
}

function emitChange(): void {
  for (const listener of getListeners()) {
    listener();
  }
}

export function subscribeStreamSessions(listener: Listener): () => void {
  const listeners = getListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function seedStreamSession(snapshot: StreamSessionState): void {
  clearTextSmoothing(snapshot.streamId);
  getStreams().set(snapshot.streamId, snapshot);
  emitChange();
}

export function removeStreamSession(streamId: string): void {
  clearTextSmoothing(streamId);
  if (getStreams().delete(streamId)) {
    emitChange();
  }
}

export function clearStreamSessions(): void {
  if (getStreams().size === 0) {
    return;
  }
  for (const streamId of getStreams().keys()) {
    clearTextSmoothing(streamId);
  }
  getStreams().clear();
  emitChange();
}

function clearTextSmoothing(streamId: string): void {
  const states = getTextSmoothingStates();
  const state = states.get(streamId);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  states.delete(streamId);
}

function flushTextSmoothing(streamId: string): StreamSessionState | undefined {
  const streams = getStreams();
  const current = streams.get(streamId);
  const state = getTextSmoothingStates().get(streamId);
  if (!current || !state) {
    return current;
  }

  clearTextSmoothing(streamId);
  if (current.content === state.targetContent) {
    return current;
  }

  const next = {
    ...current,
    content: state.targetContent,
    agentCoreParts: upsertStreamTextPart(current, state.targetContent, streamId)
  };
  streams.set(streamId, next);
  emitChange();
  return next;
}

function nextAgentCoreSequence(current: StreamSessionState): number {
  return (current.agentCoreParts ?? []).reduce((next, part) => Math.max(next, part.sequence + 1), 0);
}

function upsertAgentCorePart(current: StreamSessionState, part: AgentCoreMessagePart): AgentCoreMessagePart[] {
  const parts = current.agentCoreParts ?? [];
  const existingIndex = parts.findIndex((item) => item.id === part.id);
  return existingIndex >= 0
    ? parts.map((item, index) => (index === existingIndex ? part : item))
    : [...parts, part];
}

function upsertStreamTextPart(current: StreamSessionState, content: string, streamId: string): AgentCoreMessagePart[] {
  const existing = current.agentCoreParts?.find((part) => part.id === `stream_text:${streamId}`);
  if (!content.trim()) {
    return current.agentCoreParts ?? [];
  }
  return upsertAgentCorePart(current, {
    id: `stream_text:${streamId}`,
    kind: 'assistant_text',
    createdAt: existing?.createdAt ?? current.startedAt,
    sequence: existing?.sequence ?? nextAgentCoreSequence(current),
    text: content
  });
}

function upsertStreamThinkingPart(current: StreamSessionState, content: string, streamId: string, createdAt: string): AgentCoreMessagePart[] {
  const existing = current.agentCoreParts?.find((part) => part.id === `stream_thinking:${streamId}`);
  if (!content.trim()) {
    return current.agentCoreParts ?? [];
  }
  return upsertAgentCorePart(current, {
    id: `stream_thinking:${streamId}`,
    kind: 'assistant_thinking',
    createdAt: existing?.createdAt ?? createdAt,
    sequence: existing?.sequence ?? nextAgentCoreSequence(current),
    thinking: content
  });
}

function upsertStreamToolUsePart(current: StreamSessionState, event: Extract<PromptStreamEvent, { type: 'tool_use' }>): AgentCoreMessagePart[] {
  const existing = current.agentCoreParts?.find((part) => part.id === `stream_tool_call:${event.toolUseId}`);
  return upsertAgentCorePart(current, {
    id: `stream_tool_call:${event.toolUseId}`,
    kind: 'tool_call',
    createdAt: existing?.createdAt ?? event.startedAt,
    sequence: existing?.sequence ?? nextAgentCoreSequence(current),
    toolUseId: event.toolUseId,
    name: event.name,
    input: event.input,
    status: event.status
  });
}

function upsertStreamToolResultPart(current: StreamSessionState, event: Extract<PromptStreamEvent, { type: 'tool_result' }>): AgentCoreMessagePart[] {
  const id = event.isError ? `stream_tool_error:${event.toolUseId}` : `stream_tool_result:${event.toolUseId}`;
  const existing = current.agentCoreParts?.find((part) => part.id === id);
  if (event.isError) {
    return upsertAgentCorePart(current, {
      id,
      kind: 'tool_error',
      createdAt: existing?.createdAt ?? event.startedAt,
      sequence: existing?.sequence ?? nextAgentCoreSequence(current),
      toolUseId: event.toolUseId,
      error: event.content,
      failureKind: event.edit?.failureKind ?? event.mcp?.failureKind,
      recoveryHint: event.edit?.recoveryHint,
      transaction: event.transaction
    });
  }
  return upsertAgentCorePart(current, {
    id,
    kind: 'tool_result',
    createdAt: existing?.createdAt ?? event.startedAt,
    sequence: existing?.sequence ?? nextAgentCoreSequence(current),
    toolUseId: event.toolUseId,
    content: event.content,
    changedFiles: event.changedFiles,
    command: event.command,
    terminal: event.terminal,
    browser: event.browser,
    edit: event.edit,
    mcp: event.mcp,
    artifacts: event.artifacts,
    transaction: event.transaction
  });
}

function getStreamTargetContentLength(streamId: string, current: StreamSessionState): number {
  return getTextSmoothingStates().get(streamId)?.targetContent.length ?? current.content.length;
}

function appendStreamActivityItem(
  streamId: string,
  current: StreamSessionState,
  item: Omit<StreamActivityItem, 'id' | 'offset' | 'createdAt'>
): StreamSessionState {
  const offset = getStreamTargetContentLength(streamId, current);
  const activityItems = current.activityItems ?? [];
  const previous = activityItems.at(-1);
  const nextItem: StreamActivityItem = {
    ...item,
    id: `${item.type}:${item.stageId ?? item.toolUseIds?.join(',') ?? activityItems.length}:${offset}`,
    offset,
    createdAt: new Date().toISOString()
  };

  const existingIndex = activityItems.findIndex((activity) => activity.id === nextItem.id);
  if (existingIndex >= 0) {
    return {
      ...current,
      activityItems: activityItems.map((activity, index) =>
        index === existingIndex
          ? {
              ...nextItem,
              createdAt: activity.createdAt
            }
          : activity
      )
    };
  }

  if (
    previous &&
    previous.type === nextItem.type &&
    previous.offset === nextItem.offset &&
    previous.stageId &&
    previous.stageId === nextItem.stageId
  ) {
    return {
      ...current,
      activityItems: [...activityItems.slice(0, -1), nextItem]
    };
  }

  return {
    ...current,
    activityItems: [...activityItems, nextItem].slice(-MAX_STREAM_ACTIVITY_ITEMS)
  };
}

function appendToolActivityItem(
  streamId: string,
  current: StreamSessionState,
  toolUseId: string,
  status: StreamActivityItem['status']
): StreamSessionState {
  if (!current.toolUses.some((tool) => tool.toolUseId === toolUseId)) {
    return current;
  }

  return appendStreamActivityItem(streamId, current, {
    type: 'tool',
    status,
    title: status === 'running' ? 'tool_running' : status === 'failed' ? 'tool_failed' : 'tool_completed',
    toolUseIds: [toolUseId]
  });
}

function isInlineLifecycleHookStage(stage: StreamStageState): boolean {
  if (!stage.stageId.includes('stage:lifecycle_hook:') && !stage.target.startsWith('hook:')) {
    return false;
  }
  const hookStatus = typeof stage.input?.status === 'string' ? stage.input.status : undefined;
  const actionType = typeof stage.input?.actionType === 'string' ? stage.input.actionType : undefined;
  return stage.status === 'failed' ||
    actionType === 'command' ||
    hookStatus === 'blocked' ||
    hookStatus === 'permission_denied' ||
    hookStatus === 'command_completed' ||
    hookStatus === 'command_failed' ||
    hookStatus === 'requires_permission';
}

function shouldRenderStageInline(stage: StreamStageState): boolean {
  return stage.status === 'failed' ||
    stage.phase === 'context_compressed' ||
    stage.phase === 'tool_timeout' ||
    isInlineLifecycleHookStage(stage);
}

function getNextSmoothedContent(displayed: string, target: string): string {
  if (!target.startsWith(displayed)) {
    return target;
  }
  const pending = target.slice(displayed.length);
  if (pending.length <= 24) {
    return target;
  }

  const chunkSize =
    pending.length > 900 ? 96
      : pending.length > 420 ? 72
        : pending.length > 180 ? 48
          : pending.length > 72 ? 28
            : 14;
  const rawChunk = pending.slice(0, chunkSize);
  const boundary = Math.max(
    rawChunk.lastIndexOf(' '),
    rawChunk.lastIndexOf('\n'),
    rawChunk.lastIndexOf('，'),
    rawChunk.lastIndexOf('。'),
    rawChunk.lastIndexOf('、'),
    rawChunk.lastIndexOf(','),
    rawChunk.lastIndexOf('.')
  );
  const nextChunk = boundary >= 8 && boundary < rawChunk.length - 1
    ? pending.slice(0, boundary + 1)
    : rawChunk;
  return displayed + nextChunk;
}

function scheduleTextSmoothing(streamId: string): void {
  const states = getTextSmoothingStates();
  const state = states.get(streamId);
  const current = getStreams().get(streamId);
  if (!state || !current) {
    clearTextSmoothing(streamId);
    return;
  }

  if (current.content === state.targetContent) {
    clearTextSmoothing(streamId);
    return;
  }

  const nextContent = getNextSmoothedContent(current.content, state.targetContent);
  const next = {
    ...current,
    content: nextContent,
    phase: 'streaming' as const
  };
  getStreams().set(streamId, next);
  emitChange();

  const remaining = state.targetContent.length - nextContent.length;
  if (remaining <= 0) {
    clearTextSmoothing(streamId);
    return;
  }

  state.timer = setTimeout(() => scheduleTextSmoothing(streamId), remaining > 500 ? 18 : 24);
}

function applySmoothedDelta(event: Extract<PromptStreamEvent, { type: 'delta' }>, labels: StreamSessionLabels): void {
  const streams = getStreams();
  const current = streams.get(event.streamId);
  if (!current) {
    return;
  }

  const targetContent = event.content;
  if (!targetContent.startsWith(current.content) || targetContent.length <= current.content.length) {
    clearTextSmoothing(event.streamId);
    streams.set(event.streamId, {
      ...current,
      content: targetContent,
      agentCoreParts: upsertStreamTextPart(current, targetContent, event.streamId),
      phase: 'streaming',
      statusMessage: labels.streaming
    });
    emitChange();
    return;
  }

  const states = getTextSmoothingStates();
  const state = states.get(event.streamId) ?? { targetContent };
  state.targetContent = targetContent;
  states.set(event.streamId, state);

  const nextContent = getNextSmoothedContent(current.content, targetContent);
  streams.set(event.streamId, {
    ...current,
    content: nextContent,
    agentCoreParts: upsertStreamTextPart(current, nextContent, event.streamId),
    phase: 'streaming',
    statusMessage: labels.streaming
  });
  emitChange();

  if (nextContent === targetContent) {
    clearTextSmoothing(event.streamId);
    return;
  }

  if (!state.timer && nextContent !== targetContent) {
    state.timer = setTimeout(() => scheduleTextSmoothing(event.streamId), 24);
  }
}

export function getPreferredStreamSession(projectId?: string, sessionId?: string): StreamSessionState | null {
  if (!projectId) {
    return null;
  }

  const streams = [...getStreams().values()].filter((stream) => {
    if (stream.projectId !== projectId) {
      return false;
    }
    if (sessionId && stream.sessionId !== sessionId) {
      return false;
    }
    return true;
  });

  if (streams.length === 0) {
    return null;
  }

  streams.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return streams[0] ?? null;
}

export function listStreamSessions(): StreamSessionState[] {
  return [...getStreams().values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function getStreamSessionForSession(projectId: string, sessionId: string): StreamSessionState | null {
  return listStreamSessions().find((stream) => stream.projectId === projectId && stream.sessionId === sessionId) ?? null;
}

export function applyPromptStreamEventToManager(event: PromptStreamEvent, labels: StreamSessionLabels): void {
  const streams = getStreams();
  const current = streams.get(event.streamId);

  if (event.type === 'status') {
    if (!current) {
      return;
    }
    streams.set(event.streamId, {
      ...current,
      phase: event.phase,
      statusMessage: event.message
    });
    emitChange();
    return;
  }

  if (event.type === 'delta') {
    applySmoothedDelta(event, labels);
    return;
  }

  if (event.type === 'thinking') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      thinkingContent: event.content,
      agentCoreParts: upsertStreamThinkingPart(flushed, event.content, event.streamId, event.startedAt),
      phase: 'thinking',
      statusMessage: labels.reasoning
    });
    emitChange();
    return;
  }

  if (event.type === 'tool_use') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const nextTool: StreamToolUseState = {
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input,
      status: event.status
    };
    const existingIndex = flushed.toolUses.findIndex((tool) => tool.toolUseId === event.toolUseId);
    const toolUses =
      existingIndex >= 0
        ? flushed.toolUses.map((tool, index) => (index === existingIndex ? nextTool : tool))
        : [...flushed.toolUses, nextTool];
    const next = appendToolActivityItem(event.streamId, {
      ...flushed,
      toolUses,
      agentCoreParts: upsertStreamToolUsePart(flushed, event),
      statusMessage: labels.toolRunning(event.name)
    }, event.toolUseId, 'running');
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'tool_result') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const nextResult: StreamToolResultState = {
      toolUseId: event.toolUseId,
      content: event.content,
      isError: event.isError,
      media: event.media,
      changedFiles: event.changedFiles,
      command: event.command,
      terminal: event.terminal,
      browser: event.browser,
      edit: event.edit,
      mcp: event.mcp,
      artifacts: event.artifacts,
      transaction: event.transaction
    };
    const existingIndex = flushed.toolResults.findIndex((result) => result.toolUseId === event.toolUseId);
    const toolResults =
      existingIndex >= 0
        ? flushed.toolResults.map((result, index) => (index === existingIndex ? nextResult : result))
        : [...flushed.toolResults, nextResult];
    const next = appendToolActivityItem(event.streamId, {
      ...flushed,
      toolResults,
      agentCoreParts: upsertStreamToolResultPart(flushed, event),
      statusMessage: event.isError ? labels.toolFailed : labels.toolCompleted
    }, event.toolUseId, event.isError ? 'failed' : 'completed');
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'stage') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const nextStage: StreamStageState = {
      stageId: event.stageId,
      phase: event.phase,
      title: event.title,
      target: event.target,
      status: event.status,
      input: event.input,
      summary: event.summary,
      errorMessage: event.errorMessage,
      runtimeId: event.runtimeId,
      providerId: event.providerId,
      model: event.model,
      errorCode: event.errorCode,
      suggestedAction: event.suggestedAction,
      recoveryActions: event.recoveryActions,
      transaction: event.transaction
    };
    const existingStages = flushed.stages ?? [];
    const existingIndex = existingStages.findIndex((stage) => stage.stageId === event.stageId);
    const stages =
      existingIndex >= 0
        ? existingStages.map((stage, index) => (index === existingIndex ? nextStage : stage))
        : [...existingStages, nextStage];
    const nextBase = {
      ...flushed,
      stages,
      statusMessage: event.summary || event.title
    };
    const next = shouldRenderStageInline(nextStage)
      ? appendStreamActivityItem(event.streamId, nextBase, {
          type: nextStage.phase === 'tool_timeout' ? 'timeout' : nextStage.phase === 'context_compressed' ? 'context' : 'stage',
          status: nextStage.status === 'failed' ? 'failed' : nextStage.status === 'completed' ? 'completed' : 'running',
          title: nextStage.title,
          summary: nextStage.summary,
          stageId: nextStage.stageId,
          transaction: nextStage.transaction
        })
      : nextBase;
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'context_compressed') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const next = appendStreamActivityItem(event.streamId, {
      ...flushed,
      statusMessage: event.message
    }, {
      type: 'context',
      status: 'completed',
      title: 'context_compressed',
      summary: event.message
    });
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'tool_timeout') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const next = appendStreamActivityItem(event.streamId, {
      ...flushed,
      statusMessage: event.message
    }, {
      type: 'timeout',
      status: 'failed',
      title: event.toolName || 'tool_timeout',
      summary: event.message
    });
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'usage') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      lastUsage: event.usage,
      usageTotals: event.totals
    });
    emitChange();
    return;
  }

  if (event.type === 'session_busy') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      statusMessage: event.message
    });
    emitChange();
    return;
  }

  if (event.type === 'permission_request') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      pendingPermission: {
        requestId: event.requestId,
        title: event.title,
        detail: event.detail,
        risk: event.risk,
        toolName: event.toolName,
        impact: event.impact
      },
      statusMessage: labels.waitingPermission
    });
    emitChange();
    return;
  }

  if (event.type === 'permission_resolved') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      pendingPermission: undefined,
      statusMessage:
        event.decision === 'allow'
          ? labels.permissionAllowed
          : event.decision === 'allow_session'
            ? labels.permissionAllowedSession
            : labels.permissionDenied
    });
    emitChange();
    return;
  }

  if (event.type === 'user_input_request') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      pendingUserInput: {
        requestId: event.requestId,
        title: event.title,
        question: event.question,
        detail: event.detail,
        options: event.options,
        multiSelect: event.multiSelect,
        allowFreeText: event.allowFreeText,
        placeholder: event.placeholder,
        toolName: event.toolName
      },
      statusMessage: labels.waitingUserInput
    });
    emitChange();
    return;
  }

  if (event.type === 'user_input_resolved') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      pendingUserInput: undefined,
      statusMessage: labels.userInputSubmitted
    });
    emitChange();
    return;
  }

  if (event.type === 'completed') {
    clearTextSmoothing(event.streamId);
    if (streams.delete(event.streamId)) {
      emitChange();
    }
    return;
  }

  if (event.type === 'cancelled' || event.type === 'error') {
    clearTextSmoothing(event.streamId);
    streams.delete(event.streamId);
    emitChange();
  }
}
