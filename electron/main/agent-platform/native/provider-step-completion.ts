import type { AgentRunControllerContinuationContext, AgentRunControllerSnapshot } from '../../agent-core/index';
import {
  resolveAgentRunControllerCommand,
  type AgentRunControllerContinuationCounterKey
} from '../../agent-core/index';
import type { AgentCoreProviderStepResult } from '../../../../shared/types';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { GenericAgentRuntimeParams } from '../types';
import { type NativeTodoSnapshot } from './continuation-policy';
import { NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT } from './tool-loop-options';

export type NativeNoToolProviderCompletionDecision =
  | {
      action: 'continue';
      reason: 'incomplete_todo';
      prompt: string;
      detail: string;
      counterKey?: AgentRunControllerContinuationCounterKey;
    }
  | {
      action: 'continue';
      reason: 'partial_write';
      prompt: string;
      detail: string;
      counterKey?: AgentRunControllerContinuationCounterKey;
    }
  | {
      action: 'continue';
      reason: 'length';
      prompt: string;
      detail: string;
      counterKey?: AgentRunControllerContinuationCounterKey;
    }
  | {
      action: 'complete';
      detail: string;
    }
  | {
      action: 'fail';
      detail: string;
    }
  | {
      action: 'unsupported';
      controllerAction: AgentRunControllerSnapshot['nextAction'];
      detail: string;
    };

export type NativeProviderCompletionRuntime = 'openai-compatible' | 'ai-sdk';

export type NativeNoToolContinuationReason = Extract<
  NativeNoToolProviderCompletionDecision,
  { action: 'continue' }
>['reason'];

function isNativeNoToolContinuationReason(reason: string): reason is NativeNoToolContinuationReason {
  return reason === 'incomplete_todo' || reason === 'partial_write' || reason === 'length';
}

export interface NativeNoToolProviderContinuationEffect {
  reason: NativeNoToolContinuationReason;
  prompt: string;
  transitionReason: string;
  stage: ConversationOperationStageEvent;
}

export interface NativeNoToolProviderTerminalEffect {
  action: 'complete' | 'fail' | 'unsupported';
  detail: string;
  streamSuffix?: string;
  failedCoreStageSummary?: string;
  completedCoreStageSummary?: string;
  completedCoreReason?: string;
}

export interface NativeNoToolProviderContinuationCounterState {
  incompleteTodoContinuationCount: number;
  partialWriteContinuationCount: number;
}

export interface NativeNoToolProviderContinuationCounterUpdate {
  key: AgentRunControllerContinuationCounterKey;
  value: number;
}

export type NativeNoToolProviderCompletionEffect =
  | (NativeNoToolProviderContinuationEffect & {
      action: 'continue';
      counter?: NativeNoToolProviderContinuationCounterUpdate;
    })
  | NativeNoToolProviderTerminalEffect;

export type NativeNoToolProviderContinuationCompletionEffect = Extract<
  NativeNoToolProviderCompletionEffect,
  { action: 'continue' }
>;

export type NativeNoToolProviderTerminalCompletionEffect = Exclude<
  NativeNoToolProviderCompletionEffect,
  { action: 'continue' }
>;

export interface NativeNoToolProviderResolvedCompletion {
  controllerSnapshot: AgentRunControllerSnapshot;
  decision: NativeNoToolProviderCompletionDecision;
  effect: NativeNoToolProviderCompletionEffect;
}

export function createNativeNoToolProviderContinuationContext(input: {
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  assistantMessage: string;
  latestTodoSnapshot?: NativeTodoSnapshot;
  partialWriteContinuationCount: number;
  partialWriteContinuationLimit?: number;
}): AgentRunControllerContinuationContext {
  return {
    includeWriteTools: input.includeWriteTools,
    permissionMode: input.permissionMode,
    assistantMessage: input.assistantMessage,
    incompleteTodo: input.latestTodoSnapshot
      ? {
          incompleteCount: input.latestTodoSnapshot.incompleteItems.length,
          hasInProgress: input.latestTodoSnapshot.hasInProgress
        }
      : undefined,
    partialWrite: {
      continuationCount: input.partialWriteContinuationCount,
      continuationLimit: input.partialWriteContinuationLimit ?? NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT
    }
  };
}

