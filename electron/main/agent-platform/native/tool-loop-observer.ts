import { ProjectInstructionTracker } from '../project-instruction-tracker';
import {
  resolveTodoSnapshotFromToolResult,
  type NativeTodoSnapshot
} from './continuation-policy';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';

export function observeNativeToolLoopToolResult(input: {
  instructionTracker: ProjectInstructionTracker;
  callbacks?: NativeToolLoopCallbacks;
  toolName: string;
  toolInput?: Record<string, unknown>;
  summary: string;
  isError?: boolean;
}): NativeTodoSnapshot | undefined {
  const todoSnapshot = resolveTodoSnapshotFromToolResult({
    toolName: input.toolName,
    toolInput: input.toolInput,
    summary: input.summary,
    isError: input.isError
  });
  const discoveredInstructions = input.instructionTracker.discoverFromToolInput(
    input.toolName,
    input.toolInput
  );
  if (discoveredInstructions.length > 0) {
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_dynamic_instructions',
      title: '发现局部 Agent 指令',
      target: 'stage:native_dynamic_instructions',
      status: 'completed',
      summary: `已载入 ${discoveredInstructions.map((instruction) => instruction.path).join(', ')}。`,
      input: {
        paths: discoveredInstructions.map((instruction) => instruction.path)
      }
    });
  }
  return todoSnapshot;
}
