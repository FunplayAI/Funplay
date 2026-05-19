import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateUsage,
  emptyUsageTotals,
  normalizeAiSdkUsage,
  normalizeClaudeSdkUsage
} from '../../electron/main/agent-platform/usage.ts';

test('normalizeAiSdkUsage maps detailed input/output and cache fields', () => {
  const usage = normalizeAiSdkUsage(
    {
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      inputTokenDetails: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200
      }
    },
    { provider: 'anthropic', model: 'claude-opus-4-7', recordedAt: '2026-05-06T00:00:00.000Z' }
  );

  assert.ok(usage, 'expected non-null usage');
  assert.equal(usage!.inputTokens, 1200);
  assert.equal(usage!.outputTokens, 340);
  assert.equal(usage!.cacheReadTokens, 800);
  assert.equal(usage!.cacheCreationTokens, 200);
  assert.equal(usage!.totalTokens, 1540);
  assert.equal(usage!.provider, 'anthropic');
  assert.equal(usage!.model, 'claude-opus-4-7');
  assert.equal(usage!.recordedAt, '2026-05-06T00:00:00.000Z');
});

test('normalizeAiSdkUsage falls back to deprecated cachedInputTokens and computes total when missing', () => {
  const usage = normalizeAiSdkUsage({
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 25
    // totalTokens deliberately missing
  });

  assert.ok(usage);
  assert.equal(usage!.cacheReadTokens, 25);
  assert.equal(usage!.cacheCreationTokens, undefined);
  assert.equal(usage!.totalTokens, 100 + 50 + 25);
});

test('normalizeAiSdkUsage returns null for empty or invalid usage', () => {
  assert.equal(normalizeAiSdkUsage(null), null);
  assert.equal(normalizeAiSdkUsage(undefined), null);
  assert.equal(normalizeAiSdkUsage({}), null);
  assert.equal(normalizeAiSdkUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), null);
  assert.equal(normalizeAiSdkUsage({ inputTokens: -5, outputTokens: -3 }), null);
});

test('normalizeClaudeSdkUsage maps Anthropic snake_case fields with cache buckets', () => {
  const usage = normalizeClaudeSdkUsage(
    {
      input_tokens: 200,
      output_tokens: 80,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 1000
    },
    { provider: 'anthropic', model: 'claude-opus-4-7' }
  );

  assert.ok(usage);
  assert.equal(usage!.inputTokens, 200);
  assert.equal(usage!.outputTokens, 80);
  assert.equal(usage!.cacheCreationTokens, 50);
  assert.equal(usage!.cacheReadTokens, 1000);
  assert.equal(usage!.totalTokens, 200 + 80 + 50 + 1000);
});

test('normalizeClaudeSdkUsage strips cache fields when zero and stays defined for live tokens', () => {
  const usage = normalizeClaudeSdkUsage({
    input_tokens: 10,
    output_tokens: 5
  });

  assert.ok(usage);
  assert.equal(usage!.cacheCreationTokens, undefined);
  assert.equal(usage!.cacheReadTokens, undefined);
  assert.equal(usage!.totalTokens, 15);
});

test('accumulateUsage sums fields and increments turn counter', () => {
  const totals = accumulateUsage(
    accumulateUsage(emptyUsageTotals(), {
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 10,
      cacheReadTokens: 200,
      totalTokens: 350,
      recordedAt: '2026-05-06T00:00:00.000Z'
    }),
    {
      inputTokens: 200,
      outputTokens: 60,
      cacheReadTokens: 100,
      totalTokens: 360,
      recordedAt: '2026-05-06T00:00:01.000Z'
    }
  );

  assert.equal(totals.turns, 2);
  assert.equal(totals.inputTokens, 300);
  assert.equal(totals.outputTokens, 100);
  assert.equal(totals.cacheCreationTokens, 10);
  assert.equal(totals.cacheReadTokens, 300);
  assert.equal(totals.totalTokens, 710);
});

test('emptyUsageTotals starts every counter at zero', () => {
  const totals = emptyUsageTotals();
  assert.equal(totals.turns, 0);
  assert.equal(totals.inputTokens, 0);
  assert.equal(totals.outputTokens, 0);
  assert.equal(totals.cacheCreationTokens, 0);
  assert.equal(totals.cacheReadTokens, 0);
  assert.equal(totals.totalTokens, 0);
});
