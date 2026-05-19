import type { AiProviderApiMode, ChatContentBlock, GameAgentStep, ProjectSession } from '../../../../shared/types';
import { inferOpenAiCompatibleApiMode } from '../../../../shared/provider-catalog';
import { makeId } from '../../../../shared/utils';
import { runGenericAgentLoop } from '../agent-loop';
import {
  buildNativeRuntimePluginProbeSummary,
  buildNativeRuntimeThinkingPrelude
} from './prompt';
import { runNativeReadOnlyToolLoop, runOpenAiCompatibleNativeToolLoop } from './tool-loop';
import {
  NATIVE_COMMAND_TOOL_NAMES,
  NATIVE_MCP_TOOL_CALL_NAMES,
  NATIVE_WRITE_WORKSPACE_TOOL_NAMES
} from './tool-adapter';
import {
  createConversationOperationLogCollector,
  createConversationProcessTranscriptCollector,
  type ConversationOperationStageEvent
} from '../operation-log';
import { formatProjectContextIndexSummary } from '../context';
import { collectPluginObservations } from '../../game-tool-layer';
import { emitReplyAsDeltas, runNativeDirectChatReply } from './direct-reply';
import type { GenericAgentRuntimeParams, GenericAgentRuntimeResult } from '../types';
import { applyNativeContextPatchToProject, prepareNativeContextHandoff } from './context-handoff';
import {
  classifyNativeRuntimeError,
  extractNativeRuntimeErrorDetail,
  summarizeNativeRuntimeDiagnostic
} from './diagnostics';
import { formatToolPolicyForStage, resolveAgentToolPolicy, type AgentToolPolicyDecision } from '../tool-policy';
import { runAgentLifecycleHooks } from '../agent-hooks';

function createStep(kind: GameAgentStep['kind'], title: string, detail: string, status: GameAgentStep['status']): GameAgentStep {
  return {
    id: makeId('step'),
    kind,
    title,
    detail,
    status
  };
}

