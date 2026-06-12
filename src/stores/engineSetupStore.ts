import { type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import type { UnitySettings } from '../../shared/types';

/**
 * Engine/project-setup state — the persisted engine settings, the editable
 * settings draft, and the onboarding wizard's project path / engine plugin
 * selection. Extracted from App.tsx as the final state-layer slice.
 *
 * Setters keep the React `Dispatch<SetStateAction<T>>` shape so call sites and
 * the useOnboarding hook (which receives them) work verbatim.
 */

export const emptyUnitySettings: UnitySettings = {
  baseUrl: 'http://127.0.0.1:8765/',
  profile: 'core',
  lastStatus: 'idle',
  lastCreatedProjectDirectory: '~/Downloads',
  lastAssignedMcpPort: 8765
};

function resolveSetStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

interface EngineSetupState {
  settings: UnitySettings;
  settingsDraft: UnitySettings;
  onboardingProjectPath: string;
  onboardingEnginePluginId: string;
  setSettings: Dispatch<SetStateAction<UnitySettings>>;
  setSettingsDraft: Dispatch<SetStateAction<UnitySettings>>;
  setOnboardingProjectPath: Dispatch<SetStateAction<string>>;
  setOnboardingEnginePluginId: Dispatch<SetStateAction<string>>;
}

export const useEngineSetupStore = create<EngineSetupState>((set) => ({
  settings: emptyUnitySettings,
  settingsDraft: emptyUnitySettings,
  onboardingProjectPath: '~/Downloads',
  onboardingEnginePluginId: '',
  setSettings: (value) => set((state) => ({ settings: resolveSetStateAction(value, state.settings) })),
  setSettingsDraft: (value) => set((state) => ({ settingsDraft: resolveSetStateAction(value, state.settingsDraft) })),
  setOnboardingProjectPath: (value) =>
    set((state) => ({ onboardingProjectPath: resolveSetStateAction(value, state.onboardingProjectPath) })),
  setOnboardingEnginePluginId: (value) =>
    set((state) => ({ onboardingEnginePluginId: resolveSetStateAction(value, state.onboardingEnginePluginId) }))
}));
