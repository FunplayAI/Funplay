import type { ProjectSessionRuntimeId, SessionWritePermissionGrant } from '../../../shared/types';

interface RuntimeGrantContext {
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
}

interface ActiveSessionWritePermissionGrant extends Omit<SessionWritePermissionGrant, 'tools' | 'mcpTools'> {
  sessionId: string;
  tools: Set<string>;
  mcpTools: Set<string>;
}

const sessionWritePermissionOverrides = new Map<string, ActiveSessionWritePermissionGrant>();
const defaultSessionGrantTtlMs = 1000 * 60 * 60 * 4;
export const DEFAULT_SESSION_WRITE_PERMISSION_TOOLS = ['create_directory', 'write_file', 'edit_file', 'apply_workspace_writes'] as const;
export const DEFAULT_SESSION_WRITE_PERMISSION_PRIMARY_TOOL = 'write_file';

export function makeSessionMcpToolPermissionKey(pluginId: string, toolName: string): string {
  return `${pluginId.trim()}:${toolName.trim()}`;
}

function nowMs(): number {
  return Date.now();
}

function contextMatches(grant: ActiveSessionWritePermissionGrant, context?: RuntimeGrantContext): boolean {
  if (!context) {
    return true;
  }
  if (grant.runtimeId && context.runtimeId && grant.runtimeId !== context.runtimeId) {
    return false;
  }
  if (grant.cwd && context.cwd && grant.cwd !== context.cwd) {
    return false;
  }
  return true;
}

function getActiveGrant(sessionId: string, context?: RuntimeGrantContext): ActiveSessionWritePermissionGrant | undefined {
  const grant = sessionWritePermissionOverrides.get(sessionId);
  if (!grant) {
    return undefined;
  }

  if (grant.expiresAt <= nowMs()) {
    sessionWritePermissionOverrides.delete(sessionId);
    return undefined;
  }

  return contextMatches(grant, context) ? grant : undefined;
}

export function grantSessionWritePermission(
  sessionId: string,
  options?: {
    tools?: string[];
    mcpTools?: string[];
    ttlMs?: number;
    runtimeId?: ProjectSessionRuntimeId;
    cwd?: string;
  }
): SessionWritePermissionGrant {
  const existing = getActiveGrant(sessionId, options);
  const defaultTools = options?.mcpTools?.length && options.tools === undefined ? [] : [...DEFAULT_SESSION_WRITE_PERMISSION_TOOLS];
  const tools = new Set([...(existing?.tools ?? []), ...(options?.tools ?? defaultTools)]);
  const mcpTools = new Set([...(existing?.mcpTools ?? []), ...(options?.mcpTools ?? [])]);
  const grantedAt = nowMs();
  const grant: ActiveSessionWritePermissionGrant = {
    sessionId,
    tools,
    mcpTools,
    grantedAt,
    expiresAt: grantedAt + (options?.ttlMs ?? defaultSessionGrantTtlMs),
    runtimeId: options?.runtimeId,
    cwd: options?.cwd
  };
  sessionWritePermissionOverrides.set(sessionId, grant);
  return {
    tools: [...tools].sort(),
    mcpTools: [...mcpTools].sort(),
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    runtimeId: grant.runtimeId,
    cwd: grant.cwd
  };
}

export function restoreSessionWritePermissionGrant(sessionId: string, grant: SessionWritePermissionGrant): void {
  if (grant.expiresAt <= nowMs()) {
    sessionWritePermissionOverrides.delete(sessionId);
    return;
  }
  sessionWritePermissionOverrides.set(sessionId, {
    sessionId,
    tools: new Set(grant.tools),
    mcpTools: new Set(grant.mcpTools ?? []),
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    runtimeId: grant.runtimeId,
    cwd: grant.cwd
  });
}

export function hasSessionWritePermission(sessionId: string, toolName = DEFAULT_SESSION_WRITE_PERMISSION_PRIMARY_TOOL, context?: RuntimeGrantContext): boolean {
  const grant = getActiveGrant(sessionId, context);
  return Boolean(grant && (grant.tools.has('*') || grant.tools.has(toolName)));
}

export function listSessionWritePermissionTools(sessionId: string, context?: RuntimeGrantContext): string[] {
  const grant = getActiveGrant(sessionId, context);
  return grant ? [...grant.tools].sort() : [];
}

export function listSessionMcpToolPermissionKeys(sessionId: string, context?: RuntimeGrantContext): string[] {
  const grant = getActiveGrant(sessionId, context);
  return grant ? [...grant.mcpTools].sort() : [];
}

export function hasSessionMcpToolPermission(sessionId: string, permissionKey: string, context?: RuntimeGrantContext): boolean {
  const grant = getActiveGrant(sessionId, context);
  return Boolean(grant && (grant.mcpTools.has('*') || grant.mcpTools.has(permissionKey)));
}

export function getSessionWritePermissionGrant(sessionId: string, context?: RuntimeGrantContext): SessionWritePermissionGrant | undefined {
  const grant = getActiveGrant(sessionId, context);
  return grant
    ? {
        tools: [...grant.tools].sort(),
        mcpTools: [...grant.mcpTools].sort(),
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        runtimeId: grant.runtimeId,
        cwd: grant.cwd
      }
    : undefined;
}

export function revokeSessionWritePermission(sessionId: string): void {
  sessionWritePermissionOverrides.delete(sessionId);
}
