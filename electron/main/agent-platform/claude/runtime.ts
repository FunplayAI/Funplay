import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  Query as ClaudeAgentSdkQuery,
  SDKMessage,
  SDKResultMessage,
  SDKToolProgressMessage
} from '@anthropic-ai/claude-agent-sdk';
import { createAgentCoreRuntimeBridge } from '../../agent-core/index';
import {
  type ClaudeContextSummaryCoverage,
  type ChatMessage,
  type ChatMediaBlock,
  type GameAgentStep,
  type ProjectSession
} from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import type { ConversationOperationStageEvent } from '../operation-log';
import { createConversationRuntimeOutputCollector } from '../runtime-output';
import {
  createGenericAgentRuntimeEventQueue,
  drainGenericAgentRuntimeEventQueue
} from '../runtime-event-stream';
import { createClaudeStreamCollector, resolveClaudeCollectorFinalText } from './stream-collector';
import {
  createClaudeContentProviderEventObserver,
  createClaudeProviderEventAdapter
} from './provider-event-adapter';
import { createClaudeRuntimeLifecycle } from './runtime-lifecycle';
import {
  createClaudeCodeSdkOptions,
  createClaudeSdkPermissionHandler,
  describeClaudeWriteMode,
  resolveClaudeMcpProfile,
  resolveWritePermission
} from './runtime-sdk-options';
import {
  disposeClaudeRuntimeProcesses,
  interruptClaudeRuntimeProcess
} from './runtime-process-control';
import {
  captureClaudeExternalWriteAuditBaseline,
  emitClaudeExternalWriteAudit,
  type ClaudeExternalWriteAuditBaseline
} from './runtime-external-write-audit';
import { createClaudePostToolUseHookQueue } from './runtime-post-tool-hooks';
import { createGenericAgentRuntimeCapabilities } from '../runtime-capabilities';
import { normalizeClaudeSdkUsage } from '../usage';
import { formatToolPolicyForStage, resolveAgentToolPolicy } from '../tool-policy';
import type {
  GenericAgentRuntime,
  GenericAgentRuntimeParams,
  GenericAgentRuntimeResult,
  GenericAgentRuntimeOutputEvent
} from '../types';
import { claudeResultEventToAgentCoreProviderStepResult } from '../provider-step-adapter';
import { resolveClaudeCodeProvider } from './runtime-provider';
import type {
  ClaudeRuntimeState,
  ClaudeContentBlock,
  ClaudeAssistantEvent,
  ClaudeUserEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeToolProgressEvent,
  ClaudeResultEvent,
  ClaudeSdkSubprocessEnv,
  ClaudeRuntimeErrorCode,
  ClaudeRuntimeDiagnostic
} from './types';
import {
  activeProcesses,
  activeSdkQueries,
  CLAUDE_TOOL_TIMEOUT_SECONDS
} from './constants';

export type * from './types';
export * from './external-write-audit';
import {
  ensureClaudeCliInstalled,
  buildPermissionDeniedReply
} from './external-write-audit';

import {
  ClaudeResumeFailedError,
  resolveClaudeCodeExecutable,
  shouldSpawnClaudeCommandWithShell
} from './executable-resolver';

export * from './executable-resolver';

export * from './context-summary';
import { prepareClaudeContextHandoff } from './context-summary';

export * from './prompt-builder';
import {
  createUserPrompt,
  createClaudeSdkPrompt
} from './prompt-builder';

export * from './env-builder';
export {
  createClaudeCodeSdkOptions,
  createClaudeSdkPermissionHandler,
  resolveClaudeMcpProfile,
  sanitizeClaudeToolInput
} from './runtime-sdk-options';
export {
  isClaudeSideRuntimeModel,
  resolveClaudeCodeProvider
} from './runtime-provider';
export {
  testClaudeCodeSdkProviderRuntime
} from './runtime-provider-probe';
import {
  resolveClaudeCliModel,
  resolveClaudeCodeResumeSession,
  shouldForceLegacyClaudeCli,
  prepareClaudeCodeSdkSubprocessEnv,
  buildClaudeCodeCliEnv,
  createClaudeCodeCliArgs
} from './env-builder';

function createStep(kind: GameAgentStep['kind'], title: string, detail: string, status: GameAgentStep['status']): GameAgentStep {
  return {
    id: makeId('step'),
    kind,
    title,
    detail,
    status
  };
}

function emitClaudeUsage(params: GenericAgentRuntimeParams, event?: ClaudeResultEvent): void {
  const usage = normalizeClaudeSdkUsage(event?.usage as Parameters<typeof normalizeClaudeSdkUsage>[0], {
    provider: params.provider?.id,
    model: resolveClaudeCliModel(params.provider) || params.provider?.model
  });
  if (usage) {
    params.onUsage?.(usage);
  }
}

export function createClaudeRuntimeState(): ClaudeRuntimeState {
  return {
    text: '',
    thinking: '',
    seenAssistantEvents: new Set<string>(),
    seenToolUses: new Set<string>(),
    seenToolResults: new Set<string>(),
    toolNamesByUseId: new Map<string, string>()
  };
}

import {
  sdkResultToClaudeResultEvent,
  shouldRetryAsFreshClaudeSession,
  isContextTooLongError,
  redactClaudeRuntimeErrorDetail,
  classifyClaudeRuntimeError,
  normalizeToolInput,
  extractToolResultForCollector
} from './stream-events';

export * from './stream-events';

