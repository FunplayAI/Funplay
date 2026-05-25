import type { Project, CreateProjectInput, DeleteProjectResult, ProjectFileEntry, ProjectFileContent, ProjectAgentPolicy, ProjectSessionRuntimeId, ProjectSessionEffort, AgentPermissionMode, ProjectMemoryFileSummary, ProjectMemoryFileContent, ProjectMemoryClearScope, SessionCheckpointPreview, ProjectHtmlPreviewServerResult, ProjectHtmlPreviewServerStopResult } from './project';
import type { AiProvider, AiSettings, AiProviderInput, AiTestResult, AiProviderAuthStyle, AgentSettings, WebSearchSettings, WebResearchMetrics, WebSearchQualityReport } from './provider';
import type { McpConnectionSnapshot, McpPlugin, McpRawAuditEntry, McpRawRequestResult, McpSettings, McpToolSnapshot, UnitySettings, UnityHealthResult, UnityMcpServerInfo, UnityMcpTool, UnityMcpCallResult, UnityMcpResource, UnityMcpPrompt, UnityMcpPromptResult, UnityMcpResourceTemplate, UnityMcpCompletionResult, McpPluginKind, McpPluginInput, PlatformChoice, ProjectSetupMode, EngineProjectDimension, EnvironmentDiagnostics, EnvironmentActionKind, EnvironmentActionResult, EnvironmentTask, InstalledUnityEditorOption, FolderPickerResult } from './unity';
import type { AgentRuntimeCapabilityReport, AgentRuntimeStatus, AgentReplayLog, AgentSkillCatalogResult, AgentSkillRegistrySnapshot } from './agent';
import type { PromptStreamEvent, PromptStreamHandle, AgentUserInputResponse } from './stream';
import type { PromptAttachment } from './chat';
import type { AppNotification, AppUpdateSnapshot, ScheduledNotificationTask, ClaudeRuntimeSetupStatus, ClaudeSessionSummary, ClaudeSessionImportResult, RuntimeDoctorResult } from './app';
import type { AssetGenerationProviderConfig, AssetGenerationProviderInput, AssetGenerationProviderProfile, AssetGenerationRequest } from './asset-generation';

export interface AppState {
  settings: UnitySettings;
  aiSettings: AiSettings;
  agentSettings: AgentSettings;
  providers: AiProvider[];
  mcpSettings: McpSettings;
  mcpPlugins: McpPlugin[];
  assetGenerationProviders: AssetGenerationProviderConfig[];
  projects: Project[];
}

export interface BootstrapPayload {
  settings: UnitySettings;
  aiSettings: AiSettings;
  agentSettings: AgentSettings;
  providers: AiProvider[];
  mcpSettings: McpSettings;
  mcpPlugins: McpPlugin[];
  assetGenerationProviders: AssetGenerationProviderConfig[];
  projects: Project[];
}

