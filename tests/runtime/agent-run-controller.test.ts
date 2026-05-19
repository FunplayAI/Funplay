import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunController } from '../../electron/main/agent-platform/agent-run-controller.ts';
import type { AgentCoreMessagePart } from '../../shared/types.ts';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-05-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function getToolCallStatus(parts: AgentCoreMessagePart[], toolUseId: string): string | undefined {
  const part = parts.find((entry) => entry.kind === 'tool_call' && entry.toolUseId === toolUseId);
  return part?.kind === 'tool_call' ? part.status : undefined;
}

test('Agent Run Controller continues when provider stop contains tool calls', () => {
  const controller = createAgentRunController({
    runId: 'run_controller_1',
    turnId: 'turn_controller_1',
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      text: 'I will inspect the file.',
      finishReason: 'stop',
      toolCalls: [{
        toolUseId: 'tool_read_1',
        providerCallId: 'call_read_1',
        name: 'read_file',
        input: {
          path: 'README.md'
        }
      }]
    }
  });

  assert.equal(snapshot.nextAction, 'execute_tools');
  assert.equal(snapshot.lastDecision?.terminal, false);
  assert.equal(snapshot.coreState.state, 'executing_tools');
  assert.deepEqual(snapshot.pendingToolUseIds, ['tool_read_1']);
  assert.equal(snapshot.parts.some((part) => part.kind === 'assistant_text'), true);
  assert.equal(snapshot.parts.some((part) => part.kind === 'tool_call'), true);
});

test('Agent Run Controller records tool results and returns to model input build', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_read_1',
        name: 'read_file',
        input: {
          path: 'README.md'
        }
      }]
    }
  });
  const snapshot = controller.recordToolResult({
    toolUseId: 'tool_read_1',
    toolName: 'read_file',
    content: 'README content'
  });

  assert.equal(snapshot.nextAction, 'build_model_input');
  assert.equal(snapshot.coreState.state, 'building_model_input');
  assert.deepEqual(snapshot.pendingToolUseIds, []);
  assert.deepEqual(snapshot.completedToolUseIds, ['tool_read_1']);
  assert.equal(snapshot.parts.at(-1)?.kind, 'tool_result');
  assert.equal(getToolCallStatus(snapshot.parts, 'tool_read_1'), 'completed');
});

test('Agent Run Controller records provider usage as canonical parts', () => {
  const controller = createAgentRunController({
    runId: 'run_usage',
    turnId: 'turn_usage',
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      text: 'Done.',
      finishReason: 'stop',
      toolCalls: [],
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 4,
        totalTokens: 20,
        provider: 'provider_test',
        model: 'model_test',
        recordedAt: '2026-05-16T01:00:00.000Z'
      }
    }
  });
  const usagePart = snapshot.parts.find((part) => part.kind === 'usage');
  const finalText = snapshot.parts.at(-1);

  assert.equal(snapshot.nextAction, 'complete');
  assert.equal(usagePart?.kind, 'usage');
  assert.equal(usagePart?.kind === 'usage' ? usagePart.usage.totalTokens : undefined, 20);
  assert.equal(usagePart?.kind === 'usage' ? usagePart.usage.provider : undefined, 'provider_test');
  assert.equal(usagePart?.createdAt, '2026-05-16T01:00:00.000Z');
  assert.equal(finalText?.kind, 'assistant_text');
  assert.equal(finalText?.kind === 'assistant_text' ? finalText.final : undefined, true);
});

