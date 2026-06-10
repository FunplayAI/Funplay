import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunControllerSnapshot } from '../../electron/main/agent-core/index.ts';
import type { AgentCoreProviderStepResult } from '../../shared/types.ts';
import {
  applyNativeNoToolProviderContinuationCounterUpdate,
  applyNativeNoToolProviderContinuationCoreEffect,
  applyNativeNoToolProviderTerminalCoreEffect,
  createNativeNoToolProviderCompletionEffect,
  createNativeNoToolProviderContinuationEffect,
  createNativeNoToolProviderContinuationContext,
  createNativeNoToolProviderTerminalEffect,
  createNativeProviderToolStreamCompletedStage,
  resolveNativeNoToolProviderCompletionEffect,
  resolveNativeNoToolProviderCompletion
} from '../../electron/main/agent-platform/native/provider-step-completion.ts';

function snapshot(input: Partial<AgentRunControllerSnapshot>): AgentRunControllerSnapshot {
  return {
    coreState: {
      state: 'building_model_input',
      history: []
    },
    parts: [],
    nextAction: 'complete',
    providerStepCount: 1,
    pendingToolUseIds: [],
    completedToolUseIds: [],
    ...input
  };
}

function providerStep(): AgentCoreProviderStepResult {
  return {
    text: 'Next I will edit src/app.ts.',
    finishReason: 'stop',
    toolCalls: []
  };
}

test('native provider completion resolver maps controller continuations to prompts', () => {
  const incompleteTodo = resolveNativeNoToolProviderCompletion({
    controllerSnapshot: snapshot({
      nextAction: 'build_model_input',
      lastContinuation: {
        reason: 'incomplete_todo'
      }
    }),
    finalCandidate: '还没完成，下一步继续写 index.html。',
    latestTodoSnapshot: {
      items: [
        {
          id: '1',
          content: 'write index.html',
          status: 'pending'
        }
      ],
      incompleteItems: [
        {
          id: '1',
          content: 'write index.html',
          status: 'pending'
        }
      ],
      hasInProgress: false
    }
  });
  const partialWrite = resolveNativeNoToolProviderCompletion({
    controllerSnapshot: snapshot({
      nextAction: 'build_model_input',
      lastContinuation: {
        reason: 'partial_write'
      }
    }),
    finalCandidate: 'Next I will write game.js.'
  });
  const length = resolveNativeNoToolProviderCompletion({
    controllerSnapshot: snapshot({
      nextAction: 'build_model_input',
      lastContinuation: {
        reason: 'length'
      }
    }),
    finalCandidate: 'Partial output'
  });

  assert.equal(incompleteTodo.action, 'continue');
  assert.equal(incompleteTodo.action === 'continue' ? incompleteTodo.reason : undefined, 'incomplete_todo');
  assert.match(incompleteTodo.action === 'continue' ? incompleteTodo.prompt : '', /write index\.html/);
  assert.equal(partialWrite.action, 'continue');
  assert.equal(partialWrite.action === 'continue' ? partialWrite.reason : undefined, 'partial_write');
  assert.match(partialWrite.action === 'continue' ? partialWrite.prompt : '', /write_file/);
  assert.equal(length.action, 'continue');
  assert.equal(length.action === 'continue' ? length.reason : undefined, 'length');
  assert.match(length.action === 'continue' ? length.prompt : '', /长度限制/);
});

test('native provider completion context builder centralizes runner continuation facts', () => {
  const context = createNativeNoToolProviderContinuationContext({
    includeWriteTools: true,
    permissionMode: 'ask',
    assistantMessage: 'Next I will write index.html.',
    latestTodoSnapshot: {
      items: [
        {
          id: '1',
          content: 'write index.html',
          status: 'in_progress'
        },
        {
          id: '2',
          content: 'verify',
          status: 'completed'
        }
      ],
      incompleteItems: [
        {
          id: '1',
          content: 'write index.html',
          status: 'in_progress'
        }
      ],
      hasInProgress: true
    },
    partialWriteContinuationCount: 1
  });

  assert.equal(context.includeWriteTools, true);
  assert.equal(context.permissionMode, 'ask');
  assert.equal(context.assistantMessage, 'Next I will write index.html.');
  assert.equal(context.incompleteTodo?.incompleteCount, 1);
  assert.equal(context.incompleteTodo?.hasInProgress, true);
  assert.equal(context.partialWrite?.continuationCount, 1);
  assert.equal(context.partialWrite?.continuationLimit, 2);
});