function createConversationContentBlockCollector() {
  const eventBlocks: ChatContentBlock[] = [];
  let thinkingContent = '';

  return {
    onThinking(delta: string, accumulated: string): void {
      thinkingContent = accumulated || (thinkingContent + delta);
    },
    onToolUse(tool: {
      toolUseId: string;
      name: string;
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void {
      const existingIndex = eventBlocks.findIndex(
        (block) => block.type === 'tool_use' && block.toolUseId === tool.toolUseId
      );
      const existingBlock =
        existingIndex >= 0 && eventBlocks[existingIndex]?.type === 'tool_use'
          ? eventBlocks[existingIndex]
          : undefined;

      const nextBlock: ChatContentBlock = {
        type: 'tool_use',
        toolUseId: tool.toolUseId,
        name: tool.name,
        input: tool.input ?? existingBlock?.input,
        status: tool.status
      };

      if (existingIndex >= 0) {
        eventBlocks[existingIndex] = nextBlock;
        return;
      }

      eventBlocks.push(nextBlock);
    },
    onToolResult(result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]): void {
      eventBlocks.push({
        type: 'tool_result',
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
        transaction: result.transaction
      });
    },
    buildFinalBlocks(finalBlock: ChatContentBlock): ChatContentBlock[] {
      const blocks: ChatContentBlock[] = [];
      if (thinkingContent.trim()) {
        blocks.push({
          type: 'thinking',
          thinking: thinkingContent
        });
      }
      blocks.push(...eventBlocks);
      blocks.push(finalBlock);
      return blocks;
    }
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
  const observablePlugins = params.plugins.filter((plugin) =>
    plugin.enabled && (plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl?.trim()))
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
        observation.report.resourceReads.length > 0 ? `读取资源：${observation.report.resourceReads.join(', ')}` : '读取资源：无',
        observation.report.toolCalls.length > 0 ? `调用工具：${observation.report.toolCalls.join(', ')}` : '调用工具：无',
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

function createFallbackReply(params: GenericAgentRuntimeParams, providerMissing: boolean, errorMessage?: string): string {
  if (providerMissing) {
    return [
      '当前没有可用的 AI Provider，暂时无法生成模型回复。',
      '',
      '请到“应用设置 / AI Provider”配置并测试模型服务后重试。'
    ].join('\n');
  }

  return [
    '这次 AI Provider 返回了错误，未能生成回复。',
    errorMessage ? `错误信息：${errorMessage}` : '',
    '',
    '请检查 Provider 配置、模型名称或网络连通性后重试。'
  ].filter(Boolean).join('\n');
}

function trimDetail(value: string, maxLength = 4000): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyErrorField(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() ? trimDetail(value) : '<empty>';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return trimDetail(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function readErrorField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null) {
      return record[key];
    }
  }
  return undefined;
}

function extractProviderErrorDetail(error: unknown, provider?: GenericAgentRuntimeParams['provider']): string {
  const lines: string[] = [];
  const errorRecord = isRecord(error) ? error : undefined;
  const causeRecord = errorRecord && isRecord(errorRecord.cause) ? errorRecord.cause : undefined;

  if (provider) {
    lines.push(`Provider: ${provider.name}`);
    lines.push(`Model: ${provider.model}`);
    lines.push(`Protocol: ${provider.protocol}`);
    if (provider.protocol === 'openai-compatible') {
      lines.push(`API Mode: ${inferOpenAiCompatibleApiMode(provider)}`);
    }
  }

  const message =
    (error instanceof Error ? error.message : undefined) ||
    stringifyErrorField(readErrorField(errorRecord ?? {}, ['message', 'error', 'detail'])) ||
    'Unknown error';
  lines.push(`Message: ${message}`);

  const statusCode = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['statusCode', 'status', 'responseStatusCode']) ??
      readErrorField(causeRecord ?? {}, ['statusCode', 'status', 'responseStatusCode'])
  );
  if (statusCode) {
    lines.push(`Status: ${statusCode}`);
  }

  const errorCode = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['code', 'errorCode', 'type']) ??
      readErrorField(causeRecord ?? {}, ['code', 'errorCode', 'type'])
  );
  if (errorCode) {
    lines.push(`Code: ${errorCode}`);
  }

  const requestId = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['requestId']) ??
      readErrorField(causeRecord ?? {}, ['requestId'])
  );
  if (requestId) {
    lines.push(`Request ID: ${requestId}`);
  }

  const requestUrl = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['requestUrl', 'url']) ??
      readErrorField(causeRecord ?? {}, ['requestUrl', 'url'])
  );
  if (requestUrl) {
    lines.push(`Request URL: ${requestUrl}`);
  }

  const requestBody = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['requestBody']) ??
      readErrorField(causeRecord ?? {}, ['requestBody'])
  );
  if (requestBody !== undefined) {
    lines.push('Request Body:');
    lines.push(requestBody);
  }

  const responseBody = stringifyErrorField(
    readErrorField(errorRecord ?? {}, ['responseBody', 'body', 'data', 'responseText']) ??
      readErrorField(causeRecord ?? {}, ['responseBody', 'body', 'data', 'responseText'])
  );
  if (responseBody !== undefined) {
    lines.push('Response Body:');
    lines.push(responseBody);
  }

  const causeMessage = stringifyErrorField(
    readErrorField(causeRecord ?? {}, ['message', 'error', 'detail'])
  );
  if (causeMessage && causeMessage !== message) {
    lines.push(`Cause: ${causeMessage}`);
  }

  return trimDetail(lines.join('\n'), 6000);
}

function summarizeProviderErrorDetail(detail: string): string {
  const messageLine = detail
    .split('\n')
    .find((line) => line.startsWith('Message:'))
    ?.replace(/^Message:\s*/, '')
    .trim();
  return messageLine || detail.split('\n')[0] || 'Unknown error';
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
      summary: 'Native 真实 tool-calling 已被配置关闭；本轮将降级为普通模型回复。'
    };
  }

  if (input.providerProtocol === 'openai-compatible' && input.openAiCompatibleToolCallingVerified === false) {
    const apiMode = input.openAiCompatibleApiMode ? `（${input.openAiCompatibleApiMode}）` : '';
    return {
      useNativeToolLoop: false,
      reason: 'openai_compatible_streaming_tool_calls_disabled',
      summary: `OpenAI-compatible 流式 tool-calling${apiMode}已被显式关闭；本轮将降级为普通模型回复。`
    };
  }

  return {
    useNativeToolLoop: true,
    reason: 'native_tool_calling_selected',
    summary: 'Agent 模式命中 Native 真实 tool-calling 主链；工具能力由权限模式控制。'
  };
}

function isOpenAiCompatibleStreamingToolCallsDisabled(): boolean {
  return process.env.FUNPLAY_OPENAI_COMPAT_NATIVE_TOOLS === 'false';
}

