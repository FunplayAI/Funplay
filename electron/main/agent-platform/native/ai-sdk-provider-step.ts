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
import type { NativeEditFailureRecovery } from './continuation-policy';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { withDynamicInstructionMessage } from './tool-loop-message-adapter';
import { NEVER_STOP_ON_STEP_COUNT } from './tool-loop-options';
import {
  createNativeProviderStepAbort,
  describeNativeProviderStepError,
  getNativeProviderStepRetryDelayMs,
  NATIVE_PROVIDER_STEP_MAX_RETRIES,
  normalizeNativeProviderStepError,
  shouldRetryNativeProviderStep,
  waitForNativeProviderStepRetry
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
  editFailureContinuationCount: number;
  incompleteTodoContinuationCount: number;
  editFailureRecoveries: NativeEditFailureRecovery[];
  latestTodoSnapshot?: NativeTodoSnapshot;
}

export interface NativeAiSdkProviderStepResult {
  finishReason?: string;
  usage?: unknown;
  responseMessages: ModelMessage[];
  finalCandidate: string;
  providerStep: AgentCoreProviderStepResult;
}

function collectAiSdkEditFailureRecoveries(toolResults: ReturnType<NativeAiSdkStepState['drainStepToolResults']>): NativeEditFailureRecovery[] {
  return toolResults
    .filter((toolResult) =>
      Boolean(toolResult.isError) &&
      Boolean(toolResult.edit?.failureKind) &&
      ['write_file', 'edit_file', 'multi_edit', 'patch_file'].includes(toolResult.toolName ?? '')
    )
    .map((toolResult) => ({
      toolName: toolResult.toolName ?? 'unknown_tool',
      path: typeof toolResult.toolInput?.path === 'string' ? toolResult.toolInput.path : undefined,
      failureKind: toolResult.edit?.failureKind,
      recoveryHint: toolResult.recoveryHint ?? toolResult.edit?.recoveryHint,
      summary: toolResult.content
    }));
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
  let result: ReturnType<typeof streamText> | undefined;
  let sawProviderOutput = false;
  for (let attempt = 0; attempt <= NATIVE_PROVIDER_STEP_MAX_RETRIES; attempt += 1) {
    emitRuntimeStatus(input.params, 'thinking', attempt === 0 ? '正在思考中...' : `Provider 正在重试第 ${attempt} 次...`);
    input.stepState.beginStep();
    const stepAbort = createNativeProviderStepAbort(input.params.abortSignal, provider);
    try {
      result = streamText({
        model: input.model,
        system: createNativeRuntimeSystemPrompt(input.params.uiLanguage),
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

      for await (const event of result.fullStream) {
        switch (event.type) {
          case 'text-delta':
            sawProviderOutput = true;
            input.loopState.assistantMessage += event.text;
            input.loopState.streamedText = true;
            providerEventObserver.observe({
              type: 'text_delta',
              delta: event.text,
              accumulated: input.loopState.assistantMessage
            });
            break;
          case 'reasoning-delta': {
            sawProviderOutput = true;
            input.loopState.thinking += event.text;
            providerEventObserver.observe({
              type: 'thinking_delta',
              delta: event.text,
              accumulated: input.loopState.thinking
            });
            break;
          }
          case 'tool-call': {
            sawProviderOutput = true;
            toolEventAdapter.handleToolCall({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input
            });
            break;
          }
          case 'tool-result': {
            sawProviderOutput = true;
            toolEventAdapter.handleToolResult({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              output: event.output
            });
            break;
          }
          case 'finish-step': {
            sawProviderOutput = true;
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
              const stepToolResults = input.stepState.drainStepToolResults();
              input.loopState.editFailureRecoveries.push(...collectAiSdkEditFailureRecoveries(stepToolResults));
              for (const toolResult of stepToolResults) {
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
      break;
    } catch (error) {
      const normalizedError = normalizeNativeProviderStepError(
        error,
        stepAbort,
        'Native AI SDK provider step'
      );
      if (shouldRetryNativeProviderStep({
        error: normalizedError,
        attempt,
        sawProviderOutput,
        abortSignal: input.params.abortSignal
      })) {
        const retryDelayMs = getNativeProviderStepRetryDelayMs(attempt);
        const retryNumber = attempt + 1;
        const reason = `AI SDK provider step 失败，准备重试 ${retryNumber}/${NATIVE_PROVIDER_STEP_MAX_RETRIES}。`;
        providerEventObserver.observe({
          type: 'provider_retry',
          reason,
          attempt: retryNumber,
          maxRetries: NATIVE_PROVIDER_STEP_MAX_RETRIES,
          retryDelayMs,
          error: describeNativeProviderStepError(normalizedError)
        });
        emitRuntimeStatus(input.params, 'thinking', `Provider 请求不稳定，${Math.round(retryDelayMs / 1000)}s 后重试 ${retryNumber}/${NATIVE_PROVIDER_STEP_MAX_RETRIES}...`);
        await waitForNativeProviderStepRetry(retryDelayMs, input.params.abortSignal);
        continue;
      }

      toolEventAdapter.collectInterruptedToolResults(normalizedError);
      if (stepAbort.timedOut()) {
        providerEventObserver.observe({
          type: 'run_failed',
          reason: 'AI SDK provider step 超时。'
        });
      }
      input.callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行真实 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'failed',
        summary: describeNativeProviderStepError(normalizedError),
        errorMessage: describeNativeProviderStepError(normalizedError)
      });
      throw normalizedError;
    } finally {
      stepAbort.dispose();
    }
  }

  if (!result) {
    throw new Error('Native AI SDK provider step ended without a result.');
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
