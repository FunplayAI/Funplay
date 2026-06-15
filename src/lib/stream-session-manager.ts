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
  PromptAttachment,
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
  title?: string;
  summary?: string;
  activity?: string;
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
  attachments?: PromptAttachment[];
  content: string;
  thinkingContent: string;
  toolUses: StreamToolUseState[];
  toolResults: StreamToolResultState[];
  stages: StreamStageState[];
  activityItems: StreamActivityItem[];
  agentCoreParts?: AgentCoreMessagePart[];
  agentCorePartsAuthoritative?: boolean;
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
  timer?: StreamTextSmoothingHandle;
}

const STREAM_TEXT_SMOOTHING_FRAME_MS = 16;

type StreamTextSmoothingHandle =
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
  | { kind: 'animationFrame'; id: number };

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

let cachedGraphemeSegmenter: GraphemeSegmenter | null | undefined;

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
    if (state.timer.kind === 'animationFrame' && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(state.timer.id);
    } else if (state.timer.kind === 'timeout') {
      clearTimeout(state.timer.id);
    }
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
    content: state.targetContent
  };
  streams.set(streamId, next);
  emitChange();
  return next;
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
  status: StreamActivityItem['status'],
  summary?: string
): StreamSessionState {
  if (!current.toolUses.some((tool) => tool.toolUseId === toolUseId)) {
    return current;
  }

  return appendStreamActivityItem(streamId, current, {
    type: 'tool',
    status,
    title: status === 'running' ? 'tool_running' : status === 'failed' ? 'tool_failed' : 'tool_completed',
    summary,
    toolUseIds: [toolUseId]
  });
}

function withLiveAgentCoreParts(current: StreamSessionState): StreamSessionState {
  if (current.agentCorePartsAuthoritative) {
    return current;
  }
  const parts: AgentCoreMessagePart[] = [];
  let sequence = 0;
  const createdAt = current.startedAt;
  const content = current.content ?? '';
  if (current.thinkingContent.trim()) {
    parts.push({
      id: `live:${current.streamId}:thinking`,
      kind: 'assistant_thinking',
      createdAt,
      sequence,
      thinking: current.thinkingContent
    });
    sequence += 1;
  }

  const toolUsesById = new Map(current.toolUses.map((tool) => [tool.toolUseId, tool]));
  const toolResultsById = new Map(current.toolResults.map((result) => [result.toolUseId, result]));
  const placedToolUseIds = new Set<string>();
  const toolGroups = buildLiveToolActivityGroups(current);
  let textCursor = 0;

  for (const group of toolGroups) {
    const offset = clampLiveTextOffset(group.offset, content.length);
    sequence = pushLiveAssistantTextPart(parts, current, sequence, textCursor, offset);
    textCursor = offset;
    for (const toolUseId of group.toolUseIds) {
      const tool = toolUsesById.get(toolUseId);
      if (!tool || placedToolUseIds.has(toolUseId)) {
        continue;
      }
      sequence = pushLiveToolParts(parts, current, sequence, tool, toolResultsById.get(toolUseId));
      placedToolUseIds.add(toolUseId);
    }
  }

  const unplacedTools = current.toolUses.filter((tool) => !placedToolUseIds.has(tool.toolUseId));
  if (unplacedTools.length > 0 && textCursor === 0) {
    for (const tool of unplacedTools) {
      sequence = pushLiveToolParts(parts, current, sequence, tool, toolResultsById.get(tool.toolUseId));
      placedToolUseIds.add(tool.toolUseId);
    }
  }

  sequence = pushLiveAssistantTextPart(parts, current, sequence, textCursor, content.length);

  if (unplacedTools.length > 0 && textCursor > 0) {
    for (const tool of unplacedTools) {
      if (placedToolUseIds.has(tool.toolUseId)) {
        continue;
      }
      sequence = pushLiveToolParts(parts, current, sequence, tool, toolResultsById.get(tool.toolUseId));
      placedToolUseIds.add(tool.toolUseId);
    }
  }
  return {
    ...current,
    agentCoreParts: parts.length > 0 ? parts : current.agentCoreParts
  };
}