test('Agent Run Controller preserves structured tool result and error metadata', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [
        {
          toolUseId: 'tool_mcp_ok',
          name: 'read_resource',
          input: {
            uri: 'unity://project/context'
          }
        },
        {
          toolUseId: 'tool_mcp_failed',
          name: 'call_tool',
          input: {
            name: 'unity.bad'
          }
        }
      ]
    }
  });
  controller.recordToolResult({
    toolUseId: 'tool_mcp_ok',
    toolName: 'read_resource',
    content: 'resource ok',
    mcp: {
      pluginId: 'plugin_unity',
      pluginKind: 'engine',
      operation: 'read_resource',
      target: 'unity://project/context',
      timeoutMs: 60000,
      contentPartCount: 1,
      schemaGuard: 'passed'
    },
    transaction: {
      id: 'tool_txn:tool_mcp_ok',
      toolUseId: 'tool_mcp_ok',
      toolName: 'read_resource',
      toolClass: 'mcp',
      phase: 'completed',
      status: 'completed',
      eventCount: 3,
      startedAt: '2026-05-16T00:00:10.000Z',
      updatedAt: '2026-05-16T00:00:11.000Z'
    }
  });
  const snapshot = controller.recordToolResult({
    toolUseId: 'tool_mcp_failed',
    toolName: 'call_tool',
    content: 'MCP call failed',
    isError: true,
    mcp: {
      pluginId: 'plugin_unity',
      pluginKind: 'engine',
      operation: 'call_tool',
      target: 'unity.bad',
      timeoutMs: 60000,
      schemaGuard: 'failed',
      failureKind: 'unknown'
    },
    transaction: {
      id: 'tool_txn:tool_mcp_failed',
      toolUseId: 'tool_mcp_failed',
      toolName: 'call_tool',
      toolClass: 'mcp',
      phase: 'failed',
      status: 'failed',
      eventCount: 3,
      startedAt: '2026-05-16T00:00:12.000Z',
      updatedAt: '2026-05-16T00:00:13.000Z'
    }
  });
  const okPart = snapshot.parts.find((part) => part.kind === 'tool_result' && part.toolUseId === 'tool_mcp_ok');
  const failedPart = snapshot.parts.find((part) => part.kind === 'tool_error' && part.toolUseId === 'tool_mcp_failed');

  assert.equal(okPart?.kind === 'tool_result' ? okPart.mcp?.target : undefined, 'unity://project/context');
  assert.equal(okPart?.kind === 'tool_result' ? okPart.mcp?.contentPartCount : undefined, 1);
  assert.equal(okPart?.kind === 'tool_result' ? okPart.transaction?.toolClass : undefined, 'mcp');
  assert.equal(failedPart?.kind === 'tool_error' ? failedPart.mcp?.target : undefined, 'unity.bad');
  assert.equal(failedPart?.kind === 'tool_error' ? failedPart.mcp?.failureKind : undefined, 'unknown');
  assert.equal(failedPart?.kind === 'tool_error' ? failedPart.transaction?.phase : undefined, 'failed');
});

test('Agent Run Controller represents permission waits as structured pause parts', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_write_1',
        name: 'write_file',
        input: {
          path: 'index.html'
        }
      }]
    },
    pendingPermission: {
      requestId: 'perm_write_1',
      toolName: 'write_file',
      risk: 'high',
      reason: '写入 index.html 需要用户确认。',
      impact: {
        paths: ['index.html']
      }
    }
  });
  const permissionPart = snapshot.parts.find((part) => part.kind === 'permission_request');

  assert.equal(snapshot.nextAction, 'request_permission');
  assert.equal(snapshot.coreState.state, 'awaiting_permission');
  assert.equal(permissionPart?.kind, 'permission_request');
  assert.equal(permissionPart?.requestId, 'perm_write_1');
  assert.equal(permissionPart?.toolName, 'write_file');
  assert.deepEqual(snapshot.pendingToolUseIds, ['tool_write_1']);
});

test('Agent Run Controller records permission denial as tool error for continuation', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_write_denied',
        name: 'write_file',
        input: {
          path: 'index.html'
        }
      }]
    },
    pendingPermission: {
      requestId: 'perm_write_denied',
      toolName: 'write_file',
      risk: 'high'
    }
  });
  const snapshot = controller.recordPermissionDenied({
    toolUseId: 'tool_write_denied',
    toolName: 'write_file',
    content: '用户拒绝了写入权限。',
    recoveryHint: '改为只读说明或询问用户下一步。'
  });
  const toolError = snapshot.parts.at(-1);

  assert.equal(snapshot.nextAction, 'build_model_input');
  assert.equal(snapshot.coreState.state, 'building_model_input');
  assert.deepEqual(snapshot.pendingToolUseIds, []);
  assert.deepEqual(snapshot.completedToolUseIds, ['tool_write_denied']);
  assert.equal(toolError?.kind, 'tool_error');
  assert.equal(toolError?.kind === 'tool_error' ? toolError.failureKind : undefined, 'permission_denied');
  assert.equal(toolError?.kind === 'tool_error' ? toolError.error : undefined, '用户拒绝了写入权限。');
  assert.equal(getToolCallStatus(snapshot.parts, 'tool_write_denied'), 'failed');
});

