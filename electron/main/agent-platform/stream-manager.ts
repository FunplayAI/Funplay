import { ensureProjectSessions, getActiveProjectSession, getChatMessageVisibleAssistantText, replaceProjectSession } from '../../../shared/project-sessions';
import type { AgentRuntimeResumeContext, AgentUserInputResponse, AppState, ProjectSessionRuntimeId, PromptAttachment, PromptStreamEvent, PromptStreamHandle, Project, RuntimeDiagnosticSeverity, RuntimeRecoveryAction } from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import {
  DEFAULT_SESSION_WRITE_PERMISSION_TOOLS,
  grantSessionWritePermission,
  hasSessionWritePermission
} from './permission-session-store';
import { addSessionCheckpointSnapshot } from '../project-service';
import { executeGenericAgentTask as executeAgentTask } from './task-executor';
import {
  findActiveRunByStream,
  getActiveOrPersistedRun,
  recordActiveRunPermissionResolved,
  recordActiveRunStreamDelta,
  registerActiveRun,
  removePersistedRun,
  updateActiveRunStatus
} from './run-registry';
import {
  cancelPendingPermissionsForStream,
  resolvePendingPermission
} from './permission-registry';
import {
  cancelPendingUserInputsForStream,
  resolvePendingUserInput
} from './user-input-registry';
import { createStateAdapter } from './state-adapter';
import { getState, setState } from '../store';
import type { StreamContext } from './stream-types';
import {
  makeStageHandler,
  makeToolResultHandler,
  makeToolUseHandler,
  makeUsageHandler
} from './stream-event-dispatcher';
import {
  makePermissionHandlers,
  makeUserInputHandlers
} from './stream-interactions';
import {
  deleteActiveStream,
  finalizeStream,
  getActiveStream,
  hasActiveExecutionPlanStream,
  hasActiveStreamForSession,
  processStreamError,
  registerActiveStream
} from './stream-lifecycle';
import {
  buildResumeContextForRun,
  restoreFilesForResume
} from './stream-resume';

interface StreamMetadata {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
}

function formatPromptWithAttachments(message: string, attachments?: PromptAttachment[]): string {
  const prompt = message.trim();
  if (!attachments?.length) {
    return prompt;
  }

  const attachmentLines = attachments.map((attachment, index) => {
    const targetPath = attachment.relativePath || attachment.path;
    const meta = [
      attachment.kind,
      attachment.mimeType,
      `${attachment.size} bytes`
    ].filter(Boolean).join(', ');
    return `${index + 1}. ${attachment.name} -> ${targetPath}${meta ? ` (${meta})` : ''}`;
  });

  return [
    prompt || '请查看附件并根据其中内容继续处理。',
    '',
    'Attached files copied into the current project workspace:',
    ...attachmentLines,
    '',
    'Use the listed paths when reading or referencing these attachments.'
  ].join('\n');
}

