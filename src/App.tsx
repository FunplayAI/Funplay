import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useUiPreferences } from './hooks/useUiPreferences';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout';
import { useSelectedProjectView } from './hooks/useSelectedProjectView';
import { useAppNotifications } from './hooks/useAppNotifications';
import { useAppUpdateStatus } from './hooks/useAppUpdateStatus';
import { useProviderManager } from './hooks/useProviderManager';
import { useAssetGenerationProviders } from './hooks/useAssetGenerationProviders';
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
import {
  type AgentPermissionMode,
  type AssetGenerationProviderConfig,
  type BootstrapPayload,
  type CreateProjectInput,
  type EngineProjectDimension,
  type EnvironmentActionKind,
  type EnvironmentActionResult,
  type EnvironmentDiagnostics,
  type PromptAttachment,
  type PromptStreamEvent,
  type ProjectFileEntry,
  type Project,
  type ProjectSessionEffort,
  type ProjectSessionRuntimeId,
  type UnitySettings
} from '../shared/types';
import { AppShell } from './components/layout/AppShell';
import { AgentWorkbench } from './components/layout/AgentWorkbench';
import { UiLanguageProvider, getDocumentLanguage, localize, useUiLanguage } from './i18n';
import { dispatchRefreshFileTree, subscribeRefreshFileTree } from './lib/file-tree-events';
import {
  applyPromptStreamEventToManager,
  getStreamSessionForSession,
  listStreamSessions,
  removeStreamSession,
  seedStreamSession,
  type StreamSessionState
} from './lib/stream-session-manager';
import { AgentChatView } from './components/chat/AgentChatView';
import type { QueuedPromptItem } from './components/chat/ChatComposer';
import { getVisibleRuntimeStatusMessage } from './components/chat/runtime-display';
import { FileInspectorPanel, SidebarPanel } from './components/layout/WorkspacePanels';
import { McpPluginModal } from './components/settings-modals';
import type { SessionCheckpointListItem, SessionListState } from './components/layout/SessionManagementPanel';
import type { AppSettingsTab, ProjectSettingsTab } from './lib/app-types';
import {
  buildProjectSwitcherItem,
  buildSessionListState,
  buildVirtualProjectFiles,
  createEmptyProjectSkillDraft,
  formatAbsoluteTime,
  formatQueuedPromptWithAttachments,
  mergeProjectRuntimeRefresh,
  mergeProjectSessionSelection,
  shouldUseFastRuntimeRefresh,
  wait
} from './lib/app-helpers';
import { WelcomeScreen } from './components/pages/WelcomeScreen';
import { OnboardingScreen } from './components/pages/OnboardingScreen';
import { McpManagementPage } from './components/pages/McpManagementPage';
import { SkillsPage } from './components/pages/SkillsPage';
import { ProjectSettingsPage } from './components/pages/ProjectSettingsPage';
import { McpRegistrySettingsPage } from './components/pages/McpRegistrySettingsPage';
import { WebSearchSettingsPage } from './components/pages/WebSearchSettingsPage';
import { AssetsPage, type AssetLibraryViewId } from './components/pages/AssetsPage';
import { AppSettingsModal } from './components/modals/AppSettingsModal';
import { DeleteProjectModal } from './components/modals/DeleteProjectModal';
import { SessionChangesPanel, RestoreCheckpointModal } from './components/modals/SessionChangesPanel';
import { NotificationToastStack } from './components/shared/NotificationToastStack';

type AppMode = 'welcome' | 'onboarding' | 'workspace';
type WorkspaceSection = 'agent' | 'settings' | 'assets';
type SessionRuntimeUpdate = {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  effort?: ProjectSessionEffort;
};

const emptySettings: UnitySettings = {
  baseUrl: 'http://127.0.0.1:8765/',
  profile: 'core',
  lastStatus: 'idle',
  lastCreatedProjectDirectory: '~/Downloads',
  lastAssignedMcpPort: 8765
};

