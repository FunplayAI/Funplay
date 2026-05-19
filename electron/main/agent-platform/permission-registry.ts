import type { AgentPermissionImpact, ProjectSessionRuntimeId } from '../../../shared/types';
import { nowIso } from '../../../shared/utils';
import { appendPermissionAudit } from '../store';

type PermissionDecision = 'allow' | 'allow_session' | 'deny';

interface PendingPermissionEntry {
  requestId: string;
  streamId: string;
  projectId: string;
  sessionId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  impact?: AgentPermissionImpact;
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
  createdAt: string;
  resolve: (decision: PermissionDecision) => void;
  onResolve?: (entry: PendingPermissionEntry, decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
  abortSignal?: AbortSignal;
}

const pendingPermissions = new Map<string, PendingPermissionEntry>();
const permissionTimeoutMs = 1000 * 60 * 5;

function settlePermission(
  requestId: string,
  decision: PermissionDecision | 'timeout' | 'aborted'
): PendingPermissionEntry | undefined {
  const entry = pendingPermissions.get(requestId);
  if (!entry) {
    return undefined;
  }

  clearTimeout(entry.timer);
  pendingPermissions.delete(requestId);
  appendPermissionAudit({
    requestId: entry.requestId,
    projectId: entry.projectId,
    sessionId: entry.sessionId,
    title: entry.title,
    detail: entry.detail,
    risk: entry.risk,
    status: decision,
    createdAt: entry.createdAt,
    resolvedAt: nowIso(),
    resolutionJson: JSON.stringify({
      streamId: entry.streamId,
      toolName: entry.toolName,
      impact: entry.impact,
      runtimeId: entry.runtimeId,
      cwd: entry.cwd,
      decision
    })
  });
  return entry;
}

function resolvePermissionEntry(
  entry: PendingPermissionEntry | undefined,
  decision: PermissionDecision
): void {
  if (!entry) {
    return;
  }
  entry.resolve(decision);
  entry.onResolve?.(entry, decision);
}

export function registerPendingPermission(params: {
  requestId: string;
  streamId: string;
  projectId: string;
  sessionId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  impact?: AgentPermissionImpact;
  runtimeId?: ProjectSessionRuntimeId;
  cwd?: string;
  createdAt: string;
  abortSignal?: AbortSignal;
  onResolve?: (entry: PendingPermissionEntry, decision: PermissionDecision) => void;
}): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      const entry = settlePermission(params.requestId, 'timeout');
      resolvePermissionEntry(entry, 'deny');
    }, permissionTimeoutMs);
    timer.unref?.();

    const entry: PendingPermissionEntry = {
      ...params,
      resolve,
      timer
    };
    pendingPermissions.set(params.requestId, entry);
    appendPermissionAudit({
      requestId: params.requestId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      title: params.title,
      detail: params.detail,
      risk: params.risk,
      status: 'pending',
      createdAt: params.createdAt,
      resolutionJson: JSON.stringify({
        streamId: params.streamId,
        toolName: params.toolName,
        impact: params.impact,
        runtimeId: params.runtimeId,
        cwd: params.cwd
      })
    });

    params.abortSignal?.addEventListener('abort', () => {
      const active = settlePermission(params.requestId, 'aborted');
      resolvePermissionEntry(active, 'deny');
    }, { once: true });
  });
}

export function resolvePendingPermission(
  requestId: string,
  decision: PermissionDecision
): PendingPermissionEntry | undefined {
  return settlePermission(requestId, decision);
}

export function cancelPendingPermissionsForStream(streamId: string): void {
  for (const [requestId, entry] of pendingPermissions.entries()) {
    if (entry.streamId === streamId) {
      const active = settlePermission(requestId, 'aborted');
      resolvePermissionEntry(active, 'deny');
    }
  }
}
