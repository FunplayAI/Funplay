import { useCallback, useEffect, useRef } from 'react';
import { dispatchRefreshFileTree, subscribeRefreshFileTree } from '../lib/file-tree-events';
import { useProjectStore } from '../stores/projectStore';

interface UseProjectFilesParams {
  appMode: string;
  selectedProjectId: string;
  enginePath: string | undefined;
}

/**
 * Mirrors the selected project's file tree into projectStore.projectFiles —
 * the initial/selection-change load, the main-process watcher → refresh bus,
 * and the bus subscription. Owns selectedProjectIdRef (the stale-closure guard
 * that keeps a late list-files reply from clobbering a newer selection) and
 * returns it + refreshProjectFiles for the prompt-stream/file-inspector hooks
 * that consume them — so this hook must be called before those consumers.
 */
export function useProjectFiles({ appMode, selectedProjectId, enginePath }: UseProjectFilesParams) {
  const selectedProjectIdRef = useRef(selectedProjectId);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const refreshProjectFiles = useCallback(async (projectId: string): Promise<void> => {
    if (!projectId) {
      useProjectStore.getState().setProjectFiles([]);
      return;
    }

    try {
      const files = await window.funplay.listProjectFiles(projectId);
      if (selectedProjectIdRef.current === projectId) {
        useProjectStore.getState().setProjectFiles(files);
      }
    } catch {
      if (selectedProjectIdRef.current === projectId) {
        useProjectStore.getState().setProjectFiles([]);
      }
    }
  }, []);

  // Main-process file watcher → refresh bus.
  useEffect(() => {
    if (!window.funplay?.onProjectFileTreeChanged) {
      return;
    }

    return window.funplay.onProjectFileTreeChanged((event) => {
      dispatchRefreshFileTree({ projectId: event.projectId, reason: 'watcher' });
    });
  }, []);

  // Initial load + reload on project selection change.
  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !enginePath) {
      useProjectStore.getState().setProjectFiles([]);
      return;
    }

    void refreshProjectFiles(selectedProjectId);
  }, [appMode, selectedProjectId, enginePath, refreshProjectFiles]);

  // Refresh-bus subscription (watcher events, post-prompt, asset import, manual…).
  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !enginePath) {
      return;
    }

    return subscribeRefreshFileTree((detail) => {
      if (detail.projectId && detail.projectId !== selectedProjectId) {
        return;
      }
      void refreshProjectFiles(selectedProjectId);
    });
  }, [appMode, selectedProjectId, enginePath, refreshProjectFiles]);

  return { refreshProjectFiles, selectedProjectIdRef };
}
