import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAiSdkStepState } from '../../electron/main/agent-platform/native/ai-sdk-step-state.ts';

test('AI SDK step state preserves tool transaction metadata for Run Controller', () => {
  const stepState = new NativeAiSdkStepState();
  stepState.beginStep();
  const toolCall = stepState.recordToolCall({
    toolCallId: 'call_read',
    toolName: 'read_file',
    rawInput: {
      path: 'README.md'
    }
  });
  stepState.recordToolResult({
    toolCallId: 'call_read',
    toolName: 'read_file',
    output: {
      summary: 'read README.md',
      changedFiles: [{
        path: 'README.md',
        operation: 'modified'
      }],
      terminal: {
        sessionId: 'terminal_1',
        status: 'running'
      }
    }
  });
  stepState.recordToolResultTransaction({
    toolCallId: 'call_read',
    transaction: {
      id: 'tool_txn:call_read',
      toolUseId: toolCall.toolUseId,
      toolName: 'read_file',
      toolClass: 'workspace',
      phase: 'completed',
      status: 'completed',
      eventCount: 3,
      startedAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:01.000Z'
    }
  });

  const [toolResult] = stepState.drainStepToolResults();
  assert.equal(toolResult?.toolUseId, 'call_read');
  assert.equal(toolResult?.changedFiles?.[0]?.path, 'README.md');
  assert.equal(toolResult?.terminal?.sessionId, 'terminal_1');
  assert.equal(toolResult?.transaction?.toolName, 'read_file');
  assert.equal(toolResult?.transaction?.eventCount, 3);
});
