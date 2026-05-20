import { stepCountIs, streamText } from 'ai';
import type { AgentLifecycleHookTrigger } from '../../../../shared/types';
import { makeId } from '../../../../shared/utils';
import { createLanguageModel } from '../../ai-provider';
import {
  generateOpenAiCompatibleStreamingToolStep,
  type OpenAiCompatibleToolMessage
} from '../../openai-compatible-client';
import { runAgentLifecycleHooks } from '../agent-hooks';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage, normalizeOpenAiUsage } from '../usage';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from '../workspace-tools';
import {
  createNativeProviderStepAbort,
  rethrowNativeProviderStepTimeout
} from './provider-step';
import { createNativeRuntimeSystemPrompt, createNativeRuntimeUserPrompt } from './prompt';
import { executeNativeWorkspaceToolSetTool } from './tool-executor';
import { createNativeToolPool } from './tool-pool';
import type { NativeToolPoolMode } from './tool-pool';

const NATIVE_SUBAGENT_DEFAULT_MAX_STEPS = 8;
const NATIVE_SUBAGENT_MAX_STEPS = 12;
const NATIVE_SUBAGENT_MAX_OUTPUT_CHARS = 8000;
const NATIVE_PARALLEL_SUBAGENT_MIN_TASKS = 2;
const NATIVE_PARALLEL_SUBAGENT_MAX_TASKS = 4;
const NATIVE_BACKGROUND_SUBAGENT_MAX_RECORDS = 40;

