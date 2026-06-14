import { type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import type { AppSettingsTab, ProjectSettingsTab } from '../lib/app-types';

/**
 * App-shell navigation and lifecycle UI state — the workspace mode/section, the
 * project-settings tab, the app-settings modal, and the bootstrap loading/error
 * flags. Second slice of the Zustand state layer extracted from App.tsx.
 *
 * Setters keep the React `Dispatch<SetStateAction<T>>` shape so existing call
 * sites work verbatim.
 */

export type AppMode = 'welcome' | 'onboarding' | 'workspace';
export type WorkspaceSection = 'agent' | 'settings' | 'assets';

function resolveSetStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

interface UiShellState {
  appMode: AppMode;
  section: WorkspaceSection;
  projectSettingsTab: ProjectSettingsTab;
  showAppSettingsModal: boolean;
  appSettingsInitialTab: AppSettingsTab;
  isLoading: boolean;
  bootstrapError: string;
  setAppMode: Dispatch<SetStateAction<AppMode>>;
  setSection: Dispatch<SetStateAction<WorkspaceSection>>;
  setProjectSettingsTab: Dispatch<SetStateAction<ProjectSettingsTab>>;
  setShowAppSettingsModal: Dispatch<SetStateAction<boolean>>;
  setAppSettingsInitialTab: Dispatch<SetStateAction<AppSettingsTab>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setBootstrapError: Dispatch<SetStateAction<string>>;
  /** Open the app-settings modal pre-selected to a tab (migrated from App.tsx). */
  openAppSettings: (tab?: AppSettingsTab) => void;
}

export const useUiShellStore = create<UiShellState>((set) => ({
  appMode: 'welcome',
  section: 'agent',
  projectSettingsTab: 'engine',
  showAppSettingsModal: false,
  appSettingsInitialTab: 'appearance',
  isLoading: true,
  bootstrapError: '',
  setAppMode: (value) => set((state) => ({ appMode: resolveSetStateAction(value, state.appMode) })),
  setSection: (value) => set((state) => ({ section: resolveSetStateAction(value, state.section) })),
  setProjectSettingsTab: (value) =>
    set((state) => ({ projectSettingsTab: resolveSetStateAction(value, state.projectSettingsTab) })),
  setShowAppSettingsModal: (value) =>
    set((state) => ({ showAppSettingsModal: resolveSetStateAction(value, state.showAppSettingsModal) })),
  setAppSettingsInitialTab: (value) =>
    set((state) => ({ appSettingsInitialTab: resolveSetStateAction(value, state.appSettingsInitialTab) })),
  setIsLoading: (value) => set((state) => ({ isLoading: resolveSetStateAction(value, state.isLoading) })),
  setBootstrapError: (value) => set((state) => ({ bootstrapError: resolveSetStateAction(value, state.bootstrapError) })),
  openAppSettings: (tab = 'appearance') => set({ appSettingsInitialTab: tab, showAppSettingsModal: true })
}));
