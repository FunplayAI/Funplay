import type { GenericAgentRuntimeParams } from '../types';
import { resolveAgentToolPermission } from '../permission-broker';
import { getAgentToolDefinition } from '../tool-registry';
import type { WorkspaceToolAction } from '../workspace-tools';
import type { AgentPermissionImpact } from '../../../../shared/types';

export type NativeToolPermissionDecision = 'allow' | 'deny';

export interface NativeToolPermissionContext {
  permission: GenericAgentRuntimeParams['permission'];
  requestPermission?: GenericAgentRuntimeParams['requestPermission'];
}

export interface NativeToolPermissionRequest {
  toolName: string;
  input?: Record<string, unknown>;
  isWrite: boolean;
  title?: string;
  detail?: string;
  risk?: 'low' | 'medium' | 'high';
  mcp?: NonNullable<AgentPermissionImpact['mcp']>;
}

export async function resolveNativeToolPermission(
  context: NativeToolPermissionContext | undefined,
  request: NativeToolPermissionRequest
): Promise<NativeToolPermissionDecision> {
  const registeredTool = getAgentToolDefinition(request.toolName as WorkspaceToolAction['type']);
  const tool = registeredTool ?? {
    name: request.toolName,
    title: request.toolName,
    risk: request.risk ?? 'medium',
    readOnly: !request.isWrite,
    permissionPolicy: request.isWrite ? 'ask' as const : 'always' as const,
    checkpointPolicy: request.isWrite ? 'external_best_effort' as const : 'none' as const
  };
  // Tools can flag inputs that must be explicitly approved every run (e.g. run_command
  // with unsandboxed:true). Strip pre-approvals and allow-rules so the broker always
  // prompts; deny rules are kept because deny still wins.
  const forceExplicitApproval = registeredTool?.requiresExplicitApproval?.(request.input) === true;
  const effectiveContext = forceExplicitApproval && context
    ? {
        permission: {
          ...context.permission,
          allowWriteTools: false,
          allowSessionWriteTools: false,
          allowedWriteTools: [],
          allowedMcpTools: [],
          rules: context.permission.rules?.filter((rule) => rule.action === 'deny')
        },
        requestPermission: context.requestPermission
      }
    : context;
  return resolveAgentToolPermission(effectiveContext, {
    tool,
    input: request.input,
    title: request.title,
    detail: request.detail,
    risk: request.risk,
    mcp: request.mcp
  });
}
