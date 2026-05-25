import type { GenericAgentRuntimeParams } from '../types';
import type { AgentCoreProviderStepResult } from '../../../../shared/types';
import type { ProviderRuntimeController } from '../provider-runtime-events';
import type {
  NativeAiSdkLoopState,
  NativeAiSdkProviderStepResult
} from './ai-sdk-provider-step';
import {
  applyNativeNoToolProviderContinuationCoreEffect,
  applyNativeNoToolProviderTerminalCoreEffect,
  createNativeNoToolProviderContinuationContext,
  resolveNativeNoToolProviderCompletionEffect
} from './provider-step-completion';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import type { NativeToolLoopRunResult } from './tool-loop-state';

export type NativeAiSdkCompletionStageDecision =
  | {
      action: 'continue';
    }
  | {
      action: 'return';
      result: NativeToolLoopRunResult;
};

function createNativeAiSdkRunResult(input: {
  loopState: NativeAiSdkLoopState;
  providerStep: NativeAiSdkProviderStepResult;
  coreState?: NativeToolLoopRunResult['coreState'];
  agentCoreParts?: NativeToolLoopRunResult['agentCoreParts'];
}): NativeToolLoopRunResult {
  return {
    assistantMessage: input.providerStep.finalCandidate,
    finishReason: input.providerStep.finishReason,
    stepCount: input.loopState.stepCount,
    toolCalls: input.loopState.toolCalls,
    streamedText: input.loopState.streamedText,
    usage: input.providerStep.usage,
    coreState: input.coreState,
    agentCoreParts: input.agentCoreParts
  };
}

export function completeNativeAiSdkProviderStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  includeWriteTools: boolean;
  loopState: NativeAiSdkLoopState;
  providerStep: NativeAiSdkProviderStepResult;
  providerController: ProviderRuntimeController;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): NativeAiSdkCompletionStageDecision {
  const { finishReason, responseMessages, finalCandidate } = input.providerStep;
  const latestTodoSnapshot = input.loopState.latestTodoSnapshot;
  const {
    controllerSnapshot,
    effect: completionEffect
  } = resolveNativeNoToolProviderCompletionEffect({
    runtime: 'ai-sdk',
    providerStep: input.providerStep.providerStep,
    includeWriteTools: input.includeWriteTools,
    permissionMode: input.params.permission.mode,
    finalCandidate,
    latestTodoSnapshot,
    partialWriteContinuationCount: input.loopState.partialWriteContinuationCount,
    continuationCounters: input.loopState,
    stepNumber: input.loopState.stepCount,
    finishReason,
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

  if (completionEffect.action === 'continue') {
    applyNativeNoToolProviderContinuationCoreEffect({
      effect: completionEffect,
      counters: input.loopState,
      emitStage: input.callbacks?.emitStage,
      prepareNextProviderInput: (reason) => input.providerController.providerInputReady(reason)
    });
    input.loopState.messages = [
      ...input.loopState.messages,
      ...responseMessages,
      {
        role: 'user',
        content: completionEffect.prompt
      }
    ];
    input.loopState.assistantMessage = '';
    return {
      action: 'continue'
    };
  }

  if (completionEffect.action === 'fail') {
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'ai-sdk',
      stepCount: input.loopState.stepCount,
      finishReason,
      toolCalls: input.loopState.toolCalls,
      usage: input.providerStep.usage,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState,
        agentCoreParts: controllerSnapshot.parts
      })
    };
  }

  if (completionEffect.action === 'unsupported') {
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'ai-sdk',
      stepCount: input.loopState.stepCount,
      finishReason,
      toolCalls: input.loopState.toolCalls,
      usage: input.providerStep.usage,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState,
        agentCoreParts: controllerSnapshot.parts
      })
    };
  }

  if (completionEffect.action === 'complete') {
    applyNativeNoToolProviderTerminalCoreEffect({
      effect: completionEffect,
      runtime: 'ai-sdk',
      stepCount: input.loopState.stepCount,
      finishReason,
      toolCalls: input.loopState.toolCalls,
      usage: input.providerStep.usage,
      emitStage: input.callbacks?.emitStage,
      markFailed: (reason) => input.providerController.failRun(reason),
      markCompleted: (reason) => input.providerController.completeRun(reason),
      emitCoreStateStage: input.emitCoreStateStage
    });
    return {
      action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState,
        agentCoreParts: controllerSnapshot.parts
      })
    };
  }

  input.providerController.failRun('Unhandled provider completion effect.');
  input.emitCoreStateStage('failed', 'AI SDK completion stage reached an unhandled provider effect.');
  return {
    action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState,
        agentCoreParts: controllerSnapshot.parts
      })
    };
  }
