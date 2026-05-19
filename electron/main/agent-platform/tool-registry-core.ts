import { z } from 'zod';
import type { WorkspaceToolAction } from './workspace-tools';

export type AgentToolRisk = 'low' | 'medium' | 'high';
export type AgentToolPermissionPolicy = 'always' | 'session' | 'ask';
export type AgentToolCheckpointPolicy = 'none' | 'before_write' | 'external_best_effort';

export interface AgentToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: WorkspaceToolAction['type'];
  title: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  risk: AgentToolRisk;
  permissionPolicy: AgentToolPermissionPolicy;
  checkpointPolicy: AgentToolCheckpointPolicy;
  readOnly: boolean;
  toAction: (input: TInput) => WorkspaceToolAction;
}

const staticTools = new Map<WorkspaceToolAction['type'], AgentToolDefinition>();

export function registerAgentTool<TInput extends Record<string, unknown>>(definition: AgentToolDefinition<TInput>): void {
  staticTools.set(definition.name, definition as AgentToolDefinition);
}

export function getAgentToolDefinition(name: WorkspaceToolAction['type']): AgentToolDefinition | undefined {
  return staticTools.get(name);
}

export function listAgentToolDefinitions(): AgentToolDefinition[] {
  return [...staticTools.values()];
}

export function listReadOnlyWorkspaceToolDefinitions(): AgentToolDefinition[] {
  return listAgentToolDefinitions().filter((tool) => tool.readOnly);
}

export function listWritableToolDefinitions(): AgentToolDefinition[] {
  return listAgentToolDefinitions().filter((tool) => !tool.readOnly);
}