test('Agent Run Controller records permission approval as a structured tool result', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_write_approved',
        name: 'write_file',
        input: {
          path: 'index.html'
        }
      }]
    },
    pendingPermission: {
      requestId: 'perm_write_approved',
      toolName: 'write_file',
      risk: 'high'
    }
  });
  const snapshot = controller.recordPermissionApproved({
    toolUseId: 'tool_write_approved',
    toolName: 'write_file',
    content: '用户允许了写入权限。'
  });
  const toolResult = snapshot.parts.at(-1);

  assert.equal(snapshot.nextAction, 'build_model_input');
  assert.equal(snapshot.coreState.state, 'building_model_input');
  assert.deepEqual(snapshot.pendingToolUseIds, []);
  assert.deepEqual(snapshot.completedToolUseIds, ['tool_write_approved']);
  assert.equal(toolResult?.kind, 'tool_result');
  assert.equal(toolResult?.kind === 'tool_result' ? toolResult.content : undefined, '用户允许了写入权限。');
});

test('Agent Run Controller keeps recording state until all parallel tool results arrive', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [
        {
          toolUseId: 'tool_read_1',
          name: 'read_file',
          input: {
            path: 'README.md'
          }
        },
        {
          toolUseId: 'tool_read_2',
          name: 'read_file',
          input: {
            path: 'package.json'
          }
        }
      ]
    }
  });
  const first = controller.recordToolResult({
    toolUseId: 'tool_read_1',
    toolName: 'read_file',
    content: 'README content'
  });
  const second = controller.recordToolResult({
    toolUseId: 'tool_read_2',
    toolName: 'read_file',
    content: 'package content'
  });

  assert.equal(first.nextAction, 'execute_tools');
  assert.equal(first.coreState.state, 'recording_tool_results');
  assert.deepEqual(first.pendingToolUseIds, ['tool_read_2']);
  assert.equal(getToolCallStatus(first.parts, 'tool_read_1'), 'completed');
  assert.equal(getToolCallStatus(first.parts, 'tool_read_2'), 'pending');
  assert.equal(second.nextAction, 'build_model_input');
  assert.equal(second.coreState.state, 'building_model_input');
  assert.deepEqual(second.completedToolUseIds, ['tool_read_1', 'tool_read_2']);
});

test('Agent Run Controller finalizes pending tools as errors on resumable interruption', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [
        {
          toolUseId: 'tool_done',
          name: 'read_file',
          input: {
            path: 'README.md'
          }
        },
        {
          toolUseId: 'tool_pending',
          name: 'write_file',
          input: {
            path: 'index.html'
          }
        }
      ]
    }
  });
  controller.recordToolResult({
    toolUseId: 'tool_done',
    toolName: 'read_file',
    content: 'README content'
  });
  const interrupted = controller.interruptResumable({
    reason: 'App restarted during tool execution.',
    recoveryHint: 'Resume from the next stable provider replay.'
  });
  const lastPart = interrupted.parts.at(-1);

  assert.equal(interrupted.nextAction, 'interrupt_resumable');
  assert.equal(interrupted.coreState.state, 'interrupted_resumable');
  assert.deepEqual(interrupted.pendingToolUseIds, []);
  assert.deepEqual(interrupted.completedToolUseIds, ['tool_done', 'tool_pending']);
  assert.equal(lastPart?.kind, 'tool_error');
  assert.equal(lastPart?.kind === 'tool_error' ? lastPart.toolUseId : undefined, 'tool_pending');
  assert.equal(lastPart?.kind === 'tool_error' ? lastPart.failureKind : undefined, 'interrupted');
  assert.equal(getToolCallStatus(interrupted.parts, 'tool_pending'), 'failed');
});

test('Agent Run Controller finalizes pending permission waits on resumable interruption', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_write_waiting',
        name: 'write_file',
        input: {
          path: 'index.html'
        }
      }]
    },
    pendingPermission: {
      requestId: 'perm_write_waiting',
      toolName: 'write_file',
      risk: 'high'
    }
  });
  const interrupted = controller.interruptResumable({
    reason: 'Permission prompt was interrupted by app shutdown.'
  });
  const lastPart = interrupted.parts.at(-1);

  assert.equal(interrupted.nextAction, 'interrupt_resumable');
  assert.equal(interrupted.coreState.state, 'interrupted_resumable');
  assert.deepEqual(interrupted.pendingToolUseIds, []);
  assert.deepEqual(interrupted.completedToolUseIds, ['tool_write_waiting']);
  assert.equal(lastPart?.kind, 'tool_error');
  assert.equal(lastPart?.kind === 'tool_error' ? lastPart.failureKind : undefined, 'interrupted');
});

