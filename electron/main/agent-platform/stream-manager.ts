import {
  ensureProjectSessions,
  getActiveProjectSession,
  replaceProjectSession
} from '../../../shared/project-sessions';
import type {
  AgentPermissionImpact,
  AgentRuntimeResumeContext,
  AgentUserInputResponse,
  AppState,
  ProjectSessionRuntimeId,
  PromptAttachment,
  PromptStreamEvent,
  PromptStreamHandle,
  Project
} from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import {
  DEFAULT_SESSION_WRITE_PERMISSION_TOOLS,
  deriveScopedSessionPermissionRules,
  grantSessionWritePermission,
  hasSessionWritePermission
} from './permission-session-store';
import { addSessionCheckpointSnapshot } from '../project-service';
import { executeGenericAgentTask as executeAgentTask, AgentRunInterruptedError } from './task-executor';
import {
  findActiveRunByStream,
  getActiveOrPersistedRun,
  recordActiveRunPermissionResolved,
  registerActiveRun,
  removePersistedRun,
  unregisterActiveRun
} from './run-registry';
import { cancelPendingPermissionsForStream, resolvePendingPermission } from './permission-registry';
import { cancelPendingUserInputsForStream, resolvePendingUserInput } from './user-input-registry';
import { createStateAdapter } from './state-adapter';
import { getState, setState } from '../store';
import type { StreamContext } from './stream-types';
import { createRuntimeEventSink } from './runtime-event-sink';
import { makePermissionHandlers, makeUserInputHandlers } from './stream-interactions';
import {
  deleteActiveStream,
  finalizeStream,
  getActiveStream,
  hasActiveStreamForSession,
  processStreamError,
  registerActiveStream
} from './stream-lifecycle';
import { buildResumeContextForRun, restoreFilesForResume } from './stream-resume';

function formatPromptWithAttachments(message: string, attachments?: PromptAttachment[]): string {
  const prompt = message.trim();
  if (!attachments?.length) {
    return prompt;
  }

  const attachmentLines = attachments.map((attachment, index) => {
    const targetPath = attachment.relativePath || attachment.path;
    const meta = [attachment.kind, attachment.mimeType, `${attachment.size} bytes`].filter(Boolean).join(', ');
    return `${index + 1}. ${attachment.name} -> ${targetPath}${meta ? ` (${meta})` : ''}`;
  });

  return [
    prompt || '请查看附件并根据其中内容继续处理。',
    '',
    'Attached files staged for this message:',
    ...attachmentLines,
    '',
    'Use the listed paths when reading or referencing these attachments. Only import them into the project when the user asks to save or add them as project assets.'
  ].join('\n');
}

function getDisplayPrompt(message: string, attachments?: PromptAttachment[], uiLanguage?: 'zh-CN' | 'en-US'): string {
  const prompt = message.trim();
  if (prompt) {
    return prompt;
  }
  return attachments?.length
    ? uiLanguage === 'en-US'
      ? 'Please review the attachments and continue.'
      : '请查看附件并继续处理。'
    : '';
}

