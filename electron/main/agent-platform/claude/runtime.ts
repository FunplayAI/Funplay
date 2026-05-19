import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type {
  CanUseTool,
  Options as ClaudeAgentSdkOptions,
  PermissionResult as ClaudeAgentPermissionResult,
  Query as ClaudeAgentSdkQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKToolProgressMessage
} from '@anthropic-ai/claude-agent-sdk';
import { canTransitionAgentCoreState, createAgentCoreStateMachine } from '../../../../shared/agent-core-v2';
import {
  type AgentCoreProviderStepResult,
  type AgentCoreState,
  type AgentUserInputOption,
  type AiProvider,
  type AiProviderRoleModels,
  type ClaudeContextSummaryCoverage,
  type ClaudeRuntimeWriteMode,
  type ChatMessage,
  type ChatContentBlock,
  type ChatMediaBlock,
  type GameAgentStep,
  type ProjectSession,
  type ProjectFileEntry
} from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import { listProjectFilesForProject } from '../../project-file-service';
import {
  createConversationOperationLogCollector,
  createConversationProcessTranscriptCollector,
  type ConversationOperationStageEvent
} from '../operation-log';
import { createClaudeStreamCollector, resolveClaudeCollectorFinalText } from './stream-collector';
import { resolveAgentToolPermission } from '../permission-broker';
import { createGenericAgentRuntimeCapabilities } from '../runtime-capabilities';
import { normalizeClaudeSdkUsage } from '../usage';
import { formatToolPolicyForStage, resolveAgentToolPolicy, type AgentToolPolicyDecision } from '../tool-policy';
import type { GenericAgentRuntime, GenericAgentRuntimeParams, GenericAgentRuntimeResult } from '../types';
import { claudeResultEventToAgentCoreProviderStepResult } from '../provider-step-adapter';
import { createAgentRunController, type AgentRunControllerSnapshot } from '../agent-run-controller';
import { runAgentLifecycleHooks } from '../agent-hooks';
import {
  resolveProviderForClaudeCode
} from '../provider-resolver';
import { sanitizeClaudeModelOptions } from './model-options';
import type {
  ClaudeRuntimePermissionDecision,
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
  ClaudeRuntimeDiagnostic,
  ResolvedClaudeCodeProvider,
  ClaudeSdkProviderProbeResult,
  ClaudeMcpProfile,
  ClaudeAskUserQuestion,
  ExternalWriteBaselineEntry,
  ExternalWriteBaseline
} from './types';
import {
  activeProcesses,
  activeSdkQueries,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_NATIVE_WEB_TOOLS,
  FUNPLAY_MCP_SERVER_TOOL_NAMES,
  FUNPLAY_WORKSPACE_WRITE_SERVER_TOOL_NAMES,
  CLAUDE_TOOL_TIMEOUT_SECONDS,
  getClaudeRuntimeSession
} from './constants';

export type * from './types';
export * from './external-write-audit';
import {
  ensureClaudeCliInstalled,
  buildPermissionDeniedReply,
  mapFileSnapshot,
  diffFileSnapshots,
  captureExternalWriteBaseline,
  recordExternalWriteRollbackCheckpoint
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
  shouldUseClaudeNativeWeb,
  createSystemPrompt,
  createUserPrompt,
  createClaudeSdkPrompt
} from './prompt-builder';

