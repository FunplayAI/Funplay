import type { AiProvider } from '../../../../shared/types';
import {
  createProviderRequestAbort,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
} from '../../provider-runtime-options';

export const NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
export const NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;

export interface NativeProviderStepAbort {
  signal?: AbortSignal;
  timeoutMs: number | false;
  timedOut: () => boolean;
}

export function createNativeProviderStepAbort(parentSignal: AbortSignal | undefined, provider?: AiProvider): NativeProviderStepAbort {
  const abort = createProviderRequestAbort(parentSignal, provider);
  return {
    signal: abort.signal,
    timeoutMs: abort.timeoutMs,
    timedOut: abort.timedOut
  };
}

export function rethrowNativeProviderStepTimeout(error: unknown, abort: NativeProviderStepAbort, label: string): never {
  if (abort.timedOut()) {
    const seconds = abort.timeoutMs === false ? 0 : Math.round(abort.timeoutMs / 1000);
    const timeoutError = new Error(`${label} timed out after ${seconds}s.`);
    timeoutError.name = 'NativeProviderStepTimeoutError';
    timeoutError.cause = error;
    throw timeoutError;
  }
  throw error;
}
