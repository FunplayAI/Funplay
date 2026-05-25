import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderRuntimeController,
  createProviderRuntimeEventAdapter,
  createProviderRuntimeEventObserver,
  providerRuntimeEventToCoreEvent
} from '../../electron/main/agent-platform/provider-runtime-events.ts';
import { createAgentCoreRunEngine } from '../../electron/main/agent-core/run-engine.ts';

test('provider runtime event observer dispatches structured provider events', () => {
  const events: string[] = [];
  const observer = createProviderRuntimeEventObserver({
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

test('provider runtime event adapter maps provider events into controller events and callbacks', () => {
  const coreEvents: string[] = [];
  const callbackEvents: string[] = [];
  const adapter = createProviderRuntimeEventAdapter({
    controller: {
      submitEvent: (event) => {
        const boundary = event.type === 'terminal'
          ? event.status
          : event.type === 'provider' || event.type === 'tool' || event.type === 'context'
            ? event.phase
            : '';
        coreEvents.push(`${event.type}:${boundary}:${'reason' in event ? event.reason : ''}`);
      }
    },
    callbacks: {
      emitToolUse: (tool) => callbackEvents.push(`tool_use:${tool.toolUseId}:${tool.status}`),
      emitToolResult: (result) => callbackEvents.push(`tool_result:${result.toolUseId}:${result.isError ? 'error' : 'ok'}`)
    },
    onTextDelta: (delta, accumulated) => callbackEvents.push(`text:${delta}:${accumulated}`)
  });

  adapter.observe({
    type: 'provider_step_started',
    reason: 'start'
  });
  adapter.observe({
    type: 'text_delta',
    delta: 'Hi',
    accumulated: 'Hi'
  });
  adapter.observe({
    type: 'tool_use',
    toolUseId: 'tool_1',
    toolName: 'read_file',
    input: {
      path: 'README.md'
    }
  });
  adapter.observe({
    type: 'tool_result',
    toolUseId: 'tool_1',
    toolName: 'read_file',
    content: 'ok'
  });
  adapter.observe({
    type: 'provider_step_done',
    finishReason: 'stop',
    toolCallCount: 0
  });

  assert.deepEqual(coreEvents, [
    'provider:step_started:start',
    'provider:step_streaming:Provider 正在流式输出文本。',
    'tool:execution_started:Provider 请求执行工具 read_file。',
    'tool:results_recorded:工具 read_file 返回结果。',
    'provider:step_collected:Provider step 完成，finishReason=stop，未返回工具调用。'
  ]);
  assert.deepEqual(callbackEvents, [
    'text:Hi:Hi',
    'tool_use:tool_1:running',
    'tool_result:tool_1:ok',
    'tool_use:tool_1:completed'
  ]);
});

test('provider runtime event to core mapper skips provider step completion with tool calls', () => {
  assert.equal(providerRuntimeEventToCoreEvent({
    type: 'provider_step_done',
    finishReason: 'tool_calls',
    toolCallCount: 2
  }), undefined);
});

test('provider runtime controller records provider and tool boundaries through ProviderRuntimeEvent', () => {
  const engine = createAgentCoreRunEngine({
    guardTransitions: true,
    initialState: 'initializing'
  });
  const controller = createProviderRuntimeController({
    submitEvent: engine.submitEvent,
    mapToolEventsToCore: false
  });

  const providerSnapshot = controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_provider_event_1',
        name: 'read_file',
        input: {
          path: 'README.md'
        }
      }]
    }
  });
  assert.equal(providerSnapshot.runController.nextAction, 'execute_tools');

  const toolSnapshot = controller.recordToolResult({
    toolResult: {
      toolUseId: 'tool_provider_event_1',
      toolName: 'read_file',
      content: 'ok'
    }
  });
  assert.equal(toolSnapshot.runController.nextAction, 'build_model_input');
});
