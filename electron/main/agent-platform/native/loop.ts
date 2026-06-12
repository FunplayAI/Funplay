import type {
  AgentVerificationTrigger,
  AiProviderApiMode,
  GameAgentStep,
  NativeContextSummaryCoverage,
  ProjectSession,
  RuntimeUsage
} from '../../../../shared/types';
import { inferOpenAiCompatibleApiMode } from '../../../../shared/provider-catalog';
import { ensureProjectSessions } from '../../../../shared/project-sessions';
import { makeId } from '../../../../shared/utils';
import { runGenericAgentLoop } from '../agent-loop';
import { buildNativeRuntimePluginProbeSummary, buildNativeRuntimeThinkingPrelude } from './prompt';
import { runNativeReadOnlyToolLoop, runOpenAiCompatibleNativeToolLoop } from './tool-loop';
import { getAgentToolDefinition } from '../tool-registry';
import type { AgentToolSideEffectClassification } from '../tool-registry';
import type { ConversationOperationStageEvent } from '../operation-log';
import { createConversationRuntimeOutputCollector } from '../runtime-output';
import { emitRuntimeLifecycleHook, emitRuntimeStatus } from '../runtime-event-emitter';
import { formatProjectContextIndexSummary } from '../context';
import { collectPluginObservations } from '../../game-tool-layer';
import { emitReplyAsDeltas, runNativeDirectChatReply } from './direct-reply';
import type { GenericAgentRuntimeParams, GenericAgentRuntimeResult } from '../types';
import {
  applyNativeContextPatchToProject,
  computeNativeSessionTranscriptChars,
  prepareNativeContextHandoff,
  prepareNativeContextHandoffWithModelSummary,
  recordNativeSessionTokenBaseline
} from './context-handoff';
import {
  classifyNativeRuntimeError,
  extractNativeRuntimeErrorDetail,
  summarizeNativeRuntimeDiagnostic
} from './diagnostics';
import { formatToolPolicyForStage, resolveAgentToolPolicy, type AgentToolPolicyDecision } from '../tool-policy';
import { runAgentLifecycleHooks } from '../agent-hooks';
import {
  collectActiveVerificationChangeSummary,
  collectActiveVerificationRepairEvidence,
  createActiveVerificationRepairPrompt,
  formatActiveVerificationFailureReply,
  planActiveVerification,
  runActiveVerificationGate,
  type ActiveVerificationChangeSummary,
  type ActiveVerificationPlan,
  type ActiveVerificationRunResult,
  type ActiveVerificationSideEffectEvidence
} from '../active-verification';
import type { WorkspaceToolAction } from '../workspace-tools';

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

function isWritePermissionAllowed(decision: Awaited<ReturnType<typeof resolveWritePermission>>): boolean {
  return decision === 'allow' || decision === 'allow_session';
}

async function resolveWritePermission(
  params: GenericAgentRuntimeParams,
  policy: AgentToolPolicyDecision
): Promise<'allow' | 'allow_session' | 'deny' | 'not_needed'> {
  if (!policy.requiresWorkspaceWritePermission) {
    return 'not_needed';
  }

  if (params.permission.allowWriteTools || params.permission.allowSessionWriteTools) {
    return 'allow';
  }

  if (params.permission.mode === 'read-only') {
    return 'not_needed';
  }

  return 'not_needed';
}

async function emitRealPluginObservations(params: GenericAgentRuntimeParams): Promise<void> {
  const observablePlugins = params.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      (plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl?.trim()))
  );

  for (const plugin of observablePlugins) {
    const toolUseId = makeId('tool');
    params.onToolUse?.({
      toolUseId,
      name: `observe_${plugin.kind}_plugin`,
      input: {
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginKind: plugin.kind
      },
      status: 'running'
    });

    try {
      const observation = await collectPluginObservations(plugin);
      const lines = [
        `${plugin.name} (${plugin.kind})`,
        observation.report.resourceReads.length > 0
          ? `读取资源：${observation.report.resourceReads.join(', ')}`
          : '读取资源：无',
        observation.report.toolCalls.length > 0
          ? `调用工具：${observation.report.toolCalls.join(', ')}`
          : '调用工具：无',
        observation.report.observations.length > 0 ? observation.report.observations.join('\n') : '无可用观测结果。'
      ].filter(Boolean);

      params.onToolResult?.({
        toolUseId,
        content: lines.join('\n\n')
      });
      params.onToolUse?.({
        toolUseId,
        name: `observe_${plugin.kind}_plugin`,
        input: {
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginKind: plugin.kind
        },
        status: 'completed'
      });
    } catch (error) {
      params.onToolResult?.({
        toolUseId,
        content: error instanceof Error ? error.message : 'Failed to collect plugin observations.',
        isError: true
      });
      params.onToolUse?.({
        toolUseId,
        name: `observe_${plugin.kind}_plugin`,
        input: {
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginKind: plugin.kind
        },
        status: 'failed'
      });
    }
  }
}

function runtimeLocalize(params: Pick<GenericAgentRuntimeParams, 'uiLanguage'>, zh: string, en: string): string {
  return params.uiLanguage === 'en-US' ? en : zh;
}

// Pre-stage gating: the synthetic workspace/plugin observation stages run on the
// first turn of a session and afterwards only when change detection says the
// snapshot is stale (plugin set changed, file tree / project index changed, or a
// compaction moved the coverage boundary).
const workspaceObservationSignaturesBySession = new Map<string, string>();
const WORKSPACE_OBSERVATION_SIGNATURE_CACHE_LIMIT = 64;

export function computeNativeWorkspaceObservationSignature(
  params: Pick<GenericAgentRuntimeParams, 'context'>,
  compactionCoverage?: Pick<NativeContextSummaryCoverage, 'boundaryRowId' | 'boundaryOrdinal'>
): string {
  const index = params.context.projectContextIndex;
  return JSON.stringify({
    plugins: params.context.toolContext.plugins
      .map((plugin) => `${plugin.id}:${plugin.kind}:${plugin.enabled ? 1 : 0}:${plugin.hasEndpoint ? 1 : 0}`)
      .sort(),
    // generatedAt is excluded: it changes every run even when nothing else did.
    // recentFiles/entrypoints/scripts capture actual file-tree and config drift.
    contextIndex: index ? { ...index, generatedAt: undefined } : undefined,
    compactionBoundary: [compactionCoverage?.boundaryRowId ?? null, compactionCoverage?.boundaryOrdinal ?? null]
  });
}

export function shouldRunNativeWorkspaceObservation(sessionId: string | undefined, signature: string): boolean {
  if (!sessionId) {
    return true;
  }
  return workspaceObservationSignaturesBySession.get(sessionId) !== signature;
}

export function recordNativeWorkspaceObservation(sessionId: string | undefined, signature: string): void {
  if (!sessionId) {
    return;
  }
  if (
    !workspaceObservationSignaturesBySession.has(sessionId) &&
    workspaceObservationSignaturesBySession.size >= WORKSPACE_OBSERVATION_SIGNATURE_CACHE_LIMIT
  ) {
    const oldest = workspaceObservationSignaturesBySession.keys().next().value;
    if (oldest !== undefined) {
      workspaceObservationSignaturesBySession.delete(oldest);
    }
  }
  workspaceObservationSignaturesBySession.set(sessionId, signature);
}

export function resetNativeWorkspaceObservationGate(sessionId?: string): void {
  if (sessionId) {
    workspaceObservationSignaturesBySession.delete(sessionId);
    return;
  }
  workspaceObservationSignaturesBySession.clear();
}

