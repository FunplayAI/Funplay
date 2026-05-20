import type {
  OpenAiCompatibleToolMessage,
  OpenAiCompatibleToolStepResult
} from '../../openai-compatible-client';
import {
  generateOpenAiCompatibleStreamingToolStep
} from '../../openai-compatible-client';
import {
  openAiCompatibleStepToAgentCoreProviderStepResult
} from '../provider-step-adapter';
import {
  DYNAMIC_PROJECT_INSTRUCTIONS_MARKER,
  ProjectInstructionTracker
} from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeOpenAiUsage } from '../usage';
import type { AgentCoreProviderStepResult } from '../../../../shared/types';
import {
  createNativeProviderStepAbort,
  rethrowNativeProviderStepTimeout
} from './provider-step';
import { createNativeProviderStepEventObserver } from './native-provider-events';
import { createNativeRuntimeSystemPrompt } from './prompt';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import type { NativeToolLoopState } from './tool-loop-state';
import type { NativeProcessTextStepStream, NativeProcessTextStream } from './tool-loop-process-stream';
import type { NativeToolPool } from './tool-pool';

function withDynamicOpenAiCompatibleInstructionMessage(
  messages: OpenAiCompatibleToolMessage[],
  content: string
): OpenAiCompatibleToolMessage[] {
  return [
    ...messages.filter((message) => message.role !== 'user' || !message.content.startsWith(DYNAMIC_PROJECT_INSTRUCTIONS_MARKER)),
    {
      role: 'user',
      content
    }
  ];
}

export async function runOpenAiCompatibleProviderStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  state: NativeToolLoopState;
  stepIndex: number;
  maxOutputTokens: number;
  processTextStream: NativeProcessTextStream;
  stepStream: NativeProcessTextStepStream;
  setLatestCoreProviderStep: (providerStep: AgentCoreProviderStepResult) => void;
}): Promise<OpenAiCompatibleToolStepResult> {
  const provider = input.params.provider;
  if (!provider || provider.protocol !== 'openai-compatible') {
    throw new Error('OpenAI-compatible provider step requires an OpenAI-compatible provider.');
  }
  const dynamicInstructionMessage = input.instructionTracker.formatDynamicInstructionMessage();
  const stepMessages =
    dynamicInstructionMessage && input.stepIndex > 0
      ? withDynamicOpenAiCompatibleInstructionMessage(input.state.messages, dynamicInstructionMessage)
      : input.state.messages;
  input.params.onStatus?.('thinking', '正在思考中...');
  const stepAbort = createNativeProviderStepAbort(input.params.abortSignal, provider);
  const eventObserver = createNativeProviderStepEventObserver({
    onTextDelta: (delta, accumulated) => {
      input.processTextStream.emitRealtimeDelta(delta, accumulated, input.stepStream);
    },
    onThinkingDelta: (delta, accumulated) => {
      input.state.thinking = accumulated || (input.state.thinking + delta);
      input.callbacks?.emitThinking?.(delta, input.state.thinking);
    }
  });
  const stepResult = await generateOpenAiCompatibleStreamingToolStep({
      provider,
      system: createNativeRuntimeSystemPrompt(),
      messages: stepMessages,
      tools: input.toolPool.openAiCompatibleTools,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: stepAbort.signal,
      onDelta: (delta, accumulated) => {
        eventObserver.observe({
          type: 'text_delta',
          delta,
          accumulated
        });
      },
      onReasoningDelta: (delta, accumulated) => {
        eventObserver.observe({
          type: 'thinking_delta',
          delta,
          accumulated
        });
      }
    })
    .catch((error: unknown) => rethrowNativeProviderStepTimeout(
      error,
      stepAbort,
      'Native OpenAI-compatible provider step'
    ));
  input.state.stepCount = input.stepIndex + 1;
  input.state.finishReason = stepResult.finishReason;
  input.state.usage = stepResult.usage;
  input.setLatestCoreProviderStep(openAiCompatibleStepToAgentCoreProviderStepResult(stepResult, {
    providerId: provider.id,
    model: provider.model
  }));
  const stepUsage = normalizeOpenAiUsage(stepResult.usage, {
    provider: provider.id,
    model: provider.model
  });
  if (stepUsage) {
    input.params.onUsage?.(stepUsage);
  }
  eventObserver.observe({
    type: 'provider_step_done',
    finishReason: stepResult.finishReason,
    toolCallCount: stepResult.toolCalls.length,
    text: stepResult.text
  });

  return stepResult;
}
