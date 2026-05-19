import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult
} from './chat';
import type { AgentToolTransactionSummary, RuntimeUsage } from './agent';

export type AgentCoreState =
  | 'initializing'
  | 'loading_context'
  | 'building_model_input'
  | 'streaming_model_step'
  | 'collecting_tool_calls'
  | 'awaiting_permission'
  | 'executing_tools'
  | 'awaiting_user_input'
  | 'recording_tool_results'
  | 'continuing_after_tools'
  | 'compacting_context'
  | 'verifying_work'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted_resumable';

export type AgentCorePartKind =
  | 'assistant_text'
  | 'assistant_thinking'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'permission_request'
  | 'user_input_request'
  | 'todo_update'
  | 'context_summary'
  | 'usage'
  | 'system_event'
  | 'run_error';

export interface AgentCorePartBase {
  id: string;
  kind: AgentCorePartKind;
  createdAt: string;
  runId?: string;
  turnId?: string;
  sequence: number;
}

export interface AgentCoreAssistantTextPart extends AgentCorePartBase {
  kind: 'assistant_text';
  text: string;
  final?: boolean;
}

export interface AgentCoreAssistantThinkingPart extends AgentCorePartBase {
  kind: 'assistant_thinking';
  thinking: string;
  title?: string;
}

export interface AgentCoreToolCallPart extends AgentCorePartBase {
  kind: 'tool_call';
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  providerCallId?: string;
}

export interface AgentCoreToolResultPart extends AgentCorePartBase {
  kind: 'tool_result';
  toolUseId: string;
  toolName?: string;
  content: string;
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
  transaction?: AgentToolTransactionSummary;
}

export interface AgentCoreToolErrorPart extends AgentCorePartBase {
  kind: 'tool_error';
  toolUseId: string;
  toolName?: string;
  error: string;
  failureKind?: string;
  recoveryHint?: string;
  changedFiles?: AgentToolChangedFile[];
  command?: AgentToolCommandResult;
  terminal?: AgentToolTerminalResult;
  browser?: AgentToolBrowserResult;
  edit?: AgentToolEditMetrics;
  mcp?: AgentToolMcpResult;
  artifacts?: AgentToolArtifact[];
  transaction?: AgentToolTransactionSummary;
}

export interface AgentCorePermissionRequestPart extends AgentCorePartBase {
  kind: 'permission_request';
  requestId: string;
  toolName: string;
  risk: 'low' | 'medium' | 'high';
  reason?: string;
  impact?: Record<string, unknown>;
}

export interface AgentCoreUserInputRequestPart extends AgentCorePartBase {
  kind: 'user_input_request';
  requestId: string;
  question: string;
  options?: Array<{
    id: string;
    label: string;
  }>;
}

export interface AgentCoreTodoUpdatePart extends AgentCorePartBase {
  kind: 'todo_update';
  items: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
}

export interface AgentCoreContextSummaryPart extends AgentCorePartBase {
  kind: 'context_summary';
  summary: string;
  structured?: {
    goal?: string;
    completedWork?: string[];
    unfinishedWork?: string[];
    changedFiles?: string[];
    decisions?: string[];
    constraints?: string[];
    failedTools?: string[];
    nextStep?: string;
  };
  coverage?: Record<string, unknown>;
}

export interface AgentCoreUsagePart extends AgentCorePartBase {
  kind: 'usage';
  usage: RuntimeUsage;
}

export interface AgentCoreSystemEventPart extends AgentCorePartBase {
  kind: 'system_event';
  state?: AgentCoreState;
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCoreRunErrorPart extends AgentCorePartBase {
  kind: 'run_error';
  error: string;
  recoverable: boolean;
  diagnosticCode?: string;
}

export type AgentCoreMessagePart =
  | AgentCoreAssistantTextPart
  | AgentCoreAssistantThinkingPart
  | AgentCoreToolCallPart
  | AgentCoreToolResultPart
  | AgentCoreToolErrorPart
  | AgentCorePermissionRequestPart
  | AgentCoreUserInputRequestPart
  | AgentCoreTodoUpdatePart
  | AgentCoreContextSummaryPart
  | AgentCoreUsagePart
  | AgentCoreSystemEventPart
  | AgentCoreRunErrorPart;

export type AgentCoreProviderFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'error'
  | 'unknown';

export interface AgentCoreProviderToolCall {
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  providerCallId?: string;
}

export interface AgentCoreProviderStepResult {
  text?: string;
  thinking?: string;
  toolCalls: AgentCoreProviderToolCall[];
  finishReason: AgentCoreProviderFinishReason;
  usage?: RuntimeUsage;
  warnings?: string[];
  rawMetadata?: Record<string, unknown>;
}

export type AgentCoreLoopOutcome =
  | 'continue_after_tools'
  | 'pause_for_permission'
  | 'pause_for_user_input'
  | 'compact_context'
  | 'verify_work'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'interrupt_resumable';

export interface AgentCoreLoopDecisionInput {
  providerFinishReason: AgentCoreProviderFinishReason;
  toolCallCount: number;
  hasFinalText: boolean;
  hasPendingPermission: boolean;
  hasPendingUserInput: boolean;
  shouldCompact: boolean;
  shouldVerify: boolean;
  cancelled: boolean;
  interrupted: boolean;
  error?: string;
}

export interface AgentCoreLoopDecision {
  outcome: AgentCoreLoopOutcome;
  nextState: AgentCoreState;
  terminal: boolean;
  reason: string;
}

export interface AgentCorePartConversionOptions {
  runId?: string;
  turnId?: string;
  startingSequence?: number;
  createdAt?: string;
}

export interface AgentCoreStateTransitionRecord {
  from: AgentCoreState;
  to: AgentCoreState;
  reason: string;
  createdAt: string;
}

export interface AgentCoreStateMachineSnapshot {
  state: AgentCoreState;
  history: AgentCoreStateTransitionRecord[];
}
