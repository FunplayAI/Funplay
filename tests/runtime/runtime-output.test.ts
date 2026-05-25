import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRuntimeOutputCollector } from '../../electron/main/agent-platform/runtime-output.ts';
import type { GenericAgentRuntimeParams } from '../../electron/main/agent-platform/types.ts';

function createParams(): GenericAgentRuntimeParams {
  return {
    activeRunId: 'run_1',
    turnId: 'turn_1'
  } as unknown as GenericAgentRuntimeParams;
}

test('runtime output keeps Agent Core parts as the write-side ledger without legacy blocks', () => {
  const collector = createConversationRuntimeOutputCollector(createParams());

  collector.onThinking('plan', 'plan');
  collector.onToolUse({
    toolUseId: 'tool_1',
    name: 'read_file',
    input: { path: 'README.md' },
    status: 'pending'
  });
  collector.onToolUse({
    toolUseId: 'tool_1',
    name: 'read_file',
    status: 'completed'
  });
  collector.onToolResult({
    toolUseId: 'tool_1',
    toolName: 'read_file',
    content: 'done',
    changedFiles: [{ path: 'README.md', operation: 'modified' }]
  });
  collector.onAgentCoreParts([
    {
      id: 'part_thinking',
      kind: 'assistant_thinking',
      runId: 'run_1',
      turnId: 'turn_1',
      sequence: 0,
      createdAt: '2026-05-20T00:00:00.000Z',
      thinking: 'plan'
    },
    {
      id: 'part_tool_call',
      kind: 'tool_call',
      runId: 'run_1',
      turnId: 'turn_1',
      sequence: 1,
      createdAt: '2026-05-20T00:00:01.000Z',
      toolUseId: 'tool_1',
      name: 'read_file',
      input: { path: 'README.md' },
      status: 'completed'
    },
    {
      id: 'part_tool_result',
      kind: 'tool_result',
      runId: 'run_1',
      turnId: 'turn_1',
      sequence: 2,
      createdAt: '2026-05-20T00:00:02.000Z',
      toolUseId: 'tool_1',
      content: 'done',
      changedFiles: [{ path: 'README.md', operation: 'modified' }]
    },
    {
      id: 'part_text',
      kind: 'assistant_text',
      runId: 'run_1',
      turnId: 'turn_1',
      sequence: 3,
      createdAt: '2026-05-20T00:00:03.000Z',
      text: 'finished'
    }
  ]);

  const metadata = collector.buildMetadata('finished', {
    type: 'text',
    text: 'finished'
  });

  assert.deepEqual(metadata.agentCoreParts?.map((part) => part.kind), [
    'assistant_thinking',
    'tool_call',
    'tool_result',
    'assistant_text'
  ]);
  assert.equal(metadata.agentCoreParts?.[1]?.kind === 'tool_call' ? metadata.agentCoreParts[1].runId : undefined, 'run_1');
  assert.equal(metadata.agentCoreParts?.[1]?.kind === 'tool_call' ? metadata.agentCoreParts[1].turnId : undefined, 'turn_1');
});

test('runtime output records fallback as Agent Core run error', () => {
  const collector = createConversationRuntimeOutputCollector(createParams());

  const metadata = collector.buildMetadata('Provider failed.', {
    type: 'fallback',
    text: 'Provider failed.',
    reason: 'provider_error'
  });

  assert.deepEqual(metadata.agentCoreParts?.map((part) => part.kind), ['run_error']);
  assert.equal(metadata.agentCoreParts?.[0]?.kind === 'run_error' ? metadata.agentCoreParts[0].error : undefined, 'Provider failed.');
});

test('runtime output emits provider-neutral runtime events at source', () => {
  const events: string[] = [];
  const collector = createConversationRuntimeOutputCollector({
    ...createParams(),
    emitRuntimeEvent: (event) => {
      if (event.type === 'text_delta') {
        events.push(`text:${event.accumulated}`);
      } else if (event.type === 'tool_use') {
        events.push(`tool:${event.tool.name}:${event.tool.status}`);
      } else if (event.type === 'stage') {
        events.push(`stage:${event.stage.stageId}:${event.stage.status}`);
      }
    }
  });

  collector.onTextDelta('hello', 'hello');
  collector.onToolUse({
    toolUseId: 'tool_1',
    name: 'read_file',
    status: 'running'
  });
  collector.onStage({
    title: 'Read',
    target: 'stage:read',
    status: 'completed'
  });

  assert.deepEqual(events, [
    'text:hello',
    'tool:read_file:running',
    'stage:stage:stage:read:completed'
  ]);
});
