import { useEffect, useRef, type JSX } from 'react';
import { useUiPreferences } from './hooks/useUiPreferences';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout';
import { useSelectedProjectView } from './hooks/useSelectedProjectView';
import { useAppModeProjectSync } from './hooks/useAppModeProjectSync';
import { useProjectFiles } from './hooks/useProjectFiles';
import { useRuntimeStatePolling } from './hooks/useRuntimeStatePolling';
import { useSessionPanelDerivations } from './hooks/useSessionPanelDerivations';
import { createSessionActions } from './actions/sessionActions';
import { createEnvironmentActions } from './actions/environmentActions';
import { createPromptStreamActions } from './actions/promptStreamActions';
import { createProjectNavActions } from './actions/projectNavActions';
import { useAppNotifications } from './hooks/useAppNotifications';
import { useAppUpdateStatus } from './hooks/useAppUpdateStatus';
import { useProviderManager } from './hooks/useProviderManager';
import { useAssetGenerationProviders } from './hooks/useAssetGenerationProviders';
import { useSessionComposerStore } from './stores/sessionComposerStore';
import { useUiShellStore, type WorkspaceSection } from './stores/uiShellStore';
import { useProjectStore } from './stores/projectStore';
import { useSessionStore } from './stores/sessionStore';
import { useEngineSetupStore } from './stores/engineSetupStore';
import { useNotificationTasks } from './hooks/useNotificationTasks';
import { useProjectMemory } from './hooks/useProjectMemory';
import { useChatFileOpeners, useFileInspector } from './hooks/useFileInspector';
import { useCheckpointManager } from './hooks/useCheckpointManager';
import { useProjectSkills } from './hooks/useProjectSkills';
import { useOnboarding } from './hooks/useOnboarding';
import { useAgentRuntimeActivity } from './hooks/useAgentRuntimeActivity';
import { useAssetGenerationCenter } from './hooks/useAssetGenerationCenter';
import { usePromptAttachmentImport } from './hooks/usePromptAttachmentImport';
import { useMcpManager } from './hooks/useMcpManager';
import { ensureProjectSessions } from '../shared/project-sessions';
import { type BootstrapPayload, type CreateProjectInput, type PromptStreamEvent } from '../shared/types';
import { AppShell } from './components/layout/AppShell';
import { AgentWorkbench } from './components/layout/AgentWorkbench';
import { UiLanguageProvider, localize } from './i18n';
import { dispatchRefreshFileTree } from './lib/file-tree-events';
import {
  applyPromptStreamEventToManager,
  listStreamSessions,
  removeStreamSession,
  type StreamSessionState
} from './lib/stream-session-manager';
import { AgentChatView } from './components/chat/AgentChatView';
import { FileInspectorPanel, SidebarPanel } from './components/layout/WorkspacePanels';
import { McpPluginModal } from './components/settings-modals';
import { shouldUseFastRuntimeRefresh } from './lib/app-helpers';
import { BootstrapScreens } from './components/pages/BootstrapScreens';
import { ProjectSettingsPage } from './components/pages/ProjectSettingsPage';
import { AssetsPage } from './components/pages/AssetsPage';
import { AppSettingsModal } from './components/modals/AppSettingsModal';
import { DeleteProjectModal } from './components/modals/DeleteProjectModal';
import { SessionChangesPanel, RestoreCheckpointModal } from './components/modals/SessionChangesPanel';
import { NotificationToastStack } from './components/shared/NotificationToastStack';