function buildLiveToolActivityGroups(
  current: StreamSessionState
): Array<{ offset: number; createdAt: string; toolUseIds: string[] }> {
  const groups = current.activityItems
    .filter((activity) => activity.type === 'tool' && activity.toolUseIds?.length)
    .map((activity) => ({
      offset: activity.offset,
      createdAt: activity.createdAt,
      toolUseIds: activity.toolUseIds ?? []
    }))
    .sort((left, right) => {
      const offsetOrder = left.offset - right.offset;
      if (offsetOrder !== 0) {
        return offsetOrder;
      }
      return left.createdAt.localeCompare(right.createdAt);
    });

  const grouped: Array<{ offset: number; createdAt: string; toolUseIds: string[] }> = [];
  for (const group of groups) {
    const previous = grouped.at(-1);
    if (previous && previous.offset === group.offset) {
      previous.toolUseIds.push(...group.toolUseIds);
      continue;
    }
    grouped.push({ ...group, toolUseIds: [...group.toolUseIds] });
  }
  return grouped;
}

function pushLiveAssistantTextPart(
  parts: AgentCoreMessagePart[],
  current: StreamSessionState,
  sequence: number,
  start: number,
  end: number
): number {
  if (end <= start) {
    return sequence;
  }
  const text = current.content.slice(start, end);
  if (!text.trim()) {
    return sequence;
  }
  parts.push({
    id: `live:${current.streamId}:text:${start}:${end}`,
    kind: 'assistant_text',
    createdAt: current.startedAt,
    sequence,
    text,
    final: false
  });
  return sequence + 1;
}

function pushLiveToolParts(
  parts: AgentCoreMessagePart[],
  current: StreamSessionState,
  sequence: number,
  tool: StreamToolUseState,
  result: StreamToolResultState | undefined
): number {
  parts.push({
    id: `live:${current.streamId}:tool_call:${tool.toolUseId}`,
    kind: 'tool_call',
    createdAt: current.startedAt,
    sequence,
    toolUseId: tool.toolUseId,
    name: tool.name,
    title: tool.title,
    summary: tool.summary,
    activity: tool.activity,
    input: tool.input,
    status: result?.isError ? 'failed' : result ? 'completed' : tool.status
  });
  sequence += 1;

  if (!result) {
    return sequence;
  }

  if (result.isError) {
    parts.push({
      id: `live:${current.streamId}:tool_error:${result.toolUseId}`,
      kind: 'tool_error',
      createdAt: current.startedAt,
      sequence,
      toolUseId: result.toolUseId,
      toolName: tool.name,
      error: result.content,
      changedFiles: result.changedFiles,
      command: result.command,
      terminal: result.terminal,
      browser: result.browser,
      edit: result.edit,
      mcp: result.mcp,
      artifacts: result.artifacts,
      transaction: result.transaction
    });
    return sequence + 1;
  }

  parts.push({
    id: `live:${current.streamId}:tool_result:${result.toolUseId}`,
    kind: 'tool_result',
    createdAt: current.startedAt,
    sequence,
    toolUseId: result.toolUseId,
    toolName: tool.name,
    content: result.content,
    changedFiles: result.changedFiles,
    command: result.command,
    terminal: result.terminal,
    browser: result.browser,
    edit: result.edit,
    mcp: result.mcp,
    artifacts: result.artifacts,
    transaction: result.transaction
  });
  return sequence + 1;
}

function clampLiveTextOffset(offset: number, contentLength: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.min(contentLength, Math.floor(offset)));
}

