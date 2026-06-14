import test from 'node:test';
import assert from 'node:assert/strict';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * Integration test for the project runtime-refresh actions migrated out of
 * App.tsx (refreshProjectRuntimeStateById + retryRefreshProjectRuntimeState).
 * They run against the real projectStore with a mocked window.funplay; the
 * retry loop's wait() resolves through the stubbed window.setTimeout.
 */

interface RuntimeState {
  bridgeHealth?: { status: string };
  projectOpen?: boolean;
  bridgeInstalled?: boolean;
}

function makeProject(id: string, runtimeState?: RuntimeState): Project {
  return {
    id,
    name: id,
    engine: { platform: 'unity', projectPath: '/projects/' + id },
    runtimeState
  } as unknown as Project;
}

function installFunplay(replies: Array<Project | null>): { count: () => number } {
  let index = 0;
  const funplay = {
    refreshProjectRuntimeState: async (_projectId: string) => {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply;
    }
  };
  (globalThis as { window?: unknown }).window = {
    funplay,
    setTimeout: (cb: () => void, _ms?: number) => {
      cb();
      return 0;
    }
  };
  return { count: () => index };
}

test('refreshProjectRuntimeStateById merges the refreshed project and returns it', async () => {
  useProjectStore.setState({ projects: [makeProject('p1', { bridgeHealth: { status: 'offline' } })] });
  const fresh = makeProject('p1', { bridgeHealth: { status: 'online' } });
  installFunplay([fresh]);

  const result = await useProjectStore.getState().refreshProjectRuntimeStateById('p1');
  assert.equal(result?.id, 'p1');
  assert.equal(useProjectStore.getState().projects[0].runtimeState?.bridgeHealth?.status, 'online');
});

test('refreshProjectRuntimeStateById returns null and leaves the list untouched on an empty IPC reply', async () => {
  useProjectStore.setState({ projects: [makeProject('p1', { bridgeHealth: { status: 'offline' } })] });
  installFunplay([null]);

  const result = await useProjectStore.getState().refreshProjectRuntimeStateById('p1');
  assert.equal(result, null);
  assert.equal(useProjectStore.getState().projects[0].runtimeState?.bridgeHealth?.status, 'offline');
});

test('retryRefreshProjectRuntimeState stops as soon as the bridge reports online', async () => {
  useProjectStore.setState({ projects: [makeProject('p1')] });
  const handle = installFunplay([makeProject('p1', { bridgeHealth: { status: 'online' } })]);

  await useProjectStore.getState().retryRefreshProjectRuntimeState('p1', 6, 1);
  assert.equal(handle.count(), 1);
});

test('retryRefreshProjectRuntimeState stops when fast-refresh is no longer useful', async () => {
  useProjectStore.setState({ projects: [makeProject('p1')] });
  // offline bridge, but project closed → shouldUseFastRuntimeRefresh === false → stop.
  const handle = installFunplay([
    makeProject('p1', { bridgeHealth: { status: 'offline' }, projectOpen: false, bridgeInstalled: true })
  ]);

  await useProjectStore.getState().retryRefreshProjectRuntimeState('p1', 6, 1);
  assert.equal(handle.count(), 1);
});

test('retryRefreshProjectRuntimeState polls up to the attempt budget while fast-refresh stays useful', async () => {
  useProjectStore.setState({ projects: [makeProject('p1')] });
  // offline but project open + bridge installed → keep polling every attempt.
  const handle = installFunplay([
    makeProject('p1', { bridgeHealth: { status: 'offline' }, projectOpen: true, bridgeInstalled: true })
  ]);

  await useProjectStore.getState().retryRefreshProjectRuntimeState('p1', 3, 1);
  assert.equal(handle.count(), 3);
});
