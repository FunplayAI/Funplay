import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptStreamActions } from '../../src/actions/promptStreamActions.ts';
import {
  clearStreamSessions,
  getStreamSessionForSession,
  seedStreamSession
} from '../../src/lib/stream-session-manager.ts';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import { useSessionStore } from '../../src/stores/sessionStore.ts';
import { useSessionComposerStore } from '../../src/stores/sessionComposerStore.ts';
import { useUiShellStore } from '../../src/stores/uiShellStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * Integration test for the prompt-stream actions extracted from App.tsx. It
 * runs against the real renderer stores AND the real stream-session-manager
 * (seeded/cleared through its public API), with window.funplay mocked and the
 * two App refs faked as plain { current } cells.
 */

function makeProject(id: string, sessionIds: string[]): Project {
  return {
    id,
    name: id,
    sessions: sessionIds.map((sid) => ({ id: sid, title: sid, chat: [] })),
    activeSessionId: sessionIds[0],
    chat: []
  } as unknown as Project;
}

function makeSnapshot(streamId: string, projectId: string, sessionId: string) {
  return {
    streamId,
    projectId,
    sessionId,
    prompt: 'live',
    content: '',
    thinkingContent: '',
    toolUses: [],
    toolResults: [],
    stages: [],
    activityItems: [],
    phase: 'streaming',
    statusMessage: '',
    startedAt: 't0'
  } as never;
}

interface FunplayBehavior {
  stream?: Record<string, unknown>;
  streamReject?: Error;
  resume?: Record<string, unknown>;
  resumeReject?: Error;
}

interface FunplayCalls {
  stream: unknown[][];
  resume: unknown[];
}

function installFunplay(behavior: FunplayBehavior): FunplayCalls {
  const calls: FunplayCalls = { stream: [], resume: [] };
  (globalThis as { window?: unknown }).window = {
    funplay: {
      startPromptStream: async (...args: unknown[]) => {
        calls.stream.push(args);
        if (behavior.streamReject) {
          throw behavior.streamReject;
        }
        return behavior.stream;
      },
      resumeAgentRun: async (runId: string) => {
        calls.resume.push(runId);
        if (behavior.resumeReject) {
          throw behavior.resumeReject;
        }
        return behavior.resume;
      }
    }
  };
  return calls;
}

function resetAll(): void {
  clearStreamSessions();
  useProjectStore.setState({ projects: [] });
  useSessionStore.setState({ localActiveSessionByProject: {} });
  useSessionComposerStore.setState({ drafts: {}, attachments: {}, composerErrors: {}, queuedPrompts: {} });
  useUiShellStore.setState({ section: 'engine' });
}

function makeActions(overrides: Partial<Parameters<typeof createPromptStreamActions>[0]> = {}) {
  return createPromptStreamActions({
    getSelectedProjectView: () => useProjectStore.getState().projects[0] ?? null,
    getSelectedSessionId: () => 's1',
    language: 'en-US',
    selectedProjectIdRef: { current: 'p1' },
    sessionMutationQueueRef: { current: Promise.resolve() },
    ...overrides
  });
}

test('handleSubmitComposer starts a stream, clears the draft, and seeds the stream session', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1'])] });
  useSessionComposerStore.setState({ drafts: { s1: 'hello world' } });
  const calls = installFunplay({
    stream: { streamId: 'st1', projectId: 'p1', sessionId: 's1', startedAt: 't1', prompt: 'hello world' }
  });

  await makeActions().handleSubmitComposer(undefined, 's1');

  assert.deepEqual(calls.stream, [['p1', 'hello world', 's1', [], 'en-US']]);
  assert.equal(useSessionComposerStore.getState().drafts.s1, '');
  assert.equal(useSessionStore.getState().localActiveSessionByProject.p1, 's1');
  assert.ok(getStreamSessionForSession('p1', 's1'), 'a local stream session should be seeded');
});

test('handleSubmitComposer queues (does not start) when a stream is already live', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1'])] });
  useSessionComposerStore.setState({ drafts: { s1: 'queued message' } });
  seedStreamSession(makeSnapshot('live-1', 'p1', 's1'));
  const calls = installFunplay({ stream: { streamId: 'x' } });

  await makeActions().handleSubmitComposer(undefined, 's1');

  assert.deepEqual(calls.stream, []);
  assert.equal(useSessionComposerStore.getState().queuedPrompts.s1?.length, 1);
  assert.equal(useSessionComposerStore.getState().drafts.s1, '');
});

test('handleSubmitComposer restores the draft and surfaces a composer error on failure', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1'])] });
  useSessionComposerStore.setState({ drafts: { s1: 'retry me' } });
  installFunplay({ streamReject: new Error('provider down') });

  await makeActions().handleSubmitComposer(undefined, 's1');

  assert.equal(useSessionComposerStore.getState().drafts.s1, 'retry me');
  assert.equal(useSessionComposerStore.getState().composerErrors.s1, 'provider down');
});

test('handleSubmitComposer is a no-op with no message and no attachments', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1'])] });
  useSessionComposerStore.setState({ drafts: { s1: '   ' } });
  const calls = installFunplay({ stream: { streamId: 'x' } });

  await makeActions().handleSubmitComposer(undefined, 's1');
  assert.deepEqual(calls.stream, []);
});

test('handleResumeAgentRun repoints the active session, switches to agent, and seeds the stream', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1', 's2'])] });
  const calls = installFunplay({
    resume: { streamId: 'r1', projectId: 'p1', sessionId: 's2', startedAt: 't2', kind: 'conversation', prompt: 'resumed' }
  });

  await makeActions().handleResumeAgentRun('run-1');

  assert.deepEqual(calls.resume, ['run-1']);
  assert.equal(useSessionStore.getState().localActiveSessionByProject.p1, 's2');
  assert.equal(useUiShellStore.getState().section, 'agent');
  assert.ok(getStreamSessionForSession('p1', 's2'), 'resumed run should seed a local stream session');
});

test('handleResumeAgentRun surfaces a failure as a composer error on the selected session', async () => {
  resetAll();
  useProjectStore.setState({ projects: [makeProject('p1', ['s1'])] });
  installFunplay({ resumeReject: new Error('resume failed') });

  await makeActions({ getSelectedSessionId: () => 's1' }).handleResumeAgentRun('run-1');

  assert.equal(useSessionComposerStore.getState().composerErrors.s1, 'resume failed');
});

test('handleResumeAgentRun is a no-op without a selected project view', async () => {
  resetAll();
  const calls = installFunplay({ resume: { streamId: 'x', projectId: 'p1', sessionId: 's1', startedAt: 't' } });
  await makeActions({ getSelectedProjectView: () => null }).handleResumeAgentRun('run-1');
  assert.deepEqual(calls.resume, []);
});
