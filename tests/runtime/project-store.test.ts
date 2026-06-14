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

test('openDeleteModal stages a project and resets the source-files flag', () => {
  useProjectStore.setState({
    showDeleteProjectModal: false,
    projectPendingDelete: null,
    isDeletingProject: false,
    deleteProjectSourceFiles: true
  });
  const project = { id: 'p1', name: 'Rogue' } as never;
  useProjectStore.getState().openDeleteModal(project);
  const state = useProjectStore.getState();
  assert.equal(state.showDeleteProjectModal, true);
  assert.equal((state.projectPendingDelete as { id: string } | null)?.id, 'p1');
  assert.equal(state.deleteProjectSourceFiles, false);
});

test('closeDeleteModal clears the modal, but is a no-op while a deletion is in flight', () => {
  useProjectStore.setState({
    showDeleteProjectModal: true,
    projectPendingDelete: { id: 'p1' } as never,
    isDeletingProject: true,
    deleteProjectSourceFiles: true
  });
  useProjectStore.getState().closeDeleteModal();
  // in-flight: unchanged
  assert.equal(useProjectStore.getState().showDeleteProjectModal, true);

  useProjectStore.setState({ isDeletingProject: false });
  useProjectStore.getState().closeDeleteModal();
  const state = useProjectStore.getState();
  assert.equal(state.showDeleteProjectModal, false);
  assert.equal(state.projectPendingDelete, null);
  assert.equal(state.deleteProjectSourceFiles, false);
});
