import test from 'node:test';
import assert from 'node:assert/strict';
import { useProjectStore } from '../../src/stores/projectStore.ts';

test('project store exposes the expected defaults', () => {
  useProjectStore.setState({
    projects: [],
    selectedProjectId: '',
    projectFiles: [],
    assetLibraryViewByProject: {},
    showDeleteProjectModal: false,
    projectPendingDelete: null,
    isDeletingProject: false,
    deleteProjectSourceFiles: false
  });
  const state = useProjectStore.getState();
  assert.deepEqual(state.projects, []);
  assert.equal(state.selectedProjectId, '');
  assert.equal(state.projectPendingDelete, null);
});

test('setters accept a direct value and an updater (React setState shape)', () => {
  const store = useProjectStore.getState();
  store.setSelectedProjectId('p1');
  assert.equal(useProjectStore.getState().selectedProjectId, 'p1');

  store.setAssetLibraryViewByProject({ p1: 'all' });
  store.setAssetLibraryViewByProject((current) => ({ ...current, p2: 'jobs' }));
  assert.deepEqual(useProjectStore.getState().assetLibraryViewByProject, { p1: 'all', p2: 'jobs' });

  store.setShowDeleteProjectModal(true);
  assert.equal(useProjectStore.getState().showDeleteProjectModal, true);
});
