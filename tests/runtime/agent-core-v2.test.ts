import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentCoreStateTransitions,
  agentCorePartsToPlainText,
  agentCorePartsToChatContentBlocks,
  canTransitionAgentCoreState,
  createAgentCoreStateMachine,
  decideAgentCoreLoopOutcome,
  isTerminalAgentCoreState,
  promptStreamEventToAgentCoreParts,
  runtimeEventToAgentCoreParts
} from '../../shared/agent-core-v2.ts';
import type { AgentCoreMessagePart, AgentCoreProviderStepResult, PromptStreamEvent, AgentRuntimeEvent } from '../../shared/types.ts';

test('Agent Core v2 state table has explicit terminal states', () => {
  assert.equal(isTerminalAgentCoreState('completed'), true);
  assert.equal(isTerminalAgentCoreState('failed'), true);
  assert.equal(isTerminalAgentCoreState('cancelled'), true);
  assert.equal(isTerminalAgentCoreState('interrupted_resumable'), false);
  assert.deepEqual(agentCoreStateTransitions.completed, []);
  assert.equal(canTransitionAgentCoreState('streaming_model_step', 'collecting_tool_calls'), true);
  assert.equal(canTransitionAgentCoreState('collecting_tool_calls', 'building_model_input'), true);
  assert.equal(canTransitionAgentCoreState('completed', 'building_model_input'), false);
});

test('Agent Core v2 state machine records transitions and blocks invalid jumps', () => {
  const machine = createAgentCoreStateMachine();
  machine.transition('loading_context', 'load project context', '2026-05-15T00:00:00.000Z');
  machine.transition('building_model_input', 'build provider input', '2026-05-15T00:00:01.000Z');
  const snapshot = machine.getSnapshot();

  assert.equal(snapshot.state, 'building_model_input');
  assert.deepEqual(snapshot.history.map((item) => `${item.from}->${item.to}`), [
    'initializing->loading_context',
    'loading_context->building_model_input'
  ]);
  assert.throws(() => machine.transition('completed', 'skip loop'), /Invalid Agent Core state transition/);
});

test('Agent Core v2 state machine applies loop decisions', () => {
  const machine = createAgentCoreStateMachine('collecting_tool_calls');
  const decision = decideAgentCoreLoopOutcome({
    providerFinishReason: 'tool_calls',
    toolCallCount: 2,
    hasFinalText: false,
    hasPendingPermission: false,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });
  const snapshot = machine.applyDecision(decision, '2026-05-15T00:00:00.000Z');

  assert.equal(snapshot.state, 'executing_tools');
  assert.equal(snapshot.history[0]?.reason, decision.reason);
});

test('Agent Core v2 continues when stop contains tool calls', () => {
  const decision = decideAgentCoreLoopOutcome({
    providerFinishReason: 'stop',
    toolCallCount: 1,
    hasFinalText: true,
    hasPendingPermission: false,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });

  assert.equal(decision.outcome, 'continue_after_tools');
  assert.equal(decision.nextState, 'executing_tools');
  assert.equal(decision.terminal, false);
});

test('Agent Core v2 owns host requested continuation decisions', () => {
  const decision = decideAgentCoreLoopOutcome({
    providerFinishReason: 'stop',
    toolCallCount: 0,
    hasFinalText: true,
    hasPendingPermission: false,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false,
    requestedContinuation: {
      reason: 'partial_write',
      detail: 'Assistant promised another file write.'
    }
  });

  assert.equal(decision.outcome, 'continue_after_tools');
  assert.equal(decision.nextState, 'building_model_input');
  assert.equal(decision.terminal, false);
  assert.match(decision.reason, /partial_write/);
});

test('Agent Core v2 pauses before executing tools that need permission or input', () => {
  const permission = decideAgentCoreLoopOutcome({
    providerFinishReason: 'tool_calls',
    toolCallCount: 1,
    hasFinalText: false,
    hasPendingPermission: true,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });
  const userInput = decideAgentCoreLoopOutcome({
    providerFinishReason: 'tool_calls',
    toolCallCount: 1,
    hasFinalText: false,
    hasPendingPermission: false,
    hasPendingUserInput: true,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });

  assert.equal(permission.outcome, 'pause_for_permission');
  assert.equal(permission.nextState, 'awaiting_permission');
  assert.equal(userInput.outcome, 'pause_for_user_input');
  assert.equal(userInput.nextState, 'awaiting_user_input');
});