export const claudeCodeSdkRuntime: GenericAgentRuntime = {
  id: 'claude-code-sdk',
  displayName: 'Claude Code Runtime',
  description: 'Claude Agent SDK runtime with Claude Code tools, MCP, permissions, and resumable project sessions.',
  capabilities: createGenericAgentRuntimeCapabilities({
    conversation: true,
    toolLoop: true,
    workspaceWrite: true,
    mcpTools: true,
    sessionPermission: true,
    checkpoint: true,
    toolCheckpoint: false,
    resume: true,
    externalProcess: true,
    hostControlledWrites: false,
    contextHandoff: true,
    externalWriteAudit: true,
    externalWriteRollback: true,
    intentBoundMcp: true,
    exactlyOnceStream: true,
    liveE2EGated: true
  }),
  isAvailable: () => !shouldForceLegacyClaudeCli() || ensureClaudeCliInstalled(),
  interrupt(runIdOrSessionId: string) {
    interruptClaudeRuntimeProcess(runIdOrSessionId);
  },
  dispose() {
    disposeClaudeRuntimeProcesses();
  },
  async *executeEventStream(params) {
    const queue = createGenericAgentRuntimeEventQueue();
    const runtimeParams: GenericAgentRuntimeParams = {
      ...params,
      emitRuntimeEvent: (event: GenericAgentRuntimeOutputEvent) => queue.push(event),
      onStatus: undefined,
      onTextDelta: undefined,
      onThinkingDelta: undefined,
      onToolUse: undefined,
      onToolResult: undefined,
      onStage: undefined,
      onPermissionRequest: (request: Parameters<NonNullable<GenericAgentRuntimeParams['onPermissionRequest']>>[0]) => queue.push({ type: 'permission_request', request }),
      onUserInputRequest: (request: Parameters<NonNullable<GenericAgentRuntimeParams['onUserInputRequest']>>[0]) => queue.push({ type: 'user_input_request', request }),
      onUsage: undefined,
      onAgentCoreParts: (parts: Parameters<NonNullable<GenericAgentRuntimeParams['onAgentCoreParts']>>[0]) => queue.push({ type: 'agent_core_parts', parts }),
      onLifecycleHook: (hook: Parameters<NonNullable<GenericAgentRuntimeParams['onLifecycleHook']>>[0]) => queue.push({ type: 'lifecycle_hook', hook })
    };
    void (async (params: GenericAgentRuntimeParams): Promise<GenericAgentRuntimeResult> => {
    const outputCollector = createConversationRuntimeOutputCollector(params);
    const sessionKey = params.context.activeSessionId ?? makeId('claude_session');
    const steps: GameAgentStep[] = [
      createStep(
        'context',
        '切换 Claude Code runtime',
        `当前项目会话 ${sessionKey} 已切换到 Claude Code CLI 执行链路。`,
        'completed'
      )
    ];
    const emitThinking = (delta: string, accumulated: string): void => {
      outputCollector.onThinking(delta, accumulated);
    };
    const emitStage = (stage: ConversationOperationStageEvent): void => {
      outputCollector.onStage(stage);
    };
    const controllerBridge = createAgentCoreRuntimeBridge({
      callbacks: {
        emitStage: (stage) => emitStage({
          ...stage,
          runtimeId: 'claude-code-sdk',
          providerId: params.provider?.id,
          model: params.provider?.model
        } as ConversationOperationStageEvent)
      },
      guardTransitions: true,
      initialState: 'initializing',
      runId: params.activeRunId,
      stageId: 'stage:claude_agent_core_v2',
      turnId: params.turnId
    });
    const {
      submitEvent,
      emitCoreStateStage,
      getRunControllerSnapshot
    } = controllerBridge;
    const claudeProviderEvents = createClaudeProviderEventAdapter({
      outputCollector,
      submitEvent,
      emitCoreStateStage,
      getRunControllerSnapshot
    });
    const {
      emitProviderEvent,
      emitToolUse,
      emitToolResult,
      emitContextLoading,
      emitProviderInputReady,
      emitContextCompaction,
      emitToolExecutionStarted,
      emitToolResultsRecorded,
      emitProviderStreaming,
      emitRunCompleted,
      emitRunFailed,
      publishFinalAgentCoreParts,
      buildFinalMetadata
    } = claudeProviderEvents;
    // Assigned below once cwd is resolved; the getCwd closure handed to the
    // lifecycle must capture this binding before that assignment, so const
    // (declaration === initialization) is not possible here.
    // eslint-disable-next-line prefer-const
    let claudeRuntimeCwd: string | undefined;
    const claudeLifecycle = createClaudeRuntimeLifecycle({
      params,
      getCwd: () => claudeRuntimeCwd,
      emitStage
    });
    const appendLifecycleHookContext = claudeLifecycle.appendContext;
    const runClaudeLifecycleHooks = claudeLifecycle.runHooks;
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
        assistantMetadata: buildFinalMetadata(blockedReply, {
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
          createStep('fallback', '生命周期 Hook 阻止请求', blockReason ?? `${eventName} hook blocked the turn.`, 'completed')
        ]
      };
    };
    const claudeContentEvents = createClaudeContentProviderEventObserver(claudeProviderEvents);
    emitContextLoading('Claude runtime 正在加载上下文。');
    emitCoreStateStage('running', 'Claude runtime 已接入 Agent Core v2 状态机。');
    emitStage({
      stageId: 'stage:context',
      title: '切换 Claude 会话上下文',
      target: 'stage:context',
      status: 'completed',
      summary: `当前项目会话 ${sessionKey} 已切换到 Claude Code CLI 执行链路。`
    });
    if (params.checkpointSnapshotId) {
      emitStage({
        stageId: 'stage:checkpoint',
        title: '建立会话检查点',
        target: 'stage:checkpoint',
        status: 'completed',
        summary: '已建立本轮会话检查点；Claude CLI 外部写入不经过 Funplay 文件写入工具，文件级 checkpoint 不保证完整覆盖。',
        input: {
          checkpointSnapshotId: params.checkpointSnapshotId,
          fileCheckpointTracked: false
        }
      });
    }

    const sessionStartHookResult = await runClaudeLifecycleHooks({
      event: 'SessionStart',
      prompt: params.message,
      metadata: {
        runtimeId: 'claude-code-sdk',
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

    const promptHookResult = await runClaudeLifecycleHooks({
      event: 'UserPromptSubmit',
      prompt: params.message,
      metadata: {
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        activeSessionId: params.context.activeSessionId
      }
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

    const forceLegacyCli = shouldForceLegacyClaudeCli();
    if (forceLegacyCli && !ensureClaudeCliInstalled()) {
      emitStage({
        stageId: 'stage:claude_cli',
        title: '检查 Claude CLI',
        target: 'stage:claude_cli',
        status: 'failed',
        summary: '本机未检测到可用的 `claude` 命令。',
        errorMessage: 'claude_cli_missing',
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        errorCode: 'claude_cli_missing',
        suggestedAction: '安装 Claude Code CLI，或通过 FUNPLAY_CLAUDE_CODE_CLI_PATH 指向可执行文件。',
        recoveryActions: [
          { label: '安装 Claude Code CLI', url: 'https://docs.anthropic.com/claude-code/setup' },
          { label: '指定 CLI 路径', command: 'FUNPLAY_CLAUDE_CODE_CLI_PATH=/absolute/path/to/claude' }
        ]
      });
      const fallbackReply = 'Claude Code CLI 不可用。请先在本机安装并确保 `claude` 命令在 PATH 中，再切回这个 runtime。';
      emitRunFailed('Claude CLI 不可用。');
      return {
        assistantMessage: fallbackReply,
        assistantMetadata: buildFinalMetadata(fallbackReply, {
          type: 'fallback',
          text: fallbackReply,
          reason: 'claude_cli_missing'
        }),
        assistantIntent: 'fallback',
        fallbackDetail: 'claude_cli_missing',
        status: 'fallback',
        operationLog: outputCollector.buildOperationLog(),
        usedProviderId: params.provider?.id,
        usedModel: params.provider?.model,
        steps: [
          ...steps,
          createStep('fallback', 'Claude Code CLI 不可用', '缺少本地 `claude` 命令或命令不可执行。', 'completed')
        ]
      };
    }

    emitStage({
      stageId: 'stage:claude_cli',
      title: forceLegacyCli ? '检查 Claude CLI' : '检查 Claude Agent SDK',
      target: 'stage:claude_cli',
      status: 'completed',
      summary: forceLegacyCli ? '已检测到本机 Claude Code CLI。' : 'Claude Agent SDK 已作为主执行链路。'
    });
    emitStage({
      stageId: 'stage:permission',
      title: '校验 Claude 工具权限',
      target: 'stage:permission',
      status: 'running',
      summary: '正在判断 Claude Code runtime 是否允许写入工具。'
    });
    const toolPolicy = resolveAgentToolPolicy(params);
    const writePermission = await resolveWritePermission(params, toolPolicy);
    if (writePermission === 'deny') {
      emitStage({
        stageId: 'stage:permission',
        title: '校验 Claude 工具权限',
        target: 'stage:permission',
        status: 'failed',
        summary: '检测到写入意图，但 Claude Code runtime 未获得写入权限。',
        errorMessage: 'write_permission_denied',
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        errorCode: 'claude_permission_rejected',
        suggestedAction: '允许本次写入工具请求，或把当前会话权限切到可写后重试。',
        input: {
          toolPolicy: formatToolPolicyForStage(toolPolicy)
        }
      });
      params.onStatus?.('thinking', '当前等待写入权限，Claude Code runtime 已回退为建议模式。');
      const deniedReply = buildPermissionDeniedReply();
      emitRunFailed('Claude runtime 未获得写入权限。');
      return {
        assistantMessage: deniedReply,
        assistantMetadata: buildFinalMetadata(deniedReply, {
          type: 'fallback',
          text: deniedReply,
          reason: 'write_permission_denied'
        }),
        assistantIntent: 'fallback',
        fallbackDetail: 'write_permission_denied',
        status: 'fallback',
        operationLog: outputCollector.buildOperationLog(),
        usedProviderId: params.provider?.id,
        usedModel: params.provider?.model,
        steps: [
          ...steps,
          createStep('fallback', '未获得写入权限', 'Claude Code runtime 已回退为只读建议模式。', 'completed')
        ]
      };
    }

    const allowWriteTools = writePermission === 'allow';
    const effectiveMcpProfile = resolveClaudeMcpProfile(params, {
      allowWriteTools,
      supportsHostControlledWrites: !forceLegacyCli
    });
    const effectiveCapabilities = {
      claudeWriteMode: effectiveMcpProfile.writeMode,
      hostControlledWrites: effectiveMcpProfile.writeMode === 'host-controlled',
      externalWriteAudit: allowWriteTools,
      externalWriteRollback: allowWriteTools && effectiveMcpProfile.writeMode === 'external-audited',
      toolCheckpoint: effectiveMcpProfile.writeMode === 'host-controlled'
    };
    let claudeRuntimePatch: Partial<NonNullable<ProjectSession['runtimeOverrides']>> | undefined;
    const buildRuntimeDiagnosticFallback = (diagnostic: ClaudeRuntimeDiagnostic, rawDetail?: string): GenericAgentRuntimeResult => {
      const redactedDetail = rawDetail ? redactClaudeRuntimeErrorDetail(rawDetail, params.provider) : undefined;
      const fallbackReply = [
        diagnostic.summary,
        diagnostic.suggestedAction ? `建议：${diagnostic.suggestedAction}` : '',
        redactedDetail ? `\n原始错误：${redactedDetail.slice(0, 1600)}` : ''
      ].filter(Boolean).join('\n');
      emitStage({
        stageId: 'stage:runtime_fallback',
        title: 'Claude runtime 回退',
        target: 'stage:runtime_fallback',
        status: 'failed',
        summary: diagnostic.summary,
        errorMessage: redactedDetail || diagnostic.code,
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        errorCode: diagnostic.code,
        suggestedAction: diagnostic.suggestedAction,
        recoveryActions: diagnostic.recoveryActions,
        input: {
          errorCode: diagnostic.code,
          suggestedAction: diagnostic.suggestedAction,
          recoveryActions: diagnostic.recoveryActions,
          providerId: params.provider?.id,
          providerProtocol: params.provider?.protocol,
          model: params.provider?.model
        }
      });
      return {
        assistantMessage: fallbackReply,
        assistantMetadata: buildFinalMetadata(fallbackReply, {
          type: 'fallback',
          text: fallbackReply,
          reason: diagnostic.code
        }),
        assistantIntent: 'fallback',
        fallbackDetail: [diagnostic.code, diagnostic.suggestedAction, redactedDetail].filter(Boolean).join('\n'),
        status: 'fallback',
        operationLog: outputCollector.buildOperationLog(),
        usedProviderId: params.provider?.id,
        usedModel: params.provider?.model,
        effectiveCapabilities,
        sessionRuntimePatch: claudeRuntimePatch && Object.keys(claudeRuntimePatch).length ? claudeRuntimePatch : undefined,
        steps: [
          ...steps,
          createStep('fallback', 'Claude Code runtime 返回错误', diagnostic.summary, 'completed')
        ]
      };
    };
    emitStage({
      stageId: 'stage:permission',
      title: '校验 Claude 工具权限',
      target: 'stage:permission',
      status: 'completed',
      summary:
        writePermission === 'not_needed'
          ? '本轮策略未检测到 workspace 写入意图。'
          : '本轮允许 Claude Code runtime 执行写入工具。',
      input: {
        toolPolicy: formatToolPolicyForStage(toolPolicy)
      }
    });
    emitStage({
      stageId: 'stage:claude_write_mode',
      title: 'Claude 写入模式',
      target: 'stage:claude_write_mode',
      status: 'completed',
      summary: describeClaudeWriteMode({
        allowWriteTools,
        writeMode: effectiveMcpProfile.writeMode,
        forceLegacyCli
      }),
      runtimeId: 'claude-code-sdk',
      providerId: params.provider?.id,
      model: params.provider?.model,
      input: {
        writeMode: effectiveMcpProfile.writeMode,
        allowWriteTools,
        forceLegacyCli,
        hostControlledWrites: effectiveCapabilities.hostControlledWrites,
        externalWriteAudit: effectiveCapabilities.externalWriteAudit,
        externalWriteRollback: effectiveCapabilities.externalWriteRollback,
        toolCheckpoint: effectiveCapabilities.toolCheckpoint,
        diagnosticReason: effectiveMcpProfile.diagnosticReason,
        toolPolicy: formatToolPolicyForStage(toolPolicy)
      }
    });
    const cwd = params.context.runtimeEnvironment?.workingDirectory?.trim() || params.context.projectPath?.trim() || process.cwd();
    claudeRuntimeCwd = cwd;
    let resumeSessionId = resolveClaudeCodeResumeSession(params, cwd);
    let claudeContextSummaryOverride: string | undefined;
    let claudeContextSummaryCoverageOverride: ClaudeContextSummaryCoverage | undefined;
    const initialContextHandoff = await prepareClaudeContextHandoff(params, cwd, resumeSessionId, {
      promptCharCount: createUserPrompt(params, { includeRecentTurns: true }).length
    });
    if (initialContextHandoff) {
      const preCompactHooks = await runClaudeLifecycleHooks({
        event: 'PreCompact',
        status: 'auto',
        metadata: {
          runtimeId: 'claude-code-sdk',
          reason: 'context_budget',
          summarizedTurnCount: initialContextHandoff.patch.claudeContextSummaryTurnCount,
          previousResumeSessionId: resolveClaudeCodeResumeSession(params, cwd)
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
        steps.push(createStep('memory', '跳过 Claude runtime 上下文压缩', preCompactHooks.blockReason ?? 'PreCompact hook blocked context compression.', 'skipped'));
      } else {
        emitContextCompaction('Claude runtime 上下文接近预算，正在生成 handoff summary。');
        resumeSessionId = undefined;
        claudeContextSummaryOverride = initialContextHandoff.summary;
        claudeContextSummaryCoverageOverride = initialContextHandoff.patch.claudeContextSummaryCoverage;
        claudeRuntimePatch = initialContextHandoff.patch;
        emitStage({
          stageId: 'stage:claude_context_handoff',
          phase: 'context_compressed',
          title: '压缩 Claude runtime 上下文',
          target: 'stage:claude_context_handoff',
          status: 'completed',
          summary: '已将较早会话整理为摘要，本轮断开旧 Claude resume 并用摘要加最近消息启动新会话。',
          input: {
            contextSummary: initialContextHandoff.summary,
            contextSummaryCoverage: initialContextHandoff.patch.claudeContextSummaryCoverage,
            summarizedTurnCount: initialContextHandoff.patch.claudeContextSummaryTurnCount,
            previousResumeSessionId: resolveClaudeCodeResumeSession(params, cwd)
          }
        });
      }
    }
    const cliEnv = buildClaudeCodeCliEnv(params.provider);
    const streamCollector = createClaudeStreamCollector({
      onTextDelta: outputCollector.onTextDelta,
      onThinkingDelta: (delta, accumulated) => emitThinking(delta, accumulated),
      onToolUse: emitToolUse,
      onToolResult: emitToolResult,
      normalizeToolInput,
      extractToolResult: (block) => extractToolResultForCollector(block as ClaudeContentBlock)
    });
    const state = streamCollector.state;
    const postToolUseHooks = createClaudePostToolUseHookQueue({
      params,
      state,
      cwd,
      emitStage
    });
    let finalEvent: ClaudeResultEvent | undefined;
    let systemSessionId: string | undefined;
    let stderrBuffer = '';
    let externalWriteAuditBaseline: ClaudeExternalWriteAuditBaseline | undefined;
    if (allowWriteTools) {
      externalWriteAuditBaseline = await captureClaudeExternalWriteAuditBaseline(params);
    }

    params.onStatus?.('thinking', 'Claude Code runtime 正在整理项目上下文…');
    steps.push(
      createStep(
        'model',
        forceLegacyCli ? '启动 Claude Code CLI' : '启动 Claude Agent SDK',
        `${resolveClaudeCliModel(params.provider) || 'CLI 默认 Claude 模型'} / ${allowWriteTools ? '可写' : '只读'} 权限${resumeSessionId ? ' / 续接 CLI 会话' : ''}`,
        'completed'
      )
    );
    emitStage({
      stageId: 'stage:provider',
      title: '选择 Claude 模型与权限模式',
      target: 'stage:provider',
      status: 'completed',
      summary: `${resolveClaudeCliModel(params.provider) || 'CLI 默认 Claude 模型'} / ${allowWriteTools ? '可写' : '只读'} 权限${resumeSessionId ? ' / 续接 CLI 会话' : ''}`,
      input: {
        providerId: params.provider?.id,
        providerProtocol: params.provider?.protocol,
        model: params.provider?.model,
        claudeModel: resolveClaudeCliModel(params.provider),
        upstreamModel: resolveClaudeCodeProvider(params.provider).upstreamModel,
        authStyle: resolveClaudeCodeProvider(params.provider).authStyle,
        providerEnvInjected: Boolean(params.provider),
        allowWriteTools,
        resumeSessionId
      }
    });

    const runClaudeSdkAttempt = async (attemptResumeSessionId?: string): Promise<void> => {
      emitProviderStreaming(attemptResumeSessionId ? 'Claude SDK 正在续接会话。' : 'Claude SDK 正在启动新会话。');
      emitStage({
        stageId: 'stage:claude_sdk_stream',
        title: '执行 Claude Agent SDK 会话',
        target: 'stage:claude_sdk_stream',
        status: 'running',
        summary: attemptResumeSessionId
          ? '正在通过 Claude Agent SDK 续接会话并消费流式事件。'
          : '正在通过 Claude Agent SDK 启动新会话并消费流式事件。'
      });

      const sdkAbortController = new AbortController();
      const abortHandler = (): void => {
        emitStage({
          stageId: 'stage:claude_sdk_stream',
          title: '执行 Claude Agent SDK 会话',
          target: 'stage:claude_sdk_stream',
          status: 'failed',
          summary: '正在中断 Claude Agent SDK 查询。',
          errorMessage: 'AbortError'
        });
        sdkAbortController.abort();
        activeSdkQueries.get(sessionKey)?.close();
      };
      params.abortSignal?.addEventListener('abort', abortHandler, { once: true });
      let sdkEnvSetup: ClaudeSdkSubprocessEnv | undefined;

      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        sdkEnvSetup = prepareClaudeCodeSdkSubprocessEnv(params.provider);
        const sdkOptions = createClaudeCodeSdkOptions(params, allowWriteTools, {
          cwd,
          abortController: sdkAbortController,
          resumeSessionId: attemptResumeSessionId,
          env: sdkEnvSetup.env,
          canUseTool: createClaudeSdkPermissionHandler(params),
          stderr: (data) => {
            stderrBuffer = [stderrBuffer, data].filter(Boolean).join('\n');
          }
        });

        const sdkPrompt = createClaudeSdkPrompt(params, {
          includeRecentTurns: !attemptResumeSessionId,
          claudeContextSummaryOverride,
          claudeContextSummaryCoverageOverride
        });
        if (sdkPrompt.imageCount > 0 || sdkPrompt.degradedCount > 0 || sdkPrompt.droppedImageCount > 0) {
          emitStage({
            stageId: 'stage:claude_attachment_vision',
            title: '处理 Claude 图片附件',
            target: 'stage:claude_attachment_vision',
            status: 'completed',
            summary: `已发送 ${sdkPrompt.imageCount} 个图片 vision block，${sdkPrompt.degradedCount} 个附件降级为路径引用，${sdkPrompt.droppedImageCount} 个图片因预算被丢弃。`,
            input: {
              imageCount: sdkPrompt.imageCount,
              degradedCount: sdkPrompt.degradedCount,
              droppedImageCount: sdkPrompt.droppedImageCount,
              totalMediaBytes: sdkPrompt.totalMediaBytes,
              degradeReasons: sdkPrompt.degradeReasons
            }
          });
        }

        let conversation = query({
          prompt: sdkPrompt.prompt,
          options: sdkOptions
        });
        const controlQuery = conversation;
        activeSdkQueries.set(sessionKey, controlQuery);

        if (attemptResumeSessionId) {
          try {
            const iterator = conversation[Symbol.asyncIterator]();
            const first = await iterator.next();
            conversation = (async function* (): AsyncGenerator<SDKMessage, void> {
              if (!first.done) {
                yield first.value;
              }
              while (true) {
                const next = await iterator.next();
                if (next.done) {
                  break;
                }
                yield next.value;
              }
            })() as ClaudeAgentSdkQuery;
          } catch (error) {
            if (shouldRetryAsFreshClaudeSession(error)) {
              throw new ClaudeResumeFailedError(error instanceof Error ? error.message : String(error));
            }
            throw error;
          }
        }

        for await (const message of conversation as AsyncIterable<SDKMessage>) {
          if (params.abortSignal?.aborted || sdkAbortController.signal.aborted) {
            break;
          }

          if (message.type === 'assistant') {
            const assistantEvent = message as unknown as ClaudeAssistantEvent;
            claudeContentEvents.observeAssistantContent(assistantEvent.message?.content);
            streamCollector.applyAssistantEvent(assistantEvent);
            await postToolUseHooks.queueForContent(assistantEvent.message?.content, 'sdk_assistant');
            continue;
          }

          if (message.type === 'user') {
            const userEvent = message as unknown as ClaudeUserEvent;
            claudeContentEvents.observeUserContent(userEvent.message?.content);
            streamCollector.applyUserEvent(userEvent);
            await postToolUseHooks.queueForContent(userEvent.message?.content, 'sdk_user');
            continue;
          }

          if (message.type === 'stream_event') {
            emitProviderStreaming('Claude SDK 正在消费 stream_event。');
            streamCollector.applyStreamEvent(message as unknown as ClaudeStreamEvent);
            continue;
          }

          if (message.type === 'result') {
            finalEvent = sdkResultToClaudeResultEvent(message as SDKResultMessage);
            emitProviderEvent({
              type: 'provider_step_recorded',
              providerStep: claudeResultEventToAgentCoreProviderStepResult(finalEvent, {
                providerId: params.provider?.id,
                model: resolveClaudeCliModel(params.provider) || params.provider?.model
              })
            });
            streamCollector.applyResultEvent(finalEvent);
            continue;
          }

          if (message.type === 'tool_progress') {
            const progressEvent = message as SDKToolProgressMessage;
            emitToolExecutionStarted(`Claude 工具执行中：${progressEvent.tool_name ?? progressEvent.tool_use_id ?? 'unknown'}。`);
            const elapsedSeconds =
              typeof progressEvent.elapsed_time_seconds === 'number'
                ? Math.round(progressEvent.elapsed_time_seconds)
                : undefined;
            emitStage({
              stageId: `stage:claude_tool_progress:${progressEvent.tool_use_id ?? progressEvent.tool_name ?? 'unknown'}`,
              title: 'Claude 工具执行中',
              target: 'stage:claude_tool_progress',
              status: 'running',
              summary: [
                progressEvent.tool_name ? `tool=${progressEvent.tool_name}` : '',
                elapsedSeconds !== undefined ? `elapsed=${elapsedSeconds}s` : ''
              ].filter(Boolean).join('；') || 'Claude 工具正在执行。'
            });
            if (
              Number.isFinite(CLAUDE_TOOL_TIMEOUT_SECONDS) &&
              CLAUDE_TOOL_TIMEOUT_SECONDS > 0 &&
              elapsedSeconds !== undefined &&
              elapsedSeconds >= CLAUDE_TOOL_TIMEOUT_SECONDS
            ) {
              emitStage({
                stageId: `stage:claude_tool_timeout:${progressEvent.tool_use_id ?? progressEvent.tool_name ?? 'unknown'}`,
                phase: 'tool_timeout',
                title: 'Claude 工具执行超时',
                target: 'stage:claude_tool_timeout',
                status: 'failed',
                summary: `Claude 工具执行超过 ${CLAUDE_TOOL_TIMEOUT_SECONDS}s，已中断本轮运行。`,
                input: {
                  toolUseId: progressEvent.tool_use_id,
                  toolName: progressEvent.tool_name,
                  elapsedSeconds
                },
                errorMessage: 'ToolTimeout'
              });
              sdkAbortController.abort();
              activeSdkQueries.get(sessionKey)?.close();
            }
            continue;
          }

          if (message.type === 'rate_limit_event') {
            const rateLimitEvent = message as {
              rate_limit_info?: {
                status?: string;
                resetsAt?: number;
                rateLimitType?: string;
                utilization?: number;
              };
            };
            emitStage({
              stageId: 'stage:claude_rate_limit',
              title: 'Claude 订阅限额状态',
              target: 'stage:claude_rate_limit',
              status: rateLimitEvent.rate_limit_info?.status === 'rejected' ? 'failed' : 'completed',
              summary: rateLimitEvent.rate_limit_info
                ? JSON.stringify(rateLimitEvent.rate_limit_info)
                : 'Claude SDK 返回了限额状态事件。',
              input: rateLimitEvent.rate_limit_info as Record<string, unknown> | undefined
            });
            continue;
          }

          if (message.type === 'auth_status') {
            const authEvent = message as {
              isAuthenticating?: boolean;
              output?: string[];
              error?: string;
            };
            emitStage({
              stageId: 'stage:claude_auth_status',
              title: 'Claude 认证状态',
              target: 'stage:claude_auth_status',
              status: authEvent.error ? 'failed' : authEvent.isAuthenticating ? 'running' : 'completed',
              summary: authEvent.error || authEvent.output?.join('\n') || 'Claude SDK 返回了认证状态事件。',
              errorMessage: authEvent.error
            });
            continue;
          }

          if (message.type === 'tool_use_summary') {
            const summaryEvent = message as { summary?: string };
            emitStage({
              stageId: 'stage:claude_tool_summary',
              title: 'Claude 工具摘要',
              target: 'stage:claude_tool_summary',
              status: 'completed',
              summary: summaryEvent.summary || 'Claude SDK 返回了工具使用摘要。'
            });
            continue;
          }

          if (message.type === 'system') {
            const systemEvent = message as unknown as ClaudeSystemEvent;
            if (systemEvent.subtype === 'init') {
              systemSessionId = systemEvent.session_id ?? systemSessionId;
              emitStage({
                stageId: 'stage:claude_cli_init',
                title: 'Claude SDK 初始化',
                target: 'stage:claude_cli_init',
                status: 'completed',
                summary: [
                  systemEvent.session_id ? `session=${systemEvent.session_id}` : '',
                  systemEvent.model ? `model=${systemEvent.model}` : '',
                  Array.isArray(systemEvent.tools) ? `tools=${systemEvent.tools.length}` : '',
                  Array.isArray(systemEvent.mcp_servers) ? `mcp=${systemEvent.mcp_servers.length}` : ''
                ].filter(Boolean).join('；') || 'Claude SDK 已初始化。',
                input: {
                  sessionId: systemEvent.session_id,
                  model: systemEvent.model,
                  tools: systemEvent.tools,
                  slashCommands: systemEvent.slash_commands,
                  skills: systemEvent.skills,
                  plugins: systemEvent.plugins,
                  mcpServers: systemEvent.mcp_servers,
                  outputStyle: systemEvent.output_style
                }
              });
            } else if (systemEvent.subtype === 'status' && systemEvent.permissionMode) {
              emitStage({
                stageId: 'stage:claude_cli_permission_mode',
                title: 'Claude 权限模式变化',
                target: 'stage:claude_cli_permission_mode',
                status: 'completed',
                summary: `permissionMode=${systemEvent.permissionMode}`,
                input: {
                  permissionMode: systemEvent.permissionMode
                }
              });
            } else if (systemEvent.subtype === 'task_notification') {
              emitStage({
                stageId: `stage:claude_task:${systemEvent.task_id ?? makeId('task')}`,
                title: systemEvent.status === 'completed' ? 'Claude 子任务完成' : 'Claude 子任务通知',
                target: 'stage:claude_task',
                status: systemEvent.status === 'failed' ? 'failed' : 'completed',
                summary: systemEvent.summary || systemEvent.status || 'Claude SDK 子任务状态更新。'
              });
            } else if (systemEvent.subtype === 'task_started' || systemEvent.subtype === 'task_progress' || systemEvent.subtype === 'task_updated') {
              emitStage({
                stageId: `stage:claude_task:${systemEvent.task_id ?? makeId('task')}`,
                title: 'Claude 子任务进度',
                target: 'stage:claude_task',
                status: 'running',
                summary: systemEvent.summary || systemEvent.description || systemEvent.status || 'Claude SDK 子任务正在执行。'
              });
            } else if (systemEvent.subtype === 'api_retry') {
              emitStage({
                stageId: 'stage:claude_api_retry',
                title: 'Claude API 重试',
                target: 'stage:claude_api_retry',
                status: 'running',
                summary: `attempt=${systemEvent.attempt ?? '?'} / ${systemEvent.max_retries ?? '?'}；delay=${systemEvent.retry_delay_ms ?? 0}ms；error=${systemEvent.error ?? 'unknown'}`
              });
            } else if (systemEvent.subtype === 'compact_boundary') {
              emitStage({
                stageId: 'stage:claude_compact_boundary',
                title: 'Claude 上下文压缩边界',
                target: 'stage:claude_compact_boundary',
                status: 'completed',
                summary: 'Claude SDK 返回了上下文压缩边界。',
                input: systemEvent.compact_metadata
              });
            } else if (systemEvent.subtype === 'plugin_install') {
              emitStage({
                stageId: 'stage:claude_plugin_install',
                title: 'Claude 插件安装状态',
                target: 'stage:claude_plugin_install',
                status: systemEvent.status === 'failed' ? 'failed' : 'completed',
                summary: [systemEvent.status, systemEvent.summary, systemEvent.error].filter(Boolean).join('；') || 'Claude SDK 返回了插件安装状态。',
                errorMessage: systemEvent.error
              });
            }
            params.onStatus?.('streaming', 'Claude Code runtime 已连接。');
          }
        }

        await postToolUseHooks.drain();
        emitStage({
          stageId: 'stage:claude_sdk_stream',
          title: '执行 Claude Agent SDK 会话',
          target: 'stage:claude_sdk_stream',
          status: 'completed',
          summary: (finalEvent?.session_id ?? systemSessionId)
            ? `Claude SDK 会话已完成，session=${finalEvent?.session_id ?? systemSessionId}。`
            : 'Claude SDK 会话已完成。'
        });
      } catch (error) {
        if (
          attemptResumeSessionId &&
          !state.text.trim() &&
          state.seenToolUses.size === 0 &&
          shouldRetryAsFreshClaudeSession(error)
        ) {
          throw new ClaudeResumeFailedError(error instanceof Error ? error.message : String(error));
        }

        emitStage({
          stageId: 'stage:claude_sdk_stream',
          title: '执行 Claude Agent SDK 会话',
          target: 'stage:claude_sdk_stream',
          status: 'failed',
          summary: error instanceof Error ? error.message : 'Claude Agent SDK 执行失败。',
          errorMessage: error instanceof Error ? error.message : 'claude_sdk_error'
        });
        throw error;
      } finally {
        activeSdkQueries.delete(sessionKey);
        params.abortSignal?.removeEventListener('abort', abortHandler);
        sdkEnvSetup?.shadow.cleanup();
      }
    };

    const runClaudeCliAttempt = async (attemptResumeSessionId?: string): Promise<void> => {
      emitProviderStreaming(attemptResumeSessionId ? 'Claude CLI 正在续接会话。' : 'Claude CLI 正在启动新会话。');
      emitStage({
        stageId: 'stage:claude_cli_stream',
        title: '执行 Claude CLI 会话',
        target: 'stage:claude_cli_stream',
        status: 'running',
        summary: attemptResumeSessionId
          ? '正在续接 Claude Code CLI 会话并消费流式事件。'
          : '正在启动 Claude Code CLI 并消费流式事件。'
      });

      await new Promise<void>((resolve, reject) => {
      const executable = resolveClaudeCodeExecutable(cliEnv);
      const child = spawn(executable.command, createClaudeCodeCliArgs(params, allowWriteTools, {
        resumeSessionId: attemptResumeSessionId,
        claudeContextSummaryOverride,
        claudeContextSummaryCoverageOverride
      }), {
        cwd,
        env: cliEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shouldSpawnClaudeCommandWithShell(executable.command)
      });
      activeProcesses.set(sessionKey, child);

      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        activeProcesses.delete(sessionKey);
        callback();
      };

      const stdoutReader = createInterface({ input: child.stdout });
      const stderrReader = createInterface({ input: child.stderr });

      stdoutReader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const event = JSON.parse(trimmed) as
            | ClaudeAssistantEvent
            | ClaudeUserEvent
            | ClaudeStreamEvent
            | ClaudeSystemEvent
            | ClaudeToolProgressEvent
            | ClaudeResultEvent
            | { type?: string; [key: string]: unknown };
          if (event.type === 'assistant') {
            const assistantEvent = event as ClaudeAssistantEvent;
            claudeContentEvents.observeAssistantContent(assistantEvent.message?.content);
            streamCollector.applyAssistantEvent(assistantEvent);
            postToolUseHooks.queueForContent(assistantEvent.message?.content, 'cli_assistant');
            return;
          }

          if (event.type === 'user') {
            const userEvent = event as ClaudeUserEvent;
            claudeContentEvents.observeUserContent(userEvent.message?.content);
            streamCollector.applyUserEvent(userEvent);
            postToolUseHooks.queueForContent(userEvent.message?.content, 'cli_user');
            return;
          }

          if (event.type === 'stream_event') {
            emitProviderStreaming('Claude CLI 正在消费 stream_event。');
            streamCollector.applyStreamEvent(event as ClaudeStreamEvent);
            return;
          }

          if (event.type === 'result') {
            finalEvent = event as ClaudeResultEvent;
            emitProviderEvent({
              type: 'provider_step_recorded',
              providerStep: claudeResultEventToAgentCoreProviderStepResult(finalEvent, {
                providerId: params.provider?.id,
                model: resolveClaudeCliModel(params.provider) || params.provider?.model
              })
            });
            streamCollector.applyResultEvent(finalEvent);
            return;
          }

          if (event.type === 'system') {
            const systemEvent = event as ClaudeSystemEvent;
            if (systemEvent.subtype === 'init') {
              systemSessionId = systemEvent.session_id ?? systemSessionId;
              emitStage({
                stageId: 'stage:claude_cli_init',
                title: 'Claude CLI 初始化',
                target: 'stage:claude_cli_init',
                status: 'completed',
                summary: [
                  systemEvent.session_id ? `session=${systemEvent.session_id}` : '',
                  systemEvent.model ? `model=${systemEvent.model}` : '',
                  Array.isArray(systemEvent.tools) ? `tools=${systemEvent.tools.length}` : ''
                ].filter(Boolean).join('；') || 'Claude CLI 已初始化。',
                input: {
                  sessionId: systemEvent.session_id,
                  model: systemEvent.model,
                  tools: systemEvent.tools
                }
              });
            } else if (systemEvent.subtype === 'status' && systemEvent.permissionMode) {
              emitStage({
                stageId: 'stage:claude_cli_permission_mode',
                title: 'Claude 权限模式变化',
                target: 'stage:claude_cli_permission_mode',
                status: 'completed',
                summary: `permissionMode=${systemEvent.permissionMode}`,
                input: {
                  permissionMode: systemEvent.permissionMode
                }
              });
            } else if (systemEvent.subtype === 'task_notification') {
              emitStage({
                stageId: `stage:claude_task:${systemEvent.task_id ?? makeId('task')}`,
                title: systemEvent.status === 'completed' ? 'Claude 子任务完成' : 'Claude 子任务通知',
                target: 'stage:claude_task',
                status: systemEvent.status === 'failed' ? 'failed' : 'completed',
                summary: systemEvent.summary || systemEvent.status || 'Claude CLI 子任务状态更新。'
              });
            }
            params.onStatus?.('streaming', 'Claude Code runtime 已连接。');
            return;
          }

          if (event.type === 'tool_progress') {
            const progressEvent = event as ClaudeToolProgressEvent;
            emitToolExecutionStarted(`Claude 工具执行中：${progressEvent.tool_name ?? progressEvent.tool_use_id ?? 'unknown'}。`);
            const elapsedSeconds =
              typeof progressEvent.elapsed_time_seconds === 'number'
                ? Math.round(progressEvent.elapsed_time_seconds)
                : undefined;
            emitStage({
              stageId: `stage:claude_tool_progress:${progressEvent.tool_use_id ?? progressEvent.tool_name ?? 'unknown'}`,
              title: 'Claude 工具执行中',
              target: 'stage:claude_tool_progress',
              status: 'running',
              summary: [
                progressEvent.tool_name ? `tool=${progressEvent.tool_name}` : '',
                elapsedSeconds !== undefined ? `elapsed=${elapsedSeconds}s` : ''
              ].filter(Boolean).join('；') || 'Claude 工具正在执行。'
            });
            if (
              Number.isFinite(CLAUDE_TOOL_TIMEOUT_SECONDS) &&
              CLAUDE_TOOL_TIMEOUT_SECONDS > 0 &&
              elapsedSeconds !== undefined &&
              elapsedSeconds >= CLAUDE_TOOL_TIMEOUT_SECONDS
            ) {
              emitStage({
                stageId: `stage:claude_tool_timeout:${progressEvent.tool_use_id ?? progressEvent.tool_name ?? 'unknown'}`,
                phase: 'tool_timeout',
                title: 'Claude 工具执行超时',
                target: 'stage:claude_tool_timeout',
                status: 'failed',
                summary: `Claude 工具执行超过 ${CLAUDE_TOOL_TIMEOUT_SECONDS}s，已中断本轮运行。`,
                input: {
                  toolUseId: progressEvent.tool_use_id,
                  toolName: progressEvent.tool_name,
                  elapsedSeconds
                },
                errorMessage: 'ToolTimeout'
              });
              child.kill('SIGTERM');
            }
          }
        } catch {
          // Ignore non-JSON output from Claude CLI.
        }
      });

      stderrReader.on('line', (line) => {
        stderrBuffer = [stderrBuffer, line].filter(Boolean).join('\n');
      });

      child.once('error', (error) => {
        emitStage({
          stageId: 'stage:claude_cli_stream',
          title: '执行 Claude CLI 会话',
          target: 'stage:claude_cli_stream',
          status: 'failed',
          summary: error.message,
          errorMessage: error.message
        });
        settle(() => reject(error));
      });

      child.once('close', (code) => {
        settle(() => {
          void (async () => {
            if (!params.abortSignal?.aborted) {
              await postToolUseHooks.drain();
            }
            if (params.abortSignal?.aborted) {
              const error = new Error('Claude Code runtime was interrupted.');
              error.name = 'AbortError';
              emitStage({
                stageId: 'stage:claude_cli_stream',
                title: '执行 Claude CLI 会话',
                target: 'stage:claude_cli_stream',
                status: 'failed',
                summary: 'Claude Code runtime 已被中断。',
                errorMessage: error.message
              });
              reject(error);
              return;
            }

            if (code !== 0 && !finalEvent) {
              const errorMessage = stderrBuffer.trim() || `Claude Code CLI exited with code ${code ?? 'unknown'}.`;
              if (attemptResumeSessionId) {
                reject(new ClaudeResumeFailedError(errorMessage));
                return;
              }
              emitStage({
                stageId: 'stage:claude_cli_stream',
                title: '执行 Claude CLI 会话',
                target: 'stage:claude_cli_stream',
                status: 'failed',
                summary: errorMessage,
                errorMessage
              });
              reject(new Error(errorMessage));
              return;
            }

            emitStage({
              stageId: 'stage:claude_cli_stream',
              title: '执行 Claude CLI 会话',
              target: 'stage:claude_cli_stream',
              status: 'completed',
              summary: (finalEvent?.session_id ?? systemSessionId)
                ? `Claude CLI 会话已完成，session=${finalEvent?.session_id ?? systemSessionId}。`
                : 'Claude CLI 会话已完成。'
            });
            resolve();
          })().catch(reject);
        });
      });

      params.abortSignal?.addEventListener(
        'abort',
        () => {
          emitStage({
            stageId: 'stage:claude_cli_stream',
            title: '执行 Claude CLI 会话',
            target: 'stage:claude_cli_stream',
            status: 'failed',
            summary: '正在中断 Claude Code CLI 进程。',
            errorMessage: 'AbortError'
          });
          child.kill('SIGTERM');
        },
        { once: true }
      );
    });
    };

    const runClaudeAttempt = forceLegacyCli ? runClaudeCliAttempt : runClaudeSdkAttempt;
    let contextRetryAttempted = false;
    const clearClaudeResumeSessionPatch = (): void => {
      if (!resumeSessionId) {
        return;
      }
      claudeRuntimePatch = {
        ...claudeRuntimePatch,
        claudeCodeSessionId: '',
        claudeCodeSessionCwd: cwd
      };
    };
    const applyForcedClaudeContextHandoff = async (): Promise<Awaited<ReturnType<typeof prepareClaudeContextHandoff>>> => {
      const handoff = await prepareClaudeContextHandoff(params, cwd, resumeSessionId, { force: true });
      if (!handoff) {
        return undefined;
      }
      const preCompactHooks = await runClaudeLifecycleHooks({
        event: 'PreCompact',
        status: 'forced',
        metadata: {
          runtimeId: 'claude-code-sdk',
          reason: 'context_retry',
          summarizedTurnCount: handoff.patch.claudeContextSummaryTurnCount,
          previousResumeSessionId: resumeSessionId
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
        steps.push(createStep('memory', '跳过 Claude runtime 上下文压缩', preCompactHooks.blockReason ?? 'PreCompact hook blocked forced context compression.', 'skipped'));
        return undefined;
      }

      claudeContextSummaryOverride = handoff.summary;
      claudeContextSummaryCoverageOverride = handoff.patch.claudeContextSummaryCoverage;
      claudeRuntimePatch = {
        ...claudeRuntimePatch,
        ...handoff.patch
      };
      return handoff;
    };
    try {
      await runClaudeAttempt(resumeSessionId);
    } catch (error) {
      if (
        error instanceof ClaudeResumeFailedError &&
        resumeSessionId &&
        !state.text.trim() &&
        state.seenToolUses.size === 0 &&
        !params.abortSignal?.aborted
      ) {
        emitStage({
          stageId: 'stage:claude_resume_fallback',
          title: 'Claude 会话续接失败，改为新会话',
          target: 'stage:claude_resume_fallback',
          status: 'completed',
          summary: '已清理本轮过期 resume，使用完整 Funplay 上下文启动新的 Claude CLI 会话。',
          input: {
            failedResumeSessionId: resumeSessionId,
            reason: error.message
          }
        });
        clearClaudeResumeSessionPatch();
        emitProviderEvent({
          type: 'run_interrupted',
          reason: 'Claude resume 会话失效，准备使用新会话重试。'
        });
        emitContextLoading('Claude runtime 正在为 fresh retry 重新加载上下文。');
        emitProviderInputReady('Claude runtime 正在为 fresh retry 构建 provider 输入。');
        finalEvent = undefined;
        stderrBuffer = '';
        try {
          await runClaudeAttempt(undefined);
        } catch (freshError) {
          return buildRuntimeDiagnosticFallback(
            classifyClaudeRuntimeError({
              error: freshError,
              finalEvent,
              stderr: stderrBuffer,
              provider: params.provider
            }),
            freshError instanceof Error ? freshError.message : String(freshError ?? stderrBuffer)
          );
        }
      } else if (!forceLegacyCli && !contextRetryAttempted && isContextTooLongError(error, finalEvent) && !params.abortSignal?.aborted) {
        contextRetryAttempted = true;
        emitContextCompaction('Claude SDK 报告上下文过长，准备压缩后重试。');
        const handoff = await applyForcedClaudeContextHandoff();
        if (!handoff) {
          clearClaudeResumeSessionPatch();
        }
        emitStage({
          stageId: 'stage:claude_context_retry',
          phase: 'context_compressed',
          title: 'Claude 上下文过长，改为新会话重试',
          target: 'stage:claude_context_retry',
          status: 'completed',
          summary: handoff
            ? 'Claude SDK 报告上下文过长，已压缩历史并用摘要重新发起一次。'
            : 'Claude SDK 报告上下文过长，已丢弃本轮 resume 并重新发起一次。',
          input: handoff
            ? {
                contextSummary: handoff.summary,
                contextSummaryCoverage: handoff.patch.claudeContextSummaryCoverage,
                summarizedTurnCount: handoff.patch.claudeContextSummaryTurnCount,
                previousResumeSessionId: resumeSessionId
              }
            : undefined
        });
        finalEvent = undefined;
        stderrBuffer = '';
        emitProviderInputReady('Claude runtime 正在用压缩上下文重试。');
        try {
          await runClaudeAttempt(undefined);
        } catch (retryError) {
          return buildRuntimeDiagnosticFallback(
            classifyClaudeRuntimeError({
              error: retryError,
              finalEvent,
              stderr: stderrBuffer,
              provider: params.provider
            }),
            retryError instanceof Error ? retryError.message : String(retryError ?? stderrBuffer)
          );
        }
      } else {
        clearClaudeResumeSessionPatch();
        const diagnostic = classifyClaudeRuntimeError({
          error,
          finalEvent,
          stderr: stderrBuffer,
          provider: params.provider
        });
        return buildRuntimeDiagnosticFallback(
          diagnostic,
          error instanceof Error ? error.message : String(error ?? stderrBuffer)
        );
      }
    }

    if (
      !forceLegacyCli &&
      !contextRetryAttempted &&
      finalEvent?.is_error &&
      isContextTooLongError(undefined, finalEvent) &&
      !params.abortSignal?.aborted
    ) {
      contextRetryAttempted = true;
      emitContextCompaction('Claude SDK result 报告上下文过长，准备压缩后重试。');
      const handoff = await applyForcedClaudeContextHandoff();
      if (!handoff) {
        clearClaudeResumeSessionPatch();
      }
      emitStage({
        stageId: 'stage:claude_context_retry',
        phase: 'context_compressed',
        title: 'Claude 上下文过长，改为新会话重试',
        target: 'stage:claude_context_retry',
        status: 'completed',
        summary: handoff
          ? 'Claude SDK resume 返回上下文过长，已压缩历史并用摘要重新发起一次。'
          : 'Claude SDK resume 返回上下文过长，已改为新会话重新发起一次。',
        input: handoff
          ? {
              contextSummary: handoff.summary,
              contextSummaryCoverage: handoff.patch.claudeContextSummaryCoverage,
              summarizedTurnCount: handoff.patch.claudeContextSummaryTurnCount,
              previousResumeSessionId: resumeSessionId
            }
          : undefined
      });
      finalEvent = undefined;
      stderrBuffer = '';
      emitProviderInputReady('Claude runtime 正在用压缩上下文重试。');
      try {
        await runClaudeAttempt(undefined);
      } catch (retryError) {
        return buildRuntimeDiagnosticFallback(
          classifyClaudeRuntimeError({
            error: retryError,
            finalEvent,
            stderr: stderrBuffer,
            provider: params.provider
          }),
          retryError instanceof Error ? retryError.message : String(retryError ?? stderrBuffer)
        );
      }
    }

    const resolvedCliSessionId = state.resultSessionId ?? finalEvent?.session_id ?? systemSessionId;
    const finalText = resolveClaudeCollectorFinalText(state) || finalEvent?.result?.trim() || '';
    emitClaudeUsage(params, finalEvent);
    if (allowWriteTools && externalWriteAuditBaseline) {
      await emitClaudeExternalWriteAudit({
        params,
        baseline: externalWriteAuditBaseline,
        emitStage
      });
    }
    if (finalEvent?.is_error) {
      clearClaudeResumeSessionPatch();
      emitRunFailed(finalEvent.result?.trim() || 'Claude runtime 返回错误结果。');
      return buildRuntimeDiagnosticFallback(
        classifyClaudeRuntimeError({
          finalEvent,
          stderr: stderrBuffer,
          provider: params.provider
        }),
        finalEvent.result?.trim() || stderrBuffer.trim()
      );
    }

    if (!finalText) {
      clearClaudeResumeSessionPatch();
      emitRunFailed('Claude Code runtime 没有返回可显示内容。');
      return buildRuntimeDiagnosticFallback(
        classifyClaudeRuntimeError({
          error: new Error('empty_response'),
          stderr: stderrBuffer,
          provider: params.provider
        }),
        stderrBuffer.trim() || 'empty_response'
      );
    }

    const sessionRuntimePatch: Partial<NonNullable<ProjectSession['runtimeOverrides']>> = {
      ...(claudeRuntimePatch ?? {}),
      ...(allowWriteTools ? { claudeWriteMode: effectiveMcpProfile.writeMode } : {}),
      ...(resolvedCliSessionId
        ? {
            claudeCodeSessionId: resolvedCliSessionId,
            claudeCodeSessionCwd: cwd
          }
        : {})
    };
    const stopHookResult = await runClaudeLifecycleHooks({
      event: 'Stop',
      status: 'completed',
      metadata: {
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        replyLength: finalText.length,
        resolvedCliSessionId
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
    emitRunCompleted('Claude runtime 返回最终可见文本。');

    return {
      assistantMessage: finalText,
      assistantMetadata: buildFinalMetadata(finalText, {
        type: 'text',
        text: finalText
      }),
      assistantIntent: 'chat',
      status: 'completed',
      operationLog: outputCollector.buildOperationLog(),
      usedProviderId: params.provider?.id,
      usedModel: params.provider?.model,
      effectiveCapabilities,
      sessionRuntimePatch: Object.keys(sessionRuntimePatch).length ? sessionRuntimePatch : undefined,
      steps: [
        ...steps,
        createStep('model', 'Claude Code runtime 已完成', resolvedCliSessionId ? `CLI session: ${resolvedCliSessionId}` : '已成功返回最终回复。', 'completed')
      ]
    };
    })(runtimeParams)
      .then((result) => {
        queue.push({ type: 'result', result });
        queue.close();
      })
      .catch((error) => {
        queue.fail(error);
        queue.close();
      });
    yield* drainGenericAgentRuntimeEventQueue(queue);
  }
};
