import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emitRuntimeLifecycleHook,
  emitRuntimeStatus,
  emitRuntimeTextDelta,
  emitRuntimeThinkingDelta,
  emitRuntimeUsage
} from '../../electron/main/agent-platform/runtime-event-emitter.ts';
import type { GenericAgentRuntimeOutputEvent, GenericAgentRuntimeParams } from '../../electron/main/agent-platform/types.ts';

test('runtime event emitter writes source events and legacy callbacks', () => {
  const events: string[] = [];
  const callbacks: string[] = [];
  const params = {
    emitRuntimeEvent: (event: GenericAgentRuntimeOutputEvent) => {
      events.push(event.type);
    },
    onStatus: (_phase, message) => {
      callbacks.push(`status:${message}`);
    },
    onTextDelta: (_delta, accumulated) => {
      callbacks.push(`text:${accumulated}`);
    },
    onThinkingDelta: (_delta, accumulated) => {
      callbacks.push(`thinking:${accumulated}`);
    },
    onUsage: (usage) => {
      callbacks.push(`usage:${usage.totalTokens}`);
    },
    onLifecycleHook: (hook) => {
      callbacks.push(`hook:${hook.id}`);
    }
  } as GenericAgentRuntimeParams;

  emitRuntimeStatus(params, 'thinking', '准备');
  emitRuntimeTextDelta(params, 'hi', 'hi');
  emitRuntimeThinkingDelta(params, 'plan', 'plan');
  emitRuntimeUsage(params, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    recordedAt: '2026-05-20T00:00:00.000Z'
  });
  emitRuntimeLifecycleHook(params, {
    id: 'hook_1',
    ruleId: 'rule_1',
    event: 'Stop',
    actionType: 'audit',
    status: 'matched',
    summary: 'ok',
    trigger: {
      event: 'Stop'
    }
  });

  assert.deepEqual(events, [
    'status',
    'text_delta',
    'thinking_delta',
    'usage',
    'lifecycle_hook'
  ]);
  assert.deepEqual(callbacks, [
    'status:准备',
    'text:hi',
    'thinking:plan',
    'usage:3',
    'hook:hook_1'
  ]);
});
