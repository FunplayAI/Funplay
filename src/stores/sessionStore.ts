import { type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';

/**
 * Cross-session selection state — which session is locally active per project.
 * Kept separate from the per-session composer store (drafts/attachments/queue).
 *
 * The setter keeps the React `Dispatch<SetStateAction<T>>` shape so existing
 * call sites and the hooks that receive it work verbatim.
 */

function resolveSetStateAction<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

interface SessionState {
  localActiveSessionByProject: Record<string, string>;
  setLocalActiveSessionByProject: Dispatch<SetStateAction<Record<string, string>>>;
}

export const useSessionStore = create<SessionState>((set) => ({
  localActiveSessionByProject: {},
  setLocalActiveSessionByProject: (value) =>
    set((state) => ({ localActiveSessionByProject: resolveSetStateAction(value, state.localActiveSessionByProject) }))
}));