test('Agent Core v2 only completes on stop without tool calls and with final text', () => {
  const completed = decideAgentCoreLoopOutcome({
    providerFinishReason: 'stop',
    toolCallCount: 0,
    hasFinalText: true,
    hasPendingPermission: false,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });
  const emptyStop = decideAgentCoreLoopOutcome({
    providerFinishReason: 'stop',
    toolCallCount: 0,
    hasFinalText: false,
    hasPendingPermission: false,
    hasPendingUserInput: false,
    shouldCompact: false,
    shouldVerify: false,
    cancelled: false,
    interrupted: false
  });

  assert.equal(completed.outcome, 'complete');
  assert.equal(completed.terminal, true);
  assert.equal(emptyStop.outcome, 'fail');
});

test('Agent Core v2 platform parts cover text, tool, pause, todo, context, usage, and errors', () => {
  const parts: AgentCoreMessagePart[] = [
    { id: 'p1', kind: 'assistant_text', createdAt: 'now', sequence: 1, text: 'Working' },
    { id: 'p2', kind: 'assistant_thinking', createdAt: 'now', sequence: 2, thinking: 'Plan' },
    { id: 'p3', kind: 'tool_call', createdAt: 'now', sequence: 3, toolUseId: 'tool_1', name: 'read_file', status: 'pending' },
    { id: 'p4', kind: 'tool_result', createdAt: 'now', sequence: 4, toolUseId: 'tool_1', content: 'ok' },
    { id: 'p5', kind: 'permission_request', createdAt: 'now', sequence: 5, requestId: 'perm_1', toolName: 'write_file', risk: 'high' },
    { id: 'p6', kind: 'user_input_request', createdAt: 'now', sequence: 6, requestId: 'input_1', question: 'Choose' },
    { id: 'p7', kind: 'todo_update', createdAt: 'now', sequence: 7, items: [{ id: 'todo_1', title: 'Implement', status: 'in_progress' }] },
    { id: 'p8', kind: 'context_summary', createdAt: 'now', sequence: 8, summary: 'Compressed' },
    { id: 'p9', kind: 'usage', createdAt: 'now', sequence: 9, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, recordedAt: 'now' } },
    { id: 'p10', kind: 'run_error', createdAt: 'now', sequence: 10, error: 'failed', recoverable: true }
  ];

  assert.deepEqual(parts.map((part) => part.kind), [
    'assistant_text',
    'assistant_thinking',
    'tool_call',
    'tool_result',
    'permission_request',
    'user_input_request',
    'todo_update',
    'context_summary',
    'usage',
    'run_error'
  ]);
});

test('Agent Core v2 plain text projection omits token usage metadata', () => {
  const parts: AgentCoreMessagePart[] = [
    { id: 'p1', kind: 'assistant_text', createdAt: 'now', sequence: 1, text: '完成。' },
    { id: 'p2', kind: 'usage', createdAt: 'now', sequence: 2, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, recordedAt: 'now' } }
  ];

  assert.equal(agentCorePartsToPlainText(parts, false), '完成。');
  assert.equal(agentCorePartsToPlainText([parts[1] as AgentCoreMessagePart], true), '');
});

test('Agent Core v2 provider step result is protocol-neutral', () => {
  const step: AgentCoreProviderStepResult = {
    text: 'Need to inspect.',
    thinking: 'Use read_file.',
    finishReason: 'tool_calls',
    toolCalls: [{
      toolUseId: 'tool_1',
      providerCallId: 'call_1',
      name: 'read_file',
      input: { path: 'README.md' }
    }],
    warnings: ['provider returned stop with tool calls']
  };

  assert.equal(step.toolCalls[0]?.name, 'read_file');
  assert.equal(step.finishReason, 'tool_calls');
});

