import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSet } from 'ai';
import { ProjectInstructionTracker } from '../../electron/main/agent-platform/project-instruction-tracker.ts';
import type { NativeRuntimeToolDefinition } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import {
  createNativeOpenAiToolInvocations,
  executeNativeStreamingToolPlan
} from '../../electron/main/agent-platform/native/streaming-tool-executor.ts';
import { createNativeToolLoopState } from '../../electron/main/agent-platform/native/tool-loop-state.ts';
import type { NativeToolPool } from '../../electron/main/agent-platform/native/tool-pool.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function definition(name: string, readOnly: boolean): NativeRuntimeToolDefinition {
  return {
    name,
    readOnly
  } as NativeRuntimeToolDefinition;
}

function createToolPool(input: {
  definitions: NativeRuntimeToolDefinition[];
  toolSet: ToolSet;
}): NativeToolPool {
  return {
    definitions: input.definitions,
    names: input.definitions.map((item) => item.name),
    dynamicMcpTools: [],
    toolSet: input.toolSet,
    openAiCompatibleTools: [],
    refresh: async () => false
  };
}

test('native streaming tool executor runs concurrent-safe batch in parallel and replays results in call order', async () => {
  const state = createNativeToolLoopState([]);
  const resultEvents: string[] = [];
  const controllerEvents: string[] = [];
  let active = 0;
  let maxActive = 0;

  function readTool(name: string, ms: number) {
    return {
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(ms);
        active -= 1;
        return {
          ok: true,
          summary: `${name} done`
        };
      }
    };
  }

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_slow',
          name: 'read_slow',
          arguments: {}
        },
        {
          id: 'tool_fast',
          name: 'read_fast',
          arguments: {}
        }
      ]
    }),
    state,
    callbacks: {
      emitToolResult: (result) => {
        resultEvents.push(`${result.toolUseId}:${result.content}`);
      }
    },
    toolPool: createToolPool({
      definitions: [
        definition('read_slow', true),
        definition('read_fast', true)
      ],
      toolSet: {
        read_slow: readTool('slow', 30),
        read_fast: readTool('fast', 1)
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: (result) => {
      controllerEvents.push(`${result.toolUseId}:${result.content}`);
    }
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(resultEvents, [
    'tool_slow:slow done',
    'tool_fast:fast done'
  ]);
  assert.deepEqual(controllerEvents, resultEvents);
  assert.deepEqual(state.messages.map((message) => message.role === 'tool' ? `${message.toolCallId}:${message.content}` : ''), [
    'tool_slow:slow done',
    'tool_fast:fast done'
  ]);
});

test('native streaming tool executor emits tool presentation from tool contract metadata', async () => {
  const state = createNativeToolLoopState([]);
  const toolUses: Array<{ title?: string; summary?: string; activity?: string }> = [];

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_read',
          name: 'read_file',
          arguments: {
            path: 'README.md'
          }
        }
      ]
    }),
    state,
    callbacks: {
      emitToolUse: (tool) => {
        if (tool.status === 'running') {
          toolUses.push({
            title: tool.title,
            summary: tool.summary,
            activity: tool.activity
          });
        }
      }
    },
    toolPool: createToolPool({
      definitions: [
        {
          ...definition('read_file', true),
          title: 'Read File',
          getToolUseSummary: (input) => `Read ${String(input?.path ?? '')}`,
          getActivityDescription: (input) => `Reading ${String(input?.path ?? '')}`
        }
      ],
      toolSet: {
        read_file: {
          execute: async () => ({
            ok: true,
            summary: 'done'
          })
        }
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: () => undefined
  });

  assert.deepEqual(toolUses, [
    {
      title: 'Read File',
      summary: 'Read README.md',
      activity: 'Reading README.md'
    }
  ]);
});

test('native streaming tool executor keeps exclusive tools serialized after safe batches', async () => {
  const state = createNativeToolLoopState([]);
  const timeline: string[] = [];
  let active = 0;
  let maxActive = 0;

  function tool(name: string, ms: number) {
    return {
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        timeline.push(`start:${name}`);
        await delay(ms);
        timeline.push(`finish:${name}`);
        active -= 1;
        return {
          ok: true,
          summary: `${name} done`
        };
      }
    };
  }

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_read',
          name: 'read_file',
          arguments: {}
        },
        {
          id: 'tool_write',
          name: 'write_file',
          arguments: {}
        }
      ]
    }),
    state,
    toolPool: createToolPool({
      definitions: [
        definition('read_file', true),
        definition('write_file', false)
      ],
      toolSet: {
        read_file: tool('read_file', 5),
        write_file: tool('write_file', 5)
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: () => undefined
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(timeline, [
    'start:read_file',
    'finish:read_file',
    'start:write_file',
    'finish:write_file'
  ]);
});

test('native streaming tool executor converts thrown tool errors into ordered synthetic results', async () => {
  const state = createNativeToolLoopState([]);
  const resultEvents: string[] = [];
  const controllerFailures: Array<string | undefined> = [];
  const controllerSources: Array<string | undefined> = [];

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_bad',
          name: 'read_bad',
          arguments: {}
        },
        {
          id: 'tool_good',
          name: 'read_good',
          arguments: {}
        }
      ]
    }),
    state,
    callbacks: {
      emitToolResult: (result) => {
        resultEvents.push(`${result.toolUseId}:${result.isError ? 'error' : 'ok'}:${result.content}`);
      }
    },
    toolPool: createToolPool({
      definitions: [
        definition('read_bad', true),
        definition('read_good', true)
      ],
      toolSet: {
        read_bad: {
          execute: async () => {
            throw new Error('read failed');
          }
        },
        read_good: {
          execute: async () => ({
            ok: true,
            summary: 'good done'
          })
        }
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: (result) => {
      controllerFailures.push(result.failureKind);
      controllerSources.push(result.transaction?.resultSource);
    }
  });

  assert.equal(resultEvents.length, 2);
  assert.match(resultEvents[0] ?? '', /tool_bad:error:\[Error]\nTool execution failed before returning a result\.\nCause: read failed/);
  assert.equal(resultEvents[1], 'tool_good:ok:good done');
  const modelToolMessages = state.messages.map((message) => message.role === 'tool' ? `${message.toolCallId}:${message.content}` : '');
  assert.match(modelToolMessages[0] ?? '', /tool_bad:\[Error\]\nTool execution failed before returning a result\.\nCause: read failed/);
  assert.match(modelToolMessages[0] ?? '', /Failure kind: tool_execution_failed/);
  assert.match(modelToolMessages[0] ?? '', /Recovery hint: Inspect the tool input/);
  assert.equal(modelToolMessages[1], 'tool_good:good done');
  assert.deepEqual(controllerFailures, ['tool_execution_failed', undefined]);
  assert.deepEqual(controllerSources, ['synthetic_failure', 'executed']);
});

