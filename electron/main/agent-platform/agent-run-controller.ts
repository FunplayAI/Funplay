import {
  canTransitionAgentCoreState,
  createAgentCoreStateMachine,
  decideAgentCoreLoopOutcome
} from '../../../shared/agent-core-v2';
import type {
  AgentCoreLoopDecision,
  AgentCoreLoopOutcome,
  AgentCoreMessagePart,
  AgentCoreProviderStepResult,
  AgentCoreStateMachineSnapshot,
  AgentCoreToolErrorPart,
  AgentCoreToolResultPart
} from '../../../shared/types';

export type AgentRunControllerAction =
  | 'build_model_input'
  | 'execute_tools'
  | 'request_permission'
  | 'request_user_input'
  | 'compact_context'
  | 'verify_work'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'interrupt_resumable';

export interface AgentRunControllerOptions {
  runId?: string;
  turnId?: string;
  createdAt?: () => string;
}

export interface AgentRunControllerProviderStepInput {
  providerStep: AgentCoreProviderStepResult;
  forceContinuation?: {
    reason: AgentRunControllerContinuationReason;
    detail?: string;
  };
  continuation?: AgentRunControllerContinuationContext;
  pendingPermission?: {
    requestId: string;
    toolName: string;
    risk: 'low' | 'medium' | 'high';
    reason?: string;
    impact?: Record<string, unknown>;
  };
  hasPendingPermission?: boolean;
  hasPendingUserInput?: boolean;
  shouldCompact?: boolean;
  shouldVerify?: boolean;
  cancelled?: boolean;
  interrupted?: boolean;
  error?: string;
}

export type AgentRunControllerContinuationReason =
  | 'partial_write'
  | 'incomplete_todo'
  | 'edit_recovery'
  | 'host_policy'
  | 'length';

export interface AgentRunControllerContinuation {
  reason: AgentRunControllerContinuationReason;
  detail?: string;
}

export interface AgentRunControllerContinuationContext {
  includeWriteTools?: boolean;
  permissionMode?: string;
  assistantMessage?: string;
  incompleteTodo?: {
    incompleteCount: number;
    hasInProgress?: boolean;
  };
  partialWrite?: {
    continuationCount: number;
    continuationLimit: number;
  };
}

export interface AgentRunControllerToolResultInput {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  failureKind?: string;
  recoveryHint?: string;
  changedFiles?: AgentCoreToolResultPart['changedFiles'];
  command?: AgentCoreToolResultPart['command'];
  terminal?: AgentCoreToolResultPart['terminal'];
  browser?: AgentCoreToolResultPart['browser'];
  edit?: AgentCoreToolResultPart['edit'];
  mcp?: AgentCoreToolResultPart['mcp'];
  artifacts?: AgentCoreToolResultPart['artifacts'];
  transaction?: AgentCoreToolResultPart['transaction'];
}

export interface AgentRunControllerPermissionDeniedInput {
  toolUseId: string;
  toolName?: string;
  content?: string;
  recoveryHint?: string;
  transaction?: AgentCoreToolResultPart['transaction'];
}

export interface AgentRunControllerPermissionApprovedInput {
  toolUseId: string;
  toolName?: string;
  content?: string;
  transaction?: AgentCoreToolResultPart['transaction'];
}

export interface AgentRunControllerInterruptionInput {
  reason?: string;
  recoveryHint?: string;
}

export interface AgentRunControllerContextSummaryInput {
  summary: string;
  structured?: Extract<AgentCoreMessagePart, { kind: 'context_summary' }>['structured'];
  coverage?: Record<string, unknown>;
}

export interface AgentRunControllerSnapshot {
  coreState: AgentCoreStateMachineSnapshot;
  parts: AgentCoreMessagePart[];
  nextAction: AgentRunControllerAction;
  lastDecision?: AgentCoreLoopDecision;
  lastContinuation?: AgentRunControllerContinuation;
  providerStepCount: number;
  pendingToolUseIds: string[];
  completedToolUseIds: string[];
}

