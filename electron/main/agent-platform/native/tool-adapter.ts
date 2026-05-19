import { tool, type ToolSet } from 'ai';
import type { AgentLifecycleHookConfig, AgentLifecycleHookEvaluationResult, AgentPermissionImpact, McpPlugin, Project } from '../../../../shared/types';
import { resolveNativeToolPermission, type NativeToolPermissionContext } from './tool-permission';
import { getAgentToolDefinition, listReadOnlyWorkspaceToolDefinitions, type AgentToolDefinition } from '../tool-registry';
import { executeAgentToolAction, type AgentToolExecutionOptions, type WorkspaceToolAction, type WorkspaceToolActionResult } from '../workspace-tools';
import { resolveMcpToolPolicy, type ResolvedMcpToolPolicy } from '../mcp-policy';
import { makeSessionMcpToolPermissionKey } from '../permission-session-store';
import { runAgentLifecycleHooks, type AgentLifecycleHookStageEvent } from '../agent-hooks';

export const NATIVE_TOOL_OUTPUT_MAX_CHARS = 12_000;
const NATIVE_TOOL_OUTPUT_TAIL_CHARS = 2_000;

export const NATIVE_READ_ONLY_WORKSPACE_TOOL_NAMES = listReadOnlyWorkspaceToolDefinitions().map((definition) => definition.name);
export const NATIVE_WRITE_WORKSPACE_TOOL_NAMES = ['create_directory', 'write_file', 'edit_file', 'multi_edit', 'patch_file', 'checkpoint_rollback', 'funplay_memory_remember', 'funplay_schedule_task', 'funplay_cancel_task', 'media_save_base64', 'image_generate'] as const;
export const NATIVE_MCP_TOOL_CALL_NAMES = ['call_mcp_tool'] as const;
export const NATIVE_COMMAND_TOOL_NAMES = [
  'run_command',
  'terminal_start',
  'terminal_write',
  'terminal_stop',
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_close'
] as const;
const NATIVE_NOTIFICATION_TOOL_NAMES = new Set([
  'funplay_notify',
  'funplay_schedule_task',
  'funplay_list_tasks',
  'funplay_cancel_task'
]);
const NATIVE_SUBAGENT_STOP_TOOL_NAMES = new Set([
  'run_subagent',
  'run_subagents'
]);

export type NativeReadOnlyWorkspaceToolName = typeof NATIVE_READ_ONLY_WORKSPACE_TOOL_NAMES[number];
export type NativeWriteWorkspaceToolName = typeof NATIVE_WRITE_WORKSPACE_TOOL_NAMES[number];
export type NativeMcpToolCallName = typeof NATIVE_MCP_TOOL_CALL_NAMES[number];
export type NativeCommandToolName = typeof NATIVE_COMMAND_TOOL_NAMES[number];
export type NativeWorkspaceToolName =
  | NativeReadOnlyWorkspaceToolName
  | NativeWriteWorkspaceToolName
  | NativeMcpToolCallName
  | NativeCommandToolName;

export interface NativeWorkspaceToolAdapterOptions {
  project: Project;
  plugins?: McpPlugin[];
  dynamicTools?: NativeRuntimeToolDefinition[];
  checkpointSnapshotId?: string;
  abortSignal?: AbortSignal;
  permissionContext?: NativeToolPermissionContext;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
  excludeTools?: Array<WorkspaceToolAction['type']>;
  requestUserInput?: (action: Extract<WorkspaceToolAction, { type: 'ask_user' }>) => Promise<WorkspaceToolActionResult>;
  requestMcpUserInput?: AgentToolExecutionOptions['requestUserInput'];
  lifecycleHooks?: AgentLifecycleHookConfig;
  lifecycleHookContext?: {
    runId?: string;
    projectId?: string;
    sessionId?: string;
    cwd?: string;
  };
  onLifecycleHook?: (hook: AgentLifecycleHookEvaluationResult) => void;
  emitLifecycleHookStage?: (stage: AgentLifecycleHookStageEvent) => void;
  runSubagent?: (action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>) => Promise<WorkspaceToolActionResult>;
  runSubagents?: (action: Extract<WorkspaceToolAction, { type: 'run_subagents' }>) => Promise<WorkspaceToolActionResult>;
  startSubagent?: (action: Extract<WorkspaceToolAction, { type: 'subagent_start' }>) => Promise<WorkspaceToolActionResult>;
  readSubagentStatus?: (action: Extract<WorkspaceToolAction, { type: 'subagent_status' }>) => Promise<WorkspaceToolActionResult>;
}

