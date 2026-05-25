import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { NativeRuntimeToolDefinition } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import { createNativeToolExecutionPlan } from '../../electron/main/agent-platform/native/tool-execution-plan.ts';
import type { NativeOpenAiToolInvocation } from '../../electron/main/agent-platform/native/tool-loop-state.ts';

function invocation(name: string, id: string): NativeOpenAiToolInvocation {
  return {
    toolCall: {
      id,
      name,
      arguments: {}
    },
    toolUseId: id,
    stepIndex: 0,
    started: false,
    completed: false
  };
}

function definition(name: string, readOnly: boolean): NativeRuntimeToolDefinition {
  return {
    name,
    readOnly
  } as NativeRuntimeToolDefinition;
}

function definitionWithConcurrency(
  name: string,
  readOnly: boolean,
  isConcurrencySafe: NativeRuntimeToolDefinition['isConcurrencySafe']
): NativeRuntimeToolDefinition {
  return {
    name,
    readOnly,
    isConcurrencySafe
  } as NativeRuntimeToolDefinition;
}

test('native tool execution plan batches adjacent read-only tools and isolates unsafe tools', () => {
  const plan = createNativeToolExecutionPlan({
    invocations: [
      invocation('read_file', 'tool_1'),
      invocation('search_project_content', 'tool_2'),
      invocation('write_file', 'tool_3'),
      invocation('inspect_workspace_context', 'tool_4'),
      invocation('unknown_dynamic_tool', 'tool_5')
    ],
    definitions: [
      definition('read_file', true),
      definition('search_project_content', true),
      definition('write_file', false),
      definition('inspect_workspace_context', true)
    ]
  });

  assert.deepEqual(plan.batches.map((batch) => batch.mode), [
    'concurrent_safe',
    'exclusive',
    'concurrent_safe',
    'exclusive'
  ]);
  assert.deepEqual(plan.batches.map((batch) => batch.invocations.map((item) => item.toolUseId)), [
    ['tool_1', 'tool_2'],
    ['tool_3'],
    ['tool_4'],
    ['tool_5']
  ]);
});

test('native tool execution plan lets tool contracts override read-only concurrency safety', () => {
  const plan = createNativeToolExecutionPlan({
    invocations: [
      invocation('read_but_global_cache', 'tool_1'),
      invocation('write_dry_run', 'tool_2'),
      invocation('read_file', 'tool_3')
    ],
    definitions: [
      definitionWithConcurrency('read_but_global_cache', true, () => false),
      definitionWithConcurrency('write_dry_run', false, () => true),
      definition('read_file', true)
    ]
  });

  assert.deepEqual(plan.batches.map((batch) => batch.mode), [
    'exclusive',
    'concurrent_safe'
  ]);
  assert.deepEqual(plan.batches.map((batch) => batch.invocations.map((item) => item.toolUseId)), [
    ['tool_1'],
    ['tool_2', 'tool_3']
  ]);
});

test('native tool execution plan treats throwing concurrency predicates as unsafe', () => {
  const plan = createNativeToolExecutionPlan({
    invocations: [
      invocation('unstable_tool', 'tool_1'),
      invocation('read_file', 'tool_2')
    ],
    definitions: [
      definitionWithConcurrency('unstable_tool', true, () => {
        throw new Error('cannot inspect input');
      }),
      definition('read_file', true)
    ]
  });

  assert.deepEqual(plan.batches.map((batch) => batch.mode), [
    'exclusive',
    'concurrent_safe'
  ]);
});

test('native tool execution plan isolates duplicate tool use ids even for read-only tools', () => {
  const plan = createNativeToolExecutionPlan({
    invocations: [
      invocation('read_file', 'tool_same'),
      invocation('search_project_content', 'tool_same'),
      invocation('inspect_workspace_context', 'tool_next')
    ],
    definitions: [
      definition('read_file', true),
      definition('search_project_content', true),
      definition('inspect_workspace_context', true)
    ]
  });

  assert.deepEqual(plan.batches.map((batch) => batch.mode), [
    'concurrent_safe',
    'exclusive',
    'concurrent_safe'
  ]);
  assert.deepEqual(plan.batches.map((batch) => batch.invocations.map((item) => item.toolUseId)), [
    ['tool_same'],
    ['tool_same'],
    ['tool_next']
  ]);
});
