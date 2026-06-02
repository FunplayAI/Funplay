import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHttpRetryDelayMs } from '../../electron/main/openai-compatible-transport.ts';

test('computeHttpRetryDelayMs prefers a server-provided Retry-After', () => {
  assert.equal(computeHttpRetryDelayMs(0, 5000), 5000);
  assert.equal(computeHttpRetryDelayMs(3, 12_345), 12_345);
  assert.equal(computeHttpRetryDelayMs(0, 0), 0);
  // undefined Retry-After → falls through to backoff (not 0).
  assert.ok(computeHttpRetryDelayMs(0, undefined) > 0);
});

test('computeHttpRetryDelayMs uses exponential backoff with equal jitter', () => {
  // exp = min(500 * 2^attempt, 20000); delay ∈ [exp/2, exp].
  const cases = [
    { attempt: 0, exp: 500 },
    { attempt: 1, exp: 1_000 },
    { attempt: 2, exp: 2_000 },
    { attempt: 3, exp: 4_000 },
    { attempt: 6, exp: 20_000 } // 500*2^6=32000 → capped to 20000
  ];
  for (const { attempt, exp } of cases) {
    let sawLow = false;
    let sawHigh = false;
    for (let i = 0; i < 400; i += 1) {
      const delay = computeHttpRetryDelayMs(attempt, undefined);
      assert.ok(delay >= exp / 2 - 1, `attempt ${attempt}: ${delay} should be >= ${exp / 2}`);
      assert.ok(delay <= exp, `attempt ${attempt}: ${delay} should be <= ${exp}`);
      if (delay < exp * 0.7) sawLow = true;
      if (delay > exp * 0.8) sawHigh = true;
    }
    // Jitter should spread across the band, not collapse to a single value.
    assert.ok(sawLow && sawHigh, `attempt ${attempt}: jitter should span the [exp/2, exp] band`);
  }
});

test('computeHttpRetryDelayMs caps the exponential growth', () => {
  // Large attempts stay capped and never overflow.
  assert.ok(computeHttpRetryDelayMs(10, undefined) <= 20_000);
  assert.ok(computeHttpRetryDelayMs(30, undefined) <= 20_000);
  assert.ok(computeHttpRetryDelayMs(30, undefined) >= 10_000);
});