test('native streaming tool executor records malformed arguments as validation failures without executing tools', async () => {
  const state = createNativeToolLoopState([]);
  const transactions: Array<{ source?: string; phase?: string; eventCount?: number; failureKind?: string }> = [];
  let executed = false;

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_bad_json',
          name: 'read_file',
          arguments: {},
          rawArguments: '{"path":',
          argumentsParseError: 'Unexpected end of JSON input'
        }
      ]
    }),
    state,
    toolPool: createToolPool({
      definitions: [
        definition('read_file', true)
      ],
      toolSet: {
        read_file: {
          execute: async () => {
            executed = true;
            return {
              ok: true,
              summary: 'should not run'
            };
          }
        }
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: (result) => {
      transactions.push({
        source: result.transaction?.resultSource,
        phase: result.transaction?.phase,
        eventCount: result.transaction?.eventCount,
        failureKind: result.failureKind
      });
    }
  });

  assert.equal(executed, false);
  assert.equal(state.messages[0]?.role, 'tool');
  assert.match(state.messages[0]?.role === 'tool' ? state.messages[0].content : '', /工具调用参数 JSON 无法解析/);
  assert.deepEqual(transactions, [
    {
      source: 'validation_failed',
      phase: 'failed',
      eventCount: 2,
      failureKind: 'invalid_arguments'
    }
  ]);
});

test('native streaming tool executor replays duplicate tool results as cached transactions', async () => {
  const state = createNativeToolLoopState([]);
  state.completedToolResultsByUseId.set('tool_cached', {
    name: 'read_file',
    summary: 'cached result',
    isError: false
  });
  const transactions: Array<{ source?: string; phase?: string; eventCount?: number }> = [];
  let executed = false;

  await executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      stepIndex: 0,
      toolCalls: [
        {
          id: 'tool_cached',
          name: 'read_file',
          arguments: {
            path: 'README.md'
          }
        }
      ]
    }),
    state,
    toolPool: createToolPool({
      definitions: [
        definition('read_file', true)
      ],
      toolSet: {
        read_file: {
          execute: async () => {
            executed = true;
            return {
              ok: true,
              summary: 'fresh result'
            };
          }
        }
      } as ToolSet
    }),
    instructionTracker: {
      discoverFromToolInput: () => []
    } as unknown as ProjectInstructionTracker,
    recordRunControllerToolResult: (result) => {
      transactions.push({
        source: result.transaction?.resultSource,
        phase: result.transaction?.phase,
        eventCount: result.transaction?.eventCount
      });
    }
  });

  assert.equal(executed, false);
  assert.equal(state.messages[0]?.role === 'tool' ? state.messages[0].content : '', 'cached result');
  assert.deepEqual(transactions, [
    {
      source: 'cached',
      phase: 'completed',
      eventCount: 2
    }
  ]);
});

test('native streaming tool executor emits interrupted synthetic results and rethrows aborts', async () => {
  const state = createNativeToolLoopState([]);
  const abortError = new Error('user stopped');
  abortError.name = 'AbortError';

  await assert.rejects(
    executeNativeStreamingToolPlan({
      invocations: createNativeOpenAiToolInvocations({
        stepIndex: 0,
        toolCalls: [
          {
            id: 'tool_abort',
            name: 'read_abort',
            arguments: {}
          }
        ]
      }),
      state,
      toolPool: createToolPool({
        definitions: [
          definition('read_abort', true)
        ],
        toolSet: {
          read_abort: {
            execute: async () => {
              throw abortError;
            }
          }
        } as ToolSet
      }),
      instructionTracker: {
        discoverFromToolInput: () => []
      } as unknown as ProjectInstructionTracker,
      recordRunControllerToolResult: () => undefined
    }),
    /user stopped/
  );

  const result = state.messages.find((message) => message.role === 'tool');
  assert.match(result?.role === 'tool' ? result.content : '', /Tool execution was interrupted before returning a result/);
});