test('Agent Core v2 projects parts to transient chat content block views', () => {
  const parts: AgentCoreMessagePart[] = [
    {
      id: 'part_text',
      kind: 'assistant_text',
      sequence: 0,
      createdAt: '2026-05-15T00:00:00.000Z',
      text: 'hello'
    },
    {
      id: 'part_tool',
      kind: 'tool_call',
      sequence: 1,
      createdAt: '2026-05-15T00:00:01.000Z',
      toolUseId: 'tool_1',
      name: 'read_file',
      input: { path: 'README.md' },
      status: 'completed'
    },
    {
      id: 'part_result',
      kind: 'tool_result',
      sequence: 2,
      createdAt: '2026-05-15T00:00:02.000Z',
      toolUseId: 'tool_1',
      content: 'done',
      changedFiles: [{ path: 'README.md', operation: 'modified' }],
      transaction: {
        id: 'tool_txn:tool_1',
        toolUseId: 'tool_1',
        toolName: 'read_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z'
      }
    },
    {
      id: 'part_error',
      kind: 'tool_error',
      sequence: 3,
      createdAt: '2026-05-15T00:00:03.000Z',
      toolUseId: 'tool_2',
      toolName: 'edit_file',
      error: 'missing match',
      transaction: {
        id: 'tool_txn:tool_2',
        toolUseId: 'tool_2',
        toolName: 'edit_file',
        toolClass: 'workspace',
        phase: 'failed',
        status: 'failed',
        eventCount: 4,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z'
      }
    }
  ];
  const blocks = agentCorePartsToChatContentBlocks(parts);

  assert.deepEqual(blocks.map((block) => block.type), ['text', 'tool_use', 'tool_result', 'tool_result']);
  assert.equal(blocks[1]?.type === 'tool_use' ? blocks[1].name : undefined, 'read_file');
  assert.equal(blocks[2]?.type === 'tool_result' ? blocks[2].changedFiles?.[0]?.path : undefined, 'README.md');
  assert.equal(blocks[2]?.type === 'tool_result' ? blocks[2].transaction?.eventCount : undefined, 3);
  assert.equal(blocks[3]?.type === 'tool_result' ? blocks[3].isError : undefined, true);
  assert.equal(blocks[3]?.type === 'tool_result' ? blocks[3].transaction?.status : undefined, 'failed');
});

test('Agent Core v2 maps stream events into parts', () => {
  const event: PromptStreamEvent = {
    type: 'permission_request',
    streamId: 'stream_1',
    projectId: 'project_1',
    sessionId: 'session_1',
    requestId: 'perm_1',
    title: 'Approve write',
    detail: 'write file',
    risk: 'high',
    toolName: 'write_file',
    impact: {
      toolName: 'write_file',
      paths: ['index.html']
    },
    startedAt: '2026-05-15T00:00:00.000Z'
  };
  const parts = promptStreamEventToAgentCoreParts(event, {
    startingSequence: 4
  });

  assert.equal(parts[0]?.kind, 'permission_request');
  assert.equal(parts[0]?.sequence, 4);
  assert.equal(parts[0]?.kind === 'permission_request' ? parts[0].risk : '', 'high');
  assert.deepEqual(parts[0]?.kind === 'permission_request' ? parts[0].impact?.paths : undefined, ['index.html']);
});

test('Agent Core v2 maps runtime event log entries into parts', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_1',
    type: 'tool_result',
    createdAt: '2026-05-15T00:00:00.000Z',
    toolResult: {
      toolUseId: 'tool_1',
      toolName: 'write_file',
      contentPreview: 'updated',
      changedFiles: [{ path: 'index.html', operation: 'modified' }],
      transaction: {
        id: 'tool_txn:tool_1',
        toolUseId: 'tool_1',
        toolName: 'write_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 3,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:01.000Z'
      }
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'tool_result');
  assert.equal(parts[0]?.kind === 'tool_result' ? parts[0].toolName : '', 'write_file');
  assert.equal(parts[0]?.kind === 'tool_result' ? parts[0].changedFiles?.[0]?.operation : '', 'modified');
  assert.equal(parts[0]?.kind === 'tool_result' ? parts[0].transaction?.eventCount : 0, 3);
});