export function resolveNativeNoToolProviderCompletionEffect(input: {
  runtime: NativeProviderCompletionRuntime;
  providerStep: AgentCoreProviderStepResult;
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  finalCandidate: string;
  latestTodoSnapshot?: NativeTodoSnapshot;
  partialWriteContinuationCount: number;
  continuationCounters: NativeNoToolProviderContinuationCounterState;
  stepNumber: number;
  finishReason?: string;
  recordRunControllerProviderStep: (input: {
    providerStep: AgentCoreProviderStepResult;
    continuation?: AgentRunControllerContinuationContext;
  }) => AgentRunControllerSnapshot;
}): NativeNoToolProviderResolvedCompletion {
  const controllerSnapshot = input.recordRunControllerProviderStep({
    providerStep: input.providerStep,
    continuation: createNativeNoToolProviderContinuationContext({
      includeWriteTools: input.includeWriteTools,
      permissionMode: input.permissionMode,
      assistantMessage: input.finalCandidate,
      latestTodoSnapshot: input.latestTodoSnapshot,
      partialWriteContinuationCount: input.partialWriteContinuationCount
    })
  });
  const decision = resolveNativeNoToolProviderCompletion({
    controllerSnapshot,
    finalCandidate: input.finalCandidate,
    latestTodoSnapshot: input.latestTodoSnapshot
  });
  const effect = createNativeNoToolProviderCompletionEffect({
    decision,
    runtime: input.runtime,
    finalCandidate: input.finalCandidate,
    latestTodoSnapshot: input.latestTodoSnapshot,
    continuationCounters: input.continuationCounters,
    stepNumber: input.stepNumber,
    finishReason: input.finishReason
  });
  return {
    controllerSnapshot,
    decision,
    effect
  };
}

function runtimeProviderLabel(runtime: NativeProviderCompletionRuntime): string {
  return runtime === 'ai-sdk' ? 'AI SDK provider' : 'Provider';
}

function runtimeProviderStepLabel(runtime: NativeProviderCompletionRuntime): string {
  return runtime === 'ai-sdk' ? 'AI SDK provider step' : 'provider step';
}

export function createNativeNoToolProviderContinuationEffect(input: {
  decision: Extract<NativeNoToolProviderCompletionDecision, { action: 'continue' }>;
  runtime: NativeProviderCompletionRuntime;
  finalCandidate: string;
  latestTodoSnapshot?: NativeTodoSnapshot;
  continuationCount: number;
  stepNumber: number;
  finishReason?: string;
}): NativeNoToolProviderContinuationEffect {
  const providerLabel = runtimeProviderLabel(input.runtime);
  const providerStepLabel = runtimeProviderStepLabel(input.runtime);
  if (input.decision.reason === 'incomplete_todo') {
    return {
      reason: input.decision.reason,
      prompt: input.decision.prompt,
      transitionReason: `Todo 仍有未完成项，继续下一轮 ${providerStepLabel}。`,
      stage: {
        stageId: 'stage:native_incomplete_todo_continuation',
        title: '续跑未完成任务清单',
        target: 'stage:native_incomplete_todo_continuation',
        status: 'completed',
        summary: '模型结束时仍有 in_progress/pending todo，已要求继续调用工具完成剩余步骤。',
        input: {
          continuation: input.continuationCount,
          incompleteItems: input.latestTodoSnapshot?.incompleteItems ?? [],
          finishReason: input.finishReason
        }
      }
    };
  }
  if (input.decision.reason === 'partial_write') {
    return {
      reason: input.decision.reason,
      prompt: input.decision.prompt,
      transitionReason: `模型返回未完成写入承诺，继续下一轮 ${providerStepLabel}。`,
      stage: {
        stageId: 'stage:native_partial_write_continuation',
        title: '续写未完成文件',
        target: 'stage:native_partial_write_continuation',
        status: 'completed',
        summary: '模型返回了未完成的多文件写入承诺，已要求继续调用写入工具而不是结束回复。',
        input: {
          continuation: input.continuationCount,
          assistantMessage: input.finalCandidate
        }
      }
    };
  }
  return {
    reason: input.decision.reason,
    prompt: input.decision.prompt,
    transitionReason: `${providerLabel} 返回 length 截断，继续下一轮 provider step。`,
    stage: {
      stageId: 'stage:native_length_continuation',
      title: '续跑长度截断回复',
      target: 'stage:native_length_continuation',
      status: 'completed',
      summary: `${providerLabel} 返回 length 截断，已继续下一轮；length 不是真正完成态。`,
      input: {
        step: input.stepNumber,
        finishReason: input.finishReason,
        assistantMessage: input.finalCandidate
      }
    }
  };
}

