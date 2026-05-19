import { existsSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AgentLifecycleHookAction,
  AgentLifecycleHookActionType,
  AgentLifecycleHookConfig,
  AgentLifecycleHookEvaluationResult,
  AgentLifecycleHookEventName,
  AgentLifecycleHookRule,
  AgentLifecycleHookTrigger,
  AgentRuntimeEvent,
  Project
} from '../../../shared/types';
import { makeId } from '../../../shared/utils';
import { resolveAgentToolPermission, type AgentPermissionContext } from './permission-broker';
import {
  advanceToolExecutorTransaction,
  completeToolExecutorTransaction,
  createToolExecutorTransaction,
  createToolExecutorTransactionSummary,
  normalizeToolExecutorTransactionResult
} from './tool-executor';
import { executeAgentToolAction, type AgentToolExecutionOptions, type WorkspaceToolActionResult } from './workspace-tools';

const HOOK_EVENTS = new Set<AgentLifecycleHookEventName>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact'
]);

const ACTION_TYPES = new Set<AgentLifecycleHookActionType>([
  'audit',
  'append_context',
  'block',
  'command'
]);

const MAX_HOOK_RULES = 80;
const MAX_FIELD_LENGTH = 4000;
const MAX_HOOK_CONFIG_BYTES = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value: unknown, maxLength = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function normalizeEventName(value: unknown): AgentLifecycleHookEventName | undefined {
  return typeof value === 'string' && HOOK_EVENTS.has(value as AgentLifecycleHookEventName)
    ? value as AgentLifecycleHookEventName
    : undefined;
}

function normalizeAction(input: unknown): AgentLifecycleHookAction | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const type = typeof input.type === 'string' && ACTION_TYPES.has(input.type as AgentLifecycleHookActionType)
    ? input.type as AgentLifecycleHookActionType
    : undefined;
  if (!type) {
    return undefined;
  }

  const rawTimeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
    : typeof input.timeout === 'number' && Number.isFinite(input.timeout)
      ? input.timeout * 1000
      : undefined;
  const timeoutMs = rawTimeoutMs !== undefined
    ? Math.max(1_000, Math.min(120_000, Math.round(rawTimeoutMs)))
    : type === 'command'
      ? DEFAULT_COMMAND_TIMEOUT_MS
      : undefined;

  return {
    type,
    message: cleanText(input.message),
    context: cleanText(input.context),
    command: cleanText(input.command),
    timeoutMs
  };
}

function normalizeSource(value: unknown): AgentLifecycleHookRule['source'] {
  return value === 'project' || value === 'user' || value === 'workspace' || value === 'runtime'
    ? value
    : undefined;
}

function makeRule(params: {
  event: AgentLifecycleHookEventName;
  rule: Record<string, unknown>;
  action: AgentLifecycleHookAction;
  index: number;
  actionIndex?: number;
  defaultSource?: AgentLifecycleHookRule['source'];
  defaultSourcePath?: string;
}): AgentLifecycleHookRule {
  const suffix = params.actionIndex === undefined ? `${params.index + 1}` : `${params.index + 1}_${params.actionIndex + 1}`;
  return {
    id: cleanText(params.rule.id, 160) ?? `hook_${params.event}_${suffix}`,
    event: params.event,
    matcher: cleanText(params.rule.matcher, 1000),
    enabled: params.rule.enabled !== false,
    action: params.action,
    source: normalizeSource(params.rule.source) ?? params.defaultSource,
    sourcePath: cleanText(params.rule.sourcePath, 1000) ?? params.defaultSourcePath
  };
}