test('Agent Core v2 maps persisted Agent Core ledger events without re-projecting them', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_agent_core_parts',
    type: 'agent_core_parts',
    createdAt: '2026-05-15T00:00:00.000Z',
    agentCoreParts: [
      {
        id: 'controller_part_1',
        kind: 'assistant_text',
        sequence: 7,
        createdAt: '2026-05-15T00:00:00.000Z',
        text: 'controller-owned answer'
      }
    ]
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.id, 'controller_part_1');
  assert.equal(parts[0]?.sequence, 7);
  assert.equal(parts[0]?.kind === 'assistant_text' ? parts[0].text : '', 'controller-owned answer');
});

test('Agent Core v2 maps tool boundary transactions into system parts', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_boundary',
    type: 'tool_boundary',
    createdAt: '2026-05-15T00:00:02.000Z',
    toolBoundary: {
      toolUseId: 'tool_1',
      toolName: 'write_file',
      phase: 'tool_result',
      status: 'completed',
      checkpointSnapshotId: 'snapshot_1',
      summary: 'write completed',
      transaction: {
        id: 'tool_txn:tool_1',
        toolUseId: 'tool_1',
        toolName: 'write_file',
        toolClass: 'workspace',
        phase: 'completed',
        status: 'completed',
        eventCount: 4,
        startedAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:02.000Z'
      }
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'system_event');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].summary : '', 'write completed');
  assert.equal(parts[0]?.kind === 'system_event' ? (parts[0].metadata?.transaction as { eventCount?: number } | undefined)?.eventCount : 0, 4);
});

test('Agent Core v2 maps persisted core-state events into system parts', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_core_1',
    type: 'agent_core_state',
    createdAt: '2026-05-15T00:00:00.000Z',
    coreState: {
      state: 'interrupted_resumable',
      history: [
        {
          from: 'executing_tools',
          to: 'interrupted_resumable',
          reason: 'interrupted after tool boundary',
          createdAt: '2026-05-15T00:00:00.000Z'
        }
      ]
    },
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: []
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'system_event');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].state : undefined, 'interrupted_resumable');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.providerFinishReason : undefined, 'tool_calls');
});

test('Agent Core v2 maps persisted context summaries into context parts', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_context_1',
    type: 'context_summary',
    createdAt: '2026-05-15T00:00:00.000Z',
    contextSummary: {
      summary: 'Goals, decisions, constraints, and unfinished work.',
      coverage: {
        version: 1,
        strategy: 'extractive',
        messageCount: 10,
        turnCount: 5,
        generatedAt: '2026-05-15T00:00:00.000Z'
      }
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'context_summary');
  assert.equal(parts[0]?.kind === 'context_summary' ? parts[0].summary : undefined, 'Goals, decisions, constraints, and unfinished work.');
  assert.equal(parts[0]?.kind === 'context_summary' ? parts[0].coverage?.turnCount : undefined, 5);
});

test('Agent Core v2 maps persisted todo updates into todo parts', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_todo_1',
    type: 'todo_update',
    createdAt: '2026-05-15T00:00:00.000Z',
    todoUpdate: {
      toolUseId: 'tool_todo_1',
      items: [
        {
          id: 'inspect',
          title: 'Inspect runtime state',
          status: 'completed'
        },
        {
          id: 'persist',
          title: 'Persist todo update',
          status: 'in_progress'
        }
      ]
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'todo_update');
  assert.deepEqual(parts[0]?.kind === 'todo_update' ? parts[0].items.map((item) => item.status) : [], ['completed', 'in_progress']);
});