test('native provider completion effects centralize continuation stage output', () => {
  const effect = createNativeNoToolProviderContinuationEffect({
    decision: {
      action: 'continue',
      reason: 'length',
      prompt: '继续完成被截断的回复。',
      detail: 'length'
    },
    runtime: 'ai-sdk',
    finalCandidate: 'partial response',
    continuationCount: 0,
    stepNumber: 3,
    finishReason: 'length'
  });

  assert.equal(effect.reason, 'length');
  assert.equal(effect.prompt, '继续完成被截断的回复。');
  assert.equal(effect.transitionReason, 'AI SDK provider 返回 length 截断，继续下一轮 provider step。');
  assert.equal(effect.stage.stageId, 'stage:native_length_continuation');
  assert.equal(effect.stage.title, '续跑长度截断回复');
  assert.match(effect.stage.summary ?? '', /AI SDK provider 返回 length 截断/);
  assert.deepEqual(effect.stage.input, {
    step: 3,
    finishReason: 'length',
    assistantMessage: 'partial response'
  });
});

test('native provider terminal effects centralize runtime-specific completion details', () => {
  const openAiFail = createNativeNoToolProviderTerminalEffect({
    decision: {
      action: 'fail',
      detail: 'empty response'
    },
    runtime: 'openai-compatible'
  });
  const aiSdkUnsupported = createNativeNoToolProviderTerminalEffect({
    decision: {
      action: 'unsupported',
      controllerAction: 'execute_tools',
      detail: 'unexpected tool boundary'
    },
    runtime: 'ai-sdk'
  });
  const aiSdkComplete = createNativeNoToolProviderTerminalEffect({
    decision: {
      action: 'complete',
      detail: 'done'
    },
    runtime: 'ai-sdk'
  });

  assert.equal(openAiFail.streamSuffix, 'finalText=empty');
  assert.match(openAiFail.failedCoreStageSummary ?? '', /provider 没有返回可显示的最终文本/);
  assert.equal(aiSdkUnsupported.streamSuffix, 'controllerAction=execute_tools');
  assert.match(aiSdkUnsupported.failedCoreStageSummary ?? '', /AI SDK 分支无法完成/);
  assert.match(aiSdkComplete.completedCoreReason ?? '', /AI SDK provider stop/);
});

test('native provider completion effect advances continuation counters outside runner branches', () => {
  const counters = {
    incompleteTodoContinuationCount: 2,
    partialWriteContinuationCount: 1
  };
  const effect = createNativeNoToolProviderCompletionEffect({
    decision: {
      action: 'continue',
      reason: 'partial_write',
      prompt: '请继续用写入工具完成文件修改。',
      detail: 'partial write'
    },
    runtime: 'openai-compatible',
    finalCandidate: 'Next I will edit src/app.ts.',
    continuationCounters: counters,
    stepNumber: 5,
    finishReason: 'stop'
  });

  assert.equal(effect.action, 'continue');
  assert.equal(effect.action === 'continue' ? effect.counter?.key : undefined, 'partialWriteContinuationCount');
  assert.equal(effect.action === 'continue' ? effect.counter?.value : undefined, 2);
  applyNativeNoToolProviderContinuationCounterUpdate(counters, effect);
  assert.deepEqual(counters, {
    incompleteTodoContinuationCount: 2,
    partialWriteContinuationCount: 2
  });
});

