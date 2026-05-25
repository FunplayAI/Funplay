import { type ModelMessage } from 'ai';
import { createLanguageModel } from '../../ai-provider';
import { buildNativeToolLoopMessages } from '../model-message-builder';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import { createProviderRuntimeController } from '../provider-runtime-events';
import type { GenericAgentRuntimeParams } from '../types';
import {
  resolveLatestTodoSnapshotFromHistory
} from './continuation-policy';
import {
  resolveNativeMainToolLoopMaxOutputTokens
} from './tool-loop-options';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { completeNativeAiSdkProviderStep } from './ai-sdk-completion-stage';
import {
  runNativeAiSdkProviderStep,
  type NativeAiSdkLoopState
} from './ai-sdk-provider-step';
import {
  createNativeToolLoopControllerBridge,
  type NativeToolLoopCallbacks
} from './tool-loop-controller';
import { createNativeToolLoopPrompt } from './tool-loop-prompt';
import { initializeNativeToolLoopToolPool } from './tool-loop-setup';
import type { NativeToolLoopRunResult } from './tool-loop-state';

export async function runNativeAiSdkToolLoop(
  params: GenericAgentRuntimeParams,
  callbacks?: NativeToolLoopCallbacks
): Promise<NativeToolLoopRunResult> {
  if (!params.provider) {
    throw new Error('Native tool loop requires a provider.');
  }
  const model = createLanguageModel(params.provider);
  const {
    includeWriteTools,
    includeMcpToolCalls,
    includeCommandTools,
    toolPool,
    toolNames
  } = await initializeNativeToolLoopToolPool(params, callbacks, {
    title: '准备真实 Tool Schema',
    runningSummary: '正在初始化 Native 工作区工具池。',
    completedSummary: (toolCount) => `已注册 ${toolCount} 个 Native 工作区工具。`
  });
  const instructionTracker = new ProjectInstructionTracker(params.project, params.context.projectInstructions);

  const loopState: NativeAiSdkLoopState = {
    messages: buildNativeToolLoopMessages({
      project: params.project,
      sessionId: params.context.activeSessionId,
      currentPrompt: createNativeToolLoopPrompt(params, toolNames, {
        includeWriteTools,
        includeMcpToolCalls,
        includeCommandTools,
        dynamicMcpToolNames: toolPool.dynamicMcpTools.map((definition) => definition.name),
        toolDefinitions: toolPool.definitions
      })
    }) as ModelMessage[],
    assistantMessage: '',
    thinking: '',
    stepCount: 0,
    streamedText: false,
    toolCalls: [],
    partialWriteContinuationCount: 0,
    incompleteTodoContinuationCount: 0,
    latestTodoSnapshot: resolveLatestTodoSnapshotFromHistory(params)
  };
  const stepState = new NativeAiSdkStepState();
  const maxOutputTokens = resolveNativeMainToolLoopMaxOutputTokens(params.provider);
  const controllerBridge = createNativeToolLoopControllerBridge({
    callbacks,
    guardTransitions: true,
    runId: params.activeRunId,
    stageId: 'stage:native_ai_sdk_agent_core_v2',
    turnId: params.turnId
  });
  const {
    submitEvent,
    emitCoreStateStage
  } = controllerBridge;
  const providerController = createProviderRuntimeController({
    submitEvent,
    mapToolEventsToCore: false
  });

  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行真实 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: '已启动真实 tool-calling 流，由 Agent Core 状态与 provider finishReason 驱动续跑。'
  });
  emitCoreStateStage('running', 'AI SDK Native tool loop 已接入 Agent Core v2 状态机。');

  while (true) {
    params.abortSignal?.throwIfAborted();
    let providerStep;
    try {
      providerStep = await runNativeAiSdkProviderStep({
        params,
        callbacks,
        model,
        toolPool,
        instructionTracker,
        stepState,
        loopState,
        maxOutputTokens,
        providerController
      });
    } catch (error) {
      if (params.abortSignal?.aborted) {
        providerController.interruptRun('AI SDK Native tool loop 被中断。');
        emitCoreStateStage('failed', 'Agent Core v2 记录可恢复中断。');
      } else {
        providerController.failRun(error instanceof Error ? error.message : 'AI SDK Native tool loop 执行失败。');
        emitCoreStateStage('failed', 'Agent Core v2 记录 AI SDK Native tool loop 失败。');
      }
      throw error;
    }

    const completionDecision = completeNativeAiSdkProviderStep({
      params,
      callbacks,
      includeWriteTools,
      loopState,
      providerStep,
      providerController,
      emitCoreStateStage
    });
    if (completionDecision.action === 'return') {
      return completionDecision.result;
    }
  }
}