function normalizeRulesArray(input: unknown, options: NormalizeAgentLifecycleHooksOptions): AgentLifecycleHookConfig {
  const diagnostics: AgentLifecycleHookConfig['diagnostics'] = [];
  const rules: AgentLifecycleHookRule[] = [];
  const rawRules = Array.isArray(input) ? input : [];

  rawRules.slice(0, MAX_HOOK_RULES).forEach((rawRule, index) => {
    if (!isRecord(rawRule)) {
      diagnostics.push({
        level: 'warning',
        message: `Ignored lifecycle hook rule ${index + 1}: expected object.`
      });
      return;
    }
    const event = normalizeEventName(rawRule.event);
    const action = normalizeAction(rawRule.action);
    if (!event || !action) {
      diagnostics.push({
        level: 'warning',
        message: `Ignored lifecycle hook rule ${index + 1}: missing supported event or action.`
      });
      return;
    }
    rules.push(makeRule({
      event,
      rule: rawRule,
      action,
      index,
      defaultSource: options.source,
      defaultSourcePath: options.sourcePath
    }));
  });

  if (rawRules.length > MAX_HOOK_RULES) {
    diagnostics.push({
      level: 'warning',
      message: `Ignored ${rawRules.length - MAX_HOOK_RULES} lifecycle hook rule(s) beyond the ${MAX_HOOK_RULES} rule limit.`
    });
  }

  return {
    rules,
    diagnostics
  };
}

function normalizeClaudeStyleHooks(input: Record<string, unknown>, options: NormalizeAgentLifecycleHooksOptions): AgentLifecycleHookConfig {
  const diagnostics: AgentLifecycleHookConfig['diagnostics'] = [];
  const rules: AgentLifecycleHookRule[] = [];

  for (const [eventKey, rawEntries] of Object.entries(input)) {
    const event = normalizeEventName(eventKey);
    if (!event) {
      diagnostics.push({
        level: 'warning',
        message: `Ignored unsupported lifecycle hook event: ${eventKey}.`,
        path: `hooks.${eventKey}`
      });
      continue;
    }
    if (!Array.isArray(rawEntries)) {
      diagnostics.push({
        level: 'warning',
        message: `Ignored ${eventKey} hooks: expected array.`,
        path: `hooks.${eventKey}`
      });
      continue;
    }
    rawEntries.forEach((rawEntry, entryIndex) => {
      if (!isRecord(rawEntry)) {
        diagnostics.push({
          level: 'warning',
          message: `Ignored ${eventKey} hook ${entryIndex + 1}: expected object.`,
          path: `hooks.${eventKey}.${entryIndex}`
        });
        return;
      }
      const rawHooks = Array.isArray(rawEntry.hooks) ? rawEntry.hooks : [];
      if (rawHooks.length === 0) {
        diagnostics.push({
          level: 'warning',
          message: `Ignored ${eventKey} hook ${entryIndex + 1}: no actions.`,
          path: `hooks.${eventKey}.${entryIndex}.hooks`
        });
        return;
      }
      rawHooks.forEach((rawAction, actionIndex) => {
        if (rules.length >= MAX_HOOK_RULES) {
          return;
        }
        const action = normalizeAction(rawAction);
        if (!action) {
          diagnostics.push({
            level: 'warning',
            message: `Ignored ${eventKey} hook ${entryIndex + 1}.${actionIndex + 1}: unsupported action.`,
            path: `hooks.${eventKey}.${entryIndex}.hooks.${actionIndex}`
          });
          return;
        }
        rules.push(makeRule({
          event,
          rule: rawEntry,
          action,
          index: entryIndex,
          actionIndex,
          defaultSource: options.source,
          defaultSourcePath: options.sourcePath
        }));
      });
    });
  }

  return {
    rules,
    diagnostics
  };
}

export interface NormalizeAgentLifecycleHooksOptions {
  source?: AgentLifecycleHookRule['source'];
  sourcePath?: string;
}

export function normalizeAgentLifecycleHookConfig(
  input: unknown,
  options: NormalizeAgentLifecycleHooksOptions = {}
): AgentLifecycleHookConfig {
  if (!isRecord(input)) {
    return {
      rules: [],
      diagnostics: [{
        level: 'warning',
        message: 'Ignored lifecycle hooks config: expected object.'
      }]
    };
  }

  const rulesConfig = normalizeRulesArray(input.rules, options);
  const hooks = isRecord(input.hooks) ? normalizeClaudeStyleHooks(input.hooks, options) : { rules: [], diagnostics: [] };
  return {
    rules: [...rulesConfig.rules, ...hooks.rules].slice(0, MAX_HOOK_RULES),
    diagnostics: [...rulesConfig.diagnostics, ...hooks.diagnostics]
  };
}

export interface LoadAgentLifecycleHookConfigOptions {
  includeUser?: boolean;
}

