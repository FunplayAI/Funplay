import type { AgentRunControllerSnapshot } from '../agent-run-controller';
import type { GenericAgentRuntimeParams } from '../types';
import type { AgentCoreState } from '../../../../shared/types';
import {
  createIncompleteTodoContinuationPrompt,
  createLengthContinuationPrompt
} from './continuation-policy';
import type {
  NativeAiSdkLoopState,
  NativeAiSdkProviderStepResult
} from './ai-sdk-provider-step';
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

function emitNativeAiSdkToolStreamCompleted(input: {
  callbacks?: NativeToolLoopCallbacks;
  loopState: NativeAiSdkLoopState;
  providerStep: NativeAiSdkProviderStepResult;
  usage?: unknown;
  suffix?: string;
}): void {
  input.callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行真实 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'completed',
    summary: [
      `完成 ${input.loopState.stepCount} 步`,
      input.providerStep.finishReason ? `finishReason=${input.providerStep.finishReason}` : '',
      input.loopState.toolCalls.length > 0 ? `tools=${input.loopState.toolCalls.join(', ')}` : 'tools=none',
      input.suffix
    ]
      .filter(Boolean)
      .join('；'),
    input: {
      step: input.loopState.stepCount,
      finishReason: input.providerStep.finishReason,
      toolsUsed: [...input.loopState.toolCalls],
      usage: input.usage
    }
  });
}

function createNativeAiSdkRunResult(input: {
  loopState: NativeAiSdkLoopState;
  providerStep: NativeAiSdkProviderStepResult;
  coreState?: NativeToolLoopRunResult['coreState'];
}): NativeToolLoopRunResult {
  return {
    assistantMessage: input.providerStep.finalCandidate,
    finishReason: input.providerStep.finishReason,
    stepCount: input.loopState.stepCount,
    toolCalls: input.loopState.toolCalls,
    streamedText: input.loopState.streamedText,
    usage: input.providerStep.usage,
    coreState: input.coreState
  };
}

export function completeNativeAiSdkProviderStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  includeWriteTools: boolean;
  loopState: NativeAiSdkLoopState;
  providerStep: NativeAiSdkProviderStepResult;
  recordRunControllerProviderStep: (options?: {
    continuation?: {
      includeWriteTools?: boolean;
      permissionMode?: string;
      assistantMessage?: string;
      incompleteTodo?: {
        incompleteCount: number;
        hasInProgress?: boolean;
      };
    };
  }) => AgentRunControllerSnapshot;
  transitionCoreState: (to: AgentCoreState, reason: string) => void;
  markCoreCompleted: (reason: string) => void;
  markCoreFailed: (reason: string) => void;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): NativeAiSdkCompletionStageDecision {
  const { finishReason, responseMessages, finalCandidate } = input.providerStep;
  const controllerSnapshot = input.recordRunControllerProviderStep({
    continuation: {
      includeWriteTools: input.includeWriteTools,
      permissionMode: input.params.permission.mode,
      assistantMessage: finalCandidate,
      incompleteTodo: input.loopState.latestTodoSnapshot
        ? {
            incompleteCount: input.loopState.latestTodoSnapshot.incompleteItems.length,
            hasInProgress: input.loopState.latestTodoSnapshot.hasInProgress
          }
        : undefined
    }
  });
  if (controllerSnapshot.lastContinuation?.reason === 'incomplete_todo' && input.loopState.latestTodoSnapshot) {
    input.loopState.incompleteTodoContinuationCount += 1;
    const continuationPrompt = createIncompleteTodoContinuationPrompt(input.loopState.latestTodoSnapshot, finalCandidate);
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_incomplete_todo_continuation',
      title: '续跑未完成任务清单',
      target: 'stage:native_incomplete_todo_continuation',
      status: 'completed',
      summary: '模型结束时仍有 in_progress/pending todo，已要求继续调用工具完成剩余步骤。',
      input: {
        continuation: input.loopState.incompleteTodoContinuationCount,
        incompleteItems: input.loopState.latestTodoSnapshot.incompleteItems,
        finishReason
      }
    });
    input.transitionCoreState('building_model_input', 'Todo 仍有未完成项，继续下一轮 AI SDK provider step。');
    input.loopState.messages = [
      ...input.loopState.messages,
      ...responseMessages,
      {
        role: 'user',
        content: continuationPrompt
      }
    ];
    input.loopState.assistantMessage = '';
    return {
      action: 'continue'
    };
  }

  if (controllerSnapshot.nextAction === 'build_model_input' && controllerSnapshot.lastContinuation?.reason === 'length') {
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_length_continuation',
      title: '续跑长度截断回复',
      target: 'stage:native_length_continuation',
      status: 'completed',
      summary: 'AI SDK provider 返回 length 截断，已继续下一轮；length 不是真正完成态。',
      input: {
        step: input.loopState.stepCount,
        finishReason,
        assistantMessage: finalCandidate
      }
    });
    input.transitionCoreState('building_model_input', 'AI SDK provider 返回 length 截断，继续下一轮 provider step。');
    input.loopState.messages = [
      ...input.loopState.messages,
      ...responseMessages,
      {
        role: 'user',
        content: createLengthContinuationPrompt(finalCandidate)
      }
    ];
    input.loopState.assistantMessage = '';
    return {
      action: 'continue'
    };
  }

  if (controllerSnapshot.nextAction === 'fail') {
    emitNativeAiSdkToolStreamCompleted({
      callbacks: input.callbacks,
      loopState: input.loopState,
      providerStep: input.providerStep,
      usage: input.providerStep.usage,
      suffix: 'controllerAction=fail'
    });
    input.markCoreFailed(controllerSnapshot.lastDecision?.reason ?? 'AI SDK provider 没有产出可完成的最终步骤。');
    input.emitCoreStateStage('failed', 'Agent Run Controller 判定 AI SDK Native 工具循环失败。');
    return {
      action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState
      })
    };
  }

  if (controllerSnapshot.nextAction !== 'complete') {
    emitNativeAiSdkToolStreamCompleted({
      callbacks: input.callbacks,
      loopState: input.loopState,
      providerStep: input.providerStep,
      usage: input.providerStep.usage,
      suffix: `controllerAction=${controllerSnapshot.nextAction}`
    });
    input.markCoreFailed(`Agent Run Controller 返回了无法完成的动作：${controllerSnapshot.nextAction}。`);
    input.emitCoreStateStage('failed', 'Agent Run Controller 返回了 AI SDK 分支无法完成的动作。');
    return {
      action: 'return',
      result: createNativeAiSdkRunResult({
        loopState: input.loopState,
        providerStep: input.providerStep,
        coreState: controllerSnapshot.coreState
      })
    };
  }

  emitNativeAiSdkToolStreamCompleted({
    callbacks: input.callbacks,
    loopState: input.loopState,
    providerStep: input.providerStep,
    usage: input.providerStep.usage
  });
  input.markCoreCompleted('AI SDK provider stop 且没有待处理工具，产出最终回复。');
  input.emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 AI SDK Native 工具循环。');
  return {
    action: 'return',
    result: createNativeAiSdkRunResult({
      loopState: input.loopState,
      providerStep: input.providerStep,
      coreState: controllerSnapshot.coreState
    })
  };
}
