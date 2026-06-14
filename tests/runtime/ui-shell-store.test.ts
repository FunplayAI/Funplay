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

test('openAppSettings opens the modal on the given tab, defaulting to appearance', () => {
  useUiShellStore.setState({ showAppSettingsModal: false, appSettingsInitialTab: 'appearance' });
  useUiShellStore.getState().openAppSettings('provider');
  let state = useUiShellStore.getState();
  assert.equal(state.showAppSettingsModal, true);
  assert.equal(state.appSettingsInitialTab, 'provider');

  useUiShellStore.setState({ showAppSettingsModal: false, appSettingsInitialTab: 'provider' });
  useUiShellStore.getState().openAppSettings();
  state = useUiShellStore.getState();
  assert.equal(state.showAppSettingsModal, true);
  assert.equal(state.appSettingsInitialTab, 'appearance');
});