export interface FunPlayApi {
  bootstrap: () => Promise<BootstrapPayload>;
  openExternal: (url: string) => Promise<{ success: true }>;
  openLocalPath: (path: string) => Promise<{ success: true }>;
  revealLocalPath: (path: string) => Promise<{ success: true }>;
  diagnoseEnvironment: (input: {
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: EngineProjectDimension;
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }) => Promise<EnvironmentDiagnostics>;
  runEnvironmentAction: (input: {
    actionId: EnvironmentActionKind;
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: EngineProjectDimension;
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }) => Promise<EnvironmentActionResult>;
  listEnvironmentTasks: () => Promise<EnvironmentTask[]>;
  listInstalledUnityEditors: (dimension?: EngineProjectDimension) => Promise<InstalledUnityEditorOption[]>;
  pickProjectFolder: (input: { mode: ProjectSetupMode; defaultPath?: string }) => Promise<FolderPickerResult>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  deleteProject: (projectId: string, deleteSourceFiles?: boolean) => Promise<DeleteProjectResult>;
  listProjectFiles: (projectId: string) => Promise<ProjectFileEntry[]>;
  listAssetGenerationProviders: () => Promise<AssetGenerationProviderProfile[]>;
  createAssetGenerationProvider: (input: AssetGenerationProviderInput) => Promise<AssetGenerationProviderConfig>;
  updateAssetGenerationProvider: (providerId: string, input: AssetGenerationProviderInput) => Promise<AssetGenerationProviderConfig>;
  deleteAssetGenerationProvider: (providerId: string) => Promise<{ success: true }>;
  generateAsset: (projectId: string, input: AssetGenerationRequest) => Promise<Project>;
  importGeneratedAsset: (projectId: string, jobId: string) => Promise<Project>;
  cancelAssetGenerationJob: (projectId: string, jobId: string) => Promise<Project>;
  onAssetGenerationProjectUpdated: (listener: (project: Project) => void) => () => void;
  readProjectFile: (projectId: string, filePath: string) => Promise<ProjectFileContent>;
  writeProjectFile: (projectId: string, filePath: string, content: string) => Promise<ProjectFileContent>;
  openProjectFile: (projectId: string, filePath: string) => Promise<{ success: true }>;
  revealProjectFile: (projectId: string, filePath: string) => Promise<{ success: true }>;
  startProjectHtmlPreviewServer: (projectId: string) => Promise<ProjectHtmlPreviewServerResult>;
  stopProjectHtmlPreviewServer: (projectId: string) => Promise<ProjectHtmlPreviewServerStopResult>;
  refreshProjectRuntimeState: (projectId: string) => Promise<Project | null>;
  createProjectSession: (projectId: string, title?: string) => Promise<Project>;
  renameProjectSession: (projectId: string, sessionId: string, title: string) => Promise<Project>;
  deleteProjectSession: (projectId: string, sessionId: string) => Promise<Project>;
  setActiveProjectSession: (projectId: string, sessionId: string) => Promise<Project>;
  updateProjectAgentPolicy: (projectId: string, policy: Partial<ProjectAgentPolicy>) => Promise<Project>;
  listAgentSkillCatalog: (options?: { refresh?: boolean }) => Promise<AgentSkillCatalogResult>;
  listProjectAgentSkillRegistry: (projectId: string) => Promise<AgentSkillRegistrySnapshot>;
  updateProjectSessionRuntime: (
    projectId: string,
    sessionId: string,
    runtime: {
      runtimeId?: ProjectSessionRuntimeId;
      providerId?: string;
      model?: string;
      permissionMode?: AgentPermissionMode;
      effort?: ProjectSessionEffort;
    }
  ) => Promise<Project>;
  sendPrompt: (projectId: string, message: string) => Promise<Project>;
  startPromptStream: (projectId: string, message: string, sessionId?: string, attachments?: PromptAttachment[]) => Promise<PromptStreamHandle>;
  cancelPromptStream: (streamId: string) => Promise<{ success: true }>;
  respondPromptPermission: (requestId: string, decision: 'allow' | 'allow_session' | 'deny') => Promise<{ success: true }>;
  respondPromptUserInput: (requestId: string, response: AgentUserInputResponse) => Promise<{ success: true }>;
  onPromptStreamEvent: (listener: (event: PromptStreamEvent) => void) => () => void;
  onProjectFileTreeChanged: (listener: (event: import('./project').ProjectFileTreeChangedEvent) => void) => () => void;
  onAppNotification: (listener: (event: AppNotification) => void) => () => void;
  onAppUpdateStatus: (listener: (event: AppUpdateSnapshot) => void) => () => void;
  drainAppNotifications: () => Promise<AppNotification[]>;
  getUpdateStatus: () => Promise<AppUpdateSnapshot>;
  checkForUpdates: () => Promise<AppUpdateSnapshot>;
  downloadUpdate: () => Promise<AppUpdateSnapshot>;
  installUpdate: () => Promise<AppUpdateSnapshot>;
  listNotificationTasks: () => Promise<ScheduledNotificationTask[]>;
  cancelNotificationTask: (taskId: string) => Promise<{ success: true }>;
  listProjectMemoryFiles: (projectId: string) => Promise<ProjectMemoryFileSummary[]>;
  readProjectMemoryFile: (projectId: string, filePath: string) => Promise<ProjectMemoryFileContent>;
  saveProjectMemoryFile: (projectId: string, filePath: string, content: string) => Promise<ProjectMemoryFileContent>;
  clearProjectMemory: (
    projectId: string,
    input: {
      scope: ProjectMemoryClearScope;
      filePath?: string;
    }
  ) => Promise<ProjectMemoryFileSummary[]>;
  detectClaudeRuntime: () => Promise<ClaudeRuntimeSetupStatus>;
  runClaudeLogin: () => Promise<{ success: true; output?: string }>;
  listClaudeCliSessions: (projectId?: string) => Promise<ClaudeSessionSummary[]>;
  importClaudeCliSession: (projectId: string, sdkSessionId: string) => Promise<ClaudeSessionImportResult>;
  pickPromptAttachments: (projectId: string) => Promise<PromptAttachment[]>;
  listAgentRuntimeCapabilities: () => Promise<AgentRuntimeCapabilityReport[]>;
  getAgentRuntimeStatus: (projectId?: string) => Promise<AgentRuntimeStatus[]>;
  interruptAgentRun: (runId: string) => Promise<{ success: true }>;
  resumeAgentRun: (runId: string) => Promise<PromptStreamHandle>;
  exportAgentRunLog: (runId: string) => Promise<AgentReplayLog>;
  createSnapshot: (projectId: string, note: string) => Promise<Project>;
  previewSessionCheckpoint: (projectId: string, snapshotId: string) => Promise<SessionCheckpointPreview>;
  restoreSessionCheckpoint: (projectId: string, snapshotId: string) => Promise<Project>;
  updateProjectMcpConfig: (projectId: string, kind: McpPluginKind, pluginId: string) => Promise<Project>;
  updateProjectMcpServers: (projectId: string, pluginIds: string[]) => Promise<Project>;
  updateSettings: (settings: Partial<UnitySettings>) => Promise<UnitySettings>;
  updateAgentSettings: (settings: Partial<AgentSettings>) => Promise<AgentSettings>;
  updateWebSearchSettings: (settings: Partial<WebSearchSettings>) => Promise<AiSettings>;
  getWebResearchMetrics: () => Promise<WebResearchMetrics>;
  resetWebResearchMetrics: () => Promise<WebResearchMetrics>;
  runWebSearchQualityEval: () => Promise<WebSearchQualityReport>;
  createMcpPlugin: (input: McpPluginInput) => Promise<McpPlugin>;
  updateMcpPlugin: (pluginId: string, input: McpPluginInput) => Promise<McpPlugin>;
  deleteMcpPlugin: (pluginId: string) => Promise<{ success: true }>;
  setActiveMcpPlugin: (pluginId: string) => Promise<McpSettings>;
  checkMcpHealth: (pluginId?: string) => Promise<UnityHealthResult>;
  getMcpConnectionStatus: (pluginId?: string) => Promise<McpConnectionSnapshot>;
  reconnectMcp: (pluginId?: string) => Promise<UnityHealthResult>;
  stopMcp: (pluginId?: string) => Promise<McpConnectionSnapshot>;
  getMcpServerInfo: (pluginId?: string) => Promise<UnityMcpServerInfo>;
  listMcpToolSnapshots: (pluginId?: string) => Promise<McpToolSnapshot[]>;
  listMcpRawAudits: (pluginId?: string) => Promise<McpRawAuditEntry[]>;
  sendRawMcpRequest: (pluginId: string, method: string, params?: Record<string, unknown>) => Promise<McpRawRequestResult>;
  listMcpTools: (pluginId?: string) => Promise<UnityMcpTool[]>;
  callMcpTool: (toolName: string, args?: Record<string, unknown>, pluginId?: string) => Promise<UnityMcpCallResult>;
  listMcpResources: (pluginId?: string) => Promise<UnityMcpResource[]>;
  readMcpResource: (uri: string, pluginId?: string) => Promise<UnityMcpCallResult>;
  listMcpPrompts: (pluginId?: string) => Promise<UnityMcpPrompt[]>;
  getMcpPrompt: (name: string, args?: Record<string, unknown>, pluginId?: string) => Promise<UnityMcpPromptResult>;
  listMcpResourceTemplates: (pluginId?: string) => Promise<UnityMcpResourceTemplate[]>;
  completeMcpArgument: (
    ref: Record<string, unknown>,
    argumentName: string,
    value: string,
    context?: Record<string, unknown>,
    pluginId?: string
  ) => Promise<UnityMcpCompletionResult>;
  checkUnityHealth: (baseUrl?: string) => Promise<UnityHealthResult>;
  getUnityConnectionStatus: (baseUrl?: string) => Promise<McpConnectionSnapshot>;
  reconnectUnity: (baseUrl?: string) => Promise<UnityHealthResult>;
  getUnityServerInfo: (baseUrl?: string) => Promise<UnityMcpServerInfo>;
  listUnityTools: (baseUrl?: string) => Promise<UnityMcpTool[]>;
  callUnityTool: (toolName: string, args?: Record<string, unknown>, baseUrl?: string) => Promise<UnityMcpCallResult>;
  listUnityResources: (baseUrl?: string) => Promise<UnityMcpResource[]>;
  readUnityResource: (uri: string, baseUrl?: string) => Promise<UnityMcpCallResult>;
  listUnityPrompts: (baseUrl?: string) => Promise<UnityMcpPrompt[]>;
  getUnityPrompt: (name: string, args?: Record<string, unknown>, baseUrl?: string) => Promise<UnityMcpPromptResult>;
  listUnityResourceTemplates: (baseUrl?: string) => Promise<UnityMcpResourceTemplate[]>;
  completeUnityMcpArgument: (
    ref: Record<string, unknown>,
    argumentName: string,
    value: string,
    context?: Record<string, unknown>,
    baseUrl?: string
  ) => Promise<UnityMcpCompletionResult>;
  createProvider: (input: AiProviderInput) => Promise<AiProvider>;
  updateProvider: (providerId: string, input: AiProviderInput) => Promise<AiProvider>;
  deleteProvider: (providerId: string) => Promise<{ success: true }>;
  setDefaultProvider: (providerId: string) => Promise<AiSettings>;
  testProvider: (providerId: string) => Promise<AiTestResult>;
  runClaudeDoctor: (input?: { providerId?: string; projectId?: string; live?: boolean }) => Promise<RuntimeDoctorResult>;
  runProviderDoctor: (providerId: string, input?: { projectId?: string; live?: boolean }) => Promise<RuntimeDoctorResult>;
  repairProviderDiagnostic: (input: { actionId: string; providerId?: string; projectId?: string; sessionId?: string; authStyle?: AiProviderAuthStyle; url?: string }) => Promise<{ success: true; stateChanged: boolean }>;
  exportRuntimeDiagnostics: (input?: { providerId?: string; projectId?: string; live?: boolean }) => Promise<string>;
}
