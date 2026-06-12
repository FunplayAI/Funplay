import type { AgentToolTransactionSummary } from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import type { OpenAiCompatibleToolCall } from '../../openai-compatible-client';
import {
  createProjectInstructionGuardSummary,
  isProjectInstructionGuardedWriteTool,
  ProjectInstructionTracker,
  type ProjectInstructionGuardResult
} from '../project-instruction-tracker';
import { createToolExecutorTransactionSummary } from '../tool-executor';
import { collectEditFailureRecovery, type NativeEditFailureRecovery } from './continuation-policy';
import { createInvalidMultiEditInputResult } from './tool-loop-options';
import {
  formatFailedToolResult,
  formatInterruptedToolResult,
  isAbortLikeError,
  truncateToolArgumentPreview
} from './tool-loop-output';
import { type NativeRunControllerToolResult, type NativeToolLoopCallbacks } from './tool-loop-controller';
import { observeNativeToolLoopToolResult } from './tool-loop-observer';
import type { NativeOpenAiToolInvocation, NativeToolLoopState } from './tool-loop-state';
import { collectToolResultImageParts } from './multimodal';
import {
  executeNativeWorkspaceToolTransaction,
  recordNativeWorkspaceToolTransactionResult,
  type NativeWorkspaceToolOutput,
  type NativeWorkspaceToolResultSource,
  type NativeWorkspaceToolValidationResult
} from './tool-executor';
import {
  describeNativeRuntimeToolUse,
  resolveNativeRuntimeToolName,
  type NativeRuntimeToolDefinition
} from './tool-adapter';
import {
  createProviderRuntimeEventObserver,
  createProviderRuntimeToolCallbackHandlers,
  type ProviderRuntimeEventObserver
} from '../provider-runtime-events';
import { createNativeToolExecutionPlan } from './tool-execution-plan';
import type { NativeToolPool } from './tool-pool';

type CachedToolResult = NativeToolLoopState['completedToolResultsByUseId'] extends Map<string, infer T> ? T : never;

interface NativeStreamingToolPrecompute {
  cachedToolResult?: CachedToolResult;
  malformedToolResult?: NativeWorkspaceToolOutput;
  invalidToolInputResult?: NativeWorkspaceToolOutput;
  projectInstructionGuardResult?: NativeWorkspaceToolOutput;
  projectInstructionGuard?: ProjectInstructionGuardResult;
  precomputedToolResult?: NativeWorkspaceToolOutput;
  resultSource?: NativeWorkspaceToolResultSource;
  validation?: NativeWorkspaceToolValidationResult;
}

interface NativeStreamingToolExecution {
  invocation: NativeOpenAiToolInvocation;
  precompute: NativeStreamingToolPrecompute;
  summary: string;
  toolResult: NativeWorkspaceToolOutput;
  transaction: AgentToolTransactionSummary;
  abortLike?: boolean;
  abortError?: unknown;
}

export function createNativeOpenAiToolInvocations(input: {
  toolCalls: OpenAiCompatibleToolCall[];
  stepIndex: number;
}): NativeOpenAiToolInvocation[] {
  return input.toolCalls.map((toolCall) => ({
    toolCall,
    toolUseId: toolCall.id || makeId('tool'),
    stepIndex: input.stepIndex,
    started: false,
    completed: false
  }));
}

