import test from 'node:test';
import assert from 'node:assert/strict';
import { drainQueuedPrompts } from '../../src/hooks/useQueuedPromptDrain.ts';
import type { Project } from '../../shared/types.ts';

/**
 * The queued-prompt auto-dequeue logic extracted from App.tsx. The hazard is
 * re-entrancy (firing the same session twice before its submit settles), guarded
 * by the dequeueGuard set — these cases pin that plus the queue-key bookkeeping.
 */

function project(id: string, sessionIds: string[]): Project {
  return {
    id,
    name: id,
    sessions: sessionIds.map((sid) => ({ id: sid, title: sid, chat: [] })),
    activeSessionId: sessionIds[0]
  } as unknown as Project;
}

interface Harness {
  submits: Array<[string, string, string]>;
  queue: Record<string, Array<{ content: string }>>;
  guard: Set<string>;
}

function run(over: Partial<Parameters<typeof drainQueuedPrompts>[0]> & { guard?: Set<string> } = {}): Harness {
  const submits: Array<[string, string, string]> = [];
  const queue: Record<string, Array<{ content: string }>> = (over.queuedPromptsBySession as never) ?? {
    s1: [{ content: 'hello' }]
  };
  const guard = over.guard ?? new Set<string>();
  drainQueuedPrompts({
    activeStreamSessions: over.activeStreamSessions ?? [],
    projects: over.projects ?? [project('p1', ['s1'])],
    queuedPromptsBySession: queue as never,
    dequeueGuard: guard,
    setQueuedPromptsBySession: (updater) => {
      const next = updater(queue as never);
      Object.keys(queue).forEach((key) => delete queue[key]);
      Object.assign(queue, next);
    },
    submitPrompt: async (content, sessionId, projectId) => {
      submits.push([content, sessionId, projectId]);
    }
  });
  return { submits, queue: queue as never, guard };
}

test('drains a queued prompt: submits the head, removes the key, and guards the session', () => {
  const h = run();
  assert.deepEqual(h.submits, [['hello', 's1', 'p1']]);
  assert.equal(h.queue.s1, undefined); // single-item queue → key deleted
  assert.equal(h.guard.has('s1'), true); // guarded until the submit settles
});

test('the dequeue guard prevents a second fire for an in-flight session', () => {
  const guard = new Set<string>(['s1']);
  const h = run({ guard });
  assert.deepEqual(h.submits, []); // already mid-dequeue → not fired again
});

test('a streaming session is not drained', () => {
  const h = run({ activeStreamSessions: [{ sessionId: 's1', phase: 'streaming' }] as never });
  assert.deepEqual(h.submits, []);
});

test('a multi-item queue keeps the tail and retains the key', () => {
  const h = run({ queuedPromptsBySession: { s1: [{ content: 'first' }, { content: 'second' }] } as never });
  assert.deepEqual(h.submits, [['first', 's1', 'p1']]);
  assert.deepEqual(h.queue.s1, [{ content: 'second' }]);
});

test('a session with no resolvable project is skipped', () => {
  const h = run({ projects: [project('p1', ['other'])] });
  assert.deepEqual(h.submits, []);
});
