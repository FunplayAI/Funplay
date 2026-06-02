import type { Project, AgentRunKind, ProjectSessionRuntimeId, AgentOperationStatus } from './project';
import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  ChatMediaBlock,
  PromptAttachment
} from './chat';
import type { AgentToolTransactionSummary, RuntimeUsage, RuntimeUsageTotals } from './agent';
import type { AgentCoreMessagePart } from './agent-core';
import type { RuntimeDiagnosticSeverity, RuntimeRecoveryAction } from './diagnostics';

export type PromptStreamPhase = 'starting' | 'thinking' | 'streaming' | 'completed' | 'cancelled' | 'error';

export interface AgentUserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentUserInputResponse {
  answer: string;
  optionId?: string;
  optionIds?: string[];
  cancelled?: boolean;
}

export interface AgentPermissionImpact {
  toolName?: string;
  toolTitle?: string;
  permissionPolicy?: string;
  checkpointPolicy?: string;
  readOnly?: boolean;
  mcp?: {
    permissionKey?: string;
    pluginId?: string;
    pluginName?: string;
    toolName?: string;
    policySource?: string;
    permission?: string;
    risk?: string;
  };
  cwd?: string;
  paths?: string[];
  commands?: string[];
  reason?: string;
  inputSummary?: string[];
}

export interface PromptStreamHandle {
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  kind?: AgentRunKind;
  prompt?: string;
  attachments?: PromptAttachment[];
  resumedFromRunId?: string;
}

export interface PromptStreamStatusEvent {
  type: 'status';
  streamId: string;
  projectId: string;
  sessionId: string;
  phase: Exclude<PromptStreamPhase, 'completed' | 'cancelled' | 'error'>;
  message: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  doctorProbeId?: string;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  startedAt: string;
}

export interface PromptStreamDeltaEvent {
  type: 'delta';
  streamId: string;
  projectId: string;
  sessionId: string;
  delta: string;
  content: string;
  startedAt: string;
}

export interface PromptStreamThinkingEvent {
  type: 'thinking';
  streamId: string;
  projectId: string;
  sessionId: string;
  delta?: string;
  content: string;
  startedAt: string;
}

export interface PromptStreamToolUseEvent {
  type: 'tool_use';
  streamId: string;
  projectId: string;
  sessionId: string;
  toolUseId: string;
  name: string;
  title?: string;
  summary?: string;
  activity?: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
}

export interface PromptStreamToolResultEvent {
  type: 'tool_result';
  streamId: string;
  projectId: string;
  sessionId: string;
  toolUseId: string;
  content: string;
  isError?: boolean;
  media?: ChatMediaBlock[];
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
  transaction?: AgentToolTransactionSummary;
  startedAt: string;
}

export interface PromptStreamStageEvent {
  type: 'stage';
  streamId: string;
  projectId: string;
  sessionId: string;
  stageId: string;
  phase?: string;
  title: string;
  target: string;
  status: AgentOperationStatus;
  input?: Record<string, unknown>;
  summary?: string;
  errorMessage?: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  doctorProbeId?: string;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
  transaction?: AgentToolTransactionSummary;
  startedAt: string;
}

export interface PromptStreamContextCompressedEvent {
  type: 'context_compressed';
  streamId: string;
  projectId: string;
  sessionId: string;
  message: string;
  boundaryOrdinal?: number;
  coveredMessageCount?: number;
  startedAt: string;
}

export interface PromptStreamSessionBusyEvent {
  type: 'session_busy';
  streamId: string;
  projectId: string;
  sessionId: string;
  message: string;
  startedAt: string;
}

export interface PromptStreamToolTimeoutEvent {
  type: 'tool_timeout';
  streamId: string;
  projectId: string;
  sessionId: string;
  toolUseId?: string;
  toolName?: string;
  elapsedSeconds?: number;
  message: string;
  startedAt: string;
}

export interface PromptStreamPermissionRequestEvent {
  type: 'permission_request';
  streamId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  impact?: AgentPermissionImpact;
  startedAt: string;
}

export interface PromptStreamPermissionResolvedEvent {
  type: 'permission_resolved';
  streamId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  decision: 'allow' | 'allow_session' | 'deny';
  startedAt: string;
}

export interface PromptStreamUserInputRequestEvent {
  type: 'user_input_request';
  streamId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  title: string;
  question: string;
  detail?: string;
  options?: AgentUserInputOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  placeholder?: string;
  toolName?: string;
  startedAt: string;
}

export interface PromptStreamUserInputResolvedEvent {
  type: 'user_input_resolved';
  streamId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  response: AgentUserInputResponse;
  startedAt: string;
}

export interface PromptStreamCompleteEvent {
  type: 'completed';
  streamId: string;
  projectId: string;
  sessionId: string;
  project: Project;
  startedAt: string;
  finishedAt: string;
}

export interface PromptStreamCancelledEvent {
  type: 'cancelled';
  streamId: string;
  projectId: string;
  sessionId: string;
  /**
   * When an in-flight run is interrupted, the partial conversation turn (user
   * message + whatever the agent had streamed so far) is committed and carried
   * here so the renderer can persist it instead of losing the whole turn.
   * Absent when there was nothing to preserve.
   */
  project?: Project;
  startedAt: string;
  finishedAt: string;
}

export interface PromptStreamErrorEvent {
  type: 'error';
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  error: string;
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  upstreamModel?: string;
  diagnosticCode?: string;
  severity?: RuntimeDiagnosticSeverity;
  doctorProbeId?: string;
  errorCode?: string;
  suggestedAction?: string;
  recoveryActions?: RuntimeRecoveryAction[];
}

export interface PromptStreamUsageEvent {
  type: 'usage';
  streamId: string;
  projectId: string;
  sessionId: string;
  usage: RuntimeUsage;
  totals: RuntimeUsageTotals;
  startedAt: string;
}

export interface PromptStreamAgentCorePartsEvent {
  type: 'agent_core_parts';
  streamId: string;
  projectId: string;
  sessionId: string;
  parts: AgentCoreMessagePart[];
  startedAt: string;
}

export type PromptStreamEvent =
  | PromptStreamStatusEvent
  | PromptStreamDeltaEvent
  | PromptStreamThinkingEvent
  | PromptStreamToolUseEvent
  | PromptStreamToolResultEvent
  | PromptStreamStageEvent
  | PromptStreamContextCompressedEvent
  | PromptStreamSessionBusyEvent
  | PromptStreamToolTimeoutEvent
  | PromptStreamPermissionRequestEvent
  | PromptStreamPermissionResolvedEvent
  | PromptStreamUserInputRequestEvent
  | PromptStreamUserInputResolvedEvent
  | PromptStreamUsageEvent
  | PromptStreamAgentCorePartsEvent
  | PromptStreamCompleteEvent
  | PromptStreamCancelledEvent
  | PromptStreamErrorEvent;
