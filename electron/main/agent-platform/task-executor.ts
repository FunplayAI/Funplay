import {
  appendProjectConversationTurn,
  ensureProjectSessions,
  getActiveProjectSession,
  replaceProjectSession,
  syncProjectChatFromActiveSession
} from '../../../shared/project-sessions';
import type { GameAgentRun, GameAgentStep, McpPlugin, Project, RuntimeUsage } from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import { getAgentSettings } from '../store';
import {
  hasSessionWritePermission,
  listSessionMcpToolPermissionKeys,
  listSessionPermissionRules,
  listSessionWritePermissionTools
} from './permission-session-store';
import { buildGenericWorkspaceContext } from './context';
import { resolveGenericAgentRuntime } from './runtime-registry';
import { supportsGenericAgentRuntimeCapability } from './runtime-capabilities';
import { accumulateUsage, emptyUsageTotals } from './usage';
import type {
  GenericAgentBootstrapTask,
  GenericAgentConversationTask,
  GenericAgentRuntimeResult,
  GenericAgentTask
} from './types';
import { executeGenericAgentRuntimeEventStream } from './runtime-event-stream';
import { createRuntimeEventResultProjection } from './runtime-event-result';
import { acquireAgentSessionLock, releaseAgentSessionLock } from './session-run-lock';
import { prepareNativeContextHandoff, resetNativeContextCompressionState } from './native/context-handoff';
import {
  recordActiveRunAgentCoreParts,
  recordActiveRunLifecycleHook,
  recordActiveRunSkillActivation
} from './run-registry';
import { loadAgentLifecycleHookConfigForProject } from './agent-hooks';

/**
 * Thrown when a conversation run is interrupted (stop pressed / abort signal
 * fired) after the turn already started. Carries the committed partial turn
 * (user message + whatever the agent had streamed so far) so the caller can
 * persist it instead of discarding the whole turn. Without this, an interrupted
 * turn never reaches `appendProjectConversationTurn` and the entire session row
 * is lost on the next DELETE-then-insert persist.
 */
export class AgentRunInterruptedError extends Error {
  readonly partialProject: Project;

  constructor(partialProject: Project) {
    super('Agent run was interrupted before completion.');
    this.name = 'AgentRunInterruptedError';
    this.partialProject = partialProject;
  }
}

function createStep(
  kind: GameAgentStep['kind'],
  title: string,
  detail: string,
  status: GameAgentStep['status']
): GameAgentStep {
  return {
    id: makeId('step'),
    kind,
    title,
    detail,
    status
  };
}

function activateTargetSession(project: Project, targetSessionId?: string): Project {
  const ensured = ensureProjectSessions(project);
  if (!targetSessionId) {
    return ensured;
  }

  if (!ensured.sessions.some((session) => session.id === targetSessionId)) {
    throw new Error('Session not found.');
  }

  return syncProjectChatFromActiveSession({
    ...ensured,
    activeSessionId: targetSessionId
  });
}

function collectPlugins(task: {
  mcpPlugins?: McpPlugin[];
  enginePlugin?: McpPlugin;
  assetPlugin?: McpPlugin;
  qaPlugin?: McpPlugin;
  customPlugin?: McpPlugin;
}): McpPlugin[] {
  const plugins = [
    ...(task.mcpPlugins ?? []),
    task.enginePlugin,
    task.assetPlugin,
    task.qaPlugin,
    task.customPlugin
  ].filter(Boolean) as McpPlugin[];
  return [...new Map(plugins.map((plugin) => [plugin.id, plugin])).values()];
}

function isManualCompactPrompt(message: string): boolean {
  return message.trim() === '/compact';
}

export async function executeGenericBootstrap(
  task: GenericAgentBootstrapTask
): Promise<{ project: Project; run: GameAgentRun }> {
  const startedAt = nowIso();
  const plugins = collectPlugins(task);
  const steps = [
    createStep('context', '建立通用项目上下文', '已创建项目并初始化通用 Agent 工作区。', 'completed'),
    createStep('context', '记录可用插件配置', `已识别 ${plugins.length} 个项目插件配置。`, 'completed')
  ];

  const run: GameAgentRun = {
    id: makeId('run'),
    mode: 'bootstrap',
    input: task.input.pitch,
    status: task.provider ? 'completed' : 'fallback',
    usedProviderId: task.provider?.id,
    usedModel: task.provider?.model,
    startedAt,
    finishedAt: nowIso(),
    steps,
    pluginReports: [],
    executionPlan: task.project.currentExecutionPlan,
    operationLog: []
  };

  const project = {
    ...ensureProjectSessions(task.project),
    lastAgentRun: run,
    updatedAt: run.finishedAt,
    activity: [
      {
        id: makeId('act'),
        kind: 'planning' as const,
        title: 'Generic Agent Platform 已初始化',
        detail: '项目已接入通用 Agent 平台。',
        createdAt: run.finishedAt
      },
      ...task.project.activity
    ]
  };

  return { project, run };
}

