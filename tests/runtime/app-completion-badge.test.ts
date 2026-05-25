import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionCompletionBadgeTracker,
  createWindowsCompletionBadgeDataUrl,
  formatCompletionBadgeLabel
} from '../../electron/main/app-completion-badge.ts';

test('completion badge labels hide zero and clamp large counts', () => {
  assert.equal(formatCompletionBadgeLabel(0), '');
  assert.equal(formatCompletionBadgeLabel(-1), '');
  assert.equal(formatCompletionBadgeLabel(Number.NaN), '');
  assert.equal(formatCompletionBadgeLabel(1), '1');
  assert.equal(formatCompletionBadgeLabel(12), '12');
  assert.equal(formatCompletionBadgeLabel(100), '99+');
});

test('completion badge tracker counts unique completed sessions until cleared', () => {
  const counts: number[] = [];
  const tracker = createSessionCompletionBadgeTracker({
    onCountChanged: (count) => {
      counts.push(count);
    }
  });

  assert.equal(tracker.getCount(), 0);
  assert.equal(tracker.recordCompletedSession('session-a'), 1);
  assert.equal(tracker.recordCompletedSession('session-a'), 1);
  assert.equal(tracker.recordCompletedSession(' session-b '), 2);
  assert.equal(tracker.recordCompletedSession(''), 2);
  assert.equal(tracker.getCount(), 2);
  assert.equal(tracker.clear(), 0);
  assert.equal(tracker.clear(), 0);
  assert.deepEqual(counts, [1, 2, 0]);
});

test('windows completion badge data url contains a red numeric badge png', () => {
  const empty = createWindowsCompletionBadgeDataUrl(0);
  const badge = createWindowsCompletionBadgeDataUrl(3);
  const largeBadge = createWindowsCompletionBadgeDataUrl(120);
  const png = Buffer.from(badge.replace(/^data:image\/png;base64,/, ''), 'base64');

  assert.equal(empty, '');
  assert.match(badge, /^data:image\/png;base64,/);
  assert.match(largeBadge, /^data:image\/png;base64,/);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
});