function isOpenAiCompatibleNativeStreamingToolCallsEnabled(provider: GenericAgentRuntimeParams['provider']): boolean | undefined {
  if (!provider || provider.protocol !== 'openai-compatible') {
    return undefined;
  }

  return !isOpenAiCompatibleStreamingToolCallsDisabled();
}

function getNativeToolLoopStrategy(params: GenericAgentRuntimeParams): NativeToolLoopStrategy {
  const openAiCompatibleApiMode =
    params.provider?.protocol === 'openai-compatible'
      ? inferOpenAiCompatibleApiMode(params.provider)
      : undefined;

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
    typeof result.stepCount === 'number' ? `步数：${result.stepCount}` : '',
    result.finishReason ? `finishReason：${result.finishReason}` : '',
    result.toolCalls && result.toolCalls.length > 0 ? `工具：${result.toolCalls.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('；');
}

function shouldExposeNativeWriteTools(params: GenericAgentRuntimeParams, canApplyWorkspaceWrites: boolean, policy: AgentToolPolicyDecision): boolean {
  return (
    (canApplyWorkspaceWrites || params.permission.mode !== 'read-only' || policy.exposesHighRiskTools) &&
    params.permission.mode !== 'read-only'
  );
}

function shouldExposeNativeCommandTools(params: GenericAgentRuntimeParams): boolean {
  return params.permission.mode === 'full-access' || params.permission.mode === 'ask' || params.permission.mode === 'read-only';
}

function shouldExposeNativeMcpTools(params: GenericAgentRuntimeParams, canApplyWorkspaceWrites: boolean, policy: AgentToolPolicyDecision): boolean {
  return shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, policy);
}

function isNativeSideEffectToolName(name: string): boolean {
  return (
    (NATIVE_WRITE_WORKSPACE_TOOL_NAMES as readonly string[]).includes(name) ||
    (NATIVE_MCP_TOOL_CALL_NAMES as readonly string[]).includes(name) ||
    (NATIVE_COMMAND_TOOL_NAMES as readonly string[]).includes(name)
  );
}

export async function runNativeConversationTurn(params: GenericAgentRuntimeParams): Promise<GenericAgentRuntimeResult> {
  const operationLogCollector = createConversationOperationLogCollector();
  const processTranscriptCollector = createConversationProcessTranscriptCollector();
  const contentBlockCollector = createConversationContentBlockCollector();
  const toolPolicy = resolveAgentToolPolicy(params);
  let runtimeParams: GenericAgentRuntimeParams = {
    ...params,
    onTextDelta: (delta, accumulated) => {
      processTranscriptCollector.onTextDelta(delta, accumulated);
      params.onTextDelta?.(delta, accumulated);
    }
  };
  let sessionRuntimePatch: Partial<NonNullable<ProjectSession['runtimeOverrides']>> | undefined;
  let sideEffectToolExecuted = false;
  const emitToolUse = (tool: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }): void => {
    if (tool.status !== 'pending' && isNativeSideEffectToolName(tool.name)) {
      sideEffectToolExecuted = true;
    }
    processTranscriptCollector.onToolUse(tool);
    operationLogCollector.onToolUse(tool);
    contentBlockCollector.onToolUse(tool);
    params.onToolUse?.(tool);
  };
  const emitToolResult = (result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]): void => {
    processTranscriptCollector.onToolResult(result);
    operationLogCollector.onToolResult(result);
    contentBlockCollector.onToolResult(result);
    params.onToolResult?.(result);
  };
  const emitThinking = (delta: string, accumulated: string): void => {
    contentBlockCollector.onThinking(delta, accumulated);
    params.onThinkingDelta?.(delta, accumulated);
  };
  const emitStage = (stage: ConversationOperationStageEvent): void => {
    processTranscriptCollector.onStage(stage);
    operationLogCollector.onStage(stage);
    params.onStage?.({
      stageId: stage.stageId ?? `stage:${stage.target}`,
      phase: stage.phase,
      title: stage.title,
      target: stage.target,
      status: stage.status,
      input: stage.input,
      summary: stage.summary,
      errorMessage: stage.errorMessage,
      runtimeId: stage.runtimeId,
      providerId: stage.providerId,
      model: stage.model,
      upstreamModel: stage.upstreamModel,
      diagnosticCode: stage.diagnosticCode,
      severity: stage.severity,
      errorCode: stage.errorCode,
      suggestedAction: stage.suggestedAction,
      recoveryActions: stage.recoveryActions,
      transaction: stage.transaction
    });
  };
  const runLifecycleHooks = (trigger: Parameters<typeof runAgentLifecycleHooks>[1]) => runAgentLifecycleHooks(
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
      emitHook: runtimeParams.onLifecycleHook,
      emitStage
    }
  );
  const appendLifecycleHookContext = (contexts: string[]): void => {
    if (contexts.length === 0) {
      return;
    }
    runtimeParams = {
      ...runtimeParams,
      lifecycleHookContext: [
        ...(runtimeParams.lifecycleHookContext ?? []),
        ...contexts
      ]
    };
  };
  const buildLifecycleHookBlockedResult = (
    eventName: string,
    blockReason: string | undefined,
    stepsSoFar: GameAgentStep[]
  ): GenericAgentRuntimeResult => {
    const blockedReply = [
      '本轮请求已被生命周期 Hook 阻止。',
      blockReason ? `原因：${blockReason}` : ''
    ].filter(Boolean).join('\n');
    return {
      assistantMessage: blockedReply,
      assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
        type: 'fallback',
        text: blockedReply,
        reason: 'lifecycle_hook_blocked'
      }),
      assistantMetadata: processTranscriptCollector.build(blockedReply),
      assistantIntent: 'fallback',
      fallbackDetail: blockReason,
      status: 'fallback',
      operationLog: operationLogCollector.build(),
      usedProviderId: params.provider?.id,
      usedModel: params.provider?.model,
      steps: [
        ...stepsSoFar,
        createStep('fallback', '生命周期 Hook 阻止请求', blockReason ?? `${eventName} hook blocked the turn.`, 'completed')
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
    steps.push(createStep(
      'context',
      '执行 SessionStart Hooks',
      `已处理 ${sessionStartHookResult.results.length} 个生命周期 Hook。`,
      sessionStartHookResult.blocked ? 'failed' : 'completed'
    ));
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
    steps.push(createStep(
      'context',
      '执行 UserPromptSubmit Hooks',
      `已处理 ${promptHookResult.results.length} 个生命周期 Hook。`,
      promptHookResult.blocked ? 'failed' : 'completed'
    ));
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
      assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
        type: 'fallback',
        text: fallbackReply,
        reason: 'missing_provider'
      }),
      assistantMetadata: processTranscriptCollector.build(fallbackReply),
      assistantIntent: 'fallback',
      status: 'fallback',
      operationLog: operationLogCollector.build(),
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions,
      steps: [
        ...steps,
        createStep('fallback', '未配置 AI Provider', '本轮使用本地 fallback 回复。', 'completed')
      ]
    };
  }

  steps.push(createStep('model', '选择 AI Provider', `${params.provider.name} / ${params.provider.model}`, 'completed'));
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

  const nativeContextSessionId = params.context.activeSessionId;
  const nativeContextHandoff = prepareNativeContextHandoff({
    project: params.project,
    sessionId: nativeContextSessionId,
    provider: params.provider,
    currentPrompt: params.message
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
        coveredMessageCount: nativeContextHandoff.coverage.coveredMessageCount ?? nativeContextHandoff.coverage.messageCount
      }
    });
    if (preCompactHooks.results.length > 0) {
      steps.push(createStep(
        'memory',
        '执行 PreCompact Hooks',
        `已处理 ${preCompactHooks.results.length} 个生命周期 Hook。`,
        preCompactHooks.blocked ? 'failed' : 'completed'
      ));
    }
    appendLifecycleHookContext(preCompactHooks.appendedContext);
    if (preCompactHooks.blocked) {
      steps.push(createStep('memory', '跳过 Native runtime 上下文压缩', preCompactHooks.blockReason ?? 'PreCompact hook blocked context compression.', 'skipped'));
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
      params.onStatus?.('thinking', '已压缩 Native runtime 上下文。');
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
          coveredMessageCount: nativeContextHandoff.coverage.coveredMessageCount ?? nativeContextHandoff.coverage.messageCount,
          turnCount: nativeContextHandoff.coverage.turnCount
        }
      });
      steps.push(createStep('memory', '压缩 Native runtime 上下文', '已生成摘要并更新 Native 上下文边界。', 'completed'));
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
      params.onStatus?.('thinking', '当前等待写入权限，已回退为建议模式。');
      return {
        assistantMessage: deniedReply,
        assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
          type: 'fallback',
          text: deniedReply,
          reason: 'write_permission_denied'
        }),
        assistantMetadata: processTranscriptCollector.build(deniedReply),
        assistantIntent: 'fallback',
        status: 'fallback',
        operationLog: operationLogCollector.build(),
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
            emitStage({
              stageId: 'stage:workspace_observation',
              title: '整理工作区观察',
              target: 'stage:workspace_observation',
              status: 'running',
              summary: '正在生成当前项目的工作区摘要。'
            });
            params.onStatus?.('thinking', '正在整理会话上下文…');
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
            ].filter(Boolean).join('\n\n');
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
                const exposeWriteTools = shouldExposeNativeWriteTools(params, canApplyWorkspaceWrites, toolPolicy);
                const exposeCommandTools = shouldExposeNativeCommandTools(params);
                const exposeMcpTools = shouldExposeNativeMcpTools(params, canApplyWorkspaceWrites, toolPolicy);
                usedNativeToolLoopForStep = true;
                const commonToolLoopOptions = {
                  emitToolUse,
                  emitToolResult,
                  emitThinking,
                  emitStage,
                  includeWriteTools: isNativeWriteToolLoopEnabled() && exposeWriteTools,
                  includeMcpToolCalls: isNativeMcpToolLoopEnabled() && exposeMcpTools,
                  includeCommandTools: isNativeCommandToolLoopEnabled() && exposeCommandTools
                };
                const toolLoopResult =
                  params.provider?.protocol === 'openai-compatible'
                    ? await runOpenAiCompatibleNativeToolLoop(runtimeParams, commonToolLoopOptions)
                    : await runNativeReadOnlyToolLoop(runtimeParams, commonToolLoopOptions);
                reply = toolLoopResult.assistantMessage;
                streamedReplyForStep = Boolean(toolLoopResult.streamedText);
                toolLoopFinalSummary = summarizeToolLoopResult(toolLoopResult) || toolLoopStrategy.summary;
                emitStage({
                  stageId: 'stage:tool_loop',
                  title: '执行 Agent 工具循环',
                  target: 'stage:tool_loop',
                  status: 'completed',
                  summary: toolLoopFinalSummary || 'Native 真实 tool loop 已完成。'
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
            params.onStatus?.('streaming', '正在实时生成回复…');
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

    const stopHookResult = await runLifecycleHooks({
      event: 'Stop',
      status: 'completed',
      metadata: {
        replyLength: loopState.accumulated.trim().length
      }
    });
    if (stopHookResult.results.length > 0) {
      steps.push(createStep(
        'context',
        '执行 Stop Hooks',
        `已处理 ${stopHookResult.results.length} 个生命周期 Hook。`,
        stopHookResult.blocked ? 'failed' : 'completed'
      ));
    }

    return {
      assistantMessage: loopState.accumulated.trim(),
      assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
        type: 'text',
        text: loopState.accumulated.trim()
      }),
      assistantMetadata: processTranscriptCollector.build(loopState.accumulated.trim()),
      assistantIntent: 'chat',
      status: 'completed',
      operationLog: operationLogCollector.build(),
      usedProviderId: params.provider.id,
      usedModel: params.provider.model,
      sessionRuntimePatch,
      steps: [
        ...steps,
        createStep(
          'planning',
          loopState.usedNativeToolLoop ? 'Native 真实 Tool Loop' : '模型驱动多步工具循环',
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
          steps.push(createStep(
            'memory',
            '执行 PreCompact Hooks',
            `已处理 ${preCompactHooks.results.length} 个生命周期 Hook。`,
            preCompactHooks.blocked ? 'failed' : 'completed'
          ));
        }
        appendLifecycleHookContext(preCompactHooks.appendedContext);
        if (preCompactHooks.blocked) {
          steps.push(createStep('memory', '跳过 Native runtime 上下文压缩', preCompactHooks.blockReason ?? 'PreCompact hook blocked forced context compression.', 'skipped'));
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
              createStep('memory', '压缩 Native runtime 上下文后重试', '模型报告上下文过长，已强制压缩历史并重试一次。', 'completed'),
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
      assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
        type: 'fallback',
        text: fallbackReply,
        reason: fallbackDetail
      }),
      assistantMetadata: processTranscriptCollector.build(fallbackReply),
      assistantIntent: 'fallback',
      status: 'fallback',
      operationLog: operationLogCollector.build(),
      usedProviderId: params.provider.id,
      usedModel: params.provider.model,
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      suggestedAction: diagnostic.suggestedAction,
      recoveryActions: diagnostic.recoveryActions,
      sessionRuntimePatch,
      steps: [
        ...steps,
        createStep('fallback', 'AI 回复失败，回退本地建议', fallbackDetail, 'failed')
      ]
    };
  }
}