export async function executeGenericConversation(
  task: GenericAgentConversationTask
): Promise<{ project: Project; run: GameAgentRun }> {
  const startedAt = nowIso();
  const currentProject = activateTargetSession(task.project, task.sessionId);
  const activeSession = getActiveProjectSession(currentProject);
  const lockToken = acquireAgentSessionLock(activeSession.id, 'conversation');
  if (!lockToken) {
    task.onStage?.({
      stageId: 'stage:session_busy',
      phase: 'session_busy',
      title: '会话正在处理请求',
      target: 'stage:session_busy',
      status: 'failed',
      summary: '当前会话已有一个 Agent 请求在运行。'
    });
    throw new Error('SESSION_BUSY: This session already has an active agent run.');
  }

  try {
    const plugins = collectPlugins(task);
    const context = buildGenericWorkspaceContext(currentProject, plugins, activeSession.id, task.message);
    const lifecycleHooks = loadAgentLifecycleHookConfigForProject(currentProject, {
      includeUser: false
    });
    for (const skill of context.toolContext.activeSkills) {
      if (task.activeRunId) {
        recordActiveRunSkillActivation(task.activeRunId, skill);
      }
    }
    const agentSettings = getAgentSettings();
    const runtime = resolveGenericAgentRuntime({
      runtimeId: activeSession.runtimeOverrides?.runtimeId,
      provider: task.provider,
      runtimeStrategy: agentSettings.runtimeStrategy
    });
    if (!supportsGenericAgentRuntimeCapability(runtime, 'conversation')) {
      throw new Error(`Runtime ${runtime.id} does not support conversation turns.`);
    }
    const runtimeGrantId = runtime.id === 'native' ? runtime.id : undefined;
    const permissionGrantContext = {
      runtimeId: runtimeGrantId,
      cwd: currentProject.engine?.projectPath
    };
    const sessionWriteTools = listSessionWritePermissionTools(activeSession.id, permissionGrantContext);
    const sessionMcpTools = listSessionMcpToolPermissionKeys(activeSession.id, permissionGrantContext);
    const permissionMode =
      activeSession.runtimeOverrides?.permissionMode ??
      currentProject.agentPolicy?.permissionMode ??
      agentSettings.permissionMode;
    task.onStage?.({
      stageId: 'stage:runtime_resolved',
      phase: 'runtime_resolved',
      title: '选择 Agent runtime',
      target: 'stage:runtime_resolved',
      status: 'completed',
      summary: `${runtime.displayName} / ${task.provider?.name ?? 'no provider'} / ${task.provider?.model ?? 'default model'}`,
      runtimeId: runtimeGrantId,
      providerId: task.provider?.id,
      model: task.provider?.model,
      input: {
        runtimeId: runtime.id,
        runtimeStrategy: agentSettings.runtimeStrategy,
        sessionRuntimeId: activeSession.runtimeOverrides?.runtimeId,
        providerId: task.provider?.id,
        model: task.provider?.model
      }
    });

    if (isManualCompactPrompt(task.message)) {
      const summaryResult = prepareNativeContextHandoff({
        project: currentProject,
        sessionId: activeSession.id,
        provider: task.provider,
        currentPrompt: task.message,
        force: true
      });
      const updatedAt = nowIso();
      let nextProject = currentProject;
      const steps: GameAgentStep[] = [];

      if (summaryResult?.summary.trim()) {
        resetNativeContextCompressionState(activeSession.id);
        task.onStatus?.('thinking', '已压缩 Native runtime 上下文。');
        task.onStage?.({
          stageId: 'stage:native_context_compressed',
          phase: 'context_compressed',
          title: '压缩 Native runtime 上下文',
          target: 'stage:native_context_compressed',
          status: 'completed',
          summary: '已生成上下文摘要，下一轮 native runtime 将以摘要加未覆盖消息继续。',
          runtimeId: 'native',
          providerId: task.provider?.id,
          model: task.provider?.model,
          input: {
            contextSummary: summaryResult.summary,
            contextSummaryCoverage: summaryResult.coverage,
            boundaryRowId: summaryResult.coverage.boundaryRowId,
            boundaryOrdinal: summaryResult.coverage.boundaryOrdinal,
            coveredMessageCount: summaryResult.coverage.coveredMessageCount ?? summaryResult.coverage.messageCount
          }
        });
        steps.push(
          createStep('memory', '压缩 Native runtime 上下文', '已生成摘要并更新 Native 上下文边界。', 'completed')
        );
        nextProject = replaceProjectSession(
          currentProject,
          {
            ...activeSession,
            updatedAt,
            runtimeOverrides: {
              ...activeSession.runtimeOverrides,
              ...summaryResult.patch
            }
          },
          activeSession.id
        );
      } else {
        task.onStatus?.('thinking', '当前会话还不需要压缩。');
        steps.push(
          createStep(
            'memory',
            '跳过 Native runtime 上下文压缩',
            '当前会话未达到压缩阈值或没有可压缩的新消息。',
            'skipped'
          )
        );
      }

      const run: GameAgentRun = {
        id: makeId('run'),
        mode: 'update',
        input: task.message,
        status: 'completed',
        usedProviderId: task.provider?.id,
        usedModel: task.provider?.model,
        startedAt,
        finishedAt: updatedAt,
        steps,
        pluginReports: [],
        executionPlan: nextProject.currentExecutionPlan,
        operationLog: []
      };

      nextProject = {
        ...nextProject,
        activeSessionId: activeSession.id,
        lastAgentRun: run,
        updatedAt
      };

      return { project: nextProject, run };
    }

    let tokenUsage = emptyUsageTotals();
    let hasTokenUsage = false;
    const onUsage = (usage: RuntimeUsage): void => {
      tokenUsage = accumulateUsage(tokenUsage, usage);
      hasTokenUsage = true;
      task.onUsage?.(usage);
    };

    let result: GenericAgentRuntimeResult | undefined;
    const runtimeParams = {
      project: currentProject,
      message: task.message,
      attachments: task.attachments,
      uiLanguage: task.uiLanguage,
      provider: task.provider,
      plugins,
      context,
      appState: task.appState,
      persistAppState: task.persistAppState,
      resumeContext: task.resumeContext,
      checkpointSnapshotId: task.checkpointSnapshotId,
      permission: {
        mode: permissionMode,
        allowWriteTools: permissionMode === 'full-access',
        allowSessionWriteTools: hasSessionWritePermission(activeSession.id, undefined, permissionGrantContext),
        allowedWriteTools: permissionMode === 'full-access' ? ['*'] : sessionWriteTools,
        allowedMcpTools: sessionMcpTools,
        rules: listSessionPermissionRules(activeSession.id, permissionGrantContext),
        projectPath: currentProject.engine?.projectPath
      },
      activeRunId: task.activeRunId,
      turnId: task.userMessageId,
      lifecycleHooks,
      abortSignal: task.abortSignal,
      requestPermission: task.requestPermission,
      requestUserInput: task.requestUserInput
    };

    const eventProjection = createRuntimeEventResultProjection(runtimeParams);
    let lastAccumulatedAssistantText = '';
    try {
      for await (const event of executeGenericAgentRuntimeEventStream(runtime, runtimeParams)) {
        eventProjection.observe(event);
        if (event.type === 'status') {
          task.onStatus?.(event.phase, event.message);
        } else if (event.type === 'text_delta') {
          lastAccumulatedAssistantText = event.accumulated;
          task.onTextDelta?.(event.delta, event.accumulated);
        } else if (event.type === 'thinking_delta') {
          task.onThinkingDelta?.(event.delta, event.accumulated);
        } else if (event.type === 'tool_use') {
          task.onToolUse?.(event.tool);
        } else if (event.type === 'tool_result') {
          task.onToolResult?.(event.result);
        } else if (event.type === 'stage') {
          task.onStage?.(event.stage);
        } else if (event.type === 'permission_request') {
          task.onPermissionRequest?.(event.request);
        } else if (event.type === 'user_input_request') {
          task.onUserInputRequest?.(event.request);
        } else if (event.type === 'usage') {
          onUsage(event.usage);
        } else if (event.type === 'lifecycle_hook') {
          if (task.activeRunId) {
            recordActiveRunLifecycleHook(task.activeRunId, event.hook);
          }
        } else if (event.type === 'agent_core_parts') {
          if (task.activeRunId) {
            recordActiveRunAgentCoreParts(task.activeRunId, event.parts);
          }
          task.onAgentCoreParts?.(event.parts);
          continue;
        } else {
          result = event.result;
        }
      }
    } catch (error) {
      // Interrupted (stop / abort): commit the partial turn (user message + the
      // text streamed so far) and re-throw carrying it, so the run-manager can
      // persist it instead of losing the whole turn. Non-abort errors propagate.
      if (task.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        const interruptedAt = nowIso();
        const interruptedProject = appendProjectConversationTurn(currentProject, {
          userMessageId: task.userMessageId,
          userMessage: task.message,
          userDisplayMessage: task.displayMessage,
          userAttachments: task.attachments,
          assistantMessage: lastAccumulatedAssistantText.trim() || '_（本轮已中断，未生成完整回复）_',
          assistantMetadata: {
            intent: 'chat',
            agentStartedAt: startedAt,
            agentFinishedAt: interruptedAt,
            executionSummary: '本轮在完成前被中断，已保留用户消息与已生成的部分内容。'
          },
          updatedAt: interruptedAt,
          activityTitle: '通用 Agent 已中断',
          activityDetail: '本轮在完成前被中断，已保留用户消息与已生成的部分内容。'
        });
        throw new AgentRunInterruptedError({
          ...interruptedProject,
          activeSessionId: activeSession.id,
          updatedAt: interruptedAt
        });
      }
      throw error;
    }
    if (!result) {
      throw new Error(`Runtime ${runtime.id} completed without a result event.`);
    }

    const updatedAt = nowIso();
    result = eventProjection.buildProjectedResult(result, {
      createdAt: updatedAt,
      activeSkills: context.toolContext.activeSkills
    });
    const agentCoreParts = result.assistantMetadata?.agentCoreParts;
    let nextProject = appendProjectConversationTurn(currentProject, {
      userMessageId: task.userMessageId,
      userMessage: task.message,
      userDisplayMessage: task.displayMessage,
      userAttachments: task.attachments,
      assistantMessage: result.assistantMessage,
      assistantMetadata: {
        ...result.assistantMetadata,
        agentCoreParts,
        intent: result.assistantIntent,
        agentStartedAt: startedAt,
        agentFinishedAt: updatedAt,
        operationLog: result.operationLog,
        tokenUsage: hasTokenUsage ? tokenUsage : undefined,
        diagnosticCode: result.diagnosticCode,
        severity: result.severity,
        suggestedAction: result.suggestedAction,
        recoveryActions: result.recoveryActions,
        activitySummary:
          result.assistantIntent === 'fallback'
            ? [result.usedProviderId, result.usedModel].filter(Boolean).join(' / ') || 'fallback'
            : undefined,
        executionSummary: result.assistantIntent === 'fallback' ? result.fallbackDetail : undefined
      },
      updatedAt,
      activityTitle: result.status === 'completed' ? '通用 Agent 已回复' : '通用 Agent 已回退回复',
      activityDetail: result.status === 'completed' ? `已围绕“${task.message}”完成回复。` : '本轮使用 fallback 回复。'
    });

    if (result.sessionRuntimePatch && Object.keys(result.sessionRuntimePatch).length > 0) {
      const ensured = ensureProjectSessions(nextProject);
      const sessionToPatch = ensured.sessions.find((session) => session.id === activeSession.id);
      if (sessionToPatch) {
        nextProject = replaceProjectSession(
          ensured,
          {
            ...sessionToPatch,
            runtimeOverrides: {
              ...sessionToPatch.runtimeOverrides,
              ...result.sessionRuntimePatch
            }
          },
          activeSession.id
        );
      }
    }

    const run: GameAgentRun = {
      id: makeId('run'),
      mode: 'update',
      input: task.message,
      status: result.status,
      usedProviderId: result.usedProviderId,
      usedModel: result.usedModel,
      startedAt,
      finishedAt: updatedAt,
      steps: result.steps,
      pluginReports: [],
      executionPlan: nextProject.currentExecutionPlan,
      operationLog: result.operationLog ?? []
    };

    nextProject = {
      ...nextProject,
      activeSessionId: activeSession.id,
      lastAgentRun: run,
      updatedAt
    };

    return { project: nextProject, run };
  } finally {
    releaseAgentSessionLock(activeSession.id, lockToken);
  }
}

export async function executeGenericAgentTask(
  task: GenericAgentTask
): Promise<{ project: Project; run: GameAgentRun }> {
  switch (task.kind) {
    case 'bootstrap':
      return executeGenericBootstrap(task);
    case 'conversation':
      return executeGenericConversation(task);
    default:
      throw new Error('Unsupported generic agent task.');
  }
}
