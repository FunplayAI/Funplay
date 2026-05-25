import type { AgentCoreMessagePart } from '../../../shared/types';
import type { GenericAgentPhase, GenericAgentRuntimeParams } from './types';

export function emitRuntimeStatus(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onStatus'>,
  phase: GenericAgentPhase,
  message: string
): void {
  params.emitRuntimeEvent?.({ type: 'status', phase, message });
  params.onStatus?.(phase, message);
}

export function emitRuntimeTextDelta(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onTextDelta'>,
  delta: string,
  accumulated: string
): void {
  params.emitRuntimeEvent?.({ type: 'text_delta', delta, accumulated });
  params.onTextDelta?.(delta, accumulated);
}

export function emitRuntimeThinkingDelta(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onThinkingDelta'>,
  delta: string,
  accumulated: string
): void {
  params.emitRuntimeEvent?.({ type: 'thinking_delta', delta, accumulated });
  params.onThinkingDelta?.(delta, accumulated);
}

export function emitRuntimeUsage(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onUsage'>,
  usage: Parameters<NonNullable<GenericAgentRuntimeParams['onUsage']>>[0]
): void {
  params.emitRuntimeEvent?.({ type: 'usage', usage });
  params.onUsage?.(usage);
}

export function emitRuntimeAgentCoreParts(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onAgentCoreParts'>,
  parts: AgentCoreMessagePart[]
): void {
  params.emitRuntimeEvent?.({ type: 'agent_core_parts', parts });
  params.onAgentCoreParts?.(parts);
}

export function emitRuntimeLifecycleHook(
  params: Pick<GenericAgentRuntimeParams, 'emitRuntimeEvent' | 'onLifecycleHook'>,
  hook: Parameters<NonNullable<GenericAgentRuntimeParams['onLifecycleHook']>>[0]
): void {
  params.emitRuntimeEvent?.({ type: 'lifecycle_hook', hook });
  params.onLifecycleHook?.(hook);
}