interface NativeBackgroundSubagentTask {
  id: string;
  projectId: string;
  sessionId?: string;
  name?: string;
  task: string;
  scope?: string;
  expectedOutput?: string;
  maxSteps: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

const backgroundSubagentTasks = new Map<string, NativeBackgroundSubagentTask>();

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function truncateSubagentOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= NATIVE_SUBAGENT_MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, NATIVE_SUBAGENT_MAX_OUTPUT_CHARS)}\n\n[Subagent output truncated: exceeded ${NATIVE_SUBAGENT_MAX_OUTPUT_CHARS} chars]`;
}

function pruneBackgroundSubagentTasks(): void {
  if (backgroundSubagentTasks.size <= NATIVE_BACKGROUND_SUBAGENT_MAX_RECORDS) {
    return;
  }
  const removable = [...backgroundSubagentTasks.values()]
    .filter((task) => task.status !== 'running')
    .sort((left, right) => Date.parse(left.finishedAt ?? left.startedAt) - Date.parse(right.finishedAt ?? right.startedAt));
  for (const task of removable) {
    if (backgroundSubagentTasks.size <= NATIVE_BACKGROUND_SUBAGENT_MAX_RECORDS) {
      return;
    }
    backgroundSubagentTasks.delete(task.id);
  }
}

function buildSubagentPrompt(params: GenericAgentRuntimeParams, action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>, toolNames: string[]): string {
  return [
    '你是一个只读子任务 Agent，负责独立调查一个范围明确的问题，并把结论压缩返回给主 Agent。',
    '',
    createNativeRuntimeUserPrompt(params, undefined, {
      includeRecentTurns: false
    }),
    '',
    '子任务：',
    action.task,
    action.scope ? ['', '调查范围：', action.scope].join('\n') : '',
    action.expectedOutput ? ['', '期望输出：', action.expectedOutput].join('\n') : '',
    '',
    '可用只读工具：',
    ...toolNames.map((toolName) => `- ${toolName}`),
    '',
    '规则：',
    '- 只做读取、搜索、网页获取和记忆检索，不要写文件、运行命令或调用高风险 MCP 工具。',
    '- 不要尝试再次启动子任务。',
    '- 优先返回事实、文件路径、入口点、风险或下一步建议；避免泛泛解释。',
    '- 输出必须简洁，给主 Agent 使用。'
  ]
    .filter(Boolean)
    .join('\n');
}

async function emitNativeSubagentStopHook(
  params: GenericAgentRuntimeParams,
  trigger: Omit<AgentLifecycleHookTrigger, 'event' | 'runId' | 'projectId' | 'sessionId'>
): Promise<void> {
  try {
    await runAgentLifecycleHooks(params.lifecycleHooks, {
      event: 'SubagentStop',
      runId: params.activeRunId,
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      ...trigger
    }, {
      project: params.project,
      permissionContext: {
        permission: params.permission,
        requestPermission: params.requestPermission
      },
      cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath,
      checkpointSnapshotId: params.checkpointSnapshotId,
      abortSignal: params.abortSignal,
      emitHook: params.onLifecycleHook,
      emitStage: params.onStage
    });
  } catch (error) {
    params.onStage?.({
      stageId: `stage:lifecycle_hook:SubagentStop:error:${makeId('hook')}`,
      title: '生命周期 Hook',
      target: 'hook:SubagentStop',
      status: 'failed',
      summary: 'SubagentStop lifecycle hook failed.',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function runNativeSubagent(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>
): Promise<WorkspaceToolActionResult> {
  if (!params.provider) {
    return {
      ok: false,
      isError: true,
      summary: 'Native subagent requires a provider.'
    };
  }

  const maxSteps = Math.min(
    NATIVE_SUBAGENT_MAX_STEPS,
    Math.max(1, action.maxSteps ?? NATIVE_SUBAGENT_DEFAULT_MAX_STEPS)
  );
  const subagentToolOptions: NativeToolPoolMode = {
    includeWriteTools: false,
    includeMcpToolCalls: false,
    includeCommandTools: false,
    excludeTools: ['ask_user', 'run_subagent', 'run_subagents', 'subagent_start', 'subagent_status']
  };
  const toolPool = await createNativeToolPool({
    params,
    mode: subagentToolOptions
  });
  const toolNames = toolPool.names;
  const tools = toolPool.toolSet;

  if (params.provider.protocol === 'openai-compatible') {
    let messages: OpenAiCompatibleToolMessage[] = [
      {
        role: 'user',
        content: buildSubagentPrompt(params, action, toolNames)
      }
    ];
    let assistantMessage = '';
    let stepCount = 0;
    let finishReason: string | undefined;
    const toolCalls: string[] = [];
    const compatibleToolDefinitions = toolPool.openAiCompatibleTools;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const stepAbort = createNativeProviderStepAbort(params.abortSignal, params.provider);
      const stepResult = await generateOpenAiCompatibleStreamingToolStep({
          provider: params.provider,
          system: createNativeRuntimeSystemPrompt(),
          messages,
          tools: compatibleToolDefinitions,
          maxOutputTokens: 2048,
          abortSignal: stepAbort.signal
        })
        .catch((error: unknown) => rethrowNativeProviderStepTimeout(
          error,
          stepAbort,
          'Native subagent provider step'
        ));
      stepCount += 1;
      finishReason = stepResult.finishReason;
      const stepUsage = normalizeOpenAiUsage(stepResult.usage, {
        provider: params.provider?.id,
        model: params.provider?.model
      });
      if (stepUsage) {
        params.onUsage?.(stepUsage);
      }
      if (stepResult.text.trim()) {
        assistantMessage = stepResult.text.trim();
      }
      if (stepResult.toolCalls.length === 0) {
        break;
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: stepResult.text.trim() || undefined,
          reasoningContent: stepResult.reasoningContent,
          toolCalls: stepResult.toolCalls
        }
      ];

      for (const toolCall of stepResult.toolCalls) {
        toolCalls.push(toolCall.name);
        const toolResult = await executeNativeWorkspaceToolSetTool(tools, toolCall.name, toolCall.arguments);
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: toolResult.summary ?? stringifyToolOutput(toolResult)
        });
      }
    }

    const answer = assistantMessage.trim() || '子任务没有返回可用结论。';
    return {
      ok: Boolean(assistantMessage.trim()),
      isError: !assistantMessage.trim(),
      summary: [
        `Subagent task: ${action.task}`,
        action.scope ? `Scope: ${action.scope}` : '',
        `Steps: ${stepCount}/${maxSteps}`,
        finishReason ? `Finish reason: ${finishReason}` : '',
        toolCalls.length > 0 ? `Tools: ${toolCalls.join(', ')}` : 'Tools: none',
        '',
        truncateSubagentOutput(answer)
      ]
        .filter((line) => line !== undefined)
        .join('\n')
    };
  }

  const subagentAbort = createNativeProviderStepAbort(params.abortSignal, params.provider);
  const result = streamText({
    model: createLanguageModel(params.provider),
    system: createNativeRuntimeSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildSubagentPrompt(params, action, toolNames)
      }
    ],
    tools,
    activeTools: [...toolNames],
    toolChoice: 'auto',
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens: 2048,
    abortSignal: subagentAbort.signal
  });

  let assistantMessage = '';
  let stepCount = 0;
  const toolCalls: string[] = [];

  try {
    for await (const event of result.fullStream) {
      if (event.type === 'text-delta') {
        assistantMessage += event.text;
        continue;
      }
      if (event.type === 'tool-call') {
        toolCalls.push(event.toolName);
        continue;
      }
      if (event.type === 'finish-step') {
        stepCount += 1;
        const stepUsage = normalizeAiSdkUsage(event.usage, {
          provider: params.provider?.id,
          model: params.provider?.model
        });
        if (stepUsage) {
          params.onUsage?.(stepUsage);
        }
      }
    }
  } catch (error) {
    rethrowNativeProviderStepTimeout(
      error,
      subagentAbort,
      'Native subagent provider step'
    );
  }

  let finishReason: string | undefined;
  try {
    finishReason = await result.finishReason;
  } catch {
    finishReason = undefined;
  }
  const answer = assistantMessage.trim() || '子任务没有返回可用结论。';
  return {
    ok: Boolean(assistantMessage.trim()),
    isError: !assistantMessage.trim(),
    summary: [
      `Subagent task: ${action.task}`,
      action.scope ? `Scope: ${action.scope}` : '',
      `Steps: ${stepCount}/${maxSteps}`,
      finishReason ? `Finish reason: ${finishReason}` : '',
      toolCalls.length > 0 ? `Tools: ${toolCalls.join(', ')}` : 'Tools: none',
      '',
      truncateSubagentOutput(answer)
    ]
      .filter((line) => line !== undefined)
      .join('\n')
  };
}

export async function runNativeParallelSubagents(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'run_subagents' }>
): Promise<WorkspaceToolActionResult> {
  const tasks = action.tasks.slice(0, NATIVE_PARALLEL_SUBAGENT_MAX_TASKS);
  if (tasks.length < NATIVE_PARALLEL_SUBAGENT_MIN_TASKS) {
    return {
      ok: false,
      isError: true,
      summary: `run_subagents 至少需要 ${NATIVE_PARALLEL_SUBAGENT_MIN_TASKS} 个子任务。`
    };
  }

  const maxSteps = Math.min(
    NATIVE_SUBAGENT_MAX_STEPS,
    Math.max(1, action.maxSteps ?? NATIVE_SUBAGENT_DEFAULT_MAX_STEPS)
  );
  const results = await Promise.allSettled(tasks.map((task, index) =>
    runNativeSubagent(params, {
      type: 'run_subagent',
      task: task.task,
      scope: task.scope,
      expectedOutput: task.expectedOutput,
      maxSteps
    }).then((result) => ({ index, task, result }))
  ));

  const summaries = results.map((settled, index) => {
    if (settled.status === 'rejected') {
      return [
        `## Subagent ${index + 1}: failed`,
        `Task: ${tasks[index]?.task ?? '(unknown)'}`,
        settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
      ].join('\n');
    }
    return [
      `## Subagent ${settled.value.index + 1}: ${settled.value.result.ok ? 'completed' : 'failed'}`,
      `Task: ${settled.value.task.task}`,
      settled.value.task.scope ? `Scope: ${settled.value.task.scope}` : '',
      '',
      settled.value.result.summary
    ].filter((line) => line !== '').join('\n');
  });
  const failedCount = results.filter((result) => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.result.ok)).length;

  return {
    ok: failedCount < results.length,
    isError: failedCount === results.length,
    summary: [
      `Parallel subagents: ${results.length} task(s), ${failedCount} failed.`,
      `Max steps per subagent: ${maxSteps}`,
      '',
      summaries.join('\n\n')
    ].join('\n')
  };
}

