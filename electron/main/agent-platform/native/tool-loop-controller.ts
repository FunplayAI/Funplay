import {
  createAgentCoreRuntimeBridge,
  type AgentCoreRuntimeBridgeProviderStepOptions,
  type AgentCoreRuntimeBridgeToolResult
} from '../../agent-core/index';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { AgentToolFamily } from '../tool-policy';
import type { GenericAgentRuntimeParams } from '../types';

export interface NativeToolLoopCallbacks {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
  emitThinking?: (delta: string, accumulated: string) => void;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
  allowedToolFamilies?: AgentToolFamily[];
}

export type NativeRunControllerProviderStepOptions = AgentCoreRuntimeBridgeProviderStepOptions;
export type NativeRunControllerToolResult = AgentCoreRuntimeBridgeToolResult;

export function createNativeToolLoopControllerBridge(options: {
  callbacks?: NativeToolLoopCallbacks;
  stageId: string;
  guardTransitions?: boolean;
  runId?: string;
  turnId?: string;
}) {
  return createAgentCoreRuntimeBridge({
    callbacks: {
      emitStage: (stage) => options.callbacks?.emitStage?.(stage as ConversationOperationStageEvent)
    },
    guardTransitions: options.guardTransitions,
    runId: options.runId,
    stageId: options.stageId,
    turnId: options.turnId
  });
}
