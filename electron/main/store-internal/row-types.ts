import type {
  AgentRunKind,
  AgentPermissionMode,
  AgentRuntimeReportId,
  AgentRuntimeStatus,
  AgentTaskGraph,
  AgentVerificationReport,
  AiProvider,
  McpPlugin,
  RuntimeUsageTotals,
  Project
} from '../../../shared/types';

export interface SettingRow {
  value_json: string;
}

export interface ProviderStructuredRow {
  id: string;
  name: string;
  protocol: AiProvider['protocol'];
  api_mode: AiProvider['apiMode'] | null;
  auth_style: AiProvider['authStyle'] | null;
  base_url: string;
  model: string;
  upstream_model: string | null;
  headers_json: string | null;
  env_overrides_json: string | null;
  claude_code_compatible: number;
  claude_role_models_json: string | null;
  available_models_json: string | null;
  sdk_proxy_only: number;
  provider_meta_json: string | null;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
  request_timeout_ms: number | null;
  request_timeout_disabled: number;
  chunk_timeout_ms: number | null;
  enabled: number;
  is_default: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpPluginStructuredRow {
  id: string;
  project_id: string | null;
  name: string;
  kind: McpPlugin['kind'];
  transport: McpPlugin['transport'];
  base_url: string;
  command: string | null;
  args_json: string | null;
  cwd: string | null;
  env_json: string | null;
  default_tool_permission: McpPlugin['defaultToolPermission'] | null;
  default_tool_risk: McpPlugin['defaultToolRisk'] | null;
  tool_policies_json: string | null;
  enabled: number;
  is_default: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpToolSnapshotRow {
  plugin_id: string;
  original_name: string;
  plugin_name: string;
  exposed_name: string;
  description: string | null;
  schema_hash: string;
  schema_json: string;
  policy_summary: string | null;
  change_kind: 'added' | 'changed' | 'unchanged' | 'removed';
  discovered_at: string;
}

export interface McpRawAuditRow {
  id: string;
  plugin_id: string;
  plugin_name: string;
  method: string;
  status: 'success' | 'failed';
  duration_ms: number;
  params_size: number;
  response_size: number | null;
  error: string | null;
  created_at: string;
}

export interface ProjectStructuredRow {
  id: string;
  name: string;
  template_id: string;
  art_style: string;
  pitch: string;
  status: Project['status'];
  engine_json: string | null;
  runtime_state_json: string | null;
  agent_policy_json: string | null;
  provider_id: string | null;
  model: string | null;
  mcp_plugin_id: string | null;
  mcp_bindings_json: string | null;
  created_at: string;
  updated_at: string;
  blueprint_json: string;
  tasks_json: string;
  assets_json: string;
  activity_json: string;
  snapshots_json: string;
  memory_json: string;
  context_summary_json: string;
  current_execution_plan_json: string | null;
  last_executed_plan_json: string | null;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  auto_title: number;
  created_at: string;
  updated_at: string;
  runtime_json: string | null;
  is_active: number;
}

export interface MessageRow {
  storage_rowid?: number;
  id: string;
  project_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  content_blocks_json: string | null;
  created_at: string;
  metadata_json: string | null;
  sort_order: number;
}

export interface AgentRunRow {
  id: string;
  project_id: string;
  mode: 'bootstrap' | 'update' | 'execute-plan';
  input: string;
  status: 'completed' | 'fallback' | 'failed';
  used_provider_id: string | null;
  used_model: string | null;
  started_at: string;
  finished_at: string;
  steps_json: string;
  plugin_reports_json: string;
  execution_plan_json: string | null;
  operation_log_json: string | null;
}

export interface PermissionAuditRecord {
  requestId: string;
  projectId: string;
  sessionId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'allow' | 'allow_session' | 'deny' | 'timeout' | 'aborted';
  createdAt: string;
  resolvedAt?: string;
  resolutionJson?: string;
}

export interface RuntimeRunRow {
  id: string;
  kind: AgentRunKind;
  project_id: string;
  session_id: string | null;
  stream_id: string | null;
  status: AgentRuntimeStatus['status'];
  started_at: string;
  updated_at: string;
  status_message: string | null;
  checkpoint_snapshot_id: string | null;
  input_preview: string | null;
  request_json: string;
  last_error: string | null;
  resumed_from_run_id: string | null;
  timeline_json: string | null;
  last_tool_boundary_json: string | null;
  resume_strategy: string | null;
  task_graph_json: string | null;
  verification_json: string | null;
  usage_json: string | null;
  events_json: string | null;
}

export interface PersistedRuntimeRunRequest {
  kind: 'conversation' | 'execute-plan';
  projectId: string;
  sessionId?: string;
  runtimeId?: AgentRuntimeReportId;
  providerId?: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  message?: string;
  checkpointSnapshotId?: string;
  inputPreview?: string;
  resumeContext?: import('../../../shared/types').AgentRuntimeResumeContext;
  taskGraph?: AgentTaskGraph;
  verification?: AgentVerificationReport;
}

export interface PersistedRuntimeRunRecord extends AgentRuntimeStatus {
  request: PersistedRuntimeRunRequest;
}