test('native provider completion effect resolver owns controller snapshot and effect creation', () => {
  let continuationContext: unknown;
  const resolved = resolveNativeNoToolProviderCompletionEffect({
    runtime: 'openai-compatible',
    providerStep: providerStep(),
    includeWriteTools: true,
    permissionMode: 'ask',
    finalCandidate: 'Next I will edit src/app.ts.',
    latestTodoSnapshot: undefined,
    partialWriteContinuationCount: 1,
    continuationCounters: {
      incompleteTodoContinuationCount: 0,
      partialWriteContinuationCount: 1
    },
    stepNumber: 6,
    finishReason: 'stop',
    recordRunControllerProviderStep: (options) => {
      continuationContext = options?.continuation;
      return snapshot({
        nextAction: 'build_model_input',
        lastContinuation: {
          reason: 'partial_write'
        }
      });
    }
  });

  assert.deepEqual(continuationContext, {
    includeWriteTools: true,
    permissionMode: 'ask',
    assistantMessage: 'Next I will edit src/app.ts.',
    incompleteTodo: undefined,
    partialWrite: {
      continuationCount: 1,
      continuationLimit: 2
    }
  });
  assert.equal(resolved.controllerSnapshot.nextAction, 'build_model_input');
  assert.equal(resolved.decision.action, 'continue');
  assert.equal(resolved.decision.action === 'continue' ? resolved.decision.reason : undefined, 'partial_write');
  assert.equal(resolved.effect.action, 'continue');
  assert.equal(resolved.effect.action === 'continue' ? resolved.effect.counter?.value : undefined, 2);
});

test('native provider continuation core effect applies stage, transition, and counter update', () => {
  const counters = {
    incompleteTodoContinuationCount: 0,
    partialWriteContinuationCount: 3
  };
  const stages: string[] = [];
  const transitions: string[] = [];
  const effect = createNativeNoToolProviderCompletionEffect({
    decision: {
      action: 'continue',
      reason: 'incomplete_todo',
      prompt: '继续完成 todo。',
      detail: 'todo incomplete'
    },
    runtime: 'ai-sdk',
    finalCandidate: 'I still need to finish tests.',
    continuationCounters: counters,
    stepNumber: 4,
    finishReason: 'stop',
    latestTodoSnapshot: {
      items: [
        {
          id: '1',
          content: 'finish tests',
          status: 'pending'
        }
      ],
      incompleteItems: [
        {
          id: '1',
          content: 'finish tests',
          status: 'pending'
        }
      ],
      hasInProgress: false
    }
  });

  assert.equal(effect.action, 'continue');
  if (effect.action !== 'continue') {
    assert.fail('expected continuation effect');
  }
  applyNativeNoToolProviderContinuationCoreEffect({
    effect,
    counters,
    emitStage: (stage) => stages.push(stage.stageId),
    prepareNextProviderInput: (reason) => transitions.push(reason)
  });

  assert.deepEqual(counters, {
    incompleteTodoContinuationCount: 1,
    partialWriteContinuationCount: 3
  });
  assert.deepEqual(stages, ['stage:native_incomplete_todo_continuation']);
  assert.deepEqual(transitions, ['Todo 仍有未完成项，继续下一轮 AI SDK provider step。']);
});

test('native provider terminal core effect owns stream-completed and core terminal events', () => {
  const stages: string[] = [];
  const failed: string[] = [];
  const completed: string[] = [];
  const coreStages: string[] = [];
  const failedEffect = createNativeNoToolProviderCompletionEffect({
    decision: {
      action: 'fail',
      detail: 'empty response'
    },
    runtime: 'openai-compatible',
    finalCandidate: '',
    continuationCounters: {
      incompleteTodoContinuationCount: 0,
      partialWriteContinuationCount: 0
    },
    stepNumber: 1
  });

  assert.equal(failedEffect.action, 'fail');
  if (failedEffect.action === 'continue') {
    assert.fail('expected terminal effect');
  }
  applyNativeNoToolProviderTerminalCoreEffect({
    effect: failedEffect,
    runtime: 'openai-compatible',
    stepCount: 1,
    finishReason: 'stop',
    toolCalls: [],
    emitStage: (stage) => stages.push(`${stage.title}:${stage.summary}`),
    markFailed: (reason) => failed.push(reason),
    markCompleted: (reason) => completed.push(reason),
    emitCoreStateStage: (status, summary) => coreStages.push(`${status}:${summary}`)
  });

  assert.equal(completed.length, 0);
  assert.deepEqual(failed, ['empty response']);
  assert.equal(stages.length, 1);
  assert.match(stages[0], /执行工具步骤/);
  assert.match(stages[0], /finalText=empty/);
  assert.deepEqual(coreStages, ['failed:Agent Core v2 判定 provider 没有返回可显示的最终文本。']);
});

