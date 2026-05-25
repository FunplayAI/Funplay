import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGenericAgentRuntimeEventQueue,
  drainGenericAgentRuntimeEventQueue,
  executeGenericAgentRuntimeEventStream
} from '../../electron/main/agent-platform/runtime-event-stream.ts';
import { nativeRuntime } from '../../electron/main/agent-platform/native/runtime.ts';
import type {
  GenericAgentRuntime,
  GenericAgentRuntimeParams,
  GenericAgentRuntimeResult
} from '../../electron/main/agent-platform/types.ts';

function result(message = 'done'): GenericAgentRuntimeResult {
  return {
    assistantMessage: message,
    assistantIntent: 'chat',
    status: 'completed',
    steps: []
  };
}

async function collect(runtime: GenericAgentRuntime): Promise<string[]> {
  const events: string[] = [];
  for await (const event of executeGenericAgentRuntimeEventStream(runtime, {} as GenericAgentRuntimeParams)) {
    if (event.type === 'status') {
      events.push(`${event.type}:${event.message}`);
    } else if (event.type === 'text_delta') {
      events.push(`${event.type}:${event.accumulated}`);
    } else if (event.type === 'tool_use') {
      events.push(`${event.type}:${event.tool.name}`);
    } else if (event.type === 'usage') {
      events.push(`${event.type}:${event.usage.totalTokens}`);
    } else if (event.type === 'result') {
      events.push(`${event.type}:${event.result.assistantMessage}`);
    }
  }
  return events;
}

test('runtime event stream consumes the runtime-neutral executeEventStream entrypoint', async () => {
  const runtime = {
    id: 'native',
    executeEventStream: async function* () {
      yield {
        type: 'status',
        phase: 'streaming',
        message: '原生事件流'
      };
      yield {
        type: 'result',
        result: result('stream-result')
      };
    }
  } as GenericAgentRuntime;

  assert.deepEqual(await collect(runtime), [
    'status:原生事件流',
    'result:stream-result'
  ]);
});

test('native runtime exposes an event stream entrypoint', () => {
  assert.equal(typeof nativeRuntime.executeEventStream, 'function');
});

test('runtime event queue lets runtimes expose a native async generator without callback adapters', async () => {
  const events: string[] = [];
  const queue = createGenericAgentRuntimeEventQueue();

  void Promise.resolve()
    .then(() => {
      queue.push({
        type: 'status',
        phase: 'thinking',
        message: 'source-status'
      });
      queue.push({
        type: 'text_delta',
        delta: 'hi',
        accumulated: 'hi'
      });
      queue.push({
        type: 'tool_use',
        tool: {
          toolUseId: 'tool_1',
          name: 'read_file',
          status: 'running'
        }
      });
      queue.push({
        type: 'usage',
        usage: {
          inputTokens: 4,
          outputTokens: 5,
          totalTokens: 9,
          recordedAt: '2026-05-20T00:00:00.000Z'
        }
      });
      queue.push({
        type: 'result',
        result: result('direct-finished')
      });
      queue.close();
    });

  for await (const event of drainGenericAgentRuntimeEventQueue(queue)) {
    if (event.type === 'status') {
      events.push(`status:${event.message}`);
    } else if (event.type === 'text_delta') {
      events.push(`text:${event.accumulated}`);
    } else if (event.type === 'tool_use') {
      events.push(`tool:${event.tool.name}`);
    } else if (event.type === 'usage') {
      events.push(`usage:${event.usage.totalTokens}`);
    } else if (event.type === 'result') {
      events.push(`result:${event.result.assistantMessage}`);
    }
  }

  assert.deepEqual(events, [
    'status:source-status',
    'text:hi',
    'tool:read_file',
    'usage:9',
    'result:direct-finished'
  ]);
});
