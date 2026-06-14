import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectNavActions } from '../../src/actions/projectNavActions.ts';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import { useSessionStore } from '../../src/stores/sessionStore.ts';
import { useSessionComposerStore } from '../../src/stores/sessionComposerStore.ts';
import { useUiShellStore } from '../../src/stores/uiShellStore.ts';
import { useEngineSetupStore } from '../../src/stores/engineSetupStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * Integration test for the project navigation/lifecycle actions extracted from
 * App.tsx. Real stores; window.funplay + dispatchEvent mocked; the file-inspector
 * / layout / mcp setters injected as recording stubs; the post-create runtime
 * refresh overridden on the store so it can be observed without polling.
 */

function makeProject(id: string, extra: Record<string, unknown> = {}): Project {
  return {
    id,
    name: id,
    sessions: [{ id: id + '-s1', title: 's1', chat: [] }],
    activeSessionId: id + '-s1',
    engine: { platform: 'unity', projectPath: '/p/' + id },
    mcpBindings: { engine: 'eng-' + id },
    chat: [],
    ...extra
  } as unknown as Project;
}

interface Recorder {
  fileIds: unknown[];
  overlays: unknown[];
  inspector: unknown[];
  mcpPlugins: unknown[];
  selectedMcpPluginId: unknown[];
  retry: unknown[][];
}

function freshRecorder(): Recorder {
  return { fileIds: [], overlays: [], inspector: [], mcpPlugins: [], selectedMcpPluginId: [], retry: [] };
}

function makeActions(rec: Recorder, mcpPlugins: Array<{ id: string }> = []) {
  return createProjectNavActions({
    setSelectedFileId: ((v: unknown) => rec.fileIds.push(v)) as never,
    setSelectedOverlayFile: ((v: unknown) => rec.overlays.push(v)) as never,
    setRightInspectorCollapsed: ((v: unknown) => rec.inspector.push(v)) as never,
    getMcpPlugins: () => mcpPlugins as never,
    setMcpPlugins: ((v: unknown) => rec.mcpPlugins.push(v)) as never,
    setSelectedMcpPluginId: ((v: unknown) => rec.selectedMcpPluginId.push(v)) as never
  });
}

function installWindow(funplay: Record<string, unknown>): void {
  (globalThis as { window?: unknown }).window = { funplay, dispatchEvent: () => true };
}

function resetStores(rec: Recorder): void {
  useProjectStore.setState({
    projects: [],
    selectedProjectId: '',
    projectFiles: [],
    projectPendingDelete: null,
    isDeletingProject: false,
    deleteProjectSourceFiles: false,
    showDeleteProjectModal: false,
    // observe the fire-and-forget refresh without real polling
    retryRefreshProjectRuntimeState: (async (...args: unknown[]) => {
      rec.retry.push(args);
    }) as never
  });
  useSessionStore.setState({ localActiveSessionByProject: {} });
  useSessionComposerStore.setState({ drafts: {}, attachments: {}, composerErrors: {}, queuedPrompts: {} });
  useUiShellStore.setState({ appMode: 'welcome', section: 'engine' });
  useEngineSetupStore.setState({ onboardingEnginePluginId: '' });
}

test('openProject selects the project, repoints the session, and enters the workspace', () => {
  const rec = freshRecorder();
  resetStores(rec);
  useProjectStore.setState({ projects: [makeProject('p1')] });
  installWindow({});

  makeActions(rec).openProject('p1');

  assert.equal(useProjectStore.getState().selectedProjectId, 'p1');
  assert.equal(useSessionStore.getState().localActiveSessionByProject.p1, 'p1-s1');
  assert.equal(useUiShellStore.getState().appMode, 'workspace');
  assert.equal(useUiShellStore.getState().section, 'agent');
  assert.deepEqual(rec.fileIds, ['']);
  assert.deepEqual(rec.overlays, [null]);
  assert.deepEqual(rec.inspector, [true]);
});

