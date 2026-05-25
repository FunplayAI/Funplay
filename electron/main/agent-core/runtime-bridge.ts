import type {
  AgentCoreProviderStepResult,
  AgentCoreState,
  AgentCoreStateMachineSnapshot
} from '../../../shared/types';
import {
  createAgentRunController,
  summarizeAgentRunControllerSnapshot,
  type AgentRunControllerProviderStepInput,
  type AgentRunControllerSnapshot,
  type AgentRunControllerToolResultInput
} from './controller';

export type AgentCoreRuntimeBridgeStageStatus = 'running' | 'completed' | 'failed';

export interface AgentCoreRuntimeBridgeStage {
  stageId: string;
  title: string;
  target: string;
  status: AgentCoreRuntimeBridgeStageStatus;
  summary: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentCoreRuntimeBridgeCallbacks {
  emitStage?: (stage: AgentCoreRuntimeBridgeStage) => void;
}

export type AgentCoreRuntimeBridgeProviderStepOptions = AgentRunControllerProviderStepInput;
export type AgentCoreRuntimeBridgeToolResult = AgentRunControllerToolResultInput;

export type AgentCoreRuntimeBridgeEvent =
  | {
      type: 'provider';
      phase: 'step_started' | 'step_streaming';
      reason: string;
    }
  | {
      type: 'context';
      phase: 'loading_started';
      reason: string;
    }
  | {
      type: 'provider';
      phase: 'step_collected';
      reason: string;
    }
  | {
      type: 'tool';
      phase: 'execution_started';
      reason: string;
    }
  | {
      type: 'tool';
      phase: 'results_recorded';
      reason: string;
    }
  | {
      type: 'provider';
      phase: 'input_ready';
      reason: string;
    }
  | {
      type: 'terminal';
      status: 'completed' | 'failed' | 'interrupted';
      reason: string;
    }
  | {
      type: 'context';
      phase: 'compaction_started';
      reason: string;
    }
  | {
      type: 'provider';
      phase: 'step_recorded';
      providerStep: AgentCoreProviderStepResult;
      options?: Omit<AgentRunControllerProviderStepInput, 'providerStep'>;
    }
  | {
      type: 'tool';
      phase: 'result_recorded';
      toolResult: AgentRunControllerToolResultInput;
    };

export interface AgentCoreRuntimeBridgeSnapshot {
  coreState: AgentCoreStateMachineSnapshot;
  providerStep?: AgentCoreProviderStepResult;
  runController: AgentRunControllerSnapshot;
}

export function createAgentCoreRuntimeEventController(options: {
  initialState?: AgentCoreState;
  guardTransitions?: boolean;
  runId?: string;
  turnId?: string;
} = {}) {
  const runController = createAgentRunController({
    initialState: options.initialState,
    runId: options.runId,
    turnId: options.turnId
  });
  let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
  let latestRunControllerSnapshot: AgentRunControllerSnapshot = options.initialState
    ? runController.getSnapshot()
    : runController.start();

  const getSnapshot = (): AgentCoreRuntimeBridgeSnapshot => ({
    coreState: latestRunControllerSnapshot.coreState,
    providerStep: latestCoreProviderStep,
    runController: latestRunControllerSnapshot
  });

  const transitionCoreState = (to: AgentCoreState, reason: string): void => {
    latestRunControllerSnapshot = runController.transitionCoreState({
      guardTransitions: options.guardTransitions,
      reason,
      to
    });
  };

  const advanceProviderInputReady = (reason: string): void => {
    const current = latestRunControllerSnapshot.coreState.state;
    if (current === 'initializing') {
      transitionCoreState('loading_context', 'Runtime 正在加载上下文。');
    }
    if (latestRunControllerSnapshot.coreState.state === 'executing_tools') {
      transitionCoreState('recording_tool_results', '工具执行结束，记录工具结果。');
    }
    if (latestRunControllerSnapshot.coreState.state === 'recording_tool_results') {
      transitionCoreState('continuing_after_tools', '工具结果已记录，准备继续模型步骤。');
    }
    if (
      latestRunControllerSnapshot.coreState.state === 'loading_context' ||
      latestRunControllerSnapshot.coreState.state === 'compacting_context' ||
      latestRunControllerSnapshot.coreState.state === 'continuing_after_tools' ||
      latestRunControllerSnapshot.coreState.state === 'collecting_tool_calls'
    ) {
      transitionCoreState('building_model_input', reason);
    }
  };

  const advanceProviderStreaming = (reason: string): void => {
    advanceProviderInputReady('Runtime 正在构建 provider 输入。');
    transitionCoreState('streaming_model_step', reason);
  };

  const advanceProviderCollected = (reason: string): void => {
    advanceProviderStreaming(reason);
    transitionCoreState('collecting_tool_calls', reason);
  };

  const advanceToolExecution = (reason: string): void => {
    advanceProviderCollected(reason);
    transitionCoreState('executing_tools', reason);
  };

  const advanceToolResultsRecorded = (reason: string): void => {
    advanceToolExecution(reason);
    transitionCoreState('recording_tool_results', reason);
  };

  const advanceRunCompleted = (reason: string): void => {
    advanceProviderInputReady('工具结果已回放，准备最终模型状态。');
    advanceProviderCollected(reason);
    transitionCoreState('completed', reason);
  };

  const advanceRunFailed = (reason: string): void => {
    transitionCoreState('failed', reason);
  };

  const advanceContextCompaction = (reason: string): void => {
    if (latestRunControllerSnapshot.coreState.state === 'initializing') {
      transitionCoreState('loading_context', 'Runtime 正在加载上下文。');
    }
    transitionCoreState('compacting_context', reason);
  };

  const recordRunControllerProviderStep = (
    input: AgentRunControllerProviderStepInput
  ): AgentRunControllerSnapshot => {
    latestCoreProviderStep = input.providerStep;
    latestRunControllerSnapshot = runController.recordProviderStep({
      ...input
    });
    return latestRunControllerSnapshot;
  };

  const recordRunControllerToolResult = (toolResult: AgentRunControllerToolResultInput): AgentRunControllerSnapshot => {
    latestRunControllerSnapshot = runController.recordToolResult(toolResult);
    return latestRunControllerSnapshot;
  };

  const submitEvent = (event: AgentCoreRuntimeBridgeEvent): AgentCoreRuntimeBridgeSnapshot => {
    switch (event.type) {
      case 'context':
        if (event.phase === 'loading_started') {
          transitionCoreState('loading_context', event.reason);
        } else {
          advanceContextCompaction(event.reason);
        }
        break;
      case 'provider':
        switch (event.phase) {
          case 'step_started':
          case 'step_streaming':
            advanceProviderStreaming(event.reason);
            break;
          case 'step_collected':
            advanceProviderCollected(event.reason);
            break;
          case 'input_ready':
            advanceProviderInputReady(event.reason);
            break;
          case 'step_recorded':
            recordRunControllerProviderStep({
              providerStep: event.providerStep,
              ...event.options
            });
            break;
        }
        break;
      case 'tool':
        if (event.phase === 'execution_started') {
          advanceToolExecution(event.reason);
        } else if (event.phase === 'results_recorded') {
          advanceToolResultsRecorded(event.reason);
        } else {
          recordRunControllerToolResult(event.toolResult);
        }
        break;
      case 'terminal':
        if (event.status === 'completed') {
          advanceRunCompleted(event.reason);
        } else if (event.status === 'failed') {
          advanceRunFailed(event.reason);
        } else {
          transitionCoreState('interrupted_resumable', event.reason);
        }
        break;
    }
    return getSnapshot();
  };

  return {
    submitEvent,
    getSnapshot
  };
}

export function createAgentCoreRuntimeBridge(options: {
  callbacks?: AgentCoreRuntimeBridgeCallbacks;
  stageId: string;
  stageTitle?: string;
  stageTarget?: string;
  initialState?: AgentCoreState;
  guardTransitions?: boolean;
  runId?: string;
  turnId?: string;
}) {
  const engine = createAgentCoreRuntimeEventController({
    guardTransitions: options.guardTransitions,
    initialState: options.initialState,
    runId: options.runId,
    turnId: options.turnId
  });

  const emitCoreStateStage = (status: AgentCoreRuntimeBridgeStageStatus, summary: string): void => {
    const snapshot = engine.getSnapshot();
    options.callbacks?.emitStage?.({
      stageId: options.stageId,
      title: options.stageTitle ?? 'Agent Core v2 状态机',
      target: options.stageTarget ?? options.stageId,
      status,
      summary,
      input: {
        coreState: snapshot.coreState,
        providerStep: snapshot.providerStep,
        runController: summarizeAgentRunControllerSnapshot(snapshot.runController)
      }
    });
  };

  return {
    submitEvent: engine.submitEvent,
    emitCoreStateStage,
    getRunControllerSnapshot: () => engine.getSnapshot().runController,
    getRuntimeSnapshot: engine.getSnapshot
  };
}
