import { createToolExecutorTransactionSummary } from '../tool-executor';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import {
  type ProviderRuntimeEventObserver
} from '../provider-runtime-events';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { observeNativeToolLoopToolResult } from './tool-loop-observer';
import {
  formatInterruptedToolResult,
  normalizeToolOutputForStream
} from './tool-loop-output';
import { recordNativeWorkspaceToolTransactionResult } from './tool-executor';
import { describeNativeRuntimeToolUse, resolveNativeRuntimeToolName, type NativeRuntimeToolDefinition } from './tool-adapter';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import type { NativeAiSdkLoopState } from './ai-sdk-provider-step';

export interface NativeAiSdkToolEventAdapter {
  handleToolCall: (event: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => void;
  handleToolResult: (event: {
    toolCallId: string;
    toolName: string;
    output: unknown;
  }) => void;
  collectInterruptedToolResults: (error: unknown) => void;
}

export function createNativeAiSdkToolEventAdapter(input: {
  callbacks?: NativeToolLoopCallbacks;
  eventObserver: ProviderRuntimeEventObserver;
  definitions: NativeRuntimeToolDefinition[];
  instructionTracker: ProjectInstructionTracker;
  loopState: NativeAiSdkLoopState;
  stepState: NativeAiSdkStepState;
}): NativeAiSdkToolEventAdapter {
  return {
    handleToolCall: (event) => {
      const toolName = resolveNativeRuntimeToolName(event.toolName, input.definitions) ?? event.toolName;
      const trackedToolCall = input.stepState.recordToolCall({
        toolCallId: event.toolCallId,
        toolName,
        rawInput: event.input
      });
      const toolInput = event.input as Record<string, unknown> | undefined;
      const presentation = describeNativeRuntimeToolUse({
        definitions: input.definitions,
        toolName,
        toolInput
      });
      input.loopState.toolCalls.push(toolName);
      input.eventObserver.observe({
        type: 'tool_use',
        toolUseId: trackedToolCall.toolUseId,
        toolName,
        title: presentation.title,
        summary: presentation.summary,
        activity: presentation.activity,
        input: toolInput
      });
    },
    handleToolResult: (event) => {
      const toolName = resolveNativeRuntimeToolName(event.toolName, input.definitions) ?? event.toolName;
      const toolOutput = normalizeToolOutputForStream(event.output);
      const trackedToolResult = input.stepState.recordToolResult({
        toolCallId: event.toolCallId,
        toolName,
        output: toolOutput
      });
      const todoSnapshot = observeNativeToolLoopToolResult({
        instructionTracker: input.instructionTracker,
        callbacks: input.callbacks,
        toolName: trackedToolResult.toolName,
        toolInput: trackedToolResult.toolInput,
        summary: toolOutput.summary,
        isError: Boolean(toolOutput.isError)
      });
      if (todoSnapshot) {
        input.loopState.latestTodoSnapshot = todoSnapshot;
      }
      const transaction = recordNativeWorkspaceToolTransactionResult({
        toolUseId: trackedToolResult.toolUseId,
        toolName: trackedToolResult.toolName,
        input: trackedToolResult.toolInput ?? {},
        toolResult: toolOutput
      });
      const transactionSummary = createToolExecutorTransactionSummary(transaction.transaction);
      input.stepState.recordToolResultTransaction({
        toolCallId: event.toolCallId,
        transaction: transactionSummary
      });
      input.eventObserver.observe({
        type: 'tool_result',
        toolUseId: trackedToolResult.toolUseId,
        toolName: trackedToolResult.toolName,
        content: toolOutput.summary,
        isError: Boolean(toolOutput.isError),
        media: toolOutput.media,
        changedFiles: toolOutput.changedFiles,
        command: toolOutput.command,
        terminal: toolOutput.terminal,
        browser: toolOutput.browser,
        edit: toolOutput.edit,
        mcp: toolOutput.mcp,
        artifacts: toolOutput.artifacts,
        transaction: transactionSummary
      });
    },
    collectInterruptedToolResults: (error) => {
      for (const interruptedToolResult of input.stepState.collectInterruptedToolResults(formatInterruptedToolResult(error))) {
        const transaction = recordNativeWorkspaceToolTransactionResult({
          toolUseId: interruptedToolResult.toolUseId,
          toolName: interruptedToolResult.toolName ?? 'tool',
          input: {},
          resultSource: 'interrupted',
          toolResult: {
            ok: false,
            isError: true,
            failureKind: 'interrupted',
            recoveryHint: 'Resume from the last completed tool boundary.',
            summary: interruptedToolResult.content
          }
        });
        input.eventObserver.observe({
          type: 'tool_result',
          toolUseId: interruptedToolResult.toolUseId,
          toolName: interruptedToolResult.toolName,
          content: interruptedToolResult.content,
          isError: true,
          transaction: createToolExecutorTransactionSummary(transaction.transaction)
        });
      }
    }
  };
}