async function persistSessionWritePermissionGrant(params: {
  projectId: string;
  sessionId: string;
  toolName?: string;
  mcpToolKey?: string;
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
  impact?: AgentPermissionImpact;
}): Promise<void> {
  const state = getState();
  const project = state.projects.find((item) => item.id === params.projectId);
  if (!project) {
    return;
  }

  const ensured = ensureProjectSessions(project);
  const session = ensured.sessions.find((item) => item.id === params.sessionId);
  if (!session) {
    return;
  }

  const cwd = params.cwd ?? ensured.engine?.projectPath;
  const runtimeId = params.runtimeId ?? session.runtimeOverrides?.runtimeId;
  // Prefer an argument-scoped rule (command prefix / path glob) over blanket
  // tool grants; fall back to the legacy blanket grant when none is derivable.
  const scopedRules = params.mcpToolKey
    ? undefined
    : deriveScopedSessionPermissionRules({
        toolName: params.toolName,
        impact: params.impact,
        projectPath: cwd
      });
  const tools = scopedRules?.length
    ? []
    : params.mcpToolKey && params.toolName === 'call_mcp_tool'
      ? []
      : params.toolName
        ? [params.toolName]
        : [...DEFAULT_SESSION_WRITE_PERMISSION_TOOLS];
  const grant = grantSessionWritePermission(params.sessionId, {
    tools,
    rules: scopedRules,
    mcpTools: params.mcpToolKey ? [params.mcpToolKey] : undefined,
    runtimeId,
    cwd
  });
  const updatedProject = replaceProjectSession(
    ensured,
    {
      ...session,
      runtimeOverrides: {
        ...session.runtimeOverrides,
        sessionWritePermissionGrant: grant
      }
    },
    params.sessionId
  );
  await setState({
    ...state,
    projects: state.projects.map((item) => (item.id === params.projectId ? updatedProject : item))
  });
}

