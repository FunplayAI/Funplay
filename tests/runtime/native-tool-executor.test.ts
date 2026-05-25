import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeNativeWorkspaceToolSetTool,
  executeNativeWorkspaceToolTransaction,
  recordNativeWorkspaceToolTransactionResult
} from '../../electron/main/agent-platform/native/tool-executor.ts';

test('native tool executor runs a tool transaction with ordered callbacks', async () => {
  const events: string[] = [];
  const toolUses: Array<{ status: string; input?: Record<string, unknown> }> = [];
  const toolResults: Array<{ content: string; isError?: boolean; transactionStatus?: string; transactionPhase?: string; transactionClass?: string; transactionEventCount?: number }> = [];
  const tools = {
    read_file: {
      execute: async (input: Record<string, unknown>) => ({
        ok: true,
        summary: `read ${input.path}`,
        changedFiles: []
      })
    }
  };

  const transaction = await executeNativeWorkspaceToolTransaction({
    tools,
    toolUseId: 'tool_1',
    toolName: 'read_file',
    input: {
      path: 'README.md'
    },
    callbacks: {
      emitToolUse: (toolUse) => {
        events.push(`use:${toolUse.status}`);
        toolUses.push({
          status: toolUse.status,
          input: toolUse.input
        });
      },
      emitToolResult: (toolResult) => {
        events.push('result');
        toolResults.push({
          content: toolResult.content,
          isError: toolResult.isError,
          transactionStatus: toolResult.transaction?.status,
          transactionPhase: toolResult.transaction?.phase,
          transactionClass: toolResult.transaction?.toolClass,
          transactionEventCount: toolResult.transaction?.eventCount
        });
      }
    },
    hooks: {
      onStart: () => events.push('hook:start'),
      onResult: (_result, summary, transactionSummary) => events.push(`hook:result:${summary}:${transactionSummary.status}`)
    }
  });

  assert.equal(transaction.summary, 'read README.md');
  assert.equal(transaction.transaction.status, 'completed');
  assert.equal(transaction.transaction.phase, 'completed');
  assert.equal(transaction.transaction.toolClass, 'workspace');
  assert.equal(transaction.transaction.resultSource, 'executed');
  assert.equal(transaction.transaction.events.map((event) => event.type).join(','), 'created,validation_passed,execution_started,execution_completed');
  assert.deepEqual(events, [
    'hook:start',
    'use:running',
    'result',
    'hook:result:read README.md:completed',
    'use:completed'
  ]);
  assert.deepEqual(toolUses.map((toolUse) => toolUse.status), ['running', 'completed']);
  assert.equal(toolUses[0]?.input?.path, 'README.md');
  assert.deepEqual(toolResults, [
    {
      content: 'read README.md',
      isError: false,
      transactionStatus: 'completed',
      transactionPhase: 'completed',
      transactionClass: 'workspace',
      transactionEventCount: 4
    }
  ]);
});

test('native tool executor records validation failures and unknown tool errors', async () => {
  const precomputedEvents: string[] = [];
  const precomputed = recordNativeWorkspaceToolTransactionResult({
    toolUseId: 'tool_bad',
    toolName: 'multi_edit',
    input: {},
    resultSource: 'validation_failed',
    callbacks: {
      emitToolUse: (toolUse) => precomputedEvents.push(toolUse.status),
      emitToolResult: (toolResult) => precomputedEvents.push(toolResult.content)
    },
    toolResult: {
      ok: false,
      isError: true,
      failureKind: 'invalid_tool_input',
      recoveryHint: 'Provide at least one edit.',
      summary: 'invalid input'
    }
  });
  const unknown = await executeNativeWorkspaceToolSetTool({}, 'missing_tool', {});

  assert.equal(precomputed.summary, 'invalid input');
  assert.equal(precomputed.transaction.status, 'failed');
  assert.equal(precomputed.transaction.phase, 'failed');
  assert.equal(precomputed.transaction.resultSource, 'validation_failed');
  assert.equal(precomputed.transaction.toolClass, 'workspace');
  assert.equal(precomputed.transaction.error?.message, 'invalid input');
  assert.equal(precomputed.transaction.error?.failureKind, 'invalid_tool_input');
  assert.equal(precomputed.transaction.events.map((event) => event.type).join(','), 'created,validation_failed');
  assert.deepEqual(precomputedEvents, ['running', 'invalid input', 'failed']);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.isError, true);
  assert.match(unknown.summary ?? '', /未知工具/);
});

test('native tool executor classifies platform transaction tool classes', () => {
  const command = recordNativeWorkspaceToolTransactionResult({
    toolUseId: 'tool_command',
    toolName: 'run_command',
    input: {
      command: 'npm test'
    },
    toolResult: {
      ok: true,
      summary: 'command completed'
    }
  });
  const browser = recordNativeWorkspaceToolTransactionResult({
    toolUseId: 'tool_browser',
    toolName: 'browser_open',
    input: {
      url: 'http://localhost:3000'
    },
    toolResult: {
      ok: true,
      summary: 'browser opened'
    }
  });
  const mcp = recordNativeWorkspaceToolTransactionResult({
    toolUseId: 'tool_mcp',
    toolName: 'call_mcp_tool',
    input: {
      toolName: 'unity.echo'
    },
    toolResult: {
      ok: true,
      summary: 'mcp completed'
    }
  });

  assert.equal(command.transaction.toolClass, 'command');
  assert.equal(browser.transaction.toolClass, 'browser');
  assert.equal(mcp.transaction.toolClass, 'mcp');
});