function containsFileReference(value: string): boolean {
  return /(?:^|[\s"'`（(：:])[\w@./\\-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt|yml|yaml|xml|svg|py|cs|java|go|rs|sh|sql|vue|svelte)(?:$|[\s"'`，,。.!！?？）)；;:：])/i.test(value);
}

function looksLikeUnfinishedWriteReply(value: string): boolean {
  const normalized = value.trim();
  if (!containsFileReference(normalized)) {
    return false;
  }
  return /(现在|接下来|继续|马上|下一步|最后|再来|还要|还需要|开始)(?:[\s\S]{0,40})(写|创建|生成|实现|补上)|(?:now|next|then|continue|will|going to)(?:[\s\S]{0,40})(write|create|implement|add)/i.test(normalized);
}

function isLengthLimitedProviderFinishReason(finishReason?: string): boolean {
  return /^(length|max_tokens|max_output_tokens)$/i.test(finishReason?.trim() ?? '');
}

function resolveControllerContinuation(input: AgentRunControllerProviderStepInput): AgentRunControllerContinuation | undefined {
  if (input.forceContinuation) {
    return input.forceContinuation;
  }
  if (input.providerStep.toolCalls.length > 0) {
    return undefined;
  }
  const continuation = input.continuation;
  const includeWriteTools = Boolean(continuation?.includeWriteTools);
  const permissionMode = continuation?.permissionMode;
  const assistantMessage = continuation?.assistantMessage ?? input.providerStep.text ?? '';
  if (includeWriteTools && permissionMode !== 'read-only') {
    const incompleteCount = continuation?.incompleteTodo?.incompleteCount ?? 0;
    if (
      incompleteCount > 0 &&
      (
        !assistantMessage.trim() ||
        Boolean(continuation?.incompleteTodo?.hasInProgress) ||
        looksLikeUnfinishedWriteReply(assistantMessage) ||
        /还没|未完成|继续|马上|下一步|pending|in_progress|not done|continue|next/i.test(assistantMessage)
      )
    ) {
      return {
        reason: 'incomplete_todo',
        detail: 'Todo snapshot still has pending or in-progress items.'
      };
    }
    const partialWriteCount = continuation?.partialWrite?.continuationCount ?? 0;
    const partialWriteLimit = continuation?.partialWrite?.continuationLimit ?? 0;
    if (partialWriteCount < partialWriteLimit && looksLikeUnfinishedWriteReply(assistantMessage)) {
      return {
        reason: 'partial_write',
        detail: 'Assistant text looked like an unfinished file-writing promise.'
      };
    }
  }
  return undefined;
}

function controllerActionFromDecision(decision: AgentCoreLoopDecision): AgentRunControllerAction {
  switch (decision.outcome) {
    case 'continue_after_tools':
      return decision.nextState === 'building_model_input' ? 'build_model_input' : 'execute_tools';
    case 'pause_for_permission':
      return 'request_permission';
    case 'pause_for_user_input':
      return 'request_user_input';
    case 'compact_context':
      return 'compact_context';
    case 'verify_work':
      return 'verify_work';
    case 'complete':
      return 'complete';
    case 'fail':
      return 'fail';
    case 'cancel':
      return 'cancel';
    case 'interrupt_resumable':
      return 'interrupt_resumable';
  }
}

function createPartBase(options: {
  id: string;
  kind: AgentCoreMessagePart['kind'];
  sequence: number;
  createdAt: string;
  runId?: string;
  turnId?: string;
}): Pick<AgentCoreMessagePart, 'id' | 'kind' | 'sequence' | 'createdAt' | 'runId' | 'turnId'> {
  return {
    id: options.id,
    kind: options.kind,
    sequence: options.sequence,
    createdAt: options.createdAt,
    runId: options.runId,
    turnId: options.turnId
  };
}

export function createAgentRunController(options: AgentRunControllerOptions = {}) {
  const createdAt = options.createdAt ?? (() => new Date().toISOString());
  const machine = createAgentCoreStateMachine();
  const parts: AgentCoreMessagePart[] = [];
  const pendingToolUseIds = new Set<string>();
  const completedToolUseIds = new Set<string>();
  let nextSequence = 0;
  let providerStepCount = 0;
  let nextAction: AgentRunControllerAction = 'build_model_input';
  let lastDecision: AgentCoreLoopDecision | undefined;
  let lastContinuation: AgentRunControllerContinuation | undefined;

  function now(): string {
    return createdAt();
  }

  function pushPart(part: AgentCoreMessagePart): void {
    parts.push(part);
    nextSequence = Math.max(nextSequence, part.sequence + 1);
  }

  function markToolCallStatus(toolUseId: string, status: Extract<AgentCoreMessagePart, { kind: 'tool_call' }>['status']): void {
    const index = parts.findIndex((part) => part.kind === 'tool_call' && part.toolUseId === toolUseId);
    if (index >= 0) {
      const part = parts[index];
      if (part.kind === 'tool_call') {
        parts[index] = {
          ...part,
          status
        };
      }
    }
  }

  function getSnapshot(): AgentRunControllerSnapshot {
    return {
      coreState: machine.getSnapshot(),
      parts: parts.slice(),
      nextAction,
      lastDecision,
      lastContinuation,
      providerStepCount,
      pendingToolUseIds: [...pendingToolUseIds],
      completedToolUseIds: [...completedToolUseIds]
    };
  }

  function start(): AgentRunControllerSnapshot {
    machine.transition('loading_context', 'Load project and session context.', now());
    machine.transition('building_model_input', 'Build provider input from structured context and replay parts.', now());
    nextAction = 'build_model_input';
    return getSnapshot();
  }

  function recordProviderStep(input: AgentRunControllerProviderStepInput): AgentRunControllerSnapshot {
    machine.transition('streaming_model_step', 'Provider step started.', now());
    providerStepCount += 1;
    const continuation = resolveControllerContinuation(input);
    if (input.providerStep.thinking) {
      pushPart({
        ...createPartBase({
          id: `provider_step:${providerStepCount}:thinking`,
          kind: 'assistant_thinking',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'assistant_thinking',
        thinking: input.providerStep.thinking
      });
    }
    if (input.providerStep.usage) {
      pushPart({
        ...createPartBase({
          id: `provider_step:${providerStepCount}:usage`,
          kind: 'usage',
          sequence: nextSequence,
          createdAt: input.providerStep.usage.recordedAt || now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'usage',
        usage: input.providerStep.usage
      });
    }
    if (input.providerStep.text) {
      pushPart({
        ...createPartBase({
          id: `provider_step:${providerStepCount}:text`,
          kind: 'assistant_text',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'assistant_text',
        text: input.providerStep.text,
        final: !continuation && input.providerStep.toolCalls.length === 0 && input.providerStep.finishReason === 'stop'
      });
    }
    for (const toolCall of input.providerStep.toolCalls) {
      pendingToolUseIds.add(toolCall.toolUseId);
      pushPart({
        ...createPartBase({
          id: `provider_step:${providerStepCount}:tool_call:${toolCall.toolUseId}`,
          kind: 'tool_call',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'tool_call',
        toolUseId: toolCall.toolUseId,
        providerCallId: toolCall.providerCallId,
        name: toolCall.name,
        input: toolCall.input,
        status: 'pending'
      });
    }
    if (input.error) {
      pushPart({
        ...createPartBase({
          id: `provider_step:${providerStepCount}:run_error`,
          kind: 'run_error',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'run_error',
        error: input.error,
        recoverable: false,
        diagnosticCode: 'provider_step_error'
      });
    }
    if (input.pendingPermission) {
      pushPart({
        ...createPartBase({
          id: `permission_request:${input.pendingPermission.requestId}`,
          kind: 'permission_request',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'permission_request',
        requestId: input.pendingPermission.requestId,
        toolName: input.pendingPermission.toolName,
        risk: input.pendingPermission.risk,
        reason: input.pendingPermission.reason,
        impact: input.pendingPermission.impact
      });
    }
    machine.transition('collecting_tool_calls', 'Collect provider text, thinking, and tool calls.', now());
    lastContinuation = undefined;
    lastDecision = continuation
      ? {
          outcome: 'continue_after_tools',
          nextState: 'building_model_input',
          terminal: false,
          reason: [
            `Host requested continuation: ${continuation.reason}.`,
            continuation.detail
          ].filter(Boolean).join(' ')
        }
      : decideAgentCoreLoopOutcome({
          providerFinishReason: input.providerStep.finishReason,
          toolCallCount: input.providerStep.toolCalls.length,
          hasFinalText: Boolean(input.providerStep.text?.trim()),
          hasPendingPermission: Boolean(input.hasPendingPermission || input.pendingPermission),
          hasPendingUserInput: Boolean(input.hasPendingUserInput),
          shouldCompact: Boolean(input.shouldCompact),
          shouldVerify: Boolean(input.shouldVerify),
          cancelled: Boolean(input.cancelled),
          interrupted: Boolean(input.interrupted),
          error: input.error
        });
    if (continuation) {
      lastContinuation = continuation;
    } else if (
      lastDecision.outcome === 'continue_after_tools' &&
      lastDecision.nextState === 'building_model_input' &&
      isLengthLimitedProviderFinishReason(input.providerStep.finishReason)
    ) {
      lastContinuation = {
        reason: 'length',
        detail: 'Provider hit output length before a final stop.'
      };
    }
    machine.applyDecision(lastDecision, now());
    nextAction = controllerActionFromDecision(lastDecision);
    return getSnapshot();
  }

  function recordToolResult(input: AgentRunControllerToolResultInput): AgentRunControllerSnapshot {
    const currentState = machine.getSnapshot().state;
    const wasPending = pendingToolUseIds.has(input.toolUseId);
    if (!wasPending && completedToolUseIds.has(input.toolUseId)) {
      nextAction = currentState === 'building_model_input' ? 'build_model_input' : nextAction;
      return getSnapshot();
    }
    if (currentState === 'executing_tools') {
      machine.transition('recording_tool_results', 'Record host tool result as a structured part.', now());
    }
    pendingToolUseIds.delete(input.toolUseId);
    completedToolUseIds.add(input.toolUseId);
    markToolCallStatus(input.toolUseId, input.isError ? 'failed' : 'completed');
    const base = createPartBase({
      id: `tool_result:${input.toolUseId}`,
      kind: input.isError ? 'tool_error' : 'tool_result',
      sequence: nextSequence,
      createdAt: now(),
      runId: options.runId,
      turnId: options.turnId
    });
    if (input.isError) {
      const part: AgentCoreToolErrorPart = {
        ...base,
        kind: 'tool_error',
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        error: input.content,
        failureKind: input.failureKind,
        recoveryHint: input.recoveryHint,
        changedFiles: input.changedFiles,
        command: input.command,
        terminal: input.terminal,
        browser: input.browser,
        edit: input.edit,
        mcp: input.mcp,
        artifacts: input.artifacts,
        transaction: input.transaction
      };
      pushPart(part);
    } else {
      const part: AgentCoreToolResultPart = {
        ...base,
        kind: 'tool_result',
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        content: input.content,
        changedFiles: input.changedFiles,
        command: input.command,
        terminal: input.terminal,
        browser: input.browser,
        edit: input.edit,
        mcp: input.mcp,
        artifacts: input.artifacts,
        transaction: input.transaction
      };
      pushPart(part);
    }
    const stateAfterPart = machine.getSnapshot().state;
    if (pendingToolUseIds.size === 0 && stateAfterPart === 'recording_tool_results') {
      machine.transition('continuing_after_tools', 'Tool result is ready for provider replay.', now());
      machine.transition('building_model_input', 'Build next provider input with completed tool output.', now());
      nextAction = 'build_model_input';
    } else if (!wasPending && stateAfterPart === 'building_model_input') {
      nextAction = 'build_model_input';
    } else {
      nextAction = 'execute_tools';
    }
    return getSnapshot();
  }

  function recordPermissionDenied(input: AgentRunControllerPermissionDeniedInput): AgentRunControllerSnapshot {
    if (machine.getSnapshot().state === 'awaiting_permission') {
      machine.transition('executing_tools', 'Permission denied; record a structured tool error for provider replay.', now());
    }
    return recordToolResult({
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      content: input.content ?? `Permission denied for tool ${input.toolName ?? input.toolUseId}.`,
      isError: true,
      failureKind: 'permission_denied',
      recoveryHint: input.recoveryHint,
      transaction: input.transaction
    });
  }

  function recordPermissionApproved(input: AgentRunControllerPermissionApprovedInput): AgentRunControllerSnapshot {
    if (machine.getSnapshot().state === 'awaiting_permission') {
      machine.transition('executing_tools', 'Permission approved; record a structured permission result for provider replay.', now());
    }
    return recordToolResult({
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      content: input.content ?? `Permission approved for tool ${input.toolName ?? input.toolUseId}.`,
      transaction: input.transaction
    });
  }

  function findPendingToolName(toolUseId: string): string | undefined {
    const toolPart = [...parts]
      .reverse()
      .find((part) => part.kind === 'tool_call' && part.toolUseId === toolUseId);
    return toolPart?.kind === 'tool_call' ? toolPart.name : undefined;
  }

  function interruptResumable(input: AgentRunControllerInterruptionInput = {}): AgentRunControllerSnapshot {
    const reason = input.reason ?? 'Run interrupted before all pending tool calls completed.';
    for (const toolUseId of [...pendingToolUseIds]) {
      const toolName = findPendingToolName(toolUseId);
      markToolCallStatus(toolUseId, 'failed');
      pushPart({
        ...createPartBase({
          id: `tool_error:${toolUseId}:interrupted`,
          kind: 'tool_error',
          sequence: nextSequence,
          createdAt: now(),
          runId: options.runId,
          turnId: options.turnId
        }),
        kind: 'tool_error',
        toolUseId,
        toolName,
        error: reason,
        failureKind: 'interrupted',
        recoveryHint: input.recoveryHint
      });
      pendingToolUseIds.delete(toolUseId);
      completedToolUseIds.add(toolUseId);
    }
    const currentState = machine.getSnapshot().state;
    if (canTransitionAgentCoreState(currentState, 'interrupted_resumable')) {
      machine.transition('interrupted_resumable', reason, now());
    }
    lastDecision = {
      outcome: 'interrupt_resumable',
      nextState: 'interrupted_resumable',
      terminal: false,
      reason
    };
    nextAction = 'interrupt_resumable';
    return getSnapshot();
  }

  function requestContextCompression(reason = 'Context budget requires compression before the next provider input.'): AgentRunControllerSnapshot {
    const currentState = machine.getSnapshot().state;
    if (canTransitionAgentCoreState(currentState, 'compacting_context')) {
      machine.transition('compacting_context', reason, now());
    }
    lastDecision = {
      outcome: 'compact_context',
      nextState: 'compacting_context',
      terminal: false,
      reason
    };
    nextAction = 'compact_context';
    return getSnapshot();
  }

  function recordContextSummary(input: AgentRunControllerContextSummaryInput): AgentRunControllerSnapshot {
    pushPart({
      ...createPartBase({
        id: `context_summary:${nextSequence}`,
        kind: 'context_summary',
        sequence: nextSequence,
        createdAt: now(),
        runId: options.runId,
        turnId: options.turnId
      }),
      kind: 'context_summary',
      summary: input.summary,
      structured: input.structured,
      coverage: input.coverage
    });
    const currentState = machine.getSnapshot().state;
    if (currentState === 'compacting_context') {
      machine.transition('building_model_input', 'Context summary recorded for provider replay.', now());
    }
    nextAction = 'build_model_input';
    return getSnapshot();
  }

  return {
    getSnapshot,
    start,
    recordProviderStep,
    recordToolResult,
    recordPermissionApproved,
    recordPermissionDenied,
    interruptResumable,
    requestContextCompression,
    recordContextSummary
  };
}