function resolveProjectRootPath(project: Project): string | undefined {
  const rawPath = project.engine?.projectPath?.trim();
  if (!rawPath) {
    return undefined;
  }
  return resolve(rawPath.replace(/^~/, homedir()));
}

function readHookConfigFile(filePath: string): unknown {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_HOOK_CONFIG_BYTES) {
    throw new Error(`Lifecycle hook config is not a readable file or exceeds ${MAX_HOOK_CONFIG_BYTES} bytes.`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

export function loadAgentLifecycleHookConfigForProject(
  project: Project,
  options: LoadAgentLifecycleHookConfigOptions = {}
): AgentLifecycleHookConfig {
  const includeUser = options.includeUser ?? true;
  const projectRoot = resolveProjectRootPath(project);
  const candidates: Array<{
    path: string;
    source: AgentLifecycleHookRule['source'];
  }> = [
    ...(includeUser ? [{
      path: join(homedir(), '.claude', 'settings.json'),
      source: 'user' as const
    }] : []),
    ...(projectRoot ? [
      {
        path: join(projectRoot, '.claude', 'settings.json'),
        source: 'project' as const
      },
      {
        path: join(projectRoot, '.claude', 'settings.local.json'),
        source: 'workspace' as const
      },
      {
        path: join(projectRoot, '.funplay', 'hooks.json'),
        source: 'workspace' as const
      }
    ] : [])
  ];
  const rules: AgentLifecycleHookRule[] = [];
  const diagnostics: AgentLifecycleHookConfig['diagnostics'] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      continue;
    }
    try {
      const normalized = normalizeAgentLifecycleHookConfig(readHookConfigFile(candidate.path), {
        source: candidate.source,
        sourcePath: candidate.path
      });
      rules.push(...normalized.rules);
      diagnostics.push(...normalized.diagnostics);
    } catch (error) {
      diagnostics.push({
        level: 'error',
        message: error instanceof Error ? error.message : 'Failed to read lifecycle hook config.',
        path: candidate.path
      });
    }
  }

  return {
    rules: rules.slice(0, MAX_HOOK_RULES),
    diagnostics
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matcherToRegex(token: string): RegExp {
  return new RegExp(`^${escapeRegex(token).replace(/\*/g, '.*')}$`);
}

function getHookMatchTarget(trigger: AgentLifecycleHookTrigger): string {
  return trigger.toolName ?? trigger.prompt ?? trigger.status ?? trigger.event;
}

export function matchesAgentLifecycleHookRule(rule: AgentLifecycleHookRule, trigger: AgentLifecycleHookTrigger): boolean {
  if (!rule.enabled || rule.event !== trigger.event) {
    return false;
  }
  const matcher = rule.matcher?.trim();
  if (!matcher || matcher === '*') {
    return true;
  }
  const target = getHookMatchTarget(trigger);
  return matcher
    .split(/[|,]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => matcherToRegex(token).test(target));
}

function summarizeHookResult(rule: AgentLifecycleHookRule, status: AgentLifecycleHookEvaluationResult['status']): string {
  if (rule.action.message) {
    return rule.action.message;
  }
  if (rule.action.type === 'command') {
    return `Hook command requires host permission before execution: ${rule.action.command ?? '(missing command)'}`;
  }
  if (status === 'blocked') {
    return `Lifecycle hook blocked ${rule.event}.`;
  }
  if (status === 'context_appended') {
    return `Lifecycle hook appended context for ${rule.event}.`;
  }
  return `Lifecycle hook matched ${rule.event}.`;
}

export function evaluateAgentLifecycleHooks(
  config: AgentLifecycleHookConfig,
  trigger: AgentLifecycleHookTrigger
): {
  results: AgentLifecycleHookEvaluationResult[];
  blocked: boolean;
  appendedContext: string[];
  pendingCommands: AgentLifecycleHookEvaluationResult[];
} {
  const results = config.rules
    .filter((rule) => matchesAgentLifecycleHookRule(rule, trigger))
    .map((rule): AgentLifecycleHookEvaluationResult => {
      const status: AgentLifecycleHookEvaluationResult['status'] =
        rule.action.type === 'block'
          ? 'blocked'
          : rule.action.type === 'append_context'
            ? 'context_appended'
            : rule.action.type === 'command'
              ? 'requires_permission'
              : 'matched';
      return {
        id: makeId('hook'),
        ruleId: rule.id,
        event: rule.event,
        matcher: rule.matcher,
        actionType: rule.action.type,
        status,
        summary: summarizeHookResult(rule, status),
        blockReason: rule.action.type === 'block' ? rule.action.message ?? `Blocked by hook ${rule.id}.` : undefined,
        context: rule.action.type === 'append_context' ? rule.action.context ?? rule.action.message : undefined,
        command: rule.action.type === 'command' ? rule.action.command : undefined,
        timeoutMs: rule.action.type === 'command' ? rule.action.timeoutMs : undefined,
        source: rule.source,
        sourcePath: rule.sourcePath,
        trigger
      };
    });

  return {
    results,
    blocked: results.some((result) => result.status === 'blocked'),
    appendedContext: results.map((result) => result.context).filter((value): value is string => Boolean(value)),
    pendingCommands: results.filter((result) => result.status === 'requires_permission')
  };
}

export interface ExecuteAgentLifecycleHookCommandOptions {
  project: Project;
  permissionContext?: AgentPermissionContext;
  cwd?: string;
  checkpointSnapshotId?: string;
  abortSignal?: AbortSignal;
}

export interface AgentLifecycleHookStageEvent {
  stageId: string;
  title: string;
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  summary?: string;
  errorMessage?: string;
  input?: Record<string, unknown>;
  transaction?: AgentLifecycleHookEvaluationResult['transaction'];
}

export interface RunAgentLifecycleHooksOptions {
  project?: Project;
  permissionContext?: AgentPermissionContext;
  cwd?: string;
  checkpointSnapshotId?: string;
  abortSignal?: AbortSignal;
  executeCommands?: boolean;
  emitHook?: (hook: AgentLifecycleHookEvaluationResult) => void;
  emitStage?: (stage: AgentLifecycleHookStageEvent) => void;
}

export interface AgentLifecycleHookRunResult {
  results: AgentLifecycleHookEvaluationResult[];
  blocked: boolean;
  blockReason?: string;
  appendedContext: string[];
  commandResults: AgentLifecycleHookEvaluationResult[];
}

function previewHookCommandResult(result: WorkspaceToolActionResult): AgentLifecycleHookEvaluationResult['commandResult'] {
  return {
    ok: result.ok,
    isError: result.isError,
    contentPreview: result.summary.length > 2000 ? `${result.summary.slice(0, 2000)}…` : result.summary,
    command: result.command
  };
}

function hookCommandReason(hook: AgentLifecycleHookEvaluationResult): string {
  return `Lifecycle hook ${hook.ruleId} (${hook.event}) requested command execution.`;
}

function normalizeHookCommandCwd(project: Project, cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isAbsolute(trimmed)) {
    return trimmed;
  }
  const projectRoot = resolveProjectRootPath(project);
  if (!projectRoot) {
    return undefined;
  }
  const absoluteCwd = resolve(trimmed.replace(/^~/, homedir()));
  if (absoluteCwd === projectRoot) {
    return undefined;
  }
  const relativeCwd = relative(projectRoot, absoluteCwd);
  if (!relativeCwd || relativeCwd.startsWith('..') || isAbsolute(relativeCwd)) {
    return trimmed;
  }
  return relativeCwd;
}

export async function executeAgentLifecycleHookCommand(
  hook: AgentLifecycleHookEvaluationResult,
  options: ExecuteAgentLifecycleHookCommandOptions
): Promise<AgentLifecycleHookEvaluationResult> {
  if (hook.actionType !== 'command') {
    return {
      ...hook,
      status: 'skipped',
      summary: `Lifecycle hook ${hook.ruleId} is not a command hook.`
    };
  }
  if (!hook.command?.trim()) {
    return {
      ...hook,
      status: 'command_failed',
      summary: `Lifecycle hook ${hook.ruleId} did not include a command.`,
      commandResult: {
        ok: false,
        isError: true,
        contentPreview: 'Missing command.'
      }
    };
  }

  const commandCwd = normalizeHookCommandCwd(options.project, options.cwd);
  const input = {
    command: hook.command,
    cwd: commandCwd,
    timeoutMs: hook.timeoutMs,
    reason: hookCommandReason(hook)
  };
  const permissionRequestId = makeId('perm');
  let transaction = createToolExecutorTransaction({
    toolUseId: hook.id,
    toolName: 'run_command',
    toolClass: 'command',
    input,
    timeoutMs: hook.timeoutMs,
    permission: {
      policy: 'ask',
      risk: 'high',
      requestId: permissionRequestId
    },
    checkpoint: {
      policy: 'external_best_effort',
      snapshotId: options.checkpointSnapshotId,
      status: options.checkpointSnapshotId ? 'completed' : 'pending'
    }
  });
  transaction = advanceToolExecutorTransaction(transaction, {
    phase: 'awaiting_permission',
    eventType: 'permission_requested',
    summary: `Awaiting permission for lifecycle hook command: ${hook.command}`
  });
  const decision = await resolveAgentToolPermission(options.permissionContext, {
    tool: {
      name: 'run_command',
      title: 'Lifecycle Hook Command',
      risk: 'high',
      readOnly: false,
      permissionPolicy: 'ask',
      checkpointPolicy: 'external_best_effort'
    },
    input,
    title: `允许生命周期 Hook 执行命令？`,
    detail: [
      `Hook：${hook.ruleId}`,
      `事件：${hook.event}`,
      `命令：${hook.command}`,
      options.cwd ? `目录：${options.cwd}` : '',
      '该命令将通过 Funplay run_command 工具执行，并受同样的超时、cwd 和后台命令限制。'
    ].filter(Boolean).join('\n'),
    risk: 'high'
  });

  if (decision !== 'allow') {
    const content = 'Permission denied before command execution.';
    transaction = advanceToolExecutorTransaction({
      ...transaction,
      permission: {
        policy: 'ask',
        risk: 'high',
        requestId: permissionRequestId,
        decision: 'deny'
      }
    }, {
      phase: 'recording_result',
      eventType: 'permission_denied',
      summary: `Lifecycle hook command permission denied: ${hook.command}`
    });
    transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
      content,
      isError: true
    }), {
      summary: content
    });
    return {
      ...hook,
      status: 'permission_denied',
      permissionDecision: 'deny',
      summary: `Lifecycle hook command permission denied: ${hook.command}`,
      commandResult: {
        ok: false,
        isError: true,
        contentPreview: content
      },
      transaction: createToolExecutorTransactionSummary(transaction)
    };
  }

  transaction = advanceToolExecutorTransaction({
    ...transaction,
    permission: {
      policy: 'ask',
      risk: 'high',
      requestId: permissionRequestId,
      decision: 'allow'
    }
  }, {
    phase: 'executing',
    eventType: 'permission_allowed',
    summary: `Lifecycle hook command permission allowed: ${hook.command}`
  });
  transaction = advanceToolExecutorTransaction(transaction, {
    phase: 'executing',
    eventType: 'execution_started',
    summary: `Executing lifecycle hook command: ${hook.command}`
  });

  try {
    const result = await executeAgentToolAction(options.project, {
      type: 'run_command',
      command: hook.command,
      cwd: commandCwd,
      timeoutMs: hook.timeoutMs,
      reason: hookCommandReason(hook)
    }, {
      checkpointSnapshotId: options.checkpointSnapshotId,
      abortSignal: options.abortSignal
    } satisfies AgentToolExecutionOptions);

    transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
      content: result.summary,
      isError: Boolean(result.isError || !result.ok),
      command: result.command
    }), {
      summary: result.summary
    });
    return {
      ...hook,
      status: result.ok && !result.isError ? 'command_completed' : 'command_failed',
      permissionDecision: 'allow',
      summary: result.summary,
      commandResult: previewHookCommandResult(result),
      transaction: createToolExecutorTransactionSummary(transaction)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
      content: message,
      isError: true
    }), {
      summary: message
    });
    return {
      ...hook,
      status: 'command_failed',
      permissionDecision: 'allow',
      summary: `Lifecycle hook command failed: ${message}`,
      commandResult: {
        ok: false,
        isError: true,
        contentPreview: message
      },
      transaction: createToolExecutorTransactionSummary(transaction)
    };
  }
}