function createMalformedToolResult(toolCall: OpenAiCompatibleToolCall): NativeWorkspaceToolOutput | undefined {
  if (!toolCall.argumentsParseError) {
    return undefined;
  }
  return {
    ok: false,
    isError: true,
    failureKind: 'invalid_arguments',
    recoveryHint: 'Return valid JSON arguments that match the tool schema before retrying.',
    media: undefined,
    summary: [
      `工具调用参数 JSON 无法解析，未执行 ${toolCall.name}。`,
      `错误：${toolCall.argumentsParseError}`,
      toolCall.rawArguments ? `原始参数：${truncateToolArgumentPreview(toolCall.rawArguments)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  };
}

function createProjectInstructionGuardToolOutput(guard: ProjectInstructionGuardResult): NativeWorkspaceToolOutput {
  return {
    ok: false,
    isError: true,
    failureKind: guard.failureKind,
    recoveryHint: guard.recoveryHint,
    summary: guard.summary
  };
}

function guardWriteBeforeLocalInstructions(input: {
  instructionTracker: ProjectInstructionTracker;
  toolName: string;
  arguments?: Record<string, unknown>;
}): ProjectInstructionGuardResult | undefined {
  const tracker = input.instructionTracker as ProjectInstructionTracker & {
    guardWriteBeforeLocalInstructions?: ProjectInstructionTracker['guardWriteBeforeLocalInstructions'];
  };
  if (typeof tracker.guardWriteBeforeLocalInstructions === 'function') {
    return tracker.guardWriteBeforeLocalInstructions(input.toolName, input.arguments);
  }
  if (!isProjectInstructionGuardedWriteTool(input.toolName)) {
    return undefined;
  }
  const instructions = input.instructionTracker.discoverFromToolInput(input.toolName, input.arguments);
  if (instructions.length === 0) {
    return undefined;
  }
  const paths = instructions.map((instruction) => instruction.path);
  return {
    instructions,
    paths,
    failureKind: 'project_instructions_required',
    recoveryHint:
      'Read the newly injected local project instructions, then retry the write only if it still satisfies those rules.',
    summary: createProjectInstructionGuardSummary({
      toolName: input.toolName,
      paths
    })
  };
}

function createPrecomputedToolResult(input: {
  state: NativeToolLoopState;
  toolUseId: string;
  toolCall: OpenAiCompatibleToolCall;
  instructionTracker: ProjectInstructionTracker;
}): NativeStreamingToolPrecompute {
  const cachedToolResult = input.state.completedToolResultsByUseId.get(input.toolUseId);
  const malformedToolResult = createMalformedToolResult(input.toolCall);
  const invalidToolInputResult = malformedToolResult ? undefined : createInvalidMultiEditInputResult(input.toolCall);
  const projectInstructionGuard =
    cachedToolResult || malformedToolResult || invalidToolInputResult
      ? undefined
      : guardWriteBeforeLocalInstructions({
          instructionTracker: input.instructionTracker,
          toolName: input.toolCall.name,
          arguments: input.toolCall.arguments
        });
  const projectInstructionGuardResult = projectInstructionGuard
    ? createProjectInstructionGuardToolOutput(projectInstructionGuard)
    : undefined;
  const resultSource: NativeWorkspaceToolResultSource | undefined = cachedToolResult
    ? 'cached'
    : malformedToolResult || invalidToolInputResult || projectInstructionGuardResult
      ? 'validation_failed'
      : undefined;
  const precomputedToolResult: NativeWorkspaceToolOutput | undefined = cachedToolResult
    ? {
        ok: !cachedToolResult.isError,
        summary: cachedToolResult.summary,
        isError: cachedToolResult.isError,
        failureKind: cachedToolResult.failureKind,
        recoveryHint: cachedToolResult.recoveryHint,
        media: cachedToolResult.media,
        changedFiles: cachedToolResult.changedFiles,
        command: cachedToolResult.command,
        terminal: cachedToolResult.terminal,
        browser: cachedToolResult.browser,
        edit: cachedToolResult.edit,
        mcp: cachedToolResult.mcp,
        artifacts: cachedToolResult.artifacts,
        searchText: cachedToolResult.searchText
      }
    : (malformedToolResult ?? invalidToolInputResult ?? projectInstructionGuardResult);
  const validation: NativeWorkspaceToolValidationResult | undefined =
    malformedToolResult || invalidToolInputResult || projectInstructionGuardResult
      ? {
          status: 'failed',
          summary: precomputedToolResult?.summary,
          failureKind: precomputedToolResult?.failureKind ?? precomputedToolResult?.edit?.failureKind,
          recoveryHint: precomputedToolResult?.recoveryHint ?? precomputedToolResult?.edit?.recoveryHint
        }
      : undefined;

  return {
    cachedToolResult,
    malformedToolResult,
    invalidToolInputResult,
    projectInstructionGuardResult,
    projectInstructionGuard,
    precomputedToolResult,
    resultSource,
    validation
  };
}

function createNativeStreamingToolRecorder(input: {
  state: NativeToolLoopState;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
}) {
  const recordToolUseStart = (invocation: NativeOpenAiToolInvocation): void => {
    if (invocation.started) {
      return;
    }
    invocation.started = true;
    input.state.toolCalls.push(invocation.toolCall.name);
    input.state.parts.push({
      type: 'tool_use',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      name: invocation.toolCall.name,
      input: invocation.toolCall.arguments
    });
  };

  const recordToolResult = (
    invocation: NativeOpenAiToolInvocation,
    toolResult: NativeWorkspaceToolOutput,
    summary: string,
    transaction?: AgentToolTransactionSummary
  ): void => {
    invocation.completed = true;
    input.recordRunControllerToolResult({
      toolUseId: invocation.toolUseId,
      toolName: invocation.toolCall.name,
      content: summary,
      isError: Boolean(toolResult.isError),
      failureKind: toolResult.failureKind ?? toolResult.edit?.failureKind,
      recoveryHint: toolResult.recoveryHint ?? toolResult.edit?.recoveryHint,
      changedFiles: toolResult.changedFiles,
      command: toolResult.command,
      terminal: toolResult.terminal,
      browser: toolResult.browser,
      edit: toolResult.edit,
      mcp: toolResult.mcp,
      artifacts: toolResult.artifacts,
      transaction
    });
    input.state.parts.push({
      type: 'tool_result',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      content: summary,
      isError: Boolean(toolResult.isError)
    });
    input.state.messages.push({
      role: 'tool',
      toolCallId: invocation.toolUseId,
      name: invocation.toolCall.name,
      content: formatToolResultContentForModel(summary, toolResult)
    });
  };

  return {
    recordToolResult,
    recordToolUseStart
  };
}

/**
 * Tool results carry images on the UI-facing `media` field only. OpenAI-compatible
 * APIs cannot embed images inside a tool-result message, so when the model has
 * vision we push a synthetic follow-up user turn carrying the image parts (the
 * established Cline/OpenHands pattern). Without vision we leave a short text note
 * so the model knows an image exists but it cannot see it.
 */
async function appendToolResultImageMessage(input: {
  state: NativeToolLoopState;
  toolResult: NativeWorkspaceToolOutput;
  toolName: string;
  visionEnabled: boolean;
}): Promise<void> {
  const imageBlocks = input.toolResult.media?.filter((block) => block.type === 'image') ?? [];
  if (imageBlocks.length === 0) {
    return;
  }
  if (!input.visionEnabled) {
    input.state.messages.push({
      role: 'user',
      content: `（工具 ${input.toolName} 返回了 ${imageBlocks.length} 张图像，但当前模型不支持图像输入，无法查看。如需理解图像内容，请改用支持视觉的模型。）`
    });
    return;
  }
  const { parts, droppedCount } = await collectToolResultImageParts(imageBlocks);
  if (parts.length === 0) {
    input.state.messages.push({
      role: 'user',
      content: `（工具 ${input.toolName} 返回的图像无法解码或超出大小上限，已跳过。）`
    });
    return;
  }
  const note = droppedCount > 0
    ? `以下为工具 ${input.toolName} 返回的图像（另有 ${droppedCount} 张因数量/大小上限被跳过）：`
    : `以下为工具 ${input.toolName} 返回的图像：`;
  input.state.messages.push({
    role: 'user',
    content: note,
    images: parts
  });
}

function formatToolResultContentForModel(summary: string, toolResult: NativeWorkspaceToolOutput): string {
  if (!toolResult.isError) {
    return summary;
  }
  const failureKind = toolResult.failureKind ?? toolResult.edit?.failureKind ?? toolResult.mcp?.failureKind;
  const recoveryHint = toolResult.recoveryHint ?? toolResult.edit?.recoveryHint;
  const metadata = [
    failureKind && !summary.includes(failureKind) ? `Failure kind: ${failureKind}` : '',
    recoveryHint && !summary.includes(recoveryHint) ? `Recovery hint: ${recoveryHint}` : ''
  ].filter(Boolean);
  if (metadata.length === 0) {
    return summary;
  }
  return [summary, '', '[Tool failure recovery]', ...metadata].join('\n');
}

function normalizeNativeToolInvocation(input: {
  invocation: NativeOpenAiToolInvocation;
  definitions: NativeRuntimeToolDefinition[];
}): NativeOpenAiToolInvocation {
  const resolvedName = resolveNativeRuntimeToolName(input.invocation.toolCall.name, input.definitions);
  if (!resolvedName || resolvedName === input.invocation.toolCall.name) {
    return input.invocation;
  }
  return {
    ...input.invocation,
    toolCall: {
      ...input.invocation.toolCall,
      name: resolvedName
    }
  };
}

function emitToolUse(input: {
  invocation: NativeOpenAiToolInvocation;
  definitions: NativeRuntimeToolDefinition[];
  eventObserver: ProviderRuntimeEventObserver;
  recordToolUseStart: (invocation: NativeOpenAiToolInvocation) => void;
}): void {
  input.recordToolUseStart(input.invocation);
  const presentation = describeNativeRuntimeToolUse({
    definitions: input.definitions,
    toolName: input.invocation.toolCall.name,
    toolInput: input.invocation.toolCall.arguments
  });
  input.eventObserver.observe({
    type: 'tool_use',
    toolUseId: input.invocation.toolUseId,
    toolName: input.invocation.toolCall.name,
    title: presentation.title,
    summary: presentation.summary,
    activity: presentation.activity,
    input: input.invocation.toolCall.arguments
  });
}

function emitToolResult(input: {
  execution: NativeStreamingToolExecution;
  eventObserver: ProviderRuntimeEventObserver;
  recordToolResult: (
    invocation: NativeOpenAiToolInvocation,
    toolResult: NativeWorkspaceToolOutput,
    summary: string,
    transaction?: AgentToolTransactionSummary
  ) => void;
}): void {
  const { invocation, toolResult, summary, transaction } = input.execution;
  input.recordToolResult(invocation, toolResult, summary, transaction);
  input.eventObserver.observe({
    type: 'tool_result',
    toolUseId: invocation.toolUseId,
    toolName: invocation.toolCall.name,
    content: summary,
    isError: Boolean(toolResult.isError),
    media: toolResult.media,
    changedFiles: toolResult.changedFiles,
    command: toolResult.command,
    terminal: toolResult.terminal,
    browser: toolResult.browser,
    edit: toolResult.edit,
    mcp: toolResult.mcp,
    artifacts: toolResult.artifacts,
    transaction
  });
}

async function executeInvocation(input: {
  invocation: NativeOpenAiToolInvocation;
  abortSignal?: AbortSignal;
  state: NativeToolLoopState;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
}): Promise<NativeStreamingToolExecution> {
  const { toolCall, toolUseId } = input.invocation;
  const precompute = createPrecomputedToolResult({
    state: input.state,
    toolUseId,
    toolCall,
    instructionTracker: input.instructionTracker
  });
  let transaction;
  let abortLike = false;
  let abortError: unknown;
  try {
    transaction = await executeNativeWorkspaceToolTransaction({
      tools: input.toolPool.toolSet,
      toolUseId,
      toolName: toolCall.name,
      input: toolCall.arguments,
      precomputedResult: precompute.precomputedToolResult,
      resultSource: precompute.resultSource,
      validation: precompute.validation
    });
  } catch (error) {
    abortLike = isAbortLikeError(error, input.abortSignal);
    abortError = error;
    transaction = recordNativeWorkspaceToolTransactionResult({
      toolUseId,
      toolName: toolCall.name,
      input: toolCall.arguments,
      resultSource: abortLike ? 'interrupted' : 'synthetic_failure',
      toolResult: {
        ok: false,
        isError: true,
        failureKind: abortLike ? 'interrupted' : 'tool_execution_failed',
        recoveryHint: abortLike
          ? 'Resume from the last completed tool boundary.'
          : 'Inspect the tool input and retry with corrected arguments or a safer alternative.',
        summary: abortLike ? formatInterruptedToolResult(error) : formatFailedToolResult(error)
      }
    });
  }
  return {
    invocation: input.invocation,
    precompute,
    summary: transaction.summary,
    toolResult: transaction.toolResult,
    transaction: createToolExecutorTransactionSummary(transaction.transaction),
    abortLike,
    abortError
  };
}

function recordExecutionSideEffects(input: {
  execution: NativeStreamingToolExecution;
  callbacks?: NativeToolLoopCallbacks;
  state: NativeToolLoopState;
  instructionTracker: ProjectInstructionTracker;
  editFailureRecoveries: NativeEditFailureRecovery[];
}): void {
  const { invocation, precompute, summary, toolResult } = input.execution;
  const { toolCall, toolUseId } = invocation;
  const editRecovery = collectEditFailureRecovery(toolCall, toolResult);
  if (editRecovery) {
    input.editFailureRecoveries.push(editRecovery);
  }
  const todoSnapshot = observeNativeToolLoopToolResult({
    instructionTracker: input.instructionTracker,
    callbacks: input.callbacks,
    toolName: toolCall.name,
    toolInput: toolCall.arguments,
    summary,
    isError: Boolean(toolResult.isError)
  });
  if (todoSnapshot) {
    input.state.latestTodoSnapshot = todoSnapshot;
  }
  if (precompute.projectInstructionGuard) {
    input.callbacks?.emitStage?.({
      stageId: `stage:native_project_instruction_guard:${toolUseId}`,
      title: '写入前发现局部 Agent 指令',
      target: toolCall.name,
      status: 'completed',
      summary: `已在执行 ${toolCall.name} 前载入 ${precompute.projectInstructionGuard.paths.join(', ')}，本次写入已拦截并回放给模型重试。`,
      input: {
        paths: precompute.projectInstructionGuard.paths
      }
    });
  }
  if (precompute.cachedToolResult) {
    input.callbacks?.emitStage?.({
      stageId: `stage:native_duplicate_tool_result:${toolUseId}`,
      title: '跳过重复工具执行',
      target: toolCall.name,
      status: 'completed',
      summary: `检测到重复 toolUseId=${toolUseId}，已回放先前工具结果，未再次执行工具。`
    });
    return;
  }

  input.state.completedToolResultsByUseId.set(toolUseId, {
    name: toolCall.name,
    summary,
    isError: Boolean(toolResult.isError),
    failureKind: toolResult.failureKind,
    recoveryHint: toolResult.recoveryHint,
    media: toolResult.media,
    changedFiles: toolResult.changedFiles,
    command: toolResult.command,
    terminal: toolResult.terminal,
    browser: toolResult.browser,
    edit: toolResult.edit,
    mcp: toolResult.mcp,
    artifacts: toolResult.artifacts,
    searchText: toolResult.searchText
  });
  if (precompute.malformedToolResult) {
    input.callbacks?.emitStage?.({
      stageId: `stage:native_malformed_tool_arguments:${toolUseId}`,
      title: '拒绝畸形工具参数',
      target: toolCall.name,
      status: 'completed',
      summary: `检测到 ${toolCall.name} 的工具参数不是有效 JSON，已作为工具错误回放给模型，未执行工具。`
    });
  } else if (precompute.invalidToolInputResult) {
    input.callbacks?.emitStage?.({
      stageId: `stage:native_invalid_tool_input:${toolUseId}`,
      title: '拒绝无效工具参数',
      target: toolCall.name,
      status: 'completed',
      summary: `检测到 ${toolCall.name} 的工具参数不满足执行条件，已作为工具错误回放给模型，未执行工具。`
    });
  }
}

function emitMissingToolResults(input: {
  invocations: NativeOpenAiToolInvocation[];
  error: unknown;
  abortSignal?: AbortSignal;
  state: NativeToolLoopState;
  eventObserver: ProviderRuntimeEventObserver;
  definitions: NativeRuntimeToolDefinition[];
  recordToolUseStart: (invocation: NativeOpenAiToolInvocation) => void;
  recordToolResult: (
    invocation: NativeOpenAiToolInvocation,
    toolResult: NativeWorkspaceToolOutput,
    summary: string,
    transaction?: AgentToolTransactionSummary
  ) => void;
}): void {
  const abortLike = isAbortLikeError(input.error, input.abortSignal);
  for (const invocation of input.invocations) {
    if (invocation.completed) {
      continue;
    }
    const summary = abortLike ? formatInterruptedToolResult(input.error) : formatFailedToolResult(input.error);
    input.state.completedToolResultsByUseId.set(invocation.toolUseId, {
      name: invocation.toolCall.name,
      summary,
      isError: true,
      failureKind: abortLike ? 'interrupted' : 'tool_execution_failed',
      recoveryHint: abortLike
        ? 'Resume from the last completed tool boundary.'
        : 'Inspect the tool input and retry with corrected arguments or a safer alternative.'
    });
    recordNativeWorkspaceToolTransactionResult({
      toolUseId: invocation.toolUseId,
      toolName: invocation.toolCall.name,
      input: invocation.toolCall.arguments,
      resultSource: abortLike ? 'interrupted' : 'synthetic_failure',
      hooks: {
        onStart: () => {
          emitToolUse({
            invocation,
            definitions: input.definitions,
            eventObserver: input.eventObserver,
            recordToolUseStart: input.recordToolUseStart
          });
        },
        onResult: (toolResult, resultSummary, transactionSummary) => {
          input.recordToolResult(invocation, toolResult, resultSummary, transactionSummary);
          input.eventObserver.observe({
            type: 'tool_result',
            toolUseId: invocation.toolUseId,
            toolName: invocation.toolCall.name,
            content: resultSummary,
            isError: Boolean(toolResult.isError),
            media: toolResult.media,
            changedFiles: toolResult.changedFiles,
            command: toolResult.command,
            terminal: toolResult.terminal,
            browser: toolResult.browser,
            edit: toolResult.edit,
            mcp: toolResult.mcp,
            artifacts: toolResult.artifacts,
            transaction: transactionSummary
          });
        }
      },
      toolResult: {
        ok: false,
        isError: true,
        failureKind: abortLike ? 'interrupted' : 'tool_execution_failed',
        recoveryHint: abortLike
          ? 'Resume from the last completed tool boundary.'
          : 'Inspect the tool input and retry with corrected arguments or a safer alternative.',
        summary
      }
    });
  }
}

export async function executeNativeStreamingToolPlan(input: {
  invocations: NativeOpenAiToolInvocation[];
  abortSignal?: AbortSignal;
  state: NativeToolLoopState;
  callbacks?: NativeToolLoopCallbacks;
  toolPool: NativeToolPool;
  instructionTracker: ProjectInstructionTracker;
  recordRunControllerToolResult: (toolResult: NativeRunControllerToolResult) => unknown;
  visionEnabled?: boolean;
}): Promise<{
  editFailureRecoveries: NativeEditFailureRecovery[];
}> {
  const invocations = input.invocations.map((invocation) =>
    normalizeNativeToolInvocation({
      invocation,
      definitions: input.toolPool.definitions
    })
  );
  const recorder = createNativeStreamingToolRecorder({
    state: input.state,
    recordRunControllerToolResult: input.recordRunControllerToolResult
  });
  const eventObserver = createProviderRuntimeEventObserver({
    ...createProviderRuntimeToolCallbackHandlers(input.callbacks)
  });
  const executionPlan = createNativeToolExecutionPlan({
    invocations,
    definitions: input.toolPool.definitions
  });
  const editFailureRecoveries: NativeEditFailureRecovery[] = [];

  try {
    for (const batch of executionPlan.batches) {
      for (const invocation of batch.invocations) {
        emitToolUse({
          invocation,
          definitions: input.toolPool.definitions,
          eventObserver,
          recordToolUseStart: recorder.recordToolUseStart
        });
      }
      const executions =
        batch.mode === 'concurrent_safe'
          ? await Promise.all(
              batch.invocations.map((invocation) =>
                executeInvocation({
                  invocation,
                  abortSignal: input.abortSignal,
                  state: input.state,
                  toolPool: input.toolPool,
                  instructionTracker: input.instructionTracker
                })
              )
            )
          : [
              await executeInvocation({
                invocation: batch.invocations[0],
                abortSignal: input.abortSignal,
                state: input.state,
                toolPool: input.toolPool,
                instructionTracker: input.instructionTracker
              })
            ];

      let abortLikeExecution: NativeStreamingToolExecution | undefined;
      for (const execution of executions) {
        emitToolResult({
          execution,
          eventObserver,
          recordToolResult: recorder.recordToolResult
        });
        await appendToolResultImageMessage({
          state: input.state,
          toolResult: execution.toolResult,
          toolName: execution.invocation.toolCall.name,
          visionEnabled: input.visionEnabled === true
        });
        recordExecutionSideEffects({
          execution,
          callbacks: input.callbacks,
          state: input.state,
          instructionTracker: input.instructionTracker,
          editFailureRecoveries
        });
        if (execution.abortLike) {
          abortLikeExecution = execution;
        }
      }
      if (abortLikeExecution) {
        throw abortLikeExecution.abortError instanceof Error
          ? abortLikeExecution.abortError
          : new Error(abortLikeExecution.summary);
      }
    }
  } catch (error) {
    emitMissingToolResults({
      invocations,
      error,
      abortSignal: input.abortSignal,
      state: input.state,
      eventObserver,
      definitions: input.toolPool.definitions,
      recordToolUseStart: recorder.recordToolUseStart,
      recordToolResult: recorder.recordToolResult
    });
    throw error;
  }

  return {
    editFailureRecoveries
  };
}
