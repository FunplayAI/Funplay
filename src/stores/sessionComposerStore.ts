import { type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';
import type { PromptAttachment } from '../../shared/types';
import type { QueuedPromptItem } from '../components/chat/ChatComposer';

/**
 * Per-session composer state — drafts, staged attachments, inline errors, and
 * queued prompts — keyed by session id. Extracted out of the App.tsx
 * coordination component as the first slice of the Zustand state layer.
 *
 * The four setters intentionally expose the same `Dispatch<SetStateAction<T>>`
 * shape as the React useState setters they replace, so existing call sites and
 * the hooks that receive them (usePromptAttachmentImport, useCheckpointManager)
 * keep working verbatim during the migration.
 */

function resolveSetStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

function removeSessionKeys<T>(record: Record<string, T>, sessionIds: string[]): Record<string, T> {
  const next = { ...record };
  sessionIds.forEach((id) => delete next[id]);
  return next;
}

interface SessionComposerState {
  drafts: Record<string, string>;
  attachments: Record<string, PromptAttachment[]>;
  composerErrors: Record<string, string>;
  queuedPrompts: Record<string, QueuedPromptItem[]>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setAttachments: Dispatch<SetStateAction<Record<string, PromptAttachment[]>>>;
  setComposerErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setQueuedPrompts: Dispatch<SetStateAction<Record<string, QueuedPromptItem[]>>>;
  /** Single source of truth for tearing down every per-session map when a
   * session (or all of a project's sessions) is deleted. */
  clearSessionScoped: (sessionIds: string[]) => void;
}

export const useSessionComposerStore = create<SessionComposerState>((set) => ({
  drafts: {},
  attachments: {},
  composerErrors: {},
  queuedPrompts: {},
  setDrafts: (value) => set((state) => ({ drafts: resolveSetStateAction(value, state.drafts) })),
  setAttachments: (value) => set((state) => ({ attachments: resolveSetStateAction(value, state.attachments) })),
  setComposerErrors: (value) => set((state) => ({ composerErrors: resolveSetStateAction(value, state.composerErrors) })),
  setQueuedPrompts: (value) => set((state) => ({ queuedPrompts: resolveSetStateAction(value, state.queuedPrompts) })),
  clearSessionScoped: (sessionIds) => {
    if (sessionIds.length === 0) {
      return;
    }
    set((state) => ({
      drafts: removeSessionKeys(state.drafts, sessionIds),
      attachments: removeSessionKeys(state.attachments, sessionIds),
      composerErrors: removeSessionKeys(state.composerErrors, sessionIds),
      queuedPrompts: removeSessionKeys(state.queuedPrompts, sessionIds)
    }));
  }
}));
