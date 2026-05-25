import type {
  GenericAgentRuntime,
  GenericAgentRuntimeStreamEvent
} from './types';

export interface GenericAgentRuntimeEventQueue {
  push: (event: GenericAgentRuntimeStreamEvent) => void;
  fail: (error: unknown) => void;
  close: () => void;
  stream: () => AsyncIterable<GenericAgentRuntimeStreamEvent>;
}

export function createGenericAgentRuntimeEventQueue(): GenericAgentRuntimeEventQueue {
  const events: GenericAgentRuntimeStreamEvent[] = [];
  let closed = false;
  let failure: unknown;
  let waiter: ((result: IteratorResult<GenericAgentRuntimeStreamEvent>) => void) | undefined;
  let rejecter: ((error: unknown) => void) | undefined;

  const flush = (): void => {
    if (!waiter) {
      return;
    }
    const resolve = waiter;
    waiter = undefined;
    rejecter = undefined;
    const event = events.shift();
    if (event) {
      resolve({ value: event, done: false });
      return;
    }
    if (closed) {
      resolve({ value: undefined, done: true });
    }
  };

  return {
    push(event): void {
      if (closed) {
        return;
      }
      events.push(event);
      flush();
    },
    fail(error): void {
      failure = error;
      if (rejecter) {
        const reject = rejecter;
        waiter = undefined;
        rejecter = undefined;
        reject(error);
      }
    },
    close(): void {
      closed = true;
      flush();
    },
    stream(): AsyncIterable<GenericAgentRuntimeStreamEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<GenericAgentRuntimeStreamEvent>> {
              const event = events.shift();
              if (event) {
                return Promise.resolve({ value: event, done: false });
              }
              if (failure) {
                const error = failure;
                failure = undefined;
                return Promise.reject(error);
              }
              if (closed) {
                return Promise.resolve({ value: undefined, done: true });
              }
              return new Promise((resolve, reject) => {
                waiter = resolve;
                rejecter = reject;
              });
            }
          };
        }
      };
    }
  };
}

export async function* drainGenericAgentRuntimeEventQueue(
  queue: Pick<GenericAgentRuntimeEventQueue, 'stream'>
): AsyncIterable<GenericAgentRuntimeStreamEvent> {
  for await (const event of queue.stream()) {
    yield event;
  }
}

export function executeGenericAgentRuntimeEventStream(
  runtime: GenericAgentRuntime,
  params: Parameters<GenericAgentRuntime['executeEventStream']>[0]
): AsyncIterable<GenericAgentRuntimeStreamEvent> {
  return runtime.executeEventStream(params);
}
