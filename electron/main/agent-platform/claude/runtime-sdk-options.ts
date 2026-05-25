import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type {
  CanUseTool,
  Options as ClaudeAgentSdkOptions,
  PermissionResult as ClaudeAgentPermissionResult
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentUserInputOption,
  ClaudeRuntimeWriteMode
} from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import { runAgentLifecycleHooks } from '../agent-hooks';
import { resolveAgentToolPermission } from '../permission-broker';
import { formatToolPolicyForStage, type AgentToolPolicyDecision } from '../tool-policy';
import type { GenericAgentRuntimeParams } from '../types';
import {
  CLAUDE_NATIVE_WEB_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  FUNPLAY_MCP_SERVER_TOOL_NAMES,
  FUNPLAY_WORKSPACE_WRITE_SERVER_TOOL_NAMES,
  getClaudeRuntimeSession
} from './constants';
import {
  buildClaudeCodeSdkEnv,
  buildFunplayMcpServers,
  getAllowedTools,
  isRecord,
  resolveClaudeAgentSdkExecutablePath,
  resolveClaudeCliModel,
  resolveClaudeEffort,
  resolveClaudeSdkPermissionMode,
  resolveClaudeSdkSettingSources
} from './env-builder';
import { sanitizeClaudeModelOptions } from './model-options';
import {
  createSystemPrompt,
  shouldUseClaudeNativeWeb
} from './prompt-builder';
import type {
  ClaudeAskUserQuestion,
  ClaudeMcpProfile,
  ClaudeRuntimePermissionDecision
} from './types';

export async function resolveWritePermission(params: GenericAgentRuntimeParams, policy: AgentToolPolicyDecision): Promise<ClaudeRuntimePermissionDecision> {
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

export function describeClaudeWriteMode(params: {
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