function lifecycleHookStageStatus(status: AgentLifecycleHookEvaluationResult['status']): AgentLifecycleHookStageEvent['status'] {
  if (status === 'requires_permission') {
    return 'running';
  }
  if (status === 'blocked' || status === 'permission_denied' || status === 'command_failed') {
    return 'failed';
  }
  if (status === 'skipped' || status === 'command_skipped') {
    return 'skipped';
  }
  return 'completed';
}

function emitLifecycleHookResult(hook: AgentLifecycleHookEvaluationResult, options: RunAgentLifecycleHooksOptions): void {
  options.emitHook?.(hook);
  options.emitStage?.({
    stageId: `stage:lifecycle_hook:${hook.event}:${hook.ruleId}:${hook.id}`,
    title: '生命周期 Hook',
    target: `hook:${hook.event}`,
    status: lifecycleHookStageStatus(hook.status),
    summary: hook.summary,
    errorMessage:
      hook.status === 'blocked' ||
      hook.status === 'permission_denied' ||
      hook.status === 'command_failed'
        ? hook.blockReason ?? hook.commandResult?.contentPreview ?? hook.summary
        : undefined,
    input: {
      hookId: hook.id,
      ruleId: hook.ruleId,
      event: hook.event,
      matcher: hook.matcher,
      actionType: hook.actionType,
      status: hook.status,
      source: hook.source,
      sourcePath: hook.sourcePath,
      trigger: hook.trigger,
      command: hook.command,
      commandResult: hook.commandResult,
      transaction: hook.transaction
    },
    transaction: hook.transaction
  });
}

