import type {
  AgentPermissionImpact,
  AgentPermissionRule,
  AgentPermissionRuleSeed,
  ProjectSessionRuntimeId,
  SessionWritePermissionGrant
} from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';

interface RuntimeGrantContext {
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
}

interface ActiveSessionWritePermissionGrant extends Omit<SessionWritePermissionGrant, 'tools' | 'mcpTools' | 'rules'> {
  sessionId: string;
  tools: Set<string>;
  mcpTools: Set<string>;
  rules: AgentPermissionRule[];
}

const sessionWritePermissionOverrides = new Map<string, ActiveSessionWritePermissionGrant>();
const defaultSessionGrantTtlMs = 1000 * 60 * 60 * 4;
export const DEFAULT_SESSION_WRITE_PERMISSION_TOOLS = [
  'create_directory',
  'write_file',
  'edit_file',
  'apply_workspace_writes'
] as const;
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

function getActiveGrant(
  sessionId: string,
  context?: RuntimeGrantContext
): ActiveSessionWritePermissionGrant | undefined {
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

function ruleDedupeKey(rule: AgentPermissionRule): string {
  return [rule.toolName, rule.commandPrefix ?? '', rule.pathGlob ?? '', rule.action, rule.scope].join('\u0000');
}

function mergeSessionPermissionRules(
  existing: AgentPermissionRule[],
  incoming: AgentPermissionRule[]
): AgentPermissionRule[] {
  const merged: AgentPermissionRule[] = [];
  const seen = new Set<string>();
  for (const rule of [...existing, ...incoming]) {
    const key = ruleDedupeKey(rule);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}

function toGrantPayload(grant: ActiveSessionWritePermissionGrant): SessionWritePermissionGrant {
  return {
    tools: [...grant.tools].sort(),
    mcpTools: [...grant.mcpTools].sort(),
    rules: grant.rules.length > 0 ? [...grant.rules] : undefined,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    runtimeId: grant.runtimeId,
    cwd: grant.cwd
  };
}

export function grantSessionWritePermission(
  sessionId: string,
  options?: {
    tools?: string[];
    mcpTools?: string[];
    rules?: AgentPermissionRule[];
    ttlMs?: number;
    runtimeId?: ProjectSessionRuntimeId;
    cwd?: string;
  }
): SessionWritePermissionGrant {
  const existing = getActiveGrant(sessionId, options);
  const defaultTools =
    options?.mcpTools?.length && options.tools === undefined ? [] : [...DEFAULT_SESSION_WRITE_PERMISSION_TOOLS];
  const tools = new Set([...(existing?.tools ?? []), ...(options?.tools ?? defaultTools)]);
  const mcpTools = new Set([...(existing?.mcpTools ?? []), ...(options?.mcpTools ?? [])]);
  const rules = mergeSessionPermissionRules(existing?.rules ?? [], options?.rules ?? []);
  const grantedAt = nowMs();
  const grant: ActiveSessionWritePermissionGrant = {
    sessionId,
    tools,
    mcpTools,
    rules,
    grantedAt,
    expiresAt: grantedAt + (options?.ttlMs ?? defaultSessionGrantTtlMs),
    runtimeId: options?.runtimeId,
    cwd: options?.cwd
  };
  sessionWritePermissionOverrides.set(sessionId, grant);
  return toGrantPayload(grant);
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
    // Grants persisted before argument-level rules existed have no rules field.
    rules: Array.isArray(grant.rules) ? [...grant.rules] : [],
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    runtimeId: grant.runtimeId,
    cwd: grant.cwd
  });
}