function isInlineLifecycleHookStage(stage: StreamStageState): boolean {
  if (!stage.stageId.includes('stage:lifecycle_hook:') && !stage.target.startsWith('hook:')) {
    return false;
  }
  const hookStatus = typeof stage.input?.status === 'string' ? stage.input.status : undefined;
  const actionType = typeof stage.input?.actionType === 'string' ? stage.input.actionType : undefined;
  return (
    stage.status === 'failed' ||
    actionType === 'command' ||
    hookStatus === 'blocked' ||
    hookStatus === 'permission_denied' ||
    hookStatus === 'command_completed' ||
    hookStatus === 'command_failed' ||
    hookStatus === 'requires_permission'
  );
}

function shouldRenderStageInline(stage: StreamStageState): boolean {
  return (
    stage.status === 'failed' ||
    stage.phase === 'context_compressed' ||
    stage.phase === 'tool_timeout' ||
    isInlineLifecycleHookStage(stage)
  );
}

function getGraphemeSegmenter(): GraphemeSegmenter | undefined {
  if (cachedGraphemeSegmenter !== undefined) {
    return cachedGraphemeSegmenter ?? undefined;
  }
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter;
    }
  ).Segmenter;
  cachedGraphemeSegmenter =
    typeof Segmenter === 'function' ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return cachedGraphemeSegmenter ?? undefined;
}

function* iterateGraphemes(input: string): Iterable<string> {
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) {
    yield* Array.from(input);
    return;
  }
  for (const segment of segmenter.segment(input)) {
    yield segment.segment;
  }
}

function getSmoothedTextVisibleBudget(pendingLength: number): number {
  if (pendingLength > 4000) return 3;
  if (pendingLength > 1600) return 2;
  return 1;
}

function isWhitespaceGrapheme(segment: string): boolean {
  return /^\s+$/.test(segment);
}

function takeSmoothedTextSlice(pending: string): string {
  const visibleBudget = getSmoothedTextVisibleBudget(pending.length);
  let visibleCount = 0;
  let slice = '';
  for (const segment of iterateGraphemes(pending)) {
    slice += segment;
    if (!isWhitespaceGrapheme(segment)) {
      visibleCount += 1;
    }
    if (visibleCount >= visibleBudget) {
      break;
    }
  }
  return slice || pending.slice(0, 1);
}

function getNextSmoothedContent(displayed: string, target: string): string {
  if (!target.startsWith(displayed)) {
    return target;
  }
  const pending = target.slice(displayed.length);
  if (!pending) {
    return target;
  }

  return displayed + takeSmoothedTextSlice(pending);
}

function scheduleNextTextSmoothingTick(streamId: string, state: StreamTextSmoothingState): void {
  if (state.timer) {
    return;
  }
  if (typeof globalThis.requestAnimationFrame === 'function') {
    state.timer = {
      kind: 'animationFrame',
      id: globalThis.requestAnimationFrame(() => scheduleTextSmoothing(streamId))
    };
    return;
  }
  state.timer = {
    kind: 'timeout',
    id: setTimeout(() => scheduleTextSmoothing(streamId), STREAM_TEXT_SMOOTHING_FRAME_MS)
  };
}