export function createNativeNoToolProviderTerminalEffect(input: {
  decision: Exclude<NativeNoToolProviderCompletionDecision, { action: 'continue' }>;
  runtime: NativeProviderCompletionRuntime;
}): NativeNoToolProviderTerminalEffect {
  if (input.decision.action === 'fail') {
    return {
      action: 'fail',
      detail: input.decision.detail,
      streamSuffix: input.runtime === 'ai-sdk' ? 'controllerAction=fail' : 'finalText=empty',
      failedCoreStageSummary:
        input.runtime === 'ai-sdk'
          ? 'Agent Run Controller 判定 AI SDK Native 工具循环失败。'
          : 'Agent Core v2 判定 provider 没有返回可显示的最终文本。'
    };
  }
  if (input.decision.action === 'unsupported') {
    return {
      action: 'unsupported',
      detail: input.decision.detail,
      streamSuffix: `controllerAction=${input.decision.controllerAction}`,
      failedCoreStageSummary:
        input.runtime === 'ai-sdk'
          ? 'Agent Run Controller 返回了 AI SDK 分支无法完成的动作。'
          : 'Agent Run Controller 返回了无工具分支无法处理的动作。'
    };
  }
  return {
    action: 'complete',
    detail: input.decision.detail,
    completedCoreReason:
      input.runtime === 'ai-sdk'
        ? 'AI SDK provider stop 且没有待处理工具，产出最终回复。'
        : 'Provider stop 且没有 tool call，并产出最终可见文本。',
    completedCoreStageSummary:
      input.runtime === 'ai-sdk'
        ? 'Agent Core v2 状态机完成本轮 AI SDK Native 工具循环。'
        : 'Agent Core v2 状态机完成本轮 Native 工具循环。'
  };
}

export function createNativeNoToolProviderCompletionEffect(input: {
  decision: NativeNoToolProviderCompletionDecision;
  runtime: NativeProviderCompletionRuntime;
  finalCandidate: string;
  latestTodoSnapshot?: NativeTodoSnapshot;
  continuationCounters: NativeNoToolProviderContinuationCounterState;
  stepNumber: number;
  finishReason?: string;
}): NativeNoToolProviderCompletionEffect {
  if (input.decision.action !== 'continue') {
    return createNativeNoToolProviderTerminalEffect({
      decision: input.decision,
      runtime: input.runtime
    });
  }

  const counter = createNativeNoToolProviderContinuationCounterUpdate({
    reason: input.decision.reason,
    counters: input.continuationCounters,
    key: input.decision.counterKey
  });
  return {
    action: 'continue',
    ...createNativeNoToolProviderContinuationEffect({
      decision: input.decision,
      runtime: input.runtime,
      finalCandidate: input.finalCandidate,
      latestTodoSnapshot: input.latestTodoSnapshot,
      continuationCount: counter?.value ?? 0,
      stepNumber: input.stepNumber,
      finishReason: input.finishReason
    }),
    counter
  };
}

export function applyNativeNoToolProviderContinuationCounterUpdate(
  state: NativeNoToolProviderContinuationCounterState,
  effect: NativeNoToolProviderCompletionEffect
): void {
  if (effect.action === 'continue' && effect.counter) {
    state[effect.counter.key] = effect.counter.value;
  }
}

export function applyNativeNoToolProviderContinuationCoreEffect(input: {
  effect: NativeNoToolProviderContinuationCompletionEffect;
  counters: NativeNoToolProviderContinuationCounterState;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  prepareNextProviderInput: (reason: string) => void;
}): void {
  applyNativeNoToolProviderContinuationCounterUpdate(input.counters, input.effect);
  input.emitStage?.(input.effect.stage);
  input.prepareNextProviderInput(input.effect.transitionReason);
}

