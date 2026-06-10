import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import type { AgentCoreProviderStepResult, AiProviderApiMode } from '../../../../shared/types';
import type { OpenAiCompatibleToolStepResult } from '../../openai-compatible-client';
import type { ProviderRuntimeController } from '../provider-runtime-events';
import { createEditFailureRecoveryPrompt, type NativeEditFailureRecovery } from './continuation-policy';
import { NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT } from './tool-loop-options';
import { isAbortLikeError } from './tool-loop-output';
import { executeOpenAiCompatibleToolStage } from './openai-compatible-tool-stage';
import type { NativeProcessTextStepStream, NativeProcessTextStream } from './tool-loop-process-stream';
import type { NativeRunControllerToolResult, NativeToolLoopCallbacks } from './tool-loop-controller';
import {
  appendNativeToolLoopAssistantToolMessage,
  createNativeToolLoopRunResult,
  recordNativeToolLoopAssistantText,
  type NativeToolLoopRunResult,
  type NativeToolLoopState
} from './tool-loop-state';
import type { NativeToolPool } from './tool-pool';

export type OpenAiCompatibleToolResultStageDecision =
  | {
      action: 'continue';
      nextStepIndex: number;
    }
  | {
      action: 'return';
      result: NativeToolLoopRunResult;
    };

export async function recordOpenAiCompatibleToolResultStage(input: {
  params: GenericAgentRuntimeParams;
  callbacks?: NativeToolLoopCallbacks;
  includeWriteTools: boolean;
  apiMode: AiProviderApiMode;
  state: NativeToolLoopState;
  stepIndex: number;
  stepResult: OpenAiCompatibleToolStepResult;
  providerStep: AgentCoreProviderStepResult;
  processTextStream: NativeProcessTextStream;
  stepStream: NativeProcessTextStepStream;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  providerController: ProviderRuntimeController;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): Promise<OpenAiCompatibleToolResultStageDecision> {
  const controllerSnapshot = input.providerController.recordProviderStep({
    providerStep: input.providerStep
  }).runController;
  if (controllerSnapshot.nextAction !== 'execute_tools') {
    input.processTextStream.discard(input.stepStream);
    input.providerController.failRun(
      `Agent Run Controller 返回了无法在工具分支处理的动作：${controllerSnapshot.nextAction}。`
    );
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_tool_stream',
      title: '执行工具步骤',
      target: 'stage:native_tool_stream',
      status: 'completed',
      summary: [
        `已完成 ${input.stepIndex + 1} 轮工具执行`,
        input.stepResult.toolCalls.length > 0
          ? `调用工具：${input.stepResult.toolCalls.map((toolCall) => toolCall.name).join(', ')}`
          : '',
        `下一步：${controllerSnapshot.nextAction}`
      ]
        .filter(Boolean)
        .join('；')
    });
    input.emitCoreStateStage('failed', 'Agent Run Controller 返回了工具分支无法处理的动作。');
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState, controllerSnapshot.parts)
    };
  }
  input.providerController.toolExecutionStarted(
    `Provider 返回 ${input.stepResult.toolCalls.length} 个 tool call，进入工具执行。`
  );

  if (input.stepResult.toolCallRepair?.type === 'textual_tool_marker') {
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_text_tool_repair',
      title: '修复文本工具调用',
      target: 'stage:native_text_tool_repair',
      status: 'completed',
      summary: `OpenAI-compatible 适配层把正文工具标记归一为结构化工具调用：${input.stepResult.toolCallRepair.toolNames.join(', ')}。`
    });
  }

  const assistantStepText = recordNativeToolLoopAssistantText(input.state, input.stepIndex, input.stepResult.text, {
    final: false
  });
  input.processTextStream.commit(assistantStepText, input.stepStream);
  appendNativeToolLoopAssistantToolMessage(input.state, input.stepResult, {
    apiMode: input.apiMode,
    assistantText: assistantStepText
  });

  const editFailureRecoveries: NativeEditFailureRecovery[] = [];

  try {
    editFailureRecoveries.push(
      ...(
        await executeOpenAiCompatibleToolStage({
          toolCalls: input.stepResult.toolCalls,
          stepIndex: input.stepIndex,
          state: input.state,
          callbacks: input.callbacks,
          abortSignal: input.params.abortSignal,
          toolPool: input.toolPool,
          instructionTracker: input.instructionTracker,
          recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) =>
            input.providerController.recordToolResult({
              toolResult
            })
        })
      ).editFailureRecoveries
    );
  } catch (error) {
    if (isAbortLikeError(error, input.params.abortSignal)) {
      input.providerController.interruptRun('工具执行被中断，已把未完成工具记录为结构化错误结果。');
      input.emitCoreStateStage('failed', 'Agent Core v2 状态机记录可恢复中断。');
      throw error;
    }
  }
  input.providerController.toolResultsRecorded(`已记录第 ${input.stepIndex + 1} 步工具结果。`);

  if (
    editFailureRecoveries.length > 0 &&
    input.includeWriteTools &&
    input.params.permission.mode !== 'read-only' &&
    input.state.editFailureContinuationCount < NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT
  ) {
    input.state.editFailureContinuationCount += 1;
    const recoveryPrompt = createEditFailureRecoveryPrompt(editFailureRecoveries);
    input.state.parts.push({
      type: 'continuation',
      stepIndex: input.stepIndex,
      reason: 'edit_recovery',
      text: recoveryPrompt
    });
    input.state.messages.push({
      role: 'user',
      content: recoveryPrompt
    });
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_edit_failure_recovery',
      title: '恢复失败编辑',
      target: 'stage:native_edit_failure_recovery',
      status: 'completed',
      summary: '检测到编辑工具预检失败，已要求模型重新读取目标片段或改用 unified patch 后继续。',
      input: {
        continuation: input.state.editFailureContinuationCount,
        failures: editFailureRecoveries.map((recovery) => ({
          toolName: recovery.toolName,
          path: recovery.path,
          failureKind: recovery.failureKind
        }))
      }
    });
  }

  input.callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行工具步骤',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: `已完成 ${input.stepIndex + 1} 轮工具执行。`,
    input: {
      step: input.stepIndex + 1,
      finishReason: input.state.finishReason,
      toolsUsed: [...input.state.toolCalls],
      usage: input.state.usage
    }
  });
  input.providerController.providerInputReady('工具结果已记录，构建下一轮 provider 输入。');
  return {
    action: 'continue',
    nextStepIndex: input.stepIndex + 1
  };
}
