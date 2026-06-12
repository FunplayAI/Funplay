import test from 'node:test';
import assert from 'node:assert/strict';
import { useSessionStore } from '../../src/stores/sessionStore.ts';
import { useEngineSetupStore, emptyUnitySettings } from '../../src/stores/engineSetupStore.ts';

test('session store tracks the locally-active session per project', () => {
  useSessionStore.setState({ localActiveSessionByProject: {} });
  const store = useSessionStore.getState();
  store.setLocalActiveSessionByProject({ p1: 's1' });
  store.setLocalActiveSessionByProject((current) => ({ ...current, p2: 's2' }));
  assert.deepEqual(useSessionStore.getState().localActiveSessionByProject, { p1: 's1', p2: 's2' });
});

test('engine-setup store exposes default settings and onboarding values', () => {
  useEngineSetupStore.setState({
    settings: emptyUnitySettings,
    settingsDraft: emptyUnitySettings,
    onboardingProjectPath: '~/Downloads',
    onboardingEnginePluginId: ''
  });
  const state = useEngineSetupStore.getState();
  assert.equal(state.settings.profile, 'core');
  assert.equal(state.onboardingProjectPath, '~/Downloads');
  assert.equal(state.onboardingEnginePluginId, '');
});

test('engine-setup setters accept value and updater (React setState shape)', () => {
  const store = useEngineSetupStore.getState();
  store.setOnboardingProjectPath('/games');
  assert.equal(useEngineSetupStore.getState().onboardingProjectPath, '/games');

  store.setSettingsDraft((current) => ({ ...current, profile: 'full' }));
  assert.equal(useEngineSetupStore.getState().settingsDraft.profile, 'full');
});
