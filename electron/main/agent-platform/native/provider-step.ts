import type { AiProvider } from '../../../../shared/types';
import {
  createProviderRequestAbort,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
} from '../../provider-runtime-options';

export const NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
export const NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
export const NATIVE_PROVIDER_STEP_MAX_RETRIES = 2;

const NATIVE_PROVIDER_STEP_RETRY_DELAYS_MS = [1_000, 3_000];
const RETRYABLE_PROVIDER_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export interface NativeProviderStepAbort {
  signal?: AbortSignal;
  timeoutMs: number | false;
  timedOut: () => boolean;
  dispose: () => void;
}

export function createNativeProviderStepAbort(parentSignal: AbortSignal | undefined, provider?: AiProvider): NativeProviderStepAbort {
  const abort = createProviderRequestAbort(parentSignal, provider);
  return {
    signal: abort.signal,
    timeoutMs: abort.timeoutMs,
    timedOut: abort.timedOut,
    dispose: abort.dispose
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readErrorNumber(error: unknown, keys: string[]): number | undefined {
  const record = isRecord(error) ? error : undefined;
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readErrorString(error: unknown, keys: string[]): string | undefined {
  const record = isRecord(error) ? error : undefined;
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function normalizeNativeProviderStepError(
  error: unknown,
  abort: NativeProviderStepAbort,
  label: string
): unknown {
  if (abort.timedOut()) {
    const seconds = abort.timeoutMs === false ? 0 : Math.round(abort.timeoutMs / 1000);
    const timeoutError = new Error(`${label} timed out after ${seconds}s.`);
    timeoutError.name = 'NativeProviderStepTimeoutError';
    timeoutError.cause = error;
    return timeoutError;
  }
  return error;
}

export function rethrowNativeProviderStepTimeout(error: unknown, abort: NativeProviderStepAbort, label: string): never {
  throw normalizeNativeProviderStepError(error, abort, label);
}

export function describeNativeProviderStepError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'unknown provider error');
}

export function isRetryableNativeProviderStepError(error: unknown): boolean {
  const message = describeNativeProviderStepError(error);
  if (/cannot read properties of undefined \(reading ['"]map['"]\)/i.test(message)) {
    return false;
  }

  const statusCode = readErrorNumber(error, ['status', 'statusCode']);
  if (statusCode !== undefined && (RETRYABLE_PROVIDER_STATUS_CODES.has(statusCode) || statusCode >= 500)) {
    return true;
  }

  const name = error instanceof Error ? error.name : readErrorString(error, ['name']);
  if (name && /NativeProviderStepTimeoutError|ProviderChunkTimeoutError|TimeoutError/i.test(name)) {
    return true;
  }

  const code = readErrorString(error, ['code', 'errorCode']);
  if (
    code &&
    /PROVIDER_TIMEOUT|PROVIDER_CHUNK_TIMEOUT|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|FETCH_FAILED/i.test(code)
  ) {
    return true;
  }

  return /timed?\s*out|timeout|rate limit|too many requests|bad gateway|gateway time-?out|temporarily unavailable|overloaded|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP (408|409|425|429|500|502|503|504|529)|\b(408|409|425|429|500|502|503|504|529)\b/i.test(message);
}

export function shouldRetryNativeProviderStep(input: {
  error: unknown;
  attempt: number;
  maxRetries?: number;
  sawProviderOutput: boolean;
  abortSignal?: AbortSignal;
}): boolean {
  const maxRetries = input.maxRetries ?? NATIVE_PROVIDER_STEP_MAX_RETRIES;
  return input.attempt < maxRetries &&
    !input.sawProviderOutput &&
    !input.abortSignal?.aborted &&
    isRetryableNativeProviderStepError(input.error);
}

export function getNativeProviderStepRetryDelayMs(attempt: number): number {
  return NATIVE_PROVIDER_STEP_RETRY_DELAYS_MS[attempt] ?? NATIVE_PROVIDER_STEP_RETRY_DELAYS_MS.at(-1) ?? 0;
}

export async function waitForNativeProviderStepRetry(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted || delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}
