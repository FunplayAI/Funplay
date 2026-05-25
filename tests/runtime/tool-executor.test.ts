import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceToolExecutorTransaction,
  cancelToolExecutorTransaction,
  completeToolExecutorTransaction,
  createToolExecutorTransactionSummary,
  createToolExecutorTransaction,
  failToolExecutorTransaction,
  normalizeToolExecutorTransactionResult,
  summarizeToolExecutorTransaction,
  toolExecutorTransactionToAgentCorePart
} from '../../electron/main/agent-platform/tool-executor.ts';

test('tool executor transaction records host-owned lifecycle events', () => {
  const created = createToolExecutorTransaction({
    id: 'txn_write',
    runId: 'run_1',
    turnId: 'turn_1',
    toolUseId: 'tool_write',
    providerCallId: 'call_write',
    toolName: 'write_file',
    toolClass: 'workspace',
    input: {
      path: 'index.html'
    },
    permission: {
      policy: 'ask',
      risk: 'high'
    },
    checkpoint: {
      policy: 'before_write',
      status: 'pending'
    },
    timeoutMs: 30000,
    createdAt: '2026-05-16T00:00:00.000Z'
  });
  const validating = advanceToolExecutorTransaction(created, {
    phase: 'validating',
    eventType: 'validation_passed',
    summary: 'Input accepted.',
    createdAt: '2026-05-16T00:00:01.000Z'
  });
  const executing = advanceToolExecutorTransaction(validating, {
    phase: 'executing',
    eventType: 'execution_started',
    summary: 'Executing write_file.',
    createdAt: '2026-05-16T00:00:02.000Z'
  });
  const completed = completeToolExecutorTransaction(executing, {
    content: '已写入 index.html。',
    changedFiles: [{
      path: 'index.html',
      operation: 'modified'
    }]
  }, {
    createdAt: '2026-05-16T00:00:03.000Z'
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.events.map((event) => event.type).join(','), 'created,validation_passed,execution_started,execution_completed');
  assert.equal(completed.result?.changedFiles?.[0]?.path, 'index.html');
  const transactionSummary = createToolExecutorTransactionSummary(completed);
  assert.equal(transactionSummary.toolUseId, 'tool_write');
  assert.equal(transactionSummary.toolClass, 'workspace');
  assert.equal(transactionSummary.status, 'completed');
  assert.equal(transactionSummary.phase, 'completed');
  assert.equal(transactionSummary.eventCount, 4);
  assert.equal(transactionSummary.permission?.policy, 'ask');
  assert.equal(transactionSummary.checkpoint?.status, 'pending');
  assert.match(summarizeToolExecutorTransaction(completed), /workspace:write_file/);
  assert.match(summarizeToolExecutorTransaction(completed), /permission=ask/);
});

test('tool executor transaction projects completed and failed results to Agent Core parts', () => {
  const base = createToolExecutorTransaction({
    toolUseId: 'tool_edit',
    toolName: 'edit_file',
    toolClass: 'workspace',
    input: {
      path: 'src/app.ts'
    },
    createdAt: '2026-05-16T00:00:00.000Z'
  });
  const completed = completeToolExecutorTransaction(base, {
    content: '已更新 src/app.ts。',
    edit: {
      strategy: 'search_replace',
      patchFirst: false,
      preflight: 'passed'
    }
  }, {
    createdAt: '2026-05-16T00:00:01.000Z'
  });
  const failed = failToolExecutorTransaction(base, {
    message: '没有找到 oldText。',
    failureKind: 'context_mismatch',
    recoveryHint: '读取目标片段后重试。'
  }, {
    createdAt: '2026-05-16T00:00:02.000Z'
  });
  const pendingPart = toolExecutorTransactionToAgentCorePart(base, 0);
  const completedPart = toolExecutorTransactionToAgentCorePart(completed, 1);
  const failedPart = toolExecutorTransactionToAgentCorePart(failed, 2);

  assert.equal(pendingPart.kind, 'tool_call');
  assert.equal(pendingPart.status, 'pending');
  assert.equal(completedPart.kind, 'tool_result');
  assert.equal(completedPart.content, '已更新 src/app.ts。');
  assert.equal(completedPart.edit?.preflight, 'passed');
  assert.equal(completedPart.transaction?.toolUseId, 'tool_edit');
  assert.equal(completedPart.transaction?.status, 'completed');
  assert.equal(failedPart.kind, 'tool_error');
  assert.equal(failedPart.failureKind, 'context_mismatch');
  assert.equal(failedPart.recoveryHint, '读取目标片段后重试。');
  assert.equal(failedPart.transaction?.phase, 'failed');
});

test('tool executor transaction represents cancellation as structured tool error', () => {
  const created = createToolExecutorTransaction({
    toolUseId: 'tool_terminal',
    toolName: 'terminal_start',
    toolClass: 'terminal',
    createdAt: '2026-05-16T00:00:00.000Z'
  });
  const cancelled = cancelToolExecutorTransaction(created, {
    reason: '用户中断了本轮运行。',
    createdAt: '2026-05-16T00:00:01.000Z'
  });
  const part = toolExecutorTransactionToAgentCorePart(cancelled, 0);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.events.at(-1)?.type, 'cancelled');
  assert.equal(part.kind, 'tool_error');
  assert.equal(part.error, '用户中断了本轮运行。');
});

test('tool executor result normalization preserves MCP browser and terminal metadata', () => {
  const result = normalizeToolExecutorTransactionResult({
    summary: '工具完成。',
    failureKind: 'tool_execution_failed',
    recoveryHint: 'Use a safer fallback.',
    browser: {
      sessionId: 'browser_1',
      title: 'Preview',
      url: 'http://localhost:3000',
      consoleMessageCount: 0
    },
    terminal: {
      sessionId: 'terminal_1',
      name: 'dev server',
      status: 'running',
      nextSeq: 12
    },
    mcp: {
      pluginId: 'plugin_unity',
      operation: 'call_tool',
      target: 'unity.echo',
      exposedName: 'mcp__unity__unity_echo',
      timeoutMs: 45000,
      schemaGuard: 'passed'
    }
  });

  assert.equal(result.content, '工具完成。');
  assert.equal(result.failureKind, 'tool_execution_failed');
  assert.equal(result.recoveryHint, 'Use a safer fallback.');
  assert.equal(result.browser?.sessionId, 'browser_1');
  assert.equal(result.terminal?.sessionId, 'terminal_1');
  assert.equal(result.mcp?.exposedName, 'mcp__unity__unity_echo');
});