test('Agent Run Controller ignores duplicate completed tool result ids exactly once', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  controller.recordProviderStep({
    providerStep: {
      finishReason: 'tool_calls',
      toolCalls: [{
        toolUseId: 'tool_read_1',
        name: 'read_file',
        input: {
          path: 'README.md'
        }
      }]
    }
  });
  controller.recordToolResult({
    toolUseId: 'tool_read_1',
    toolName: 'read_file',
    content: 'README content'
  });
  const partCountAfterFirstResult = controller.getSnapshot().parts.length;
  const duplicate = controller.recordToolResult({
    toolUseId: 'tool_read_1',
    toolName: 'read_file',
    content: 'README content replayed'
  });

  assert.equal(duplicate.nextAction, 'build_model_input');
  assert.equal(duplicate.coreState.state, 'building_model_input');
  assert.deepEqual(duplicate.completedToolUseIds, ['tool_read_1']);
  assert.equal(duplicate.parts.length, partCountAfterFirstResult);
  assert.equal(duplicate.parts.filter((part) => part.kind === 'tool_result' && part.toolUseId === 'tool_read_1').length, 1);
});

test('Agent Run Controller supports host-forced continuation after no-tool text', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      text: 'Now I will write game.js.',
      finishReason: 'stop',
      toolCalls: []
    },
    forceContinuation: {
      reason: 'partial_write',
      detail: 'Assistant promised more file writes.'
    }
  });

  assert.equal(snapshot.nextAction, 'build_model_input');
  assert.equal(snapshot.coreState.state, 'building_model_input');
  assert.equal(snapshot.lastDecision?.terminal, false);
  assert.match(snapshot.lastDecision?.reason ?? '', /partial_write/);
  assert.equal(snapshot.parts.at(-1)?.kind === 'assistant_text' ? snapshot.parts.at(-1)?.final : undefined, false);
});

test('Agent Run Controller owns context compression trigger and summary recording', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const compacting = controller.requestContextCompression('Token budget crossed 80%.');
  const summarized = controller.recordContextSummary({
    summary: 'Earlier work compressed.',
    structured: {
      goal: 'Build the runtime loop',
      completedWork: ['Controller integrated'],
      unfinishedWork: ['Replay UI parity'],
      changedFiles: ['electron/main/agent-platform/agent-run-controller.ts'],
      decisions: ['Host owns permissions'],
      constraints: ['No prompt-level authority'],
      failedTools: ['edit_file context mismatch'],
      nextStep: 'Resume from stable cursor'
    },
    coverage: {
      strategy: 'structured'
    }
  });
  const summaryPart = summarized.parts.at(-1);

  assert.equal(compacting.nextAction, 'compact_context');
  assert.equal(compacting.coreState.state, 'compacting_context');
  assert.equal(summarized.nextAction, 'build_model_input');
  assert.equal(summarized.coreState.state, 'building_model_input');
  assert.equal(summaryPart?.kind, 'context_summary');
  assert.equal(summaryPart?.kind === 'context_summary' ? summaryPart.structured?.nextStep : undefined, 'Resume from stable cursor');
});

test('Agent Run Controller completes only on no-tool stop with final text', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      text: 'Done.',
      finishReason: 'stop',
      toolCalls: []
    }
  });

  assert.equal(snapshot.nextAction, 'complete');
  assert.equal(snapshot.coreState.state, 'completed');
  assert.equal(snapshot.lastDecision?.terminal, true);
  assert.equal(snapshot.parts.at(-1)?.kind, 'assistant_text');
  assert.equal(snapshot.parts.at(-1)?.kind === 'assistant_text' ? snapshot.parts.at(-1)?.final : undefined, true);
});

test('Agent Run Controller fails visible no-tool text when finish reason is not stop', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      text: 'Partially blocked.',
      finishReason: 'content_filter',
      toolCalls: []
    }
  });

  assert.equal(snapshot.nextAction, 'fail');
  assert.equal(snapshot.coreState.state, 'failed');
  assert.equal(snapshot.lastDecision?.terminal, true);
  assert.equal(snapshot.parts.at(-1)?.kind === 'assistant_text' ? snapshot.parts.at(-1)?.final : undefined, false);
});

test('Agent Run Controller records provider errors as structured run error parts', () => {
  const controller = createAgentRunController({
    createdAt: fixedClock()
  });
  controller.start();
  const snapshot = controller.recordProviderStep({
    providerStep: {
      finishReason: 'error',
      toolCalls: []
    },
    error: 'Provider request failed.'
  });
  const runError = snapshot.parts.at(-1);

  assert.equal(snapshot.nextAction, 'fail');
  assert.equal(snapshot.coreState.state, 'failed');
  assert.equal(runError?.kind, 'run_error');
  assert.equal(runError?.kind === 'run_error' ? runError.error : undefined, 'Provider request failed.');
  assert.equal(runError?.kind === 'run_error' ? runError.diagnosticCode : undefined, 'provider_step_error');
});