export async function startNativeBackgroundSubagent(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'subagent_start' }>
): Promise<WorkspaceToolActionResult> {
  if (!params.provider) {
    return {
      ok: false,
      isError: true,
      summary: 'Native background subagent requires a provider.'
    };
  }

  pruneBackgroundSubagentTasks();
  const maxSteps = Math.min(
    NATIVE_SUBAGENT_MAX_STEPS,
    Math.max(1, action.maxSteps ?? NATIVE_SUBAGENT_DEFAULT_MAX_STEPS)
  );
  const id = makeId('subagent');
  const taskRecord: NativeBackgroundSubagentTask = {
    id,
    projectId: params.project.id,
    sessionId: params.context.activeSessionId,
    name: action.name,
    task: action.task,
    scope: action.scope,
    expectedOutput: action.expectedOutput,
    maxSteps,
    status: 'running',
    startedAt: new Date().toISOString()
  };
  backgroundSubagentTasks.set(id, taskRecord);

  void runNativeSubagent(params, {
    type: 'run_subagent',
    task: action.task,
    scope: action.scope,
    expectedOutput: action.expectedOutput,
    maxSteps
  }).then((result) => {
    const current = backgroundSubagentTasks.get(id);
    if (!current) {
      return;
    }
    current.status = result.ok ? 'completed' : 'failed';
    current.finishedAt = new Date().toISOString();
    current.summary = result.summary;
    current.error = result.isError ? result.summary : undefined;
    void emitNativeSubagentStopHook(params, {
      toolName: 'subagent_start',
      status: current.status,
      metadata: {
        taskId: id,
        name: action.name,
        task: action.task,
        scope: action.scope,
        expectedOutput: action.expectedOutput,
        maxSteps,
        ok: result.ok,
        isError: result.isError,
        summary: result.summary
      }
    });
  }).catch((error) => {
    const current = backgroundSubagentTasks.get(id);
    if (!current) {
      return;
    }
    current.status = 'failed';
    current.finishedAt = new Date().toISOString();
    current.error = error instanceof Error ? error.message : String(error);
    current.summary = current.error;
    void emitNativeSubagentStopHook(params, {
      toolName: 'subagent_start',
      status: 'failed',
      metadata: {
        taskId: id,
        name: action.name,
        task: action.task,
        scope: action.scope,
        expectedOutput: action.expectedOutput,
        maxSteps,
        ok: false,
        isError: true,
        summary: current.error
      }
    });
  });

  return {
    ok: true,
    summary: [
      `Background subagent started: ${id}`,
      action.name ? `Name: ${action.name}` : '',
      `Task: ${action.task}`,
      action.scope ? `Scope: ${action.scope}` : '',
      `Max steps: ${maxSteps}`,
      'Use subagent_status with this taskId to read progress or the final result.'
    ].filter((line) => line !== '').join('\n')
  };
}

