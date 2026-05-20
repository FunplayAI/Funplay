import type { AgentToolTransactionSummary } from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import type { OpenAiCompatibleToolCall } from '../../openai-compatible-client';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import {
  collectEditFailureRecovery,
  type NativeEditFailureRecovery
} from './continuation-policy';
import {
  createInvalidMultiEditInputResult
} from './tool-loop-options';
import {
  formatInterruptedToolResult,
  truncateToolArgumentPreview
} from './tool-loop-output';
import {
  type NativeRunControllerToolResult,
  type NativeToolLoopCallbacks
} from './tool-loop-controller';
import { observeNativeToolLoopToolResult } from './tool-loop-observer';
import type {
  NativeOpenAiToolInvocation,
  NativeToolLoopState
} from './tool-loop-state';
import {
  executeNativeWorkspaceToolTransaction,
  recordNativeWorkspaceToolTransactionResult,
  type NativeWorkspaceToolOutput
} from './tool-executor';
import {
  createNativeProviderStepEventObserver,
  createNativeProviderToolCallbackHandlers,
  type NativeProviderStepEventObserver
} from './native-provider-events';
import type { NativeToolPool } from './tool-pool';

function createOpenAiToolInvocations(input: {
  toolCalls: OpenAiCompatibleToolCall[];
  stepIndex: number;
}): NativeOpenAiToolInvocation[] {
  return input.toolCalls.map((toolCall) => ({
    toolCall,
    toolUseId: toolCall.id || makeId('tool'),
    stepIndex: input.stepIndex,
    started: false,
    completed: false
  }));
}

function createMalformedToolResult(toolCall: OpenAiCompatibleToolCall): NativeWorkspaceToolOutput | undefined {
  if (!toolCall.argumentsParseError) {
    return undefined;
  }
  return {
    ok: false,
    isError: true,
    media: undefined,
    summary: [
      `工具调用参数 JSON 无法解析，未执行 ${toolCall.name}。`,
      `错误：${toolCall.argumentsParseError}`,
      toolCall.rawArguments ? `原始参数：${truncateToolArgumentPreview(toolCall.rawArguments)}` : ''
    ].filter(Boolean).join('\n')
  };
}

function createPrecomputedToolResult(input: {
  state: NativeToolLoopState;
  toolUseId: string;
  toolCall: OpenAiCompatibleToolCall;
}): {
  cachedToolResult?: NativeToolLoopState['completedToolResultsByUseId'] extends Map<string, infer T> ? T : never;
  malformedToolResult?: NativeWorkspaceToolOutput;
  invalidToolInputResult?: NativeWorkspaceToolOutput;
  precomputedToolResult?: NativeWorkspaceToolOutput;
} {
  const cachedToolResult = input.state.completedToolResultsByUseId.get(input.toolUseId);
  const malformedToolResult = createMalformedToolResult(input.toolCall);
  const invalidToolInputResult = malformedToolResult ? undefined : createInvalidMultiEditInputResult(input.toolCall);
  const precomputedToolResult: NativeWorkspaceToolOutput | undefined = cachedToolResult
    ? {
        ok: !cachedToolResult.isError,
        summary: cachedToolResult.summary,
        isError: cachedToolResult.isError,
        media: cachedToolResult.media,
        changedFiles: cachedToolResult.changedFiles,
        command: cachedToolResult.command,
        terminal: cachedToolResult.terminal,
        browser: cachedToolResult.browser,
        edit: cachedToolResult.edit,
        mcp: cachedToolResult.mcp,
        artifacts: cachedToolResult.artifacts
      }
    : malformedToolResult ?? invalidToolInputResult;

  return {
    cachedToolResult,
    malformedToolResult,
    invalidToolInputResult,
    precomputedToolResult
  };
}

