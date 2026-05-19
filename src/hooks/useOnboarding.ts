import { useEffect, useState } from 'react';
import {
  type CreateProjectInput,
  type EnvironmentActionResult,
  type EnvironmentDiagnostics,
  type EnvironmentTask,
  type EngineProjectDimension,
  type InstalledUnityEditorOption,
  type PlatformChoice,
  type Project,
  type ProjectSetupMode,
  type UnitySettings
} from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { getFolderNameFromPath, resolveEngineProjectPath } from '../lib/app-helpers';

interface UseOnboardingParams {
  appMode: string;
  projects: Project[];
  settings: UnitySettings;
  setSettings: (s: UnitySettings) => void;
  setSettingsDraft: (s: UnitySettings) => void;
  onboardingEnginePluginId: string;
  setOnboardingEnginePluginId: (id: string) => void;
  onboardingProjectPath: string;
  setOnboardingProjectPath: (p: string) => void;
  handleCreateProject: (input: CreateProjectInput) => Promise<void>;
  openProject: (projectId: string) => void;
  language: UiLanguage;
}

export function useOnboarding(params: UseOnboardingParams) {
  const {
    appMode,
    projects,
    settings,
    setSettings,
    setSettingsDraft,
    onboardingEnginePluginId,
    setOnboardingEnginePluginId,
    onboardingProjectPath,
    setOnboardingProjectPath,
    handleCreateProject,
    openProject,
    language
  } = params;

  const [isCheckingEngine, setIsCheckingEngine] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3>(1);
  const [onboardingView, setOnboardingView] = useState<'setup' | 'environment'>('setup');
  const [onboardingMode, setOnboardingMode] = useState<ProjectSetupMode>('create');
  const [onboardingPlatform, setOnboardingPlatform] = useState<PlatformChoice>('web');
  const [onboardingDimension, setOnboardingDimension] = useState<EngineProjectDimension>('2d');
  const [onboardingProjectName, setOnboardingProjectName] = useState('');
  const [onboardingUnityEditors, setOnboardingUnityEditors] = useState<InstalledUnityEditorOption[]>([]);
  const [onboardingUnityEditorVersion, setOnboardingUnityEditorVersion] = useState('');
  const [onboardingDetectionMessage, setOnboardingDetectionMessage] = useState('');
  const [onboardingDetectionOk, setOnboardingDetectionOk] = useState(false);
  const [environmentDiagnostics, setEnvironmentDiagnostics] = useState<EnvironmentDiagnostics | null>(null);
  const [environmentActionMessage, setEnvironmentActionMessage] = useState('');
  const [environmentTasks, setEnvironmentTasks] = useState<EnvironmentTask[]>([]);
  const [lastAutoDiagnosedTaskId, setLastAutoDiagnosedTaskId] = useState('');

  useEffect(() => {
    setEnvironmentDiagnostics(null);
    setOnboardingDetectionOk(false);
    setEnvironmentActionMessage('');
  }, [onboardingMode, onboardingPlatform, onboardingProjectPath, onboardingEnginePluginId, onboardingDimension]);

  useEffect(() => {
    if (onboardingPlatform === 'cocos') {
      setOnboardingDimension('2d');
    }
  }, [onboardingPlatform]);

  useEffect(() => {
    if (appMode !== 'onboarding' || onboardingPlatform !== 'unity' || onboardingMode !== 'create') {
      return;
    }

    let cancelled = false;
    const loadInstalledEditors = async (): Promise<void> => {
      try {
        const editors = await window.funplay.listInstalledUnityEditors(onboardingDimension);
        if (cancelled) {
          return;
        }
        setOnboardingUnityEditors(editors);
        setOnboardingUnityEditorVersion((current) => {
          if (current && editors.some((editor) => editor.version === current)) {
            return current;
          }
          return editors.find((editor) => editor.recommended)?.version ?? editors[0]?.version ?? '';
        });
      } catch {
        if (!cancelled) {
          setOnboardingUnityEditors([]);
          setOnboardingUnityEditorVersion('');
        }
      }
    };

    void loadInstalledEditors();
    return () => {
      cancelled = true;
    };
  }, [appMode, onboardingPlatform, onboardingMode, onboardingDimension]);

  useEffect(() => {
    if (appMode !== 'onboarding') {
      return;
    }

    let cancelled = false;
    const refreshTasks = async (): Promise<void> => {
      if (!window.funplay?.listEnvironmentTasks) {
        return;
      }
      try {
        const tasks = await window.funplay.listEnvironmentTasks();
        if (!cancelled) {
          setEnvironmentTasks(tasks);
        }
      } catch {
        // noop
      }
    };

    void refreshTasks();
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appMode]);

  useEffect(() => {
    if (appMode !== 'onboarding' || environmentTasks.length === 0 || isCheckingEngine) {
      return;
    }

    const latestTask = environmentTasks[0];
    if (latestTask.id === lastAutoDiagnosedTaskId) {
      return;
    }
    if (!['completed', 'needs_user', 'failed'].includes(latestTask.status)) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLastAutoDiagnosedTaskId(latestTask.id);
      void handleCheckOnboardingConnection();
    }, 600);

    return () => window.clearTimeout(timer);
  }, [appMode, environmentTasks, isCheckingEngine, lastAutoDiagnosedTaskId]);

  function buildOnboardingProjectInput(input: {
    mode: ProjectSetupMode;
    platform: PlatformChoice;
    dimension: EngineProjectDimension;
    projectName: string;
    projectPath: string;
    unityEditorVersion?: string;
  }): CreateProjectInput {
    const isGenericProject = input.platform === 'web';
    const targetProjectPath =
      input.mode === 'create' && (input.platform === 'unity' || input.platform === 'cocos' || isGenericProject)
        ? resolveEngineProjectPath(input.mode, input.projectPath, input.projectName)
        : input.projectPath.trim();
    const resolvedName =
      input.projectName.trim() ||
      getFolderNameFromPath(targetProjectPath) ||
      localize(language, '未命名项目', 'Untitled Project');

    if (isGenericProject) {
      return {
        name: resolvedName,
        templateId: 'generic-workspace',
        artStyle: localize(language, '通用工作区', 'Generic Workspace'),
        pitch: localize(
          language,
          '通用工作区项目，可用于代码、文档、素材和 AI 对话协作',
          'a generic workspace project for code, documents, assets, and AI collaboration'
        ),
        engine: {
          platform: input.platform,
          setupMode: input.mode,
          projectPath: targetProjectPath,
          dimension: 'unknown'
        }
      };
    }

    return {
      name: resolvedName || 'Flappy Bird',
      templateId: 'engine-game-prototype',
      artStyle: input.dimension === '2d'
        ? localize(language, '像素风格', 'Pixel Art')
        : localize(language, '暗黑卡通', 'Dark Cartoon'),
      pitch:
        input.platform === 'unity'
          ? localize(
              language,
              `由 AI 与引擎控制器共同制作的 Unity ${input.dimension === '2d' ? '2D' : '3D'} 游戏原型`,
              `A Unity ${input.dimension === '2d' ? '2D' : '3D'} game prototype co-created by AI and the engine controller`
            )
          : input.platform === 'cocos'
            ? localize(language, '由 AI 规划并接入 Cocos Creator 的 2D 游戏原型', 'A 2D game prototype planned by AI and connected to Cocos Creator')
            : localize(language, '由 AI 制作的轻量游戏原型', 'A lightweight game prototype created by AI'),
      engine: {
        platform: input.platform,
        setupMode: input.mode,
        projectPath: targetProjectPath,
        dimension: input.dimension,
        unityEditorVersion: input.platform === 'unity' ? input.unityEditorVersion || undefined : undefined
      }
    };
  }

  async function runOnboardingDiagnostics(input: {
    mode: ProjectSetupMode;
    platform: PlatformChoice;
    dimension: EngineProjectDimension;
    projectName: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }): Promise<void> {
    setIsCheckingEngine(true);
    setEnvironmentActionMessage('');
    try {
      const diagnostics = await window.funplay.diagnoseEnvironment({
        platform: input.platform,
        mode: input.mode,
        dimension: input.dimension,
        projectName: input.projectName,
        projectPath: input.projectPath,
        enginePluginId: input.enginePluginId || undefined,
        unityEditorVersion: input.unityEditorVersion || undefined
      });
      setOnboardingDimension(diagnostics.dimension);
      setEnvironmentDiagnostics(diagnostics);
      setOnboardingEnginePluginId(diagnostics.enginePluginId ?? input.enginePluginId ?? onboardingEnginePluginId);
      setOnboardingUnityEditors(diagnostics.availableUnityEditors ?? []);
      setOnboardingUnityEditorVersion(
        diagnostics.selectedUnityVersion ??
          diagnostics.availableUnityEditors?.find((editor) => editor.recommended)?.version ??
          input.unityEditorVersion ??
          onboardingUnityEditorVersion
      );
      const failedCheck = diagnostics.checks.find((check) => check.status === 'failed');
      const warningCheck = diagnostics.checks.find((check) => check.status === 'warning');
      const summaryCheck = failedCheck ?? warningCheck;
      setOnboardingDetectionMessage(
        diagnostics.ready
          ? localize(language, '环境检测通过，可以进入工作台。', 'Environment check passed. You can enter the workspace.')
          : summaryCheck?.detail || localize(language, '请根据检测结果完成安装与修复。', 'Finish the required install and fixes based on the check results.')
      );
      setOnboardingDetectionOk(diagnostics.ready);
      setOnboardingView('environment');
    } catch (error) {
      setOnboardingDetectionMessage(error instanceof Error ? error.message : localize(language, '检测失败', 'Check failed'));
      setOnboardingDetectionOk(false);
      setOnboardingView('environment');
    } finally {
      setIsCheckingEngine(false);
    }
  }

  async function handleCheckOnboardingConnection(): Promise<void> {
    if (onboardingMode === 'create' && !onboardingProjectName.trim()) {
      setOnboardingDetectionMessage(localize(language, '请先填写项目名称。', 'Please enter a project name first.'));
      setOnboardingDetectionOk(false);
      setOnboardingView('setup');
      return;
    }
    if (!onboardingProjectPath.trim()) {
      setOnboardingDetectionMessage(
        onboardingMode === 'create'
          ? localize(language, '请先选择项目创建目录。', 'Please choose a destination folder first.')
          : localize(language, '请先选择已有项目目录。', 'Please choose an existing project folder first.')
      );
      setOnboardingDetectionOk(false);
      setOnboardingView('setup');
      return;
    }
    await runOnboardingDiagnostics({
      mode: onboardingMode,
      platform: onboardingPlatform,
      dimension: onboardingDimension,
      projectName: onboardingProjectName,
      projectPath: onboardingProjectPath,
      enginePluginId: onboardingEnginePluginId || undefined,
      unityEditorVersion: onboardingUnityEditorVersion || undefined
    });
  }

  async function handlePickExistingProjectFromWelcome(): Promise<void> {
    const result = await window.funplay.pickProjectFolder({
      mode: 'import',
      defaultPath: settings.lastCreatedProjectDirectory || onboardingProjectPath
    });
    if (result.canceled || !result.path) {
      return;
    }

    const matched = projects.find((project) => project.engine?.projectPath === result.path);
    if (matched) {
      openProject(matched.id);
      return;
    }

    setIsCreatingProject(true);
    try {
      await handleCreateProject(buildOnboardingProjectInput({
        mode: 'import',
        platform: 'web',
        dimension: 'unknown',
        projectName: '',
        projectPath: result.path,
        unityEditorVersion: onboardingUnityEditorVersion || undefined
      }));
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleRunEnvironmentAction(actionId: Parameters<typeof window.funplay.runEnvironmentAction>[0]['actionId']): Promise<void> {
    setEnvironmentActionMessage('');
    try {
      if (actionId === 'create_unity_project' && onboardingMode === 'create' && onboardingProjectPath.trim()) {
        const nextSettings = await window.funplay.updateSettings({
          lastCreatedProjectDirectory: onboardingProjectPath.trim()
        });
        setSettings(nextSettings);
        setSettingsDraft(nextSettings);
      }
      const result: EnvironmentActionResult = await window.funplay.runEnvironmentAction({
        actionId,
        platform: onboardingPlatform,
        mode: onboardingMode,
        dimension: onboardingDimension,
        projectName: onboardingProjectName,
        projectPath: onboardingProjectPath,
        enginePluginId: onboardingEnginePluginId || undefined,
        unityEditorVersion: onboardingUnityEditorVersion || undefined
      });
      setEnvironmentActionMessage(result.message);
      setEnvironmentTasks(await window.funplay.listEnvironmentTasks());
      if (!result.taskId) {
        await handleCheckOnboardingConnection();
      }
    } catch (error) {
      setEnvironmentActionMessage(error instanceof Error ? error.message : localize(language, '执行失败', 'Action failed'));
    }
  }

  async function handleBrowseOnboardingProjectPath(): Promise<void> {
    const result = await window.funplay.pickProjectFolder({
      mode: onboardingMode,
      defaultPath: onboardingMode === 'create' ? settings.lastCreatedProjectDirectory || onboardingProjectPath : onboardingProjectPath
    });
    if (!result.canceled && result.path) {
      setOnboardingProjectPath(result.path);
      if (onboardingMode === 'create') {
        const nextSettings = await window.funplay.updateSettings({
          lastCreatedProjectDirectory: result.path
        });
        setSettings(nextSettings);
        setSettingsDraft(nextSettings);
      }
    }
  }

  async function handleFinishOnboarding(): Promise<void> {
    if (onboardingPlatform === 'web') {
      await handleEnterWorkspace();
      return;
    }
    if (onboardingMode === 'create' && !onboardingProjectName.trim()) {
      setOnboardingDetectionMessage(localize(language, '请先填写项目名称。', 'Please enter a project name first.'));
      setOnboardingDetectionOk(false);
      return;
    }
    if (!onboardingDetectionOk) {
      await handleCheckOnboardingConnection();
      return;
    }
    setOnboardingStep(3);
  }

  async function handleEnterWorkspace(): Promise<void> {
    if (onboardingMode === 'create' && !onboardingProjectName.trim()) {
      setOnboardingDetectionMessage(localize(language, '请先填写项目名称。', 'Please enter a project name first.'));
      setOnboardingDetectionOk(false);
      setOnboardingView('setup');
      return;
    }
    if (!onboardingProjectPath.trim()) {
      setOnboardingDetectionMessage(
        onboardingMode === 'create'
          ? localize(language, '请先选择项目存放目录。', 'Please choose a destination folder first.')
          : localize(language, '请先选择已有项目目录。', 'Please choose an existing project folder first.')
      );
      setOnboardingDetectionOk(false);
      setOnboardingView('setup');
      return;
    }

    setIsCreatingProject(true);
    try {
      await handleCreateProject(buildOnboardingProjectInput({
        mode: onboardingMode,
        platform: onboardingPlatform,
        dimension: onboardingPlatform === 'web' ? 'unknown' : onboardingDimension,
        projectName: onboardingProjectName,
        projectPath: onboardingProjectPath,
        unityEditorVersion: onboardingUnityEditorVersion || environmentDiagnostics?.selectedUnityVersion
      }));
    } catch (error) {
      setOnboardingDetectionMessage(error instanceof Error ? error.message : localize(language, '创建项目失败。', 'Failed to create project.'));
      setOnboardingDetectionOk(false);
      setOnboardingView('setup');
    } finally {
      setIsCreatingProject(false);
    }
  }

  function startOnboarding(): void {
    setOnboardingStep(1);
    setOnboardingView('setup');
    setOnboardingMode('create');
    setOnboardingPlatform('web');
    setOnboardingProjectName('');
    setOnboardingDetectionMessage('');
    setOnboardingDetectionOk(false);
    setEnvironmentActionMessage('');
    setEnvironmentDiagnostics(null);
  }

  return {
    onboardingStep,
    onboardingView,
    onboardingMode,
    onboardingPlatform,
    onboardingDimension,
    onboardingProjectName,
    onboardingProjectPath,
    onboardingEnginePluginId,
    onboardingUnityEditors,
    onboardingUnityEditorVersion,
    onboardingDetectionMessage,
    onboardingDetectionOk,
    environmentDiagnostics,
    environmentActionMessage,
    environmentTasks,
    isCheckingEngine,
    isCreatingProject,

    setOnboardingMode,
    setOnboardingPlatform,
    setOnboardingDimension,
    setOnboardingProjectName,
    setOnboardingProjectPath,
    setOnboardingUnityEditorVersion,
    setOnboardingView,

    handleBrowseOnboardingProjectPath,
    handleCheckOnboardingConnection,
    handleRunEnvironmentAction,
    handleFinishOnboarding,
    handleEnterWorkspace,
    handlePickExistingProjectFromWelcome,
    startOnboarding
  };
}
