import type {
  AgentCoreLoopDecision,
  AgentCoreLoopDecisionInput,
  AgentCoreMessagePart,
  AgentCorePartConversionOptions,
  AgentCorePartKind,
  AgentCoreState,
  AgentCoreStateMachineSnapshot
} from './types/agent-core';
import type { AgentRuntimeEvent } from './types/agent';
import type { ChatContentBlock } from './types/chat';
import type { PromptStreamEvent } from './types/stream';

export const agentCoreStateTransitions: Record<AgentCoreState, AgentCoreState[]> = {
  initializing: ['loading_context', 'failed', 'cancelled'],
  loading_context: ['building_model_input', 'compacting_context', 'failed', 'cancelled'],
  building_model_input: ['streaming_model_step', 'compacting_context', 'failed', 'cancelled'],
  streaming_model_step: ['collecting_tool_calls', 'compacting_context', 'failed', 'cancelled', 'interrupted_resumable'],
  collecting_tool_calls: ['awaiting_permission', 'executing_tools', 'awaiting_user_input', 'building_model_input', 'verifying_work', 'completed', 'failed', 'cancelled', 'interrupted_resumable'],
  awaiting_permission: ['executing_tools', 'failed', 'cancelled', 'interrupted_resumable'],
  executing_tools: ['recording_tool_results', 'awaiting_user_input', 'failed', 'cancelled', 'interrupted_resumable'],
  awaiting_user_input: ['recording_tool_results', 'failed', 'cancelled', 'interrupted_resumable'],
  recording_tool_results: ['continuing_after_tools', 'failed', 'cancelled', 'interrupted_resumable'],
  continuing_after_tools: ['building_model_input', 'compacting_context', 'failed', 'cancelled', 'interrupted_resumable'],
  compacting_context: ['building_model_input', 'failed', 'cancelled', 'interrupted_resumable'],
  verifying_work: ['completed', 'building_model_input', 'failed', 'cancelled', 'interrupted_resumable'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted_resumable: ['loading_context', 'failed', 'cancelled']
};

export function isTerminalAgentCoreState(state: AgentCoreState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function canTransitionAgentCoreState(from: AgentCoreState, to: AgentCoreState): boolean {
  return agentCoreStateTransitions[from].includes(to);
}

export function createAgentCoreStateMachine(initialState: AgentCoreState = 'initializing') {
  let state = initialState;
  const history: AgentCoreStateMachineSnapshot['history'] = [];

  const getSnapshot = (): AgentCoreStateMachineSnapshot => ({
    state,
    history: history.slice()
  });

  const transition = (to: AgentCoreState, reason: string, createdAt = new Date(0).toISOString()): AgentCoreStateMachineSnapshot => {
    if (!canTransitionAgentCoreState(state, to)) {
      throw new Error(`Invalid Agent Core state transition: ${state} -> ${to}`);
    }
    history.push({
      from: state,
      to,
      reason,
      createdAt
    });
    state = to;
    return getSnapshot();
  };

  const applyDecision = (decision: AgentCoreLoopDecision, createdAt = new Date(0).toISOString()): AgentCoreStateMachineSnapshot =>
    transition(decision.nextState, decision.reason, createdAt);

  return {
    getSnapshot,
    transition,
    applyDecision
  };
}

export function decideAgentCoreLoopOutcome(input: AgentCoreLoopDecisionInput): AgentCoreLoopDecision {
  if (input.cancelled) {
    return {
      outcome: 'cancel',
      nextState: 'cancelled',
      terminal: true,
      reason: 'User or host cancelled the run.'
    };
  }

  if (input.interrupted) {
    return {
      outcome: 'interrupt_resumable',
      nextState: 'interrupted_resumable',
      terminal: false,
      reason: 'Run was interrupted after a stable boundary and can be resumed.'
    };
  }

  if (input.error) {
    return {
      outcome: 'fail',
      nextState: 'failed',
      terminal: true,
      reason: input.error
    };
  }

  if (input.hasPendingPermission) {
    return {
      outcome: 'pause_for_permission',
      nextState: 'awaiting_permission',
      terminal: false,
      reason: 'Tool execution requires host permission.'
    };
  }

  if (input.hasPendingUserInput) {
    return {
      outcome: 'pause_for_user_input',
      nextState: 'awaiting_user_input',
      terminal: false,
      reason: 'Tool or MCP elicitation is waiting for user input.'
    };
  }

  if (input.toolCallCount > 0) {
    return {
      outcome: 'continue_after_tools',
      nextState: 'executing_tools',
      terminal: false,
      reason: 'Provider returned tool calls; tool results must be executed and replayed before final completion.'
    };
  }

  if (input.shouldCompact) {
    return {
      outcome: 'compact_context',
      nextState: 'compacting_context',
      terminal: false,
      reason: 'Context should be compacted before the next model step.'
    };
  }

  if (input.shouldVerify) {
    return {
      outcome: 'verify_work',
      nextState: 'verifying_work',
      terminal: false,
      reason: 'Work should be verified before completion.'
    };
  }

  if (input.providerFinishReason === 'stop' && input.hasFinalText) {
    return {
      outcome: 'complete',
      nextState: 'completed',
      terminal: true,
      reason: 'Provider stopped without tool calls and produced final visible text.'
    };
  }

  if (input.providerFinishReason === 'length') {
    return {
      outcome: 'continue_after_tools',
      nextState: 'building_model_input',
      terminal: false,
      reason: 'Provider hit output length before a final stop; continue with bounded context.'
    };
  }

  return {
    outcome: 'fail',
    nextState: 'failed',
    terminal: true,
    reason: 'Provider did not produce tool calls or final visible text.'
  };
}

function partBase(
  kind: AgentCorePartKind,
  id: string,
  sequence: number,
  options: AgentCorePartConversionOptions,
  createdAt?: string
): Pick<AgentCoreMessagePart, 'id' | 'kind' | 'createdAt' | 'runId' | 'turnId' | 'sequence'> {
  return {
    id,
    kind,
    createdAt: createdAt ?? options.createdAt ?? new Date(0).toISOString(),
    runId: options.runId,
    turnId: options.turnId,
    sequence
  };
}

function sequenceAt(options: AgentCorePartConversionOptions, offset: number): number {
  return (options.startingSequence ?? 0) + offset;
}

function partId(prefix: string, stableId: string | undefined, sequence: number): string {
  return stableId ? `${prefix}:${stableId}` : `${prefix}:${sequence}`;
}

export function chatContentBlocksToAgentCoreParts(
  blocks: ChatContentBlock[] | undefined,
  options: AgentCorePartConversionOptions = {}
): AgentCoreMessagePart[] {
  if (!blocks?.length) {
    return [];
  }
  return blocks.map((block, index): AgentCoreMessagePart => {
    const sequence = sequenceAt(options, index);
    if (block.type === 'text') {
      return {
        ...partBase('assistant_text', partId('chat_text', block.id, sequence), sequence, options),
        kind: 'assistant_text',
        text: block.text
      };
    }
    if (block.type === 'thinking') {
      return {
        ...partBase('assistant_thinking', partId('chat_thinking', block.id, sequence), sequence, options),
        kind: 'assistant_thinking',
        thinking: block.thinking,
        title: block.title
      };
    }
    if (block.type === 'tool_use') {
      return {
        ...partBase('tool_call', partId('chat_tool_call', block.toolUseId, sequence), sequence, options),
        kind: 'tool_call',
        toolUseId: block.toolUseId,
        name: block.name,
        input: block.input,
        status: block.status ?? 'completed'
      };
    }
    if (block.type === 'tool_result') {
      if (block.isError) {
        return {
          ...partBase('tool_error', partId('chat_tool_error', block.toolUseId, sequence), sequence, options),
          kind: 'tool_error',
          toolUseId: block.toolUseId,
          error: block.content,
          failureKind: block.edit?.failureKind ?? block.mcp?.failureKind,
          recoveryHint: block.edit?.recoveryHint,
          changedFiles: block.changedFiles,
          command: block.command,
          terminal: block.terminal,
          browser: block.browser,
          edit: block.edit,
          mcp: block.mcp,
          artifacts: block.artifacts,
          transaction: block.transaction
        };
      }
      return {
        ...partBase('tool_result', partId('chat_tool_result', block.toolUseId, sequence), sequence, options),
        kind: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        changedFiles: block.changedFiles,
        command: block.command,
        terminal: block.terminal,
        browser: block.browser,
        edit: block.edit,
        mcp: block.mcp,
        artifacts: block.artifacts,
        transaction: block.transaction
      };
    }
    return {
      ...partBase('system_event', partId('chat_fallback', block.id, sequence), sequence, options),
      kind: 'system_event',
      title: 'Fallback response',
      summary: block.text,
      metadata: block.reason ? { reason: block.reason } : undefined
    };
  });
}

export function agentCorePartsToChatContentBlocks(parts: AgentCoreMessagePart[] | undefined): ChatContentBlock[] {
  if (!parts?.length) {
    return [];
  }
  return [...parts]
    .sort((left, right) => {
      if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })
    .flatMap((part): ChatContentBlock[] => {
      if (part.kind === 'assistant_text') {
        return part.text.trim() ? [{ id: part.id, type: 'text', text: part.text }] : [];
      }
      if (part.kind === 'assistant_thinking') {
        return part.thinking.trim()
          ? [{ id: part.id, type: 'thinking', thinking: part.thinking, title: part.title }]
          : [];
      }
      if (part.kind === 'tool_call') {
        return [{
          id: part.id,
          type: 'tool_use',
          toolUseId: part.toolUseId,
          name: part.name,
          input: part.input,
          status: part.status
        }];
      }
      if (part.kind === 'tool_result') {
        return [{
          id: part.id,
          type: 'tool_result',
          toolUseId: part.toolUseId,
          content: part.content,
          changedFiles: part.changedFiles,
          command: part.command,
          terminal: part.terminal,
          browser: part.browser,
          edit: part.edit,
          mcp: part.mcp,
          artifacts: part.artifacts,
          transaction: part.transaction
        }];
      }
      if (part.kind === 'tool_error') {
        return [{
          id: part.id,
          type: 'tool_result',
          toolUseId: part.toolUseId,
          content: part.error,
          isError: true,
          changedFiles: part.changedFiles,
          command: part.command,
          terminal: part.terminal,
          browser: part.browser,
          edit: part.edit,
          mcp: part.mcp,
          artifacts: part.artifacts,
          transaction: part.transaction
        }];
      }
      if (part.kind === 'run_error') {
        return [{
          id: part.id,
          type: 'fallback',
          text: part.error,
          reason: part.diagnosticCode
        }];
      }
      return [];
    });
}

function agentCorePartToPlainText(part: AgentCoreMessagePart, includeToolDetails: boolean): string {
  if (part.kind === 'assistant_text') {
    return part.text;
  }
  if (part.kind === 'assistant_thinking') {
    return part.thinking;
  }
  if (part.kind === 'tool_call') {
    if (!includeToolDetails) {
      return '';
    }
    return [`[Tool] ${part.name}`, part.input ? JSON.stringify(part.input, null, 2) : ''].filter(Boolean).join('\n');
  }
  if (part.kind === 'tool_result') {
    if (!includeToolDetails) {
      return '';
    }
    return [`[Tool Result]`, part.content, part.artifacts?.length ? `[Artifacts: ${part.artifacts.length}]` : ''].filter(Boolean).join('\n');
  }
  if (part.kind === 'tool_error') {
    if (!includeToolDetails) {
      return '';
    }
    return [`[Tool Error]`, part.error].filter(Boolean).join('\n');
  }
  if (part.kind === 'permission_request') {
    return [`[Permission] ${part.toolName}`, part.reason ?? ''].filter(Boolean).join('\n');
  }
  if (part.kind === 'user_input_request') {
    return [`[User Input]`, part.question].filter(Boolean).join('\n');
  }
  if (part.kind === 'todo_update') {
    return part.items.map((item) => `${item.status}: ${item.title}`).join('\n');
  }
  if (part.kind === 'context_summary') {
    return part.summary;
  }
  if (part.kind === 'run_error') {
    return part.error;
  }
  if (part.kind === 'system_event') {
    return [part.title, part.summary ?? ''].filter(Boolean).join('\n');
  }
  if (part.kind === 'usage') {
    return `Usage: ${part.usage.totalTokens}`;
  }
  return '';
}

export function agentCorePartsToPlainText(parts: AgentCoreMessagePart[] | undefined, includeToolDetails = true): string {
  if (!parts?.length) {
    return '';
  }

  return [...parts]
    .sort((left, right) => {
      if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })
    .map((part) => agentCorePartToPlainText(part, includeToolDetails))
    .filter(Boolean)
    .join('\n\n');
}

export function agentCorePartsToVisibleAssistantText(parts: AgentCoreMessagePart[] | undefined): string {
  if (!parts?.length) {
    return '';
  }

  return [...parts]
    .sort((left, right) => {
      if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })
    .filter((part) => part.kind === 'assistant_text')
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n\n');
}

export function promptStreamEventToAgentCoreParts(
  event: PromptStreamEvent,
  options: AgentCorePartConversionOptions = {}
): AgentCoreMessagePart[] {
  const sequence = sequenceAt(options, 0);
  const withEventTime = { ...options, createdAt: event.startedAt };
  if (event.type === 'delta') {
    return event.delta
      ? [{
          ...partBase('assistant_text', partId('stream_text', event.streamId, sequence), sequence, withEventTime),
          kind: 'assistant_text',
          text: event.delta
        }]
      : [];
  }
  if (event.type === 'thinking') {
    return [{
      ...partBase('assistant_thinking', partId('stream_thinking', event.streamId, sequence), sequence, withEventTime),
      kind: 'assistant_thinking',
      thinking: event.delta ?? event.content
    }];
  }
  if (event.type === 'tool_use') {
    return [{
      ...partBase('tool_call', partId('stream_tool_call', event.toolUseId, sequence), sequence, withEventTime),
      kind: 'tool_call',
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input,
      status: event.status
    }];
  }
  if (event.type === 'tool_result') {
    if (event.isError) {
      return [{
        ...partBase('tool_error', partId('stream_tool_error', event.toolUseId, sequence), sequence, withEventTime),
        kind: 'tool_error',
        toolUseId: event.toolUseId,
        error: event.content,
        failureKind: event.edit?.failureKind ?? event.mcp?.failureKind,
        recoveryHint: event.edit?.recoveryHint,
        changedFiles: event.changedFiles,
        command: event.command,
        terminal: event.terminal,
        browser: event.browser,
        edit: event.edit,
        mcp: event.mcp,
        artifacts: event.artifacts,
        transaction: event.transaction
      }];
    }
    return [{
      ...partBase('tool_result', partId('stream_tool_result', event.toolUseId, sequence), sequence, withEventTime),
      kind: 'tool_result',
      toolUseId: event.toolUseId,
      content: event.content,
      changedFiles: event.changedFiles,
      command: event.command,
      terminal: event.terminal,
      browser: event.browser,
      edit: event.edit,
      mcp: event.mcp,
      artifacts: event.artifacts,
      transaction: event.transaction
    }];
  }
  if (event.type === 'permission_request') {
    return [{
      ...partBase('permission_request', partId('stream_permission', event.requestId, sequence), sequence, withEventTime),
      kind: 'permission_request',
      requestId: event.requestId,
      toolName: event.toolName ?? event.impact?.toolName ?? 'unknown',
      risk: event.risk,
      reason: event.detail,
      impact: event.impact as Record<string, unknown> | undefined
    }];
  }
  if (event.type === 'user_input_request') {
    return [{
      ...partBase('user_input_request', partId('stream_user_input', event.requestId, sequence), sequence, withEventTime),
      kind: 'user_input_request',
      requestId: event.requestId,
      question: event.question,
      options: event.options?.map((option) => ({ id: option.id, label: option.label }))
    }];
  }
  if (event.type === 'context_compressed') {
    return [{
      ...partBase('context_summary', partId('stream_context', event.streamId, sequence), sequence, withEventTime),
      kind: 'context_summary',
      summary: event.message,
      coverage: {
        boundaryOrdinal: event.boundaryOrdinal,
        coveredMessageCount: event.coveredMessageCount
      }
    }];
  }
  if (event.type === 'usage') {
    return [{
      ...partBase('usage', partId('stream_usage', event.streamId, sequence), sequence, withEventTime),
      kind: 'usage',
      usage: event.usage
    }];
  }
  if (event.type === 'error') {
    return [{
      ...partBase('run_error', partId('stream_error', event.streamId, sequence), sequence, { ...options, createdAt: event.finishedAt }),
      kind: 'run_error',
      error: event.error,
      recoverable: Boolean(event.recoveryActions?.length),
      diagnosticCode: event.diagnosticCode
    }];
  }
  const title =
    event.type === 'status' ? event.message :
      event.type === 'stage' ? event.title :
        event.type === 'tool_timeout' ? event.message :
          event.type === 'session_busy' ? event.message :
            event.type === 'completed' ? 'Run completed' :
              event.type === 'cancelled' ? 'Run cancelled' :
                event.type === 'permission_resolved' ? `Permission ${event.decision}` :
                  event.type === 'user_input_resolved' ? 'User input resolved' :
                    'Stream event';
  return [{
    ...partBase('system_event', partId('stream_event', `${event.streamId}:${event.type}`, sequence), sequence, withEventTime),
    kind: 'system_event',
    title,
    summary: event.type === 'stage' ? event.summary ?? event.errorMessage : undefined,
    metadata: { type: event.type }
  }];
}

export function runtimeEventToAgentCoreParts(
  event: AgentRuntimeEvent,
  options: AgentCorePartConversionOptions = {}
): AgentCoreMessagePart[] {
  const sequence = sequenceAt(options, 0);
  const withEventTime = { ...options, createdAt: event.createdAt };
  if (event.type === 'text_delta' && event.streamDelta) {
    return [{
      ...partBase('assistant_text', partId('runtime_text', event.id, sequence), sequence, withEventTime),
      kind: 'assistant_text',
      text: event.streamDelta.deltaPreview ?? event.streamDelta.contentPreview
    }];
  }
  if (event.type === 'thinking_delta' && event.streamDelta) {
    return [{
      ...partBase('assistant_thinking', partId('runtime_thinking', event.id, sequence), sequence, withEventTime),
      kind: 'assistant_thinking',
      thinking: event.streamDelta.deltaPreview ?? event.streamDelta.contentPreview
    }];
  }
  if (event.type === 'tool_use' && event.toolUse) {
    return [{
      ...partBase('tool_call', partId('runtime_tool_call', event.toolUse.toolUseId, sequence), sequence, withEventTime),
      kind: 'tool_call',
      toolUseId: event.toolUse.toolUseId,
      name: event.toolUse.name,
      input: event.toolUse.input,
      status: event.toolUse.status
    }];
  }
  if (event.type === 'tool_result' && event.toolResult) {
    if (event.toolResult.isError) {
      return [{
        ...partBase('tool_error', partId('runtime_tool_error', event.toolResult.toolUseId, sequence), sequence, withEventTime),
        kind: 'tool_error',
        toolUseId: event.toolResult.toolUseId,
        toolName: event.toolResult.toolName,
        error: event.toolResult.contentPreview,
        failureKind: event.toolResult.edit?.failureKind ?? event.toolResult.mcp?.failureKind,
        recoveryHint: event.toolResult.edit?.recoveryHint,
        changedFiles: event.toolResult.changedFiles,
        command: event.toolResult.command,
        terminal: event.toolResult.terminal,
        browser: event.toolResult.browser,
        edit: event.toolResult.edit,
        mcp: event.toolResult.mcp,
        artifacts: event.toolResult.artifacts,
        transaction: event.toolResult.transaction
      }];
    }
    return [{
      ...partBase('tool_result', partId('runtime_tool_result', event.toolResult.toolUseId, sequence), sequence, withEventTime),
      kind: 'tool_result',
      toolUseId: event.toolResult.toolUseId,
      toolName: event.toolResult.toolName,
      content: event.toolResult.contentPreview,
      changedFiles: event.toolResult.changedFiles,
      command: event.toolResult.command,
      terminal: event.toolResult.terminal,
      browser: event.toolResult.browser,
      edit: event.toolResult.edit,
      mcp: event.toolResult.mcp,
      artifacts: event.toolResult.artifacts,
      transaction: event.toolResult.transaction
    }];
  }
  if (event.type === 'usage' && event.usage) {
    return [{
      ...partBase('usage', partId('runtime_usage', event.id, sequence), sequence, withEventTime),
      kind: 'usage',
      usage: event.usage
    }];
  }
  if (event.type === 'context_summary' && event.contextSummary) {
    return [{
      ...partBase('context_summary', partId('runtime_context_summary', event.id, sequence), sequence, withEventTime),
      kind: 'context_summary',
      summary: event.contextSummary.summary,
      coverage: event.contextSummary.coverage as Record<string, unknown> | undefined
    }];
  }
  if (event.type === 'todo_update' && event.todoUpdate) {
    return [{
      ...partBase('todo_update', partId('runtime_todo_update', event.id, sequence), sequence, withEventTime),
      kind: 'todo_update',
      items: event.todoUpdate.items
    }];
  }
  if (event.type === 'permission_request' && event.permissionRequest) {
    return [{
      ...partBase('permission_request', partId('runtime_permission_request', event.permissionRequest.requestId, sequence), sequence, withEventTime),
      kind: 'permission_request',
      requestId: event.permissionRequest.requestId,
      toolName: event.permissionRequest.toolName ?? (event.permissionRequest.impact?.toolName as string | undefined) ?? 'unknown',
      risk: event.permissionRequest.risk,
      reason: event.permissionRequest.detail,
      impact: event.permissionRequest.impact
    }];
  }
  if (event.type === 'permission_resolved' && event.permissionResponse) {
    return [{
      ...partBase('system_event', partId('runtime_permission_resolved', event.permissionResponse.requestId, sequence), sequence, withEventTime),
      kind: 'system_event',
      title: `Permission ${event.permissionResponse.decision}`,
      metadata: {
        type: event.type,
        requestId: event.permissionResponse.requestId,
        decision: event.permissionResponse.decision
      }
    }];
  }
  if (event.type === 'user_input_request' && event.userInputRequest) {
    return [{
      ...partBase('user_input_request', partId('runtime_user_input_request', event.userInputRequest.requestId, sequence), sequence, withEventTime),
      kind: 'user_input_request',
      requestId: event.userInputRequest.requestId,
      question: event.userInputRequest.question,
      options: event.userInputRequest.options?.map((option) => ({
        id: option.id,
        label: option.label
      }))
    }];
  }
  if (event.type === 'user_input_resolved' && event.userInputResponse) {
    return [{
      ...partBase('system_event', partId('runtime_user_input_resolved', event.userInputResponse.requestId, sequence), sequence, withEventTime),
      kind: 'system_event',
      title: event.userInputResponse.cancelled ? 'User input cancelled' : 'User input resolved',
      summary: event.userInputResponse.answerPreview,
      metadata: {
        type: event.type,
        requestId: event.userInputResponse.requestId,
        optionId: event.userInputResponse.optionId,
        optionIds: event.userInputResponse.optionIds,
        cancelled: event.userInputResponse.cancelled
      }
    }];
  }
  if (event.type === 'skill_activation' && event.skillActivation) {
    return [{
      ...partBase('system_event', partId('runtime_skill_activation', event.skillActivation.id, sequence), sequence, withEventTime),
      kind: 'system_event',
      title: `Skill activated: ${event.skillActivation.name}`,
      summary: [
        `Reason: ${event.skillActivation.activationReason}`,
        `Trust: ${event.skillActivation.trustLevel}`,
        `Permission: ${event.skillActivation.permissionPolicy}`
      ].join(' · '),
      metadata: {
        type: event.type,
        skillId: event.skillActivation.id,
        skillName: event.skillActivation.name,
        activationReason: event.skillActivation.activationReason,
        source: event.skillActivation.source,
        sourcePath: event.skillActivation.sourcePath,
        trustLevel: event.skillActivation.trustLevel,
        verificationStatus: event.skillActivation.verificationStatus,
        permissionPolicy: event.skillActivation.permissionPolicy,
        scriptPolicy: event.skillActivation.scriptPolicy
      }
    }];
  }
  if (event.type === 'hook' && event.hook) {
    return [{
      ...partBase('system_event', partId('runtime_hook', event.hook.id, sequence), sequence, withEventTime),
      kind: 'system_event',
      title: `Hook ${event.hook.status}: ${event.hook.event}`,
      summary: event.hook.summary,
      metadata: {
        type: event.type,
        hookId: event.hook.id,
        ruleId: event.hook.ruleId,
        event: event.hook.event,
        actionType: event.hook.actionType,
        status: event.hook.status,
        matcher: event.hook.matcher,
        source: event.hook.source,
        sourcePath: event.hook.sourcePath,
        transaction: event.hook.transaction
      }
    }];
  }
  if (event.type === 'agent_core_state' && event.coreState) {
    const latestTransition = event.coreState.history.at(-1);
    return [{
      ...partBase('system_event', partId('runtime_core_state', event.id, sequence), sequence, withEventTime),
      kind: 'system_event',
      state: event.coreState.state,
      title: `Agent Core state: ${event.coreState.state}`,
      summary: latestTransition?.reason ?? event.statusMessage,
      metadata: {
        type: event.type,
        transitionCount: event.coreState.history.length,
        providerFinishReason: event.providerStep?.finishReason
      }
    }];
  }
  if (event.type === 'run_failed') {
    return [{
      ...partBase('run_error', partId('runtime_error', event.id, sequence), sequence, withEventTime),
      kind: 'run_error',
      error: event.error ?? event.statusMessage ?? 'Run failed.',
      recoverable: false
    }];
  }
  return [{
    ...partBase('system_event', partId('runtime_event', event.id, sequence), sequence, withEventTime),
    kind: 'system_event',
    title: event.statusMessage ?? event.timelineEntry?.title ?? event.type,
    summary: event.timelineEntry?.summary ?? event.toolBoundary?.summary,
    metadata: {
      type: event.type,
      status: event.status,
      toolBoundary: event.toolBoundary,
      transaction: event.toolBoundary?.transaction
    }
  }];
}
