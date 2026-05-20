import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import type {
  AgentCoreProviderStepResult,
  AgentCoreState
} from '../../../../shared/types';
import {
  aiSdkStepToAgentCoreProviderStepResult
} from '../provider-step-adapter';
import { createToolExecutorTransactionSummary } from '../tool-executor';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage } from '../usage';
import { type NativeTodoSnapshot } from './continuation-policy';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { observeNativeToolLoopToolResult } from './tool-loop-observer';
import { withDynamicInstructionMessage } from './tool-loop-message-adapter';
import {
  formatInterruptedToolResult,
  normalizeToolOutputForStream
} from './tool-loop-output';
import { recordNativeWorkspaceToolTransactionResult } from './tool-executor';
import { NEVER_STOP_ON_STEP_COUNT } from './tool-loop-options';
import {
  createNativeProviderStepAbort,
  rethrowNativeProviderStepTimeout
} from './provider-step';
import { createNativeRuntimeSystemPrompt } from './prompt';
import {
  createNativeProviderStepEventObserver,
  createNativeProviderToolCallbackHandlers
} from './native-provider-events';
import type {
  NativeRunControllerToolResult,
  NativeToolLoopCallbacks
} from './tool-loop-controller';
import type { NativeToolPool } from './tool-pool';
import { normalizeModelReplyText } from './text';

export interface NativeAiSdkLoopState {
  messages: ModelMessage[];
  assistantMessage: string;
  thinking: string;
  stepCount: number;
  streamedText: boolean;
  toolCalls: string[];
  incompleteTodoContinuationCount: number;
  latestTodoSnapshot?: NativeTodoSnapshot;
}

export interface NativeAiSdkProviderStepResult {
  finishReason?: string;
  usage?: unknown;
  responseMessages: ModelMessage[];
  finalCandidate: string;
}

interface NativeAiSdkProviderStepController {
  markCoreCollecting: (reason: string) => void;
  markCoreExecuting: (reason: string) => void;
  markCoreFailed: (reason: string) => void;
  markCoreRecording: (reason: string) => void;
  markCoreStreaming: (reason: string) => void;
  recordRunControllerProviderStep: () => unknown;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
  setLatestCoreProviderStep: (providerStep: AgentCoreProviderStepResult) => void;
  transitionCoreState: (to: AgentCoreState, reason: string) => void;
}

export async function runNativeAiSdkProviderStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  model: LanguageModel;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  stepState: NativeAiSdkStepState;
  loopState: NativeAiSdkLoopState;
  maxOutputTokens: number;
  controller: NativeAiSdkProviderStepController;
}): Promise<NativeAiSdkProviderStepResult> {
  const provider = input.params.provider;
  if (!provider) {
    throw new Error('Native AI SDK provider step requires a provider.');
  }
  const eventObserver = createNativeProviderStepEventObserver({
    onTextDelta: (delta, accumulated) => {
      input.params.onTextDelta?.(delta, accumulated);
    },
    onThinkingDelta: (delta, accumulated) => {
      input.callbacks?.emitThinking?.(delta, accumulated);
    },
    ...createNativeProviderToolCallbackHandlers(input.callbacks)
  });

  input.controller.markCoreStreaming(`开始第 ${input.loopState.stepCount + 1} 个 AI SDK provider step。`);
  await input.toolPool.refresh({
    stepIndex: input.loopState.stepCount,
    emitStage: input.callbacks?.emitStage
  });
  input.stepState.beginStep();
  const stepAbort = createNativeProviderStepAbort(input.params.abortSignal, provider);
  const result = streamText({
    model: input.model,
    system: createNativeRuntimeSystemPrompt(),
    messages: input.loopState.messages,
    tools: input.toolPool.toolSet,
    activeTools: [...input.toolPool.names],
    toolChoice: 'auto',
    prepareStep: ({ messages, stepNumber }) => {
      const dynamicInstructionMessage = input.instructionTracker.formatDynamicInstructionMessage();
      if (!dynamicInstructionMessage || stepNumber === 0) {
        return undefined;
      }

      return {
        messages: withDynamicInstructionMessage(messages, dynamicInstructionMessage)
      };
    },
    stopWhen: NEVER_STOP_ON_STEP_COUNT,
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: stepAbort.signal
  });

  try {
    for await (const event of result.fullStream) {
      switch (event.type) {
        case 'text-delta':
          input.controller.markCoreStreaming('AI SDK provider 正在流式输出文本。');
          input.loopState.assistantMessage += event.text;
          input.loopState.streamedText = true;
          eventObserver.observe({
            type: 'text_delta',
            delta: event.text,
            accumulated: input.loopState.assistantMessage
          });
          break;
        case 'reasoning-delta': {
          input.controller.markCoreStreaming('AI SDK provider 正在流式输出推理内容。');
          input.loopState.thinking += event.text;
          eventObserver.observe({
            type: 'thinking_delta',
            delta: event.text,
            accumulated: input.loopState.thinking
          });
          break;
        }
        case 'tool-call': {
          input.controller.markCoreExecuting(`AI SDK provider 请求工具 ${event.toolName}。`);
          const trackedToolCall = input.stepState.recordToolCall({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            rawInput: event.input
          });
          input.loopState.toolCalls.push(event.toolName);
          eventObserver.observe({
            type: 'tool_use',
            toolUseId: trackedToolCall.toolUseId,
            toolName: event.toolName,
            input: event.input as Record<string, unknown> | undefined
          });
          break;
        }
        case 'tool-result': {
          input.controller.markCoreRecording(`AI SDK 工具 ${event.toolName} 返回结果。`);
          const toolOutput = normalizeToolOutputForStream(event.output);
          const trackedToolResult = input.stepState.recordToolResult({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
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
          eventObserver.observe({
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
          break;
        }
        case 'finish-step': {
          input.loopState.stepCount += 1;
          if (input.stepState.hasToolCalls) {
            input.controller.markCoreRecording(`AI SDK provider step ${input.loopState.stepCount} 已记录工具结果。`);
            input.controller.transitionCoreState('continuing_after_tools', `AI SDK provider step ${input.loopState.stepCount} 准备继续。`);
            input.controller.transitionCoreState('building_model_input', `AI SDK provider step ${input.loopState.stepCount} 工具结果已进入上下文。`);
          } else {
            input.controller.markCoreCollecting(`AI SDK provider step ${input.loopState.stepCount} 完成，未返回工具调用。`);
          }
          input.params.onStatus?.('thinking', `Native tool loop 已完成 ${input.loopState.stepCount} 步。`);
          input.callbacks?.emitStage?.({
            stageId: 'stage:native_tool_stream',
            title: '执行真实 Tool Loop',
            target: 'stage:native_tool_stream',
            status: 'running',
            summary: `真实 tool loop 已完成 ${input.loopState.stepCount} 步。`,
            input: {
              step: input.loopState.stepCount,
              toolsUsed: [...input.loopState.toolCalls]
            }
          });
          const stepUsage = normalizeAiSdkUsage(event.usage, {
            provider: provider.id,
            model: provider.model
          });
          const providerStepToolCalls = input.stepState.buildProviderToolCalls();
          input.controller.setLatestCoreProviderStep(aiSdkStepToAgentCoreProviderStepResult({
            text: input.loopState.assistantMessage,
            thinking: input.loopState.thinking,
            finishReason: event.finishReason,
            usage: event.usage,
            toolCalls: providerStepToolCalls.map((toolCall) => ({
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input
            }))
          }, {
            providerId: provider.id,
            model: provider.model
          }));
          if (providerStepToolCalls.length > 0) {
            input.controller.recordRunControllerProviderStep();
            for (const toolResult of input.stepState.drainStepToolResults()) {
              input.controller.recordRunControllerToolResult(toolResult);
            }
          }
          input.stepState.beginStep();
          if (stepUsage) {
            input.params.onUsage?.(stepUsage);
          }
          eventObserver.observe({
            type: 'provider_step_done',
            finishReason: event.finishReason,
            toolCallCount: providerStepToolCalls.length,
            text: input.loopState.assistantMessage
          });
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    for (const interruptedToolResult of input.stepState.collectInterruptedToolResults(formatInterruptedToolResult(error))) {
      const transaction = recordNativeWorkspaceToolTransactionResult({
        toolUseId: interruptedToolResult.toolUseId,
        toolName: interruptedToolResult.toolName ?? 'tool',
        input: {},
        toolResult: {
          ok: false,
          isError: true,
          summary: interruptedToolResult.content
        }
      });
      eventObserver.observe({
        type: 'tool_result',
        toolUseId: interruptedToolResult.toolUseId,
        toolName: interruptedToolResult.toolName,
        content: interruptedToolResult.content,
        isError: true,
        transaction: createToolExecutorTransactionSummary(transaction.transaction)
      });
    }
    if (stepAbort.timedOut()) {
      input.controller.markCoreFailed('AI SDK provider step 超时。');
      rethrowNativeProviderStepTimeout(
        error,
        stepAbort,
        'Native AI SDK provider step'
      );
    }
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_tool_stream',
      title: '执行真实 Tool Loop',
      target: 'stage:native_tool_stream',
      status: 'failed',
      summary: error instanceof Error ? error.message : '真实 tool-calling 流执行失败。',
      errorMessage: error instanceof Error ? error.message : '真实 tool-calling 流执行失败。'
    });
    throw error;
  }

  const finishReason = await result.finishReason;
  const usage = await Promise.resolve(result.usage).catch(() => undefined);
  const response = await Promise.resolve(result.response).catch(() => undefined);
  const finalCandidate = normalizeModelReplyText(input.loopState.assistantMessage);
  input.controller.setLatestCoreProviderStep(aiSdkStepToAgentCoreProviderStepResult({
    text: finalCandidate,
    thinking: input.loopState.thinking,
    finishReason,
    usage,
    toolCalls: input.stepState.buildCurrentToolCalls()
  }, {
    providerId: provider.id,
    model: provider.model
  }));

  return {
    finishReason,
    usage,
    responseMessages: (response?.messages ?? []) as ModelMessage[],
    finalCandidate
  };
}