async function persistSessionWritePermissionGrant(params: {
  projectId: string;
  sessionId: string;
  toolName?: string;
  mcpToolKey?: string;
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
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
  const tools = params.mcpToolKey && params.toolName === 'call_mcp_tool'
    ? []
    : params.toolName
      ? [params.toolName]
      : [...DEFAULT_SESSION_WRITE_PERMISSION_TOOLS];
  const grant = grantSessionWritePermission(params.sessionId, {
    tools,
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

export async function executeAgentExecutionPlan(state: AppState, projectId: string): Promise<Project> {
  const { project } = await executeAgentTask({
    kind: 'execute-plan',
    state,
    projectId
  });
  return project;
}

export function startAgentPromptStream(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  projectId: string;
  sessionId?: string;
  message: string;
  attachments?: PromptAttachment[];
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
  const message = formatPromptWithAttachments(params.message, params.attachments);
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
  let latestStreamMetadata: StreamMetadata = {
    runtimeId: activeSession.runtimeOverrides?.runtimeId,
    providerId: resolved.provider?.id,
    model: activeSession.runtimeOverrides?.model ?? resolved.provider?.model,
    upstreamModel: activeSession.runtimeOverrides?.upstreamModel ?? resolved.provider?.upstreamModel
  };
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
  const { onPermissionRequest, requestPermission } = makePermissionHandlers(ctx, {
    getRuntimeId: () => latestStreamMetadata.runtimeId,
    getCwd: () => resolved.current.engine?.projectPath
  });
  const { onUserInputRequest, requestUserInput } = makeUserInputHandlers(ctx);
  const onStage = makeStageHandler(ctx, {
    updateMetadata: (stage) => {
      latestStreamMetadata = {
        ...latestStreamMetadata,
        runtimeId: stage.runtimeId ?? latestStreamMetadata.runtimeId,
        providerId: stage.providerId ?? latestStreamMetadata.providerId,
        model: stage.model ?? latestStreamMetadata.model,
        upstreamModel: stage.upstreamModel ?? latestStreamMetadata.upstreamModel,
        diagnosticCode: stage.diagnosticCode ?? latestStreamMetadata.diagnosticCode,
        severity: stage.severity ?? latestStreamMetadata.severity,
        errorCode: stage.errorCode ?? latestStreamMetadata.errorCode,
        suggestedAction: stage.suggestedAction ?? latestStreamMetadata.suggestedAction,
        recoveryActions: stage.recoveryActions ?? latestStreamMetadata.recoveryActions
      };
    },
    extraDispatchFields: (stage) => ({
      runtimeId: stage.runtimeId,
      providerId: stage.providerId,
      model: stage.model,
      upstreamModel: stage.upstreamModel,
      diagnosticCode: stage.diagnosticCode,
      severity: stage.severity,
      errorCode: stage.errorCode,
      suggestedAction: stage.suggestedAction,
      recoveryActions: stage.recoveryActions
    }),
    onAfterDispatch: (stage) => {
      if (stage.phase === 'context_compressed') {
        params.dispatchEvent({
          type: 'context_compressed',
          streamId,
          projectId: params.projectId,
          sessionId,
          message: stage.summary || '上下文已压缩。',
          boundaryOrdinal: typeof stage.input?.boundaryOrdinal === 'number' ? stage.input.boundaryOrdinal : undefined,
          coveredMessageCount: typeof stage.input?.coveredMessageCount === 'number' ? stage.input.coveredMessageCount : undefined,
          startedAt
        });
      }
      if (stage.phase === 'tool_timeout') {
        params.dispatchEvent({
          type: 'tool_timeout',
          streamId,
          projectId: params.projectId,
          sessionId,
          toolUseId: typeof stage.input?.toolUseId === 'string' ? stage.input.toolUseId : undefined,
          toolName: typeof stage.input?.toolName === 'string' ? stage.input.toolName : undefined,
          elapsedSeconds: typeof stage.input?.elapsedSeconds === 'number' ? stage.input.elapsedSeconds : undefined,
          message: stage.summary || 'Claude 工具执行超时。',
          startedAt
        });
      }
    }
  });

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
        attachments: params.attachments,
        resumeContext: params.resumeContext,
        provider: resolved.provider,
        mcpPlugins: resolved.mcpPlugins,
        enginePlugin: resolved.enginePlugin,
        assetPlugin: resolved.assetPlugin,
        qaPlugin: resolved.qaPlugin,
        customPlugin: resolved.customPlugin,
        abortSignal: controller.signal,
        onStatus: (phase, statusMessage) => {
          updateActiveRunStatus(activeRun.id, statusMessage);
          params.dispatchEvent({
            type: 'status',
            streamId,
            projectId: params.projectId,
            sessionId,
            phase,
            message: statusMessage,
            ...latestStreamMetadata,
            startedAt
          });
        },
        onTextDelta: (delta, content) => {
          recordActiveRunStreamDelta(activeRun.id, {
            kind: 'text',
            delta,
            content
          });
          params.dispatchEvent({
            type: 'delta',
            streamId,
            projectId: params.projectId,
            sessionId,
            delta,
            content,
            startedAt
          });
        },
        onThinkingDelta: (delta, content) => {
          recordActiveRunStreamDelta(activeRun.id, {
            kind: 'thinking',
            delta,
            content
          });
          params.dispatchEvent({
            type: 'thinking',
            streamId,
            projectId: params.projectId,
            sessionId,
            delta,
            content,
            startedAt
          });
        },
        onToolUse: makeToolUseHandler(ctx),
        onToolResult: makeToolResultHandler(ctx),
        onStage,
        onPermissionRequest,
        requestPermission,
        onUserInputRequest,
        requestUserInput,
        onUsage: makeUsageHandler(ctx)
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
      finalOutcome = processStreamError(ctx, error, {
        interruptMessage: 'Agent run was interrupted before completion.',
        failMessage: 'AI stream failed.',
        errorMetadata: { ...latestStreamMetadata }
      }).finalOutcome;
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
    prompt: message,
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

export function startAgentExecutionPlanStream(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  projectId: string;
  resumedFromRunId?: string;
  dispatchEvent: (event: PromptStreamEvent) => void;
}): PromptStreamHandle {
  const state = params.getState();
  const project = state.projects.find((item) => item.id === params.projectId);
  if (!project) {
    throw new Error('Project not found.');
  }

  const activeSession = getActiveProjectSession(ensureProjectSessions(project));
  const sessionId = activeSession.id;
  if (hasActiveStreamForSession(sessionId) || hasActiveExecutionPlanStream(params.projectId)) {
    throw new Error('This project already has an active agent run.');
  }

  const streamId = makeId('planstream');
  const startedAt = nowIso();
  const controller = new AbortController();
  addSessionCheckpointSnapshot(
    state,
    params.projectId,
    sessionId,
    'Before execution plan'
  );
  const checkpointSnapshotId = state.projects.find((item) => item.id === params.projectId)?.snapshots[0]?.id;
  const activeRun = registerActiveRun({
    kind: 'execute-plan',
    projectId: params.projectId,
    sessionId,
    streamId,
    checkpointSnapshotId,
    inputPreview: 'Run current plan',
    request: {
      kind: 'execute-plan',
      projectId: params.projectId,
      sessionId,
      runtimeId: 'execute-plan',
      providerId: activeSession.runtimeOverrides?.providerId,
      model: activeSession.runtimeOverrides?.model,
      permissionMode:
        activeSession.runtimeOverrides?.permissionMode ??
        project.agentPolicy?.permissionMode ??
        state.agentSettings.permissionMode,
      checkpointSnapshotId,
      inputPreview: 'Run current plan'
    },
    controller,
    resumedFromRunId: params.resumedFromRunId
  });
  const toolNamesByUseId = new Map<string, string>();
  registerActiveStream({
    kind: 'execute-plan',
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
  const { onPermissionRequest, requestPermission } = makePermissionHandlers(ctx, {
    getRuntimeId: () => activeSession.runtimeOverrides?.runtimeId,
    getCwd: () => project.engine?.projectPath
  });
  const { onUserInputRequest, requestUserInput } = makeUserInputHandlers(ctx);
  const onStage = makeStageHandler(ctx);

  void (async () => {
    let finalOutcome: 'completed' | 'interrupted' | 'failed' = 'completed';
    try {
      updateActiveRunStatus(activeRun.id, '正在准备执行计划…');
      params.dispatchEvent({
        type: 'status',
        streamId,
        projectId: params.projectId,
        sessionId,
        phase: 'thinking',
        message: '正在准备执行计划…',
        startedAt
      });

      const executionState = params.getState();
      await params.persistState({ ...executionState });

      const { project: updated } = await executeAgentTask({
        kind: 'execute-plan',
        state: executionState,
        projectId: params.projectId,
        controller,
        checkpointSnapshotId,
        onStatus: (message) => {
          updateActiveRunStatus(activeRun.id, message);
          params.dispatchEvent({
            type: 'status',
            streamId,
            projectId: params.projectId,
            sessionId,
            phase: 'streaming',
            message,
            startedAt
          });
        },
        onToolUse: makeToolUseHandler(ctx),
        onToolResult: makeToolResultHandler(ctx),
        onStage,
        onPermissionRequest,
        requestPermission,
        onUserInputRequest,
        requestUserInput
      });

      await params.persistState({ ...executionState });
      const planActiveSession = getActiveProjectSession(ensureProjectSessions(updated));
      const latestAssistantMessage = [...planActiveSession.chat].reverse().find((message) => message.role === 'assistant');
      const finalContent = latestAssistantMessage ? getChatMessageVisibleAssistantText(latestAssistantMessage, 2400) : '';
      if (finalContent) {
        recordActiveRunStreamDelta(activeRun.id, {
          kind: 'text',
          delta: finalContent,
          content: finalContent
        });
        params.dispatchEvent({
          type: 'delta',
          streamId,
          projectId: params.projectId,
          sessionId,
          delta: finalContent,
          content: finalContent,
          startedAt
        });
      }

      params.dispatchEvent({
        type: 'completed',
        streamId,
        projectId: params.projectId,
        sessionId,
        project: updated,
        startedAt,
        finishedAt: nowIso()
      });
    } catch (error) {
      finalOutcome = processStreamError(ctx, error, {
        interruptMessage: 'Execution plan run was interrupted before completion.',
        failMessage: 'Execution plan stream failed.'
      }).finalOutcome;
    } finally {
      finalizeStream(ctx, finalOutcome);
    }
  })();

  return {
    streamId,
    projectId: params.projectId,
    sessionId,
    startedAt,
    kind: 'execute-plan',
    prompt: 'Run current plan',
    resumedFromRunId: params.resumedFromRunId
  };
}

export function cancelAgentExecutionPlanStream(streamId: string): { success: true } {
  const active = getActiveStream(streamId);
  if (!active || active.kind !== 'execute-plan') {
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

  if (persisted.request.kind === 'execute-plan') {
    const handle = startAgentExecutionPlanStream({
      getState: params.getState,
      persistState: params.persistState,
      projectId: persisted.projectId,
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
      cwd: pending.cwd
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

export function respondToAgentUserInputRequest(
  requestId: string,
  response: AgentUserInputResponse
): { success: true } {
  resolvePendingUserInput(requestId, response);
  return { success: true };
}

export function hasSessionWritePermissionOverride(sessionId: string): boolean {
  return hasSessionWritePermission(sessionId);
}
