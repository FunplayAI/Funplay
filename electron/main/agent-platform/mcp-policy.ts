import type { AgentToolCheckpointPolicy, AgentToolPermissionPolicy, AgentToolRisk } from './tool-registry-core';
import type { McpPlugin, McpToolPermissionPolicy, McpToolRiskPolicy } from '../../../shared/types';

export interface ResolvedMcpToolPolicy {
  permission: Exclude<McpToolPermissionPolicy, 'infer'>;
  riskPolicy: Exclude<McpToolRiskPolicy, 'infer'>;
  readOnly: boolean;
  risk: AgentToolRisk;
  permissionPolicy: AgentToolPermissionPolicy;
  checkpointPolicy: AgentToolCheckpointPolicy;
  source: 'tool' | 'server' | 'inferred';
  summary: string;
}

export function inferMcpToolReadOnly(toolName: string): boolean {
  if (/(execute|write|edit|create|delete|remove|apply|patch|save|import|install|play_mode|enter_play_mode|exit_play_mode|set_|update|run|simulate|click|drag|press|type|scroll|select)/i.test(toolName)) {
    return false;
  }
  return /^(get|list|read|inspect|find|search|query|capture|take|screenshot|analyze|check|status|describe|browse|view)/i.test(toolName);
}

function normalizePermission(input: McpToolPermissionPolicy | undefined, fallback: Exclude<McpToolPermissionPolicy, 'infer'>): Exclude<McpToolPermissionPolicy, 'infer'> {
  return input && input !== 'infer' ? input : fallback;
}

function normalizeRisk(input: McpToolRiskPolicy | undefined, fallback: Exclude<McpToolRiskPolicy, 'infer'>): Exclude<McpToolRiskPolicy, 'infer'> {
  return input && input !== 'infer' ? input : fallback;
}

export function resolveMcpToolPolicy(plugin: McpPlugin, toolName: string): ResolvedMcpToolPolicy {
  const toolOverride = plugin.toolPolicies?.[toolName];
  const inferredReadOnly = inferMcpToolReadOnly(toolName);
  const defaultRisk: Exclude<McpToolRiskPolicy, 'infer'> = inferredReadOnly ? 'read' : 'write';
  const riskPolicy = normalizeRisk(toolOverride?.risk, normalizeRisk(plugin.defaultToolRisk, defaultRisk));
  const readOnly = riskPolicy === 'read';
  const inferredPermission: Exclude<McpToolPermissionPolicy, 'infer'> = readOnly ? 'allow' : 'ask';
  const permission = normalizePermission(toolOverride?.permission, normalizePermission(plugin.defaultToolPermission, inferredPermission));
  const source = toolOverride?.permission || toolOverride?.risk
    ? 'tool'
    : plugin.defaultToolPermission || plugin.defaultToolRisk
      ? 'server'
      : 'inferred';
  const risk = readOnly ? 'low' : 'high';
  const permissionPolicy = permission === 'allow' ? 'always' : 'ask';
  const checkpointPolicy = readOnly ? 'none' : 'external_best_effort';

  return {
    permission,
    riskPolicy,
    readOnly,
    risk,
    permissionPolicy,
    checkpointPolicy,
    source,
    summary: `MCP policy ${source}: permission=${permission}, risk=${riskPolicy}`
  };
}