export function hasSessionWritePermission(
  sessionId: string,
  toolName = DEFAULT_SESSION_WRITE_PERMISSION_PRIMARY_TOOL,
  context?: RuntimeGrantContext
): boolean {
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

export function listSessionPermissionRules(sessionId: string, context?: RuntimeGrantContext): AgentPermissionRule[] {
  const grant = getActiveGrant(sessionId, context);
  return grant ? [...grant.rules] : [];
}

export function hasSessionMcpToolPermission(
  sessionId: string,
  permissionKey: string,
  context?: RuntimeGrantContext
): boolean {
  const grant = getActiveGrant(sessionId, context);
  return Boolean(grant && (grant.mcpTools.has('*') || grant.mcpTools.has(permissionKey)));
}

export function getSessionWritePermissionGrant(
  sessionId: string,
  context?: RuntimeGrantContext
): SessionWritePermissionGrant | undefined {
  const grant = getActiveGrant(sessionId, context);
  return grant ? toGrantPayload(grant) : undefined;
}

export function revokeSessionWritePermission(sessionId: string): void {
  sessionWritePermissionOverrides.delete(sessionId);
}

function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** First two tokens of the command after normalization, e.g. 'npm run test:runtime' -> 'npm run'. */
export function deriveCommandPrefix(command: string): string {
  return normalizeCommandText(command).split(' ').slice(0, 2).join(' ');
}

export function toProjectRelativePermissionPath(path: string, projectPath?: string): string {
  let normalized = path.replace(/\\/g, '/');
  if (projectPath) {
    const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === root) {
      normalized = '';
    } else if (normalized.startsWith(`${root}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return normalized.replace(/^\.\//, '').replace(/^\/+/, '');
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

/**
 * Glob covering the project-relative directory shared by all paths: '<dir>/**',
 * '*' for root-level paths, undefined when paths span different top directories
 * (the caller then falls back to the legacy blanket grant).
 */
export function derivePathGlobForPaths(paths: string[], projectPath?: string): string | undefined {
  const directories = paths
    .map((path) => toProjectRelativePermissionPath(path, projectPath))
    .filter(Boolean)
    .map(directoryOf);
  if (directories.length === 0) {
    return undefined;
  }
  if (directories.every((directory) => directory === '')) {
    return '*';
  }
  let common = directories[0].split('/');
  for (const directory of directories.slice(1)) {
    const segments = directory.split('/');
    let shared = 0;
    while (shared < common.length && shared < segments.length && common[shared] === segments[shared]) {
      shared += 1;
    }
    common = common.slice(0, shared);
  }
  return common.length > 0 ? `${common.join('/')}/**` : undefined;
}

/**
 * Maps an allow_session decision to argument-scoped session rules:
 * run_command grants get a commandPrefix rule (first two command tokens); write
 * tools get a pathGlob rule scoped to the affected project-relative directory.
 * Returns undefined when no scoped rule can be derived so callers keep the
 * legacy blanket tool grant.
 */
export function deriveScopedSessionPermissionRules(params: {
  toolName?: string;
  impact?: AgentPermissionImpact;
  projectPath?: string;
  seed?: AgentPermissionRuleSeed;
}): AgentPermissionRule[] | undefined {
  const createdAt = nowIso();
  if (params.seed) {
    return [
      {
        id: makeId('permrule'),
        toolName: params.seed.toolName,
        commandPrefix: params.seed.commandPrefix,
        pathGlob: params.seed.pathGlob,
        action: params.seed.action ?? 'allow',
        scope: params.seed.scope ?? 'session',
        createdAt,
        source: 'user_decision'
      }
    ];
  }

  const toolName = params.toolName;
  if (!toolName) {
    return undefined;
  }

  if (toolName === 'run_command') {
    const command = params.impact?.commands?.[0];
    const commandPrefix = command ? deriveCommandPrefix(command) : '';
    if (!commandPrefix) {
      return undefined;
    }
    return [
      {
        id: makeId('permrule'),
        toolName,
        commandPrefix,
        action: 'allow',
        scope: 'session',
        createdAt,
        source: 'user_decision'
      }
    ];
  }

  const paths = params.impact?.paths ?? [];
  if (paths.length === 0) {
    return undefined;
  }
  const pathGlob = derivePathGlobForPaths(paths, params.projectPath ?? params.impact?.cwd);
  if (!pathGlob) {
    return undefined;
  }
  return [
    {
      id: makeId('permrule'),
      toolName,
      pathGlob,
      action: 'allow',
      scope: 'session',
      createdAt,
      source: 'user_decision'
    }
  ];
}
