import type { AgentUserInputOption, AgentUserInputResponse } from '../../../shared/types';

export interface PendingUserInputEntry {
  requestId: string;
  streamId: string;
  projectId: string;
  sessionId: string;
  title: string;
  question: string;
  detail?: string;
  options?: AgentUserInputOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  placeholder?: string;
  toolName?: string;
  createdAt: string;
  resolve: (response: AgentUserInputResponse) => void;
  onResolve?: (entry: PendingUserInputEntry, response: AgentUserInputResponse) => void;
  timer: NodeJS.Timeout;
  abortSignal?: AbortSignal;
}

const pendingUserInputs = new Map<string, PendingUserInputEntry>();
const userInputTimeoutMs = 1000 * 60 * 30;

function settleUserInput(
  requestId: string,
  fallback?: AgentUserInputResponse
): PendingUserInputEntry | undefined {
  const entry = pendingUserInputs.get(requestId);
  if (!entry) {
    return undefined;
  }

  clearTimeout(entry.timer);
  pendingUserInputs.delete(requestId);
  if (fallback) {
    entry.resolve(fallback);
    entry.onResolve?.(entry, fallback);
  }
  return entry;
}

export function registerPendingUserInput(params: {
  requestId: string;
  streamId: string;
  projectId: string;
  sessionId: string;
  title: string;
  question: string;
  detail?: string;
  options?: AgentUserInputOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
  placeholder?: string;
  toolName?: string;
  createdAt: string;
  abortSignal?: AbortSignal;
  onResolve?: (entry: PendingUserInputEntry, response: AgentUserInputResponse) => void;
}): Promise<AgentUserInputResponse> {
  return new Promise<AgentUserInputResponse>((resolve) => {
    const timer = setTimeout(() => {
      settleUserInput(params.requestId, {
        answer: '',
        cancelled: true
      });
    }, userInputTimeoutMs);
    timer.unref?.();

    const entry: PendingUserInputEntry = {
      ...params,
      resolve,
      timer
    };
    pendingUserInputs.set(params.requestId, entry);

    params.abortSignal?.addEventListener('abort', () => {
      settleUserInput(params.requestId, {
        answer: '',
        cancelled: true
      });
    }, { once: true });
  });
}

export function resolvePendingUserInput(
  requestId: string,
  response: AgentUserInputResponse
): PendingUserInputEntry | undefined {
  return settleUserInput(requestId, response);
}

export function cancelPendingUserInputsForStream(streamId: string): void {
  for (const [requestId, entry] of pendingUserInputs.entries()) {
    if (entry.streamId === streamId) {
      settleUserInput(requestId, {
        answer: '',
        cancelled: true
      });
    }
  }
}