export async function readNativeBackgroundSubagentStatus(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'subagent_status' }>
): Promise<WorkspaceToolActionResult> {
  const formatTask = (task: NativeBackgroundSubagentTask): string => [
    `Task ID: ${task.id}`,
    task.name ? `Name: ${task.name}` : '',
    `Status: ${task.status}`,
    `Started: ${task.startedAt}`,
    task.finishedAt ? `Finished: ${task.finishedAt}` : '',
    `Task: ${task.task}`,
    task.scope ? `Scope: ${task.scope}` : '',
    task.summary ? ['', truncateSubagentOutput(task.summary)].join('\n') : ''
  ].filter((line) => line !== '').join('\n');

  if (action.taskId) {
    const task = backgroundSubagentTasks.get(action.taskId);
    if (!task || task.projectId !== params.project.id) {
      return {
        ok: false,
        isError: true,
        summary: `Background subagent not found: ${action.taskId}`
      };
    }
    return {
      ok: true,
      summary: formatTask(task)
    };
  }

  const includeCompleted = action.includeCompleted ?? true;
  const tasks = [...backgroundSubagentTasks.values()]
    .filter((task) => task.projectId === params.project.id)
    .filter((task) => task.sessionId === params.context.activeSessionId || !params.context.activeSessionId)
    .filter((task) => includeCompleted || task.status === 'running')
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 12);

  return {
    ok: true,
    summary: tasks.length
      ? tasks.map(formatTask).join('\n\n')
      : 'No background subagent tasks found for this session.'
  };
}
