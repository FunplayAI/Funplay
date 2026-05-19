import type {
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolCommandResult,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTerminalResult,
  AgentToolTransactionSummary,
  ChatMediaBlock
} from '../../../shared/types';
import type { AgentToolCheckpointPolicy, AgentToolPermissionPolicy, AgentToolRisk } from './tool-registry-core';

export type ToolExecutorToolClass =
  | 'workspace'
  | 'command'
  | 'terminal'
  | 'browser'
  | 'mcp'
  | 'media'
  | 'memory'
  | 'user_input'
  | 'subagent'
  | 'checkpoint'
  | 'custom';

export type ToolExecutorTransactionPhase =
  | 'created'
  | 'validating'
  | 'awaiting_permission'
  | 'checkpointing'
  | 'executing'
  | 'recording_result'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type ToolExecutorTransactionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ToolExecutorTransactionEventType =
  | 'created'
  | 'validation_passed'
  | 'validation_failed'
  | 'permission_requested'
  | 'permission_allowed'
  | 'permission_denied'
  | 'checkpoint_started'
  | 'checkpoint_completed'
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed'
  | 'execution_timed_out'
  | 'cancelled';

export interface ToolExecutorTransactionResult {
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
}

export type ToolExecutorTransactionResultLike = Omit<ToolExecutorTransactionResult, 'content'> & {
  content?: string;
  summary?: string;
};

export interface ToolExecutorTransactionError {
  message: string;
  code?: string;
  failureKind?: string;
  recoveryHint?: string;
  retryable?: boolean;
}

export interface ToolExecutorPermissionSnapshot {
  policy: AgentToolPermissionPolicy;
  risk: AgentToolRisk;
  decision?: 'allow' | 'allow_session' | 'deny';
  requestId?: string;
  reason?: string;
}

export interface ToolExecutorCheckpointSnapshot {
  policy: AgentToolCheckpointPolicy;
  snapshotId?: string;
  status?: 'not_applicable' | 'pending' | 'completed' | 'failed';
  error?: string;
}

