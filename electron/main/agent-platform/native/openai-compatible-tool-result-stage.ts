import type { AgentRunControllerSnapshot } from '../agent-run-controller';
import { ProjectInstructionTracker } from '../project-instruction-tracker';
import type { GenericAgentRuntimeParams } from '../types';
import type {
  AgentCoreState,
  AiProviderApiMode
} from '../../../../shared/types';
import type { OpenAiCompatibleToolStepResult } from '../../openai-compatible-client';
import {
  createEditFailureRecoveryPrompt,
  type NativeEditFailureRecovery
} from './continuation-policy';
import { NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT } from './tool-loop-options';
import { isAbortLikeError } from './tool-loop-output';
import { executeOpenAiCompatibleToolStage } from './openai-compatible-tool-stage';
import type {
  NativeProcessTextStepStream,
  NativeProcessTextStream
} from './tool-loop-process-stream';
import type {
  NativeRunControllerToolResult,
  NativeToolLoopCallbacks
} from './tool-loop-controller';
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
  processTextStream: NativeProcessTextStream;
  stepStream: NativeProcessTextStepStream;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  recordRunControllerProviderStep: () => AgentRunControllerSnapshot;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
  transitionCoreState: (to: AgentCoreState, reason: string) => void;
  emitCoreStateStage: (status: 'running' | 'completed' | 'failed', summary: string) => void;
}): Promise<OpenAiCompatibleToolResultStageDecision> {
  const controllerSnapshot = input.recordRunControllerProviderStep();
  input.transitionCoreState('collecting_tool_calls', `Provider step ${input.stepIndex + 1} 完成，finishReason=${input.state.finishReason ?? 'unknown'}，toolCalls=${input.stepResult.toolCalls.length}。`);
  if (controllerSnapshot.nextAction !== 'execute_tools') {
    input.processTextStream.discard(input.stepStream);
    input.transitionCoreState('failed', `Agent Run Controller 返回了无法在工具分支处理的动作：${controllerSnapshot.nextAction}。`);
    input.callbacks?.emitStage?.({
      stageId: 'stage:native_tool_stream',
      title: '执行兼容 Tool Loop',
      target: 'stage:native_tool_stream',
      status: 'completed',
      summary: [
        `完成 ${input.stepIndex + 1} 步`,
        input.state.finishReason ? `finishReason=${input.state.finishReason}` : '',
        `tools=${input.stepResult.toolCalls.map((toolCall) => toolCall.name).join(', ')}`,
        `controllerAction=${controllerSnapshot.nextAction}`
      ].filter(Boolean).join('；')
    });
    input.emitCoreStateStage('failed', 'Agent Run Controller 返回了工具分支无法处理的动作。');
    return {
      action: 'return',
      result: createNativeToolLoopRunResult(input.state, controllerSnapshot.coreState)
    };
  }
  input.transitionCoreState('executing_tools', `Provider 返回 ${input.stepResult.toolCalls.length} 个 tool call，进入工具执行。`);

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
    editFailureRecoveries.push(...(await executeOpenAiCompatibleToolStage({
      toolCalls: input.stepResult.toolCalls,
      stepIndex: input.stepIndex,
      state: input.state,
      callbacks: input.callbacks,
      toolPool: input.toolPool,
      instructionTracker: input.instructionTracker,
      recordRunControllerToolResult: input.recordRunControllerToolResult
    })).editFailureRecoveries);
  } catch (error) {
    if (isAbortLikeError(error, input.params.abortSignal)) {
      input.transitionCoreState('interrupted_resumable', '工具执行被中断，已把未完成工具记录为结构化错误结果。');
      input.emitCoreStateStage('failed', 'Agent Core v2 状态机记录可恢复中断。');
      throw error;
    }
  }
  input.transitionCoreState('recording_tool_results', `已记录第 ${input.stepIndex + 1} 步工具结果。`);

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
  input.transitionCoreState('continuing_after_tools', '工具结果已进入上下文，准备回放给模型。');

  input.callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行兼容 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: `兼容 tool loop 已完成 ${input.stepIndex + 1} 步。`,
    input: {
      step: input.stepIndex + 1,
      finishReason: input.state.finishReason,
      toolsUsed: [...input.state.toolCalls],
      usage: input.state.usage
    }
  });
  input.transitionCoreState('building_model_input', '工具结果已记录，构建下一轮 provider 输入。');
  return {
    action: 'continue',
    nextStepIndex: input.stepIndex + 1
  };
}
