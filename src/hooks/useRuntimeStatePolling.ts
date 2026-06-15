import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ProjectFileItem } from '../components/layout/WorkspacePanels';
import { useProjectStore } from '../stores/projectStore';

interface UseRuntimeStatePollingParams {
  appMode: string;
  selectedProjectId: string;
  runtimePath: string;
  useFastRefresh: boolean;
  selectedOverlayFile: ProjectFileItem | null;
  setRightInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
}

/**
 * Polls the selected project's engine runtime state while it is open: one
 * immediate refresh on entry, then a 5s interval for fast-refresh engines
 * (Unity/Cocos with the bridge installed), cancelled on project change/unmount.
 * Also collapses the right inspector on project entry when no overlay file is
 * open. Reads refreshProjectRuntimeStateById from the project store. Extracted
 * from App.tsx — call after useFileInspector so selectedOverlayFile is resolved.
 */
export function useRuntimeStatePolling({
  appMode,
  selectedProjectId,
  runtimePath,
  useFastRefresh,
  selectedOverlayFile,
  setRightInspectorCollapsed
}: UseRuntimeStatePollingParams): void {
  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !runtimePath) {
      return;
    }
    if (!selectedOverlayFile) {
      setRightInspectorCollapsed(true);
    }

    let cancelled = false;
    const refreshRuntimeState = async (): Promise<void> => {
      try {
        if (!cancelled) {
          await useProjectStore.getState().refreshProjectRuntimeStateById(selectedProjectId);
        }
      } catch {
        // noop
      }
    };

    void refreshRuntimeState();
    if (!useFastRefresh) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => {
      void refreshRuntimeState();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // selectedOverlayFile is read lazily on (re)entry, intentionally not a trigger.
  }, [appMode, selectedProjectId, runtimePath, useFastRefresh]);
}
