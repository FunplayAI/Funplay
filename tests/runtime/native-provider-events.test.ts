import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeProviderStepEventObserver } from '../../electron/main/agent-platform/native/native-provider-events.ts';

test('native provider event observer dispatches structured provider events', () => {
  const events: string[] = [];
  const observer = createNativeProviderStepEventObserver({
    onTextDelta: (delta, accumulated) => events.push(`text:${delta}:${accumulated}`),
    onThinkingDelta: (delta, accumulated) => events.push(`thinking:${delta}:${accumulated}`),
    onToolUse: (event) => events.push(`tool_use:${event.toolUseId}:${event.toolName}`),
    onToolResult: (event) => events.push(`tool_result:${event.toolUseId}:${event.isError ? 'error' : 'ok'}:${event.transaction?.status ?? 'none'}`),
    onProviderStepDone: (event) => events.push(`done:${event.finishReason}:${event.toolCallCount}`)
  });

  observer.observe({
    type: 'text_delta',
    delta: 'Hel',
    accumulated: 'Hel'
  });
  observer.observe({
    type: 'thinking_delta',
    delta: 'why',
    accumulated: 'why'
  });
  observer.observe({
    type: 'tool_use',
    toolUseId: 'tool_1',
    toolName: 'read_file',
    input: {
      path: 'README.md'
    }
  });
  observer.observe({
    type: 'tool_result',
    toolUseId: 'tool_1',
    toolName: 'read_file',
    content: 'ok',
    transaction: {
      id: 'tool_txn:tool_1',
      toolUseId: 'tool_1',
      toolName: 'read_file',
      toolClass: 'workspace',
      phase: 'completed',
      status: 'completed',
      eventCount: 3,
      startedAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:01.000Z'
    }
  });
  observer.observe({
    type: 'provider_step_done',
    finishReason: 'stop',
    toolCallCount: 1,
    text: 'Hello'
  });

  assert.deepEqual(events, [
    'text:Hel:Hel',
    'thinking:why:why',
    'tool_use:tool_1:read_file',
    'tool_result:tool_1:ok:completed',
    'done:stop:1'
  ]);
});
