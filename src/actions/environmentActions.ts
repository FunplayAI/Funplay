import type {
  EngineProjectDimension,
  EnvironmentActionKind,
  EnvironmentActionResult,
  EnvironmentDiagnostics,
  Project
} from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { useProjectStore } from '../stores/projectStore';

/**
 * Engine-environment orchestration extracted from App.tsx — diagnose the
 * selected project's engine and run import/open actions against it.
 *
 * Both handlers are thin wrappers over window.funplay that share one pure
 * input-builder (buildEnvironmentInput) and need only the per-render selected
 * project view plus the UI language injected; the post-action runtime refresh
 * is reached through projectStore.getState(), so it is not an inject-dep.
 */

type EnvironmentInput = {
  platform: Exclude<NonNullable<Project['engine']>['platform'], 'web'>;
  mode: 'import';
  dimension: EngineProjectDimension;
  projectPath: string;
  enginePluginId?: string;
  unityEditorVersion?: string;
};

function buildEnvironmentInput(project: Project, language: UiLanguage): EnvironmentInput {
  if (!project.engine?.projectPath || project.engine.platform === 'web') {
    throw new Error(
      localize(language, '当前项目没有可打开的引擎路径。', 'This project has no engine path to open.')
    );
  }
  return {
    platform: project.engine.platform,
    mode: 'import',
    dimension: project.engine.dimension ?? project.runtimeState?.detectedDimension ?? 'unknown',
    projectPath: project.engine.projectPath,
    enginePluginId: project.mcpBindings.engine || project.mcpPluginId,
    unityEditorVersion: project.engine.unityEditorVersion
  };
}

interface EnvironmentActionDeps {
  /** The selected project resolved with its runtime state (App's selectedProjectView). */
  getSelectedProject: () => Project | null;
  language: UiLanguage;
}

export interface EnvironmentActions {
  diagnoseSelectedProjectEnvironment: () => Promise<EnvironmentDiagnostics>;
  runSelectedProjectEnvironmentAction: (actionId: EnvironmentActionKind) => Promise<EnvironmentActionResult>;
}

export function createEnvironmentActions({ getSelectedProject, language }: EnvironmentActionDeps): EnvironmentActions {
  async function diagnoseSelectedProjectEnvironment(): Promise<EnvironmentDiagnostics> {
    const project = getSelectedProject();
    if (!project) {
      throw new Error(localize(language, '请先选择一个项目。', 'Select a project first.'));
    }
    return window.funplay.diagnoseEnvironment(buildEnvironmentInput(project, language));
  }

  async function runSelectedProjectEnvironmentAction(
    actionId: EnvironmentActionKind
  ): Promise<EnvironmentActionResult> {
    const project = getSelectedProject();
    if (!project) {
      throw new Error(localize(language, '请先选择一个项目。', 'Select a project first.'));
    }
    const result = await window.funplay.runEnvironmentAction({
      ...buildEnvironmentInput(project, language),
      actionId
    });
    void useProjectStore.getState().retryRefreshProjectRuntimeState(project.id, 6, 1200);
    return result;
  }

  return { diagnoseSelectedProjectEnvironment, runSelectedProjectEnvironmentAction };
}
