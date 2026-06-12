import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { AgentCoreProviderStepResult, AiProvider, ProjectSessionEffort } from '../../../../shared/types';
import { resolveProviderEffortLevel, resolveProviderModelMetadata } from '../../../../shared/provider-catalog';
import { aiSdkStepToAgentCoreProviderStepResult } from '../provider-step-adapter';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage } from '../usage';
import { emitRuntimeStatus, emitRuntimeTextDelta, emitRuntimeUsage } from '../runtime-event-emitter';
import { type NativeTodoSnapshot } from './continuation-policy';
import type { NativeEditFailureRecovery } from './continuation-policy';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { withDynamicInstructionMessage } from './tool-loop-message-adapter';
import {
  createNativeProviderStepAbort,
  describeNativeProviderStepError,
  getNativeProviderStepRetryDelayMs,
  NATIVE_PROVIDER_STEP_MAX_RETRIES,
  normalizeNativeProviderStepError,
  shouldRetryNativeProviderStep,
  waitForNativeProviderStepRetry
} from './provider-step';
import { createNativeToolLoopSystemPrompt } from './tool-loop-prompt';
import { createProviderRuntimeEventAdapter, type ProviderRuntimeController } from '../provider-runtime-events';
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

const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = {
  anthropic: {
    cacheControl: {
      type: 'ephemeral' as const
    }
  }
};

// Maps the session effort to Anthropic provider options. The AI SDK anthropic
// options accept effort low/medium/high/max directly; 'xhigh' (an OpenAI-side
// level) clamps to 'max'. Gated on the catalog declaring supportsEffort so
// older models never receive an unknown parameter.
export function buildNativeAiSdkEffortProviderOptions(
  provider: AiProvider,
  sessionEffort: ProjectSessionEffort | undefined
): ProviderOptions | undefined {
  if (provider.protocol !== 'anthropic') {
    return undefined;
  }
  const resolved = resolveProviderEffortLevel(provider, sessionEffort);
  if (!resolved) {
    return undefined;
  }
  const effort = resolved === 'xhigh' ? 'max' : resolved;
  const capabilities = resolveProviderModelMetadata(provider)?.capabilities;
  return {
    anthropic: {
      effort,
      ...(capabilities?.supportsAdaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {})
    }
  };
}

// Marks the LAST message of a request with an Anthropic prompt-cache breakpoint.
// The source messages are never mutated — each step gets a fresh shallow copy of
// the tail so exactly one history breakpoint exists per request and the stored
// transcript stays clean for the next step's prefix reuse.
export function applyNativeAnthropicTailCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }
  const last = messages[messages.length - 1];
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        ...ANTHROPIC_EPHEMERAL_CACHE_CONTROL
      }
    } as ModelMessage
  ];
}