function createOpenAiToolStageRecorder(input: {
  state: NativeToolLoopState;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
}) {
  const recordToolUseStart = (invocation: NativeOpenAiToolInvocation): void => {
    if (invocation.started) {
      return;
    }
    invocation.started = true;
    input.state.toolCalls.push(invocation.toolCall.name);
    input.state.parts.push({
      type: 'tool_use',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      name: invocation.toolCall.name,
      input: invocation.toolCall.arguments
    });
  };

  const recordToolResult = (
    invocation: NativeOpenAiToolInvocation,
    toolResult: NativeWorkspaceToolOutput,
    summary: string,
    transaction?: AgentToolTransactionSummary
  ): void => {
    invocation.completed = true;
    input.recordRunControllerToolResult({
      toolUseId: invocation.toolUseId,
      toolName: invocation.toolCall.name,
      content: summary,
      isError: Boolean(toolResult.isError),
      failureKind: toolResult.edit?.failureKind,
      recoveryHint: toolResult.edit?.recoveryHint,
      changedFiles: toolResult.changedFiles,
      command: toolResult.command,
      terminal: toolResult.terminal,
      browser: toolResult.browser,
      edit: toolResult.edit,
      mcp: toolResult.mcp,
      artifacts: toolResult.artifacts,
      transaction
    });
    input.state.parts.push({
      type: 'tool_result',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      content: summary,
      isError: Boolean(toolResult.isError)
    });
    input.state.messages.push({
      role: 'tool',
      toolCallId: invocation.toolUseId,
      name: invocation.toolCall.name,
      content: summary
    });
  };

  return {
    recordToolResult,
    recordToolUseStart
  };
}

function emitInterruptedToolResults(input: {
  invocations: NativeOpenAiToolInvocation[];
  error: unknown;
  state: NativeToolLoopState;
  eventObserver: NativeProviderStepEventObserver;
  recordToolUseStart: (invocation: NativeOpenAiToolInvocation) => void;
  recordToolResult: (
    invocation: NativeOpenAiToolInvocation,
    toolResult: NativeWorkspaceToolOutput,
    summary: string,
    transaction?: AgentToolTransactionSummary
  ) => void;
}): void {
  for (const invocation of input.invocations) {
    if (invocation.completed) {
      continue;
    }
    const summary = formatInterruptedToolResult(input.error);
    input.state.completedToolResultsByUseId.set(invocation.toolUseId, {
      name: invocation.toolCall.name,
      summary,
      isError: true
    });
    recordNativeWorkspaceToolTransactionResult({
      toolUseId: invocation.toolUseId,
      toolName: invocation.toolCall.name,
      input: invocation.toolCall.arguments,
      hooks: {
        onStart: () => {
          input.recordToolUseStart(invocation);
          input.eventObserver.observe({
            type: 'tool_use',
            toolUseId: invocation.toolUseId,
            toolName: invocation.toolCall.name,
            input: invocation.toolCall.arguments
          });
        },
        onResult: (toolResult, resultSummary, transactionSummary) => {
          input.recordToolResult(invocation, toolResult, resultSummary, transactionSummary);
          input.eventObserver.observe({
            type: 'tool_result',
            toolUseId: invocation.toolUseId,
            toolName: invocation.toolCall.name,
            content: resultSummary,
            isError: Boolean(toolResult.isError),
            media: toolResult.media,
            changedFiles: toolResult.changedFiles,
            command: toolResult.command,
            terminal: toolResult.terminal,
            browser: toolResult.browser,
            edit: toolResult.edit,
            mcp: toolResult.mcp,
            artifacts: toolResult.artifacts,
            transaction: transactionSummary
          });
        }
      },
      toolResult: {
        ok: false,
        isError: true,
        summary
      }
    });
  }
}

