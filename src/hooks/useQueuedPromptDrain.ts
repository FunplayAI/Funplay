import { useEffect, useRef } from 'react';
import type { Project } from '../../shared/types';
import { ensureProjectSessions } from '../../shared/project-sessions';
import type { QueuedPromptItem } from '../components/chat/ChatComposer';
import type { StreamSessionState } from '../lib/stream-session-manager';
import { useSessionComposerStore } from '../stores/sessionComposerStore';

/**
 * Auto-dequeues queued prompts: for each session with a non-empty queue that is
 * not currently streaming and not already mid-dequeue, pops the head, removes it
 * from the queue (deleting the key when empty), and submits it. The dequeueGuard
 * set prevents the same session from firing twice before its in-flight submit
 * settles — the re-entrancy hazard this guards against. Extracted as a pure
 * function so that guard behavior is unit-testable without rendering.
 */
export function drainQueuedPrompts(ctx: {
  activeStreamSessions: StreamSessionState[];
  projects: Project[];
  queuedPromptsBySession: Record<string, QueuedPromptItem[]>;
  dequeueGuard: Set<string>;
  setQueuedPromptsBySession: (
    updater: (current: Record<string, QueuedPromptItem[]>) => Record<string, QueuedPromptItem[]>
  ) => void;
  submitPrompt: (content: string, sessionId: string, projectId: string) => Promise<void>;
}): void {
  const activeSessionIds = new Set(
    ctx.activeStreamSessions
      .filter((stream) => !['completed', 'cancelled', 'error'].includes(stream.phase))
      .map((stream) => stream.sessionId)
  );
  const projectBySessionId = new Map<string, string>();
  ctx.projects.forEach((project) => {
    ensureProjectSessions(project).sessions.forEach((session) => {
      projectBySessionId.set(session.id, project.id);
    });
  });

  for (const [sessionId, queue] of Object.entries(ctx.queuedPromptsBySession)) {
    if (queue.length === 0 || activeSessionIds.has(sessionId) || ctx.dequeueGuard.has(sessionId)) {
      continue;
    }

    const projectId = projectBySessionId.get(sessionId);
    const nextPrompt = queue[0];
    if (!projectId || !nextPrompt) {
      continue;
    }

    ctx.dequeueGuard.add(sessionId);
    ctx.setQueuedPromptsBySession((current) => {
      const nextQueue = (current[sessionId] ?? []).slice(1);
      const next = { ...current };
      if (nextQueue.length > 0) {
        next[sessionId] = nextQueue;
      } else {
        delete next[sessionId];
      }
      return next;
    });
    void ctx.submitPrompt(nextPrompt.content, sessionId, projectId).finally(() => {
      ctx.dequeueGuard.delete(sessionId);
    });
  }
}

interface UseQueuedPromptDrainParams {
  activeStreamSessions: StreamSessionState[];
  projects: Project[];
  handleSubmitComposer: (content?: string, sessionIdOverride?: string, projectIdOverride?: string) => Promise<void>;
}

export function useQueuedPromptDrain({
  activeStreamSessions,
  projects,
  handleSubmitComposer
}: UseQueuedPromptDrainParams): void {
  const dequeueGuardRef = useRef<Set<string>>(new Set());
  const queuedPromptsBySession = useSessionComposerStore((store) => store.queuedPrompts);
  const setQueuedPromptsBySession = useSessionComposerStore((store) => store.setQueuedPrompts);

  useEffect(() => {
    drainQueuedPrompts({
      activeStreamSessions,
      projects,
      queuedPromptsBySession,
      dequeueGuard: dequeueGuardRef.current,
      setQueuedPromptsBySession,
      submitPrompt: handleSubmitComposer
    });
  }, [activeStreamSessions, projects, queuedPromptsBySession]);
}
