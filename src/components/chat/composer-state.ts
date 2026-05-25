export type RuntimeMenuKey = 'agent' | 'plus' | 'permission' | null;

export type ComposerState =
  | 'idle'
  | 'drafting'
  | 'running'
  | 'queuedDraft'
  | 'awaitingPermission'
  | 'awaitingUserInput'
  | 'selectingProvider'
  | 'selectingMode'
  | 'attaching'
  | 'assetGenerating';

export function resolveComposerState(input: {
  draft: string;
  attachments: readonly unknown[];
  isSending: boolean;
  queuedPrompts: readonly unknown[];
  pendingPermission?: unknown;
  pendingUserInput?: unknown;
  runtimeMenuOpen: RuntimeMenuKey;
}): ComposerState {
  if (input.pendingUserInput) return 'awaitingUserInput';
  if (input.pendingPermission) return 'awaitingPermission';
  if (input.runtimeMenuOpen === 'permission') return 'selectingMode';
  if (input.runtimeMenuOpen === 'agent') return 'selectingProvider';
  if (input.runtimeMenuOpen === 'plus') return 'attaching';
  if (input.queuedPrompts.length > 0) return 'queuedDraft';
  if (input.isSending) return 'running';
  if (input.draft.trim() || input.attachments.length > 0) return 'drafting';
  return 'idle';
}
