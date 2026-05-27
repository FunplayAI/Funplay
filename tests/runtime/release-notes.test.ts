import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReleaseNotesText } from '../../shared/release-notes.ts';

test('release notes normalize GitHub HTML into readable text', () => {
  const html = '<p>This release includes &amp; fixes.</p><h2>Added</h2><ul><li>Added model list <code>/models</code>.</li><li>Added Unity Hub path selection.</li></ul>';
  assert.equal(
    normalizeReleaseNotesText(html),
    'This release includes & fixes.\n\n## Added\n\n- Added model list `/models`.\n- Added Unity Hub path selection.'
  );
});

test('release notes preserve plain markdown without exposing entities', () => {
  const markdown = '## Fixed\n\n- Escaped &amp; normalized text';
  assert.equal(normalizeReleaseNotesText(markdown), '## Fixed\n\n- Escaped & normalized text');
});
