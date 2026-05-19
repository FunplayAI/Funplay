import { z } from 'zod';
import type { McpPlugin, UnityMcpTool } from '../../../../shared/types';
import { nowIso } from '../../../../shared/utils';
import { tryRecordMcpToolSnapshots } from '../../store';
import { listUnityTools } from '../../unity-mcp-client';
import { resolveMcpToolPolicy } from '../mcp-policy';
import { makeSessionMcpToolPermissionKey } from '../permission-session-store';
import type { NativeRuntimeToolDefinition } from './tool-adapter';

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
    mcp: {
      permissionKey: makeSessionMcpToolPermissionKey(plugin.id, mcpTool.name),
      pluginId: plugin.id,
      pluginName: plugin.name,
      toolName: mcpTool.name,
      policySource: policy.source,
      permission: policy.permission,
      risk: policy.riskPolicy
    },
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