export async function executeOpenAiCompatibleToolStage(input: {
  toolCalls: OpenAiCompatibleToolCall[];
  stepIndex: number;
  state: NativeToolLoopState;
  callbacks?: NativeToolLoopCallbacks;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
}): Promise<{
  editFailureRecoveries: NativeEditFailureRecovery[];
}> {
  const invocations = createOpenAiToolInvocations({
    toolCalls: input.toolCalls,
    stepIndex: input.stepIndex
  });
  const recorder = createOpenAiToolStageRecorder({
    state: input.state,
    recordRunControllerToolResult: input.recordRunControllerToolResult
  });
  const eventObserver = createNativeProviderStepEventObserver({
    ...createNativeProviderToolCallbackHandlers(input.callbacks)
  });
  const editFailureRecoveries: NativeEditFailureRecovery[] = [];

  try {
    for (const invocation of invocations) {
      const { toolCall, toolUseId } = invocation;
      const {
        cachedToolResult,
        malformedToolResult,
        invalidToolInputResult,
        precomputedToolResult
      } = createPrecomputedToolResult({
        state: input.state,
        toolUseId,
        toolCall
      });
      const transaction = await executeNativeWorkspaceToolTransaction({
        tools: input.toolPool.toolSet,
        toolUseId,
        toolName: toolCall.name,
        input: toolCall.arguments,
        precomputedResult: precomputedToolResult,
        hooks: {
          onStart: () => {
            recorder.recordToolUseStart(invocation);
            eventObserver.observe({
              type: 'tool_use',
              toolUseId,
              toolName: toolCall.name,
              input: toolCall.arguments
            });
          },
          onResult: (result, resultSummary, transactionSummary) => {
            recorder.recordToolResult(invocation, result, resultSummary, transactionSummary);
            eventObserver.observe({
              type: 'tool_result',
              toolUseId,
              toolName: toolCall.name,
              content: resultSummary,
              isError: Boolean(result.isError),
              media: result.media,
              changedFiles: result.changedFiles,
              command: result.command,
              terminal: result.terminal,
              browser: result.browser,
              edit: result.edit,
              mcp: result.mcp,
              artifacts: result.artifacts,
              transaction: transactionSummary
            });
          }
        }
      });
      const toolResult = transaction.toolResult;
      const summary = transaction.summary;
      const editRecovery = collectEditFailureRecovery(toolCall, toolResult);
      if (editRecovery) {
        editFailureRecoveries.push(editRecovery);
      }
      const todoSnapshot = observeNativeToolLoopToolResult({
        instructionTracker: input.instructionTracker,
        callbacks: input.callbacks,
        toolName: toolCall.name,
        toolInput: toolCall.arguments,
        summary,
        isError: Boolean(toolResult.isError)
      });
      if (todoSnapshot) {
        input.state.latestTodoSnapshot = todoSnapshot;
      }
      if (cachedToolResult) {
        input.callbacks?.emitStage?.({
          stageId: `stage:native_duplicate_tool_result:${toolUseId}`,
          title: '跳过重复工具执行',
          target: toolCall.name,
          status: 'completed',
          summary: `检测到重复 toolUseId=${toolUseId}，已回放先前工具结果，未再次执行工具。`
        });
      } else {
        input.state.completedToolResultsByUseId.set(toolUseId, {
          name: toolCall.name,
          summary,
          isError: Boolean(toolResult.isError),
          media: toolResult.media,
          changedFiles: toolResult.changedFiles,
          command: toolResult.command,
          terminal: toolResult.terminal,
          browser: toolResult.browser,
          edit: toolResult.edit,
          mcp: toolResult.mcp,
          artifacts: toolResult.artifacts
        });
        if (malformedToolResult) {
          input.callbacks?.emitStage?.({
            stageId: `stage:native_malformed_tool_arguments:${toolUseId}`,
            title: '拒绝畸形工具参数',
            target: toolCall.name,
            status: 'completed',
            summary: `检测到 ${toolCall.name} 的工具参数不是有效 JSON，已作为工具错误回放给模型，未执行真实工具。`
          });
        } else if (invalidToolInputResult) {
          input.callbacks?.emitStage?.({
            stageId: `stage:native_invalid_tool_input:${toolUseId}`,
            title: '拒绝无效工具参数',
            target: toolCall.name,
            status: 'completed',
            summary: `检测到 ${toolCall.name} 的工具参数不满足执行条件，已作为工具错误回放给模型，未执行真实工具。`
          });
        }
      }
    }
  } catch (error) {
    emitInterruptedToolResults({
      invocations,
      error,
      state: input.state,
      eventObserver,
      recordToolUseStart: recorder.recordToolUseStart,
      recordToolResult: recorder.recordToolResult
    });
    throw error;
  }

  return {
    editFailureRecoveries
  };
}
