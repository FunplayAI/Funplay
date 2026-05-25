import { z } from 'zod';
import type { McpPlugin, UnityMcpTool } from '../../../../shared/types';
import { nowIso } from '../../../../shared/utils';
import { tryRecordMcpToolSnapshots } from '../../store';
import { listUnityTools } from '../../unity-mcp-client';
import { resolveMcpToolPolicy } from '../mcp-policy';
import { makeSessionMcpToolPermissionKey } from '../permission-session-store';
import type { NativeRuntimeToolDefinition } from './tool-adapter';
import type { WorkspaceToolActionResult } from '../workspace-tools';

export interface NativeMcpMaterializationFailure {
  pluginId: string;
  pluginName: string;
  message: string;
}

export interface NativeMcpMaterializationResult {
  tools: NativeRuntimeToolDefinition[];
  failures: NativeMcpMaterializationFailure[];
}

const MAX_OPENAI_TOOL_NAME_LENGTH = 64;
const MCP_PROTOCOL_RESULT_MAX_CHARS = 9_000;
const MCP_CLASSIFIER_PREVIEW_CHARS = 640;
const MCP_TOOL_INPUT_SCHEMA = z.object({}).catchall(z.unknown());

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeToolNameSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function truncateToolNameSegment(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).replace(/_+$/g, '') || value.slice(0, maxLength);
}

function makeMcpToolName(plugin: McpPlugin, mcpTool: UnityMcpTool, usedNames: Set<string>): string {
  const serverSlug = truncateToolNameSegment(
    sanitizeToolNameSegment(plugin.name || plugin.id, 'server'),
    22
  );
  const toolSlug = sanitizeToolNameSegment(mcpTool.name, 'tool');
  const basePrefix = `mcp__${serverSlug}__`;
  const availableToolLength = Math.max(8, MAX_OPENAI_TOOL_NAME_LENGTH - basePrefix.length);
  const baseName = `${basePrefix}${truncateToolNameSegment(toolSlug, availableToolLength)}`;
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`;
    const trimmedBase = baseName.slice(0, MAX_OPENAI_TOOL_NAME_LENGTH - suffixText.length).replace(/_+$/g, '');
    candidate = `${trimmedBase}${suffixText}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function normalizeInputJsonSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized = isRecord(schema) ? { ...schema } : {};
  delete normalized.$schema;
  if (normalized.type !== 'object') {
    normalized.type = 'object';
  }
  if (!isRecord(normalized.properties)) {
    normalized.properties = {};
  }
  if (normalized.required !== undefined && !Array.isArray(normalized.required)) {
    delete normalized.required;
  }
  return normalized;
}

function compactMcpText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = `\n\n[${label} truncated by Funplay: original ${value.length} chars]\n\n`;
  const tailChars = Math.min(1600, Math.floor(maxChars / 3));
  const headChars = Math.max(0, maxChars - marker.length - tailChars);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function compactMcpClassifierValue(value: unknown, maxChars = MCP_CLASSIFIER_PREVIEW_CHARS): unknown {
  if (typeof value === 'string') {
    return {
      length: value.length,
      preview: value.length > maxChars ? value.slice(0, maxChars) : value,
      truncated: value.length > maxChars || undefined
    };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      count: value.length,
      items: value.slice(0, 8).map((item) => compactMcpClassifierValue(item, Math.floor(maxChars / 2)))
    };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 16).map(([key, item]) => [
      key,
      compactMcpClassifierValue(item, Math.floor(maxChars / 2))
    ]));
  }
  return String(value);
}

function mcpJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? {})?.length ?? 0;
  } catch {
    return 0;
  }
}

function mapDynamicMcpResultToProtocolResult(result: WorkspaceToolActionResult): ReturnType<NonNullable<NativeRuntimeToolDefinition['mapToolResultToProtocolResult']>> {
  const mcp = result.mcp;
  return {
    content: compactMcpText([
      mcp ? `MCP operation: ${mcp.operation}` : '',
      mcp ? `Target: ${mcp.target}` : '',
      mcp?.exposedName ? `Exposed name: ${mcp.exposedName}` : '',
      mcp?.pluginId ? `Plugin: ${mcp.pluginId}` : '',
      mcp?.policySummary ? `Policy: ${mcp.policySummary}` : '',
      mcp ? `Schema guard: ${mcp.schemaGuard}` : '',
      mcp?.argsSize !== undefined ? `Args size: ${mcp.argsSize}` : '',
      mcp?.contentPartCount !== undefined ? `Content parts: ${mcp.contentPartCount}` : '',
      mcp?.failureKind ? `Failure: ${mcp.failureKind}` : '',
      result.summary
    ].filter(Boolean).join('\n'), MCP_PROTOCOL_RESULT_MAX_CHARS, 'mcp protocol result'),
    isError: result.isError,
    failureKind: result.mcp?.failureKind,
    media: result.media,
    changedFiles: result.changedFiles,
    command: result.command,
    terminal: result.terminal,
    browser: result.browser,
    edit: result.edit,
    mcp: result.mcp,
    artifacts: result.artifacts
  };
}

