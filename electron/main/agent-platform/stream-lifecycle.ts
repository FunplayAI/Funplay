import { nowIso } from '../../../shared/utils';
import type { StreamContext } from './stream-types';
import {
  findActiveRunBySession,
  getActiveOrPersistedRun,
  unregisterActiveRun
} from './run-registry';
import { closeBrowserPagesForProject } from './browser-inspection-store';

export interface ActiveStreamEntry {
  kind: 'conversation' | 'execute-plan';
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  controller: AbortController;
}

const activeStreams = new Map<string, ActiveStreamEntry>();

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function hasActiveStreamForSession(sessionId: string): boolean {
  return [...activeStreams.values()].some((item) => item.sessionId === sessionId && item.kind === 'conversation') || Boolean(findActiveRunBySession(sessionId));
}

export function hasActiveExecutionPlanStream(projectId: string): boolean {
  return [...activeStreams.values()].some((stream) => stream.projectId === projectId && stream.kind === 'execute-plan');
}

export function registerActiveStream(entry: ActiveStreamEntry): void {
  activeStreams.set(entry.streamId, entry);
}

export function getActiveStream(streamId: string): ActiveStreamEntry | undefined {
  return activeStreams.get(streamId);
}

export function deleteActiveStream(streamId: string): void {
  activeStreams.delete(streamId);
}

export function processStreamError(
  ctx: StreamContext,
  error: unknown,
  opts: {
    interruptMessage: string;
    failMessage: string;
    errorMetadata?: Record<string, unknown>;
  }
): { finalOutcome: 'interrupted' | 'failed'; finalError: string } {
  if (ctx.controller.signal.aborted || isAbortError(error)) {
    const finalError = opts.interruptMessage;
    ctx.dispatchEvent({
      type: 'cancelled',
      streamId: ctx.streamId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      startedAt: ctx.startedAt,
      finishedAt: nowIso()
    });
    unregisterActiveRun(ctx.activeRunId, {
      finalStatus: 'interrupted',
      error: finalError
    });
    return { finalOutcome: 'interrupted', finalError };
  }
  const finalError = error instanceof Error ? error.message : opts.failMessage;
  ctx.dispatchEvent({
    type: 'error',
    streamId: ctx.streamId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    startedAt: ctx.startedAt,
    finishedAt: nowIso(),
    error: finalError,
    ...opts.errorMetadata
  });
  unregisterActiveRun(ctx.activeRunId, {
    finalStatus: 'failed',
    error: finalError
  });
  return { finalOutcome: 'failed', finalError };
}

export function finalizeStream(ctx: StreamContext, finalOutcome: string): void {
  activeStreams.delete(ctx.streamId);
  closeBrowserPagesForProject(ctx.projectId);
  if (!getActiveOrPersistedRun(ctx.activeRunId) || finalOutcome !== 'completed') {
    return;
  }
  unregisterActiveRun(ctx.activeRunId, {
    finalStatus: 'completed'
  });
}