export * from './env-builder';
import {
  getAllowedTools,
  resolveClaudeCliModel,
  resolveClaudeEffort,
  resolveClaudeCodeResumeSession,
  shouldForceLegacyClaudeCli,
  resolveClaudeSdkPermissionMode,
  resolveClaudeSdkSettingSources,
  buildFunplayMcpServers,
  buildClaudeCodeSdkEnv,
  prepareClaudeCodeSdkSubprocessEnv,
  resolveClaudeAgentSdkExecutablePath,
  buildClaudeCodeCliEnv,
  createClaudeCodeCliArgs,
  isRecord
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

      const nextBlock: ChatContentBlock = {
        type: 'tool_use',
        toolUseId: tool.toolUseId,
        name: tool.name,
        input: tool.input,
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

export function isClaudeSideRuntimeModel(provider?: AiProvider): boolean {
  const resolved = resolveProviderForClaudeCode(provider);
  if (!resolved.canUseClaudeCode) {
    return false;
  }
  if (!provider || provider.protocol === 'bedrock' || provider.protocol === 'vertex' || provider.claudeCodeCompatible || provider.sdkProxyOnly) {
    return true;
  }
  const model = (resolved.upstreamModel ?? resolved.model ?? provider.model).trim().toLowerCase();
  if (!model) {
    return true;
  }
  return /(^|[/._:-])(claude|sonnet|opus|haiku)([/._:-]|$)/i.test(model);
}

function normalizeClaudeRoleModels(input?: AiProviderRoleModels): AiProviderRoleModels {
  const normalized: AiProviderRoleModels = {};
  for (const key of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
    const value = input?.[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function resolveClaudeCodeRoleModels(provider?: AiProvider): AiProviderRoleModels {
  const resolved = resolveProviderForClaudeCode(provider);
  const configured = normalizeClaudeRoleModels(resolved.roleModels);
  const defaultModel = configured.default ?? resolved.upstreamModel ?? resolved.model ?? provider?.model.trim();
  if (!defaultModel) {
    return configured;
  }

  return {
    default: defaultModel,
    reasoning: configured.reasoning ?? defaultModel,
    small: configured.small ?? defaultModel,
    haiku: configured.haiku ?? defaultModel,
    sonnet: configured.sonnet ?? defaultModel,
    opus: configured.opus ?? defaultModel
  };
}

export function resolveClaudeCodeProvider(provider?: AiProvider): ResolvedClaudeCodeProvider {
  const resolved = resolveProviderForClaudeCode(provider);
  const roleModels = resolveClaudeCodeRoleModels(provider);
  const model = resolved.upstreamModel ?? roleModels.default ?? resolved.model;
  const injectAnthropicEnv = Boolean(
    provider &&
    resolved.canUseClaudeCode &&
    resolved.authStyle !== 'env_only' &&
    (resolved.protocol === 'anthropic' || resolved.sdkProxyOnly)
  );

  return {
    provider: resolved.provider,
    providerId: resolved.providerId,
    providerName: resolved.providerName,
    protocol: resolved.protocol,
    authStyle: resolved.provider ? resolved.authStyle : 'none',
    hasCredentials: resolved.hasCredentials,
    canUseClaudeCode: resolved.canUseClaudeCode && isClaudeSideRuntimeModel(provider),
    injectAnthropicEnv,
    useShadowHome: resolved.useShadowHome,
    baseUrl: resolved.baseUrl,
    model,
    upstreamModel: resolved.upstreamModel,
    roleModels,
    settingSources: resolved.settingSources,
    sdkProxyOnly: resolved.sdkProxyOnly,
    diagnostic: {
      providerId: resolved.providerId,
      providerName: resolved.providerName,
      protocol: resolved.protocol,
      authStyle: resolved.provider ? resolved.authStyle : 'none',
      baseUrl: resolved.baseUrl,
      model,
      upstreamModel: resolved.upstreamModel,
      hasApiKey: Boolean(provider?.apiKey.trim()),
      claudeCodeCompatible: resolved.canUseClaudeCode,
      sdkProxyOnly: resolved.sdkProxyOnly
    }
  };
}


async function resolveWritePermission(params: GenericAgentRuntimeParams, policy: AgentToolPolicyDecision): Promise<ClaudeRuntimePermissionDecision> {
  if (!policy.requiresWorkspaceWritePermission) {
    return 'not_needed';
  }

  const decision = await resolveAgentToolPermission(
    {
      permission: params.permission,
      requestPermission: params.requestPermission
    },
    {
      tool: {
        name: 'claude_code_external_write',
        title: 'Claude Code External Write Mode',
        risk: 'high',
        readOnly: false,
        permissionPolicy: 'ask',
        checkpointPolicy: 'external_best_effort'
      },
      input: {
        runtimeId: 'claude-code-sdk',
        projectPath: params.context.projectPath,
        model: params.provider?.model,
        toolPolicy: formatToolPolicyForStage(policy)
      },
      title: '允许 Claude Code runtime 执行写入型工具？',
      detail: [
        '工具：claude_code_external_write',
        '权限策略：ask',
        '检查点策略：external_best_effort',
        '本轮会切换到 Claude Code runtime 的写入权限模式，并允许其在当前项目目录中修改文件。',
        'Claude CLI 外部写入不经过 Funplay 文件写入工具，文件级 checkpoint 只能 best-effort。'
      ].join('\n'),
      risk: 'high'
    }
  );

  return decision === 'allow' ? 'allow' : 'deny';
}

function getClaudeWriteMode(params: GenericAgentRuntimeParams, allowWriteTools: boolean, supportsHostControlledWrites: boolean): ClaudeRuntimeWriteMode {
  if (!allowWriteTools) {
    return 'external-audited';
  }

  const configured = getClaudeRuntimeSession(params).runtimeOverrides?.claudeWriteMode;
  if (configured === 'external-audited') {
    return 'external-audited';
  }

  return supportsHostControlledWrites ? 'host-controlled' : 'external-audited';
}

function hasIntent(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function resolveClaudeMcpProfile(params: GenericAgentRuntimeParams, options: {
  allowWriteTools: boolean;
  supportsHostControlledWrites?: boolean;
}): ClaudeMcpProfile {
  const message = `${params.message}\n${params.context.currentGoal ?? ''}`.toLowerCase();
  const skillText = params.context.toolContext.skills.map((skill) => `${skill.name} ${skill.description ?? ''} ${skill.trigger ?? ''}`).join('\n').toLowerCase();
  const combined = `${message}\n${skillText}`;
  const writeMode = getClaudeWriteMode(params, options.allowWriteTools, options.supportsHostControlledWrites ?? true);
  const includeWeb = hasIntent(combined, [
    /https?:\/\//i,
    /\b(web|website|search|fetch|docs?|latest|current|today|news|price|hotel|booking)\b/i,
    /(搜索|联网|网页|官网|最新|今天|实时|新闻|价格|酒店|预订|查询)/i
  ]);
  const includeMemory = hasIntent(combined, [
    /\b(memory|remember|recall|previous|past|decision)\b/i,
    /(记住|记忆|回忆|之前|上次|历史|决定|偏好)/i
  ]);
  const includeMedia = hasIntent(combined, [
    /\b(media|image|audio|video|asset|attachment|ppt|pptx|thumbnail|preview|file)\b/i,
    /(图片|图像|音频|视频|素材|附件|预览|缩略图|幻灯片|演示文稿|文件)/i
  ]);
  const includeImageGeneration = hasIntent(combined, [
    /\b(generate image|image generation|icon|logo|sprite|portrait)\b/i,
    /(生成.*图|图标|logo|立绘|像素|贴图|插画)/i
  ]);
  const includeNotifications = hasIntent(combined, [
    /\b(notify|notification|remind|schedule|alert)\b/i,
    /(通知|提醒|定时|日程|闹钟)/i
  ]);
  const includeWorkspaceWrite = options.allowWriteTools && writeMode === 'host-controlled';
  const builtinAllowedTools = [
    ...(includeWeb ? [
      'funplay_web_search',
      'funplay_web_fetch',
      'mcp__funplay-web__funplay_web_search',
      'mcp__funplay-web__funplay_web_fetch'
    ] : []),
    ...(includeMemory ? [
      'funplay_memory_search',
      'funplay_memory_get',
      'funplay_memory_recent',
      'funplay_memory_remember',
      'mcp__funplay-memory__funplay_memory_search',
      'mcp__funplay-memory__funplay_memory_get',
      'mcp__funplay-memory__funplay_memory_recent',
      'mcp__funplay-memory__funplay_memory_remember'
    ] : []),
    ...(includeMedia ? [
      'funplay_media_attach_file',
      'funplay_media_save_base64',
      'mcp__funplay-media__funplay_media_attach_file',
      'mcp__funplay-media__funplay_media_save_base64'
    ] : []),
    ...(includeImageGeneration ? [
      'funplay_image_generate',
      'mcp__funplay-image-gen__funplay_image_generate'
    ] : []),
    ...(includeNotifications ? [
      'funplay_notify',
      'funplay_schedule_task',
      'funplay_list_tasks',
      'funplay_cancel_task',
      'mcp__funplay-notify__funplay_notify',
      'mcp__funplay-notify__funplay_schedule_task',
      'mcp__funplay-notify__funplay_list_tasks',
      'mcp__funplay-notify__funplay_cancel_task'
    ] : []),
    ...(includeWorkspaceWrite ? [...FUNPLAY_WORKSPACE_WRITE_SERVER_TOOL_NAMES] : [])
  ];

  return {
    includeWeb,
    includeMemory,
    includeMedia,
    includeImageGeneration,
    includeNotifications,
    includeWorkspaceWrite,
    writeMode,
    builtinAllowedTools,
    diagnosticReason: [
      includeWeb ? 'web-intent' : '',
      includeMemory ? 'memory-intent' : '',
      includeMedia ? 'media-intent' : '',
      includeImageGeneration ? 'image-intent' : '',
      includeNotifications ? 'notification-intent' : '',
      includeWorkspaceWrite ? 'host-controlled-write' : `write-mode:${writeMode}`
    ].filter(Boolean).join(', ')
  };
}

function getAutoAllowedSdkTools(allowWriteTools: boolean, includeNativeWebTools: boolean, profile?: ClaudeMcpProfile): string[] {
  const effectiveWriteTools = profile?.includeWorkspaceWrite ? false : allowWriteTools;
  return [
    ...getAllowedTools(effectiveWriteTools, profile?.includeWeb ? includeNativeWebTools : false),
    ...(profile?.builtinAllowedTools ?? FUNPLAY_MCP_SERVER_TOOL_NAMES)
  ];
}

function describeClaudeWriteMode(params: {
  allowWriteTools: boolean;
  writeMode: ClaudeRuntimeWriteMode;
  forceLegacyCli: boolean;
}): string {
  if (!params.allowWriteTools) {
    return '本轮未授予 Claude 写入工具，保持只读执行。';
  }
  if (params.writeMode === 'host-controlled') {
    return 'Claude 写入模式：host-controlled，写文件通过 Funplay MCP 工具执行并获得文件级 checkpoint。';
  }
  return params.forceLegacyCli
    ? 'Claude 写入模式：external-audited，CLI 外部写入仅能进行 best-effort 审计和 rollback checkpoint。'
    : 'Claude 写入模式：external-audited，外部写入会进行 best-effort 审计和 rollback checkpoint。';
}

function isReadOnlyClaudeTool(toolName: string): boolean {
  if (
    /funplay_memory_(search|get|recent)$/.test(toolName) ||
    /funplay_web_(search|fetch)$/.test(toolName) ||
    /funplay_media_(attach_file|save_base64)$/.test(toolName) ||
    /funplay_image_generate$/.test(toolName) ||
    /funplay_list_tasks$/.test(toolName) ||
    /funplay_notify$/.test(toolName) ||
    CLAUDE_NATIVE_WEB_TOOLS.some((tool) => tool === toolName)
  ) {
    return true;
  }
  return CLAUDE_READ_ONLY_TOOLS.some((tool) => tool === toolName);
}

function formatToolInputForPermission(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return '[unserializable tool input]';
  }
}

function isClaudeAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}

function resolveClaudeRuntimeCwd(params: GenericAgentRuntimeParams): string {
  return params.context.runtimeEnvironment?.workingDirectory?.trim() ||
    params.context.projectPath?.trim() ||
    process.cwd();
}

function isGitWorkTree(cwd: string): boolean {
  if (!cwd || !existsSync(cwd)) {
    return false;
  }

  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function shouldUseClaudeAgentWorktreeIsolation(params: GenericAgentRuntimeParams, cwd: string): boolean {
  if (params.context.runtimeEnvironment?.workingDirectory === cwd) {
    return params.context.runtimeEnvironment.isGitRepository === true;
  }

  return isGitWorkTree(cwd);
}

function downgradeClaudeAgentWorktreeIsolationForNonGitProject(
  toolName: string,
  input: Record<string, unknown>,
  params: GenericAgentRuntimeParams,
  toolUseID?: string
): Record<string, unknown> {
  if (!isClaudeAgentTool(toolName) || input.isolation !== 'worktree') {
    return input;
  }

  const cwd = resolveClaudeRuntimeCwd(params);
  if (shouldUseClaudeAgentWorktreeIsolation(params, cwd)) {
    return input;
  }

  const downgradedInput = { ...input };
  delete downgradedInput.isolation;
  params.onStage?.({
    stageId: `stage:claude_agent_worktree_downgrade:${toolUseID || makeId('tool')}`,
    phase: 'permission',
    title: '调整子任务隔离方式',
    target: `claude_code:${toolName}`,
    status: 'completed',
    input: {
      toolName,
      requestedIsolation: 'worktree',
      workingDirectory: cwd
    },
    summary: '当前项目不是 Git 仓库，已改用普通子任务执行，避免 worktree 创建失败。'
  });
  return downgradedInput;
}

export function sanitizeClaudeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'Read') {
    return input;
  }

  const pages = input.pages;
  if (typeof pages !== 'string' || pages.trim()) {
    return input;
  }

  const sanitized = { ...input };
  delete sanitized.pages;
  return sanitized;
}


function normalizeClaudeAskUserQuestions(input: Record<string, unknown>): ClaudeAskUserQuestion[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const normalized: ClaudeAskUserQuestion[] = [];
  for (const [questionIndex, questionInput] of questions.entries()) {
    if (!isRecord(questionInput) || typeof questionInput.question !== 'string' || !questionInput.question.trim()) {
      continue;
    }

    const options: AgentUserInputOption[] = [];
    if (Array.isArray(questionInput.options)) {
      for (const [optionIndex, optionInput] of questionInput.options.entries()) {
        if (!isRecord(optionInput) || typeof optionInput.label !== 'string' || !optionInput.label.trim()) {
          continue;
        }
        const option: AgentUserInputOption = {
          id: `q${questionIndex + 1}_option_${optionIndex + 1}`,
          label: optionInput.label
        };
        if (typeof optionInput.description === 'string') {
          option.description = optionInput.description;
        }
        options.push(option);
      }
    }
    if (options.length === 0) {
      continue;
    }

    const normalizedQuestion: ClaudeAskUserQuestion = {
      question: questionInput.question,
      options,
      multiSelect: questionInput.multiSelect === true
    };
    if (typeof questionInput.header === 'string') {
      normalizedQuestion.header = questionInput.header;
    }
    normalized.push(normalizedQuestion);
  }
  return normalized;
}

async function handleClaudeAskUserQuestion(
  params: GenericAgentRuntimeParams,
  input: Record<string, unknown>,
  toolUseID: string
): Promise<ClaudeAgentPermissionResult> {
  if (!params.requestUserInput) {
    return {
      behavior: 'deny',
      message: 'User input is not available in this Funplay runtime.',
      toolUseID
    };
  }

  const questions = normalizeClaudeAskUserQuestions(input);
  if (questions.length === 0) {
    return {
      behavior: 'deny',
      message: 'Claude Code AskUserQuestion did not include a valid question.',
      toolUseID
    };
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    const response = await params.requestUserInput({
      title: question.header ? `Claude 需要确认：${question.header}` : 'Claude 需要你的选择',
      question: question.question,
      detail: question.multiSelect
        ? '可多选：请选择一个或多个选项，或直接输入其他回答。'
        : '请选择一个选项，或直接输入其他回答。',
      options: question.options,
      multiSelect: question.multiSelect,
      allowFreeText: true,
      placeholder: question.multiSelect ? '例如：选项 A, 选项 B' : '输入其他回答…',
      toolName: 'AskUserQuestion'
    });
    if (response.cancelled) {
      return {
        behavior: 'deny',
        message: 'User cancelled the clarification question.',
        toolUseID
      };
    }
    answers[question.question] = response.answer;
  }

  return {
    behavior: 'allow',
    updatedInput: {
      ...input,
      answers
    },
    toolUseID
  };
}

export function createClaudeSdkPermissionHandler(params: GenericAgentRuntimeParams): CanUseTool {
  return async (toolName, input, options): Promise<ClaudeAgentPermissionResult> => {
    const sanitizedInput = downgradeClaudeAgentWorktreeIsolationForNonGitProject(
      toolName,
      sanitizeClaudeToolInput(toolName, input),
      params,
      options.toolUseID
    );
    const hookAbortSignal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, options.signal])
      : options.signal;
    const preToolHooks = await runAgentLifecycleHooks(params.lifecycleHooks, {
      event: 'PreToolUse',
      runId: params.activeRunId,
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      toolUseId: options.toolUseID,
      toolName,
      metadata: {
        input: sanitizedInput,
        claudeTool: true,
        agentId: options.agentID,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath
      }
    }, {
      project: params.project,
      permissionContext: {
        permission: params.permission,
        requestPermission: params.requestPermission
      },
      cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath,
      checkpointSnapshotId: params.checkpointSnapshotId,
      abortSignal: hookAbortSignal,
      emitHook: params.onLifecycleHook,
      emitStage: (stage) => params.onStage?.({
        ...stage,
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        upstreamModel: params.provider?.upstreamModel
      })
    });
    if (preToolHooks.blocked) {
      return {
        behavior: 'deny',
        message: preToolHooks.blockReason ?? `Lifecycle hook blocked Claude Code tool ${toolName}.`,
        interrupt: false,
        toolUseID: options.toolUseID
      };
    }

    if (toolName === 'AskUserQuestion') {
      return handleClaudeAskUserQuestion(params, sanitizedInput, options.toolUseID);
    }

    const readOnly = isReadOnlyClaudeTool(toolName);
    const risk = readOnly ? 'low' : toolName === 'Bash' ? 'high' : 'medium';
    const decision = await resolveAgentToolPermission(
      {
        permission: params.permission,
        requestPermission: params.requestPermission
      },
      {
        tool: {
          name: readOnly ? `claude_code:${toolName}` : 'claude_code_external_write',
          title: options.displayName || toolName,
          risk,
          readOnly,
          permissionPolicy: readOnly ? 'always' : 'ask',
          checkpointPolicy: readOnly ? 'none' : 'external_best_effort'
        },
        input: {
          claudeToolName: toolName,
          claudeToolUseId: options.toolUseID,
          ...sanitizedInput
        },
        title: options.title || `允许 Claude Code 使用工具：${options.displayName || toolName}？`,
        detail: [
          options.description,
          `Claude tool: ${toolName}`,
          options.decisionReason ? `Reason: ${options.decisionReason}` : '',
          options.blockedPath ? `Blocked path: ${options.blockedPath}` : '',
          `Input:\n${formatToolInputForPermission(sanitizedInput)}`
        ].filter(Boolean).join('\n\n'),
        risk
      }
    );

    if (decision === 'allow') {
      return {
        behavior: 'allow',
        updatedInput: sanitizedInput,
        updatedPermissions: options.suggestions,
        toolUseID: options.toolUseID
      };
    }

    return {
      behavior: 'deny',
      message: 'Funplay denied this Claude Code tool request.',
      interrupt: false,
      toolUseID: options.toolUseID
    };
  };
}

function buildClaudeSdkSkillSettings(
  params: GenericAgentRuntimeParams,
  activeSkillNames: string[]
): ClaudeAgentSdkOptions['settings'] | undefined {
  const skillIndex = params.context.toolContext.skillIndex;
  if (!skillIndex.length && !activeSkillNames.length) {
    return undefined;
  }
  const active = new Set(activeSkillNames);
  return {
    disableSkillShellExecution: true,
    skillOverrides: Object.fromEntries(skillIndex.map((skill) => [
      skill.name,
      active.has(skill.name) ? 'on' : skill.userInvocable ? 'user-invocable-only' : 'off'
    ]))
  };
}

export function createClaudeCodeSdkOptions(params: GenericAgentRuntimeParams, allowWriteTools: boolean, options: {
  cwd: string;
  abortController: AbortController;
  resumeSessionId?: string;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  canUseTool?: CanUseTool;
}): ClaudeAgentSdkOptions {
  const permissionMode = resolveClaudeSdkPermissionMode(params, allowWriteTools);
  const useClaudeNativeWeb = shouldUseClaudeNativeWeb(params.provider);
  const profile = resolveClaudeMcpProfile(params, {
    allowWriteTools,
    supportsHostControlledWrites: true
  });
  const activeSkillNames = params.context.toolContext.activeSkills.map((skill) => skill.name);
  const skillSettings = buildClaudeSdkSkillSettings(params, activeSkillNames);
  const sdkOptions: ClaudeAgentSdkOptions = {
    cwd: options.cwd,
    abortController: options.abortController,
    includePartialMessages: true,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: createSystemPrompt(params.provider, profile)
    },
    permissionMode,
    allowedTools: getAutoAllowedSdkTools(false, useClaudeNativeWeb, profile),
    disallowedTools: useClaudeNativeWeb && profile.includeWeb ? undefined : [...CLAUDE_NATIVE_WEB_TOOLS],
    env: options.env ?? buildClaudeCodeSdkEnv(params.provider),
    settingSources: resolveClaudeSdkSettingSources(params.provider),
    mcpServers: buildFunplayMcpServers(params, options.cwd, profile),
    settings: skillSettings,
    enableFileCheckpointing: Boolean(params.checkpointSnapshotId),
    canUseTool: options.canUseTool,
    stderr: options.stderr
  };

  if (permissionMode === 'bypassPermissions') {
    sdkOptions.allowDangerouslySkipPermissions = true;
    sdkOptions.allowedTools = getAutoAllowedSdkTools(allowWriteTools, useClaudeNativeWeb, profile);
  }

  if (options.resumeSessionId) {
    sdkOptions.resume = options.resumeSessionId;
  }

  const executablePath = resolveClaudeAgentSdkExecutablePath();
  if (executablePath) {
    sdkOptions.pathToClaudeCodeExecutable = executablePath;
  }

  const runtimeOverrides = getClaudeRuntimeSession(params).runtimeOverrides;
  const model = resolveClaudeCliModel(params.provider);
  const sanitizedModelOptions = sanitizeClaudeModelOptions({
    model,
    effort: resolveClaudeEffort(params.context.sessionEffort),
    context1m: Boolean(runtimeOverrides?.context1m),
    thinking: runtimeOverrides?.thinking
  });

  if (sanitizedModelOptions.effort) {
    sdkOptions.effort = sanitizedModelOptions.effort as ClaudeAgentSdkOptions['effort'];
  }

  if (sanitizedModelOptions.applyContext1mBeta) {
    sdkOptions.betas = [
      ...((sdkOptions.betas ?? []) as string[]),
      'context-1m-2025-08-07'
    ] as ClaudeAgentSdkOptions['betas'];
  }
  if (sanitizedModelOptions.thinking) {
    sdkOptions.thinking = sanitizedModelOptions.thinking as ClaudeAgentSdkOptions['thinking'];
  }
  if (runtimeOverrides?.outputFormat) {
    sdkOptions.outputFormat = runtimeOverrides.outputFormat as ClaudeAgentSdkOptions['outputFormat'];
  }
  if (runtimeOverrides?.agents) {
    sdkOptions.agents = runtimeOverrides.agents as ClaudeAgentSdkOptions['agents'];
  }
  if (runtimeOverrides?.agent?.trim()) {
    sdkOptions.agent = runtimeOverrides.agent.trim();
    if (activeSkillNames.length && sdkOptions.agents?.[sdkOptions.agent]) {
      sdkOptions.agents = {
        ...sdkOptions.agents,
        [sdkOptions.agent]: {
          ...sdkOptions.agents[sdkOptions.agent],
          skills: activeSkillNames
        }
      };
    }
  }

  if (model) {
    sdkOptions.model = model;
  }

  return sdkOptions;
}