function createFallbackReply(
  params: GenericAgentRuntimeParams,
  providerMissing: boolean,
  errorMessage?: string
): string {
  if (providerMissing) {
    return [
      runtimeLocalize(
        params,
        '当前没有可用的 AI Provider，暂时无法生成模型回复。',
        'No AI Provider is currently available, so Funplay cannot generate a model response yet.'
      ),
      '',
      runtimeLocalize(
        params,
        '请到“应用设置 / AI Provider”配置并测试模型服务后重试。',
        'Go to App Settings / AI Provider, configure and test a model service, then try again.'
      )
    ].join('\n');
  }

  return [
    runtimeLocalize(
      params,
      '这次 AI Provider 返回了错误，未能生成回复。',
      'The AI Provider returned an error and could not generate a response.'
    ),
    errorMessage ? runtimeLocalize(params, `错误信息：${errorMessage}`, `Error: ${errorMessage}`) : '',
    '',
    runtimeLocalize(
      params,
      '请检查 Provider 配置、模型名称或网络连通性后重试。',
      'Check the Provider configuration, model name, or network connection, then try again.'
    )
  ]
    .filter(Boolean)
    .join('\n');
}

function createPermissionDeniedReply(): string {
  return [
    '当前这轮请求涉及文件写入，但还没有获得写入权限。',
    '',
    '我可以继续以 Agent 只读方式提供：',
    '- 可直接复制的修改方案',
    '- 分步骤操作指引',
    '- 文件级 patch 建议',
    '',
    '如果你希望我直接执行写入，请先允许本轮或当前会话的写入权限。'
  ].join('\n');
}

function isNativeReadOnlyToolLoopEnabled(): boolean {
  return process.env.FUNPLAY_NATIVE_TOOL_LOOP !== 'false';
}

function isNativeWriteToolLoopEnabled(): boolean {
  return process.env.FUNPLAY_NATIVE_WRITE_TOOL_LOOP !== 'false';
}

function isNativeMcpToolLoopEnabled(): boolean {
  return process.env.FUNPLAY_NATIVE_MCP_TOOL_LOOP !== 'false';
}

function isNativeCommandToolLoopEnabled(): boolean {
  return process.env.FUNPLAY_NATIVE_COMMAND_TOOL_LOOP !== 'false';
}

export type NativeToolLoopStrategyReason =
  | 'native_tool_calling_selected'
  | 'native_tool_calling_disabled'
  | 'openai_compatible_streaming_tool_calls_disabled';

export interface NativeToolLoopStrategy {
  useNativeToolLoop: boolean;
  reason: NativeToolLoopStrategyReason;
  summary: string;
}

export function resolveNativeToolLoopStrategy(input: {
  nativeToolCallingEnabled: boolean;
  sessionMode?: string;
  providerProtocol?: string;
  openAiCompatibleApiMode?: AiProviderApiMode;
  openAiCompatibleToolCallingVerified?: boolean;
}): NativeToolLoopStrategy {
  if (!input.nativeToolCallingEnabled) {
    return {
      useNativeToolLoop: false,
      reason: 'native_tool_calling_disabled',
      summary: '内置工具执行链路已关闭；本轮将降级为普通模型回复。'
    };
  }

  if (input.providerProtocol === 'openai-compatible' && input.openAiCompatibleToolCallingVerified === false) {
    const apiMode = input.openAiCompatibleApiMode ? `（${input.openAiCompatibleApiMode}）` : '';
    return {
      useNativeToolLoop: false,
      reason: 'openai_compatible_streaming_tool_calls_disabled',
      summary: `当前服务商的流式工具执行${apiMode}已被显式关闭；本轮将降级为普通模型回复。`
    };
  }

  return {
    useNativeToolLoop: true,
    reason: 'native_tool_calling_selected',
    summary: '已启用内置工具执行链路；工具能力由权限模式控制。'
  };
}

function isOpenAiCompatibleStreamingToolCallsDisabled(): boolean {
  return process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS === 'false';
}

function isOpenAiCompatibleNativeStreamingToolCallsEnabled(
  provider: GenericAgentRuntimeParams['provider']
): boolean | undefined {
  if (!provider || provider.protocol !== 'openai-compatible') {
    return undefined;
  }

  return !isOpenAiCompatibleStreamingToolCallsDisabled();
}

function getNativeToolLoopStrategy(params: GenericAgentRuntimeParams): NativeToolLoopStrategy {
  const openAiCompatibleApiMode =
    params.provider?.protocol === 'openai-compatible' ? inferOpenAiCompatibleApiMode(params.provider) : undefined;

  return resolveNativeToolLoopStrategy({
    nativeToolCallingEnabled: isNativeReadOnlyToolLoopEnabled(),
    sessionMode: params.context.sessionMode,
    providerProtocol: params.provider?.protocol,
    openAiCompatibleApiMode,
    openAiCompatibleToolCallingVerified: isOpenAiCompatibleNativeStreamingToolCallsEnabled(params.provider)
  });
}

