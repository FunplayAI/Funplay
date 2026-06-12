import { z } from 'zod';
import type { AgentVerificationTrigger, Project } from '../../../shared/types';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from './workspace-tools';

export type AgentToolRisk = 'low' | 'medium' | 'high';
export type AgentToolPermissionPolicy = 'always' | 'session' | 'ask';
export type AgentToolCheckpointPolicy = 'none' | 'before_write' | 'external_best_effort';
export type AgentToolLanguageFamily =
  | 'interaction'
  | 'planning'
  | 'read'
  | 'search'
  | 'web'
  | 'media'
  | 'game'
  | 'engine'
  | 'edit'
  | 'command'
  | 'terminal'
  | 'browser'
  | 'checkpoint'
  | 'mcp'
  | 'memory'
  | 'notification'
  | 'subagent'
  | 'generic';

export interface AgentToolLanguageMetadata {
  family: AgentToolLanguageFamily;
  canonicalName?: string;
  aliases?: string[];
  usageHint?: string;
  failureHint?: string;
  resultHint?: string;
}

export type AgentToolSideEffectKind = 'none' | 'workspace_write' | 'engine' | 'external';
export type AgentToolSideEffectConfidence = 'none' | 'medium' | 'high';

export interface AgentToolSideEffectClassification {
  kind: AgentToolSideEffectKind;
  confidence: AgentToolSideEffectConfidence;
  verificationTrigger?: AgentVerificationTrigger;
  evidence: string[];
}

export interface AgentToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: WorkspaceToolAction['type'];
  title: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  risk: AgentToolRisk;
  permissionPolicy: AgentToolPermissionPolicy;
  checkpointPolicy: AgentToolCheckpointPolicy;
  readOnly: boolean;
  aliases?: string[];
  toolLanguage?: AgentToolLanguageMetadata;
  validateInput?: (input: TInput, context: AgentToolValidationContext) => Promise<AgentToolValidationResult | undefined> | AgentToolValidationResult | undefined;
  checkPermissions?: (input: TInput, context: AgentToolPermissionCheckContext) => Promise<WorkspaceToolActionResult | undefined> | WorkspaceToolActionResult | undefined;
  /** When true for a given input, session/global pre-approvals are bypassed and the user is prompted every time. */
  requiresExplicitApproval?: (input: Partial<TInput> | undefined) => boolean;
  getPermissionDetail?: (input: TInput, context: AgentToolPermissionCheckContext) => string | undefined;
  isConcurrencySafe?: (input: Partial<TInput> | undefined) => boolean;
  classifySideEffect?: (input: Partial<TInput> | undefined) => AgentToolSideEffectClassification;
  render?: (input: Partial<TInput> | undefined) => AgentToolRenderResult | undefined;
  progress?: (input: Partial<TInput> | undefined, context: AgentToolProgressContext) => AgentToolProgressResult | undefined;
  mapResult?: (result: WorkspaceToolActionResult, context: AgentToolResultMappingContext<TInput>) => WorkspaceToolActionResult;
  mapToolResultToProtocolResult?: (result: WorkspaceToolActionResult, context: AgentToolResultMappingContext<TInput>) => AgentToolProtocolResult;
  extractSearchText?: (result: WorkspaceToolActionResult, context: AgentToolResultMappingContext<TInput>) => string | undefined;
  userFacingName?: (input: Partial<TInput> | undefined) => string;
  toAutoClassifierInput?: (input: TInput) => unknown;
  getActivityDescription?: (input: Partial<TInput> | undefined) => string | null | undefined;
  getToolUseSummary?: (input: Partial<TInput> | undefined) => string | null | undefined;
  toAction: (input: TInput) => WorkspaceToolAction;
}

export interface AgentToolValidationContext {
  project: Project;
  permissionMode?: string;
  toolName: string;
  readOnly: boolean;
}

export interface AgentToolValidationResult {
  ok: false;
  summary: string;
  failureKind?: string;
  recoveryHint?: string;
}

export interface AgentToolPermissionCheckContext extends AgentToolValidationContext {
  risk: AgentToolRisk;
  permissionPolicy: AgentToolPermissionPolicy;
}

export interface AgentToolRenderResult {
  title?: string;
  summary?: string;
  activity?: string;
}

export interface AgentToolProgressContext {
  phase: 'queued' | 'running' | 'completed' | 'failed';
}

export interface AgentToolProgressResult {
  activity?: string;
  summary?: string;
}

export interface AgentToolProtocolResult {
  content: string;
  isError?: boolean;
  failureKind?: string;
  recoveryHint?: string;
  media?: WorkspaceToolActionResult['media'];
  changedFiles?: WorkspaceToolActionResult['changedFiles'];
  command?: WorkspaceToolActionResult['command'];
  terminal?: WorkspaceToolActionResult['terminal'];
  browser?: WorkspaceToolActionResult['browser'];
  edit?: WorkspaceToolActionResult['edit'];
  mcp?: WorkspaceToolActionResult['mcp'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
  searchText?: string;
}

export interface AgentToolResultMappingContext<TInput extends Record<string, unknown> = Record<string, unknown>> extends AgentToolValidationContext {
  input: TInput;
}

const staticTools = new Map<WorkspaceToolAction['type'], AgentToolDefinition>();

export function registerAgentTool<TInput extends Record<string, unknown>>(definition: AgentToolDefinition<TInput>): void {
  staticTools.set(definition.name, definition as AgentToolDefinition);
}

export function updateAgentToolDefinition<TInput extends Record<string, unknown>>(
  name: WorkspaceToolAction['type'],
  patch: Partial<AgentToolDefinition<TInput>>
): void {
  const current = staticTools.get(name);
  if (!current) {
    throw new Error(`Cannot update unknown agent tool: ${name}`);
  }
  staticTools.set(name, {
    ...current,
    ...patch
  } as AgentToolDefinition);
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