export function startAgentPromptStream(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  projectId: string;
  sessionId?: string;
  message: string;
  attachments?: PromptAttachment[];
  uiLanguage?: 'zh-CN' | 'en-US';
  resumedFromRunId?: string;
  resumeContext?: AgentRuntimeResumeContext;
  dispatchEvent: (event: PromptStreamEvent) => void;
}): PromptStreamHandle {
  const stateAdapter = createStateAdapter({
    getState: params.getState,
    persistState: params.persistState
  });
  let resolved = stateAdapter.resolveProjectContext(params.projectId, params.sessionId);
  const activeSession = getActiveProjectSession(resolved.current);
  const sessionId = activeSession.id;
  const startedAt = nowIso();

  if (hasActiveStreamForSession(sessionId)) {
    params.dispatchEvent({
      type: 'session_busy',
      streamId: makeId('busy'),
      projectId: params.projectId,
      sessionId,
      message: '当前会话已有一个 Agent 请求在运行。',
      startedAt
    });
    throw new Error('This session already has an active AI response.');
  }

  const streamId = makeId('stream');
  const userMessageId = makeId('msg');
  const controller = new AbortController();
  const displayMessage = getDisplayPrompt(params.message, params.attachments, params.uiLanguage);
  const message = formatPromptWithAttachments(displayMessage, params.attachments);
  const checkpointProject = addSessionCheckpointSnapshot(
    stateAdapter.getState(),
    params.projectId,
    sessionId,
    `Before prompt: ${message.slice(0, 80)}`,
    {
      triggerUserMessageId: userMessageId
    }
  );
  const checkpointSnapshotId = checkpointProject.snapshots[0]?.id;
  resolved = {
    ...resolved,
    current: checkpointProject
  };
  const activeRun = registerActiveRun({
    kind: 'conversation',
    projectId: params.projectId,
    sessionId,
    streamId,
    checkpointSnapshotId,
    inputPreview: message,
    request: {
      kind: 'conversation',
      projectId: params.projectId,
      sessionId,
      runtimeId: activeSession.runtimeOverrides?.runtimeId ?? 'native',
      providerId: resolved.provider?.id,
      model: activeSession.runtimeOverrides?.model ?? resolved.provider?.model,
      permissionMode:
        activeSession.runtimeOverrides?.permissionMode ??
        resolved.current.agentPolicy?.permissionMode ??
        stateAdapter.getState().agentSettings.permissionMode,
      message,
      checkpointSnapshotId,
      inputPreview: message,
      resumeContext: params.resumeContext
    },
    controller,
    resumedFromRunId: params.resumedFromRunId
  });
  const toolNamesByUseId = new Map<string, string>();
  registerActiveStream({
    kind: 'conversation',
    streamId,
    projectId: params.projectId,
    sessionId,
    startedAt,
    controller
  });
  const ctx: StreamContext = {
    streamId,
    projectId: params.projectId,
    sessionId,
    startedAt,
    controller,
    activeRunId: activeRun.id,
    toolNamesByUseId,
    checkpointSnapshotId,
    dispatchEvent: params.dispatchEvent
  };
  const eventSink = createRuntimeEventSink(ctx, {
    initialMetadata: {
      runtimeId: activeSession.runtimeOverrides?.runtimeId,
      providerId: resolved.provider?.id,
      model: activeSession.runtimeOverrides?.model ?? resolved.provider?.model,
      upstreamModel: activeSession.runtimeOverrides?.upstreamModel ?? resolved.provider?.upstreamModel
    },
    emitStageSideEvents: true
  });
  const { onPermissionRequest, requestPermission } = makePermissionHandlers(ctx, {
    getRuntimeId: () => eventSink.getMetadata().runtimeId,
    getCwd: () => resolved.current.engine?.projectPath
  });
  const { onUserInputRequest, requestUserInput } = makeUserInputHandlers(ctx);

  void (async () => {
    let finalOutcome: 'completed' | 'interrupted' | 'failed' = 'completed';
    try {
      await stateAdapter.persistState({ ...stateAdapter.getState() });

      const { project: updated } = await executeAgentTask({
        kind: 'conversation',
        activeRunId: activeRun.id,
        project: resolved.current,
        sessionId,
        userMessageId,
        checkpointSnapshotId,
        message,
        displayMessage,
        attachments: params.attachments,
        uiLanguage: params.uiLanguage,
        appState: stateAdapter.getState(),
        persistAppState: stateAdapter.persistState,
        resumeContext: params.resumeContext,
        provider: resolved.provider,
        mcpPlugins: resolved.mcpPlugins,
        enginePlugin: resolved.enginePlugin,
        assetPlugin: resolved.assetPlugin,
        qaPlugin: resolved.qaPlugin,
        customPlugin: resolved.customPlugin,
        abortSignal: controller.signal,
        onStatus: eventSink.onStatus,
        onTextDelta: eventSink.onTextDelta,
        onThinkingDelta: eventSink.onThinkingDelta,
        onToolUse: eventSink.onToolUse,
        onToolResult: eventSink.onToolResult,
        onStage: eventSink.onStage,
        onPermissionRequest,
        requestPermission,
        onUserInputRequest,
        requestUserInput,
        onUsage: eventSink.onUsage,
        onAgentCoreParts: eventSink.onAgentCoreParts
      });

      const latestState = stateAdapter.getState();
      const latestResolved = stateAdapter.resolveProjectContext(params.projectId);
      const committed = stateAdapter.mergeUpdatedProject(latestResolved, updated, sessionId);
      await stateAdapter.persistState({ ...latestState });

      params.dispatchEvent({
        type: 'completed',
        streamId,
        projectId: params.projectId,
        sessionId,
        project: committed,
        startedAt,
        finishedAt: nowIso()
      });
    } catch (error) {
      if (error instanceof AgentRunInterruptedError) {
        // Interrupted mid-turn: persist the partial turn (user message + the
        // text streamed so far) and hand it to the renderer via cancelled.project,
        // so the whole session row isn't lost. Mirrors the completed merge+persist.
        const latestState = stateAdapter.getState();
        const latestResolved = stateAdapter.resolveProjectContext(params.projectId);
        const committed = stateAdapter.mergeUpdatedProject(latestResolved, error.partialProject, sessionId);
        await stateAdapter.persistState({ ...latestState });
        params.dispatchEvent({
          type: 'cancelled',
          streamId,
          projectId: params.projectId,
          sessionId,
          project: committed,
          startedAt,
          finishedAt: nowIso()
        });
        unregisterActiveRun(activeRun.id, {
          finalStatus: 'interrupted',
          error: 'Agent run was interrupted before completion.'
        });
        finalOutcome = 'interrupted';
      } else {
        finalOutcome = processStreamError(ctx, error, {
          interruptMessage: 'Agent run was interrupted before completion.',
          failMessage: 'AI stream failed.',
          errorMetadata: { ...eventSink.getMetadata() }
        }).finalOutcome;
      }
    } finally {
      finalizeStream(ctx, finalOutcome);
    }
  })();

  return {
    streamId,
    projectId: params.projectId,
    sessionId,
    startedAt,
    kind: 'conversation',
    prompt: displayMessage || message,
    attachments: params.attachments,
    resumedFromRunId: params.resumedFromRunId
  };
}