function summarizeToolLoopResult(result: { stepCount?: number; finishReason?: string; toolCalls?: string[] }): string {
  return [
    typeof result.stepCount === 'number' ? `已完成 ${result.stepCount} 轮工具执行` : '',
    result.toolCalls && result.toolCalls.length > 0 ? `调用工具：${result.toolCalls.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('；');
}

function shouldExposeNativeWriteTools(
  params: GenericAgentRuntimeParams,
  canApplyWorkspaceWrites: boolean,
  policy: AgentToolPolicyDecision
): boolean {
  const profileAllowsWrites =
    policy.executionProfile.allowedToolFamilies.includes('workspace_write') ||
    params.permission.allowWriteTools ||
    params.permission.allowSessionWriteTools ||
    params.permission.mode === 'full-access';
  return (
    profileAllowsWrites &&
    (canApplyWorkspaceWrites || params.permission.mode !== 'read-only' || policy.exposesHighRiskTools) &&
    params.permission.mode !== 'read-only'
  );
}

function shouldExposeNativeWriteToolBucket(
  params: GenericAgentRuntimeParams,
  canApplyWorkspaceWrites: boolean,
  policy: AgentToolPolicyDecision
): boolean {
  if (shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, policy)) {
    return true;
  }
  if (params.permission.mode === 'read-only') {
    return false;
  }
  const profileAllowsDurableSideEffects =
    policy.executionProfile.allowedToolFamilies.includes('engine') ||
    policy.executionProfile.allowedToolFamilies.includes('media') ||
    policy.executionProfile.allowedToolFamilies.includes('memory') ||
    policy.executionProfile.allowedToolFamilies.includes('notification');
  return policy.executionProfile.sideEffectPolicy === 'host_controlled' && profileAllowsDurableSideEffects;
}

function shouldExposeNativeCommandTools(params: GenericAgentRuntimeParams, policy: AgentToolPolicyDecision): boolean {
  return (
    policy.executionProfile.allowedToolFamilies.includes('command') &&
    (params.permission.mode === 'full-access' ||
      params.permission.mode === 'ask' ||
      params.permission.mode === 'read-only')
  );
}

function shouldExposeNativeMcpTools(
  params: GenericAgentRuntimeParams,
  canApplyWorkspaceWrites: boolean,
  policy: AgentToolPolicyDecision
): boolean {
  if (!policy.executionProfile.allowedToolFamilies.includes('mcp')) {
    return false;
  }
  if (shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, policy)) {
    return true;
  }
  return (
    policy.mcp.detected &&
    (params.permission.mode === 'full-access' ||
      params.permission.mode === 'ask' ||
      params.permission.mode === 'read-only')
  );
}

function resolveNativeAllowedToolFamilies(
  params: GenericAgentRuntimeParams,
  canApplyWorkspaceWrites: boolean,
  policy: AgentToolPolicyDecision
): AgentToolPolicyDecision['executionProfile']['allowedToolFamilies'] {
  const allowed = new Set(policy.executionProfile.allowedToolFamilies);
  if (shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, policy)) {
    allowed.add('workspace_write');
  }
  if (shouldExposeNativeMcpTools(params, canApplyWorkspaceWrites, policy)) {
    allowed.add('mcp');
  }
  return [...allowed];
}

function classifyToolSideEffectFromToolUse(
  name: string,
  input?: Record<string, unknown>
): AgentToolSideEffectClassification | undefined {
  const registered = getAgentToolDefinition(name as WorkspaceToolAction['type'])?.classifySideEffect?.(input);
  if (registered) {
    return registered;
  }
  if (name.startsWith('mcp__')) {
    return {
      kind: 'external',
      confidence: 'medium',
      evidence: ['tool:mcp', `dynamic:${name}`]
    };
  }
  return undefined;
}

function isExecutedToolSideEffect(
  classification: AgentToolSideEffectClassification | undefined
): classification is AgentToolSideEffectClassification {
  return Boolean(classification && classification.kind !== 'none' && classification.confidence !== 'none');
}

function didToolResultCommitSideEffect(
  result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]
): boolean {
  const source = result.transaction?.resultSource;
  if (source === 'validation_failed' || source === 'synthetic_failure' || source === 'cached') {
    return false;
  }
  if (source === 'interrupted') {
    return true;
  }
  if (!result.isError) {
    return true;
  }
  return Boolean(result.command || result.terminal || result.browser || result.mcp);
}

function isReadOnlyMcpToolResult(
  result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]
): boolean {
  if (!result.mcp) {
    return false;
  }
  if (
    result.mcp.operation === 'list_tools' ||
    result.mcp.operation === 'list_resources' ||
    result.mcp.operation === 'read_resource'
  ) {
    return true;
  }
  if (typeof result.mcp.readOnly === 'boolean') {
    return result.mcp.readOnly;
  }
  // Legacy results persisted before the structured flag existed only carry the rendered summary.
  return /\brisk=read\b/i.test(result.mcp.policySummary ?? '');
}

function mergeActiveVerificationTrigger(
  current: AgentVerificationTrigger | undefined,
  next: AgentVerificationTrigger | undefined
): AgentVerificationTrigger | undefined {
  if (!next) {
    return current;
  }
  if (current === 'active_write' || next === 'active_write') {
    return 'active_write';
  }
  return current ?? next;
}

function activeVerificationPlanSignature(plan: ActiveVerificationPlan): string {
  return JSON.stringify({
    trigger: plan.trigger,
    blocking: plan.blocking,
    checks: plan.checks.map((check) => ({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      target: check.target
    })),
    omittedChecks: (plan.omittedChecks ?? []).map((check) => ({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      target: check.target,
      reason: check.reason
    })),
    sideEffects: (plan.sideEffects ?? []).map((item) => ({
      toolName: item.toolName,
      kind: item.kind,
      confidence: item.confidence,
      verificationTrigger: item.verificationTrigger,
      evidence: item.evidence
    }))
  });
}

export async function runNativeConversationTurn(params: GenericAgentRuntimeParams): Promise<GenericAgentRuntimeResult> {
  const outputCollector = createConversationRuntimeOutputCollector(params);
  const toolPolicy = resolveAgentToolPolicy(params);
  let runtimeParams: GenericAgentRuntimeParams = {
    ...params,
    emitRuntimeEvent: undefined,
    onStatus: (phase, message) => params.emitRuntimeEvent?.({ type: 'status', phase, message }),
    onTextDelta: outputCollector.onTextDelta,
    onThinkingDelta: outputCollector.onThinking,
    onToolUse: outputCollector.onToolUse,
    onToolResult: outputCollector.onToolResult,
    onStage: outputCollector.onStage,
    onUsage: outputCollector.onUsage,
    onAgentCoreParts: outputCollector.onAgentCoreParts,
    onLifecycleHook: (hook) => params.emitRuntimeEvent?.({ type: 'lifecycle_hook', hook })
  };
  const nativeContextSessionId = params.context.activeSessionId;
  // First provider usage report of the run becomes the session token baseline:
  // provider-reported prompt tokens are exact for everything sent so far, so the
  // next turn's context estimate only needs chars/4 for the delta.
  let usageBaselineRecorded = false;
  const recordFirstUsageBaseline = (usage: RuntimeUsage): void => {
    if (usageBaselineRecorded || !nativeContextSessionId || usage.inputTokens <= 0) {
      return;
    }
    const session = ensureProjectSessions(runtimeParams.project).sessions.find(
      (item) => item.id === nativeContextSessionId
    );
    if (!session) {
      return;
    }
    usageBaselineRecorded = true;
    recordNativeSessionTokenBaseline(
      nativeContextSessionId,
      usage,
      computeNativeSessionTranscriptChars(session, params.message)
    );
  };
  runtimeParams = {
    ...runtimeParams,
    onUsage: (usage) => {
      recordFirstUsageBaseline(usage);
      outputCollector.onUsage(usage);
    }
  };
  let sessionRuntimePatch: Partial<NonNullable<ProjectSession['runtimeOverrides']>> | undefined;
  let sideEffectToolExecuted = false;
  let activeVerificationTrigger: AgentVerificationTrigger | undefined;
  const activeVerificationChangedFiles = new Set<string>();
  const pendingToolSideEffects = new Map<string, ActiveVerificationSideEffectEvidence>();
  const activeVerificationSideEffects: ActiveVerificationSideEffectEvidence[] = [];
  const activeVerificationSideEffectKeys = new Set<string>();
  const recordCommittedSideEffect = (sideEffect: ActiveVerificationSideEffectEvidence): void => {
    sideEffectToolExecuted = true;
    activeVerificationTrigger = mergeActiveVerificationTrigger(
      activeVerificationTrigger,
      sideEffect.verificationTrigger
    );
    const key = [
      sideEffect.toolName,
      sideEffect.kind,
      sideEffect.confidence,
      sideEffect.verificationTrigger ?? '',
      ...sideEffect.evidence
    ].join('\u0000');
    if (!activeVerificationSideEffectKeys.has(key)) {
      activeVerificationSideEffectKeys.add(key);
      activeVerificationSideEffects.push(sideEffect);
    }
  };
  const emitToolUse = (tool: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }): void => {
    const sideEffect = tool.status !== 'pending' ? classifyToolSideEffectFromToolUse(tool.name, tool.input) : undefined;
    if (isExecutedToolSideEffect(sideEffect)) {
      pendingToolSideEffects.set(tool.toolUseId, {
        toolName: tool.name,
        kind: sideEffect.kind,
        confidence: sideEffect.confidence,
        verificationTrigger: sideEffect.verificationTrigger,
        evidence: sideEffect.evidence
      });
    }
    outputCollector.onToolUse(tool);
  };
  const emitToolResult = (result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]): void => {
    if (result.changedFiles?.some((file) => file.operation !== 'failed')) {
      activeVerificationTrigger = mergeActiveVerificationTrigger(activeVerificationTrigger, 'active_write');
      sideEffectToolExecuted = true;
      for (const file of result.changedFiles) {
        if (file.operation !== 'failed') {
          activeVerificationChangedFiles.add(file.path);
        }
      }
      recordCommittedSideEffect({
        toolName: result.toolName ?? 'tool_result',
        kind: 'workspace_write',
        confidence: 'high',
        verificationTrigger: 'active_write',
        evidence: [
          'tool_result:changed_files',
          ...result.changedFiles
            .filter((file) => file.operation !== 'failed')
            .slice(0, 8)
            .map((file) => `${file.operation}:${file.path}`)
        ]
      });
    } else {
      const pendingSideEffect = pendingToolSideEffects.get(result.toolUseId);
      if (pendingSideEffect && didToolResultCommitSideEffect(result) && !isReadOnlyMcpToolResult(result)) {
        recordCommittedSideEffect(pendingSideEffect);
      }
    }
    pendingToolSideEffects.delete(result.toolUseId);
    outputCollector.onToolResult(result);
  };
  const emitThinking = (delta: string, accumulated: string): void => {
    outputCollector.onThinking(delta, accumulated);
  };
  const emitStage = (stage: ConversationOperationStageEvent): void => {
    outputCollector.onStage(stage);
  };
  const runLifecycleHooks = (trigger: Parameters<typeof runAgentLifecycleHooks>[1]) =>
    runAgentLifecycleHooks(
      runtimeParams.lifecycleHooks,
      {
        runId: runtimeParams.activeRunId,
        projectId: runtimeParams.project.id,
        sessionId: runtimeParams.context.activeSessionId,
        ...trigger
      },
      {
        project: runtimeParams.project,
        permissionContext: {
          permission: runtimeParams.permission,
          requestPermission: runtimeParams.requestPermission
        },
        cwd: runtimeParams.context.runtimeEnvironment?.workingDirectory ?? runtimeParams.context.projectPath,
        checkpointSnapshotId: runtimeParams.checkpointSnapshotId,
        abortSignal: runtimeParams.abortSignal,
        emitHook: (hook) => emitRuntimeLifecycleHook(runtimeParams, hook),
        emitStage
      }
    );
  const appendLifecycleHookContext = (contexts: string[]): void => {
    if (contexts.length === 0) {
      return;
    }
    runtimeParams = {
      ...runtimeParams,
      lifecycleHookContext: [...(runtimeParams.lifecycleHookContext ?? []), ...contexts]
    };
  };
  const buildLifecycleHookBlockedResult = (
    eventName: string,
    blockReason: string | undefined,
    stepsSoFar: GameAgentStep[]
  ): GenericAgentRuntimeResult => {
    const blockedReply = ['本轮请求已被生命周期 Hook 阻止。', blockReason ? `原因：${blockReason}` : '']
      .filter(Boolean)
      .join('\n');
    return {
      assistantMessage: blockedReply,
      assistantMetadata: outputCollector.buildMetadata(blockedReply, {
        type: 'fallback',
        text: blockedReply,
        reason: 'lifecycle_hook_blocked'
      }),
      assistantIntent: 'fallback',
      fallbackDetail: blockReason,
      status: 'fallback',
      operationLog: outputCollector.buildOperationLog(),
      usedProviderId: params.provider?.id,
      usedModel: params.provider?.model,
      steps: [
        ...stepsSoFar,
        createStep(
          'fallback',
          '生命周期 Hook 阻止请求',
          blockReason ?? `${eventName} hook blocked the turn.`,
          'completed'
        )
      ]
    };
  };

  const steps: GameAgentStep[] = [
    createStep(
      'context',
      '整理通用工作区上下文',
      `已带入 ${params.context.recentMessages.length} 条近期消息、${params.context.toolContext.plugins.length} 个插件配置。`,
      'completed'
    )
  ];
  emitStage({
    stageId: 'stage:context',
    title: '整理会话上下文',
    target: 'stage:context',
    status: 'completed',
    summary: `已带入 ${params.context.recentMessages.length} 条近期消息、${params.context.toolContext.plugins.length} 个插件配置。`
  });
  if (params.checkpointSnapshotId) {
    emitStage({
      stageId: 'stage:checkpoint',
      title: '建立会话检查点',
      target: 'stage:checkpoint',
      status: 'completed',
      summary: '已建立本轮会话检查点；Native 写入工具会在实际写入前记录文件级 checkpoint。',
      input: {
        checkpointSnapshotId: params.checkpointSnapshotId,
        fileCheckpointTracked: true
      }
    });
  }

  const sessionStartHookResult = await runLifecycleHooks({
    event: 'SessionStart',
    prompt: params.message,
    metadata: {
      runtimeId: 'native',
      providerId: params.provider?.id,
      model: params.provider?.model,
      activeSessionId: params.context.activeSessionId
    }
  });
  if (sessionStartHookResult.results.length > 0) {
    steps.push(
      createStep(
        'context',
        '执行 SessionStart Hooks',
        `已处理 ${sessionStartHookResult.results.length} 个生命周期 Hook。`,
        sessionStartHookResult.blocked ? 'failed' : 'completed'
      )
    );
  }
  appendLifecycleHookContext(sessionStartHookResult.appendedContext);
  if (sessionStartHookResult.blocked) {
    return buildLifecycleHookBlockedResult('SessionStart', sessionStartHookResult.blockReason, steps);
  }

  const promptHookResult = await runLifecycleHooks({
    event: 'UserPromptSubmit',
    prompt: params.message
  });
  if (promptHookResult.results.length > 0) {
    steps.push(
      createStep(
        'context',
        '执行 UserPromptSubmit Hooks',
        `已处理 ${promptHookResult.results.length} 个生命周期 Hook。`,
        promptHookResult.blocked ? 'failed' : 'completed'
      )
    );
  }
  appendLifecycleHookContext(promptHookResult.appendedContext);
  if (promptHookResult.blocked) {
    return buildLifecycleHookBlockedResult('UserPromptSubmit', promptHookResult.blockReason, steps);
  }

  if (!params.provider) {
    const diagnostic = classifyNativeRuntimeError({});
    emitStage({
      stageId: 'stage:provider',
      title: '选择 AI Provider',
      target: 'stage:provider',
      status: 'failed',
      summary: diagnostic.summary,
      errorMessage: diagnostic.code,
      runtimeId: 'native',
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      errorCode: diagnostic.code,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions
    });
    const fallbackReply = createFallbackReply(params, true);
    return {
      assistantMessage: fallbackReply,
      assistantMetadata: outputCollector.buildMetadata(fallbackReply, {
        type: 'fallback',
        text: fallbackReply,
        reason: 'missing_provider'
      }),
      assistantIntent: 'fallback',
      status: 'fallback',
      operationLog: outputCollector.buildOperationLog(),
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions,
      steps: [...steps, createStep('fallback', '未配置 AI Provider', '本轮使用本地 fallback 回复。', 'completed')]
    };
  }

  steps.push(
    createStep('model', '选择 AI Provider', `${params.provider.name} / ${params.provider.model}`, 'completed')
  );
  emitStage({
    stageId: 'stage:provider',
    title: '选择 AI Provider',
    target: 'stage:provider',
    status: 'completed',
    summary: `${params.provider.name} / ${params.provider.model}`,
    runtimeId: 'native',
    providerId: params.provider.id,
    model: params.provider.model,
    upstreamModel: params.provider.upstreamModel,
    input: {
      providerId: params.provider.id,
      protocol: params.provider.protocol,
      model: params.provider.model,
      upstreamModel: params.provider.upstreamModel
    }
  });

  const nativeContextHandoff = await prepareNativeContextHandoffWithModelSummary({
    project: params.project,
    sessionId: nativeContextSessionId,
    provider: params.provider,
    currentPrompt: params.message,
    abortSignal: params.abortSignal
  });
  if (nativeContextHandoff && nativeContextSessionId) {
    const preCompactHooks = await runLifecycleHooks({
      event: 'PreCompact',
      status: 'auto',
      metadata: {
        runtimeId: 'native',
        reason: 'context_budget',
        boundaryRowId: nativeContextHandoff.coverage.boundaryRowId,
        boundaryOrdinal: nativeContextHandoff.coverage.boundaryOrdinal,
        coveredMessageCount:
          nativeContextHandoff.coverage.coveredMessageCount ?? nativeContextHandoff.coverage.messageCount
      }
    });
    if (preCompactHooks.results.length > 0) {
      steps.push(
        createStep(
          'memory',
          '执行 PreCompact Hooks',
          `已处理 ${preCompactHooks.results.length} 个生命周期 Hook。`,
          preCompactHooks.blocked ? 'failed' : 'completed'
        )
      );
    }
    appendLifecycleHookContext(preCompactHooks.appendedContext);
    if (preCompactHooks.blocked) {
      steps.push(
        createStep(
          'memory',
          '跳过 Native runtime 上下文压缩',
          preCompactHooks.blockReason ?? 'PreCompact hook blocked context compression.',
          'skipped'
        )
      );
    } else {
      sessionRuntimePatch = {
        ...sessionRuntimePatch,
        ...nativeContextHandoff.patch
      };
      runtimeParams = {
        ...runtimeParams,
        project: applyNativeContextPatchToProject(
          runtimeParams.project,
          nativeContextSessionId,
          nativeContextHandoff.patch
        )
      };
      emitRuntimeStatus(params, 'thinking', '已压缩 Native runtime 上下文。');
      emitStage({
        stageId: 'stage:native_context_handoff',
        phase: 'context_compressed',
        title: '压缩 Native runtime 上下文',
        target: 'stage:native_context_handoff',
        status: 'completed',
        summary: '当前会话接近模型上下文预算，已生成摘要并保留未覆盖的近期消息。',
        runtimeId: 'native',
        providerId: params.provider.id,
        model: params.provider.model,
        input: {
          contextSummary: nativeContextHandoff.summary,
          contextSummaryCoverage: nativeContextHandoff.coverage,
          boundaryRowId: nativeContextHandoff.coverage.boundaryRowId,
          boundaryOrdinal: nativeContextHandoff.coverage.boundaryOrdinal,
          coveredMessageCount:
            nativeContextHandoff.coverage.coveredMessageCount ?? nativeContextHandoff.coverage.messageCount,
          turnCount: nativeContextHandoff.coverage.turnCount
        }
      });
      steps.push(
        createStep('memory', '压缩 Native runtime 上下文', '已生成摘要并更新 Native 上下文边界。', 'completed')
      );
    }
  }

  try {
    emitStage({
      stageId: 'stage:permission',
      title: '校验工具权限',
      target: 'stage:permission',
      status: 'running',
      summary: '正在判断本轮是否涉及写入权限。'
    });
    const writePermission = await resolveWritePermission(params, toolPolicy);
    if (writePermission === 'deny') {
      const diagnostic = classifyNativeRuntimeError({
        error: new Error('write_permission_denied'),
        provider: params.provider
      });
      emitStage({
        stageId: 'stage:permission',
        title: '校验工具权限',
        target: 'stage:permission',
        status: 'failed',
        summary: '检测到写入意图，但当前会话未获得写入权限。',
        errorMessage: 'write_permission_denied',
        runtimeId: 'native',
        providerId: params.provider.id,
        model: params.provider.model,
        upstreamModel: params.provider.upstreamModel,
        diagnosticCode: diagnostic.code,
        severity: diagnostic.severity,
        errorCode: diagnostic.code,
        suggestedAction: diagnostic.suggestedAction,
        recoveryActions: diagnostic.recoveryActions,
        input: {
          toolPolicy: formatToolPolicyForStage(toolPolicy)
        }
      });
      const deniedReply = createPermissionDeniedReply();
      emitRuntimeStatus(params, 'thinking', '当前等待写入权限，已回退为建议模式。');
      return {
        assistantMessage: deniedReply,
        assistantMetadata: outputCollector.buildMetadata(deniedReply, {
          type: 'fallback',
          text: deniedReply,
          reason: 'write_permission_denied'
        }),
        assistantIntent: 'fallback',
        status: 'fallback',
        operationLog: outputCollector.buildOperationLog(),
        usedProviderId: params.provider.id,
        usedModel: params.provider.model,
        diagnosticCode: diagnostic.code,
        severity: diagnostic.severity,
        suggestedAction: diagnostic.suggestedAction,
        recoveryActions: diagnostic.recoveryActions,
        sessionRuntimePatch,
        steps: [
          ...steps,
          createStep('fallback', '未获得写入权限', '本轮检测到写入意图，已回退为只读建议模式。', 'completed')
        ]
      };
    }
    emitStage({
      stageId: 'stage:permission',
      title: '校验工具权限',
      target: 'stage:permission',
      status: 'completed',
      summary:
        params.permission.mode === 'read-only' && toolPolicy.requiresWorkspaceWritePermission
          ? 'Plan 模式检测到写入请求；Native 主链继续运行，但不会开放项目写入工具，实际工具权限在执行点处理。'
          : writePermission === 'not_needed'
            ? '本轮策略未检测到 workspace 写入意图。'
            : writePermission === 'allow_session'
              ? '本轮复用了当前会话的写入授权。'
              : '本轮允许执行写入工具。',
      input: {
        toolPolicy: formatToolPolicyForStage(toolPolicy)
      }
    });
    const canApplyWorkspaceWrites = isWritePermissionAllowed(writePermission);

    const sessionAfterHandoff = nativeContextSessionId
      ? ensureProjectSessions(runtimeParams.project).sessions.find((item) => item.id === nativeContextSessionId)
      : undefined;
    const workspaceObservationSignature = computeNativeWorkspaceObservationSignature(
      runtimeParams,
      nativeContextHandoff?.coverage ?? sessionAfterHandoff?.runtimeOverrides?.nativeContextSummaryCoverage
    );
    const runWorkspaceObservation = shouldRunNativeWorkspaceObservation(
      nativeContextSessionId,
      workspaceObservationSignature
    );

    const loopState = await runGenericAgentLoop({
      initialState: {
        accumulated: '',
        workspaceEvidence: {
          directorySummaries: [] as Array<{
            path: string;
            summary: string;
          }>,
          searchResults: [] as Array<{
            path: string;
            excerpts: string[];
          }>,
          filesRead: [] as Array<{
            path: string;
            content: string;
            truncated?: boolean;
          }>,
          fileTreeSummary: undefined as string | undefined
        },
        usedNativeToolLoop: false,
        streamedReply: false,
        toolLoopFinalSummary: ''
      },
      abortSignal: params.abortSignal,
      steps: [
        {
          id: 'observe_workspace',
          run: async (state) => {
            if (!runWorkspaceObservation) {
              emitStage({
                stageId: 'stage:workspace_observation',
                title: '整理工作区观察',
                target: 'stage:workspace_observation',
                status: 'completed',
                summary: '工作区上下文未变化，已复用上一轮观测快照。',
                input: {
                  reused: true
                }
              });
              return state;
            }
            emitStage({
              stageId: 'stage:workspace_observation',
              title: '整理工作区观察',
              target: 'stage:workspace_observation',
              status: 'running',
              summary: '正在生成当前项目的工作区摘要。'
            });
            emitRuntimeStatus(params, 'thinking', '正在整理会话上下文…');
            const thinkingPrelude = buildNativeRuntimeThinkingPrelude(params);
            emitThinking(thinkingPrelude, thinkingPrelude);
            const summaryToolUseId = makeId('tool');
            emitToolUse({
              toolUseId: summaryToolUseId,
              name: 'inspect_workspace_context',
              input: {
                projectName: params.context.projectName,
                projectPath: params.context.projectPath,
                pluginCount: params.context.toolContext.plugins.length
              },
              status: 'running'
            });

            const pluginProbeSummary = buildNativeRuntimePluginProbeSummary(params);
            const projectContextIndexSummary = formatProjectContextIndexSummary(params.context.projectContextIndex);
            const workspaceObservationSummary = [
              projectContextIndexSummary ? `Project context index:\n${projectContextIndexSummary}` : '',
              pluginProbeSummary.trim() ? `Plugin summary:\n${pluginProbeSummary}` : ''
            ]
              .filter(Boolean)
              .join('\n\n');
            if (workspaceObservationSummary.trim()) {
              emitToolResult({
                toolUseId: summaryToolUseId,
                content: workspaceObservationSummary
              });
            }
            emitToolUse({
              toolUseId: summaryToolUseId,
              name: 'inspect_workspace_context',
              input: {
                projectName: params.context.projectName,
                projectPath: params.context.projectPath,
                pluginCount: params.context.toolContext.plugins.length
              },
              status: 'completed'
            });
            emitStage({
              stageId: 'stage:workspace_observation',
              title: '整理工作区观察',
              target: 'stage:workspace_observation',
              status: 'completed',
              summary: workspaceObservationSummary.trim() ? '已写入工作区索引与插件摘要。' : '已写入工作区摘要。'
            });

            return state;
          }
        },
        {
          id: 'observe_plugins',
          run: async (state) => {
            if (!runWorkspaceObservation) {
              emitStage({
                stageId: 'stage:plugin_observation',
                title: '采集插件观测',
                target: 'stage:plugin_observation',
                status: 'completed',
                summary: '插件集合未变化，已复用上一轮观测快照。',
                input: {
                  reused: true
                }
              });
              return state;
            }
            emitStage({
              stageId: 'stage:plugin_observation',
              title: '采集插件观测',
              target: 'stage:plugin_observation',
              status: 'running',
              summary: '正在读取已启用插件的观测结果。'
            });
            try {
              await emitRealPluginObservations({
                ...runtimeParams,
                onToolUse: emitToolUse,
                onToolResult: emitToolResult
              });
              emitStage({
                stageId: 'stage:plugin_observation',
                title: '采集插件观测',
                target: 'stage:plugin_observation',
                status: 'completed',
                summary: '已完成所有可观测插件的结果采集。'
              });
              recordNativeWorkspaceObservation(nativeContextSessionId, workspaceObservationSignature);
            } catch (error) {
              emitStage({
                stageId: 'stage:plugin_observation',
                title: '采集插件观测',
                target: 'stage:plugin_observation',
                status: 'failed',
                summary: error instanceof Error ? error.message : '插件观测采集失败。',
                errorMessage: error instanceof Error ? error.message : 'plugin_observation_failed'
              });
              throw error;
            }
            return state;
          }
        },
        {
          id: 'model_driven_workspace_loop',
          run: async (state) => {
            const toolLoopStrategy = getNativeToolLoopStrategy(params);
            const useNativeToolLoop = toolLoopStrategy.useNativeToolLoop;
            emitStage({
              stageId: 'stage:tool_loop_strategy',
              title: '选择工具循环策略',
              target: 'stage:tool_loop_strategy',
              status: 'completed',
              summary: toolLoopStrategy.summary,
              input: {
                reason: toolLoopStrategy.reason,
                sessionMode: params.context.sessionMode,
                providerProtocol: params.provider?.protocol,
                openAiCompatibleApiMode:
                  params.provider?.protocol === 'openai-compatible'
                    ? inferOpenAiCompatibleApiMode(params.provider)
                    : undefined,
                openAiCompatibleToolCallingVerified: isOpenAiCompatibleNativeStreamingToolCallsEnabled(params.provider),
                nativeToolCallingEnabled: isNativeReadOnlyToolLoopEnabled()
              }
            });
            emitStage({
              stageId: 'stage:tool_loop',
              title: '执行 Agent 工具循环',
              target: 'stage:tool_loop',
              status: 'running',
              summary: '正在执行模型驱动的多步工具循环。'
            });
            let reply = '';
            let usedNativeToolLoopForStep = false;
            let streamedReplyForStep = false;
            let toolLoopFinalSummary = '';
            try {
              if (useNativeToolLoop) {
                const exposeWriteToolBucket = shouldExposeNativeWriteToolBucket(
                  params,
                  canApplyWorkspaceWrites,
                  toolPolicy
                );
                const exposeCommandTools = shouldExposeNativeCommandTools(params, toolPolicy);
                const exposeMcpTools = shouldExposeNativeMcpTools(params, canApplyWorkspaceWrites, toolPolicy);
                const allowedToolFamilies = resolveNativeAllowedToolFamilies(
                  params,
                  canApplyWorkspaceWrites,
                  toolPolicy
                );
                usedNativeToolLoopForStep = true;
                const commonToolLoopOptions = {
                  emitToolUse,
                  emitToolResult,
                  emitThinking,
                  emitStage,
                  includeWriteTools: isNativeWriteToolLoopEnabled() && exposeWriteToolBucket,
                  includeMcpToolCalls: isNativeMcpToolLoopEnabled() && exposeMcpTools,
                  includeCommandTools: isNativeCommandToolLoopEnabled() && exposeCommandTools,
                  allowedToolFamilies
                };
                const toolLoopResult =
                  params.provider?.protocol === 'openai-compatible'
                    ? await runOpenAiCompatibleNativeToolLoop(runtimeParams, commonToolLoopOptions)
                    : await runNativeReadOnlyToolLoop(runtimeParams, commonToolLoopOptions);
                reply = toolLoopResult.assistantMessage;
                streamedReplyForStep = Boolean(toolLoopResult.streamedText);
                toolLoopFinalSummary = summarizeToolLoopResult(toolLoopResult) || toolLoopStrategy.summary;
                if (toolLoopResult.agentCoreParts?.length) {
                  outputCollector.onAgentCoreParts(toolLoopResult.agentCoreParts);
                }
                emitStage({
                  stageId: 'stage:tool_loop',
                  title: '执行 Agent 工具循环',
                  target: 'stage:tool_loop',
                  status: 'completed',
                  summary: toolLoopFinalSummary || '工具执行已完成。'
                });
              } else {
                emitStage({
                  stageId: 'stage:direct_reply',
                  title: '普通模型回复',
                  target: 'stage:direct_reply',
                  status: 'running',
                  summary: toolLoopStrategy.summary
                });
                reply = await runNativeDirectChatReply(runtimeParams);
                streamedReplyForStep = true;
                toolLoopFinalSummary = toolLoopStrategy.summary;
                emitStage({
                  stageId: 'stage:tool_loop',
                  title: '执行 Agent 工具循环',
                  target: 'stage:tool_loop',
                  status: 'completed',
                  summary: '未进入工具循环；已使用普通模型回复。'
                });
                emitStage({
                  stageId: 'stage:direct_reply',
                  title: '普通模型回复',
                  target: 'stage:direct_reply',
                  status: 'completed',
                  summary: '已完成普通模型回复。'
                });
              }
            } catch (error) {
              emitStage({
                stageId: 'stage:tool_loop',
                title: '执行 Agent 工具循环',
                target: 'stage:tool_loop',
                status: 'failed',
                summary: error instanceof Error ? error.message : 'Agent 工具循环失败。',
                errorMessage: error instanceof Error ? error.message : 'tool_loop_failed'
              });
              throw error;
            }
            emitRuntimeStatus(params, 'streaming', '正在实时生成回复…');
            if (!streamedReplyForStep) {
              emitReplyAsDeltas(runtimeParams, reply);
            }

            return {
              ...state,
              accumulated: reply,
              usedNativeToolLoop: usedNativeToolLoopForStep,
              streamedReply: streamedReplyForStep,
              toolLoopFinalSummary
            };
          }
        }
      ]
    });

    let activeVerificationEvidence = {
      changedFiles: Array.from(activeVerificationChangedFiles),
      sideEffects: activeVerificationSideEffects
    };
    let activeVerificationPlan = planActiveVerification(
      runtimeParams,
      activeVerificationTrigger,
      activeVerificationEvidence
    );
    let activeVerificationResult: ActiveVerificationRunResult | undefined;
    let repairAttempted = false;
    let repairChangeSummary: ActiveVerificationChangeSummary | undefined;
    if (activeVerificationPlan) {
      activeVerificationResult = await runActiveVerificationGate({
        params: runtimeParams,
        plan: activeVerificationPlan,
        emitStage,
        emitToolUse,
        emitToolResult
      });
      steps.push(
        createStep(
          'planning',
          '执行主动验证',
          activeVerificationResult.summary,
          activeVerificationResult.status === 'passed' ? 'completed' : 'failed'
        )
      );
      if (activeVerificationResult.blocking && activeVerificationResult.status === 'failed') {
        const toolLoopStrategy = getNativeToolLoopStrategy(params);
        const canRepairWithNativeTools =
          toolLoopStrategy.useNativeToolLoop &&
          params.permission.mode !== 'read-only' &&
          isNativeWriteToolLoopEnabled() &&
          shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, toolPolicy);
        if (canRepairWithNativeTools) {
          const repairAllowedToolFamilies = resolveNativeAllowedToolFamilies(
            params,
            canApplyWorkspaceWrites,
            toolPolicy
          );
          repairChangeSummary = await collectActiveVerificationChangeSummary(runtimeParams, activeVerificationEvidence);
          const repairFileEvidence = collectActiveVerificationRepairEvidence(
            runtimeParams,
            activeVerificationResult,
            activeVerificationEvidence
          );
          const repairPrompt = createActiveVerificationRepairPrompt({
            originalUserMessage: params.message,
            previousAssistantMessage: loopState.accumulated.trim(),
            verification: activeVerificationResult,
            relatedFiles: repairFileEvidence,
            changeSummary: repairChangeSummary
          });
          emitStage({
            stageId: 'stage:native_active_verification_repair',
            phase: 'verification_repair',
            title: 'Repair failed verification',
            target: activeVerificationResult.trigger,
            status: 'running',
            summary: '主动验证失败，正在执行一次受控修复回合。',
            input: {
              trigger: activeVerificationResult.trigger,
              diagnosis: activeVerificationResult.diagnosis,
              changeSummary: repairChangeSummary
                ? {
                    source: repairChangeSummary.source,
                    truncated: repairChangeSummary.truncated,
                    length: repairChangeSummary.summary.length
                  }
                : undefined,
              failedChecks: activeVerificationResult.checks
                .filter((check) => check.status === 'failed')
                .map((check) => ({
                  id: check.id,
                  kind: check.kind,
                  command: check.command,
                  target: check.target
                }))
            }
          });
          const repairRuntimeParams: GenericAgentRuntimeParams = {
            ...runtimeParams,
            message: repairPrompt,
            context: {
              ...runtimeParams.context,
              workspaceEvidence: [
                ...(runtimeParams.context.workspaceEvidence ?? []),
                ...repairFileEvidence.map((file) => ({
                  kind: 'verification_failure_file' as const,
                  source: file.source,
                  path: file.path,
                  title: file.line ? `${file.path}:${file.line}` : file.path,
                  excerpt: file.excerpt,
                  truncated: file.truncated
                }))
              ]
            }
          };
          try {
            repairAttempted = true;
            const repairToolLoopResult =
              params.provider?.protocol === 'openai-compatible'
                ? await runOpenAiCompatibleNativeToolLoop(repairRuntimeParams, {
                    emitToolUse,
                    emitToolResult,
                    emitThinking,
                    emitStage,
                    includeWriteTools: true,
                    includeMcpToolCalls:
                      isNativeMcpToolLoopEnabled() &&
                      shouldExposeNativeMcpTools(params, canApplyWorkspaceWrites, toolPolicy),
                    includeCommandTools:
                      isNativeCommandToolLoopEnabled() && shouldExposeNativeCommandTools(params, toolPolicy),
                    allowedToolFamilies: repairAllowedToolFamilies
                  })
                : await runNativeReadOnlyToolLoop(repairRuntimeParams, {
                    emitToolUse,
                    emitToolResult,
                    emitThinking,
                    emitStage,
                    includeWriteTools: true,
                    includeMcpToolCalls:
                      isNativeMcpToolLoopEnabled() &&
                      shouldExposeNativeMcpTools(params, canApplyWorkspaceWrites, toolPolicy),
                    includeCommandTools:
                      isNativeCommandToolLoopEnabled() && shouldExposeNativeCommandTools(params, toolPolicy),
                    allowedToolFamilies: repairAllowedToolFamilies
                  });
            if (repairToolLoopResult.agentCoreParts?.length) {
              outputCollector.onAgentCoreParts(repairToolLoopResult.agentCoreParts);
            }
            if (repairToolLoopResult.assistantMessage.trim()) {
              loopState.accumulated = repairToolLoopResult.assistantMessage.trim();
            }
            loopState.usedNativeToolLoop = true;
            loopState.toolLoopFinalSummary =
              summarizeToolLoopResult(repairToolLoopResult) || '主动验证修复回合已完成。';
            emitStage({
              stageId: 'stage:native_active_verification_repair',
              phase: 'verification_repair',
              title: 'Repair failed verification',
              target: activeVerificationResult.trigger,
              status: 'completed',
              summary: loopState.toolLoopFinalSummary
            });
            activeVerificationEvidence = {
              changedFiles: Array.from(activeVerificationChangedFiles),
              sideEffects: activeVerificationSideEffects
            };
            const previousActiveVerificationPlan = activeVerificationPlan;
            const nextActiveVerificationPlan =
              planActiveVerification(runtimeParams, activeVerificationTrigger, activeVerificationEvidence) ??
              previousActiveVerificationPlan;
            const planChanged =
              activeVerificationPlanSignature(previousActiveVerificationPlan) !==
              activeVerificationPlanSignature(nextActiveVerificationPlan);
            activeVerificationPlan = nextActiveVerificationPlan;
            emitStage({
              stageId: 'stage:native_active_verification_replan',
              phase: 'verification',
              title: 'Replan active verification',
              target: activeVerificationPlan.trigger,
              status: 'completed',
              summary: planChanged
                ? `主动验证已根据修复后的 ${activeVerificationEvidence.changedFiles.length} 个变更文件重新规划。`
                : '主动验证计划在修复后保持不变。',
              input: {
                trigger: activeVerificationPlan.trigger,
                changedFiles: activeVerificationEvidence.changedFiles,
                plannedChecks: activeVerificationPlan.checks,
                omittedChecks: activeVerificationPlan.omittedChecks,
                previousPlannedChecks: previousActiveVerificationPlan.checks,
                previousOmittedChecks: previousActiveVerificationPlan.omittedChecks
              }
            });
            const repairedVerificationResult = await runActiveVerificationGate({
              params: runtimeParams,
              plan: activeVerificationPlan,
              emitStage,
              emitToolUse,
              emitToolResult
            });
            activeVerificationResult = repairedVerificationResult;
            steps.push(
              createStep(
                'planning',
                '执行主动验证修复',
                repairedVerificationResult.summary,
                repairedVerificationResult.status === 'passed' ? 'completed' : 'failed'
              )
            );
            if (!repairedVerificationResult.blocking || repairedVerificationResult.status !== 'failed') {
              steps.push(createStep('planning', '主动验证修复通过', repairedVerificationResult.summary, 'completed'));
            }
          } catch (error) {
            emitStage({
              stageId: 'stage:native_active_verification_repair',
              phase: 'verification_repair',
              title: 'Repair failed verification',
              target: activeVerificationResult.trigger,
              status: 'failed',
              summary: error instanceof Error ? error.message : '主动验证修复回合失败。',
              errorMessage: error instanceof Error ? error.message : 'active_verification_repair_failed'
            });
          }
        }
      }
      if (activeVerificationResult.blocking && activeVerificationResult.status === 'failed') {
        repairChangeSummary ??= await collectActiveVerificationChangeSummary(runtimeParams, activeVerificationEvidence);
        const rollbackAvailable = Boolean(runtimeParams.checkpointSnapshotId);
        emitStage({
          stageId: 'stage:native_active_verification_handoff',
          phase: 'verification_handoff',
          title: 'Verification handoff',
          target: activeVerificationResult.trigger,
          status: 'failed',
          summary: activeVerificationResult.diagnosis
            ? `${activeVerificationResult.diagnosis.kind}: ${activeVerificationResult.diagnosis.suggestedFocus}`
            : activeVerificationResult.summary,
          input: {
            trigger: activeVerificationResult.trigger,
            repairAttempted,
            diagnosis: activeVerificationResult.diagnosis,
            omittedChecks: activeVerificationResult.omittedChecks,
            rollbackAvailable,
            changeSummary: repairChangeSummary
              ? {
                  source: repairChangeSummary.source,
                  truncated: repairChangeSummary.truncated,
                  length: repairChangeSummary.summary.length
                }
              : undefined
          }
        });
        const verificationReply = formatActiveVerificationFailureReply(
          loopState.accumulated.trim(),
          activeVerificationResult,
          {
            repairAttempted,
            changeSummary: repairChangeSummary,
            rollbackAvailable
          }
        );
        return {
          assistantMessage: verificationReply,
          assistantMetadata: outputCollector.buildMetadata(verificationReply, {
            type: 'fallback',
            text: verificationReply,
            reason: 'active_verification_failed'
          }),
          assistantIntent: 'fallback',
          fallbackDetail: activeVerificationResult.summary,
          status: 'failed',
          operationLog: outputCollector.buildOperationLog(),
          usedProviderId: params.provider.id,
          usedModel: params.provider.model,
          sessionRuntimePatch,
          steps: [...steps, createStep('fallback', '主动验证未通过', activeVerificationResult.summary, 'failed')]
        };
      }
    }

    const stopHookResult = await runLifecycleHooks({
      event: 'Stop',
      status: 'completed',
      metadata: {
        replyLength: loopState.accumulated.trim().length,
        activeVerificationStatus: activeVerificationResult?.status
      }
    });
    if (stopHookResult.results.length > 0) {
      steps.push(
        createStep(
          'context',
          '执行 Stop Hooks',
          `已处理 ${stopHookResult.results.length} 个生命周期 Hook。`,
          stopHookResult.blocked ? 'failed' : 'completed'
        )
      );
    }

    return {
      assistantMessage: loopState.accumulated.trim(),
      assistantMetadata: outputCollector.buildMetadata(loopState.accumulated.trim(), {
        type: 'text',
        text: loopState.accumulated.trim()
      }),
      assistantIntent: 'chat',
      status: 'completed',
      operationLog: outputCollector.buildOperationLog(),
      usedProviderId: params.provider.id,
      usedModel: params.provider.model,
      sessionRuntimePatch,
      steps: [
        ...steps,
        createStep(
          'planning',
          loopState.usedNativeToolLoop ? '执行工具步骤' : '模型驱动多步工具循环',
          loopState.usedNativeToolLoop
            ? loopState.toolLoopFinalSummary || getNativeToolLoopStrategy(params).summary
            : loopState.toolLoopFinalSummary || '本轮未进入工具循环，已使用普通模型回复。',
          'completed'
        ),
        createStep('planning', '生成通用会话回复', '已完成本轮通用 Agent 回复。', 'completed')
      ]
    };
  } catch (error) {
    if (params.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }

    const fallbackDetail = extractNativeRuntimeErrorDetail(error, params.provider);
    const diagnostic = classifyNativeRuntimeError({
      error,
      provider: params.provider,
      detail: fallbackDetail
    });
    if (
      diagnostic.code === 'native_context_too_long' &&
      !params.nativeContextRetryAttempted &&
      !sideEffectToolExecuted &&
      params.context.activeSessionId
    ) {
      const forcedHandoff = prepareNativeContextHandoff({
        project: params.project,
        sessionId: params.context.activeSessionId,
        provider: params.provider,
        currentPrompt: params.message,
        force: true
      });
      if (forcedHandoff) {
        const preCompactHooks = await runLifecycleHooks({
          event: 'PreCompact',
          status: 'forced',
          metadata: {
            runtimeId: 'native',
            reason: 'context_retry',
            boundaryRowId: forcedHandoff.coverage.boundaryRowId,
            boundaryOrdinal: forcedHandoff.coverage.boundaryOrdinal,
            coveredMessageCount: forcedHandoff.coverage.coveredMessageCount ?? forcedHandoff.coverage.messageCount
          }
        });
        if (preCompactHooks.results.length > 0) {
          steps.push(
            createStep(
              'memory',
              '执行 PreCompact Hooks',
              `已处理 ${preCompactHooks.results.length} 个生命周期 Hook。`,
              preCompactHooks.blocked ? 'failed' : 'completed'
            )
          );
        }
        appendLifecycleHookContext(preCompactHooks.appendedContext);
        if (preCompactHooks.blocked) {
          steps.push(
            createStep(
              'memory',
              '跳过 Native runtime 上下文压缩',
              preCompactHooks.blockReason ?? 'PreCompact hook blocked forced context compression.',
              'skipped'
            )
          );
        } else {
          const patchedProject = applyNativeContextPatchToProject(
            params.project,
            params.context.activeSessionId,
            forcedHandoff.patch
          );
          emitStage({
            stageId: 'stage:native_context_retry',
            phase: 'context_compressed',
            title: '压缩 Native runtime 上下文后重试',
            target: 'stage:native_context_retry',
            status: 'completed',
            summary: '模型报告上下文过长，已强制压缩历史并重试一次。',
            runtimeId: 'native',
            providerId: params.provider.id,
            model: params.provider.model,
            upstreamModel: params.provider.upstreamModel,
            diagnosticCode: diagnostic.code,
            severity: diagnostic.severity,
            errorCode: diagnostic.code,
            suggestedAction: diagnostic.suggestedAction,
            recoveryActions: diagnostic.recoveryActions,
            input: {
              contextSummary: forcedHandoff.summary,
              contextSummaryCoverage: forcedHandoff.coverage,
              boundaryRowId: forcedHandoff.coverage.boundaryRowId,
              boundaryOrdinal: forcedHandoff.coverage.boundaryOrdinal,
              coveredMessageCount: forcedHandoff.coverage.coveredMessageCount ?? forcedHandoff.coverage.messageCount
            }
          });
          const retryResult = await runNativeConversationTurn({
            ...params,
            project: patchedProject,
            nativeContextRetryAttempted: true
          });
          return {
            ...retryResult,
            sessionRuntimePatch: {
              ...forcedHandoff.patch,
              ...retryResult.sessionRuntimePatch
            },
            steps: [
              ...steps,
              createStep(
                'memory',
                '压缩 Native runtime 上下文后重试',
                '模型报告上下文过长，已强制压缩历史并重试一次。',
                'completed'
              ),
              ...retryResult.steps
            ]
          };
        }
      }
    }
    emitStage({
      stageId: 'stage:runtime_fallback',
      title: '生成本地回退建议',
      target: 'stage:runtime_fallback',
      status: 'failed',
      summary: summarizeNativeRuntimeDiagnostic(diagnostic),
      errorMessage: fallbackDetail,
      runtimeId: 'native',
      providerId: params.provider.id,
      model: params.provider.model,
      upstreamModel: params.provider.upstreamModel,
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      errorCode: diagnostic.code,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions
    });
    const fallbackReply = createFallbackReply(params, false, summarizeNativeRuntimeDiagnostic(diagnostic));
    return {
      assistantMessage: fallbackReply,
      fallbackDetail,
      assistantMetadata: outputCollector.buildMetadata(fallbackReply, {
        type: 'fallback',
        text: fallbackReply,
        reason: fallbackDetail
      }),
      assistantIntent: 'fallback',
      status: 'fallback',
      operationLog: outputCollector.buildOperationLog(),
      usedProviderId: params.provider.id,
      usedModel: params.provider.model,
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions,
      sessionRuntimePatch,
      steps: [...steps, createStep('fallback', 'AI 回复失败，回退本地建议', fallbackDetail, 'failed')]
    };
  }
}
