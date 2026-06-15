import { useEffect } from 'react';
import { useUiShellStore } from '../stores/uiShellStore';
import { useProjectStore } from '../stores/projectStore';

/**
 * When the app enters the workspace with no project selected, fall back to the
 * first project. Fully store-backed — reads appMode (ui-shell) and the project
 * list/selection (project store) via selectors, takes no arguments. Extracted
 * from App.tsx as part of the render-tree decomposition.
 */
export function useAppModeProjectSync(): void {
  const appMode = useUiShellStore((store) => store.appMode);
  const selectedProjectId = useProjectStore((store) => store.selectedProjectId);
  const projects = useProjectStore((store) => store.projects);
  const setSelectedProjectId = useProjectStore((store) => store.setSelectedProjectId);

  useEffect(() => {
    if (appMode !== 'workspace' || selectedProjectId || projects.length === 0) {
      return;
    }
    setSelectedProjectId(projects[0].id);
  }, [appMode, selectedProjectId, projects, setSelectedProjectId]);
}
