import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeEventSink } from '../../electron/main/agent-platform/runtime-event-sink.ts';
import type { StreamContext } from '../../electron/main/agent-platform/stream-types.ts';
import type { PromptStreamEvent } from '../../shared/types.ts';

function createContext(events: PromptStreamEvent[]): StreamContext {
  return {
    streamId: 'stream_1',
    projectId: 'project_1',
    sessionId: 'session_1',
    startedAt: '2026-05-20T00:00:00.000Z',
    controller: new AbortController(),
    activeRunId: 'missing_run',
    toolNamesByUseId: new Map(),
    dispatchEvent: (event) => {
      events.push(event);
    }
  };
}

test('runtime event sink carries runtime metadata from stages into status events', () => {
  const events: PromptStreamEvent[] = [];
  const sink = createRuntimeEventSink(createContext(events), {
    initialMetadata: {
      providerId: 'provider_old'
    }
  });

  sink.onStage({
    stageId: 'stage:provider',
    title: '选择 Provider',
    target: 'stage:provider',
    status: 'completed',
    runtimeId: 'native',
    providerId: 'provider_new',
    model: 'model_1',
    upstreamModel: 'upstream_1',
    diagnosticCode: 'ok'
  });
  sink.onStatus('streaming', '正在执行');

  const stage = events[0];
  const status = events[1];
  assert.equal(stage?.type, 'stage');
  assert.equal(stage?.type === 'stage' ? stage.providerId : undefined, 'provider_new');
  assert.equal(status?.type, 'status');
  assert.equal(status?.type === 'status' ? status.providerId : undefined, 'provider_new');
  assert.equal(status?.type === 'status' ? status.model : undefined, 'model_1');
  assert.deepEqual(sink.getMetadata(), {
    runtimeId: 'native',
    providerId: 'provider_new',
    model: 'model_1',
    upstreamModel: 'upstream_1',
    diagnosticCode: 'ok',
    severity: undefined,
    errorCode: undefined,
    suggestedAction: undefined,
    recoveryActions: undefined
  });
});

test('runtime event sink emits side stream events from selected stages', () => {
  const events: PromptStreamEvent[] = [];
  const sink = createRuntimeEventSink(createContext(events), {
    emitStageSideEvents: true
  });

  sink.onStage({
    stageId: 'stage:compact',
    phase: 'context_compressed',
    title: '压缩上下文',
    target: 'stage:compact',
    status: 'completed',
    summary: '上下文已压缩。',
    input: {
      boundaryOrdinal: 12,
      coveredMessageCount: 8
    }
  });

  assert.deepEqual(events.map((event) => event.type), ['stage', 'context_compressed']);
  const compressed = events[1];
  assert.equal(compressed?.type === 'context_compressed' ? compressed.boundaryOrdinal : undefined, 12);
  assert.equal(compressed?.type === 'context_compressed' ? compressed.coveredMessageCount : undefined, 8);
});

test('runtime event sink forwards authoritative Agent Core ledger parts to the stream', () => {
  const events: PromptStreamEvent[] = [];
  const sink = createRuntimeEventSink(createContext(events));

  sink.onAgentCoreParts([
    {
      id: 'part_1',
      kind: 'assistant_text',
      sequence: 0,
      createdAt: '2026-05-20T00:00:00.000Z',
      text: 'done'
    }
  ]);

  assert.equal(events[0]?.type, 'agent_core_parts');
  assert.equal(events[0]?.type === 'agent_core_parts' ? events[0].parts[0]?.id : undefined, 'part_1');
});