test('native provider terminal core effect completes through one controller command path', () => {
  const stages: string[] = [];
  const failed: string[] = [];
  const completed: string[] = [];
  const coreStages: string[] = [];
  const completedEffect = createNativeNoToolProviderCompletionEffect({
    decision: {
      action: 'complete',
      detail: 'done'
    },
    runtime: 'ai-sdk',
    finalCandidate: 'Done.',
    continuationCounters: {
      incompleteTodoContinuationCount: 0,
      partialWriteContinuationCount: 0
    },
    stepNumber: 2,
    finishReason: 'stop'
  });

  assert.equal(completedEffect.action, 'complete');
  if (completedEffect.action === 'continue') {
    assert.fail('expected terminal effect');
  }
  applyNativeNoToolProviderTerminalCoreEffect({
    effect: completedEffect,
    runtime: 'ai-sdk',
    stepCount: 2,
    finishReason: 'stop',
    toolCalls: [],
    emitStage: (stage) => stages.push(`${stage.title}:${stage.status}`),
    markFailed: (reason) => failed.push(reason),
    markCompleted: (reason) => completed.push(reason),
    emitCoreStateStage: (status, summary) => coreStages.push(`${status}:${summary}`)
  });

  assert.deepEqual(failed, []);
  assert.deepEqual(completed, ['AI SDK provider stop 且没有待处理工具，产出最终回复。']);
  assert.deepEqual(stages, ['执行工具步骤:completed']);
  assert.deepEqual(coreStages, ['completed:Agent Core v2 状态机完成本轮 AI SDK Native 工具循环。']);
});

test('native provider tool stream completion stage is shared by native runtimes', () => {
  const openAiStage = createNativeProviderToolStreamCompletedStage({
    runtime: 'openai-compatible',
    stepCount: 2,
    finishReason: 'stop',
    toolCalls: ['read_file', 'write_file'],
    suffix: 'finalText=empty'
  });
  const aiSdkStage = createNativeProviderToolStreamCompletedStage({
    runtime: 'ai-sdk',
    stepCount: 4,
    finishReason: 'tool-calls',
    toolCalls: []
  });

  assert.equal(openAiStage.title, '执行工具步骤');
  assert.match(openAiStage.summary ?? '', /已完成 2 轮工具执行/);
  assert.match(openAiStage.summary ?? '', /调用工具：read_file, write_file/);
  assert.match(openAiStage.summary ?? '', /finalText=empty/);
  assert.doesNotMatch(openAiStage.summary ?? '', /tool loop|Tool Loop|真实/i);
  assert.deepEqual(openAiStage.input, {
    step: 2,
    finishReason: 'stop',
    toolsUsed: ['read_file', 'write_file'],
    usage: undefined
  });
  assert.equal(aiSdkStage.title, '执行工具步骤');
  assert.match(aiSdkStage.summary ?? '', /未调用工具/);
  assert.doesNotMatch(aiSdkStage.summary ?? '', /tool loop|Tool Loop|真实/i);
});

test('native provider completion resolver preserves terminal controller actions', () => {
  const completed = resolveNativeNoToolProviderCompletion({
    controllerSnapshot: snapshot({
      nextAction: 'complete',
      lastDecision: {
        outcome: 'complete',
        nextState: 'completed',
        terminal: true,
        reason: 'done'
      }
    }),
    finalCandidate: 'Done.'
  });
  const failed = resolveNativeNoToolProviderCompletion({
    controllerSnapshot: snapshot({
      nextAction: 'fail',
      lastDecision: {
        outcome: 'fail',
        nextState: 'failed',
        terminal: true,
        reason: 'empty reply'
      }
    }),
    finalCandidate: ''
  });

  assert.equal(completed.action, 'complete');
  assert.equal(completed.detail, 'done');
  assert.equal(failed.action, 'fail');
  assert.equal(failed.detail, 'empty reply');
});
