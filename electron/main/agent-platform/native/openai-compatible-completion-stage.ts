import type { AgentRunControllerSnapshot } from '../agent-run-controller';
import type { GenericAgentRuntimeParams } from '../types';
import type {
  AgentCoreState,
  AiProviderApiMode
} from '../../../../shared/types';
import type { OpenAiCompatibleToolStepResult } from '../../openai-compatible-client';
import {
  createIncompleteTodoContinuationPrompt,
  createLengthContinuationPrompt,
  createPartialWriteContinuationPrompt
} from './continuation-policy';
import { NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT } from './tool-loop-options';
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

function emitOpenAiCompatibleToolStreamCompleted(input: {
  callbacks?: NativeToolLoopCallbacks;
  stepIndex: number;
  state: NativeToolLoopState;
  suffix?: string;
}): void {
  input.callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行兼容 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'completed',
    summary: [
      `完成 ${input.stepIndex + 1} 步`,
      input.state.finishReason ? `finishReason=${input.state.finishReason}` : '',
      input.state.toolCalls.length > 0 ? `tools=${input.state.toolCalls.join(', ')}` : 'tools=none',
      input.suffix
    ].filter(Boolean).join('；')
  });
}

export function completeOpenAiCompatibleNoToolStep(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  includeWriteTools: boolean;
  apiMode: AiProviderApiMode;
  state: NativeToolLoopState;
  stepIndex: number;
  stepResult: OpenAiCompatibleToolStepResult;
  processTextStream: NativeProcessTextStream;
  stepStream: NativeProcessTextStepStream;
  recordRunControllerProviderStep: (options?: {
    continuation?: {
      includeWriteTools?: boolean;
      permissionMode?: string;
      assistantMessage?: string;
      incompleteTodo?: {
        incompleteCount: number;
        hasInProgress?: boolean;
      };
      partialWrite?: {
        continuationCount: number;
        continuationLimit: number;
      };
    };
  }) => AgentRunControllerSnapshot;
  transitionCoreState: (to: AgentCoreState, reason: string) => void;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): OpenAiCompatibleCompletionStageDecision {
  const finalCandidate = normalizeModelReplyText(input.stepResult.text);
  const latestTodoSnapshot = input.state.latestTodoSnapshot;
  const controllerSnapshot = input.recordRunControllerProviderStep({
    continuation: {
      includeWriteTools: input.includeWriteTools,
      permissionMode: input.params.permission.mode,
      assistantMessage: finalCandidate,
      incompleteTodo: latestTodoSnapshot
        ? {
            incompleteCount: latestTodoSnapshot.incompleteItems.length,
            hasInProgress: latestTodoSnapshot.hasInProgress
          }
        : undefined,
      partialWrite: {
        continuationCount: input.state.partialWriteContinuationCount,
        continuationLimit: NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT
      }
    }
  });
  input.transitionCoreState('collecting_tool_calls', `Provider step ${input.stepIndex + 1} 完成，finishReason=${input.state.finishReason ?? 'unknown'}，toolCalls=0。`);

  if (controllerSnapshot.lastContinuation?.reason === 'incomplete_todo' && latestTodoSnapshot) {
    input.state.incompleteTodoContinuationCount += 1;
    input.state.parts.push({
      type: 'continuation',
      stepIndex: input.stepIndex,
      reason: 'incomplete_todo',
      text: finalCandidate
    });
    const continuationPrompt = createIncompleteTodoContinuationPrompt(latestTodoSnapshot, finalCandidate);
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_incomplete_todo_continuation',
      title: '续跑未完成任务清单',
      target: 'stage:native_incomplete_todo_continuation',
      status: 'completed',
      summary: '模型结束时仍有 in_progress/pending todo，已要求继续调用工具完成剩余步骤。',
      input: {
        continuation: input.state.incompleteTodoContinuationCount,
        incompleteItems: latestTodoSnapshot.incompleteItems
      }
    });
    input.processTextStream.discard(input.stepStream);
    input.state.messages.push({
      role: 'assistant',
      content: finalCandidate,
      reasoningContent: input.stepResult.reasoningContent
    });
    input.state.messages.push({
      role: 'user',
      content: continuationPrompt
    });
    input.transitionCoreState('building_model_input', 'Todo 仍有未完成项，继续下一轮 provider step。');
    return {
      action: 'continue',
      nextStepIndex: input.stepIndex + 1
    };
  }

  if (controllerSnapshot.lastContinuation?.reason === 'partial_write') {
    input.state.partialWriteContinuationCount += 1;
    input.state.parts.push({
      type: 'continuation',
      stepIndex: input.stepIndex,
      reason: 'partial_write',
      text: finalCandidate
    });
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_partial_write_continuation',
      title: '续写未完成文件',
      target: 'stage:native_partial_write_continuation',
      status: 'completed',
      summary: '模型返回了未完成的多文件写入承诺，已要求继续调用写入工具而不是结束回复。',
      input: {
        continuation: input.state.partialWriteContinuationCount,
        assistantMessage: finalCandidate
      }
    });
    input.processTextStream.discard(input.stepStream);
    input.state.messages.push({
      role: 'assistant',
      content: finalCandidate,
      reasoningContent: input.stepResult.reasoningContent
    });
    input.state.messages.push({
      role: 'user',
      content: createPartialWriteContinuationPrompt(finalCandidate)
    });
    input.transitionCoreState('building_model_input', '模型返回未完成写入承诺，继续下一轮 provider step。');
    return {
      action: 'continue',
      nextStepIndex: input.stepIndex + 1
    };
  }

  if (controllerSnapshot.nextAction === 'build_model_input' && controllerSnapshot.lastContinuation?.reason === 'length') {
    if (finalCandidate.trim()) {
      recordNativeToolLoopAssistantText(input.state, input.stepIndex, finalCandidate, {
        final: false
      });
      input.processTextStream.commit(finalCandidate, input.stepStream);
    } else {
      input.processTextStream.discard(input.stepStream);
    }
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_length_continuation',
      title: '续跑长度截断回复',
      target: 'stage:native_length_continuation',
      status: 'completed',
      summary: 'Provider 返回 length 截断，已继续下一轮；length 不是真正完成态。',
      input: {
        step: input.stepIndex + 1,
        finishReason: input.state.finishReason,
        assistantMessage: finalCandidate
      }
    });
    appendNativeToolLoopAssistantToolMessage(input.state, input.stepResult, {
      apiMode: input.apiMode,
      assistantText: finalCandidate
    });
    input.state.messages.push({
      role: 'user',
      content: createLengthContinuationPrompt(finalCandidate)
    });
    input.transitionCoreState('building_model_input', 'Provider 返回 length 截断，继续下一轮 provider step。');
    return {
      action: 'continue',
      nextStepIndex: input.stepIndex + 1
    };
  }

  if (controllerSnapshot.nextAction === 'fail') {
    input.processTextStream.discard(input.stepStream);
    input.transitionCoreState('failed', controllerSnapshot.lastDecision?.reason ?? 'Provider 没有 tool call，也没有可见最终文本。');
    emitOpenAiCompatibleToolStreamCompleted({
      callbacks: input.callbacks,
      stepIndex: input.stepIndex,
      state: input.state,
      suffix: 'finalText=empty'
    });
    input.emitCoreStateStage('failed', 'Agent Core v2 判定 provider 没有返回可显示的最终文本。');
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState)
    };
  }

  if (controllerSnapshot.nextAction !== 'complete') {
    input.processTextStream.discard(input.stepStream);
    input.transitionCoreState('failed', `Agent Run Controller 返回了无法在无工具分支处理的动作：${controllerSnapshot.nextAction}。`);
    emitOpenAiCompatibleToolStreamCompleted({
      callbacks: input.callbacks,
      stepIndex: input.stepIndex,
      state: input.state,
      suffix: `controllerAction=${controllerSnapshot.nextAction}`
    });
    input.emitCoreStateStage('failed', 'Agent Run Controller 返回了无工具分支无法处理的动作。');
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState)
    };
  }

  recordNativeToolLoopAssistantText(input.state, input.stepIndex, finalCandidate, {
    final: true
  });
  input.processTextStream.commit(finalCandidate, input.stepStream);
  input.transitionCoreState('completed', 'Provider stop 且没有 tool call，并产出最终可见文本。');
  emitOpenAiCompatibleToolStreamCompleted({
    callbacks: input.callbacks,
    stepIndex: input.stepIndex,
    state: input.state
  });
  input.emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 Native 工具循环。');
  return {
    action: 'return',
    result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState)
  };
}
