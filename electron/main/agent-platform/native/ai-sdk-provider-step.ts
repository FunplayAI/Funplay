import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import type { AgentCoreProviderStepResult } from '../../../../shared/types';
import {
  aiSdkStepToAgentCoreProviderStepResult
} from '../provider-step-adapter';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage } from '../usage';
import { emitRuntimeStatus, emitRuntimeTextDelta, emitRuntimeUsage } from '../runtime-event-emitter';
import { type NativeTodoSnapshot } from './continuation-policy';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { withDynamicInstructionMessage } from './tool-loop-message-adapter';
import { NEVER_STOP_ON_STEP_COUNT } from './tool-loop-options';
import {
  createNativeProviderStepAbort,
  rethrowNativeProviderStepTimeout
} from './provider-step';
import { createNativeRuntimeSystemPrompt } from './prompt';
import {
  createProviderRuntimeEventAdapter,
  type ProviderRuntimeController
} from '../provider-runtime-events';
import { createNativeAiSdkToolEventAdapter } from './ai-sdk-tool-event-adapter';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import type { NativeToolPool } from './tool-pool';
import { normalizeModelReplyText } from './text';

export interface NativeAiSdkLoopState {
  messages: ModelMessage[];
  assistantMessage: string;
  thinking: string;
  stepCount: number;
  streamedText: boolean;
  toolCalls: string[];
  partialWriteContinuationCount: number;
  incompleteTodoContinuationCount: number;
  latestTodoSnapshot?: NativeTodoSnapshot;
}

export interface NativeAiSdkProviderStepResult {
  finishReason?: string;
  usage?: unknown;
  responseMessages: ModelMessage[];
  finalCandidate: string;
  providerStep: AgentCoreProviderStepResult;
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
  providerController: ProviderRuntimeController;
}): Promise<NativeAiSdkProviderStepResult> {
  const provider = input.params.provider;
  if (!provider) {
    throw new Error('Native AI SDK provider step requires a provider.');
  }
  const eventObserver = createProviderRuntimeEventAdapter({
    callbacks: input.callbacks,
    mapToolEventsToCore: false,
    onTextDelta: (delta, accumulated) => {
      emitRuntimeTextDelta(input.params, delta, accumulated);
    },
    onThinkingDelta: (delta, accumulated) => {
      input.callbacks?.emitThinking?.(delta, accumulated);
    }
  });
  const providerEventObserver = {
    observe: (event: Parameters<typeof eventObserver.observe>[0]) => {
      input.providerController.observe(event);
      eventObserver.observe(event);
    }
  };
  const toolEventAdapter = createNativeAiSdkToolEventAdapter({
    callbacks: input.callbacks,
    eventObserver: providerEventObserver,
    definitions: input.toolPool.definitions,
    instructionTracker: input.instructionTracker,
    loopState: input.loopState,
    stepState: input.stepState
  });

  providerEventObserver.observe({
    type: 'provider_step_started',
    reason: `开始第 ${input.loopState.stepCount + 1} 个 AI SDK provider step。`
  });
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
          input.loopState.assistantMessage += event.text;
          input.loopState.streamedText = true;
          providerEventObserver.observe({
            type: 'text_delta',
            delta: event.text,
            accumulated: input.loopState.assistantMessage
          });
          break;
        case 'reasoning-delta': {
          input.loopState.thinking += event.text;
          providerEventObserver.observe({
            type: 'thinking_delta',
            delta: event.text,
            accumulated: input.loopState.thinking
          });
          break;
        }
        case 'tool-call': {
          toolEventAdapter.handleToolCall({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input
          });
          break;
        }
        case 'tool-result': {
          toolEventAdapter.handleToolResult({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: event.output
          });
          break;
        }
        case 'finish-step': {
          input.loopState.stepCount += 1;
          emitRuntimeStatus(input.params, 'thinking', `Native tool loop 已完成 ${input.loopState.stepCount} 步。`);
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
          const providerStep = aiSdkStepToAgentCoreProviderStepResult({
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
            });
          if (providerStepToolCalls.length > 0) {
            providerEventObserver.observe({
              type: 'provider_step_recorded',
              providerStep
            });
            for (const toolResult of input.stepState.drainStepToolResults()) {
              providerEventObserver.observe({
                type: 'tool_result_recorded',
                toolResult
              });
            }
            providerEventObserver.observe({
              type: 'provider_input_ready',
              reason: `AI SDK provider step ${input.loopState.stepCount} 工具结果已进入上下文。`
            });
          }
          input.stepState.beginStep();
          if (stepUsage) {
            emitRuntimeUsage(input.params, stepUsage);
          }
          providerEventObserver.observe({
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
    toolEventAdapter.collectInterruptedToolResults(error);
    if (stepAbort.timedOut()) {
      providerEventObserver.observe({
        type: 'run_failed',
        reason: 'AI SDK provider step 超时。'
      });
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
  const providerStep = aiSdkStepToAgentCoreProviderStepResult({
      text: finalCandidate,
      thinking: input.loopState.thinking,
      finishReason,
      usage,
      toolCalls: input.stepState.buildCurrentToolCalls()
    }, {
      providerId: provider.id,
      model: provider.model
    });

  return {
    finishReason,
    usage,
    responseMessages: (response?.messages ?? []) as ModelMessage[],
    finalCandidate,
    providerStep
  };
}
