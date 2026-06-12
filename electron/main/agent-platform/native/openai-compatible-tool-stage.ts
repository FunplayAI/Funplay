import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { OpenAiCompatibleToolCall } from '../../openai-compatible-client';
import {
  createNativeOpenAiToolInvocations,
  executeNativeStreamingToolPlan
} from './streaming-tool-executor';
import type {
  NativeRunControllerToolResult,
  NativeToolLoopCallbacks
} from './tool-loop-controller';
import type { NativeToolLoopState } from './tool-loop-state';
import type { NativeToolPool } from './tool-pool';
import type { NativeEditFailureRecovery } from './continuation-policy';

export async function executeOpenAiCompatibleToolStage(input: {
  toolCalls: OpenAiCompatibleToolCall[];
  stepIndex: number;
  state: NativeToolLoopState;
  callbacks?: NativeToolLoopCallbacks;
  abortSignal?: AbortSignal;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
  visionEnabled?: boolean;
}): Promise<{
  editFailureRecoveries: NativeEditFailureRecovery[];
}> {
  return executeNativeStreamingToolPlan({
    invocations: createNativeOpenAiToolInvocations({
      toolCalls: input.toolCalls,
      stepIndex: input.stepIndex
    }),
    abortSignal: input.abortSignal,
    state: input.state,
    callbacks: input.callbacks,
    toolPool: input.toolPool,
    instructionTracker: input.instructionTracker,
    recordRunControllerToolResult: input.recordRunControllerToolResult,
    visionEnabled: input.visionEnabled
  });
}
