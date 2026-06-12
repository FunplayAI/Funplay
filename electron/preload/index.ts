import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AiProviderInput,
  AssetGenerationProviderInput,
  AssetGenerationRequest,
  CreateProjectInput,
  EnvironmentActionKind,
  FunPlayApi,
  AgentUserInputResponse,
  AiProviderAuthStyle,
  McpPluginInput,
  McpPluginKind,
  PlatformChoice,
  PromptAttachment,
  ProjectSetupMode,
  UnitySettings
} from '../../shared/types';

const api: FunPlayApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  openLocalPath: (path: string) => ipcRenderer.invoke('app:openLocalPath', path),
  revealLocalPath: (path: string) => ipcRenderer.invoke('app:revealLocalPath', path),
  diagnoseEnvironment: (input: {
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: '2d' | '3d' | 'unknown';
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }) => ipcRenderer.invoke('onboarding:diagnoseEnvironment', input),
  runEnvironmentAction: (input: {
    actionId: EnvironmentActionKind;
    platform: PlatformChoice;
    mode: ProjectSetupMode;
    dimension: '2d' | '3d' | 'unknown';
    projectName?: string;
    projectPath: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }) => ipcRenderer.invoke('onboarding:runEnvironmentAction', input),
  listEnvironmentTasks: () => ipcRenderer.invoke('onboarding:listEnvironmentTasks'),
  listInstalledUnityEditors: (dimension?: '2d' | '3d' | 'unknown') =>
    ipcRenderer.invoke('onboarding:listInstalledUnityEditors', dimension),
  pickProjectFolder: (input: { mode: ProjectSetupMode; defaultPath?: string }) =>
    ipcRenderer.invoke('dialog:pickProjectFolder', input),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke('projects:create', input),
  deleteProject: (projectId: string, deleteSourceFiles?: boolean) =>
    ipcRenderer.invoke('projects:delete', projectId, deleteSourceFiles),
  listProjectFiles: (projectId: string) => ipcRenderer.invoke('projects:listFiles', projectId),
  listAssetGenerationProviders: () => ipcRenderer.invoke('assetGeneration:listProviders'),
  createAssetGenerationProvider: (input: AssetGenerationProviderInput) =>
    ipcRenderer.invoke('assetGeneration:createProvider', input),
  updateAssetGenerationProvider: (providerId: string, input: AssetGenerationProviderInput) =>
    ipcRenderer.invoke('assetGeneration:updateProvider', providerId, input),
  deleteAssetGenerationProvider: (providerId: string) =>
    ipcRenderer.invoke('assetGeneration:deleteProvider', providerId),
  generateAsset: (projectId: string, input: AssetGenerationRequest) =>
    ipcRenderer.invoke('assetGeneration:generate', projectId, input),
  importGeneratedAsset: (projectId: string, jobId: string) =>
    ipcRenderer.invoke('assetGeneration:import', projectId, jobId),
  cancelAssetGenerationJob: (projectId: string, jobId: string) =>
    ipcRenderer.invoke('assetGeneration:cancel', projectId, jobId),
  onAssetGenerationProjectUpdated: (listener) => {
    const channel = 'assetGeneration:projectUpdated';
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  readProjectFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke('projects:readFile', projectId, filePath),
  writeProjectFile: (projectId: string, filePath: string, content: string) =>
    ipcRenderer.invoke('projects:writeFile', projectId, filePath, content),
  openProjectFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke('projects:openFile', projectId, filePath),
  revealProjectFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke('projects:revealFile', projectId, filePath),
  startProjectHtmlPreviewServer: (projectId: string) =>
    ipcRenderer.invoke('projects:startHtmlPreviewServer', projectId),
  stopProjectHtmlPreviewServer: (projectId: string) => ipcRenderer.invoke('projects:stopHtmlPreviewServer', projectId),
  refreshProjectRuntimeState: (projectId: string) => ipcRenderer.invoke('projects:refreshRuntimeState', projectId),
  createProjectSession: (projectId: string, title?: string) =>
    ipcRenderer.invoke('projects:createSession', projectId, title),
  renameProjectSession: (projectId: string, sessionId: string, title: string) =>
    ipcRenderer.invoke('projects:renameSession', projectId, sessionId, title),
  deleteProjectSession: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('projects:deleteSession', projectId, sessionId),
  setActiveProjectSession: (projectId: string, sessionId: string) =>
    ipcRenderer.invoke('projects:setActiveSession', projectId, sessionId),
  updateProjectAgentPolicy: (projectId: string, policy) =>
    ipcRenderer.invoke('projects:updateAgentPolicy', projectId, policy),
  listAgentSkillCatalog: (options?: { refresh?: boolean }) => ipcRenderer.invoke('skills:listCatalog', options),
  listProjectAgentSkillRegistry: (projectId: string) => ipcRenderer.invoke('skills:listProjectRegistry', projectId),
  updateProjectSessionRuntime: (projectId: string, sessionId: string, runtime) =>
    ipcRenderer.invoke('projects:updateSessionRuntime', projectId, sessionId, runtime),
  sendPrompt: (projectId: string, message: string) => ipcRenderer.invoke('projects:sendPrompt', projectId, message),
  startPromptStream: (
    projectId: string,
    message: string,
    sessionId?: string,
    attachments?: PromptAttachment[],
    uiLanguage?: 'zh-CN' | 'en-US'
  ) => ipcRenderer.invoke('projects:startPromptStream', projectId, message, sessionId, attachments, uiLanguage),
  importPromptAttachments: (projectId, items) => ipcRenderer.invoke('dialog:importPromptAttachments', projectId, items),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  cancelPromptStream: (streamId: string) => ipcRenderer.invoke('projects:cancelPromptStream', streamId),
  respondPromptPermission: (requestId: string, decision: 'allow' | 'allow_session' | 'deny') =>
    ipcRenderer.invoke('projects:respondPromptPermission', requestId, decision),
  respondPromptUserInput: (requestId: string, response: AgentUserInputResponse) =>
    ipcRenderer.invoke('projects:respondPromptUserInput', requestId, response),
  onPromptStreamEvent: (listener) => {
    const channel = 'projects:promptStreamEvent';
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onProjectFileTreeChanged: (listener) => {
    const channel = 'projects:fileTreeChanged';
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onAppNotification: (listener) => {
    const channel = 'app:notification';
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onAppUpdateStatus: (listener) => {
    const channel = 'updates:status';
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  drainAppNotifications: () => ipcRenderer.invoke('notifications:drain'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:getStatus'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  listNotificationTasks: () => ipcRenderer.invoke('notifications:listTasks'),
  cancelNotificationTask: (taskId: string) => ipcRenderer.invoke('notifications:cancelTask', taskId),
  listProjectMemoryFiles: (projectId: string) => ipcRenderer.invoke('memory:listFiles', projectId),
  readProjectMemoryFile: (projectId: string, filePath: string) =>
    ipcRenderer.invoke('memory:readFile', projectId, filePath),
  saveProjectMemoryFile: (projectId: string, filePath: string, content: string) =>
    ipcRenderer.invoke('memory:saveFile', projectId, filePath, content),
  clearProjectMemory: (projectId: string, input) => ipcRenderer.invoke('memory:clear', projectId, input),
  runRuntimeDoctor: (input?: { providerId?: string; projectId?: string; live?: boolean }) =>
    ipcRenderer.invoke('runtimeDoctor:run', input),
  pickPromptAttachments: (projectId: string) => ipcRenderer.invoke('dialog:pickPromptAttachments', projectId),
  listAgentRuntimeCapabilities: () => ipcRenderer.invoke('agent:listRuntimeCapabilities'),
  getAgentRuntimeStatus: (projectId?: string) => ipcRenderer.invoke('agent:getRuntimeStatus', projectId),
  interruptAgentRun: (runId: string) => ipcRenderer.invoke('agent:interruptRun', runId),
  resumeAgentRun: (runId: string) => ipcRenderer.invoke('agent:resumeRun', runId),
  exportAgentRunLog: (runId: string) => ipcRenderer.invoke('agent:exportRunLog', runId),
  createSnapshot: (projectId: string, note: string) => ipcRenderer.invoke('projects:createSnapshot', projectId, note),
  previewSessionCheckpoint: (projectId: string, snapshotId: string) =>
    ipcRenderer.invoke('projects:previewSessionCheckpoint', projectId, snapshotId),
  restoreSessionCheckpoint: (projectId: string, snapshotId: string) =>
    ipcRenderer.invoke('projects:restoreSessionCheckpoint', projectId, snapshotId),
  updateProjectMcpConfig: (projectId: string, kind: McpPluginKind, pluginId: string) =>
    ipcRenderer.invoke('projects:updateMcpConfig', projectId, kind, pluginId),
  updateProjectMcpServers: (projectId: string, pluginIds: string[]) =>
    ipcRenderer.invoke('projects:updateMcpServers', projectId, pluginIds),
  updateSettings: (settings: Partial<UnitySettings>) => ipcRenderer.invoke('settings:update', settings),
  updateAgentSettings: (settings) => ipcRenderer.invoke('agentSettings:update', settings),
  updateWebSearchSettings: (settings) => ipcRenderer.invoke('webSearchSettings:update', settings),
  getWebResearchMetrics: () => ipcRenderer.invoke('webResearch:getMetrics'),
  resetWebResearchMetrics: () => ipcRenderer.invoke('webResearch:resetMetrics'),
  runWebSearchQualityEval: () => ipcRenderer.invoke('webResearch:runQualityEval'),
  createMcpPlugin: (input: McpPluginInput) => ipcRenderer.invoke('mcp:createPlugin', input),
  updateMcpPlugin: (pluginId: string, input: McpPluginInput) => ipcRenderer.invoke('mcp:updatePlugin', pluginId, input),
  deleteMcpPlugin: (pluginId: string) => ipcRenderer.invoke('mcp:deletePlugin', pluginId),
  setActiveMcpPlugin: (pluginId: string) => ipcRenderer.invoke('mcp:setActivePlugin', pluginId),
  checkMcpHealth: (pluginId?: string) => ipcRenderer.invoke('mcp:checkHealth', pluginId),
  getMcpConnectionStatus: (pluginId?: string) => ipcRenderer.invoke('mcp:getConnectionStatus', pluginId),
  reconnectMcp: (pluginId?: string) => ipcRenderer.invoke('mcp:reconnect', pluginId),
  stopMcp: (pluginId?: string) => ipcRenderer.invoke('mcp:stop', pluginId),
  getMcpServerInfo: (pluginId?: string) => ipcRenderer.invoke('mcp:getServerInfo', pluginId),
  listMcpToolSnapshots: (pluginId?: string) => ipcRenderer.invoke('mcp:listToolSnapshots', pluginId),
  listMcpRawAudits: (pluginId?: string) => ipcRenderer.invoke('mcp:listRawAudits', pluginId),
  sendRawMcpRequest: (pluginId: string, method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke('mcp:sendRawRequest', pluginId, method, params),
  listMcpTools: (pluginId?: string) => ipcRenderer.invoke('mcp:listTools', pluginId),
  callMcpTool: (toolName: string, args?: Record<string, unknown>, pluginId?: string) =>
    ipcRenderer.invoke('mcp:callTool', toolName, args, pluginId),
  listMcpResources: (pluginId?: string) => ipcRenderer.invoke('mcp:listResources', pluginId),
  readMcpResource: (uri: string, pluginId?: string) => ipcRenderer.invoke('mcp:readResource', uri, pluginId),
  listMcpPrompts: (pluginId?: string) => ipcRenderer.invoke('mcp:listPrompts', pluginId),
  getMcpPrompt: (name: string, args?: Record<string, unknown>, pluginId?: string) =>
    ipcRenderer.invoke('mcp:getPrompt', name, args, pluginId),
  listMcpResourceTemplates: (pluginId?: string) => ipcRenderer.invoke('mcp:listResourceTemplates', pluginId),
  completeMcpArgument: (
    ref: Record<string, unknown>,
    argumentName: string,
    value: string,
    context?: Record<string, unknown>,
    pluginId?: string
  ) => ipcRenderer.invoke('mcp:completeArgument', ref, argumentName, value, context, pluginId),
  checkUnityHealth: (baseUrl?: string) => ipcRenderer.invoke('unity:checkHealth', baseUrl),
  getUnityConnectionStatus: (baseUrl?: string) => ipcRenderer.invoke('unity:getConnectionStatus', baseUrl),
  reconnectUnity: (baseUrl?: string) => ipcRenderer.invoke('unity:reconnect', baseUrl),
  getUnityServerInfo: (baseUrl?: string) => ipcRenderer.invoke('unity:getServerInfo', baseUrl),
  listUnityTools: (baseUrl?: string) => ipcRenderer.invoke('unity:listTools', baseUrl),
  callUnityTool: (toolName: string, args?: Record<string, unknown>, baseUrl?: string) =>
    ipcRenderer.invoke('unity:callTool', toolName, args, baseUrl),
  listUnityResources: (baseUrl?: string) => ipcRenderer.invoke('unity:listResources', baseUrl),
  readUnityResource: (uri: string, baseUrl?: string) => ipcRenderer.invoke('unity:readResource', uri, baseUrl),
  listUnityPrompts: (baseUrl?: string) => ipcRenderer.invoke('unity:listPrompts', baseUrl),
  getUnityPrompt: (name: string, args?: Record<string, unknown>, baseUrl?: string) =>
    ipcRenderer.invoke('unity:getPrompt', name, args, baseUrl),
  listUnityResourceTemplates: (baseUrl?: string) => ipcRenderer.invoke('unity:listResourceTemplates', baseUrl),
  completeUnityMcpArgument: (
    ref: Record<string, unknown>,
    argumentName: string,
    value: string,
    context?: Record<string, unknown>,
    baseUrl?: string
  ) => ipcRenderer.invoke('unity:completeArgument', ref, argumentName, value, context, baseUrl),
  createProvider: (input: AiProviderInput) => ipcRenderer.invoke('providers:create', input),
  updateProvider: (providerId: string, input: AiProviderInput) =>
    ipcRenderer.invoke('providers:update', providerId, input),
  deleteProvider: (providerId: string) => ipcRenderer.invoke('providers:delete', providerId),
  setDefaultProvider: (providerId: string) => ipcRenderer.invoke('providers:setDefault', providerId),
  listProviderModels: (input) => ipcRenderer.invoke('providers:listModels', input),
  testProvider: (providerId: string) => ipcRenderer.invoke('providers:test', providerId),
  runProviderDoctor: (providerId: string, input?: { projectId?: string; live?: boolean }) =>
    ipcRenderer.invoke('providers:doctor', providerId, input),
  repairProviderDiagnostic: (input: {
    actionId: string;
    providerId?: string;
    projectId?: string;
    sessionId?: string;
    authStyle?: AiProviderAuthStyle;
    url?: string;
  }) => ipcRenderer.invoke('providers:repair', input),
  exportRuntimeDiagnostics: (input?: { providerId?: string; projectId?: string; live?: boolean }) =>
    ipcRenderer.invoke('diagnostics:export', input)
};

contextBridge.exposeInMainWorld('funplay', api);