function toNativeMcpToolDefinition(plugin: McpPlugin, mcpTool: UnityMcpTool, usedNames: Set<string>): NativeRuntimeToolDefinition | undefined {
  const policy = resolveMcpToolPolicy(plugin, mcpTool.name);
  if (policy.permission === 'deny') {
    return undefined;
  }
  const name = makeMcpToolName(plugin, mcpTool, usedNames);
  const title = `${plugin.name}: ${mcpTool.name}`;
  const description = [
    `MCP tool from ${plugin.name}.`,
    `Original MCP tool name: ${mcpTool.name}.`,
    `Policy: ${policy.summary}.`,
    mcpTool.description ?? ''
  ].filter(Boolean).join(' ');

  return {
    name,
    title,
    description,
    inputSchema: MCP_TOOL_INPUT_SCHEMA,
    inputJsonSchema: normalizeInputJsonSchema(mcpTool.inputSchema),
    risk: policy.risk,
    permissionPolicy: policy.permissionPolicy,
    checkpointPolicy: policy.checkpointPolicy,
    readOnly: policy.readOnly,
    aliases: [mcpTool.name],
    toolLanguage: {
      family: 'mcp',
      canonicalName: 'MCP',
      aliases: [mcpTool.name],
      usageHint: policy.readOnly
        ? `Read ${mcpTool.name} through ${plugin.name}.`
        : `Call ${mcpTool.name} through ${plugin.name}; host policy and permission apply.`,
      failureHint: 'If this direct MCP tool disappears, list MCP tools and retry through call_mcp_tool with the original MCP name.'
    },
    mcp: {
      permissionKey: makeSessionMcpToolPermissionKey(plugin.id, mcpTool.name),
      pluginId: plugin.id,
      pluginName: plugin.name,
      toolName: mcpTool.name,
      policySource: policy.source,
      permission: policy.permission,
      risk: policy.riskPolicy
    },
    userFacingName: () => title,
    getActivityDescription: () => policy.readOnly
      ? `Reading MCP tool ${plugin.name} / ${mcpTool.name}`
      : `Calling MCP tool ${plugin.name} / ${mcpTool.name}`,
    getToolUseSummary: () => `${plugin.name} / ${mcpTool.name}`,
    render: () => ({
      title,
      summary: policy.summary,
      activity: policy.readOnly
        ? `Reading MCP tool ${mcpTool.name}`
        : `Calling MCP tool ${mcpTool.name}`
    }),
    progress: (_input, context) => ({
      activity: context.phase === 'running'
        ? (policy.readOnly ? `Reading MCP tool ${mcpTool.name}` : `Calling MCP tool ${mcpTool.name}`)
        : `${context.phase} ${mcpTool.name}`,
      summary: policy.summary
    }),
    toAutoClassifierInput: (input) => ({
      toolClass: 'mcp',
      pluginId: plugin.id,
      pluginName: plugin.name,
      toolName: mcpTool.name,
      exposedName: name,
      inferredReadOnly: policy.readOnly,
      policy: policy.summary,
      argsSize: mcpJsonSize(input),
      args: compactMcpClassifierValue(input)
    }),
    getPermissionDetail: (input) => [
      `工具：${title}`,
      `MCP 原名：${mcpTool.name}`,
      `策略：${policy.summary}`,
      `参数：${compactMcpText(JSON.stringify(compactMcpClassifierValue(input), null, 2), 1200, 'mcp permission detail')}`
    ].join('\n'),
    mapToolResultToProtocolResult: (result) => mapDynamicMcpResultToProtocolResult(result),
    extractSearchText: (result) => [
      title,
      policy.summary,
      result.summary,
      result.mcp?.target ? `MCP target: ${result.mcp.target}` : ''
    ].filter(Boolean).join('\n'),
    isConcurrencySafe: () => policy.readOnly,
    toAction: (input) => ({
      type: 'call_mcp_tool',
      pluginId: plugin.id,
      toolName: mcpTool.name,
      args: input,
      exposedToolName: name,
      mcpPolicySummary: policy.summary
    })
  };
}

export async function materializeNativeMcpTools(input: {
  plugins?: McpPlugin[];
  abortSignal?: AbortSignal;
}): Promise<NativeMcpMaterializationResult> {
  const plugins = (input.plugins ?? []).filter((plugin) =>
    plugin.enabled && (plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl.trim()))
  );
  const usedNames = new Set<string>();
  const tools: NativeRuntimeToolDefinition[] = [];
  const failures: NativeMcpMaterializationFailure[] = [];

  const results = await Promise.all(plugins.map(async (plugin) => {
    try {
      const mcpTools = await listUnityTools(plugin, input.abortSignal);
      return {
        plugin,
        mcpTools
      };
    } catch (error) {
      return {
        plugin,
        failure: {
          pluginId: plugin.id,
          pluginName: plugin.name,
          message: error instanceof Error ? error.message : 'MCP tools/list failed.'
        }
      };
    }
  }));

  const discoveredAt = nowIso();
  for (const result of results) {
    if ('failure' in result && result.failure) {
      failures.push(result.failure);
      continue;
    }
    const snapshotInputs = [];
    for (const mcpTool of result.mcpTools) {
      const policy = resolveMcpToolPolicy(result.plugin, mcpTool.name);
      const definition = toNativeMcpToolDefinition(result.plugin, mcpTool, usedNames);
      snapshotInputs.push({
        pluginId: result.plugin.id,
        pluginName: result.plugin.name,
        originalName: mcpTool.name,
        exposedName: definition?.name ?? '',
        description: mcpTool.description,
        inputSchema: mcpTool.inputSchema,
        policySummary: policy.summary,
        discoveredAt
      });
      if (definition) {
        tools.push(definition);
      }
    }
    tryRecordMcpToolSnapshots(snapshotInputs, {
      pluginId: result.plugin.id,
      pluginName: result.plugin.name,
      discoveredAt
    });
  }

  return {
    tools,
    failures
  };
}