function collectAiSdkEditFailureRecoveries(
  toolResults: ReturnType<NativeAiSdkStepState['drainStepToolResults']>
): NativeEditFailureRecovery[] {
  return toolResults
    .filter(
      (toolResult) =>
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
  maxSteps: number;
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
  // Static per run: deterministic given (params, tool definitions), so the bytes
  // are identical across consecutive steps and providers can prefix-cache it.
  const systemPrompt = createNativeToolLoopSystemPrompt(input.params, {
    toolDefinitions: input.toolPool.definitions
  });
  const useAnthropicCacheBreakpoints = provider.protocol === 'anthropic';
  const system = useAnthropicCacheBreakpoints
    ? {
        role: 'system' as const,
        content: systemPrompt,
        providerOptions: ANTHROPIC_EPHEMERAL_CACHE_CONTROL
      }
    : systemPrompt;
  const effortProviderOptions = buildNativeAiSdkEffortProviderOptions(provider, input.params.context.sessionEffort);
  let result: ReturnType<typeof streamText> | undefined;
  let sawProviderOutput = false;
  for (let attempt = 0; attempt <= NATIVE_PROVIDER_STEP_MAX_RETRIES; attempt += 1) {
    emitRuntimeStatus(
      input.params,
      'thinking',
      attempt === 0 ? '正在思考中...' : `Provider 正在重试第 ${attempt} 次...`
    );
    input.stepState.beginStep();
    const stepAbort = createNativeProviderStepAbort(input.params.abortSignal, provider);
    try {
      result = streamText({
        model: input.model,
        system,
        messages: input.loopState.messages,
        tools: input.toolPool.toolSet,
        activeTools: [...input.toolPool.names],
        toolChoice: 'auto',
        ...(effortProviderOptions ? { providerOptions: effortProviderOptions } : {}),
        prepareStep: ({ messages, stepNumber }) => {
          const dynamicInstructionMessage = input.instructionTracker.formatDynamicInstructionMessage();
          const baseMessages =
            dynamicInstructionMessage && stepNumber > 0
              ? withDynamicInstructionMessage(messages, dynamicInstructionMessage)
              : messages;
          const stepMessages = useAnthropicCacheBreakpoints
            ? applyNativeAnthropicTailCacheBreakpoint(baseMessages)
            : baseMessages;
          if (stepMessages === messages) {
            return undefined;
          }

          return {
            messages: stepMessages
          };
        },
        stopWhen: () => input.loopState.stepCount >= input.maxSteps,
        maxOutputTokens: input.maxOutputTokens,
        abortSignal: stepAbort.signal
      });

      for await (const event of result.fullStream) {
        switch (event.type) {
          case 'text-delta':
            sawProviderOutput = true;
            input.loopState.assistantMessage += event.text;
            input.stepState.recordTextDelta(event.text);
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
            input.stepState.recordThinkingDelta(event.text);
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
            emitRuntimeStatus(
              input.params,
              'thinking',
              `已完成 ${input.loopState.stepCount} 轮工具执行，正在整理结果…`
            );
            input.callbacks?.emitStage?.({
              stageId: 'stage:native_tool_stream',
              title: '执行工具步骤',
              target: 'stage:native_tool_stream',
              status: 'running',
              summary: `已完成 ${input.loopState.stepCount} 轮工具执行。`,
              input: {
                step: input.loopState.stepCount,
                toolsUsed: [...input.loopState.toolCalls]
              }
            });
            const stepUsage = normalizeAiSdkUsage(event.usage, {
              provider: provider.id,
              model: provider.model
            });
            const providerStepText = input.stepState.getStepText();
            const providerStepThinking = input.stepState.getStepThinking();
            const providerStepToolCalls = input.stepState.buildProviderToolCalls();
            const providerStep = aiSdkStepToAgentCoreProviderStepResult(
              {
                text: providerStepText,
                thinking: providerStepThinking,
                finishReason: event.finishReason,
                usage: event.usage,
                toolCalls: providerStepToolCalls.map((toolCall) => ({
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: toolCall.input
                }))
              },
              {
                providerId: provider.id,
                model: provider.model
              }
            );
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
            if (stepUsage) {
              emitRuntimeUsage(input.params, stepUsage);
            }
            providerEventObserver.observe({
              type: 'provider_step_done',
              finishReason: event.finishReason,
              toolCallCount: providerStepToolCalls.length,
              text: providerStepText
            });
            if (providerStepToolCalls.length > 0) {
              input.stepState.beginStep();
            }
            break;
          }
          default:
            break;
        }
      }
      break;
    } catch (error) {
      const normalizedError = normalizeNativeProviderStepError(error, stepAbort, 'Native AI SDK provider step');
      if (
        shouldRetryNativeProviderStep({
          error: normalizedError,
          attempt,
          sawProviderOutput,
          abortSignal: input.params.abortSignal
        })
      ) {
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
        emitRuntimeStatus(
          input.params,
          'thinking',
          `Provider 请求不稳定，${Math.round(retryDelayMs / 1000)}s 后重试 ${retryNumber}/${NATIVE_PROVIDER_STEP_MAX_RETRIES}...`
        );
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
        title: '执行工具步骤',
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
  const providerStep = aiSdkStepToAgentCoreProviderStepResult(
    {
      text: input.stepState.getStepText(),
      thinking: input.stepState.getStepThinking(),
      finishReason,
      usage,
      toolCalls: input.stepState.buildCurrentToolCalls()
    },
    {
      providerId: provider.id,
      model: provider.model
    }
  );

  return {
    finishReason,
    usage,
    responseMessages: (response?.messages ?? []) as ModelMessage[],
    finalCandidate,
    providerStep
  };
}