test('Agent Core v2 maps persisted user input events into parts', () => {
  const requestEvent: AgentRuntimeEvent = {
    id: 'event_user_input_1',
    type: 'user_input_request',
    createdAt: '2026-05-15T00:00:00.000Z',
    userInputRequest: {
      requestId: 'input_1',
      title: 'Agent 需要你的输入',
      question: 'Choose a direction',
      options: [
        {
          id: 'left',
          label: 'Left',
          description: 'Go left'
        }
      ],
      toolName: 'ask_user'
    }
  };
  const resolvedEvent: AgentRuntimeEvent = {
    id: 'event_user_input_2',
    type: 'user_input_resolved',
    createdAt: '2026-05-15T00:00:01.000Z',
    userInputResponse: {
      requestId: 'input_1',
      answerPreview: 'Left',
      answerLength: 4,
      optionId: 'left'
    }
  };
  const requestParts = runtimeEventToAgentCoreParts(requestEvent);
  const resolvedParts = runtimeEventToAgentCoreParts(resolvedEvent);

  assert.equal(requestParts[0]?.kind, 'user_input_request');
  assert.equal(requestParts[0]?.kind === 'user_input_request' ? requestParts[0].question : undefined, 'Choose a direction');
  assert.equal(requestParts[0]?.kind === 'user_input_request' ? requestParts[0].options?.[0]?.id : undefined, 'left');
  assert.equal(resolvedParts[0]?.kind, 'system_event');
  assert.equal(resolvedParts[0]?.kind === 'system_event' ? resolvedParts[0].metadata?.requestId : undefined, 'input_1');
  assert.equal(resolvedParts[0]?.kind === 'system_event' ? resolvedParts[0].summary : undefined, 'Left');
});

test('Agent Core v2 maps persisted permission events into parts', () => {
  const requestEvent: AgentRuntimeEvent = {
    id: 'event_permission_1',
    type: 'permission_request',
    createdAt: '2026-05-15T00:00:00.000Z',
    permissionRequest: {
      requestId: 'perm_1',
      title: 'Approve write',
      detail: 'write index.html',
      risk: 'high',
      toolName: 'write_file',
      impact: {
        toolName: 'write_file',
        paths: ['index.html']
      }
    }
  };
  const resolvedEvent: AgentRuntimeEvent = {
    id: 'event_permission_2',
    type: 'permission_resolved',
    createdAt: '2026-05-15T00:00:01.000Z',
    permissionResponse: {
      requestId: 'perm_1',
      decision: 'allow'
    }
  };
  const requestParts = runtimeEventToAgentCoreParts(requestEvent);
  const resolvedParts = runtimeEventToAgentCoreParts(resolvedEvent);

  assert.equal(requestParts[0]?.kind, 'permission_request');
  assert.equal(requestParts[0]?.kind === 'permission_request' ? requestParts[0].toolName : undefined, 'write_file');
  assert.equal(requestParts[0]?.kind === 'permission_request' ? requestParts[0].risk : undefined, 'high');
  assert.deepEqual(requestParts[0]?.kind === 'permission_request' ? requestParts[0].impact?.paths : undefined, ['index.html']);
  assert.equal(resolvedParts[0]?.kind, 'system_event');
  assert.equal(resolvedParts[0]?.kind === 'system_event' ? resolvedParts[0].metadata?.requestId : undefined, 'perm_1');
  assert.equal(resolvedParts[0]?.kind === 'system_event' ? resolvedParts[0].metadata?.decision : undefined, 'allow');
});

test('Agent Core v2 maps persisted skill activation into a system part', () => {
  const event: AgentRuntimeEvent = {
    id: 'event_skill_1',
    type: 'skill_activation',
    createdAt: '2026-05-16T00:00:00.000Z',
    skillActivation: {
      id: 'project:/repo:backend-plan',
      name: 'backend-plan',
      description: 'Plan backend changes.',
      source: 'project',
      sourceId: '/repo',
      sourcePath: '.claude/skills/backend-plan/SKILL.md',
      activationReason: 'automatic_metadata_match',
      instruction: 'Plan carefully.',
      trustLevel: 'workspace',
      verificationStatus: 'local_source',
      contentSha256: 'a'.repeat(64),
      permissionPolicy: 'workspace_policy',
      scriptPolicy: 'none'
    }
  };
  const parts = runtimeEventToAgentCoreParts(event);

  assert.equal(parts[0]?.kind, 'system_event');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.type : undefined, 'skill_activation');
  assert.equal(parts[0]?.kind === 'system_event' ? parts[0].metadata?.skillName : undefined, 'backend-plan');
  assert.match(parts[0]?.kind === 'system_event' ? parts[0].summary ?? '' : '', /workspace_policy/);
});