export interface ToolExecutorTransactionEvent {
  id: string;
  type: ToolExecutorTransactionEventType;
  phase: ToolExecutorTransactionPhase;
  status: ToolExecutorTransactionStatus;
  createdAt: string;
  summary?: string;
  error?: ToolExecutorTransactionError;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutorTransaction {
  id: string;
  runId?: string;
  turnId?: string;
  toolUseId: string;
  providerCallId?: string;
  toolName: string;
  toolClass: ToolExecutorToolClass;
  input?: Record<string, unknown>;
  status: ToolExecutorTransactionStatus;
  phase: ToolExecutorTransactionPhase;
  createdAt: string;
  updatedAt: string;
  timeoutMs?: number;
  permission?: ToolExecutorPermissionSnapshot;
  checkpoint?: ToolExecutorCheckpointSnapshot;
  result?: ToolExecutorTransactionResult;
  error?: ToolExecutorTransactionError;
  events: ToolExecutorTransactionEvent[];
}

export interface CreateToolExecutorTransactionInput {
  id?: string;
  runId?: string;
  turnId?: string;
  toolUseId: string;
  providerCallId?: string;
  toolName: string;
  toolClass: ToolExecutorToolClass;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  permission?: ToolExecutorPermissionSnapshot;
  checkpoint?: ToolExecutorCheckpointSnapshot;
  createdAt?: string;
}

export interface AdvanceToolExecutorTransactionInput {
  phase: ToolExecutorTransactionPhase;
  status?: ToolExecutorTransactionStatus;
  eventType: ToolExecutorTransactionEventType;
  summary?: string;
  error?: ToolExecutorTransactionError;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function transactionEventId(transaction: ToolExecutorTransaction, eventType: ToolExecutorTransactionEventType): string {
  return `${transaction.id}:${transaction.events.length}:${eventType}`;
}

function createTransactionEvent(
  transaction: ToolExecutorTransaction,
  input: Required<Pick<AdvanceToolExecutorTransactionInput, 'phase' | 'eventType'>> & Omit<AdvanceToolExecutorTransactionInput, 'phase' | 'eventType'>,
  status: ToolExecutorTransactionStatus,
  createdAt: string
): ToolExecutorTransactionEvent {
  return {
    id: transactionEventId(transaction, input.eventType),
    type: input.eventType,
    phase: input.phase,
    status,
    createdAt,
    summary: input.summary,
    error: input.error,
    metadata: input.metadata
  };
}

export function createToolExecutorTransaction(input: CreateToolExecutorTransactionInput): ToolExecutorTransaction {
  const createdAt = input.createdAt ?? nowIso();
  const transaction: ToolExecutorTransaction = {
    id: input.id ?? `tool_txn:${input.toolUseId}`,
    runId: input.runId,
    turnId: input.turnId,
    toolUseId: input.toolUseId,
    providerCallId: input.providerCallId,
    toolName: input.toolName,
    toolClass: input.toolClass,
    input: input.input,
    status: 'pending',
    phase: 'created',
    createdAt,
    updatedAt: createdAt,
    timeoutMs: input.timeoutMs,
    permission: input.permission,
    checkpoint: input.checkpoint,
    events: []
  };
  return {
    ...transaction,
    events: [createTransactionEvent(transaction, {
      phase: 'created',
      eventType: 'created',
      summary: `${input.toolName} transaction created.`
    }, 'pending', createdAt)]
  };
}

export function advanceToolExecutorTransaction(
  transaction: ToolExecutorTransaction,
  input: AdvanceToolExecutorTransactionInput
): ToolExecutorTransaction {
  const createdAt = input.createdAt ?? nowIso();
  const status = input.status ?? (input.phase === 'completed'
    ? 'completed'
    : input.phase === 'failed' || input.phase === 'timed_out'
      ? 'failed'
      : input.phase === 'cancelled'
        ? 'cancelled'
        : 'running');
  const next: ToolExecutorTransaction = {
    ...transaction,
    status,
    phase: input.phase,
    updatedAt: createdAt,
    error: input.error ?? transaction.error
  };
  return {
    ...next,
    events: [
      ...transaction.events,
      createTransactionEvent(next, input, status, createdAt)
    ]
  };
}

export function completeToolExecutorTransaction(
  transaction: ToolExecutorTransaction,
  result: ToolExecutorTransactionResult,
  options: {
    createdAt?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  } = {}
): ToolExecutorTransaction {
  const createdAt = options.createdAt ?? nowIso();
  const status: ToolExecutorTransactionStatus = result.isError ? 'failed' : 'completed';
  const phase: ToolExecutorTransactionPhase = result.isError ? 'failed' : 'completed';
  const eventType: ToolExecutorTransactionEventType = result.isError ? 'execution_failed' : 'execution_completed';
  const error: ToolExecutorTransactionError | undefined = result.isError
    ? {
        message: result.content,
        failureKind: result.edit?.failureKind ?? result.mcp?.failureKind,
        recoveryHint: result.edit?.recoveryHint
      }
    : undefined;
  const next: ToolExecutorTransaction = {
    ...transaction,
    status,
    phase,
    result,
    error,
    updatedAt: createdAt
  };
  return {
    ...next,
    events: [
      ...transaction.events,
      createTransactionEvent(next, {
        phase,
        eventType,
        summary: options.summary ?? result.content,
        error,
        metadata: options.metadata
      }, status, createdAt)
    ]
  };
}

export function normalizeToolExecutorTransactionResult(input: ToolExecutorTransactionResultLike): ToolExecutorTransactionResult {
  return {
    content: input.content ?? input.summary ?? '',
    isError: input.isError,
    media: input.media,
    changedFiles: input.changedFiles,
    command: input.command,
    terminal: input.terminal,
    browser: input.browser,
    edit: input.edit,
    mcp: input.mcp,
    artifacts: input.artifacts
  };
}

export function failToolExecutorTransaction(
  transaction: ToolExecutorTransaction,
  error: ToolExecutorTransactionError,
  options: {
    createdAt?: string;
    timedOut?: boolean;
    metadata?: Record<string, unknown>;
  } = {}
): ToolExecutorTransaction {
  const createdAt = options.createdAt ?? nowIso();
  const phase: ToolExecutorTransactionPhase = options.timedOut ? 'timed_out' : 'failed';
  const eventType: ToolExecutorTransactionEventType = options.timedOut ? 'execution_timed_out' : 'execution_failed';
  const result: ToolExecutorTransactionResult = {
    content: error.message,
    isError: true
  };
  const next: ToolExecutorTransaction = {
    ...transaction,
    status: 'failed',
    phase,
    result,
    error,
    updatedAt: createdAt
  };
  return {
    ...next,
    events: [
      ...transaction.events,
      createTransactionEvent(next, {
        phase,
        eventType,
        summary: error.message,
        error,
        metadata: options.metadata
      }, 'failed', createdAt)
    ]
  };
}

export function cancelToolExecutorTransaction(
  transaction: ToolExecutorTransaction,
  options: {
    createdAt?: string;
    reason?: string;
  } = {}
): ToolExecutorTransaction {
  const error = options.reason ? { message: options.reason } : transaction.error;
  return advanceToolExecutorTransaction(transaction, {
    phase: 'cancelled',
    status: 'cancelled',
    eventType: 'cancelled',
    summary: options.reason ?? 'Tool transaction cancelled.',
    error,
    createdAt: options.createdAt
  });
}

export function toolExecutorTransactionToAgentCorePart(
  transaction: ToolExecutorTransaction,
  sequence: number
): AgentCoreMessagePart {
  const transactionSummary = createToolExecutorTransactionSummary(transaction);
  if (transaction.status === 'completed' && transaction.result) {
    return {
      id: `tool_result:${transaction.toolUseId}`,
      kind: 'tool_result',
      runId: transaction.runId,
      turnId: transaction.turnId,
      createdAt: transaction.updatedAt,
      sequence,
      toolUseId: transaction.toolUseId,
      toolName: transaction.toolName,
      content: transaction.result.content,
      changedFiles: transaction.result.changedFiles,
      command: transaction.result.command,
      terminal: transaction.result.terminal,
      browser: transaction.result.browser,
      edit: transaction.result.edit,
      mcp: transaction.result.mcp,
      artifacts: transaction.result.artifacts,
      transaction: transactionSummary
    };
  }

  if ((transaction.status === 'failed' || transaction.status === 'cancelled') && (transaction.error || transaction.result)) {
    return {
      id: `tool_error:${transaction.toolUseId}`,
      kind: 'tool_error',
      runId: transaction.runId,
      turnId: transaction.turnId,
      createdAt: transaction.updatedAt,
      sequence,
      toolUseId: transaction.toolUseId,
      toolName: transaction.toolName,
      error: transaction.error?.message ?? transaction.result?.content ?? 'Tool execution failed.',
      failureKind: transaction.error?.failureKind,
      recoveryHint: transaction.error?.recoveryHint,
      changedFiles: transaction.result?.changedFiles,
      command: transaction.result?.command,
      terminal: transaction.result?.terminal,
      browser: transaction.result?.browser,
      edit: transaction.result?.edit,
      mcp: transaction.result?.mcp,
      artifacts: transaction.result?.artifacts,
      transaction: transactionSummary
    };
  }

  return {
    id: `tool_call:${transaction.toolUseId}`,
    kind: 'tool_call',
    runId: transaction.runId,
    turnId: transaction.turnId,
    createdAt: transaction.createdAt,
    sequence,
    toolUseId: transaction.toolUseId,
    providerCallId: transaction.providerCallId,
    name: transaction.toolName,
    input: transaction.input,
    status: transaction.status === 'pending' ? 'pending' : 'running'
  };
}

export function createToolExecutorTransactionSummary(transaction: ToolExecutorTransaction): AgentToolTransactionSummary {
  return {
    id: transaction.id,
    toolUseId: transaction.toolUseId,
    providerCallId: transaction.providerCallId,
    toolName: transaction.toolName,
    toolClass: transaction.toolClass,
    phase: transaction.phase,
    status: transaction.status,
    eventCount: transaction.events.length,
    startedAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    timeoutMs: transaction.timeoutMs,
    permission: transaction.permission
      ? {
          policy: transaction.permission.policy,
          risk: transaction.permission.risk,
          decision: transaction.permission.decision,
          requestId: transaction.permission.requestId
        }
      : undefined,
    checkpoint: transaction.checkpoint
      ? {
          policy: transaction.checkpoint.policy,
          snapshotId: transaction.checkpoint.snapshotId,
          status: transaction.checkpoint.status
        }
      : undefined
  };
}

export function summarizeToolExecutorTransaction(transaction: ToolExecutorTransaction): string {
  const resultText = transaction.result?.content || transaction.error?.message;
  return [
    `${transaction.toolClass}:${transaction.toolName}`,
    `status=${transaction.status}`,
    `phase=${transaction.phase}`,
    transaction.permission ? `permission=${transaction.permission.policy}${transaction.permission.decision ? `/${transaction.permission.decision}` : ''}` : '',
    transaction.checkpoint ? `checkpoint=${transaction.checkpoint.policy}${transaction.checkpoint.status ? `/${transaction.checkpoint.status}` : ''}` : '',
    resultText ? `result=${resultText}` : ''
  ].filter(Boolean).join(' · ');
}
