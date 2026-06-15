import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPromptStreamLifecycleEvent } from '../../src/hooks/usePromptStreamEvents.ts';
import { clearStreamSessions, listStreamSessions, seedStreamSession } from '../../src/lib/stream-session-manager.ts';
import { useProjectStore } from '../../src/stores/projectStore.ts';
import { useSessionComposerStore } from '../../src/stores/sessionComposerStore.ts';
import type { Project } from '../../shared/types.ts';

/**
 * The byte-exact terminal-event side effects extracted from App.tsx — completed
 * commits the project + GCs the stream, cancelled-with-project commits without
 * restoring the draft, cancelled-without-project restores the draft, and error
 * restores the draft + surfaces the error.
 */

function snapshot(streamId: string, projectId: string, sessionId: string, prompt: string) {
  return {
    streamId,
    projectId,
    sessionId,
    prompt,
    content: '',
    thinkingContent: '',
    toolUses: [],
    toolResults: [],
    stages: [],
    activityItems: [],
    phase: 'streaming',
    statusMessage: '',
    startedAt: 't0'
  } as never;
}

function reset() {
  clearStreamSessions();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'old' } as unknown as Project] });
  useSessionComposerStore.setState({ drafts: {}, attachments: {}, composerErrors: {}, queuedPrompts: {} });
}

test('completed commits the updated project, clears the error, and GCs the stream', () => {
  reset();
  seedStreamSession(snapshot('st1', 'p1', 'sess1', 'live'));
  const updatedProject = { id: 'p1', name: 'fresh' } as unknown as Project;
  useSessionComposerStore.setState({ composerErrors: { sess1: 'stale error' } });

  applyPromptStreamLifecycleEvent(
    { type: 'completed', streamId: 'st1', sessionId: 'sess1', project: updatedProject } as never,
    { language: 'zh-CN', activePromptStream: null }
  );

  assert.equal(useProjectStore.getState().projects[0].name, 'fresh');
  assert.equal(useSessionComposerStore.getState().composerErrors.sess1, '');
  assert.equal(
    listStreamSessions().some((stream) => stream.streamId === 'st1'),
    false
  );
});

test('cancelled WITH a persisted project commits it and does NOT restore the draft', () => {
  reset();
  const interrupted = { id: 'p1', name: 'interrupted' } as unknown as Project;

  applyPromptStreamLifecycleEvent(
    { type: 'cancelled', streamId: 'c1', sessionId: 'sess1', project: interrupted } as never,
    { language: 'en-US', activePromptStream: snapshot('c1', 'p1', 'sess1', 'my draft') }
  );

  assert.equal(useProjectStore.getState().projects[0].name, 'interrupted');
  assert.equal(useSessionComposerStore.getState().drafts.sess1, undefined); // not restored
  assert.match(useSessionComposerStore.getState().composerErrors.sess1, /cancelled/i);
});

test('cancelled WITHOUT a project restores the draft from the in-flight stream', () => {
  reset();
  applyPromptStreamLifecycleEvent(
    { type: 'cancelled', streamId: 'c1', sessionId: 'sess1' } as never,
    { language: 'en-US', activePromptStream: snapshot('c1', 'p1', 'sess1', 'restore me') }
  );

  assert.equal(useSessionComposerStore.getState().drafts.sess1, 'restore me');
  assert.match(useSessionComposerStore.getState().composerErrors.sess1, /cancelled/i);
});

test('error restores the draft and surfaces the error message', () => {
  reset();
  applyPromptStreamLifecycleEvent(
    { type: 'error', streamId: 'e1', sessionId: 'sess1', error: 'provider exploded' } as never,
    { language: 'en-US', activePromptStream: snapshot('e1', 'p1', 'sess1', 'keep my text') }
  );

  assert.equal(useSessionComposerStore.getState().drafts.sess1, 'keep my text');
  assert.equal(useSessionComposerStore.getState().composerErrors.sess1, 'provider exploded');
});
