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
