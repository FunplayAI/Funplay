import type {
  AgentCoreProviderStepResult,
} from '../../agent-core/index';
import type { GenericAgentRuntimeParams } from '../types';
import type { AiProviderApiMode } from '../../../../shared/types';
import type { OpenAiCompatibleToolStepResult } from '../../openai-compatible-client';
import type { ProviderRuntimeController } from '../provider-runtime-events';
import {
  applyNativeNoToolProviderContinuationCoreEffect,
  applyNativeNoToolProviderTerminalCoreEffect,
  createNativeNoToolProviderContinuationContext,
  resolveNativeNoToolProviderCompletionEffect
} from './provider-step-completion';
import type {
  NativeProcessTextStepStream,
  NativeProcessTextStream
} from './tool-loop-process-stream';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import {
  appendNativeToolLoopAssistantToolMessage,
  createNativeToolLoopRunResult,
  recordNativeToolLoopAssistantText,
  type NativeToolLoopRunResult,
  type NativeToolLoopState
} from './tool-loop-state';
import { normalizeModelReplyText } from './text';

export type OpenAiCompatibleCompletionStageDecision =
  | {
      action: 'continue';
      nextStepIndex: number;
    }
  | {
      action: 'return';
      result: NativeToolLoopRunResult;
};

export function completeOpenAiCompatibleNoToolStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  includeWriteTools: boolean;
  apiMode: AiProviderApiMode;
  state: NativeToolLoopState;
  stepIndex: number;
  stepResult: OpenAiCompatibleToolStepResult;
  providerStep: AgentCoreProviderStepResult;
  processTextStream: NativeProcessTextStream;
  stepStream: NativeProcessTextStepStream;
  providerController: ProviderRuntimeController;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): OpenAiCompatibleCompletionStageDecision {
  const finalCandidate = normalizeModelReplyText(input.stepResult.text);
  const latestTodoSnapshot = input.state.latestTodoSnapshot;
  const {
    controllerSnapshot,
    effect: completionEffect
  } = resolveNativeNoToolProviderCompletionEffect({
    runtime: 'openai-compatible',
    providerStep: input.providerStep,
    includeWriteTools: input.includeWriteTools,
    permissionMode: input.params.permission.mode,
    finalCandidate,
    latestTodoSnapshot,
    partialWriteContinuationCount: input.state.partialWriteContinuationCount,
    continuationCounters: input.state,
    stepNumber: input.stepIndex + 1,
    finishReason: input.state.finishReason,
    recordRunControllerProviderStep: (options: {
      providerStep: AgentCoreProviderStepResult;
      continuation?: ReturnType<typeof createNativeNoToolProviderContinuationContext>;
    }) => input.providerController.recordProviderStep({
      providerStep: options.providerStep,
      options: {
        continuation: options.continuation
      }
    }).runController
  });

  if (completionEffect.action === 'continue' && completionEffect.reason !== 'length') {
    input.state.parts.push({
      type: 'continuation',
      stepIndex: input.stepIndex,
      reason: completionEffect.reason,
      text: finalCandidate
    });
    applyNativeNoToolProviderContinuationCoreEffect({
      effect: completionEffect,
      counters: input.state,
      emitStage: input.callbacks?.emitStage,
      prepareNextProviderInput: (reason) => input.providerController.providerInputReady(reason)
    });
    input.processTextStream.discard(input.stepStream);
    input.state.messages.push({
      role: 'assistant',
      content: finalCandidate,
      reasoningContent: input.stepResult.reasoningContent
    });
    input.state.messages.push({
      role: 'user',
      content: completionEffect.prompt
    });
    return {
      action: 'continue',
      nextStepIndex: input.stepIndex + 1
    };
  }

  if (completionEffect.action === 'continue' && completionEffect.reason === 'length') {
    if (finalCandidate.trim()) {
      recordNativeToolLoopAssistantText(input.state, input.stepIndex, finalCandidate, {
        final: false
      });
      input.processTextStream.commit(finalCandidate, input.stepStream);
    } else {
      input.processTextStream.discard(input.stepStream);
    }
    applyNativeNoToolProviderContinuationCoreEffect({
      effect: completionEffect,
      counters: input.state,
      emitStage: input.callbacks?.emitStage,
      prepareNextProviderInput: (reason) => input.providerController.providerInputReady(reason)
    });
    appendNativeToolLoopAssistantToolMessage(input.state, input.stepResult, {
      apiMode: input.apiMode,
      assistantText: finalCandidate
    });
    input.state.messages.push({
      role: 'user',
      content: completionEffect.prompt
    });
    return {
      action: 'continue',
      nextStepIndex: input.stepIndex + 1
    };
  }

  if (completionEffect.action === 'fail') {
    input.processTextStream.discard(input.stepStream);
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'openai-compatible',
      stepCount: input.stepIndex + 1,
      finishReason: input.state.finishReason,
      toolCalls: input.state.toolCalls,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState, controllerSnapshot.parts)
    };
  }

  if (completionEffect.action === 'unsupported') {
    input.processTextStream.discard(input.stepStream);
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'openai-compatible',
      stepCount: input.stepIndex + 1,
      finishReason: input.state.finishReason,
      toolCalls: input.state.toolCalls,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState, controllerSnapshot.parts)
    };
  }

  if (completionEffect.action === 'complete') {
    recordNativeToolLoopAssistantText(input.state, input.stepIndex, finalCandidate, {
      final: true
    });
    input.processTextStream.commit(finalCandidate, input.stepStream);
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'openai-compatible',
      stepCount: input.stepIndex + 1,
      finishReason: input.state.finishReason,
      toolCalls: input.state.toolCalls,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState, controllerSnapshot.parts)
    };
  }

  input.processTextStream.discard(input.stepStream);
  input.providerController.failRun('Unhandled provider completion effect.');
  input.emitCoreStateStage('failed', 'Native completion stage reached an unhandled provider effect.');
  return {
    action: 'return',
    result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState, controllerSnapshot.parts)
  };
}
