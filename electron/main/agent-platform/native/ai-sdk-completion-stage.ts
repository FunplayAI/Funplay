import type { GenericAgentRuntimeParams } from '../types';
import type { AgentCoreProviderStepResult } from '../../../../shared/types';
import type { ProviderRuntimeController } from '../provider-runtime-events';
import type {
  NativeAiSdkLoopState,
  NativeAiSdkProviderStepResult
} from './ai-sdk-provider-step';
import { createEditFailureRecoveryPrompt } from './continuation-policy';
import {
  applyNativeNoToolProviderContinuationCoreEffect,
  applyNativeNoToolProviderTerminalCoreEffect,
  createNativeNoToolProviderContinuationContext,
  resolveNativeNoToolProviderCompletionEffect
} from './provider-step-completion';
import { NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT } from './tool-loop-options';
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
  if (
    input.loopState.editFailureRecoveries.length > 0 &&
    input.includeWriteTools &&
    input.params.permission.mode !== 'read-only' &&
    input.loopState.editFailureContinuationCount < NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT
  ) {
    input.loopState.editFailureContinuationCount += 1;
    const recoveries = input.loopState.editFailureRecoveries.splice(0);
    const recoveryPrompt = createEditFailureRecoveryPrompt(recoveries);
    input.loopState.messages = [
      ...input.loopState.messages,
      ...responseMessages,
      {
        role: 'user',
        content: recoveryPrompt
      }
    ];
    input.loopState.assistantMessage = '';
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_ai_sdk_edit_failure_recovery',
      title: '恢复失败编辑',
      target: 'stage:native_ai_sdk_edit_failure_recovery',
      status: 'completed',
      summary: '检测到 AI SDK 编辑工具预检失败，已要求模型重新读取目标片段或改用 unified patch 后继续。',
      input: {
        continuation: input.loopState.editFailureContinuationCount,
        failures: recoveries.map((recovery) => ({
          toolName: recovery.toolName,
          path: recovery.path,
          failureKind: recovery.failureKind
        }))
      }
    });
    input.providerController.providerInputReady('AI SDK 编辑失败恢复提示已加入下一轮 provider 输入。');
    return {
      action: 'continue'
    };
  }
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