function scheduleTextSmoothing(streamId: string): void {
  const states = getTextSmoothingStates();
  const state = states.get(streamId);
  const current = getStreams().get(streamId);
  if (!state || !current) {
    clearTextSmoothing(streamId);
    return;
  }
  state.timer = undefined;

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
  getStreams().set(streamId, withLiveAgentCoreParts(next));
  emitChange();

  // Stop on direct content equality rather than a UTF-16 length delta. Today
  // these coincide (each tick reveals a strictly-longer PREFIX of the target, so
  // length only reaches target.length when the whole string is present), but the
  // equality check doesn't rely on that implicit prefix invariant: if a future
  // change to getNextSmoothedContent ever broke monotone-prefix reveal, the
  // length check could stop early (drop the tail) whereas equality keeps
  // rescheduling and self-heals via the snap path on the next tick.
  if (nextContent === state.targetContent) {
    clearTextSmoothing(streamId);
    return;
  }

  scheduleNextTextSmoothingTick(streamId, state);
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
    streams.set(
      event.streamId,
      withLiveAgentCoreParts({
        ...current,
        content: targetContent,
        phase: 'streaming',
        statusMessage: labels.streaming
      })
    );
    emitChange();
    return;
  }

  const states = getTextSmoothingStates();
  const state = states.get(event.streamId) ?? { targetContent };
  state.targetContent = targetContent;
  states.set(event.streamId, state);

  if (state.timer) {
    return;
  }

  const nextContent = getNextSmoothedContent(current.content, targetContent);
  streams.set(
    event.streamId,
    withLiveAgentCoreParts({
      ...current,
      content: nextContent,
      phase: 'streaming',
      statusMessage: labels.streaming
    })
  );
  emitChange();

  if (nextContent === targetContent) {
    clearTextSmoothing(event.streamId);
    return;
  }

  if (!state.timer && nextContent !== targetContent) {
    scheduleNextTextSmoothingTick(event.streamId, state);
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
  return (
    listStreamSessions().find((stream) => stream.projectId === projectId && stream.sessionId === sessionId) ?? null
  );
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
    streams.set(
      event.streamId,
      withLiveAgentCoreParts({
        ...flushed,
        thinkingContent: event.content,
        phase: 'thinking',
        statusMessage: labels.reasoning
      })
    );
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
      title: event.title,
      summary: event.summary,
      activity: event.activity,
      input: event.input,
      status: event.status
    };
    const existingIndex = flushed.toolUses.findIndex((tool) => tool.toolUseId === event.toolUseId);
    const existingTool = existingIndex >= 0 ? flushed.toolUses[existingIndex] : undefined;
    const mergedTool: StreamToolUseState = {
      ...nextTool,
      title: nextTool.title ?? existingTool?.title,
      summary: nextTool.summary ?? existingTool?.summary,
      activity: nextTool.activity ?? existingTool?.activity,
      input: nextTool.input ?? existingTool?.input
    };
    const toolUses =
      existingIndex >= 0
        ? flushed.toolUses.map((tool, index) => (index === existingIndex ? mergedTool : tool))
        : [...flushed.toolUses, mergedTool];
    const next = appendToolActivityItem(
      event.streamId,
      {
        ...flushed,
        toolUses,
        statusMessage: mergedTool.activity ?? labels.toolRunning(event.name)
      },
      event.toolUseId,
      'running',
      mergedTool.summary ?? mergedTool.activity
    );
    streams.set(event.streamId, withLiveAgentCoreParts(next));
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
    const next = appendToolActivityItem(
      event.streamId,
      {
        ...flushed,
        toolResults,
        statusMessage: event.isError ? labels.toolFailed : labels.toolCompleted
      },
      event.toolUseId,
      event.isError ? 'failed' : 'completed'
    );
    streams.set(event.streamId, withLiveAgentCoreParts(next));
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
          type:
            nextStage.phase === 'tool_timeout'
              ? 'timeout'
              : nextStage.phase === 'context_compressed'
                ? 'context'
                : 'stage',
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
    const next = appendStreamActivityItem(
      event.streamId,
      {
        ...flushed,
        statusMessage: event.message
      },
      {
        type: 'context',
        status: 'completed',
        title: 'context_compressed',
        summary: event.message
      }
    );
    streams.set(event.streamId, next);
    emitChange();
    return;
  }

  if (event.type === 'tool_timeout') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    const next = appendStreamActivityItem(
      event.streamId,
      {
        ...flushed,
        statusMessage: event.message
      },
      {
        type: 'timeout',
        status: 'failed',
        title: event.toolName || 'tool_timeout',
        summary: event.message
      }
    );
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

  if (event.type === 'agent_core_parts') {
    const flushed = flushTextSmoothing(event.streamId);
    if (!flushed) {
      return;
    }
    streams.set(event.streamId, {
      ...flushed,
      agentCoreParts: event.parts,
      agentCorePartsAuthoritative: true
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