test('handleCreateProject binds the onboarding plugin, bootstraps, and enters the workspace', async () => {
  const rec = freshRecorder();
  resetStores(rec);
  useEngineSetupStore.setState({ onboardingEnginePluginId: 'onb-plug' });
  const bound = makeProject('new1', { mcpBindings: { engine: 'onb-plug' } });
  installWindow({
    createProject: async () => makeProject('new1'),
    updateProjectMcpConfig: async () => bound,
    bootstrap: async () => ({ mcpPlugins: [{ id: 'onb-plug' }] })
  });

  // mcpPlugins does NOT yet contain onb-plug → bootstrap path runs.
  await makeActions(rec, []).handleCreateProject({ engine: { platform: 'unity' } } as never);

  assert.equal(useProjectStore.getState().selectedProjectId, 'new1');
  assert.equal(useProjectStore.getState().projects[0].id, 'new1');
  assert.equal(useUiShellStore.getState().appMode, 'workspace');
  assert.deepEqual(rec.mcpPlugins, [[{ id: 'onb-plug' }]]);
  assert.deepEqual(rec.selectedMcpPluginId, ['onb-plug']);
  assert.deepEqual(rec.retry, [['new1']]); // unity → runtime refresh kicked off
});

test('handleCreateProject skips engine effects for a non-engine (web) project', async () => {
  const rec = freshRecorder();
  resetStores(rec);
  const webProject = makeProject('web1', { engine: { platform: 'web' }, mcpBindings: {} });
  installWindow({ createProject: async () => webProject });

  await makeActions(rec).handleCreateProject({ engine: { platform: 'web' } } as never);

  assert.equal(useProjectStore.getState().selectedProjectId, 'web1');
  assert.deepEqual(rec.mcpPlugins, []); // no bootstrap
  assert.deepEqual(rec.retry, []); // no runtime refresh for web
});

test('handleDeleteProject re-opens the next project when the deleted one was selected', async () => {
  const rec = freshRecorder();
  resetStores(rec);
  useProjectStore.setState({
    projects: [makeProject('p1'), makeProject('p2')],
    selectedProjectId: 'p1',
    projectPendingDelete: makeProject('p1')
  });
  useSessionComposerStore.setState({ drafts: { 'p1-s1': 'scratch' } });
  installWindow({ deleteProject: async () => ({ remainingProjects: [makeProject('p2')] }) });

  await makeActions(rec).handleDeleteProject();

  // openProject('p2') ran → selection + workspace
  assert.equal(useProjectStore.getState().selectedProjectId, 'p2');
  assert.equal(useUiShellStore.getState().appMode, 'workspace');
  // deleted project's session-scoped composer state cleared
  assert.equal(useSessionComposerStore.getState().drafts['p1-s1'], undefined);
  assert.equal(useProjectStore.getState().isDeletingProject, false);
  assert.equal(useProjectStore.getState().projectPendingDelete, null);
});

test('handleDeleteProject falls back to the welcome screen when no projects remain', async () => {
  const rec = freshRecorder();
  resetStores(rec);
  useProjectStore.setState({
    projects: [makeProject('p1')],
    selectedProjectId: 'p1',
    projectFiles: [{ path: 'x' } as never],
    projectPendingDelete: makeProject('p1')
  });
  installWindow({ deleteProject: async () => ({ remainingProjects: [] }) });

  await makeActions(rec).handleDeleteProject();

  assert.equal(useProjectStore.getState().selectedProjectId, '');
  assert.equal(useUiShellStore.getState().appMode, 'welcome');
  assert.deepEqual(useProjectStore.getState().projectFiles, []);
  assert.equal(useProjectStore.getState().isDeletingProject, false);
});

test('handleDeleteProject is a no-op when nothing is pending', async () => {
  const rec = freshRecorder();
  resetStores(rec);
  let called = false;
  installWindow({
    deleteProject: async () => {
      called = true;
      return { remainingProjects: [] };
    }
  });

  await makeActions(rec).handleDeleteProject();
  assert.equal(called, false);
});