export async function testClaudeCodeSdkProviderRuntime(
  provider: AiProvider,
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ClaudeSdkProviderProbeResult> {
  const resolved = resolveClaudeCodeProvider(provider);
  if (!resolved.canUseClaudeCode) {
    throw new Error(`claude_provider_invalid: 当前 provider 不能直接作为 Claude Code SDK runtime 使用。protocol=${provider.protocol}`);
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref?.();

  let stderrBuffer = '';
  let sdkEnvSetup: ClaudeSdkSubprocessEnv | undefined;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    sdkEnvSetup = prepareClaudeCodeSdkSubprocessEnv(provider);
    const executable = resolveClaudeCodeExecutable();
    const sdkOptions: ClaudeAgentSdkOptions = {
      cwd: options.cwd ?? tmpdir(),
      abortController,
      includePartialMessages: false,
      permissionMode: 'dontAsk',
      env: sdkEnvSetup.env,
      settingSources: resolved.settingSources,
      stderr: (data) => {
        stderrBuffer = [stderrBuffer, data].filter(Boolean).join('\n').slice(-1200);
      }
    };

    const executablePath = executable.sdkExecutablePath;
    if (executablePath) {
      sdkOptions.pathToClaudeCodeExecutable = executablePath;
    }
    const model = resolveClaudeCliModel(provider);
    if (model) {
      sdkOptions.model = model;
    }

    let responsePreview = '';
    for await (const message of query({
      prompt: 'Reply with exactly: OK',
      options: sdkOptions
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'result') {
        const result = sdkResultToClaudeResultEvent(message as SDKResultMessage);
        if (result.is_error) {
          throw new Error(result.result || result.subtype || 'claude_sdk_probe_failed');
        }
        responsePreview = result.result?.trim() || responsePreview;
        break;
      }
      if (message.type === 'assistant') {
        const assistant = message as SDKAssistantMessage;
        const content = assistant.message?.content;
        if (Array.isArray(content)) {
          responsePreview = content
            .map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
            .slice(0, 120);
        }
      }
    }

    if (!responsePreview) {
      throw new Error('empty_response');
    }

    return {
      ok: true,
      runtimeId: 'claude-code-sdk',
      providerId: resolved.providerId,
      providerProtocol: resolved.protocol,
      baseUrl: resolved.baseUrl,
      model,
      executablePath: executable.command,
      executableSource: executable.source,
      responsePreview: responsePreview.slice(0, 120),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const diagnostic = classifyClaudeRuntimeError({
      error,
      stderr: stderrBuffer,
      provider
    });
    throw new Error(`${diagnostic.code}: ${diagnostic.summary}\n建议：${diagnostic.suggestedAction}`);
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    sdkEnvSetup?.shadow.cleanup();
  }
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
    const query = activeSdkQueries.get(runIdOrSessionId);
    if (query) {
      query.close();
      activeSdkQueries.delete(runIdOrSessionId);
    }

    const child = activeProcesses.get(runIdOrSessionId);
    if (!child) {
      return;
    }
    child.kill('SIGTERM');
    activeProcesses.delete(runIdOrSessionId);
  },
  dispose() {
    for (const query of activeSdkQueries.values()) {
      query.close();
    }
    activeSdkQueries.clear();

    for (const child of activeProcesses.values()) {
      child.kill('SIGTERM');
    }
    activeProcesses.clear();
  },
  async executeTurn(params) {
    const operationLogCollector = createConversationOperationLogCollector();
    const processTranscriptCollector = createConversationProcessTranscriptCollector();
    const contentBlockCollector = createConversationContentBlockCollector();
    const sessionKey = params.context.activeSessionId ?? makeId('claude_session');
    const steps: GameAgentStep[] = [
      createStep(
        'context',
        '切换 Claude Code runtime',
        `当前项目会话 ${sessionKey} 已切换到 Claude Code CLI 执行链路。`,
        'completed'
      )
    ];
    const runController = createAgentRunController();
    let latestRunControllerSnapshot: AgentRunControllerSnapshot = runController.start();
    const emitToolUse = (tool: {
      toolUseId: string;
      name: string;
      input?: Record<string, unknown>;
      status: 'pending' | 'running' | 'completed' | 'failed';
    }): void => {
      processTranscriptCollector.onToolUse(tool);
      operationLogCollector.onToolUse(tool);
      contentBlockCollector.onToolUse(tool);
      params.onToolUse?.(tool);
    };
    const emitToolResult = (result: Parameters<NonNullable<GenericAgentRuntimeParams['onToolResult']>>[0]): void => {
      if (
        latestRunControllerSnapshot.pendingToolUseIds.includes(result.toolUseId) ||
        latestRunControllerSnapshot.coreState.state === 'executing_tools' ||
        latestRunControllerSnapshot.coreState.state === 'recording_tool_results'
      ) {
        latestRunControllerSnapshot = runController.recordToolResult({
          toolUseId: result.toolUseId,
          toolName: result.toolName,
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
      }
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
      const runtimeId = stage.runtimeId === 'native' || stage.runtimeId === 'claude-code-sdk' ? stage.runtimeId : undefined;
      params.onStage?.({
        stageId: stage.stageId ?? `stage:${stage.target}`,
        phase: stage.phase,
        title: stage.title,
        target: stage.target,
        status: stage.status,
        input: stage.input,
        summary: stage.summary,
        errorMessage: stage.errorMessage,
        runtimeId,
        providerId: stage.providerId,
        model: stage.model,
        errorCode: stage.errorCode,
        suggestedAction: stage.suggestedAction,
        recoveryActions: stage.recoveryActions,
        transaction: stage.transaction
      });
    };
    const appendLifecycleHookContext = (contexts: string[]): void => {
      if (contexts.length === 0) {
        return;
      }
      params.lifecycleHookContext = [
        ...(params.lifecycleHookContext ?? []),
        ...contexts
      ];
    };
    const runClaudeLifecycleHooks = (trigger: Parameters<typeof runAgentLifecycleHooks>[1]) => runAgentLifecycleHooks(
      params.lifecycleHooks,
      {
        runId: params.activeRunId,
        projectId: params.project.id,
        sessionId: params.context.activeSessionId,
        ...trigger
      },
      {
        project: params.project,
        permissionContext: {
          permission: params.permission,
          requestPermission: params.requestPermission
        },
        cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath,
        checkpointSnapshotId: params.checkpointSnapshotId,
        abortSignal: params.abortSignal,
        emitHook: params.onLifecycleHook,
        emitStage: (stage) => emitStage({
          ...stage,
          runtimeId: 'claude-code-sdk',
          providerId: params.provider?.id,
          model: params.provider?.model,
          upstreamModel: params.provider?.upstreamModel
        })
      }
    );
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
    const coreStateMachine = createAgentCoreStateMachine();
    let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
    const transitionCoreState = (to: AgentCoreState, reason: string): void => {
      const current = coreStateMachine.getSnapshot().state;
      if (current === to || !canTransitionAgentCoreState(current, to)) {
        return;
      }
      coreStateMachine.transition(to, reason, new Date().toISOString());
    };
    const summarizeRunControllerSnapshot = (snapshot: AgentRunControllerSnapshot): Record<string, unknown> => ({
      state: snapshot.coreState.state,
      nextAction: snapshot.nextAction,
      providerStepCount: snapshot.providerStepCount,
      partCount: snapshot.parts.length,
      pendingToolUseIds: snapshot.pendingToolUseIds,
      completedToolUseIds: snapshot.completedToolUseIds,
      lastDecision: snapshot.lastDecision
        ? {
            outcome: snapshot.lastDecision.outcome,
            nextState: snapshot.lastDecision.nextState,
            terminal: snapshot.lastDecision.terminal,
            reason: snapshot.lastDecision.reason
          }
        : undefined
    });
    const recordRunControllerProviderStep = (
      forceContinuation?: Parameters<typeof runController.recordProviderStep>[0]['forceContinuation']
    ): AgentRunControllerSnapshot => {
      if (!latestCoreProviderStep) {
        return latestRunControllerSnapshot;
      }
      latestRunControllerSnapshot = runController.recordProviderStep({
        providerStep: latestCoreProviderStep,
        forceContinuation
      });
      return latestRunControllerSnapshot;
    };
    const emitCoreStateStage = (status: 'running' | 'completed' | 'failed', summary: string): void => {
      emitStage({
        stageId: 'stage:claude_agent_core_v2',
        title: 'Agent Core v2 状态机',
        target: 'stage:claude_agent_core_v2',
        status,
        summary,
        runtimeId: 'claude-code-sdk',
        providerId: params.provider?.id,
        model: params.provider?.model,
        input: {
          coreState: coreStateMachine.getSnapshot(),
          providerStep: latestCoreProviderStep,
          runController: summarizeRunControllerSnapshot(latestRunControllerSnapshot)
        }
      });
    };
    const markCoreBuildingInput = (reason: string): void => {
      const current = coreStateMachine.getSnapshot().state;
      if (current === 'initializing') {
        transitionCoreState('loading_context', 'Claude runtime 正在加载上下文。');
      }
      if (coreStateMachine.getSnapshot().state === 'compacting_context') {
        transitionCoreState('building_model_input', reason);
      } else if (coreStateMachine.getSnapshot().state === 'loading_context') {
        transitionCoreState('building_model_input', reason);
      } else if (coreStateMachine.getSnapshot().state === 'continuing_after_tools') {
        transitionCoreState('building_model_input', reason);
      } else if (coreStateMachine.getSnapshot().state === 'collecting_tool_calls') {
        transitionCoreState('building_model_input', reason);
      }
    };
    const markCoreStreaming = (reason: string): void => {
      const current = coreStateMachine.getSnapshot().state;
      if (current === 'recording_tool_results') {
        transitionCoreState('continuing_after_tools', 'Claude 工具结果已记录，准备继续模型步骤。');
      }
      markCoreBuildingInput('Claude runtime 正在构建 provider 输入。');
      transitionCoreState('streaming_model_step', reason);
    };
    const markCoreCollecting = (reason: string): void => {
      markCoreStreaming(reason);
      transitionCoreState('collecting_tool_calls', reason);
    };
    const markCoreExecuting = (reason: string): void => {
      markCoreCollecting(reason);
      transitionCoreState('executing_tools', reason);
    };
    const markCoreRecording = (reason: string): void => {
      markCoreExecuting(reason);
      transitionCoreState('recording_tool_results', reason);
    };
    const markCoreCompleted = (reason: string): void => {
      const current = coreStateMachine.getSnapshot().state;
      if (current === 'executing_tools') {
        transitionCoreState('recording_tool_results', 'Claude 工具执行结束，记录工具结果。');
      }
      if (coreStateMachine.getSnapshot().state === 'recording_tool_results') {
        transitionCoreState('continuing_after_tools', 'Claude 工具结果已记录，准备最终回复。');
      }
      markCoreCollecting(reason);
      transitionCoreState('completed', reason);
      emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 Claude runtime。');
    };
    const markCoreFailed = (reason: string): void => {
      transitionCoreState('failed', reason);
      emitCoreStateStage('failed', reason);
    };
    const markCoreCompacting = (reason: string): void => {
      if (coreStateMachine.getSnapshot().state === 'initializing') {
        transitionCoreState('loading_context', 'Claude runtime 正在加载上下文。');
      }
      transitionCoreState('compacting_context', reason);
    };
    const recordClaudeAssistantContentForRunController = (content?: ClaudeContentBlock[]): void => {
      if (!Array.isArray(content)) {
        return;
      }
      const toolCalls: AgentCoreProviderStepResult['toolCalls'] = [];
      for (const [index, block] of content.entries()) {
        if (block.type !== 'tool_use') {
          continue;
        }
        const input = normalizeToolInput(block.input);
        toolCalls.push({
          toolUseId: block.id ?? `claude_tool_${index}`,
          name: block.name ?? 'claude_tool',
          ...(block.id ? { providerCallId: block.id } : {}),
          ...(input ? { input } : {})
        });
      }
      if (toolCalls.length === 0) {
        return;
      }
      const text = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
      const thinking = content
        .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
        .map((block) => block.thinking)
        .join('\n\n')
        .trim();
      latestCoreProviderStep = {
        text: text || undefined,
        thinking: thinking || undefined,
        finishReason: 'tool_calls',
        toolCalls
      };
      recordRunControllerProviderStep();
    };
    const observeClaudeAssistantContentForCoreState = (content?: ClaudeContentBlock[]): void => {
      if (!Array.isArray(content)) {
        return;
      }
      if (content.some((block) => block.type === 'text' || block.type === 'thinking')) {
        markCoreStreaming('Claude runtime 正在流式输出内容。');
      }
      if (content.some((block) => block.type === 'tool_use')) {
        markCoreExecuting('Claude runtime 请求执行工具。');
      }
      if (content.some((block) => block.type === 'tool_result')) {
        markCoreRecording('Claude runtime 返回工具结果。');
      }
      recordClaudeAssistantContentForRunController(content);
    };
    const observeClaudeUserContentForCoreState = (content?: ClaudeContentBlock[] | string): void => {
      if (Array.isArray(content) && content.some((block) => block.type === 'tool_result')) {
        markCoreRecording('Claude runtime 已收到工具结果回放。');
      }
    };
    transitionCoreState('loading_context', 'Claude runtime 正在加载上下文。');
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
      markCoreFailed('Claude CLI 不可用。');
      return {
        assistantMessage: fallbackReply,
        assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
          type: 'fallback',
          text: fallbackReply,
          reason: 'claude_cli_missing'
        }),
        assistantMetadata: processTranscriptCollector.build(fallbackReply),
        assistantIntent: 'fallback',
        fallbackDetail: 'claude_cli_missing',
        status: 'fallback',
        operationLog: operationLogCollector.build(),
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
      markCoreFailed('Claude runtime 未获得写入权限。');
      return {
        assistantMessage: deniedReply,
        assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
          type: 'fallback',
          text: deniedReply,
          reason: 'write_permission_denied'
        }),
        assistantMetadata: processTranscriptCollector.build(deniedReply),
        assistantIntent: 'fallback',
        fallbackDetail: 'write_permission_denied',
        status: 'fallback',
        operationLog: operationLogCollector.build(),
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
        assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
          type: 'fallback',
          text: fallbackReply,
          reason: diagnostic.code
        }),
        assistantMetadata: processTranscriptCollector.build(fallbackReply),
        assistantIntent: 'fallback',
        fallbackDetail: [diagnostic.code, diagnostic.suggestedAction, redactedDetail].filter(Boolean).join('\n'),
        status: 'fallback',
        operationLog: operationLogCollector.build(),
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
        markCoreCompacting('Claude runtime 上下文接近预算，正在生成 handoff summary。');
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
      onTextDelta: (delta, accumulated) => {
        processTranscriptCollector.onTextDelta(delta, accumulated);
        params.onTextDelta?.(delta, accumulated);
      },
      onThinkingDelta: (delta, accumulated) => emitThinking(delta, accumulated),
      onToolUse: emitToolUse,
      onToolResult: emitToolResult,
      normalizeToolInput,
      extractToolResult: (block) => extractToolResultForCollector(block as ClaudeContentBlock)
    });
    const state = streamCollector.state;
    const postToolUseHookedResults = new Set<string>();
    const pendingPostToolUseHookRuns = new Set<Promise<void>>();
    const runClaudePostToolUseHooksForContent = async (
      content: ClaudeContentBlock[] | string | undefined,
      source: 'sdk_assistant' | 'sdk_user' | 'cli_assistant' | 'cli_user'
    ): Promise<void> => {
      if (!Array.isArray(content) || !params.lifecycleHooks?.rules.length) {
        return;
      }
      for (const [index, block] of content.entries()) {
        if (block.type !== 'tool_result') {
          continue;
        }
        const toolUseId = block.tool_use_id ?? `claude_tool_result_${index}`;
        if (postToolUseHookedResults.has(toolUseId)) {
          continue;
        }
        postToolUseHookedResults.add(toolUseId);
        const toolName = state.toolNamesByUseId.get(toolUseId) ?? 'claude_tool';
        const extracted = extractToolResultForCollector(block);
        await runAgentLifecycleHooks(params.lifecycleHooks, {
          event: 'PostToolUse',
          runId: params.activeRunId,
          projectId: params.project.id,
          sessionId: params.context.activeSessionId,
          toolUseId,
          toolName,
          status: block.is_error ? 'failed' : 'completed',
          metadata: {
            claudeTool: true,
            source,
            isError: Boolean(block.is_error),
            resultLength: extracted.content.length,
            resultPreview: extracted.content.slice(0, 2000),
            mediaCount: extracted.media?.length ?? 0
          }
        }, {
          project: params.project,
          permissionContext: {
            permission: params.permission,
            requestPermission: params.requestPermission
          },
          cwd,
          checkpointSnapshotId: params.checkpointSnapshotId,
          abortSignal: params.abortSignal,
          emitHook: params.onLifecycleHook,
          emitStage: (stage) => emitStage({
            ...stage,
            runtimeId: 'claude-code-sdk',
            providerId: params.provider?.id,
            model: params.provider?.model,
            upstreamModel: params.provider?.upstreamModel
          })
        });
      }
    };
    const queueClaudePostToolUseHooksForContent = (
      content: ClaudeContentBlock[] | string | undefined,
      source: 'sdk_assistant' | 'sdk_user' | 'cli_assistant' | 'cli_user'
    ): Promise<void> => {
      let queuedRun: Promise<void>;
      queuedRun = runClaudePostToolUseHooksForContent(content, source)
        .catch((error) => {
          emitStage({
            stageId: 'stage:lifecycle_hook:PostToolUse:claude_error',
            phase: 'hook',
            title: '生命周期 Hook',
            target: 'hook:PostToolUse',
            status: 'failed',
            summary: error instanceof Error ? error.message : 'Claude PostToolUse hook failed.',
            errorMessage: error instanceof Error ? error.message : String(error),
            runtimeId: 'claude-code-sdk',
            providerId: params.provider?.id,
            model: params.provider?.model,
            upstreamModel: params.provider?.upstreamModel
          });
        })
        .finally(() => {
          pendingPostToolUseHookRuns.delete(queuedRun);
        });
      pendingPostToolUseHookRuns.add(queuedRun);
      return queuedRun;
    };
    const waitForQueuedClaudePostToolUseHooks = async (): Promise<void> => {
      while (pendingPostToolUseHookRuns.size > 0) {
        await Promise.allSettled([...pendingPostToolUseHookRuns]);
      }
    };
    let finalEvent: ClaudeResultEvent | undefined;
    let systemSessionId: string | undefined;
    let stderrBuffer = '';
    let beforeExternalWriteSnapshot: Map<string, Pick<ProjectFileEntry, 'size' | 'modifiedAt'>> | undefined;
    let externalWriteBaseline: ExternalWriteBaseline | undefined;
    if (allowWriteTools) {
      try {
        beforeExternalWriteSnapshot = mapFileSnapshot(await listProjectFilesForProject(params.project));
        externalWriteBaseline = await captureExternalWriteBaseline(params);
      } catch {
        beforeExternalWriteSnapshot = undefined;
        externalWriteBaseline = undefined;
      }
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
      markCoreStreaming(attemptResumeSessionId ? 'Claude SDK 正在续接会话。' : 'Claude SDK 正在启动新会话。');
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
            observeClaudeAssistantContentForCoreState(assistantEvent.message?.content);
            streamCollector.applyAssistantEvent(assistantEvent);
            await queueClaudePostToolUseHooksForContent(assistantEvent.message?.content, 'sdk_assistant');
            continue;
          }

          if (message.type === 'user') {
            const userEvent = message as unknown as ClaudeUserEvent;
            observeClaudeUserContentForCoreState(userEvent.message?.content);
            streamCollector.applyUserEvent(userEvent);
            await queueClaudePostToolUseHooksForContent(userEvent.message?.content, 'sdk_user');
            continue;
          }

          if (message.type === 'stream_event') {
            markCoreStreaming('Claude SDK 正在消费 stream_event。');
            streamCollector.applyStreamEvent(message as unknown as ClaudeStreamEvent);
            continue;
          }

          if (message.type === 'result') {
            finalEvent = sdkResultToClaudeResultEvent(message as SDKResultMessage);
            latestCoreProviderStep = claudeResultEventToAgentCoreProviderStepResult(finalEvent, {
              providerId: params.provider?.id,
              model: resolveClaudeCliModel(params.provider) || params.provider?.model
            });
            recordRunControllerProviderStep();
            streamCollector.applyResultEvent(finalEvent);
            continue;
          }

          if (message.type === 'tool_progress') {
            const progressEvent = message as SDKToolProgressMessage;
            markCoreExecuting(`Claude 工具执行中：${progressEvent.tool_name ?? progressEvent.tool_use_id ?? 'unknown'}。`);
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

        await waitForQueuedClaudePostToolUseHooks();
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
      markCoreStreaming(attemptResumeSessionId ? 'Claude CLI 正在续接会话。' : 'Claude CLI 正在启动新会话。');
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
            observeClaudeAssistantContentForCoreState(assistantEvent.message?.content);
            streamCollector.applyAssistantEvent(assistantEvent);
            queueClaudePostToolUseHooksForContent(assistantEvent.message?.content, 'cli_assistant');
            return;
          }

          if (event.type === 'user') {
            const userEvent = event as ClaudeUserEvent;
            observeClaudeUserContentForCoreState(userEvent.message?.content);
            streamCollector.applyUserEvent(userEvent);
            queueClaudePostToolUseHooksForContent(userEvent.message?.content, 'cli_user');
            return;
          }

          if (event.type === 'stream_event') {
            markCoreStreaming('Claude CLI 正在消费 stream_event。');
            streamCollector.applyStreamEvent(event as ClaudeStreamEvent);
            return;
          }

          if (event.type === 'result') {
            finalEvent = event as ClaudeResultEvent;
            latestCoreProviderStep = claudeResultEventToAgentCoreProviderStepResult(finalEvent, {
              providerId: params.provider?.id,
              model: resolveClaudeCliModel(params.provider) || params.provider?.model
            });
            recordRunControllerProviderStep();
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
            markCoreExecuting(`Claude 工具执行中：${progressEvent.tool_name ?? progressEvent.tool_use_id ?? 'unknown'}。`);
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
              await waitForQueuedClaudePostToolUseHooks();
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
        transitionCoreState('interrupted_resumable', 'Claude resume 会话失效，准备使用新会话重试。');
        transitionCoreState('loading_context', 'Claude runtime 正在为 fresh retry 重新加载上下文。');
        transitionCoreState('building_model_input', 'Claude runtime 正在为 fresh retry 构建 provider 输入。');
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
        markCoreCompacting('Claude SDK 报告上下文过长，准备压缩后重试。');
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
        markCoreBuildingInput('Claude runtime 正在用压缩上下文重试。');
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
      markCoreCompacting('Claude SDK result 报告上下文过长，准备压缩后重试。');
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
      markCoreBuildingInput('Claude runtime 正在用压缩上下文重试。');
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
    if (allowWriteTools) {
      try {
        const afterExternalWriteSnapshot = mapFileSnapshot(await listProjectFilesForProject(params.project));
        const diff = beforeExternalWriteSnapshot
          ? diffFileSnapshots(beforeExternalWriteSnapshot, afterExternalWriteSnapshot)
          : {
              added: [],
              modified: [],
              removed: []
            };
        const rollback = await recordExternalWriteRollbackCheckpoint(params, externalWriteBaseline, diff);
        emitStage({
          stageId: 'stage:external_write_audit',
          title: '审计 Claude 外部写入',
          target: 'stage:external_write_audit',
          status: 'completed',
          summary: beforeExternalWriteSnapshot
            ? `外部写入审计：added=${diff.added.length}, modified=${diff.modified.length}, removed=${diff.removed.length}, rollback=${rollback.rollbackFiles.length}, auditOnly=${rollback.auditOnlyFiles.length}`
            : 'Claude 外部写入审计未能获取运行前文件快照。',
          input: {
            checkpointPolicy: rollback.rollbackFiles.length ? 'external_rollback_available' : 'external_best_effort',
            added: diff.added.slice(0, 20),
            modified: diff.modified.slice(0, 20),
            removed: diff.removed.slice(0, 20),
            rollbackFiles: rollback.rollbackFiles.slice(0, 20),
            auditOnlyFiles: rollback.auditOnlyFiles.slice(0, 20),
            baselineSkippedFiles: externalWriteBaseline?.skippedFiles.slice(0, 20) ?? []
          }
        });
      } catch (error) {
        emitStage({
          stageId: 'stage:external_write_audit',
          title: '审计 Claude 外部写入',
          target: 'stage:external_write_audit',
          status: 'failed',
          summary: error instanceof Error ? error.message : 'Claude 外部写入审计失败。',
          errorMessage: error instanceof Error ? error.message : 'external_write_audit_failed'
        });
      }
    }
    if (finalEvent?.is_error) {
      clearClaudeResumeSessionPatch();
      markCoreFailed(finalEvent.result?.trim() || 'Claude runtime 返回错误结果。');
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
      markCoreFailed('Claude Code runtime 没有返回可显示内容。');
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
    markCoreCompleted('Claude runtime 返回最终可见文本。');

    return {
      assistantMessage: finalText,
      assistantContentBlocks: contentBlockCollector.buildFinalBlocks({
        type: 'text',
        text: finalText
      }),
      assistantMetadata: processTranscriptCollector.build(finalText),
      assistantIntent: 'chat',
      status: 'completed',
      operationLog: operationLogCollector.build(),
      usedProviderId: params.provider?.id,
      usedModel: params.provider?.model,
      effectiveCapabilities,
      sessionRuntimePatch: Object.keys(sessionRuntimePatch).length ? sessionRuntimePatch : undefined,
      steps: [
        ...steps,
        createStep('model', 'Claude Code runtime 已完成', resolvedCliSessionId ? `CLI session: ${resolvedCliSessionId}` : '已成功返回最终回复。', 'completed')
      ]
    };
  }
};
