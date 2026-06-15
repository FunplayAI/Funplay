import { inferOpenAiCompatibleApiMode } from '../../../../shared/provider-catalog';
import { drainBackgroundCommandNoticeMessage } from '../persistent-terminal-store';
import { buildNativeToolLoopMessages } from '../model-message-builder';
import { resolveModelVisionEnabled } from './multimodal';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import { createProviderRuntimeController } from '../provider-runtime-events';
import { emitRuntimeTextDelta } from '../runtime-event-emitter';
import type { GenericAgentRuntimeParams } from '../types';
import { resolveLatestTodoSnapshotFromHistory } from './continuation-policy';
import { convertModelMessagesToOpenAiCompatible } from './tool-loop-message-adapter';
import {
  buildNativeMainToolLoopFinalPrompt,
  resolveNativeMainToolLoopMaxOutputTokens,
  resolveNativeMainToolLoopMaxSteps
} from './tool-loop-options';
import { createNativeToolLoopControllerBridge, type NativeToolLoopCallbacks } from './tool-loop-controller';
import { completeOpenAiCompatibleNoToolStep } from './openai-compatible-completion-stage';
import { runOpenAiCompatibleProviderStep } from './openai-compatible-provider-step';
import { recordOpenAiCompatibleToolResultStage } from './openai-compatible-tool-result-stage';
import { NativeProcessTextStream } from './tool-loop-process-stream';
import { createNativeToolLoopPrompt } from './tool-loop-prompt';
import { initializeNativeToolLoopToolPool } from './tool-loop-setup';
import {
  createNativeToolLoopRunResult,
  createNativeToolLoopState,
  type NativeToolLoopRunResult
} from './tool-loop-state';

export async function runOpenAiCompatibleNativeToolLoop(
  params: GenericAgentRuntimeParams,
  callbacks?: NativeToolLoopCallbacks
): Promise<NativeToolLoopRunResult> {
  if (!params.provider || params.provider.protocol !== 'openai-compatible') {
    throw new Error('OpenAI-compatible tool loop requires an OpenAI-compatible provider.');
  }

  const { includeWriteTools, includeMcpToolCalls, includeCommandTools, toolPool, toolNames } =
    await initializeNativeToolLoopToolPool(params, callbacks, {
      title: '准备兼容 Tool Schema',
      runningSummary: '正在初始化 OpenAI-compatible 工作区工具池。',
      completedSummary: (toolCount) => `已注册 ${toolCount} 个 OpenAI-compatible 工作区工具。`
    });

  const instructionTracker = new ProjectInstructionTracker(params.project, params.context.projectInstructions);
  const builtMessages = await buildNativeToolLoopMessages({
    project: params.project,
    sessionId: params.context.activeSessionId,
    visionEnabled: resolveModelVisionEnabled(params.provider),
    currentPrompt: createNativeToolLoopPrompt(params, toolNames, {
      includeWriteTools,
      includeMcpToolCalls,
      includeCommandTools,
      dynamicMcpToolNames: toolPool.dynamicMcpTools.map((definition) => definition.name),
      toolDefinitions: toolPool.definitions
    })
  });
  const state = createNativeToolLoopState(
    convertModelMessagesToOpenAiCompatible(builtMessages, {
      preserveToolMessages: true
    })
  );
  state.latestTodoSnapshot = resolveLatestTodoSnapshotFromHistory(params);
  const apiMode = inferOpenAiCompatibleApiMode(params.provider);
  const maxOutputTokens = resolveNativeMainToolLoopMaxOutputTokens(params.provider);
  const maxSteps = resolveNativeMainToolLoopMaxSteps();
  const controllerBridge = createNativeToolLoopControllerBridge({
    callbacks,
    guardTransitions: true,
    runId: params.activeRunId,
    stageId: 'stage:native_agent_core_v2',
    turnId: params.turnId
  });
  const { submitEvent, emitCoreStateStage } = controllerBridge;
  const providerController = createProviderRuntimeController({
    submitEvent,
    mapToolEventsToCore: false
  });

  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行工具步骤',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: '已启动工具执行，正在根据模型结果推进任务。'
  });
  emitCoreStateStage('running', 'OpenAI-compatible Native tool loop 已接入 Agent Core v2 状态机。');

  let stepIndex = 0;
  const processTextStream = new NativeProcessTextStream({
    state,
    onTextDelta: (delta, accumulated) => emitRuntimeTextDelta(params, delta, accumulated)
  });
  while (true) {
    params.abortSignal?.throwIfAborted();
    const backgroundNotice = drainBackgroundCommandNoticeMessage(params.project.id);
    if (backgroundNotice) {
      state.messages.push({ role: 'user', content: backgroundNotice });
    }
    if (stepIndex >= maxSteps) {
      providerController.completeRun(`已达到 ${maxSteps} 轮工具循环步数预算上限。`);
      emitCoreStateStage('completed', `工具循环达到 ${maxSteps} 轮步数预算上限，已强制收尾。`);
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_loop_step_budget',
        title: '工具循环步数预算上限',
        target: 'stage:native_tool_loop_step_budget',
        status: 'completed',
        summary: `已达到 ${maxSteps} 轮步数预算上限，停止继续调用工具。`,
        input: { maxSteps, stepCount: stepIndex }
      });
      return createNativeToolLoopRunResult(state);
    }
    if (stepIndex === maxSteps - 1) {
      state.messages.push({
        role: 'user',
        content: buildNativeMainToolLoopFinalPrompt(maxSteps)
      });
    }
    await toolPool.refresh({
      stepIndex,
      emitStage: callbacks?.emitStage
    });
    const stepStream = processTextStream.createStepStream();
    const providerStepResult = await runOpenAiCompatibleProviderStep({
      params,
      callbacks,
      toolPool,
      instructionTracker,
      state,
      stepIndex,
      maxOutputTokens,
      processTextStream,
      stepStream,
      providerController
    });
    const { stepResult, providerStep } = providerStepResult;

    if (stepResult.toolCalls.length === 0) {
      const completionDecision = completeOpenAiCompatibleNoToolStep({
        params,
        callbacks,
        includeWriteTools,
        apiMode,
        state,
        stepIndex,
        stepResult,
        processTextStream,
        stepStream,
        providerStep,
        providerController,
        emitCoreStateStage
      });
      if (completionDecision.action === 'return') {
        return completionDecision.result;
      }
      stepIndex = completionDecision.nextStepIndex;
      continue;
    }

    const toolResultDecision = await recordOpenAiCompatibleToolResultStage({
      params,
      callbacks,
      includeWriteTools,
      apiMode,
      state,
      stepIndex,
      stepResult,
      processTextStream,
      stepStream,
      toolPool,
      instructionTracker,
      providerStep,
      providerController,
      emitCoreStateStage
    });
    if (toolResultDecision.action === 'return') {
      return toolResultDecision.result;
    }
    stepIndex = toolResultDecision.nextStepIndex;
  }
}