export async function runAgentLifecycleHooks(
  config: AgentLifecycleHookConfig | undefined,
  trigger: AgentLifecycleHookTrigger,
  options: RunAgentLifecycleHooksOptions = {}
): Promise<AgentLifecycleHookRunResult> {
  if (!config?.rules.length) {
    return {
      results: [],
      blocked: false,
      appendedContext: [],
      commandResults: []
    };
  }

  const evaluation = evaluateAgentLifecycleHooks(config, trigger);
  const results: AgentLifecycleHookEvaluationResult[] = [];
  for (const result of evaluation.results) {
    results.push(result);
    emitLifecycleHookResult(result, options);
  }

  const commandResults: AgentLifecycleHookEvaluationResult[] = [];
  if (options.executeCommands !== false) {
    for (const commandHook of evaluation.pendingCommands) {
      let executed: AgentLifecycleHookEvaluationResult;
      if (evaluation.blocked) {
        executed = {
          ...commandHook,
          status: 'command_skipped',
          summary: `Skipped lifecycle hook command because ${trigger.event} was blocked by another hook.`
        };
      } else if (!options.project) {
        executed = {
          ...commandHook,
          status: 'command_skipped',
          summary: `Skipped lifecycle hook command because no project execution context was available.`
        };
      } else {
        executed = await executeAgentLifecycleHookCommand(commandHook, {
          project: options.project,
          permissionContext: options.permissionContext,
          cwd: options.cwd,
          checkpointSnapshotId: options.checkpointSnapshotId,
          abortSignal: options.abortSignal
        });
      }
      commandResults.push(executed);
      results.push(executed);
      emitLifecycleHookResult(executed, options);
    }
  }

  return {
    results,
    blocked: evaluation.blocked,
    blockReason: evaluation.results.find((result) => result.status === 'blocked')?.blockReason,
    appendedContext: evaluation.appendedContext,
    commandResults
  };
}

export function agentLifecycleHookResultToRuntimeEvent(
  hook: AgentLifecycleHookEvaluationResult
): Omit<AgentRuntimeEvent, 'id' | 'createdAt'> {
  const failed = hook.status === 'blocked' ||
    hook.status === 'permission_denied' ||
    hook.status === 'command_failed';
  const running = hook.status === 'requires_permission';
  return {
    type: 'hook',
    status: failed ? 'failed' : running ? 'running' : 'completed',
    statusMessage: hook.summary,
    hook,
    metadata: {
      hookId: hook.id,
      ruleId: hook.ruleId,
      event: hook.event,
      actionType: hook.actionType,
      hookStatus: hook.status
    }
  };
}
