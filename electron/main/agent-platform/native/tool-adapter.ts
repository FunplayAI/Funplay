import { tool, type ToolSet } from 'ai';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLifecycleHookConfig, AgentLifecycleHookEvaluationResult, AgentPermissionImpact, AppState, McpPlugin, Project } from '../../../../shared/types';
import { resolveNativeToolPermission, type NativeToolPermissionContext } from './tool-permission';
import { getAgentToolDefinition, listReadOnlyWorkspaceToolDefinitions, type AgentToolDefinition } from '../tool-registry';
import { executeAgentToolAction, type AgentToolExecutionOptions, type WorkspaceToolAction, type WorkspaceToolActionResult } from '../workspace-tools';
import { resolveMcpToolPolicy, type ResolvedMcpToolPolicy } from '../mcp-policy';
import { makeSessionMcpToolPermissionKey } from '../permission-session-store';
import { runAgentLifecycleHooks, type AgentLifecycleHookStageEvent } from '../agent-hooks';
import type { ProjectInstructionGuardResult } from '../project-instruction-tracker';
import type { AgentToolFamily } from '../tool-policy';

export const NATIVE_TOOL_OUTPUT_MAX_CHARS = 12_000;
const NATIVE_TOOL_OUTPUT_TAIL_CHARS = 2_000;
const NATIVE_TOOL_OUTPUT_ARTIFACT_DIR = 'funplay-agent-artifacts';

export const NATIVE_READ_ONLY_WORKSPACE_TOOL_NAMES = listReadOnlyWorkspaceToolDefinitions().map((definition) => definition.name);
export const NATIVE_WRITE_WORKSPACE_TOOL_NAMES = ['create_directory', 'write_file', 'edit_file', 'multi_edit', 'patch_file', 'checkpoint_rollback', 'funplay_memory_remember', 'funplay_schedule_task', 'funplay_cancel_task', 'media_save_base64', 'image_generate', 'generate_asset', 'import_generated_asset', 'open_engine_hub', 'open_engine_project', 'install_engine_bridge'] as const;
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
  appState?: AppState;
  persistAppState?: AgentToolExecutionOptions['persistAppState'];
  permissionContext?: NativeToolPermissionContext;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
  allowedToolFamilies?: AgentToolFamily[];
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
  projectInstructionGuard?: (input: {
    toolName: string;
    input: Record<string, unknown>;
  }) => ProjectInstructionGuardResult | undefined;
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
  aliases?: AgentToolDefinition<TInput>['aliases'];
  toolLanguage?: AgentToolDefinition<TInput>['toolLanguage'];
  mcp?: NonNullable<AgentPermissionImpact['mcp']>;
  validateInput?: AgentToolDefinition<TInput>['validateInput'];
  checkPermissions?: AgentToolDefinition<TInput>['checkPermissions'];
  getPermissionDetail?: AgentToolDefinition<TInput>['getPermissionDetail'];
  isConcurrencySafe?: AgentToolDefinition<TInput>['isConcurrencySafe'];
  classifySideEffect?: AgentToolDefinition<TInput>['classifySideEffect'];
  render?: AgentToolDefinition<TInput>['render'];
  progress?: AgentToolDefinition<TInput>['progress'];
  mapResult?: AgentToolDefinition<TInput>['mapResult'];
  mapToolResultToProtocolResult?: AgentToolDefinition<TInput>['mapToolResultToProtocolResult'];
  extractSearchText?: AgentToolDefinition<TInput>['extractSearchText'];
  userFacingName?: AgentToolDefinition<TInput>['userFacingName'];
  toAutoClassifierInput?: AgentToolDefinition<TInput>['toAutoClassifierInput'];
  getActivityDescription?: AgentToolDefinition<TInput>['getActivityDescription'];
  getToolUseSummary?: AgentToolDefinition<TInput>['getToolUseSummary'];
  toAction?: (input: TInput) => WorkspaceToolAction;
  execute?: (input: TInput) => Promise<WorkspaceToolActionResult>;
}

export interface NativeRuntimeToolUsePresentation {
  title?: string;
  summary?: string;
  activity?: string;
}

function normalizeToolNameForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function candidateNativeRuntimeToolNames(definition: NativeRuntimeToolDefinition): string[] {
  return [
    definition.name,
    definition.toolLanguage?.canonicalName,
    ...(definition.aliases ?? []),
    ...(definition.toolLanguage?.aliases ?? [])
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function resolveNativeRuntimeToolDefinition(
  toolName: string,
  definitions: NativeRuntimeToolDefinition[]
): NativeRuntimeToolDefinition | undefined {
  const trimmed = toolName.trim();
  const exact = definitions.find((definition) => definition.name === trimmed);
  if (exact) {
    return exact;
  }
  const exactAlias = definitions.find((definition) =>
    candidateNativeRuntimeToolNames(definition).some((candidate) => candidate === trimmed)
  );
  if (exactAlias) {
    return exactAlias;
  }
  const lowered = trimmed.toLowerCase();
  const caseInsensitive = definitions.find((definition) =>
    candidateNativeRuntimeToolNames(definition).some((candidate) => candidate.toLowerCase() === lowered)
  );
  if (caseInsensitive) {
    return caseInsensitive;
  }
  const normalized = normalizeToolNameForMatch(trimmed);
  return definitions.find((definition) =>
    candidateNativeRuntimeToolNames(definition).some((candidate) => normalizeToolNameForMatch(candidate) === normalized)
  );
}

export function resolveNativeRuntimeToolName(
  toolName: string,
  definitions: NativeRuntimeToolDefinition[]
): string | undefined {
  return resolveNativeRuntimeToolDefinition(toolName, definitions)?.name;
}

export function describeNativeRuntimeToolUse(input: {
  definitions: NativeRuntimeToolDefinition[];
  toolName: string;
  toolInput?: Record<string, unknown>;
}): NativeRuntimeToolUsePresentation {
  const definition = resolveNativeRuntimeToolDefinition(input.toolName, input.definitions);
  if (!definition) {
    return {};
  }
  const toolInput = input.toolInput;
  const rendered = definition.render?.(toolInput);
  const progress = definition.progress?.(toolInput, { phase: 'running' });
  const summary = definition.getToolUseSummary?.(toolInput);
  const activity = definition.getActivityDescription?.(toolInput);
  const userFacingName = definition.userFacingName?.(toolInput);
  return {
    title: rendered?.title ?? userFacingName ?? definition.title,
    summary: rendered?.summary ?? summary ?? progress?.summary ?? undefined,
    activity: rendered?.activity ?? activity ?? progress?.activity ?? summary ?? userFacingName ?? definition.title
  };
}

function describeNativeRuntimeToolForModel(definition: NativeRuntimeToolDefinition): string {
  const language = definition.toolLanguage;
  return [
    definition.description,
    language?.canonicalName ? `Claude-like tool role: ${language.canonicalName}.` : '',
    language?.aliases?.length ? `Aliases the model may think of: ${language.aliases.join(', ')}.` : '',
    language?.usageHint ? `Use when: ${language.usageHint}` : '',
    language?.failureHint ? `If it fails: ${language.failureHint}` : ''
  ].filter(Boolean).join('\n');
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
  searchText?: string;
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

function sanitizeNativeArtifactSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tool';
}

function hasCommandOutputArtifact(artifacts: WorkspaceToolActionResult['artifacts'] | undefined): boolean {
  return artifacts?.some((artifact) => artifact.type === 'command_output') ?? false;
}

function summarizeToolInputKeys(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return keys.length > 0 ? keys.join(', ') : 'none';
}

async function writeNativeToolOutputArtifact(input: {
  options: NativeWorkspaceToolAdapterOptions;
  definition: NativeRuntimeToolDefinition;
  toolInput: Record<string, unknown>;
  source: 'workspace_result' | 'protocol_result';
  content: string;
}): Promise<NonNullable<WorkspaceToolActionResult['artifacts']>[number] | undefined> {
  try {
    const output = [
      `Tool: ${input.definition.name}`,
      `Title: ${input.definition.title}`,
      `Project: ${input.options.project.name} (${input.options.project.id})`,
      `Source: ${input.source}`,
      `Original output length: ${input.content.length} chars`,
      `Input keys: ${summarizeToolInputKeys(input.toolInput)}`,
      '',
      input.content
    ].join('\n');
    const artifactDir = join(
      tmpdir(),
      NATIVE_TOOL_OUTPUT_ARTIFACT_DIR,
      sanitizeNativeArtifactSegment(input.options.project.id)
    );
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(
      artifactDir,
      `${Date.now()}-${sanitizeNativeArtifactSegment(input.definition.name)}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    await writeFile(artifactPath, output, 'utf8');
    return {
      type: 'command_output',
      path: artifactPath,
      title: `${input.definition.name} output`,
      mimeType: 'text/plain',
      size: Buffer.byteLength(output, 'utf8')
    };
  } catch {
    return undefined;
  }
}

async function attachTruncatedToolOutputArtifact<T extends ReturnType<typeof toToolOutput>>(input: {
  options: NativeWorkspaceToolAdapterOptions;
  definition: NativeRuntimeToolDefinition;
  toolInput: Record<string, unknown>;
  output: T;
  source: 'workspace_result' | 'protocol_result';
  originalContent: string;
  truncated: boolean;
}): Promise<T> {
  if (!input.truncated || hasCommandOutputArtifact(input.output.artifacts)) {
    return input.output;
  }
  const artifact = await writeNativeToolOutputArtifact({
    options: input.options,
    definition: input.definition,
    toolInput: input.toolInput,
    source: input.source,
    content: input.originalContent
  });
  if (!artifact) {
    return input.output;
  }
  return {
    ...input.output,
    artifacts: [
      ...(input.output.artifacts ?? []),
      artifact
    ]
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
  const allowedFamilies = options.allowedToolFamilies ? new Set(options.allowedToolFamilies) : undefined;
  return [...readOnlyTools, ...writeTools, ...mcpToolCalls, ...(options.dynamicTools ?? []), ...commandTools]
    .filter((definition) => !excluded.has(definition.name as WorkspaceToolAction['type']))
    .filter((definition) => !allowedFamilies || allowedFamilies.has(resolveNativeAgentToolFamily(definition)));
}

export function listNativeWorkspaceToolNames(options: Pick<NativeWorkspaceToolAdapterOptions, 'includeWriteTools' | 'includeMcpToolCalls' | 'includeCommandTools' | 'allowedToolFamilies' | 'excludeTools'> = {}): string[] {
  return listNativeWorkspaceToolDefinitions(options as NativeWorkspaceToolAdapterOptions).map((definition) => definition.name);
}

function resolveNativeAgentToolFamily(definition: NativeRuntimeToolDefinition): AgentToolFamily {
  const family = definition.toolLanguage?.family;
  if (family === 'memory') {
    return 'memory';
  }
  if (family === 'notification') {
    return 'notification';
  }
  if (family === 'mcp') {
    return 'mcp';
  }
  if (family === 'browser') {
    return 'browser';
  }
  if (family === 'engine') {
    return 'engine';
  }
  if (family === 'media') {
    return 'media';
  }
  if (family === 'command' || family === 'terminal') {
    return 'command';
  }
  if (!definition.readOnly || family === 'edit' || family === 'checkpoint') {
    return 'workspace_write';
  }
  return 'read_only';
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
  const toolInput = (input ?? {}) as Record<string, unknown>;
  const validation = await definition.validateInput?.((input ?? {}) as Record<string, unknown>, {
    project: options.project,
    permissionMode: options.permissionContext?.permission.mode,
    toolName: definition.name,
    readOnly: definition.readOnly
  });
  if (validation) {
    return {
      ok: false,
      isError: true,
      summary: [
        validation.summary,
        validation.recoveryHint ? `Recovery: ${validation.recoveryHint}` : ''
      ].filter(Boolean).join('\n')
    };
  }
  const permissionResult = await definition.checkPermissions?.(toolInput, {
    project: options.project,
    permissionMode: options.permissionContext?.permission.mode,
    toolName: definition.name,
    readOnly: definition.readOnly,
    risk: definition.risk,
    permissionPolicy: definition.permissionPolicy
  });
  if (permissionResult) {
    return permissionResult;
  }
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
  const risk = mcpPermission?.policy.risk ?? definition.risk;
  const permissionPolicy = mcpPermission?.policy.permissionPolicy ?? definition.permissionPolicy;
  const permissionDetail = definition.getPermissionDetail?.(toolInput, {
    project: options.project,
    permissionMode: options.permissionContext?.permission.mode,
    toolName: definition.name,
    readOnly: definition.readOnly,
    risk,
    permissionPolicy
  });
  const decision = await resolveNativeToolPermission(options.permissionContext, {
    toolName: definition.name,
    input,
    isWrite: mcpPermission ? !mcpPermission.policy.readOnly : !definition.readOnly,
    risk,
    title: `允许 Agent 执行工具：${definition.title}？`,
    detail: permissionDetail,
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

function mapNativeRuntimeToolResult(
  options: NativeWorkspaceToolAdapterOptions,
  definition: NativeRuntimeToolDefinition,
  input: Record<string, unknown>,
  result: WorkspaceToolActionResult
): WorkspaceToolActionResult {
  return definition.mapResult?.(result, {
    project: options.project,
    permissionMode: options.permissionContext?.permission.mode,
    toolName: definition.name,
    readOnly: definition.readOnly,
    input
  }) ?? result;
}

async function toMappedToolOutput(
  options: NativeWorkspaceToolAdapterOptions,
  definition: NativeRuntimeToolDefinition,
  input: Record<string, unknown>,
  result: WorkspaceToolActionResult
): Promise<ReturnType<typeof toToolOutput>> {
  const mapped = mapNativeRuntimeToolResult(options, definition, input, result);
  const mappingContext = {
    project: options.project,
    permissionMode: options.permissionContext?.permission.mode,
    toolName: definition.name,
    readOnly: definition.readOnly,
    input
  };
  const protocolResult = definition.mapToolResultToProtocolResult?.(mapped, mappingContext);
  const searchText = definition.extractSearchText?.(mapped, mappingContext);
  if (!protocolResult) {
    const output = {
      ...toToolOutput(mapped),
      searchText
    };
    return attachTruncatedToolOutputArtifact({
      options,
      definition,
      toolInput: input,
      output,
      source: 'workspace_result',
      originalContent: mapped.summary,
      truncated: Boolean(output.summaryTruncated)
    });
  }
  const compacted = compactToolSummary(protocolResult.content);
  const baseOutput = {
    ...toToolOutput(mapped),
    summaryTruncated: undefined,
    originalSummaryLength: undefined
  };
  const output = {
    ...baseOutput,
    ...protocolResult,
    summary: compacted.summary,
    artifacts: protocolResult.artifacts ?? baseOutput.artifacts,
    summaryTruncated: compacted.truncated || undefined,
    originalSummaryLength: compacted.truncated ? protocolResult.content.length : undefined,
    searchText: protocolResult.searchText ?? searchText
  };
  return attachTruncatedToolOutputArtifact({
    options,
    definition,
    toolInput: input,
    output,
    source: 'protocol_result',
    originalContent: protocolResult.content,
    truncated: compacted.truncated
  });
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

function projectInstructionGuardToWorkspaceResult(guard: ProjectInstructionGuardResult): WorkspaceToolActionResult {
  return {
    ok: false,
    isError: true,
    summary: guard.summary
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
        description: describeNativeRuntimeToolForModel(definition),
        inputSchema: definition.inputSchema,
        execute: async (input) => {
          const normalizedInput = (input ?? {}) as Record<string, unknown>;
          const preToolHooks = await runWorkspaceToolLifecycleHooks(options, definition, 'PreToolUse', normalizedInput);
          if (preToolHooks.blocked) {
            return await toMappedToolOutput(options, definition, normalizedInput, {
              ok: false,
              isError: true,
              summary: [
                `生命周期 Hook 阻止了工具 ${definition.name} 的执行。`,
                preToolHooks.blockReason ?? '该工具调用未执行。'
              ].filter(Boolean).join('\n')
            });
          }
          const executeTool = async () => {
            const projectInstructionGuard = options.projectInstructionGuard?.({
              toolName: definition.name,
              input: normalizedInput
            });
            if (projectInstructionGuard) {
              return await toMappedToolOutput(
                options,
                definition,
                normalizedInput,
                projectInstructionGuardToWorkspaceResult(projectInstructionGuard)
              );
            }
            const denied = await guardWorkspaceTool(options, definition, normalizedInput);
            if (denied) {
              return await toMappedToolOutput(options, definition, normalizedInput, denied);
            }
            if (definition.execute) {
              return await toMappedToolOutput(options, definition, normalizedInput, await definition.execute(normalizedInput));
            }
            if (!definition.toAction) {
              return await toMappedToolOutput(options, definition, normalizedInput, {
                ok: false,
                isError: true,
                summary: `工具 ${definition.name} 没有可执行动作。`
              });
            }
            const action = definition.toAction(normalizedInput);
            if (action.type === 'ask_user') {
              if (!options.requestUserInput) {
                return await toMappedToolOutput(options, definition, normalizedInput, {
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用用户输入请求器。'
                });
              }
              return await toMappedToolOutput(options, definition, normalizedInput, await options.requestUserInput(action));
            }
            if (action.type === 'run_subagent') {
              if (!options.runSubagent) {
                return await toMappedToolOutput(options, definition, normalizedInput, {
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用子任务执行器。'
                });
              }
              return await toMappedToolOutput(options, definition, normalizedInput, await options.runSubagent(action));
            }
            if (action.type === 'run_subagents') {
              if (!options.runSubagents) {
                return await toMappedToolOutput(options, definition, normalizedInput, {
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用并行子任务执行器。'
                });
              }
              return await toMappedToolOutput(options, definition, normalizedInput, await options.runSubagents(action));
            }
            if (action.type === 'subagent_start') {
              if (!options.startSubagent) {
                return await toMappedToolOutput(options, definition, normalizedInput, {
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用后台子任务执行器。'
                });
              }
              return await toMappedToolOutput(options, definition, normalizedInput, await options.startSubagent(action));
            }
            if (action.type === 'subagent_status') {
              if (!options.readSubagentStatus) {
                return await toMappedToolOutput(options, definition, normalizedInput, {
                  ok: false,
                  isError: true,
                  summary: '当前 Native tool loop 没有启用后台子任务状态读取器。'
                });
              }
              return await toMappedToolOutput(options, definition, normalizedInput, await options.readSubagentStatus(action));
            }
            return await toMappedToolOutput(
              options,
              definition,
              normalizedInput,
              await executeAgentToolAction(
                options.project,
                action,
                {
                  plugins: options.plugins,
                  checkpointSnapshotId: options.checkpointSnapshotId,
                  abortSignal: options.abortSignal,
                  appState: options.appState,
                  persistAppState: options.persistAppState,
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
