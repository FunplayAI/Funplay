import { type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import type { Project, ProjectFileEntry } from '../../shared/types';
import type { AssetLibraryViewId } from '../components/pages/AssetsPage';
import { mergeProjectRuntimeRefresh, shouldUseFastRuntimeRefresh, wait } from '../lib/app-helpers';

/**
 * Project-domain state — the project list, the selected project, its file tree,
 * the per-project asset-library view, and the delete-project modal flow. Third
 * slice of the Zustand state layer extracted from App.tsx.
 *
 * Setters keep the React `Dispatch<SetStateAction<T>>` shape, so App keeps
 * passing them to hooks (useSelectedProjectView, useCheckpointManager, …) and
 * uses them in handler bodies verbatim.
 */

function resolveSetStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

interface ProjectState {
  projects: Project[];
  selectedProjectId: string;
  projectFiles: ProjectFileEntry[];
  assetLibraryViewByProject: Record<string, AssetLibraryViewId>;
  showDeleteProjectModal: boolean;
  projectPendingDelete: Project | null;
  isDeletingProject: boolean;
  deleteProjectSourceFiles: boolean;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  setProjectFiles: Dispatch<SetStateAction<ProjectFileEntry[]>>;
  setAssetLibraryViewByProject: Dispatch<SetStateAction<Record<string, AssetLibraryViewId>>>;
  setShowDeleteProjectModal: Dispatch<SetStateAction<boolean>>;
  setProjectPendingDelete: Dispatch<SetStateAction<Project | null>>;
  setIsDeletingProject: Dispatch<SetStateAction<boolean>>;
  setDeleteProjectSourceFiles: Dispatch<SetStateAction<boolean>>;
  /** Open the delete-project modal for a project (migrated from App.tsx). */
  openDeleteModal: (project: Project) => void;
  /** Close the delete-project modal unless a deletion is already in flight. */
  closeDeleteModal: () => void;
  /** Pull fresh engine runtime state for one project and merge it into the list. */
  refreshProjectRuntimeStateById: (projectId: string) => Promise<Project | null>;
  /** Poll runtime state until the bridge is online (or fast-refresh stops being useful). */
  retryRefreshProjectRuntimeState: (projectId: string, attempts?: number, delayMs?: number) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: '',
  projectFiles: [],
  assetLibraryViewByProject: {},
  showDeleteProjectModal: false,
  projectPendingDelete: null,
  isDeletingProject: false,
  deleteProjectSourceFiles: false,
  setProjects: (value) => set((state) => ({ projects: resolveSetStateAction(value, state.projects) })),
  setSelectedProjectId: (value) =>
    set((state) => ({ selectedProjectId: resolveSetStateAction(value, state.selectedProjectId) })),
  setProjectFiles: (value) => set((state) => ({ projectFiles: resolveSetStateAction(value, state.projectFiles) })),
  setAssetLibraryViewByProject: (value) =>
    set((state) => ({ assetLibraryViewByProject: resolveSetStateAction(value, state.assetLibraryViewByProject) })),
  setShowDeleteProjectModal: (value) =>
    set((state) => ({ showDeleteProjectModal: resolveSetStateAction(value, state.showDeleteProjectModal) })),
  setProjectPendingDelete: (value) =>
    set((state) => ({ projectPendingDelete: resolveSetStateAction(value, state.projectPendingDelete) })),
  setIsDeletingProject: (value) =>
    set((state) => ({ isDeletingProject: resolveSetStateAction(value, state.isDeletingProject) })),
  setDeleteProjectSourceFiles: (value) =>
    set((state) => ({ deleteProjectSourceFiles: resolveSetStateAction(value, state.deleteProjectSourceFiles) })),
  openDeleteModal: (project) =>
    set({ projectPendingDelete: project, deleteProjectSourceFiles: false, showDeleteProjectModal: true }),
  closeDeleteModal: () =>
    set((state) =>
      state.isDeletingProject
        ? {}
        : { showDeleteProjectModal: false, projectPendingDelete: null, deleteProjectSourceFiles: false }
    ),
  refreshProjectRuntimeStateById: async (projectId) => {
    const updated = await window.funplay.refreshProjectRuntimeState(projectId);
    if (!updated) {
      return null;
    }
    get().setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectRuntimeRefresh(project, updated) : project))
    );
    return updated;
  },
  retryRefreshProjectRuntimeState: async (projectId, attempts = 6, delayMs = 1500) => {
    for (let index = 0; index < attempts; index += 1) {
      const updated = await get()
        .refreshProjectRuntimeStateById(projectId)
        .catch(() => null);
      if (updated?.runtimeState?.bridgeHealth?.status === 'online') {
        return;
      }
      if (updated?.runtimeState && !shouldUseFastRuntimeRefresh(updated)) {
        return;
      }
      if (index < attempts - 1) {
        await wait(delayMs);
      }
    }
  }
}));