function App(): JSX.Element {
  const [appMode, setAppMode] = useState<AppMode>('welcome');
  const [section, setSection] = useState<WorkspaceSection>('agent');
  const [projectSettingsTab, setProjectSettingsTab] = useState<ProjectSettingsTab>('engine');
  const [showAppSettingsModal, setShowAppSettingsModal] = useState(false);
  const [appSettingsInitialTab, setAppSettingsInitialTab] = useState<AppSettingsTab>('appearance');
  const [showDeleteProjectModal, setShowDeleteProjectModal] = useState(false);
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState('');
  const [isDeletingProject, setIsDeletingProject] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const {
    assetGenerationProviderConfigs,
    setAssetGenerationProviderConfigs,
    handleCreateAssetGenerationProvider,
    handleUpdateAssetGenerationProvider,
    handleDeleteAssetGenerationProvider
  } = useAssetGenerationProviders();
  const [settings, setSettings] = useState<UnitySettings>(emptySettings);
  const [settingsDraft, setSettingsDraft] = useState(emptySettings);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [sessionAttachments, setSessionAttachments] = useState<Record<string, PromptAttachment[]>>({});
  const [sessionComposerErrors, setSessionComposerErrors] = useState<Record<string, string>>({});
  const [queuedPromptsBySession, setQueuedPromptsBySession] = useState<Record<string, QueuedPromptItem[]>>({});
  const [localActiveSessionByProject, setLocalActiveSessionByProject] = useState<Record<string, string>>({});
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [deleteProjectSourceFiles, setDeleteProjectSourceFiles] = useState(false);
  const [assetLibraryViewByProject, setAssetLibraryViewByProject] = useState<Record<string, AssetLibraryViewId>>({});

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

  // Single source of truth for tearing down the per-session draft/attachment/
  // error/queue records when a session (or all of a project's sessions) is
  // deleted, so the four Record<string, …> maps never drift out of sync.
  function clearSessionScopedState(sessionIds: string[]): void {
    if (sessionIds.length === 0) {
      return;
    }
    const removeKeys = <T,>(record: Record<string, T>): Record<string, T> => {
      const next = { ...record };
      sessionIds.forEach((id) => delete next[id]);
      return next;
    };
    setSessionDrafts(removeKeys);
    setSessionAttachments(removeKeys);
    setSessionComposerErrors(removeKeys);
    setQueuedPromptsBySession(removeKeys);
  }

  const [onboardingProjectPath, setOnboardingProjectPath] = useState('~/Downloads');
  const [onboardingEnginePluginId, setOnboardingEnginePluginId] = useState('');

  const { uiPreferences, setUiPreferences, platformCards } = useUiPreferences();
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
    setProviderTests,
    refreshProviderStateFromMain,
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
  const selectedProjectIdRef = useRef(selectedProjectId);

  useEffect(() => {
    activePromptStreamRef.current = activePromptStream;
  }, [activePromptStream]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

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

  useEffect(() => {
    if (!window.funplay?.onProjectFileTreeChanged) {
      return;
    }

    return window.funplay.onProjectFileTreeChanged((event) => {
      dispatchRefreshFileTree({ projectId: event.projectId, reason: 'watcher' });
    });
  }, []);

  useEffect(() => {
    setSkillDraft(createEmptyProjectSkillDraft());
    setEditingSkillId('');
  }, [selectedProject]);

  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !selectedProjectRuntimePath) {
      return;
    }
    if (!selectedOverlayFile) {
      setRightInspectorCollapsed(true);
    }

    let cancelled = false;
    const refreshRuntimeState = async (): Promise<void> => {
      try {
        if (!cancelled) {
          await refreshProjectRuntimeStateById(selectedProjectId);
        }
      } catch {
        // noop
      }
    };

    void refreshRuntimeState();
    if (!selectedProjectUseFastRuntimeRefresh) {
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
  }, [appMode, selectedProjectId, selectedProjectRuntimePath, selectedProjectUseFastRuntimeRefresh]);

  const refreshProjectFiles = useCallback(async (projectId: string): Promise<void> => {
    if (!projectId) {
      setProjectFiles([]);
      return;
    }

    try {
      const files = await window.funplay.listProjectFiles(projectId);
      if (selectedProjectIdRef.current === projectId) {
        setProjectFiles(files);
      }
    } catch {
      if (selectedProjectIdRef.current === projectId) {
        setProjectFiles([]);
      }
    }
  }, []);

  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !selectedProjectView?.engine?.projectPath) {
      setProjectFiles([]);
      return;
    }

    void refreshProjectFiles(selectedProjectId);
  }, [appMode, selectedProjectId, selectedProjectView?.engine?.projectPath, refreshProjectFiles]);

  useEffect(() => {
    if (appMode !== 'workspace' || !selectedProjectId || !selectedProjectView?.engine?.projectPath) {
      return;
    }

    return subscribeRefreshFileTree((detail) => {
      if (detail.projectId && detail.projectId !== selectedProjectId) {
        return;
      }
      void refreshProjectFiles(selectedProjectId);
    });
  }, [appMode, selectedProjectId, selectedProjectView?.engine?.projectPath, refreshProjectFiles]);

  useEffect(() => {
    if (appMode !== 'workspace' || selectedProjectId || projects.length === 0) {
      return;
    }
    setSelectedProjectId(projects[0].id);
  }, [appMode, selectedProjectId, projects]);

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
  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers]);
  const selectedDefaultProvider =
    providers.find((provider) => provider.id === aiSettings.defaultProviderId && provider.enabled) ??
    providers.find((provider) => provider.enabled) ??
    null;
  const selectedProvider =
    (selectedSessionRuntime?.providerId
      ? providers.find((provider) => provider.id === selectedSessionRuntime.providerId && provider.enabled)
      : undefined) ?? selectedDefaultProvider;
  const selectedComposerValue = selectedSessionId ? (sessionDrafts[selectedSessionId] ?? '') : '';
  const selectedComposerAttachments = selectedSessionId ? (sessionAttachments[selectedSessionId] ?? []) : [];
  const selectedComposerError = selectedSessionId ? (sessionComposerErrors[selectedSessionId] ?? '') : '';
  const selectedQueuedPrompts = selectedSessionId ? (queuedPromptsBySession[selectedSessionId] ?? []) : [];
  const { handlePickPromptAttachments, handleImportPromptAttachmentFiles, removePromptAttachment } =
    usePromptAttachmentImport({
      projectId: selectedProjectView?.id,
      sessionId: selectedSessionId,
      sessionAttachments,
      setSessionAttachments,
      setSessionComposerErrors,
      language: uiPreferences.language
    });
  const selectedProjectSessionStates = useMemo<Record<string, SessionListState>>(() => {
    if (!selectedProjectView) {
      return {};
    }

    return Object.fromEntries(
      selectedProjectView.sessions.map((session) => [
        session.id,
        buildSessionListState({
          session,
          language: uiPreferences.language,
          isStreaming: Boolean(
            activeStreamSessions.some(
              (stream) =>
                stream.projectId === selectedProjectView.id &&
                stream.sessionId === session.id &&
                !['completed', 'cancelled', 'error'].includes(stream.phase)
            )
          ),
          statusMessage: getVisibleRuntimeStatusMessage(
            activeStreamSessions.find(
              (stream) => stream.projectId === selectedProjectView.id && stream.sessionId === session.id
            )?.statusMessage,
            uiPreferences.developerMode,
            uiPreferences.language
          ),
          queuedCount: queuedPromptsBySession[session.id]?.length ?? 0,
          composerError: sessionComposerErrors[session.id] ?? ''
        })
      ])
    );
  }, [
    activeStreamSessions,
    queuedPromptsBySession,
    selectedProjectView,
    sessionComposerErrors,
    uiPreferences.developerMode,
    uiPreferences.language
  ]);
  const selectedProjectSessionCheckpoints = useMemo<Record<string, SessionCheckpointListItem[]>>(() => {
    if (!selectedProjectView) {
      return {};
    }

    return selectedProjectView.snapshots
      .filter((snapshot) => snapshot.sessionCheckpoint)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .reduce<Record<string, SessionCheckpointListItem[]>>((accumulator, snapshot) => {
        const sessionId = snapshot.sessionCheckpoint?.sessionId;
        if (sessionId) {
          const next = accumulator[sessionId] ?? [];
          next.push({
            id: snapshot.id,
            note: snapshot.note,
            createdAt: snapshot.createdAt
          });
          accumulator[sessionId] = next;
        }
        return accumulator;
      }, {});
  }, [selectedProjectView]);
  const selectedSessionRewindSnapshotIds = useMemo<Record<string, string>>(() => {
    if (!selectedProjectView || !selectedSessionId) {
      return {};
    }

    return selectedProjectView.snapshots
      .filter(
        (snapshot) =>
          snapshot.sessionCheckpoint?.sessionId === selectedSessionId &&
          snapshot.sessionCheckpoint?.triggerUserMessageId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .reduce<Record<string, string>>((accumulator, snapshot) => {
        const messageId = snapshot.sessionCheckpoint?.triggerUserMessageId;
        if (messageId && !accumulator[messageId]) {
          accumulator[messageId] = snapshot.id;
        }
        return accumulator;
      }, {});
  }, [selectedProjectView, selectedSessionId]);

  function updateSelectedSessionRuntime(runtime: SessionRuntimeUpdate, fallbackErrorMessage: string): Promise<void> {
    if (!selectedProjectView || !selectedSessionId) {
      return Promise.resolve();
    }
    const projectId = selectedProjectView.id;
    const sessionId = selectedSessionId;
    return enqueueSessionMutation(() => window.funplay.updateProjectSessionRuntime(projectId, sessionId, runtime))
      .then((updated) => {
        setProjects((current) =>
          current.map((project) =>
            project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project
          )
        );
      })
      .catch((error) => {
        setSessionComposerErrors((current) => ({
          ...current,
          [sessionId]: error instanceof Error ? error.message : fallbackErrorMessage
        }));
      });
  }
  const selectedSessionLatestCheckpointId = selectedSessionId
    ? selectedProjectSessionCheckpoints[selectedSessionId]?.[0]?.id
    : undefined;

  const projectSwitcherItems = useMemo(
    () =>
      projects.map((project) =>
        buildProjectSwitcherItem({
          project: ensureProjectSessions(project),
          activeStreams: activeStreamSessions,
          runtimeStatuses: agentRuntimeStatuses,
          queuedPromptsBySession,
          composerErrors: sessionComposerErrors,
          activeSessionByProject: localActiveSessionByProject
        })
      ),
    [
      activeStreamSessions,
      agentRuntimeStatuses,
      localActiveSessionByProject,
      projects,
      queuedPromptsBySession,
      sessionComposerErrors
    ]
  );
  const virtualProjectFiles = selectedProjectView ? buildVirtualProjectFiles(selectedProjectView) : [];

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
    setEditingSkillId,
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

  function openAppSettings(tab: AppSettingsTab = 'appearance'): void {
    setAppSettingsInitialTab(tab);
    setShowAppSettingsModal(true);
  }

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

  function openProject(projectId: string): void {
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    if (project) {
      setLocalActiveSessionByProject((current) => ({
        ...current,
        [projectId]: project.activeSessionId || project.sessions[0]?.id || ''
      }));
    }
    setAppMode('workspace');
    setSection('agent');
    setSelectedFileId('');
    setSelectedOverlayFile(null);
    setRightInspectorCollapsed(true);
    dispatchRefreshFileTree({ projectId, reason: 'project-opened' });
  }

  function openDeleteProjectModal(project: Project): void {
    setProjectPendingDelete(project);
    setDeleteProjectSourceFiles(false);
    setShowDeleteProjectModal(true);
  }

  function closeDeleteProjectModal(): void {
    if (isDeletingProject) {
      return;
    }
    setShowDeleteProjectModal(false);
    setProjectPendingDelete(null);
    setDeleteProjectSourceFiles(false);
  }

  async function handleCreateProject(input: CreateProjectInput): Promise<void> {
    const project = await window.funplay.createProject(input);
    const shouldBindOnboardingEnginePlugin = input.engine?.platform === 'unity' && onboardingEnginePluginId;
    const nextProject = shouldBindOnboardingEnginePlugin
      ? await window.funplay.updateProjectMcpConfig(project.id, 'engine', onboardingEnginePluginId)
      : project;
    const enginePluginId = nextProject.mcpBindings.engine;
    if (
      (input.engine?.platform === 'unity' || input.engine?.platform === 'cocos') &&
      enginePluginId &&
      !mcpPlugins.some((plugin) => plugin.id === enginePluginId)
    ) {
      const payload = await window.funplay.bootstrap();
      setMcpPlugins(payload.mcpPlugins);
      setSelectedMcpPluginId(enginePluginId);
    }

    setProjects((current) => [nextProject, ...current.filter((item) => item.id !== nextProject.id)]);
    setLocalActiveSessionByProject((current) => ({
      ...current,
      [nextProject.id]: nextProject.activeSessionId || nextProject.sessions[0]?.id || ''
    }));
    setSelectedProjectId(nextProject.id);
    setRightInspectorCollapsed(true);
    if (nextProject.engine?.platform === 'unity' || nextProject.engine?.platform === 'cocos') {
      void retryRefreshProjectRuntimeState(nextProject.id);
    }

    setAppMode('workspace');
    setSection('agent');
    setSelectedFileId('');
    setSelectedOverlayFile(null);
    dispatchRefreshFileTree({ projectId: nextProject.id, reason: 'project-created' });
  }

  async function handleDeleteProject(): Promise<void> {
    if (!projectPendingDelete) {
      return;
    }

    setIsDeletingProject(true);
    try {
      const result = await window.funplay.deleteProject(projectPendingDelete.id, deleteProjectSourceFiles);
      setProjects(result.remainingProjects);
      setLocalActiveSessionByProject((current) => {
        const next = { ...current };
        delete next[projectPendingDelete.id];
        return next;
      });
      clearSessionScopedState(projectPendingDelete.sessions.map((session) => session.id));

      if (selectedProjectId === projectPendingDelete.id) {
        const nextProjectId = result.remainingProjects[0]?.id ?? '';
        if (nextProjectId) {
          openProject(nextProjectId);
        } else {
          setSelectedProjectId('');
          setAppMode('welcome');
          setSection('agent');
          setSelectedFileId('');
          setSelectedOverlayFile(null);
          setProjectFiles([]);
        }
      }

      setShowDeleteProjectModal(false);
      setProjectPendingDelete(null);
      setDeleteProjectSourceFiles(false);
    } finally {
      setIsDeletingProject(false);
    }
  }

  function updateSessionDraft(sessionId: string, value: string): void {
    setSessionDrafts((current) => ({ ...current, [sessionId]: value }));
    setSessionComposerErrors((current) => ({ ...current, [sessionId]: '' }));
  }

  function queuePromptForSession(sessionId: string, content: string): void {
    const prompt = content.trim();
    if (!sessionId || !prompt) {
      return;
    }

    setQueuedPromptsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        {
          id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          content: prompt
        }
      ]
    }));
  }

  function removeQueuedPrompt(sessionId: string, promptId: string): void {
    setQueuedPromptsBySession((current) => {
      const nextQueue = (current[sessionId] ?? []).filter((item) => item.id !== promptId);
      const next = { ...current };
      if (nextQueue.length > 0) {
        next[sessionId] = nextQueue;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }

  function seedPromptHandle(
    handle: {
      streamId: string;
      projectId: string;
      sessionId: string;
      startedAt: string;
      prompt?: string;
      attachments?: PromptAttachment[];
      kind?: 'conversation' | 'bootstrap';
    },
    fallbackPrompt: string
  ): void {
    seedStreamSession({
      streamId: handle.streamId,
      projectId: handle.projectId,
      sessionId: handle.sessionId,
      prompt: handle.prompt || fallbackPrompt,
      attachments: handle.attachments,
      content: '',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      phase: 'starting',
      kind: handle.kind,
      statusMessage: localize(
        uiPreferences.language,
        '已提交给 AI，正在准备上下文…',
        'Queued for AI. Preparing context…'
      ),
      startedAt: handle.startedAt
    });
  }

  async function handleSubmitComposer(
    content?: string,
    sessionIdOverride?: string,
    projectIdOverride?: string
  ): Promise<void> {
    const targetProject = projectIdOverride
      ? projects.find((project) => project.id === projectIdOverride)
      : selectedProjectView;
    if (!targetProject) {
      return;
    }

    const targetProjectView = ensureProjectSessions(targetProject);
    const sessionId = sessionIdOverride ?? targetProjectView.activeSessionId ?? targetProjectView.sessions[0]?.id;
    if (!sessionId) {
      return;
    }

    const attachments = sessionAttachments[sessionId] ?? [];
    const prompt = (content ?? sessionDrafts[sessionId] ?? '').trim();
    const message =
      prompt ||
      (attachments.length
        ? localize(uiPreferences.language, '请查看附件并继续处理。', 'Please review the attachments and continue.')
        : '');
    if (!message && attachments.length === 0) {
      return;
    }

    if (getStreamSessionForSession(targetProjectView.id, sessionId)) {
      queuePromptForSession(sessionId, formatQueuedPromptWithAttachments(message, attachments, uiPreferences.language));
      setSessionDrafts((current) => ({ ...current, [sessionId]: '' }));
      setSessionAttachments((current) => ({ ...current, [sessionId]: [] }));
      return;
    }

    setSessionComposerErrors((current) => ({ ...current, [sessionId]: '' }));
    if (targetProjectView.id === selectedProjectIdRef.current) {
      setLocalActiveSessionByProject((current) => ({
        ...current,
        [targetProjectView.id]: sessionId
      }));
    }
    try {
      await sessionMutationQueueRef.current;
      const handle = await window.funplay.startPromptStream(
        targetProjectView.id,
        message,
        sessionId,
        attachments,
        uiPreferences.language
      );
      setSessionDrafts((current) => ({ ...current, [sessionId]: '' }));
      setSessionAttachments((current) => ({ ...current, [sessionId]: [] }));
      seedPromptHandle(
        {
          ...handle,
          kind: 'conversation',
          prompt: handle.prompt || message,
          attachments
        },
        message
      );
    } catch (error) {
      setSessionDrafts((current) => ({ ...current, [sessionId]: message }));
      setSessionComposerErrors((current) => ({
        ...current,
        [sessionId]:
          error instanceof Error
            ? error.message
            : localize(
                uiPreferences.language,
                '发送失败，请检查 AI Provider 配置。',
                'Send failed. Check your AI Provider settings.'
              )
      }));
    }
  }

  async function handleCreateSession(): Promise<void> {
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() => window.funplay.createProjectSession(selectedProject.id));
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
    const nextSessionId = updated.activeSessionId || updated.sessions[0]?.id;
    if (nextSessionId) {
      setLocalActiveSessionByProject((current) => ({
        ...current,
        [updated.id]: nextSessionId
      }));
      setSessionDrafts((current) => ({ ...current, [nextSessionId]: '' }));
      setSessionAttachments((current) => ({ ...current, [nextSessionId]: [] }));
      setSessionComposerErrors((current) => ({ ...current, [nextSessionId]: '' }));
    }
    setSection('agent');
  }

  async function handleSelectSession(sessionId: string, projectIdOverride?: string): Promise<void> {
    const targetProject = projectIdOverride
      ? (projects.find((project) => project.id === projectIdOverride) ?? null)
      : selectedProject;
    if (!targetProject) {
      setSection('agent');
      return;
    }

    const currentProjectId = targetProject.id;
    const currentProject = ensureProjectSessions(targetProject);
    const currentActiveSessionId = localActiveSessionByProject[currentProject.id] || currentProject.activeSessionId;
    if (currentActiveSessionId === sessionId) {
      setSection('agent');
      return;
    }

    const nextActiveSession = currentProject.sessions.find((session) => session.id === sessionId);
    if (!nextActiveSession) {
      return;
    }

    if (selectedProjectIdRef.current !== currentProjectId) {
      openProject(currentProjectId);
    }

    const token = activeSessionSwitchTokenRef.current + 1;
    activeSessionSwitchTokenRef.current = token;
    setLocalActiveSessionByProject((current) => ({
      ...current,
      [currentProjectId]: sessionId
    }));

    setProjects((current) =>
      current.map((project) =>
        project.id === currentProjectId
          ? {
              ...project,
              activeSessionId: sessionId,
              chat: [...nextActiveSession.chat]
            }
          : project
      )
    );

    const updated = await enqueueSessionMutation(() =>
      window.funplay.setActiveProjectSession(currentProjectId, sessionId)
    );
    if (activeSessionSwitchTokenRef.current !== token) {
      return;
    }

    setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project))
    );
    setSection('agent');
  }

  async function handleRenameSession(sessionId: string, title: string): Promise<void> {
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() =>
      window.funplay.renameProjectSession(selectedProject.id, sessionId, title)
    );
    setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project))
    );
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() =>
      window.funplay.deleteProjectSession(selectedProject.id, sessionId)
    );
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
    setLocalActiveSessionByProject((current) => ({
      ...current,
      [updated.id]: updated.activeSessionId || updated.sessions[0]?.id || ''
    }));
    clearSessionScopedState([sessionId]);
    setSection('agent');
  }

  async function handleResumeAgentRun(runId: string): Promise<void> {
    if (!selectedProjectView) {
      return;
    }

    try {
      const handle = await window.funplay.resumeAgentRun(runId);
      setLocalActiveSessionByProject((current) => ({
        ...current,
        [handle.projectId]: handle.sessionId
      }));
      setSection('agent');
      seedPromptHandle(
        {
          ...handle,
          kind: handle.kind,
          prompt: handle.prompt || localize(uiPreferences.language, '恢复 Agent 运行', 'Resume Agent run')
        },
        localize(uiPreferences.language, '恢复 Agent 运行', 'Resume Agent run')
      );
    } catch (error) {
      const sessionId = selectedSessionId || selectedProjectView.sessions[0]?.id || selectedProjectView.id;
      setSessionComposerErrors((current) => ({
        ...current,
        [sessionId]:
          error instanceof Error
            ? error.message
            : localize(uiPreferences.language, '恢复 Agent 运行失败。', 'Failed to resume the Agent run.')
      }));
    }
  }

  async function refreshProjectRuntimeStateById(projectId: string): Promise<Project | null> {
    const updated = await window.funplay.refreshProjectRuntimeState(projectId);
    if (!updated) {
      return null;
    }
    setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectRuntimeRefresh(project, updated) : project))
    );
    return updated;
  }

  async function retryRefreshProjectRuntimeState(projectId: string, attempts = 6, delayMs = 1500): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
      const updated = await refreshProjectRuntimeStateById(projectId).catch(() => null);
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

  function buildSelectedProjectEnvironmentInput(project: Project): {
    platform: Exclude<NonNullable<Project['engine']>['platform'], 'web'>;
    mode: 'import';
    dimension: EngineProjectDimension;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  } {
    if (!project.engine?.projectPath || project.engine.platform === 'web') {
      throw new Error(
        localize(uiPreferences.language, '当前项目没有可打开的引擎路径。', 'This project has no engine path to open.')
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

  async function diagnoseSelectedProjectEnvironment(): Promise<EnvironmentDiagnostics> {
    if (!selectedProjectView) {
      throw new Error(localize(uiPreferences.language, '请先选择一个项目。', 'Select a project first.'));
    }
    return window.funplay.diagnoseEnvironment(buildSelectedProjectEnvironmentInput(selectedProjectView));
  }

  async function runSelectedProjectEnvironmentAction(
    actionId: EnvironmentActionKind
  ): Promise<EnvironmentActionResult> {
    if (!selectedProjectView) {
      throw new Error(localize(uiPreferences.language, '请先选择一个项目。', 'Select a project first.'));
    }
    const result = await window.funplay.runEnvironmentAction({
      ...buildSelectedProjectEnvironmentInput(selectedProjectView),
      actionId
    });
    void retryRefreshProjectRuntimeState(selectedProjectView.id, 6, 1200);
    return result;
  }

  if (isLoading) {
    return (
      <UiLanguageProvider language={uiPreferences.language}>
        <>
          <div className="app-bootstrap-screen">
            {localize(uiPreferences.language, '正在加载 Funplay…', 'Loading Funplay…')}
          </div>
          <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />
        </>
      </UiLanguageProvider>
    );
  }

  if (bootstrapError) {
    return (
      <UiLanguageProvider language={uiPreferences.language}>
        <>
          <div className="app-bootstrap-screen">
            <div className="bootstrap-error-card">
              <strong>{localize(uiPreferences.language, 'Funplay 启动失败', 'Funplay failed to start')}</strong>
              <div>{bootstrapError}</div>
            </div>
          </div>
          <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />
        </>
      </UiLanguageProvider>
    );
  }

  if (appMode === 'welcome') {
    return (
      <UiLanguageProvider language={uiPreferences.language}>
        <>
          <WelcomeScreen
            projects={projects}
            mcpPlugins={mcpPlugins}
            onCreate={() => {
              onboarding.startOnboarding();
              setAppMode('onboarding');
            }}
            onOpen={openProject}
            onOpenExisting={() => void onboarding.handlePickExistingProjectFromWelcome()}
          />
          <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />
        </>
      </UiLanguageProvider>
    );
  }

  if (appMode === 'onboarding') {
    return (
      <UiLanguageProvider language={uiPreferences.language}>
        <>
          <OnboardingScreen
            step={onboarding.onboardingStep}
            view={onboarding.onboardingView}
            mode={onboarding.onboardingMode}
            platform={onboarding.onboardingPlatform}
            dimension={onboarding.onboardingDimension}
            projectName={onboarding.onboardingProjectName}
            projectPath={onboarding.onboardingProjectPath}
            unityEditors={onboarding.onboardingUnityEditors}
            selectedUnityEditorVersion={onboarding.onboardingUnityEditorVersion}
            diagnostics={onboarding.environmentDiagnostics}
            tasks={onboarding.environmentTasks}
            detectionMessage={onboarding.onboardingDetectionMessage}
            detectionOk={onboarding.onboardingDetectionOk}
            actionMessage={onboarding.environmentActionMessage}
            isChecking={onboarding.isCheckingEngine}
            isCreatingProject={onboarding.isCreatingProject}
            onModeChange={onboarding.setOnboardingMode}
            onPlatformChange={onboarding.setOnboardingPlatform}
            onDimensionChange={onboarding.setOnboardingDimension}
            onProjectNameChange={onboarding.setOnboardingProjectName}
            onPathChange={onboarding.setOnboardingProjectPath}
            onUnityEditorVersionChange={onboarding.setOnboardingUnityEditorVersion}
            onBrowsePath={() => void onboarding.handleBrowseOnboardingProjectPath()}
            onDetect={() => void onboarding.handleCheckOnboardingConnection()}
            onRunAction={(actionId) => void onboarding.handleRunEnvironmentAction(actionId)}
            onBackToSetup={() => onboarding.setOnboardingView('setup')}
            onSkip={() => setAppMode('workspace')}
            onNext={() => void onboarding.handleFinishOnboarding()}
            onEnter={() => void onboarding.handleEnterWorkspace()}
          />
          <NotificationToastStack notifications={appNotifications} onDismiss={dismissNotification} />
        </>
      </UiLanguageProvider>
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
            openDeleteProjectModal(project);
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
        renderLeftPanel={({ width, close }) => (
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
                composerDraft={selectedComposerValue}
                composerAttachments={selectedComposerAttachments}
                composerError={selectedComposerError}
                queuedPrompts={selectedQueuedPrompts}
                isSending={Boolean(
                  selectedProjectStream && !['completed', 'cancelled', 'error'].includes(selectedProjectStream.phase)
                )}
                onComposerChange={(value) => {
                  if (selectedSessionId) {
                    updateSessionDraft(selectedSessionId, value);
                  }
                }}
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
                onQueuePrompt={(content) => {
                  if (!selectedSessionId) {
                    return;
                  }
                  queuePromptForSession(selectedSessionId, content);
                  updateSessionDraft(selectedSessionId, '');
                }}
                onRemoveQueuedPrompt={(promptId) => {
                  if (selectedSessionId) {
                    removeQueuedPrompt(selectedSessionId, promptId);
                  }
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
              tab={projectSettingsTab}
              onTabChange={setProjectSettingsTab}
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
          onClose={closeDeleteProjectModal}
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
