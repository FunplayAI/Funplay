import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeEventResultProjection } from '../../electron/main/agent-platform/runtime-event-result.ts';
import type { GenericAgentRuntimeParams } from '../../electron/main/agent-platform/types.ts';

test('runtime event result projection keeps stream events as projections without synthesizing ledger parts', () => {
  const projection = createRuntimeEventResultProjection({
    activeRunId: 'run_1',
    turnId: 'turn_1'
  } as GenericAgentRuntimeParams);

  projection.observe({
    type: 'text_delta',
    delta: 'hello',
    accumulated: 'hello'
  });
  projection.observe({
    type: 'tool_use',
    tool: {
      toolUseId: 'tool_1',
      name: 'read_file',
      input: { path: 'README.md' },
      status: 'running'
    }
  });
  projection.observe({
    type: 'tool_result',
    result: {
      toolUseId: 'tool_1',
      toolName: 'read_file',
      content: 'done'
    }
  });

  const result = projection.buildProjectedResult({
    assistantMessage: 'legacy final text',
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  }, {
    createdAt: '2026-05-20T00:00:00.000Z'
  });

  assert.equal(result.assistantMessage, 'legacy final text');
  assert.equal(result.assistantMetadata?.agentCoreParts, undefined);
  assert.equal(result.operationLog, undefined);
});

test('runtime event result projection preserves plain result without synthesizing Agent Core parts', () => {
  const projection = createRuntimeEventResultProjection({
    turnId: 'turn_1'
  } as GenericAgentRuntimeParams);

  const result = projection.buildProjectedResult({
    assistantMessage: 'legacy final text',
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  }, {
    createdAt: '2026-05-20T00:00:00.000Z'
  });

  assert.equal(result.assistantMessage, 'legacy final text');
  assert.equal(result.assistantMetadata?.agentCoreParts, undefined);
});

test('runtime event result projection prefers Agent Core parts when runtime emits the ledger directly', () => {
  const projection = createRuntimeEventResultProjection({
    activeRunId: 'run_ledger',
    turnId: 'turn_ledger'
  } as GenericAgentRuntimeParams);

  projection.observe({
    type: 'text_delta',
    delta: 'legacy stream text',
    accumulated: 'legacy stream text'
  });
  projection.observe({
    type: 'agent_core_parts',
    parts: [
      {
        id: 'part_controller_text',
        kind: 'assistant_text',
        sequence: 0,
        createdAt: '2026-05-20T00:00:00.000Z',
        runId: 'run_ledger',
        turnId: 'turn_ledger',
        text: 'controller text'
      }
    ]
  });

  const result = projection.buildProjectedResult({
    assistantMessage: 'legacy final text',
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  }, {
    createdAt: '2026-05-20T00:00:00.000Z'
  });

  assert.equal(result.assistantMessage, 'controller text');
  assert.deepEqual(result.assistantMetadata?.agentCoreParts?.map((part) => part.id), ['part_controller_text']);
});

test('runtime event result projection does not append terminal text to an authoritative tool-only ledger', () => {
  const projection = createRuntimeEventResultProjection({
    turnId: 'turn_tool_only'
  } as GenericAgentRuntimeParams);

  projection.observe({
    type: 'agent_core_parts',
    parts: [
      {
        id: 'tool_call_1',
        kind: 'tool_call',
        sequence: 0,
        createdAt: '2026-05-20T00:00:00.000Z',
        toolUseId: 'tool_1',
        name: 'read_file',
        status: 'completed'
      },
      {
        id: 'tool_result_1',
        kind: 'tool_result',
        sequence: 1,
        createdAt: '2026-05-20T00:00:01.000Z',
        toolUseId: 'tool_1',
        toolName: 'read_file',
        content: 'done'
      }
    ]
  });

  const result = projection.buildProjectedResult({
    assistantMessage: 'final answer',
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  }, {
    createdAt: '2026-05-20T00:00:00.000Z'
  });

  assert.deepEqual(result.assistantMetadata?.agentCoreParts?.map((part) => part.kind), ['tool_call', 'tool_result']);
  assert.equal(result.assistantMessage, 'final answer');
});
