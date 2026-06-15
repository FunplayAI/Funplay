import { generateText, type ModelMessage } from 'ai';
import { createLanguageModel } from '../../ai-provider';
import { drainBackgroundCommandNoticeMessage } from '../persistent-terminal-store';
import { buildNativeToolLoopMessages } from '../model-message-builder';
import { resolveModelVisionEnabled } from './multimodal';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import { createProviderRuntimeController } from '../provider-runtime-events';
import type { GenericAgentRuntimeParams } from '../types';
import { resolveLatestTodoSnapshotFromHistory } from './continuation-policy';
import {
  buildNativeMainToolLoopFinalPrompt,
  resolveNativeMainToolLoopMaxOutputTokens,
  resolveNativeMainToolLoopMaxSteps
} from './tool-loop-options';
import { NativeAiSdkStepState } from './ai-sdk-step-state';
import { completeNativeAiSdkProviderStep } from './ai-sdk-completion-stage';
import { runNativeAiSdkProviderStep, type NativeAiSdkLoopState } from './ai-sdk-provider-step';
import { createNativeToolLoopControllerBridge, type NativeToolLoopCallbacks } from './tool-loop-controller';
import { createNativeToolLoopPrompt } from './tool-loop-prompt';
import { createNativeRuntimeSystemPrompt } from './prompt';
import { initializeNativeToolLoopToolPool } from './tool-loop-setup';
import type { NativeToolLoopRunResult } from './tool-loop-state';
import { normalizeModelReplyText } from './text';

export async function runNativeAiSdkToolLoop(
  params: GenericAgentRuntimeParams,
  callbacks?: NativeToolLoopCallbacks
): Promise<NativeToolLoopRunResult> {
  if (!params.provider) {
    throw new Error('Native tool loop requires a provider.');
  }
  const model = createLanguageModel(params.provider);
  const instructionTracker = new ProjectInstructionTracker(params.project, params.context.projectInstructions);
  const { includeWriteTools, includeMcpToolCalls, includeCommandTools, toolPool, toolNames } =
    await initializeNativeToolLoopToolPool(
      params,
      callbacks,
      {
        title: '准备工具能力',
        runningSummary: '正在初始化工作区工具能力。',
        completedSummary: (toolCount) => `已准备 ${toolCount} 个工作区工具。`
      },
      {
        projectInstructionGuard: ({ toolName, input }) => {
          const guard = instructionTracker.guardWriteBeforeLocalInstructions(toolName, input);
          if (guard) {
            callbacks?.emitStage?.({
              stageId: 'stage:native_ai_sdk_project_instruction_guard',
              title: '写入前发现局部 Agent 指令',
              target: toolName,
              status: 'completed',
              summary: `已在执行 ${toolName} 前载入 ${guard.paths.join(', ')}，本次写入已拦截并回放给模型重试。`,
              input: {
                paths: guard.paths
              }
            });
          }
          return guard;
        }
      }
    );

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
  const loopState: NativeAiSdkLoopState = {
    messages: builtMessages as ModelMessage[],
    assistantMessage: '',
    thinking: '',
    stepCount: 0,
    streamedText: false,
    toolCalls: [],
    partialWriteContinuationCount: 0,
    editFailureContinuationCount: 0,
    incompleteTodoContinuationCount: 0,
    editFailureRecoveries: [],
    latestTodoSnapshot: resolveLatestTodoSnapshotFromHistory(params)
  };
  const stepState = new NativeAiSdkStepState();
  const maxOutputTokens = resolveNativeMainToolLoopMaxOutputTokens(params.provider);
  const maxSteps = resolveNativeMainToolLoopMaxSteps();
  const controllerBridge = createNativeToolLoopControllerBridge({
    callbacks,
    guardTransitions: true,
    runId: params.activeRunId,
    stageId: 'stage:native_ai_sdk_agent_core_v2',
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
  emitCoreStateStage('running', 'AI SDK Native tool loop 已接入 Agent Core v2 状态机。');

  while (true) {
    params.abortSignal?.throwIfAborted();
    const backgroundNotice = drainBackgroundCommandNoticeMessage(params.project.id);
    if (backgroundNotice) {
      loopState.messages.push({ role: 'user', content: backgroundNotice });
    }
    if (loopState.stepCount >= maxSteps) {
      providerController.completeRun(`已达到 ${maxSteps} 轮工具循环步数预算上限。`);
      emitCoreStateStage('completed', `工具循环达到 ${maxSteps} 轮步数预算上限，已强制收尾。`);
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_loop_step_budget',
        title: '工具循环步数预算上限',
        target: 'stage:native_tool_loop_step_budget',
        status: 'completed',
        summary: `已达到 ${maxSteps} 轮步数预算上限，停止继续调用工具。`,
        input: { maxSteps, stepCount: loopState.stepCount }
      });
      let budgetReply = normalizeModelReplyText(loopState.assistantMessage);
      if (!budgetReply) {
        // No streamed text yet — make one tool-free pass so the model can
        // summarize the work done so far (mirrors the openai-compatible path's
        // closing prompt) instead of returning an empty reply.
        try {
          const closing = await generateText({
            model,
            system: createNativeRuntimeSystemPrompt(params.uiLanguage),
            messages: [...loopState.messages, { role: 'user', content: buildNativeMainToolLoopFinalPrompt(maxSteps) }],
            maxOutputTokens,
            abortSignal: params.abortSignal
          });
          budgetReply = normalizeModelReplyText(closing.text);
        } catch {
          // fall through to the localized fallback below
        }
      }
      if (!budgetReply) {
        budgetReply =
          params.uiLanguage === 'en-US'
            ? `Reached the ${maxSteps}-step tool-loop budget. Continue from the work already completed, or rephrase the request.`
            : `已达到 ${maxSteps} 轮工具循环步数上限。可以基于已完成的工作继续，或换一种方式提问。`;
      }
      return {
        assistantMessage: budgetReply,
        finishReason: 'step-budget-exhausted',
        stepCount: loopState.stepCount,
        toolCalls: loopState.toolCalls,
        streamedText: loopState.streamedText
      };
    }
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
        maxSteps,
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
