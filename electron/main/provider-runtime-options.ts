import type { AiProvider } from '../../shared/types';

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Default streaming stall timeout: abort + retry if no new SSE chunk arrives for
// this long. Catches hung/stalled provider responses (including a missing first
// token) fast enough to retry, instead of hanging near the full 5min request
// timeout. Generous enough not to trip on a slow reasoning-model first token;
// providers can override via chunkTimeoutMs.
export const DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS = 120 * 1000;
export const MIN_PROVIDER_TIMEOUT_MS = 1;
export const MAX_PROVIDER_TIMEOUT_MS = 60 * 60 * 1000;
export const MIN_PROVIDER_CONTEXT_WINDOW_TOKENS = 1_024;
export const MAX_PROVIDER_CONTEXT_WINDOW_TOKENS = 2_000_000;
export const MIN_PROVIDER_MAX_OUTPUT_TOKENS = 1;
export const MAX_PROVIDER_MAX_OUTPUT_TOKENS = 1_000_000;

export interface ProviderRequestAbort {
  signal?: AbortSignal;
  timeoutMs: number | false;
  timedOut: () => boolean;
  dispose: () => void;
}

function normalizeTimeoutNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized < MIN_PROVIDER_TIMEOUT_MS || normalized > MAX_PROVIDER_TIMEOUT_MS) {
    return undefined;
  }
  return normalized;
}

export function normalizeProviderRequestTimeoutMs(value: unknown): number | false | undefined {
  if (value === false) {
    return false;
  }
  return normalizeTimeoutNumber(value);
}

export function normalizeProviderChunkTimeoutMs(value: unknown): number | undefined {
  return normalizeTimeoutNumber(value);
}

function normalizeTokenNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= min && normalized <= max ? normalized : undefined;
}

export function normalizeProviderContextWindowTokens(value: unknown): number | undefined {
  return normalizeTokenNumber(value, MIN_PROVIDER_CONTEXT_WINDOW_TOKENS, MAX_PROVIDER_CONTEXT_WINDOW_TOKENS);
}

export function normalizeProviderMaxOutputTokens(value: unknown): number | undefined {
  return normalizeTokenNumber(value, MIN_PROVIDER_MAX_OUTPUT_TOKENS, MAX_PROVIDER_MAX_OUTPUT_TOKENS);
}

export function resolveProviderRequestTimeoutMs(provider?: Pick<AiProvider, 'requestTimeoutMs'>): number | false {
  return normalizeProviderRequestTimeoutMs(provider?.requestTimeoutMs) ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
}

export function resolveProviderChunkTimeoutMs(provider?: Pick<AiProvider, 'chunkTimeoutMs'>): number | undefined {
  return normalizeProviderChunkTimeoutMs(provider?.chunkTimeoutMs) ?? DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS;
}

export function createProviderRequestAbort(
  parentSignal: AbortSignal | undefined,
  provider?: Pick<AiProvider, 'requestTimeoutMs'>
): ProviderRequestAbort {
  const timeoutMs = resolveProviderRequestTimeoutMs(provider);
  if (timeoutMs === false) {
    return {
      signal: parentSignal,
      timeoutMs,
      timedOut: () => false,
      dispose: () => undefined
    };
  }
  const timeoutController = new AbortController();
  let didTimeout = false;
  let disposed = false;
  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', cleanup);
  };
  const timeout = setTimeout(() => {
    didTimeout = true;
    timeoutController.abort();
    cleanup();
  }, timeoutMs);
  parentSignal?.addEventListener('abort', cleanup, { once: true });
  return {
    signal: parentSignal ? AbortSignal.any([parentSignal, timeoutController.signal]) : timeoutController.signal,
    timeoutMs,
    timedOut: () => didTimeout && !parentSignal?.aborted,
    dispose: cleanup
  };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return undefined;
  }
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

function wrapSseChunkTimeout(response: Response, chunkTimeoutMs: number | undefined, controller: AbortController | undefined): Response {
  if (!chunkTimeoutMs || chunkTimeoutMs <= 0 || !controller || !response.body) {
    return response;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const error = new Error(`SSE chunk timed out after ${chunkTimeoutMs}ms.`);
          error.name = 'ProviderChunkTimeoutError';
          controller.abort(error);
          void reader.cancel(error);
          reject(error);
        }, chunkTimeoutMs);
        reader.read().then(
          (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
      });

      if (part.done) {
        streamController.close();
        return;
      }
      streamController.enqueue(part.value);
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader.cancel(reason);
    }
  });

  return new Response(body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText
  });
}

export function createProviderFetch(provider: AiProvider, baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestAbort = createProviderRequestAbort(init?.signal ?? undefined, provider);
    const chunkTimeoutMs = resolveProviderChunkTimeoutMs(provider);
    const chunkAbortController = chunkTimeoutMs ? new AbortController() : undefined;
    const signal = combineAbortSignals([requestAbort.signal, chunkAbortController?.signal]);
    try {
      const response = await baseFetch(input, {
        ...(init ?? {}),
        signal
      });
      return wrapSseChunkTimeout(response, chunkTimeoutMs, chunkAbortController);
    } finally {
      requestAbort.dispose();
    }
  }) as typeof fetch;
}