function App(): JSX.Element {
  // App-shell navigation + lifecycle UI state lives in the Zustand ui-shell store.
  // App is the root and re-renders on any of these, so it subscribes to the whole slice.
  const {
    appMode, setAppMode, section, setSection, projectSettingsTab, setProjectSettingsTab,
    showAppSettingsModal, setShowAppSettingsModal, appSettingsInitialTab,
    isLoading, setIsLoading, bootstrapError, setBootstrapError, openAppSettings
  } = useUiShellStore();
  // Project-domain state lives in the Zustand project store.
  const {
    projects, setProjects, selectedProjectId, setSelectedProjectId, projectFiles,
    assetLibraryViewByProject, setAssetLibraryViewByProject, showDeleteProjectModal,
    projectPendingDelete, isDeletingProject,
    deleteProjectSourceFiles, setDeleteProjectSourceFiles, openDeleteModal, closeDeleteModal,
    refreshProjectRuntimeStateById, retryRefreshProjectRuntimeState
  } = useProjectStore();
  const {
    assetGenerationProviderConfigs,
    setAssetGenerationProviderConfigs,
    handleCreateAssetGenerationProvider,
    handleUpdateAssetGenerationProvider,
    handleDeleteAssetGenerationProvider
  } = useAssetGenerationProviders();
  // Engine/project-setup state (settings + onboarding wizard) lives in the engine-setup store.
  const {
    settings, setSettings, setSettingsDraft,
    onboardingProjectPath, setOnboardingProjectPath, onboardingEnginePluginId, setOnboardingEnginePluginId
  } = useEngineSetupStore();
  // Per-session composer state now lives in the Zustand session-composer store.
  // The store setters share the React Dispatch<SetStateAction> shape, so call
  // sites and the hooks that receive them work unchanged.
  const setSessionDrafts = useSessionComposerStore((store) => store.setDrafts);
  const sessionAttachments = useSessionComposerStore((store) => store.attachments);
  const setSessionAttachments = useSessionComposerStore((store) => store.setAttachments);
  const setSessionComposerErrors = useSessionComposerStore((store) => store.setComposerErrors);
  const queuedPromptsBySession = useSessionComposerStore((store) => store.queuedPrompts);
  const setQueuedPromptsBySession = useSessionComposerStore((store) => store.setQueuedPrompts);
  const localActiveSessionByProject = useSessionStore((store) => store.localActiveSessionByProject);
  const setLocalActiveSessionByProject = useSessionStore((store) => store.setLocalActiveSessionByProject);

  const activeSessionSwitchTokenRef = useRef(0);
  const dequeueSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionMutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  function enqueueSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = sessionMutationQueueRef.current.then(operation, operation);
    sessionMutationQueueRef.current = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  const { uiPreferences, setUiPreferences } = useUiPreferences();
  const {
    leftSidebarCollapsed,
    setLeftSidebarCollapsed,
    rightInspectorCollapsed,
    setRightInspectorCollapsed,
    leftSidebarWidth,
    setLeftSidebarWidth,
    rightInspectorWidth,
    setRightInspectorWidth
  } = useWorkspaceLayout();
  const { appNotifications, dismissNotification } = useAppNotifications();
  const {
    appUpdateStatus,
    refreshAppUpdateStatus,
    checkForUpdates: handleCheckForUpdates,
    downloadUpdate: handleDownloadUpdate,
    installUpdate: handleInstallUpdate
  } = useAppUpdateStatus();
  const {
    providers,
    setProviders,
    aiSettings,
    setAiSettings,
    agentSettings,
    setAgentSettings,
    providerTests,
    handleCreateProvider,
    handleUpdateProvider,
    handleDeleteProvider,
    handleTestProvider,
    handleSetDefaultProvider
  } = useProviderManager();

  const onboarding = useOnboarding({
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
    language: uiPreferences.language
  });

  useEffect(() => {
    if (!window.funplay?.bootstrap) {
      setBootstrapError(
        localize(
          uiPreferences.language,
          'Funplay preload API 未成功注入。请重启应用；如果仍有问题，检查 Electron preload 是否正确加载。',
          'Funplay preload API was not injected. Restart the app, and if it still fails, verify Electron preload is loading correctly.'
        )
      );
      setIsLoading(false);
      return;
    }

    void window.funplay
      .bootstrap()
      .then((payload: BootstrapPayload) => {
        setProjects(payload.projects);
        setLocalActiveSessionByProject(
          Object.fromEntries(
            payload.projects.map((project) => [project.id, project.activeSessionId || project.sessions[0]?.id || ''])
          )
        );
        setProviders(payload.providers);
        setMcpPlugins(payload.mcpPlugins);
        setAssetGenerationProviderConfigs(payload.assetGenerationProviders ?? []);
        setAiSettings(payload.aiSettings);
        setAgentSettings(payload.agentSettings);
        setSettings(payload.settings);
        setSettingsDraft(payload.settings);
        setOnboardingProjectPath(payload.settings.lastCreatedProjectDirectory || '~/Downloads');
        setSelectedProjectId(payload.projects[0]?.id ?? '');
        setOnboardingEnginePluginId(
          payload.mcpPlugins.find(
            (plugin) => !plugin.projectId && plugin.kind === 'engine' && /unity/i.test(plugin.name)
          )?.id ??
            payload.mcpPlugins.find((plugin) => !plugin.projectId && plugin.kind === 'engine' && plugin.enabled)?.id ??
            ''
        );
        setAppMode(payload.projects.length > 0 ? 'workspace' : 'welcome');
      })
      .catch((error) => {
        setBootstrapError(
          error instanceof Error
            ? error.message
            : localize(uiPreferences.language, '应用启动失败', 'Failed to launch app')
        );
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const { selectedProject, selectedProjectView, selectedSessionId } = useSelectedProjectView({
    projects,
    selectedProjectId,
    localActiveSessionByProject
  });
  // Session CRUD orchestration lives in a factory (src/actions/sessionActions.ts);
  // it reads the renderer stores via getState() and only needs the per-render
  // selected project plus App's serialized-mutation queue.
  const {
    createSession: handleCreateSession,
    renameSession: handleRenameSession,
    deleteSession: handleDeleteSession,
    updateSelectedSessionRuntime,
    handleSelectSession
  } = createSessionActions({
    getSelectedProject: () => selectedProject,
    getSelectedProjectView: () => selectedProjectView ?? null,
    getSelectedSessionId: () => selectedSessionId ?? '',
    enqueueSessionMutation,
    activeSessionSwitchTokenRef,
    openProject
  });
  // Engine-environment orchestration (src/actions/environmentActions.ts) — diagnose
  // + run import/open actions against the selected project's engine.
  const { diagnoseSelectedProjectEnvironment, runSelectedProjectEnvironmentAction } = createEnvironmentActions({
    getSelectedProject: () => selectedProjectView ?? null,
    language: uiPreferences.language
  });
  const {
    mcpPlugins,
    setMcpPlugins,
    unityServerInfo,
    unityTools,
    unityResources,
    unityPrompts,
    unityResourceTemplates,
    mcpToolSnapshots,
    mcpRawAudits,
    pluginError,
    mcpConnectionStatuses,
    projectBindings,
    isRefreshingPlugin,
    setSelectedMcpPluginId,
    editingPlugin,
    setEditingPlugin,
    showPluginModal,
    setShowPluginModal,
    mcpModalProjectId,
    setMcpModalProjectId,
    activeProjectMcpPlugins,
    selectedMcpPlugin,
    projectMcpSelectedPlugin,
    globalMcpPlugins,
    selectedGlobalMcpPlugin,
    projectMcpConnectionStatus,
    globalMcpConnectionStatus,
    handleToggleProjectMcpPlugin,
    handleRefreshPluginMeta,
    handleReconnectMcpPlugin,
    handleStopMcpPlugin,
    handleSendRawMcpRequest,
    handleCreatePlugin,
    handleUpdatePlugin,
    handleToggleMcpPluginEnabled,
    handleDeletePlugin
  } = useMcpManager({
    selectedProject,
    selectedProjectView,
    setProjects,
    retryRefreshProjectRuntimeState,
    language: uiPreferences.language
  });
  const selectedAssetLibraryView = selectedProjectView
    ? (assetLibraryViewByProject[selectedProjectView.id] ?? 'all')
    : 'all';
  const selectedProjectRuntimePath = selectedProjectView?.engine?.projectPath ?? '';
  const selectedProjectUseFastRuntimeRefresh = shouldUseFastRuntimeRefresh(selectedProjectView);
  const { activeStreamSessions, activePromptStream, selectedProjectStream, agentRuntimeStatuses } =
    useAgentRuntimeActivity({
      enabled: appMode === 'workspace',
      projectId: selectedProjectView?.id,
      sessionId: selectedSessionId || undefined
    });
  const activePromptStreamRef = useRef<StreamSessionState | null>(null);

  useEffect(() => {
    activePromptStreamRef.current = activePromptStream;
  }, [activePromptStream]);

  // File-tree mirror (src/hooks/useProjectFiles.ts) — owns selectedProjectIdRef +
  // refreshProjectFiles, consumed below by prompt-stream + file-inspector hooks.
  const { refreshProjectFiles, selectedProjectIdRef } = useProjectFiles({
    appMode,
    selectedProjectId,
    enginePath: selectedProjectView?.engine?.projectPath
  });

  // Prompt-stream orchestration (src/actions/promptStreamActions.ts) — submit a
  // composer message into a new stream, or resume a persisted agent run. Needs
  // the two App-owned refs (stale-closure guard + the mutation-queue tail it
  // awaits directly), so it is created here after both refs exist.
  const { handleSubmitComposer, handleResumeAgentRun } = createPromptStreamActions({
    getSelectedProjectView: () => selectedProjectView ?? null,
    getSelectedSessionId: () => selectedSessionId ?? '',
    language: uiPreferences.language,
    selectedProjectIdRef,
    sessionMutationQueueRef
  });

  useEffect(() => {
    if (!selectedProjectView || !activePromptStream || activePromptStream.phase !== 'completed') {
      return;
    }

    if (activePromptStream.projectId !== selectedProjectView.id) {
      return;
    }

    const targetSession =
      selectedProjectView.sessions.find((session) => session.id === activePromptStream.sessionId) ??
      selectedProjectView.sessions[0];

    if (!targetSession) {
      return;
    }

    const streamStartedAt = new Date(activePromptStream.startedAt).getTime();
    const hasCommittedAssistantMessage = targetSession.chat.some(
      (message) => message.role === 'assistant' && new Date(message.createdAt).getTime() >= streamStartedAt
    );

    if (hasCommittedAssistantMessage) {
      removeStreamSession(activePromptStream.streamId);
    }
  }, [selectedProjectView, activePromptStream]);

  useEffect(() => {
    if (!window.funplay?.onPromptStreamEvent) {
      return;
    }

    return window.funplay.onPromptStreamEvent((event: PromptStreamEvent) => {
      applyPromptStreamEventToManager(event, {
        streaming: localize(uiPreferences.language, '正在实时生成回复…', 'Streaming response…'),
        reasoning: localize(uiPreferences.language, '正在整理推理过程…', 'Reasoning…'),
        toolRunning: () => localize(uiPreferences.language, '正在思考中...', 'Thinking...'),
        toolCompleted: localize(uiPreferences.language, '工具调用完成。', 'Tool call completed.'),
        toolFailed: localize(uiPreferences.language, '工具调用失败。', 'Tool call failed.'),
        waitingPermission: localize(uiPreferences.language, '等待权限确认…', 'Waiting for permission…'),
        waitingUserInput: localize(uiPreferences.language, '等待用户回答…', 'Waiting for user input…'),
        permissionAllowed: localize(
          uiPreferences.language,
          '已允许本轮写入操作。',
          'Write access allowed for this turn.'
        ),
        permissionAllowedSession: localize(
          uiPreferences.language,
          '已允许当前会话写入操作。',
          'Write access allowed for this session.'
        ),
        permissionDenied: localize(
          uiPreferences.language,
          '已拒绝本轮写入操作。',
          'Write access denied for this turn.'
        ),
        userInputSubmitted: localize(
          uiPreferences.language,
          '已提交回答，Agent 正在继续。',
          'Answer submitted. Agent is continuing.'
        ),
        completed: localize(uiPreferences.language, '已生成完成，正在写入会话…', 'Completed. Writing into the session…')
      });

      if (event.type === 'completed') {
        setProjects((current) => current.map((project) => (project.id === event.project.id ? event.project : project)));
        setSessionComposerErrors((current) => ({
          ...current,
          [event.sessionId]: ''
        }));
        dispatchRefreshFileTree({ projectId: event.project.id, reason: 'prompt-completed' });
        removeStreamSession(event.streamId);
        return;
      }

      if (event.type === 'cancelled') {
        const current =
          listStreamSessions().find((stream) => stream.streamId === event.streamId) ?? activePromptStreamRef.current;
        if (event.project) {
          // Interrupted, but the partial turn (user message + text streamed so
          // far) was persisted on the main side. Commit it like a completed turn
          // so the session row survives, and do NOT restore the draft — the user
          // message now lives in the session, restoring would duplicate it.
          const interruptedProject = event.project;
          setProjects((projectsValue) =>
            projectsValue.map((project) => (project.id === interruptedProject.id ? interruptedProject : project))
          );
        } else if (current?.streamId === event.streamId) {
          setSessionDrafts((value) => ({
            ...value,
            [current.sessionId]: value[current.sessionId] || current.prompt
          }));
        }
        if (current?.sessionId) {
          setSessionComposerErrors((value) => ({
            ...value,
            [current.sessionId]: localize(
              uiPreferences.language,
              '已取消本轮生成。',
              'The current response was cancelled.'
            )
          }));
        }
        return;
      }

      if (event.type === 'error') {
        const current =
          listStreamSessions().find((stream) => stream.streamId === event.streamId) ?? activePromptStreamRef.current;
        if (current?.streamId === event.streamId) {
          setSessionDrafts((value) => ({
            ...value,
            [current.sessionId]: value[current.sessionId] || current.prompt
          }));
          setSessionComposerErrors((value) => ({
            ...value,
            [current.sessionId]: event.error
          }));
        }
      }
    });
  }, [uiPreferences.language]);

  // Workspace-with-no-selection → fall back to the first project (store-only hook).
  useAppModeProjectSync();

  const { assetGenerationProviders, handleGenerateAsset, handleImportGeneratedAsset, handleCancelAssetGenerationJob } =
    useAssetGenerationCenter({
      appMode,
      mcpPlugins,
      assetGenerationProviderConfigs,
      selectedProjectView,
      language: uiPreferences.language,
      setProjects,
      refreshProjectFiles
    });

  const selectedActiveSession =
    selectedProjectView?.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedSessionRuntime = selectedActiveSession?.runtimeOverrides;
  const selectedProjectPermissionMode =
    selectedProjectView?.agentPolicy?.permissionMode ?? agentSettings.permissionMode;
  const selectedSessionPermissionMode = selectedSessionRuntime?.permissionMode ?? selectedProjectPermissionMode;
  const selectedSessionEffort = selectedSessionRuntime?.effort ?? 'auto';
  const selectedDefaultProvider =
    providers.find((provider) => provider.id === aiSettings.defaultProviderId && provider.enabled) ??
    providers.find((provider) => provider.enabled) ??
    null;
  const selectedProvider =
    (selectedSessionRuntime?.providerId
      ? providers.find((provider) => provider.id === selectedSessionRuntime.providerId && provider.enabled)
      : undefined) ?? selectedDefaultProvider;
  const { handlePickPromptAttachments, handleImportPromptAttachmentFiles, removePromptAttachment } =
    usePromptAttachmentImport({
      projectId: selectedProjectView?.id,
      sessionId: selectedSessionId,
      sessionAttachments,
      setSessionAttachments,
      setSessionComposerErrors,
      language: uiPreferences.language
    });
  const {
    enabledProviders,
    selectedProjectSessionStates,
    selectedSessionRewindSnapshotIds,
    selectedSessionLatestCheckpointId,
    projectSwitcherItems,
    virtualProjectFiles
  } = useSessionPanelDerivations({
    selectedProjectView,
    selectedSessionId,
    providers,
    activeStreamSessions,
    agentRuntimeStatuses,
    language: uiPreferences.language,
    developerMode: uiPreferences.developerMode
  });

  const {
    notificationTasks,
    isLoadingNotificationTasks,
    notificationTaskError,
    refreshNotificationTasks,
    handleCancelNotificationTask
  } = useNotificationTasks(uiPreferences.language);

  const {
    memoryFiles,
    selectedMemoryPath,
    selectedMemoryFile,
    memoryDraft,
    setMemoryDraft,
    isLoadingMemory,
    isSavingMemory,
    memoryError,
    loadProjectMemoryFile,
    refreshProjectMemoryFiles,
    handleSaveMemoryFile,
    handleClearProjectMemory
  } = useProjectMemory(selectedProjectView?.id, uiPreferences.language);

  const {
    selectedFileId,
    setSelectedFileId,
    selectedOverlayFile,
    setSelectedOverlayFile,
    fileInspectorMode,
    setFileInspectorMode,
    fileInspectorDraft,
    setFileInspectorDraft,
    isSavingProjectFile,
    fileInspectorSaveError,
    setFileInspectorSaveError,
    fileInspectorSavedAt,
    handleOpenProjectFile,
    handleCloseFileInspector,
    handleSaveSelectedProjectFile,
    handleOpenVirtualFile
  } = useFileInspector(
    selectedProject,
    refreshProjectFiles,
    virtualProjectFiles,
    setRightInspectorCollapsed,
    uiPreferences.language
  );

  // Engine runtime-state polling (src/hooks/useRuntimeStatePolling.ts) — placed after
  // useFileInspector since it reads selectedOverlayFile to gate the inspector collapse.
  useRuntimeStatePolling({
    appMode,
    selectedProjectId,
    runtimePath: selectedProjectRuntimePath,
    useFastRefresh: selectedProjectUseFastRuntimeRefresh,
    selectedOverlayFile,
    setRightInspectorCollapsed
  });

  // Project navigation + lifecycle orchestration (src/actions/projectNavActions.ts).
  // Built here, after the file-inspector / mcp / layout hooks that supply its
  // non-store injects. openProject + handleCreateProject are consumed earlier by
  // useOnboarding, so App keeps hoisted wrappers (below) that delegate here.
  const projectNavActions = createProjectNavActions({
    setSelectedFileId,
    setSelectedOverlayFile,
    setRightInspectorCollapsed,
    getMcpPlugins: () => mcpPlugins,
    setMcpPlugins,
    setSelectedMcpPluginId
  });

  const { chatOpenablePaths, handleOpenChatFilePath } = useChatFileOpeners({
    projectFiles,
    virtualProjectFiles,
    handleOpenProjectFile,
    handleOpenVirtualFile
  });

  const {
    restoreCheckpointPreview,
    setRestoreCheckpointPreview,
    sessionChangePanelPreview,
    sessionChangePanelLoading,
    sessionChangePanelOpen,
    setSessionChangePanelOpen,
    restoredCheckpointState,
    isRestoringCheckpoint,
    handleRequestRestoreSessionCheckpoint,
    handleRestoreSelectedSessionCheckpoint,
    handleConfirmRestoreSessionCheckpoint
  } = useCheckpointManager({
    selectedProjectView,
    selectedSessionId,
    selectedSessionLatestCheckpointId,
    setProjects,
    setLocalActiveSessionByProject,
    setSessionComposerErrors,
    setSection,
    enqueueSessionMutation
  });
  const selectedRestoredCheckpoint =
    restoredCheckpointState &&
    selectedProjectView &&
    restoredCheckpointState.projectId === selectedProjectView.id &&
    restoredCheckpointState.sessionId === selectedSessionId
      ? restoredCheckpointState
      : null;

  const {
    skillDraft,
    setSkillDraft,
    editingSkillId,
    skillCatalog,
    isLoadingSkillCatalog,
    skillCatalogError,
    loadSkillCatalog,
    handleSaveProjectSkill,
    handleInstallCatalogSkill,
    handleToggleProjectSkill,
    handleDeleteProjectSkill,
    handleEditProjectSkill,
    handleCancelProjectSkillEdit
  } = useProjectSkills({
    selectedProjectView,
    setProjects,
    language: uiPreferences.language,
    appMode,
    section,
    projectSettingsTab
  });

  const sidebarNavItems = [
    { id: 'settings', label: localize(uiPreferences.language, '项目设置', 'Project Settings'), icon: '⚙' },
    { id: 'assets', label: localize(uiPreferences.language, '素材库', 'Assets'), icon: '▧' }
  ];

  useEffect(() => {
    const activeSessionIds = new Set(
      activeStreamSessions
        .filter((stream) => !['completed', 'cancelled', 'error'].includes(stream.phase))
        .map((stream) => stream.sessionId)
    );
    const projectBySessionId = new Map<string, string>();
    projects.forEach((project) => {
      ensureProjectSessions(project).sessions.forEach((session) => {
        projectBySessionId.set(session.id, project.id);
      });
    });

    for (const [sessionId, queue] of Object.entries(queuedPromptsBySession)) {
      if (queue.length === 0 || activeSessionIds.has(sessionId) || dequeueSessionIdsRef.current.has(sessionId)) {
        continue;
      }

      const projectId = projectBySessionId.get(sessionId);
      const nextPrompt = queue[0];
      if (!projectId || !nextPrompt) {
        continue;
      }

      dequeueSessionIdsRef.current.add(sessionId);
      setQueuedPromptsBySession((current) => {
        const nextQueue = (current[sessionId] ?? []).slice(1);
        const next = { ...current };
        if (nextQueue.length > 0) {
          next[sessionId] = nextQueue;
        } else {
          delete next[sessionId];
        }
        return next;
      });
      void handleSubmitComposer(nextPrompt.content, sessionId, projectId).finally(() => {
        dequeueSessionIdsRef.current.delete(sessionId);
      });
    }
  }, [activeStreamSessions, projects, queuedPromptsBySession]);

  // Hoisted wrappers so useOnboarding (above) can take stable references before
  // projectNavActions is constructed; the bodies live in projectNavActions.ts.
  function openProject(projectId: string): void {
    projectNavActions.openProject(projectId);
  }

  function handleCreateProject(input: CreateProjectInput): Promise<void> {
    return projectNavActions.handleCreateProject(input);
  }

  function handleDeleteProject(): Promise<void> {
    return projectNavActions.handleDeleteProject();
  }

  if (isLoading || bootstrapError || appMode !== 'workspace') {
    return (
      <BootstrapScreens
        isLoading={isLoading}
        bootstrapError={bootstrapError}
        appMode={appMode}
        setAppMode={setAppMode}
        projects={projects}
        language={uiPreferences.language}
        mcpPlugins={mcpPlugins}
        onboarding={onboarding}
        openProject={openProject}
        appNotifications={appNotifications}
        dismissNotification={dismissNotification}
      />
    );
  }

  return (
    <UiLanguageProvider language={uiPreferences.language}>
      <AppShell
        projects={projectSwitcherItems.map((project) => ({
          id: project.id,
          name: project.name,
          enginePlatform: project.enginePlatform,
          runningCount: project.runningCount,
          pendingApprovalCount: project.pendingApprovalCount,
          failedCount: project.failedCount
        }))}
        selectedProjectId={selectedProjectId}
        onSelectProject={openProject}
        onDeleteProject={(projectId) => {
          const project = projects.find((item) => item.id === projectId);
          if (project) {
            openDeleteModal(project);
          }
        }}
        onAddProject={() => {
          onboarding.startOnboarding();
          setAppMode('onboarding');
        }}
        onOpenAppSettings={() => openAppSettings()}
        onOpenAgentWorkspace={() => setSection('agent')}
        onOpenProjectSettings={() => setSection('settings')}
        onOpenAssets={() => setSection('assets')}
        appUpdateStatus={appUpdateStatus}
        onOpenAppUpdate={() => openAppSettings('about')}
        showChangePanelToggle={Boolean(selectedProjectView)}
        changePanelOpen={section === 'agent' && sessionChangePanelOpen}
        onToggleChangePanel={() => {
          if (section !== 'agent') {
            setSection('agent');
            setSessionChangePanelOpen(true);
            return;
          }
          setSessionChangePanelOpen((isOpen) => !isOpen);
        }}
        leftCollapsed={leftSidebarCollapsed}
        rightCollapsed={rightInspectorCollapsed}
        onToggleLeftSidebar={() => setLeftSidebarCollapsed((current) => !current)}
        onToggleRightInspector={() => setRightInspectorCollapsed((current) => !current)}
        leftWidth={leftSidebarWidth}
        rightWidth={rightInspectorWidth}
        onLeftWidthChange={setLeftSidebarWidth}
        onRightWidthChange={setRightInspectorWidth}
        renderLeftPanel={({ width }) => (
          <SidebarPanel
            files={projectFiles}
            selectedFileId={selectedFileId}
            sessions={selectedProjectView?.sessions ?? []}
            activeSessionId={selectedProjectView?.activeSessionId}
            streamingSessionId={selectedProjectStream?.sessionId}
            sessionStates={selectedProjectSessionStates}
            navItems={sidebarNavItems}
            activeNavId={section}
            width={width}
            onOpenFile={(fileId) => {
              void handleOpenProjectFile(fileId);
            }}
            onCreateSession={() => void handleCreateSession()}
            onSelectSession={(sessionId) => void handleSelectSession(sessionId)}
            onRenameSession={(sessionId, title) => void handleRenameSession(sessionId, title)}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
            onSelectNav={(navId) => setSection(navId as WorkspaceSection)}
          />
        )}
        renderRightPanel={({ width }) => (
          <FileInspectorPanel
            file={selectedOverlayFile}
            project={selectedProjectView}
            draft={fileInspectorDraft}
            mode={fileInspectorMode}
            width={width}
            isDirty={Boolean(selectedOverlayFile && fileInspectorDraft !== selectedOverlayFile.content)}
            isSaving={isSavingProjectFile}
            saveError={fileInspectorSaveError}
            savedAt={fileInspectorSavedAt}
            onDraftChange={setFileInspectorDraft}
            onModeChange={setFileInspectorMode}
            onClose={handleCloseFileInspector}
            onSave={() => void handleSaveSelectedProjectFile()}
            onReset={() => {
              if (!selectedOverlayFile) {
                return;
              }
              setFileInspectorDraft(selectedOverlayFile.content);
              setFileInspectorSaveError('');
            }}
          />
        )}
      >
        <div
          className={`prototype-content desktop-content ${section === 'agent' ? 'agent-mode' : 'page-mode'} ${section === 'settings' ? 'settings-mode' : ''} ${section === 'assets' ? 'assets-mode' : ''}`}
          role="main"
          aria-label={localize(
            uiPreferences.language,
            section === 'agent' ? 'Agent 工作区' : section === 'settings' ? '项目设置' : '素材库',
            section === 'agent' ? 'Agent workspace' : section === 'settings' ? 'Project settings' : 'Assets'
          )}
          data-workspace-section={section}
        >
          {section === 'agent' ? (
            <AgentWorkbench
              project={selectedProjectView}
              sidePanel={
                selectedProjectView && sessionChangePanelOpen ? (
                  <SessionChangesPanel
                    preview={sessionChangePanelPreview}
                    isLoading={sessionChangePanelLoading}
                    onRestore={(snapshotId) =>
                      void handleRequestRestoreSessionCheckpoint(selectedSessionId, snapshotId)
                    }
                    onClose={() => setSessionChangePanelOpen(false)}
                  />
                ) : undefined
              }
            >
              <AgentChatView
                project={selectedProjectView}
                provider={selectedProvider}
                providers={enabledProviders}
                permissionMode={selectedSessionPermissionMode}
                openablePaths={chatOpenablePaths}
                defaultProviderId={selectedDefaultProvider?.id}
                sessionProviderId={selectedSessionRuntime?.providerId}
                sessionModel={selectedSessionRuntime?.model}
                sessionEffort={selectedSessionEffort}
                rewindSnapshotIds={selectedSessionRewindSnapshotIds}
                highlightMessageId={selectedRestoredCheckpoint?.triggerUserMessageId}
                highlightToken={selectedRestoredCheckpoint?.restoredAt}
                restoreNotice={
                  selectedRestoredCheckpoint
                    ? {
                        checkpointNote: selectedRestoredCheckpoint.checkpointNote,
                        rolledBackCount: selectedRestoredCheckpoint.rolledBackCount
                      }
                    : null
                }
                activePromptStream={selectedProjectStream}
                developerMode={uiPreferences.developerMode}
                isSending={Boolean(
                  selectedProjectStream && !['completed', 'cancelled', 'error'].includes(selectedProjectStream.phase)
                )}
                onPickAttachments={() => void handlePickPromptAttachments()}
                onImportAttachments={(files, source) => void handleImportPromptAttachmentFiles(files, source)}
                onRemoveAttachment={(attachmentId) => {
                  if (selectedSessionId) {
                    removePromptAttachment(selectedSessionId, attachmentId);
                  }
                }}
                onSubmit={(content) => void handleSubmitComposer(content, selectedSessionId)}
                onCancelStream={() => {
                  if (!selectedProjectStream) {
                    return;
                  }
                  void window.funplay.cancelPromptStream(selectedProjectStream.streamId);
                }}
                onRespondPermission={(decision) => {
                  if (!selectedProjectStream?.pendingPermission) {
                    return;
                  }
                  void window.funplay
                    .respondPromptPermission(selectedProjectStream.pendingPermission.requestId, decision)
                    .catch((error) => {
                      if (!selectedSessionId) {
                        return;
                      }
                      setSessionComposerErrors((current) => ({
                        ...current,
                        [selectedSessionId]:
                          error instanceof Error
                            ? error.message
                            : localize(
                                uiPreferences.language,
                                '权限响应失败，请重试。',
                                'Failed to submit the permission decision. Please try again.'
                              )
                      }));
                    });
                }}
                onRespondUserInput={(response) => {
                  if (!selectedProjectStream?.pendingUserInput) {
                    return;
                  }
                  void window.funplay
                    .respondPromptUserInput(selectedProjectStream.pendingUserInput.requestId, response)
                    .catch((error) => {
                      if (!selectedSessionId) {
                        return;
                      }
                      setSessionComposerErrors((current) => ({
                        ...current,
                        [selectedSessionId]:
                          error instanceof Error
                            ? error.message
                            : localize(
                                uiPreferences.language,
                                '回答提交失败，请重试。',
                                'Failed to submit the answer. Please try again.'
                              )
                      }));
                    });
                }}
                onUpdateSessionRuntime={(runtime) => {
                  void updateSelectedSessionRuntime(
                    runtime,
                    localize(uiPreferences.language, 'Provider 设置更新失败。', 'Failed to update provider settings.')
                  );
                }}
                onUpdatePermissionMode={(mode) => {
                  void updateSelectedSessionRuntime(
                    { permissionMode: mode },
                    localize(uiPreferences.language, '权限模式更新失败。', 'Failed to update permission mode.')
                  );
                }}
                onOpenAppSettings={() => openAppSettings('provider')}
                onOpenProjectAgentSettings={() => {
                  setProjectSettingsTab('agent');
                  setSection('settings');
                }}
                onDiagnoseEnvironment={diagnoseSelectedProjectEnvironment}
                onRunEnvironmentAction={runSelectedProjectEnvironmentAction}
                onRefreshProjectRuntimeState={() =>
                  selectedProjectView ? refreshProjectRuntimeStateById(selectedProjectView.id) : Promise.resolve(null)
                }
                onOpenFilePath={handleOpenChatFilePath}
                onRestoreCheckpoint={handleRestoreSelectedSessionCheckpoint}
              />
            </AgentWorkbench>
          ) : null}

          {section === 'settings' ? (
            <ProjectSettingsPage
              project={selectedProjectView}
              plugins={mcpPlugins}
              selectedPlugin={projectMcpSelectedPlugin}
              serverInfo={unityServerInfo}
              tools={unityTools}
              toolSnapshots={mcpToolSnapshots}
              rawAudits={mcpRawAudits}
              resources={unityResources}
              prompts={unityPrompts}
              resourceTemplates={unityResourceTemplates}
              connectionStatus={projectMcpConnectionStatus}
              connectionStatuses={mcpConnectionStatuses}
              pluginError={pluginError}
              isRefreshing={isRefreshingPlugin}
              projectBindings={projectBindings}
              skillDraft={skillDraft}
              editingSkillId={editingSkillId}
              skillCatalog={skillCatalog}
              isLoadingSkillCatalog={isLoadingSkillCatalog}
              skillCatalogError={skillCatalogError}
              providers={enabledProviders}
              activeProvider={selectedProvider}
              defaultProviderId={selectedDefaultProvider?.id}
              activeSession={selectedActiveSession}
              sessionProviderId={selectedSessionRuntime?.providerId}
              sessionModel={selectedSessionRuntime?.model}
              sessionEffort={selectedSessionEffort}
              runtimeStatuses={agentRuntimeStatuses}
              onSelectProjectMcpPlugin={setSelectedMcpPluginId}
              onToggleProjectMcpPlugin={(pluginId, enabled) => void handleToggleProjectMcpPlugin(pluginId, enabled)}
              onAddProjectMcpPlugin={() => {
                setEditingPlugin(null);
                setMcpModalProjectId(selectedProjectView?.id);
                setShowPluginModal(true);
              }}
              onEditProjectMcpPlugin={(plugin) => {
                setEditingPlugin(plugin);
                setMcpModalProjectId(plugin.projectId);
                setShowPluginModal(true);
              }}
              onDeleteProjectMcpPlugin={(pluginId) => void handleDeletePlugin(pluginId)}
              onSendRawMcpRequest={handleSendRawMcpRequest}
              onReconnectMcpPlugin={() => void handleReconnectMcpPlugin(projectMcpSelectedPlugin)}
              onStopMcpPlugin={() => void handleStopMcpPlugin(projectMcpSelectedPlugin)}
              onRefreshSkillCatalog={() => loadSkillCatalog(true)}
              onInstallCatalogSkill={handleInstallCatalogSkill}
              onChangeSkillDraft={setSkillDraft}
              onSaveProjectSkill={handleSaveProjectSkill}
              onEditProjectSkill={handleEditProjectSkill}
              onCancelProjectSkillEdit={handleCancelProjectSkillEdit}
              onToggleProjectSkill={handleToggleProjectSkill}
              onDeleteProjectSkill={handleDeleteProjectSkill}
              onUpdateProjectPermissionMode={async (permissionMode) => {
                if (!selectedProjectView) {
                  return;
                }
                const updated = await window.funplay.updateProjectAgentPolicy(selectedProjectView.id, {
                  permissionMode
                });
                setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
              }}
              onUpdateSessionRuntime={(runtime) =>
                updateSelectedSessionRuntime(
                  runtime,
                  localize(
                    uiPreferences.language,
                    '会话运行设置更新失败。',
                    'Failed to update session runtime settings.'
                  )
                )
              }
              onResumeAgentRun={(runId) => void handleResumeAgentRun(runId)}
              onRefreshPluginMeta={() =>
                void handleRefreshPluginMeta(selectedMcpPlugin ?? activeProjectMcpPlugins[0] ?? null)
              }
              onOpenMcpRegistry={() => openAppSettings('mcp')}
            />
          ) : null}

          {section === 'assets' ? (
            <AssetsPage
              project={selectedProjectView}
              projectFiles={projectFiles}
              assetGenerationProviders={assetGenerationProviders}
              activeViewId={selectedAssetLibraryView}
              onActiveViewChange={(viewId) => {
                if (!selectedProjectView) {
                  return;
                }
                setAssetLibraryViewByProject((current) => ({
                  ...current,
                  [selectedProjectView.id]: viewId
                }));
              }}
              onOpenAsset={handleOpenVirtualFile}
              onOpenProjectFile={(path) => void handleOpenProjectFile(path)}
              onGenerateAsset={handleGenerateAsset}
              onImportGeneratedAsset={handleImportGeneratedAsset}
              onCancelAssetGenerationJob={handleCancelAssetGenerationJob}
            />
          ) : null}
        </div>
      </AppShell>

      <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />

      {showAppSettingsModal ? (
        <AppSettingsModal
          initialTab={appSettingsInitialTab}
          theme={uiPreferences.theme}
          language={uiPreferences.language}
          developerMode={uiPreferences.developerMode}
          aiSettings={aiSettings}
          providers={providers}
          assetGenerationProviderConfigs={assetGenerationProviderConfigs}
          providerTests={providerTests}
          mcpPlugins={globalMcpPlugins}
          selectedMcpPlugin={selectedGlobalMcpPlugin}
          serverInfo={unityServerInfo}
          tools={unityTools}
          toolSnapshots={mcpToolSnapshots}
          rawAudits={mcpRawAudits}
          resources={unityResources}
          prompts={unityPrompts}
          resourceTemplates={unityResourceTemplates}
          connectionStatus={globalMcpConnectionStatus}
          connectionStatuses={mcpConnectionStatuses}
          pluginError={pluginError}
          isRefreshingPlugin={isRefreshingPlugin}
          memoryFiles={memoryFiles}
          selectedMemoryPath={selectedMemoryPath}
          selectedMemoryFile={selectedMemoryFile}
          memoryDraft={memoryDraft}
          isLoadingMemory={isLoadingMemory}
          isSavingMemory={isSavingMemory}
          memoryError={memoryError}
          notificationTasks={notificationTasks}
          isLoadingNotificationTasks={isLoadingNotificationTasks}
          notificationTaskError={notificationTaskError}
          appUpdateStatus={appUpdateStatus}
          selectedProjectId={selectedProjectView?.id}
          onChangeTheme={(theme) => setUiPreferences((current) => ({ ...current, theme }))}
          onChangeLanguage={(language) => setUiPreferences((current) => ({ ...current, language }))}
          onChangeDeveloperMode={(developerMode) => setUiPreferences((current) => ({ ...current, developerMode }))}
          onUpdateWebSearchSettings={async (settings) => {
            const next = await window.funplay.updateWebSearchSettings(settings);
            setAiSettings(next);
          }}
          onCreateProvider={handleCreateProvider}
          onUpdateProvider={handleUpdateProvider}
          onListProviderModels={(input) => window.funplay.listProviderModels(input)}
          onDeleteProvider={(providerId) => void handleDeleteProvider(providerId)}
          onTestProvider={(providerId) => void handleTestProvider(providerId)}
          onSetDefaultProvider={(providerId) => void handleSetDefaultProvider(providerId)}
          onCreateAssetGenerationProvider={handleCreateAssetGenerationProvider}
          onUpdateAssetGenerationProvider={handleUpdateAssetGenerationProvider}
          onDeleteAssetGenerationProvider={(providerId) => void handleDeleteAssetGenerationProvider(providerId)}
          onSelectMcpPlugin={setSelectedMcpPluginId}
          onRefreshMcpPluginMeta={() => void handleRefreshPluginMeta(selectedGlobalMcpPlugin)}
          onToggleMcpPlugin={(plugin, enabled) => void handleToggleMcpPluginEnabled(plugin, enabled)}
          onAddMcpPlugin={() => {
            setEditingPlugin(null);
            setMcpModalProjectId(undefined);
            setShowPluginModal(true);
          }}
          onEditMcpPlugin={(plugin) => {
            setEditingPlugin(plugin);
            setMcpModalProjectId(plugin.projectId);
            setShowPluginModal(true);
          }}
          onDeleteMcpPlugin={(pluginId) => void handleDeletePlugin(pluginId)}
          onSendRawMcpRequest={handleSendRawMcpRequest}
          onReconnectMcpPlugin={() => void handleReconnectMcpPlugin(selectedGlobalMcpPlugin)}
          onStopMcpPlugin={() => void handleStopMcpPlugin(selectedGlobalMcpPlugin)}
          onRefreshMemoryFiles={refreshProjectMemoryFiles}
          onSelectMemoryFile={loadProjectMemoryFile}
          onChangeMemoryDraft={setMemoryDraft}
          onSaveMemoryFile={handleSaveMemoryFile}
          onClearMemory={handleClearProjectMemory}
          onRefreshNotificationTasks={refreshNotificationTasks}
          onCancelNotificationTask={handleCancelNotificationTask}
          onRefreshAppUpdateStatus={refreshAppUpdateStatus}
          onCheckForUpdates={handleCheckForUpdates}
          onDownloadUpdate={handleDownloadUpdate}
          onInstallUpdate={handleInstallUpdate}
          onClose={() => setShowAppSettingsModal(false)}
        />
      ) : null}

      {showPluginModal ? (
        <McpPluginModal
          plugin={editingPlugin}
          projectId={editingPlugin?.projectId ?? mcpModalProjectId}
          onClose={() => {
            setShowPluginModal(false);
            setEditingPlugin(null);
            setMcpModalProjectId(undefined);
          }}
          onCreate={handleCreatePlugin}
          onUpdate={handleUpdatePlugin}
        />
      ) : null}

      {showDeleteProjectModal && projectPendingDelete ? (
        <DeleteProjectModal
          project={projectPendingDelete}
          deleteSourceFiles={deleteProjectSourceFiles}
          isDeleting={isDeletingProject}
          onChangeDeleteSourceFiles={setDeleteProjectSourceFiles}
          onClose={closeDeleteModal}
          onConfirm={() => void handleDeleteProject()}
        />
      ) : null}

      {restoreCheckpointPreview ? (
        <RestoreCheckpointModal
          preview={restoreCheckpointPreview}
          isRestoring={isRestoringCheckpoint}
          onClose={() => setRestoreCheckpointPreview(null)}
          onConfirm={() => void handleConfirmRestoreSessionCheckpoint()}
        />
      ) : null}
    </UiLanguageProvider>
  );
}

export default App;
