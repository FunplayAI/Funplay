import type {
  AgentUserInputOption,
  AiProvider,
  AiProviderAuthStyle,
  AiProviderRoleModels,
  ClaudeRuntimeWriteMode
} from '../../../../shared/types';

export type ClaudeRuntimePermissionDecision = 'allow' | 'deny' | 'not_needed';

export interface ClaudeRuntimeState {
  text: string;
  thinking: string;
  seenAssistantEvents: Set<string>;
  seenToolUses: Set<string>;
  seenToolResults: Set<string>;
  toolNamesByUseId: Map<string, string>;
}

export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown> | string;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
  data?: string;
  mimeType?: string;
  media_type?: string;
  localPath?: string;
  mediaId?: string;
  title?: string;
  source?: {
    type?: string;
    data?: string;
    media_type?: string;
    url?: string;
  };
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  uuid?: string;
  error?: string;
  message?: {
    id?: string;
    content?: ClaudeContentBlock[];
  };
}

export interface ClaudeUserEvent {
  type: 'user';
  uuid?: string;
  message?: {
    id?: string;
    content?: ClaudeContentBlock[] | string;
  };
}

export interface ClaudeStreamEvent {
  type: 'stream_event';
  event?: {
    type?: string;
    delta?: {
      text?: string;
      thinking?: string;
    };
  };
}

export interface ClaudeSystemEvent {
  type: 'system';
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
  mcp_servers?: unknown;
  output_style?: string;
  permissionMode?: string;
  status?: string;
  summary?: string;
  task_id?: string;
  description?: string;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error?: string;
  compact_metadata?: Record<string, unknown>;
}

export interface ClaudeToolProgressEvent {
  type: 'tool_progress';
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
  terminal_reason?: string;
  usage?: unknown;
}

export interface ClaudeShadowHome {
  home: string;
  isShadow: boolean;
  cleanup: () => void;
}

export interface ClaudeSdkSubprocessEnv {
  env: Record<string, string | undefined>;
  shadow: ClaudeShadowHome;
}

export type ClaudeRuntimeErrorCode =
  | 'claude_cli_missing'
  | 'claude_cli_version_unsupported'
  | 'claude_cli_install_conflict'
  | 'claude_git_bash_missing'
  | 'claude_auth_failed'
  | 'claude_auth_style_mismatch'
  | 'claude_base_url_invalid'
  | 'claude_model_invalid'
  | 'claude_rate_limited'
  | 'claude_provider_invalid'
  | 'claude_provider_env_polluted'
  | 'claude_stale_session'
  | 'claude_context_too_long'
  | 'claude_tool_timeout'
  | 'claude_permission_rejected'
  | 'claude_unsupported_feature'
  | 'claude_empty_response'
  | 'claude_runtime_error';

export interface ClaudeRuntimeDiagnostic {
  code: ClaudeRuntimeErrorCode;
  summary: string;
  suggestedAction: string;
  recoveryActions?: Array<{
    label: string;
    url?: string;
    command?: string;
  }>;
}

export interface ResolvedClaudeCodeProvider {
  provider?: AiProvider;
  providerId?: string;
  providerName?: string;
  protocol?: AiProvider['protocol'];
  authStyle: AiProviderAuthStyle | 'none';
  hasCredentials: boolean;
  canUseClaudeCode: boolean;
  injectAnthropicEnv: boolean;
  useShadowHome: boolean;
  baseUrl?: string;
  model?: string;
  upstreamModel?: string;
  roleModels: AiProviderRoleModels;
  settingSources: Array<'user' | 'project' | 'local'>;
  sdkProxyOnly?: boolean;
  diagnostic: {
    providerId?: string;
    providerName?: string;
    protocol?: AiProvider['protocol'];
    authStyle?: AiProviderAuthStyle | 'none';
    baseUrl?: string;
    model?: string;
    upstreamModel?: string;
    hasApiKey: boolean;
    claudeCodeCompatible: boolean;
    sdkProxyOnly?: boolean;
  };
}

export interface ClaudeSdkProviderProbeResult {
  ok: true;
  runtimeId: 'claude-code-sdk';
  providerId?: string;
  providerProtocol?: AiProvider['protocol'];
  baseUrl?: string;
  model?: string;
  executablePath?: string;
  executableSource?: ClaudeCodeExecutableSource;
  responsePreview: string;
  durationMs: number;
}

export type ClaudeCodeExecutableSource = 'env' | 'path' | 'sdk-bundled' | 'fallback';

export interface ClaudeCodeExecutableCandidate {
  path: string;
  source: ClaudeCodeExecutableSource;
  sdkExecutablePath?: string;
  exists?: boolean;
}

export interface ClaudeCodeExecutableResolution {
  command: string;
  source: ClaudeCodeExecutableSource;
  sdkExecutablePath?: string;
  diagnostics: string[];
}

export interface ClaudeMcpProfile {
  includeWeb: boolean;
  includeMemory: boolean;
  includeMedia: boolean;
  includeImageGeneration: boolean;
  includeNotifications: boolean;
  includeWorkspaceWrite: boolean;
  writeMode: ClaudeRuntimeWriteMode;
  builtinAllowedTools: string[];
  diagnosticReason: string;
}

export interface ClaudeAskUserQuestion {
  question: string;
  header?: string;
  options: AgentUserInputOption[];
  multiSelect?: boolean;
}

export interface ExternalWriteBaselineEntry {
  existed: boolean;
  content?: string;
  rollbackSupported: boolean;
  reason?: string;
}

export interface ExternalWriteBaseline {
  files: Map<string, ExternalWriteBaselineEntry>;
  skippedFiles: string[];
  totalBytes: number;
}

export type ClaudeSdkPromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
