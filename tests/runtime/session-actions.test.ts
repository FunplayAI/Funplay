import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionActions } from '../../src/actions/sessionActions.ts';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import { useSessionStore } from '../../src/stores/sessionStore.ts';
import { useSessionComposerStore } from '../../src/stores/sessionComposerStore.ts';
import { useUiShellStore } from '../../src/stores/uiShellStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * Integration test for the session CRUD orchestration extracted from App.tsx.
 * It exercises the real renderer stores against a mocked `window.funplay`, so
 * the store-state transitions each handler drives are pinned end to end.
 */

function makeProject(id: string, sessions: Array<{ id: string; title?: string }>, activeSessionId?: string): Project {
  return {
    id,
    name: id,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title ?? session.id,
      chat: []
    })),
    activeSessionId: activeSessionId ?? sessions[0]?.id ?? '',
    chat: []
  } as unknown as Project;
}

interface FunplayCalls {
  create: string[];
  rename: Array<[string, string, string]>;
  remove: Array<[string, string]>;
}

function installFunplay(reply: (call: keyof FunplayCalls, ...args: string[]) => Project): FunplayCalls {
  const calls: FunplayCalls = { create: [], rename: [], remove: [] };
  const funplay = {
    createProjectSession: async (projectId: string) => {
      calls.create.push(projectId);
      return reply('create', projectId);
    },
    renameProjectSession: async (projectId: string, sessionId: string, title: string) => {
      calls.rename.push([projectId, sessionId, title]);
      return reply('rename', projectId, sessionId, title);
    },
    deleteProjectSession: async (projectId: string, sessionId: string) => {
      calls.remove.push([projectId, sessionId]);
      return reply('remove', projectId, sessionId);
    }
  };
  (globalThis as { window?: unknown }).window = { funplay };
  return calls;
}

function resetStores(): void {
  useProjectStore.setState({ projects: [], selectedProjectId: '' });
  useSessionStore.setState({ localActiveSessionByProject: {} });
  useSessionComposerStore.setState({ drafts: {}, attachments: {}, composerErrors: {}, queuedPrompts: {} });
  useUiShellStore.setState({ section: 'engine' });
}

// Tests run session mutations directly; the FIFO queue is App-owned, so a
// pass-through keeps the test focused on orchestration, not serialization.
const passthrough = <T>(operation: () => Promise<T>): Promise<T> => operation();

test('createSession replaces the project, seeds composer state, and switches to the agent section', async () => {
  resetStores();
  useProjectStore.setState({ projects: [makeProject('p1', [{ id: 's0' }])] });
  const updated = makeProject('p1', [{ id: 's0' }, { id: 's1' }], 's1');
  installFunplay(() => updated);

  const actions = createSessionActions({
    getSelectedProject: () => useProjectStore.getState().projects[0] ?? null,
    enqueueSessionMutation: passthrough
  });
  await actions.createSession();

  const projects = useProjectStore.getState().projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].activeSessionId, 's1');
  assert.equal(useSessionStore.getState().localActiveSessionByProject.p1, 's1');
  const composer = useSessionComposerStore.getState();
  assert.equal(composer.drafts.s1, '');
  assert.deepEqual(composer.attachments.s1, []);
  assert.equal(composer.composerErrors.s1, '');
  assert.equal(useUiShellStore.getState().section, 'agent');
});

test('createSession is a no-op when no project is selected', async () => {
  resetStores();
  const calls = installFunplay(() => makeProject('p1', [{ id: 's0' }]));
  const actions = createSessionActions({ getSelectedProject: () => null, enqueueSessionMutation: passthrough });
  await actions.createSession();
  assert.deepEqual(calls.create, []);
  assert.equal(useUiShellStore.getState().section, 'engine');
});

test('renameSession forwards the title and merges the updated project', async () => {
  resetStores();
  useProjectStore.setState({ projects: [makeProject('p1', [{ id: 's1', title: 'Old' }])] });
  const renamed = makeProject('p1', [{ id: 's1', title: 'New title' }], 's1');
  const calls = installFunplay(() => renamed);

  const actions = createSessionActions({
    getSelectedProject: () => useProjectStore.getState().projects[0] ?? null,
    enqueueSessionMutation: passthrough
  });
  await actions.renameSession('s1', 'New title');

  assert.deepEqual(calls.rename, [['p1', 's1', 'New title']]);
  const session = useProjectStore.getState().projects[0].sessions.find((entry) => entry.id === 's1');
  assert.equal(session?.title, 'New title');
});

test('deleteSession replaces the project, repoints the active session, and clears session-scoped composer state', async () => {
  resetStores();
  useProjectStore.setState({ projects: [makeProject('p1', [{ id: 's0' }, { id: 's1' }], 's1')] });
  useSessionComposerStore.setState({ drafts: { s1: 'in-progress draft' }, attachments: { s1: [] } });
  const afterDelete = makeProject('p1', [{ id: 's0' }], 's0');
  const calls = installFunplay(() => afterDelete);

  const actions = createSessionActions({
    getSelectedProject: () => useProjectStore.getState().projects[0] ?? null,
    enqueueSessionMutation: passthrough
  });
  await actions.deleteSession('s1');

  assert.deepEqual(calls.remove, [['p1', 's1']]);
  assert.equal(useProjectStore.getState().projects[0].activeSessionId, 's0');
  assert.equal(useSessionStore.getState().localActiveSessionByProject.p1, 's0');
  // clearSessionScoped drops the deleted session's composer scratch state.
  assert.equal(useSessionComposerStore.getState().drafts.s1, undefined);
  assert.equal(useUiShellStore.getState().section, 'agent');
});