export function cancelAgentPromptStream(streamId: string): { success: true } {
  const active = getActiveStream(streamId);
  if (!active || active.kind !== 'conversation') {
    return { success: true };
  }

  active.controller.abort();
  cancelPendingPermissionsForStream(streamId);
  cancelPendingUserInputsForStream(streamId);
  deleteActiveStream(streamId);
  return { success: true };
}

export async function resumeAgentRun(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  runId: string;
  dispatchEvent: (event: PromptStreamEvent) => void;
}): Promise<PromptStreamHandle> {
  const persisted = getActiveOrPersistedRun(params.runId);
  if (!persisted) {
    throw new Error('Resumable agent run not found.');
  }
  if (!persisted.canResume) {
    throw new Error('This agent run is still active and cannot be resumed.');
  }

  const stateAdapter = createStateAdapter({
    getState: params.getState,
    persistState: params.persistState
  });
  await restoreFilesForResume(stateAdapter, persisted.projectId, persisted.checkpointSnapshotId);
  const resumeContext = buildResumeContextForRun(persisted);

  if (persisted.request.kind === 'conversation') {
    if (!persisted.request.message?.trim()) {
      throw new Error('The saved conversation run does not contain a resumable prompt.');
    }

    const handle = startAgentPromptStream({
      getState: params.getState,
      persistState: params.persistState,
      projectId: persisted.projectId,
      sessionId: persisted.sessionId,
      message: persisted.request.message,
      resumeContext,
      resumedFromRunId: persisted.id,
      dispatchEvent: params.dispatchEvent
    });
    removePersistedRun(persisted.id);
    return handle;
  }

  throw new Error('Unsupported resumable agent run kind.');
}

export async function respondToAgentPermissionRequest(
  requestId: string,
  decision: 'allow' | 'allow_session' | 'deny',
  dispatchEvent?: (event: PromptStreamEvent) => void
): Promise<{ success: true }> {
  const pending = resolvePendingPermission(requestId, decision);
  if (!pending) {
    return { success: true };
  }

  if (decision === 'allow_session') {
    await persistSessionWritePermissionGrant({
      projectId: pending.projectId,
      sessionId: pending.sessionId,
      toolName: pending.toolName,
      mcpToolKey: pending.impact?.mcp?.permissionKey,
      runtimeId: pending.runtimeId,
      cwd: pending.cwd,
      impact: pending.impact
    });
  }
  pending.resolve(decision);
  if (pending.onResolve) {
    pending.onResolve(pending, decision);
    return { success: true };
  }
  const activeRun = findActiveRunByStream(pending.streamId);
  if (activeRun) {
    recordActiveRunPermissionResolved(activeRun.id, {
      requestId,
      decision
    });
  }
  dispatchEvent?.({
    type: 'permission_resolved',
    streamId: pending.streamId,
    projectId: pending.projectId,
    sessionId: pending.sessionId,
    requestId,
    decision,
    startedAt: pending.createdAt
  });
  return { success: true };
}

export function respondToAgentUserInputRequest(requestId: string, response: AgentUserInputResponse): { success: true } {
  resolvePendingUserInput(requestId, response);
  return { success: true };
}

export function hasSessionWritePermissionOverride(sessionId: string): boolean {
  return hasSessionWritePermission(sessionId);
}
