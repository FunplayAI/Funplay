import type { Dispatch, SetStateAction } from 'react';
import type { CreateProjectInput, McpPlugin } from '../../shared/types';
import type { ProjectFileItem } from '../components/layout/WorkspacePanels';
import { dispatchRefreshFileTree } from '../lib/file-tree-events';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionComposerStore } from '../stores/sessionComposerStore';
import { useUiShellStore } from '../stores/uiShellStore';
import { useEngineSetupStore } from '../stores/engineSetupStore';

/**
 * Project navigation + lifecycle orchestration extracted from App.tsx — open a
 * project into the workspace, create one (optionally binding an onboarding
 * engine plugin), and delete the pending one.
 *
 * Project/session/composer/ui-shell/engine state is reached via getState(). The
 * injects are the renderer state that has no Zustand home yet: the file-inspector
 * selection setters, the workspace-layout inspector toggle, and the MCP-plugin
 * list + setters (all owned by hooks). window.funplay and dispatchRefreshFileTree
 * are direct calls; the post-create runtime refresh rides projectStore.getState().
 */

interface ProjectNavActionDeps {
  setSelectedFileId: Dispatch<SetStateAction<string>>;
  setSelectedOverlayFile: Dispatch<SetStateAction<ProjectFileItem | null>>;
  setRightInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
  getMcpPlugins: () => McpPlugin[];
  setMcpPlugins: Dispatch<SetStateAction<McpPlugin[]>>;
  setSelectedMcpPluginId: Dispatch<SetStateAction<string>>;
}

export interface ProjectNavActions {
  openProject: (projectId: string) => void;
  handleCreateProject: (input: CreateProjectInput) => Promise<void>;
  handleDeleteProject: () => Promise<void>;
}

export function createProjectNavActions({
  setSelectedFileId,
  setSelectedOverlayFile,
  setRightInspectorCollapsed,
  getMcpPlugins,
  setMcpPlugins,
  setSelectedMcpPluginId
}: ProjectNavActionDeps): ProjectNavActions {
  function openProject(projectId: string): void {
    const projectStore = useProjectStore.getState();
    const project = projectStore.projects.find((item) => item.id === projectId);
    projectStore.setSelectedProjectId(projectId);
    if (project) {
      useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
        ...current,
        [projectId]: project.activeSessionId || project.sessions[0]?.id || ''
      }));
    }
    const ui = useUiShellStore.getState();
    ui.setAppMode('workspace');
    ui.setSection('agent');
    setSelectedFileId('');
    setSelectedOverlayFile(null);
    setRightInspectorCollapsed(true);
    dispatchRefreshFileTree({ projectId, reason: 'project-opened' });
  }

  async function handleCreateProject(input: CreateProjectInput): Promise<void> {
    const project = await window.funplay.createProject(input);
    const onboardingEnginePluginId = useEngineSetupStore.getState().onboardingEnginePluginId;
    const shouldBindOnboardingEnginePlugin = input.engine?.platform === 'unity' && onboardingEnginePluginId;
    const nextProject = shouldBindOnboardingEnginePlugin
      ? await window.funplay.updateProjectMcpConfig(project.id, 'engine', onboardingEnginePluginId)
      : project;
    const enginePluginId = nextProject.mcpBindings.engine;
    if (
      (input.engine?.platform === 'unity' || input.engine?.platform === 'cocos') &&
      enginePluginId &&
      !getMcpPlugins().some((plugin) => plugin.id === enginePluginId)
    ) {
      const payload = await window.funplay.bootstrap();
      setMcpPlugins(payload.mcpPlugins);
      setSelectedMcpPluginId(enginePluginId);
    }

    const projectStore = useProjectStore.getState();
    projectStore.setProjects((current) => [nextProject, ...current.filter((item) => item.id !== nextProject.id)]);
    useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
      ...current,
      [nextProject.id]: nextProject.activeSessionId || nextProject.sessions[0]?.id || ''
    }));
    projectStore.setSelectedProjectId(nextProject.id);
    setRightInspectorCollapsed(true);
    if (nextProject.engine?.platform === 'unity' || nextProject.engine?.platform === 'cocos') {
      void projectStore.retryRefreshProjectRuntimeState(nextProject.id);
    }

    const ui = useUiShellStore.getState();
    ui.setAppMode('workspace');
    ui.setSection('agent');
    setSelectedFileId('');
    setSelectedOverlayFile(null);
    dispatchRefreshFileTree({ projectId: nextProject.id, reason: 'project-created' });
  }

  async function handleDeleteProject(): Promise<void> {
    const projectPendingDelete = useProjectStore.getState().projectPendingDelete;
    if (!projectPendingDelete) {
      return;
    }

    useProjectStore.getState().setIsDeletingProject(true);
    try {
      const result = await window.funplay.deleteProject(
        projectPendingDelete.id,
        useProjectStore.getState().deleteProjectSourceFiles
      );
      useProjectStore.getState().setProjects(result.remainingProjects);
      useSessionStore.getState().setLocalActiveSessionByProject((current) => {
        const next = { ...current };
        delete next[projectPendingDelete.id];
        return next;
      });
      useSessionComposerStore.getState().clearSessionScoped(projectPendingDelete.sessions.map((session) => session.id));

      if (useProjectStore.getState().selectedProjectId === projectPendingDelete.id) {
        const nextProjectId = result.remainingProjects[0]?.id ?? '';
        if (nextProjectId) {
          openProject(nextProjectId);
        } else {
          useProjectStore.getState().setSelectedProjectId('');
          const ui = useUiShellStore.getState();
          ui.setAppMode('welcome');
          ui.setSection('agent');
          setSelectedFileId('');
          setSelectedOverlayFile(null);
          useProjectStore.getState().setProjectFiles([]);
        }
      }

      const projectStore = useProjectStore.getState();
      projectStore.setShowDeleteProjectModal(false);
      projectStore.setProjectPendingDelete(null);
      projectStore.setDeleteProjectSourceFiles(false);
    } finally {
      useProjectStore.getState().setIsDeletingProject(false);
    }
  }

  return { openProject, handleCreateProject, handleDeleteProject };
}
