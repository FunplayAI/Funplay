export type UnityProfile = 'core' | 'full';
export type UnityHealthStatus = 'idle' | 'online' | 'offline';
export type UnityReleaseChannel = 'stable' | 'patch' | 'beta' | 'alpha' | 'unknown';
export type PlatformChoice = 'web' | 'unity' | 'cocos' | 'godot' | 'unreal';
export type ProjectSetupMode = 'create' | 'import';
export type EngineProjectDimension = '2d' | '3d' | 'unknown';
export type UnityMcpContentType = 'text' | 'image';
export type McpPluginKind = 'engine' | 'asset' | 'qa' | 'custom';
export type McpTransport = 'http' | 'stdio' | 'streamable-http' | 'sse';
export type McpConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline';
export type McpProcessStatus = 'not_started' | 'running' | 'stopped' | 'exited';
export type McpToolPermissionPolicy = 'infer' | 'allow' | 'ask' | 'deny';
export type McpToolRiskPolicy = 'infer' | 'read' | 'write';
export type EnvironmentCheckStatus = 'passed' | 'warning' | 'failed' | 'pending';
export type EnvironmentActionKind =
  | 'install_unity_hub'
  | 'open_unity_hub'
  | 'select_unity_hub'
  | 'install_unity_editor'
  | 'create_unity_project'
  | 'import_unity_project'
  | 'open_unity_project'
  | 'install_project_bridge'
  | 'install_cocos_dashboard'
  | 'open_cocos_dashboard'
  | 'create_cocos_project'
  | 'open_cocos_project'
  | 'install_cocos_bridge'
  | 'verify_project_path';
export type EnvironmentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'needs_user';
export type EnvironmentTaskStage =
  | 'queued'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'waiting_login'
  | 'waiting_manual'
  | 'validating'
  | 'completed'
  | 'failed';

export interface UnityMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface UnityMcpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface UnityMcpResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
}

export interface UnityMcpContentPart {
  type: UnityMcpContentType;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface UnityMcpCallResult {
  content: UnityMcpContentPart[];
  raw: unknown;
}

export interface UnityMcpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: UnityMcpPromptArgument[];
}

export interface UnityMcpPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface UnityMcpPromptMessage {
  role: string;
  content: UnityMcpContentPart;
}

export interface UnityMcpPromptResult {
  description?: string;
  messages: UnityMcpPromptMessage[];
  raw: unknown;
}

export interface UnityMcpCompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
  raw: unknown;
}

export interface UnityMcpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface McpConnectionSnapshot {
  baseUrl: string;
  transport: McpTransport;
  status: McpConnectionStatus;
  serverInfo?: UnityMcpServerInfo;
  lastCheckedAt?: string;
  lastConnectedAt?: string;
  lastError?: string;
  initializeCount: number;
  processStatus?: McpProcessStatus;
  pid?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  stderrTail?: string[];
}

export interface UnityMcpJsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

export interface McpPlugin {
  id: string;
  projectId?: string;
  name: string;
  kind: McpPluginKind;
  transport: McpTransport;
  baseUrl: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultToolPermission?: McpToolPermissionPolicy;
  defaultToolRisk?: McpToolRiskPolicy;
  toolPolicies?: Record<string, McpToolPolicyOverride>;
  enabled: boolean;
  isDefault: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpPluginBindings {
  servers?: string[];
  engine?: string;
  asset?: string;
  qa?: string;
  custom?: string;
}

export interface McpPluginInput {
  name: string;
  projectId?: string;
  kind: McpPluginKind;
  transport: McpTransport;
  baseUrl: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultToolPermission?: McpToolPermissionPolicy;
  defaultToolRisk?: McpToolRiskPolicy;
  toolPolicies?: Record<string, McpToolPolicyOverride>;
  enabled?: boolean;
  notes?: string;
}

export interface McpToolPolicyOverride {
  permission?: McpToolPermissionPolicy;
  risk?: McpToolRiskPolicy;
  notes?: string;
}

export type McpToolSnapshotChangeKind = 'added' | 'changed' | 'unchanged' | 'removed';

export interface McpToolSnapshot {
  pluginId: string;
  pluginName: string;
  originalName: string;
  exposedName: string;
  description?: string;
  schemaHash: string;
  schemaJson: string;
  policySummary?: string;
  changeKind: McpToolSnapshotChangeKind;
  discoveredAt: string;
}

export interface McpRawRequestResult {
  method: string;
  pluginId?: string;
  status?: 'success' | 'failed';
  durationMs: number;
  paramsSize: number;
  responseSize: number;
  truncated: boolean;
  result?: unknown;
  resultPreview?: string;
  error?: string;
}

export interface McpRawAuditEntry {
  id: string;
  pluginId: string;
  pluginName: string;
  method: string;
  status: 'success' | 'failed';
  durationMs: number;
  paramsSize: number;
  responseSize?: number;
  error?: string;
  createdAt: string;
}

export interface McpPluginPreset {
  id: string;
  name: string;
  kind: McpPluginKind;
  transport: McpTransport;
  baseUrl: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  description: string;
}

export interface McpSettings {
  activeEnginePluginId?: string;
  activePluginIds?: McpPluginBindings;
}

export interface UnitySettings {
  baseUrl: string;
  profile: UnityProfile;
  lastCheckedAt?: string;
  lastStatus: UnityHealthStatus;
  lastMessage?: string;
  lastCreatedProjectDirectory?: string;
  lastAssignedMcpPort?: number;
  unityHubPath?: string;
}

export interface UnityHealthResult {
  status: Exclude<UnityHealthStatus, 'idle'>;
  checkedAt: string;
  message: string;
  url: string;
  projectPath?: string;
}

export interface InstalledUnityEditorOption {
  version: string;
  displayName: string;
  releaseChannel: UnityReleaseChannel;
  supports2dUrp: boolean;
  supports3dUrp: boolean;
  recommended: boolean;
  compatible: boolean;
  reason: string;
}

export interface EnvironmentAction {
  id: EnvironmentActionKind;
  label: string;
  description: string;
  primary?: boolean;
}

export interface EnvironmentCheck {
  id: string;
  title: string;
  description: string;
  status: EnvironmentCheckStatus;
  detail: string;
  actions: EnvironmentAction[];
}

export interface EnvironmentDiagnostics {
  platform: PlatformChoice;
  mode: ProjectSetupMode;
  dimension: EngineProjectDimension;
  checkedAt: string;
  projectPath: string;
  enginePluginId?: string;
  selectedUnityVersion?: string;
  availableUnityEditors?: InstalledUnityEditorOption[];
  checks: EnvironmentCheck[];
  ready: boolean;
}

export interface EnvironmentActionResult {
  actionId: EnvironmentActionKind;
  status: 'completed' | 'opened' | 'failed';
  message: string;
  taskId?: string;
}

export interface EnvironmentTask {
  id: string;
  actionId: EnvironmentActionKind;
  title: string;
  status: EnvironmentTaskStatus;
  stage: EnvironmentTaskStage;
  progress: number;
  message: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FolderPickerResult {
  canceled: boolean;
  path?: string;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {};
