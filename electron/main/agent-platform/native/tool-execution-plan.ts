import type { NativeRuntimeToolDefinition } from './tool-adapter';
import type { NativeOpenAiToolInvocation } from './tool-loop-state';

export type NativeToolExecutionBatchMode = 'concurrent_safe' | 'exclusive';

export interface NativeToolExecutionBatch {
  mode: NativeToolExecutionBatchMode;
  invocations: NativeOpenAiToolInvocation[];
}

export interface NativeToolExecutionPlan {
  batches: NativeToolExecutionBatch[];
}

export function isNativeToolConcurrentSafe(
  invocation: NativeOpenAiToolInvocation,
  definitions: NativeRuntimeToolDefinition[]
): boolean {
  const definition = definitions.find((candidate) => candidate.name === invocation.toolCall.name);
  if (!definition) {
    return false;
  }
  if (definition.isConcurrencySafe) {
    try {
      return Boolean(definition.isConcurrencySafe(invocation.toolCall.arguments));
    } catch {
      return false;
    }
  }
  return Boolean(definition.readOnly);
}

export function createNativeToolExecutionPlan(input: {
  invocations: NativeOpenAiToolInvocation[];
  definitions: NativeRuntimeToolDefinition[];
}): NativeToolExecutionPlan {
  const batches: NativeToolExecutionBatch[] = [];
  let currentConcurrentBatch: NativeToolExecutionBatch | undefined;
  const seenToolUseIds = new Set<string>();

  for (const invocation of input.invocations) {
    const duplicateToolUseId = seenToolUseIds.has(invocation.toolUseId);
    seenToolUseIds.add(invocation.toolUseId);
    if (!duplicateToolUseId && isNativeToolConcurrentSafe(invocation, input.definitions)) {
      if (!currentConcurrentBatch) {
        currentConcurrentBatch = {
          mode: 'concurrent_safe',
          invocations: []
        };
        batches.push(currentConcurrentBatch);
      }
      currentConcurrentBatch.invocations.push(invocation);
      continue;
    }

    currentConcurrentBatch = undefined;
    batches.push({
      mode: 'exclusive',
      invocations: [invocation]
    });
  }

  return {
    batches
  };
}
