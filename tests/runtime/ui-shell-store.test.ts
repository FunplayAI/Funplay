import test from 'node:test';
import assert from 'node:assert/strict';
import { useUiShellStore } from '../../src/stores/uiShellStore.ts';

test('ui-shell store exposes the expected defaults', () => {
  useUiShellStore.setState({
    appMode: 'welcome',
    section: 'agent',
    projectSettingsTab: 'engine',
    showAppSettingsModal: false,
    appSettingsInitialTab: 'appearance',
    isLoading: true,
    bootstrapError: ''
  });
  const state = useUiShellStore.getState();
  assert.equal(state.appMode, 'welcome');
  assert.equal(state.section, 'agent');
  assert.equal(state.isLoading, true);
});

test('setters accept a direct value and an updater (React setState shape)', () => {
  const store = useUiShellStore.getState();
  store.setAppMode('workspace');
  assert.equal(useUiShellStore.getState().appMode, 'workspace');

  store.setSection('settings');
  store.setSection((current) => (current === 'settings' ? 'assets' : 'agent'));
  assert.equal(useUiShellStore.getState().section, 'assets');

  store.setIsLoading(false);
  assert.equal(useUiShellStore.getState().isLoading, false);
});
