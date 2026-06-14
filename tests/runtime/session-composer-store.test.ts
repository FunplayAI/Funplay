import test from 'node:test';
import assert from 'node:assert/strict';
import { useSessionComposerStore } from '../../src/stores/sessionComposerStore.ts';

function resetStore(): void {
  useSessionComposerStore.setState({ drafts: {}, attachments: {}, composerErrors: {}, queuedPrompts: {} });
}

test('setters accept a direct value and an updater function (React setState shape)', () => {
  resetStore();
  const store = useSessionComposerStore.getState();

  store.setDrafts({ s1: 'hello' });
  assert.deepEqual(useSessionComposerStore.getState().drafts, { s1: 'hello' });

  store.setDrafts((current) => ({ ...current, s2: 'world' }));
  assert.deepEqual(useSessionComposerStore.getState().drafts, { s1: 'hello', s2: 'world' });
});

test('each setter only touches its own slice', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.setComposerErrors({ s1: 'boom' });
  store.setQueuedPrompts({ s1: [{ id: 'q1', content: 'go' }] });

  const state = useSessionComposerStore.getState();
  assert.deepEqual(state.composerErrors, { s1: 'boom' });
  assert.deepEqual(state.queuedPrompts.s1?.[0]?.content, 'go');
  assert.deepEqual(state.drafts, {});
  assert.deepEqual(state.attachments, {});
});

test('clearSessionScoped removes the given session ids from all four maps', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.setDrafts({ s1: 'a', s2: 'b', s3: 'c' });
  store.setAttachments({ s1: [], s2: [] });
  store.setComposerErrors({ s2: 'err', s3: 'err3' });
  store.setQueuedPrompts({ s1: [{ id: 'q', content: 'x' }], s2: [] });

  store.clearSessionScoped(['s1', 's2']);

  const state = useSessionComposerStore.getState();
  assert.deepEqual(Object.keys(state.drafts), ['s3']);
  assert.deepEqual(state.attachments, {});
  assert.deepEqual(state.composerErrors, { s3: 'err3' });
  assert.deepEqual(state.queuedPrompts, {});
});

test('clearSessionScoped with an empty list is a no-op', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.setDrafts({ s1: 'keep' });
  store.clearSessionScoped([]);
  assert.deepEqual(useSessionComposerStore.getState().drafts, { s1: 'keep' });
});

test('setter identities are stable across state changes (safe for hook deps)', () => {
  resetStore();
  const first = useSessionComposerStore.getState().setDrafts;
  useSessionComposerStore.getState().setDrafts({ s1: 'x' });
  const second = useSessionComposerStore.getState().setDrafts;
  assert.equal(first, second);
});

test('updateDraft sets the draft and clears that session error', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.setComposerErrors({ s1: 'stale error' });
  store.updateDraft('s1', 'hello world');
  const state = useSessionComposerStore.getState();
  assert.equal(state.drafts.s1, 'hello world');
  assert.equal(state.composerErrors.s1, '');
});

test('queuePrompt trims, ignores empty/sessionless, and appends with an id', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.queuePrompt('s1', '  go  ');
  store.queuePrompt('s1', 'again');
  store.queuePrompt('s1', '   ');
  store.queuePrompt('', 'no session');
  const queue = useSessionComposerStore.getState().queuedPrompts.s1;
  assert.equal(queue?.length, 2);
  assert.deepEqual(queue?.map((item) => item.content), ['go', 'again']);
  assert.match(queue?.[0]?.id ?? '', /^queued_/);
});

test('removeQueuedPrompt drops the item and deletes the session key when empty', () => {
  resetStore();
  const store = useSessionComposerStore.getState();
  store.queuePrompt('s1', 'a');
  store.queuePrompt('s1', 'b');
  const firstId = useSessionComposerStore.getState().queuedPrompts.s1![0].id;
  store.removeQueuedPrompt('s1', firstId);
  assert.equal(useSessionComposerStore.getState().queuedPrompts.s1?.length, 1);
  const lastId = useSessionComposerStore.getState().queuedPrompts.s1![0].id;
  store.removeQueuedPrompt('s1', lastId);
  assert.equal('s1' in useSessionComposerStore.getState().queuedPrompts, false);
});