export interface NativeRuntimeToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputSchema: AgentToolDefinition<TInput>['inputSchema'];
  inputJsonSchema?: Record<string, unknown>;
  risk: AgentToolDefinition['risk'];
  permissionPolicy: AgentToolDefinition['permissionPolicy'];
  checkpointPolicy: AgentToolDefinition['checkpointPolicy'];
  readOnly: boolean;
  mcp?: NonNullable<AgentPermissionImpact['mcp']>;
  toAction?: (input: TInput) => WorkspaceToolAction;
  execute?: (input: TInput) => Promise<WorkspaceToolActionResult>;
}

function toToolOutput(result: WorkspaceToolActionResult): {
  ok: boolean;
  summary: string;
  isError?: boolean;
  media?: WorkspaceToolActionResult['media'];
  changedFiles?: WorkspaceToolActionResult['changedFiles'];
  command?: WorkspaceToolActionResult['command'];
  terminal?: WorkspaceToolActionResult['terminal'];
  browser?: WorkspaceToolActionResult['browser'];
  edit?: WorkspaceToolActionResult['edit'];
  mcp?: WorkspaceToolActionResult['mcp'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
  summaryTruncated?: boolean;
  originalSummaryLength?: number;
} {
  const compacted = compactToolSummary(result.summary);
  return {
    ok: result.ok,
    summary: compacted.summary,
    isError: result.isError,
    media: result.media,
    changedFiles: result.changedFiles,
    command: result.command,
    terminal: result.terminal,
    browser: result.browser,
    edit: result.edit,
    mcp: result.mcp,
    artifacts: result.artifacts,
    summaryTruncated: compacted.truncated || undefined,
    originalSummaryLength: compacted.truncated ? result.summary.length : undefined
  };
}

function compactToolSummary(summary: string): {
  summary: string;
  truncated: boolean;
} {
  if (summary.length <= NATIVE_TOOL_OUTPUT_MAX_CHARS) {
    return {
      summary,
      truncated: false
    };
  }

  const marker = `\n\n[Native tool output truncated by Funplay: kept head and tail; original length ${summary.length} chars]\n\n`;
  const tailLength = Math.min(NATIVE_TOOL_OUTPUT_TAIL_CHARS, Math.floor(NATIVE_TOOL_OUTPUT_MAX_CHARS / 3));
  const headLength = Math.max(0, NATIVE_TOOL_OUTPUT_MAX_CHARS - marker.length - tailLength);
  return {
    summary: `${summary.slice(0, headLength)}${marker}${summary.slice(-tailLength)}`,
    truncated: true
  };
}

function createUnsafeToolQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let queue = Promise.resolve();
  return async (operation) => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

export function listNativeWorkspaceToolDefinitions(options: NativeWorkspaceToolAdapterOptions): NativeRuntimeToolDefinition[] {
  const readOnlyTools = listReadOnlyWorkspaceToolDefinitions();
  const writeTools = options.includeWriteTools
    ? NATIVE_WRITE_WORKSPACE_TOOL_NAMES
        .map((toolName) => getAgentToolDefinition(toolName))
        .filter((definition): definition is AgentToolDefinition => Boolean(definition))
    : [];
  const mcpToolCalls = options.includeMcpToolCalls
    ? NATIVE_MCP_TOOL_CALL_NAMES
        .map((toolName) => getAgentToolDefinition(toolName))
        .filter((definition): definition is AgentToolDefinition => Boolean(definition))
    : [];
  const commandTools = options.includeCommandTools
    ? NATIVE_COMMAND_TOOL_NAMES
        .map((toolName) => getAgentToolDefinition(toolName))
        .filter((definition): definition is AgentToolDefinition => Boolean(definition))
    : [];
  const excluded = new Set(options.excludeTools ?? []);
  return [...readOnlyTools, ...writeTools, ...mcpToolCalls, ...(options.dynamicTools ?? []), ...commandTools]
    .filter((definition) => !excluded.has(definition.name as WorkspaceToolAction['type']));
}

export function listNativeWorkspaceToolNames(options: Pick<NativeWorkspaceToolAdapterOptions, 'includeWriteTools' | 'includeMcpToolCalls' | 'includeCommandTools' | 'excludeTools'> = {}): string[] {
  return listNativeWorkspaceToolDefinitions(options as NativeWorkspaceToolAdapterOptions).map((definition) => definition.name);
}

function createMcpPermissionImpact(plugin: McpPlugin, toolName: string, policy: ResolvedMcpToolPolicy): NonNullable<AgentPermissionImpact['mcp']> {
  return {
    permissionKey: makeSessionMcpToolPermissionKey(plugin.id, toolName),
    pluginId: plugin.id,
    pluginName: plugin.name,
    toolName,
    policySource: policy.source,
    permission: policy.permission,
    risk: policy.riskPolicy
  };
}

function resolveMcpPermissionForTool(options: NativeWorkspaceToolAdapterOptions, definition: NativeRuntimeToolDefinition, input?: Record<string, unknown>): {
  mcp: NonNullable<AgentPermissionImpact['mcp']>;
  policy: ResolvedMcpToolPolicy;
} | undefined {
  if (definition.mcp?.pluginId && definition.mcp.toolName) {
    const plugin = options.plugins?.find((item) => item.id === definition.mcp?.pluginId);
    if (!plugin) {
      return undefined;
    }
    const policy = resolveMcpToolPolicy(plugin, definition.mcp.toolName);
    return {
      mcp: createMcpPermissionImpact(plugin, definition.mcp.toolName, policy),
      policy
    };
  }

  if (definition.name !== 'call_mcp_tool') {
    return undefined;
  }

  const toolName = typeof input?.toolName === 'string' ? input.toolName : '';
  if (!toolName) {
    return undefined;
  }
  const plugin = typeof input?.pluginId === 'string'
    ? options.plugins?.find((item) => item.id === input.pluginId && item.enabled)
    : typeof input?.pluginKind === 'string'
      ? options.plugins?.find((item) => item.kind === input.pluginKind && item.enabled)
      : options.plugins?.find((item) => item.enabled);
  if (!plugin) {
    return undefined;
  }
  const policy = resolveMcpToolPolicy(plugin, toolName);
  return {
    mcp: createMcpPermissionImpact(plugin, toolName, policy),
    policy
  };
}

async function guardWorkspaceTool(options: NativeWorkspaceToolAdapterOptions, definition: NativeRuntimeToolDefinition, input?: Record<string, unknown>): Promise<WorkspaceToolActionResult | undefined> {
  const mcpPermission = resolveMcpPermissionForTool(options, definition, input);
  if (mcpPermission?.policy.permission === 'deny') {
    return {
      ok: false,
      isError: true,
      summary: `${mcpPermission.mcp.pluginName ?? mcpPermission.mcp.pluginId} / ${mcpPermission.mcp.toolName} 已被 MCP policy 拒绝。`,
      mcp: {
        pluginId: mcpPermission.mcp.pluginId,
        operation: 'call_tool',
        target: mcpPermission.mcp.toolName ?? '',
        timeoutMs: 0,
        schemaGuard: 'failed',
        failureKind: 'permission_denied'
      }
    };
  }
  const decision = await resolveNativeToolPermission(options.permissionContext, {
    toolName: definition.name,
    input,
    isWrite: mcpPermission ? !mcpPermission.policy.readOnly : !definition.readOnly,
    risk: mcpPermission?.policy.risk ?? definition.risk,
    title: `允许 Agent 执行工具：${definition.title}？`,
    mcp: mcpPermission?.mcp ?? definition.mcp
  });
  if (decision === 'allow') {
    return undefined;
  }

  return {
    ok: false,
    isError: true,
    summary: `工具 ${definition.name} 未获得执行权限。`
  };
}

function appendLifecycleHookContextToToolOutput<T extends ReturnType<typeof toToolOutput>>(output: T, contexts: string[]): T {
  const cleaned = contexts.map((context) => context.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return output;
  }
  return {
    ...output,
    summary: [
      output.summary,
      '',
      '[Lifecycle hook additional context]',
      ...cleaned
    ].join('\n')
  };
}

async function runWorkspaceToolLifecycleHooks(
  options: NativeWorkspaceToolAdapterOptions,
  definition: NativeRuntimeToolDefinition,
  event: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'SubagentStop',
  input: Record<string, unknown>,
  status?: string,
  metadata?: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof runAgentLifecycleHooks>>> {
  return runAgentLifecycleHooks(options.lifecycleHooks, {
    event,
    runId: options.lifecycleHookContext?.runId,
    projectId: options.lifecycleHookContext?.projectId ?? options.project.id,
    sessionId: options.lifecycleHookContext?.sessionId,
    toolName: definition.name,
    status,
    metadata: {
      input,
      ...metadata
    }
  }, {
    project: options.project,
    permissionContext: options.permissionContext,
    cwd: options.lifecycleHookContext?.cwd,
    checkpointSnapshotId: options.checkpointSnapshotId,
    abortSignal: options.abortSignal,
    emitHook: options.onLifecycleHook,
    emitStage: options.emitLifecycleHookStage
  });
}

export function createNativeReadOnlyWorkspaceTools(options: NativeWorkspaceToolAdapterOptions): ToolSet {
  return createNativeWorkspaceTools({
    ...options,
    includeWriteTools: false
  });
}

export function createNativeWorkspaceTools(options: NativeWorkspaceToolAdapterOptions): ToolSet {
  const runUnsafeToolExclusive = createUnsafeToolQueue();

  return Object.fromEntries(
    listNativeWorkspaceToolDefinitions(options).map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input) => {
          const normalizedInput = (input ?? {}) as Record<string, unknown>;
          const preToolHooks = await runWorkspaceToolLifecycleHooks(options, definition, 'PreToolUse', normalizedInput);
          if (preToolHooks.blocked) {
            return toToolOutput({
              ok: false,
              isError: true,
              summary: [
                `生命周期 Hook 阻止了工具 ${definition.name} 的执行。`,
                preToolHooks.blockReason ?? '该工具调用未执行。'
              ].filter(Boolean).join('\n')
            });
          }
          const executeTool = async () => {
            const denied = await guardWorkspaceTool(options, definition, normalizedInput);
            if (denied) {
              return toToolOutput(denied);
            }
            if (definition.execute) {
              return toToolOutput(await definition.execute(normalizedInput));
            }
            if (!definition.toAction) {
              return toToolOutput({
                ok: false,
                isError: true,
                summary: `工具 ${definition.name} 没有可执行动作。`
              });
            }
            const action = definition.toAction(normalizedInput);
            if (action.type === 'ask_user') {
              if (!options.requestUserInput) {
                return toToolOutput({
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用用户输入请求器。'
                });
              }
              return toToolOutput(await options.requestUserInput(action));
            }
            if (action.type === 'run_subagent') {
              if (!options.runSubagent) {
                return toToolOutput({
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用子任务执行器。'
                });
              }
              return toToolOutput(await options.runSubagent(action));
            }
            if (action.type === 'run_subagents') {
              if (!options.runSubagents) {
                return toToolOutput({
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用并行子任务执行器。'
                });
              }
              return toToolOutput(await options.runSubagents(action));
            }
            if (action.type === 'subagent_start') {
              if (!options.startSubagent) {
                return toToolOutput({
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用后台子任务执行器。'
                });
              }
              return toToolOutput(await options.startSubagent(action));
            }
            if (action.type === 'subagent_status') {
              if (!options.readSubagentStatus) {
                return toToolOutput({
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用后台子任务状态读取器。'
                });
              }
              return toToolOutput(await options.readSubagentStatus(action));
            }
            return toToolOutput(
              await executeAgentToolAction(
                options.project,
                action,
                {
                  plugins: options.plugins,
                  checkpointSnapshotId: options.checkpointSnapshotId,
                  abortSignal: options.abortSignal,
                  requestUserInput: options.requestMcpUserInput
                }
              )
            );
          };

          const output = definition.readOnly ? await executeTool() : await runUnsafeToolExclusive(executeTool);
          const postToolHooks = await runWorkspaceToolLifecycleHooks(
            options,
            definition,
            'PostToolUse',
            normalizedInput,
            output.isError ? 'failed' : 'completed'
          );
          const appendedContext = [...postToolHooks.appendedContext];
          if (NATIVE_NOTIFICATION_TOOL_NAMES.has(definition.name)) {
            const notificationHooks = await runWorkspaceToolLifecycleHooks(
              options,
              definition,
              'Notification',
              normalizedInput,
              output.isError ? 'failed' : 'completed',
              {
                ok: output.ok,
                isError: output.isError,
                summary: output.summary
              }
            );
            appendedContext.push(...notificationHooks.appendedContext);
          }
          if (NATIVE_SUBAGENT_STOP_TOOL_NAMES.has(definition.name)) {
            const subagentStopHooks = await runWorkspaceToolLifecycleHooks(
              options,
              definition,
              'SubagentStop',
              normalizedInput,
              output.isError ? 'failed' : 'completed',
              {
                ok: output.ok,
                isError: output.isError,
                summary: output.summary
              }
            );
            appendedContext.push(...subagentStopHooks.appendedContext);
          }
          return appendLifecycleHookContextToToolOutput(output, appendedContext);
        }
      })
    ])
  );
}