export function applyNativeNoToolProviderTerminalCoreEffect(input: {
  effect: NativeNoToolProviderTerminalCompletionEffect;
  runtime: NativeProviderCompletionRuntime;
  stepCount: number;
  finishReason?: string;
  toolCalls: string[];
  usage?: unknown;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  markFailed: (reason: string) => void;
  markCompleted: (reason: string) => void;
  emitCoreStateStage: (status: 'completed' | 'failed', summary: string) => void;
}): void {
  if (input.effect.action === 'complete') {
    input.emitStage?.(
      createNativeProviderToolStreamCompletedStage({
        runtime: input.runtime,
        stepCount: input.stepCount,
        finishReason: input.finishReason,
        toolCalls: input.toolCalls,
        usage: input.usage
      })
    );
    input.markCompleted(input.effect.completedCoreReason ?? input.effect.detail);
    input.emitCoreStateStage('completed', input.effect.completedCoreStageSummary ?? input.effect.detail);
    return;
  }

  input.emitStage?.(
    createNativeProviderToolStreamCompletedStage({
      runtime: input.runtime,
      stepCount: input.stepCount,
      finishReason: input.finishReason,
      toolCalls: input.toolCalls,
      usage: input.usage,
      suffix: input.effect.streamSuffix
    })
  );
  input.markFailed(input.effect.detail);
  input.emitCoreStateStage('failed', input.effect.failedCoreStageSummary ?? input.effect.detail);
}

function createNativeNoToolProviderContinuationCounterUpdate(input: {
  reason: NativeNoToolContinuationReason;
  counters: NativeNoToolProviderContinuationCounterState;
  key?: AgentRunControllerContinuationCounterKey;
}): NativeNoToolProviderContinuationCounterUpdate | undefined {
  if (input.key === 'incompleteTodoContinuationCount' || (!input.key && input.reason === 'incomplete_todo')) {
    return {
      key: 'incompleteTodoContinuationCount',
      value: input.counters.incompleteTodoContinuationCount + 1
    };
  }
  if (input.key === 'partialWriteContinuationCount' || (!input.key && input.reason === 'partial_write')) {
    return {
      key: 'partialWriteContinuationCount',
      value: input.counters.partialWriteContinuationCount + 1
    };
  }
  return undefined;
}

export function createNativeProviderToolStreamCompletedStage(input: {
  runtime: NativeProviderCompletionRuntime;
  stepCount: number;
  finishReason?: string;
  toolCalls: string[];
  usage?: unknown;
  suffix?: string;
}): ConversationOperationStageEvent {
  return {
    stageId: 'stage:native_tool_stream',
    title: '执行工具步骤',
    target: 'stage:native_tool_stream',
    status: 'completed',
    summary: [
      `已完成 ${input.stepCount} 轮工具执行`,
      input.toolCalls.length > 0 ? `调用工具：${input.toolCalls.join(', ')}` : '未调用工具',
      input.suffix
    ]
      .filter(Boolean)
      .join('；'),
    input: {
      step: input.stepCount,
      finishReason: input.finishReason,
      toolsUsed: [...input.toolCalls],
      usage: input.usage
    }
  };
}

export function resolveNativeNoToolProviderCompletion(input: {
  controllerSnapshot: AgentRunControllerSnapshot;
  finalCandidate: string;
  latestTodoSnapshot?: NativeTodoSnapshot;
}): NativeNoToolProviderCompletionDecision {
  const command = resolveAgentRunControllerCommand(input.controllerSnapshot, {
    assistantMessage: input.finalCandidate,
    latestTodoSnapshot: input.latestTodoSnapshot
  });
  if (command.action === 'continue' && command.effect?.prompt && isNativeNoToolContinuationReason(command.reason)) {
    return {
      action: 'continue',
      reason: command.reason,
      prompt: command.effect.prompt,
      detail: command.detail,
      counterKey: command.effect.counterKey
    };
  }

  if (command.action === 'fail') {
    return {
      action: 'fail',
      detail: command.detail
    };
  }

  if (command.action === 'complete') {
    return {
      action: 'complete',
      detail: command.detail
    };
  }

  return {
    action: 'unsupported',
    controllerAction: command.controllerAction,
    detail: command.detail
  };
}
