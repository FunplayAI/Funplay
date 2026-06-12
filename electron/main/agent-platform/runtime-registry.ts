import { nativeRuntime } from './native/runtime';
import type { AgentRuntimeStrategy, AiProvider } from '../../../shared/types';
import type { GenericAgentRuntime, GenericAgentRuntimeId } from './types';

const runtimes = new Map<GenericAgentRuntimeId, GenericAgentRuntime>();
let initialized = false;

function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  registerGenericAgentRuntime(nativeRuntime);
  initialized = true;
}

export function registerGenericAgentRuntime(runtime: GenericAgentRuntime): void {
  runtimes.set(runtime.id, runtime);
}

export function getGenericAgentRuntime(runtimeId: GenericAgentRuntimeId): GenericAgentRuntime | undefined {
  ensureInitialized();
  return runtimes.get(runtimeId);
}

export function listGenericAgentRuntimes(): GenericAgentRuntime[] {
  ensureInitialized();
  return [...runtimes.values()];
}

export interface GenericAgentRuntimeResolveOptions {
  runtimeId?: GenericAgentRuntimeId;
  provider?: AiProvider;
  runtimeStrategy?: AgentRuntimeStrategy;
}

function resolveNativeRuntime(): GenericAgentRuntime {
  const fallback = runtimes.get('native');
  if (!fallback) {
    throw new Error('Generic native runtime is not registered.');
  }
  return fallback;
}

function resolveExplicitRuntime(runtimeId: GenericAgentRuntimeId): GenericAgentRuntime {
  const runtime = runtimes.get(runtimeId);
  if (!runtime) {
    throw new Error(`Agent runtime "${runtimeId}" is not registered.`);
  }
  if (!runtime.isAvailable()) {
    throw new Error(`Agent runtime "${runtime.displayName}" (${runtimeId}) is not available.`);
  }
  return runtime;
}

export function resolveGenericAgentRuntime(
  input?: GenericAgentRuntimeId | GenericAgentRuntimeResolveOptions
): GenericAgentRuntime {
  ensureInitialized();

  const options: GenericAgentRuntimeResolveOptions = typeof input === 'string' ? { runtimeId: input } : (input ?? {});
  const runtimeId = options.runtimeId;

  if (runtimeId) {
    return resolveExplicitRuntime(runtimeId);
  }

  return resolveNativeRuntime();
}

export function interruptGenericAgentRuntime(runtimeId: GenericAgentRuntimeId, runIdOrSessionId: string): void {
  resolveGenericAgentRuntime(runtimeId).interrupt(runIdOrSessionId);
}

export function disposeGenericAgentRuntimes(): void {
  ensureInitialized();
  for (const runtime of runtimes.values()) {
    runtime.dispose();
  }
}
