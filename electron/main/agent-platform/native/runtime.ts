import { createGenericAgentRuntimeCapabilities } from '../runtime-capabilities';
import {
  createGenericAgentRuntimeEventQueue,
  drainGenericAgentRuntimeEventQueue
} from '../runtime-event-stream';
import { runNativeConversationTurn } from './loop';
import type { GenericAgentRuntime, GenericAgentRuntimeParams, GenericAgentRuntimeStreamEvent } from '../types';

const activeNativeControllers = new Map<string, AbortController>();

function resolveNativeInterruptKeys(params: GenericAgentRuntimeParams): string[] {
  return [
    params.context.activeSessionId,
    params.project.activeSessionId,
    params.project.id
  ].filter((value): value is string => Boolean(value));
}

async function executeNativeTurn(params: GenericAgentRuntimeParams) {
  const controller = new AbortController();
  const keys = resolveNativeInterruptKeys(params);
  for (const key of keys) {
    activeNativeControllers.set(key, controller);
  }
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  try {
    return await runNativeConversationTurn({
      ...params,
      abortSignal
    });
  } finally {
    for (const key of keys) {
      if (activeNativeControllers.get(key) === controller) {
        activeNativeControllers.delete(key);
      }
    }
  }
}

async function* executeNativeEventStream(params: GenericAgentRuntimeParams): AsyncIterable<GenericAgentRuntimeStreamEvent> {
  const queue = createGenericAgentRuntimeEventQueue();
  void executeNativeTurn({
    ...params,
    emitRuntimeEvent: (event) => queue.push(event),
    onStatus: undefined,
    onTextDelta: undefined,
    onThinkingDelta: undefined,
    onToolUse: undefined,
    onToolResult: undefined,
    onStage: undefined,
    onPermissionRequest: (request) => queue.push({ type: 'permission_request', request }),
    onUserInputRequest: (request) => queue.push({ type: 'user_input_request', request }),
    onUsage: undefined,
    onAgentCoreParts: (parts) => queue.push({ type: 'agent_core_parts', parts }),
    onLifecycleHook: (hook) => queue.push({ type: 'lifecycle_hook', hook })
  })
    .then((result) => {
      queue.push({ type: 'result', result });
      queue.close();
    })
    .catch((error) => {
      queue.fail(error);
      queue.close();
    });
  yield* drainGenericAgentRuntimeEventQueue(queue);
}

export const nativeRuntime: GenericAgentRuntime = {
  id: 'native',
  displayName: 'Native Runtime',
  description: 'Funplay built-in multi-provider runtime with project-first workspace context and tool orchestration.',
  capabilities: createGenericAgentRuntimeCapabilities({
    conversation: true,
    toolLoop: true,
    nativeToolCalling: true,
    legacyJsonLoop: false,
    workspaceWrite: true,
    mcpTools: true,
    sessionPermission: true,
    checkpoint: true,
    toolCheckpoint: true,
    resume: true,
    toolResume: true,
    hostControlledWrites: true
  }),
  isAvailable: () => true,
  interrupt: (runIdOrSessionId: string) => {
    activeNativeControllers.get(runIdOrSessionId)?.abort();
  },
  dispose: () => {
    for (const controller of activeNativeControllers.values()) {
      controller.abort();
    }
    activeNativeControllers.clear();
  },
  executeEventStream: executeNativeEventStream
};
