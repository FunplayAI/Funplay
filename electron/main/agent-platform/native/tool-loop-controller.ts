import {
  canTransitionAgentCoreState,
  createAgentCoreStateMachine
} from '../../../../shared/agent-core-v2';
import type {
  AgentCoreProviderStepResult,
  AgentCoreState
} from '../../../../shared/types';
import { createAgentRunController, type AgentRunControllerSnapshot } from '../agent-run-controller';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { GenericAgentRuntimeParams } from '../types';

export interface NativeToolLoopCallbacks {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
  emitThinking?: (delta: string, accumulated: string) => void;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
}

type NativeRunController = ReturnType<typeof createAgentRunController>;
type NativeRunControllerProviderStepOptions = Omit<Parameters<NativeRunController['recordProviderStep']>[0], 'providerStep'>;
export type NativeRunControllerToolResult = Parameters<NativeRunController['recordToolResult']>[0];

function summarizeRunControllerSnapshot(snapshot: AgentRunControllerSnapshot): Record<string, unknown> {
  return {
    state: snapshot.coreState.state,
    nextAction: snapshot.nextAction,
    providerStepCount: snapshot.providerStepCount,
    partCount: snapshot.parts.length,
    pendingToolUseIds: snapshot.pendingToolUseIds,
    completedToolUseIds: snapshot.completedToolUseIds,
    lastDecision: snapshot.lastDecision
      ? {
          outcome: snapshot.lastDecision.outcome,
          nextState: snapshot.lastDecision.nextState,
          terminal: snapshot.lastDecision.terminal,
          reason: snapshot.lastDecision.reason
        }
      : undefined,
    lastContinuation: snapshot.lastContinuation
  };
}

export function createNativeToolLoopControllerBridge(options: {
  callbacks?: NativeToolLoopCallbacks;
  stageId: string;
  guardTransitions?: boolean;
}) {
  const coreStateMachine = createAgentCoreStateMachine('building_model_input');
  const runController = createAgentRunController();
  let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
  let latestRunControllerSnapshot: AgentRunControllerSnapshot = runController.start();

  const transitionCoreState = (to: AgentCoreState, reason: string): void => {
    const current = coreStateMachine.getSnapshot().state;
    if (options.guardTransitions && (current === to || !canTransitionAgentCoreState(current, to))) {
      return;
    }
    coreStateMachine.transition(to, reason, new Date().toISOString());
  };

  const emitCoreStateStage = (status: 'running' | 'completed' | 'failed', summary: string): void => {
    options.callbacks?.emitStage?.({
      stageId: options.stageId,
      title: 'Agent Core v2 状态机',
      target: options.stageId,
      status,
      summary,
      input: {
        coreState: coreStateMachine.getSnapshot(),
        providerStep: latestCoreProviderStep,
        runController: summarizeRunControllerSnapshot(latestRunControllerSnapshot)
      }
    });
  };

  const recordRunControllerProviderStep = (
    providerStepOptions?: NativeRunControllerProviderStepOptions
  ): AgentRunControllerSnapshot => {
    if (!latestCoreProviderStep) {
      return latestRunControllerSnapshot;
    }
    latestRunControllerSnapshot = runController.recordProviderStep({
      providerStep: latestCoreProviderStep,
      ...providerStepOptions
    });
    return latestRunControllerSnapshot;
  };

  const recordRunControllerToolResult = (toolResult: NativeRunControllerToolResult): AgentRunControllerSnapshot => {
    latestRunControllerSnapshot = runController.recordToolResult(toolResult);
    return latestRunControllerSnapshot;
  };

  const setLatestCoreProviderStep = (providerStep: AgentCoreProviderStepResult): void => {
    latestCoreProviderStep = providerStep;
  };

  const markCoreStreaming = (reason: string): void => {
    const current = coreStateMachine.getSnapshot().state;
    if (current === 'recording_tool_results') {
      transitionCoreState('continuing_after_tools', '工具结果已记录，准备继续模型步骤。');
      transitionCoreState('building_model_input', '工具结果已进入上下文，构建下一轮 provider 输入。');
    } else if (current === 'continuing_after_tools') {
      transitionCoreState('building_model_input', '工具结果已进入上下文，构建下一轮 provider 输入。');
    } else if (current === 'loading_context' || current === 'compacting_context' || current === 'collecting_tool_calls') {
      transitionCoreState('building_model_input', '准备构建 provider 输入。');
    }
    transitionCoreState('streaming_model_step', reason);
  };

  const markCoreCollecting = (reason: string): void => {
    markCoreStreaming(reason);
    transitionCoreState('collecting_tool_calls', reason);
  };

  const markCoreExecuting = (reason: string): void => {
    markCoreCollecting(reason);
    transitionCoreState('executing_tools', reason);
  };

  const markCoreRecording = (reason: string): void => {
    markCoreExecuting(reason);
    transitionCoreState('recording_tool_results', reason);
  };

  const markCoreCompleted = (reason: string): void => {
    const current = coreStateMachine.getSnapshot().state;
    if (current === 'executing_tools') {
      transitionCoreState('recording_tool_results', '工具执行结束，记录工具结果。');
    }
    if (coreStateMachine.getSnapshot().state === 'recording_tool_results') {
      transitionCoreState('continuing_after_tools', '工具结果已记录，准备完成最终回复。');
    }
    if (coreStateMachine.getSnapshot().state === 'continuing_after_tools') {
      transitionCoreState('building_model_input', '工具结果已回放，准备最终模型状态。');
    }
    markCoreCollecting(reason);
    transitionCoreState('completed', reason);
  };

  const markCoreFailed = (reason: string): void => {
    transitionCoreState('failed', reason);
  };

  return {
    emitCoreStateStage,
    getCoreStateSnapshot: coreStateMachine.getSnapshot,
    markCoreCollecting,
    markCoreCompleted,
    markCoreExecuting,
    markCoreFailed,
    markCoreRecording,
    markCoreStreaming,
    recordRunControllerProviderStep,
    recordRunControllerToolResult,
    setLatestCoreProviderStep,
    transitionCoreState
  };
}
