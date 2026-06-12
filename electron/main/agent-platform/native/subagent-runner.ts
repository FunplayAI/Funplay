import { generateText, stepCountIs, streamText } from 'ai';
import type { AgentLifecycleHookTrigger, AiProvider } from '../../../../shared/types';
import { ensureProjectSessions } from '../../../../shared/project-sessions';
import { makeId } from '../../../../shared/utils';
import { createLanguageModel } from '../../ai-provider';
import {
  generateOpenAiCompatibleStreamingToolStep,
  type OpenAiCompatibleToolMessage
} from '../../openai-compatible-client';
import { getSubagentRun, listSubagentRuns, tryUpsertSubagentRun, type SubagentRunRecord } from '../../store';
import { runAgentLifecycleHooks } from '../agent-hooks';
import { emitRuntimeLifecycleHook, emitRuntimeUsage } from '../runtime-event-emitter';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage, normalizeOpenAiUsage } from '../usage';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from '../workspace-tools';
import {
  createNativeProviderStepAbort,
  rethrowNativeProviderStepTimeout
} from './provider-step';
import { createNativeRuntimeSystemPrompt, createNativeRuntimeUserPrompt } from './prompt';
import {
  findSubagentDefinition,
  listSubagentDefinitions,
  resolveNativeSubagentModel,
  resolveNativeSubagentToolPoolMode,
  type NativeSubagentDefinition,
  type NativeSubagentMode,
  type NativeSubagentModelResolution
} from './subagent-definitions';
import { executeNativeWorkspaceToolSetTool } from './tool-executor';
import { createNativeToolPool, enqueueNativeSubagentCompletionNotice } from './tool-pool';

const NATIVE_SUBAGENT_DEFAULT_MAX_STEPS = 32;
const NATIVE_SUBAGENT_MAX_STEPS = 200;
const NATIVE_SUBAGENT_MAX_OUTPUT_CHARS = 8000;
const NATIVE_WORKER_SUBAGENT_MAX_OUTPUT_CHARS = 16_000;
const NATIVE_PARALLEL_SUBAGENT_MIN_TASKS = 2;
const NATIVE_PARALLEL_SUBAGENT_MAX_TASKS = 4;
const NATIVE_BACKGROUND_SUBAGENT_MAX_RECORDS = 40;
const NATIVE_SUBAGENT_NOTICE_TASK_CHARS = 160;
const NATIVE_SUBAGENT_NOTICE_SUMMARY_CHARS = 400;

interface NativeBackgroundSubagentTask {
  id: string;
  projectId: string;
  sessionId?: string;
  name?: string;
  agentName?: string;
  mode?: NativeSubagentMode;
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

// Hot cache for live background runs; the durable copy lives in subagent_runs.
const backgroundSubagentTasks = new Map<string, NativeBackgroundSubagentTask>();

interface NativeSubagentRunPlan {
  mode: NativeSubagentMode;
  definition?: NativeSubagentDefinition;
  provider: AiProvider;
  modelResolution: NativeSubagentModelResolution;
  maxOutputChars: number;
}

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

function truncateSubagentOutput(value: string, maxChars = NATIVE_WORKER_SUBAGENT_MAX_OUTPUT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n\n[Subagent output truncated: exceeded ${maxChars} chars]`;
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

function resolveSubagentProjectRoot(params: GenericAgentRuntimeParams): string | undefined {
  return params.context.projectPath ?? params.context.runtimeEnvironment?.workingDirectory;
}

function buildSubagentProvider(provider: AiProvider, resolution: NativeSubagentModelResolution): AiProvider {
  if (resolution.source === 'parent') {
    return provider;
  }
  return {
    ...provider,
    model: resolution.model,
    upstreamModel: resolution.upstreamModel
  };
}

function planNativeSubagentRun(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>
): NativeSubagentRunPlan | { error: string } {
  const provider = params.provider;
  if (!provider) {
    return { error: 'Native subagent requires a provider.' };
  }
  const projectRoot = resolveSubagentProjectRoot(params);
  let definition: NativeSubagentDefinition | undefined;
  if (action.agent?.trim()) {
    definition = findSubagentDefinition(projectRoot, action.agent);
    if (!definition) {
      const available = listSubagentDefinitions(projectRoot).map((entry) => entry.name);
      return {
        error: [
          `未找到子 Agent 定义："${action.agent}"。`,
          available.length
            ? `可用定义：${available.join(', ')}`
            : '当前项目没有任何子 Agent 定义（<project>/.claude/agents/*.md 或 <project>/.funplay/agents/*.md）。'
        ].join('\n')
      };
    }
  }
  const mode: NativeSubagentMode = action.mode === 'worker' ? 'worker' : 'investigator';
  const modelResolution = resolveNativeSubagentModel(provider, action.model ?? definition?.model);
  return {
    mode,
    definition,
    provider: buildSubagentProvider(provider, modelResolution),
    modelResolution,
    maxOutputChars: mode === 'worker' ? NATIVE_WORKER_SUBAGENT_MAX_OUTPUT_CHARS : NATIVE_SUBAGENT_MAX_OUTPUT_CHARS
  };
}

function buildSubagentSystemPrompt(params: GenericAgentRuntimeParams, definition?: NativeSubagentDefinition): string {
  return [
    createNativeRuntimeSystemPrompt(params.uiLanguage),
    definition?.systemPrompt
      ? ['', `子 Agent 定义附加指令（${definition.name}）：`, definition.systemPrompt].join('\n')
      : ''
  ].filter(Boolean).join('\n');
}

function buildSubagentPrompt(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>,
  toolNames: string[],
  plan: NativeSubagentRunPlan
): string {
  const isWorker = plan.mode === 'worker';
  const ruleLines = isWorker
    ? [
        '- 你可以使用已开放的写入/命令工具直接完成任务；每次写入或命令都会经过宿主权限审批，被拒绝时不要原样重试，说明受阻原因并继续可行部分。',
        '- 文件写入会自动记录 checkpoint，与主 Agent 的写入一致。',
        '- 不要尝试再次启动子任务。',
        `- 完成后报告：做了什么改动、涉及哪些文件、如何验证；输出超过 ${plan.maxOutputChars} 字符会被截断。`
      ]
    : [
        '- 只做读取、搜索、网页获取和记忆检索，不要写文件、运行命令或调用高风险 MCP 工具。',
        '- 不要尝试再次启动子任务。',
        '- 优先返回事实、文件路径、入口点、风险或下一步建议；避免泛泛解释。',
        `- 输出必须简洁，给主 Agent 使用；超过 ${plan.maxOutputChars} 字符会被截断。`
      ];
  return [
    isWorker
      ? '你是一个子任务 Worker Agent，负责独立完成一个范围明确的任务，并把结果压缩返回给主 Agent。'
      : '你是一个只读子任务 Agent，负责独立调查一个范围明确的问题，并把结论压缩返回给主 Agent。',
    plan.definition
      ? `当前以子 Agent 定义 "${plan.definition.name}" 运行${plan.definition.description ? `：${plan.definition.description}` : '。'}`
      : '',
    plan.modelResolution.fallbackNote ?? '',
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
    isWorker ? '可用工具：' : '可用只读工具：',
    ...toolNames.map((toolName) => `- ${toolName}`),
    '',
    '规则：',
    ...ruleLines
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSubagentFinalPrompt(action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>, maxSteps: number): string {
  return [
    `子任务模型轮次预算已经到达 ${maxSteps} 轮。`,
    '现在不要再调用任何工具，只基于上面的工具结果给主 Agent 返回可用结论。',
    '如果证据不足，也要说明已经确认的事实、仍缺的证据、建议主 Agent 下一步怎么查。',
    '',
    '原始子任务：',
    action.task,
    action.scope ? `调查范围：${action.scope}` : '',
    action.expectedOutput ? `期望输出：${action.expectedOutput}` : ''
  ].filter(Boolean).join('\n');
}

function buildSubagentSummaryHeader(
  action: Extract<WorkspaceToolAction, { type: 'run_subagent' }>,
  plan: NativeSubagentRunPlan,
  stepCount: number,
  maxSteps: number,
  finishReason: string | undefined,
  toolCalls: string[]
): string[] {
  return [
    `Subagent task: ${action.task}`,
    plan.definition ? `Agent: ${plan.definition.name}` : '',
    plan.mode === 'worker' ? 'Mode: worker' : '',
    plan.modelResolution.source === 'requested' ? `Model: ${plan.modelResolution.model}` : '',
    plan.modelResolution.source === 'fallback'
      ? `Model: ${plan.modelResolution.model} (fallback from ${plan.modelResolution.requestedModel})`
      : '',
    action.scope ? `Scope: ${action.scope}` : '',
    `Steps: ${stepCount}/${maxSteps}`,
    finishReason ? `Finish reason: ${finishReason}` : '',
    toolCalls.length > 0 ? `Tools: ${toolCalls.join(', ')}` : 'Tools: none'
  ].filter((line) => line !== '');
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
      emitHook: (hook) => emitRuntimeLifecycleHook(params, hook),
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
  const plan = planNativeSubagentRun(params, action);
  if ('error' in plan) {
    return {
      ok: false,
      isError: true,
      summary: plan.error
    };
  }
  const subagentProvider = plan.provider;

  const maxSteps = Math.min(
    NATIVE_SUBAGENT_MAX_STEPS,
    Math.max(1, action.maxSteps ?? NATIVE_SUBAGENT_DEFAULT_MAX_STEPS)
  );
  // Worker pools share the parent's permission broker and checkpoint snapshot via
  // params (createNativeToolPool wires permissionContext + checkpointSnapshotId),
  // so write tools ask the user and capture checkpoints exactly like parent-loop tools.
  const toolPool = await createNativeToolPool({
    params,
    mode: resolveNativeSubagentToolPoolMode({
      mode: plan.mode,
      definition: plan.definition
    })
  });
  const toolNames = toolPool.names;
  const tools = toolPool.toolSet;
  const systemPrompt = buildSubagentSystemPrompt(params, plan.definition);

  if (subagentProvider.protocol === 'openai-compatible') {
    let messages: OpenAiCompatibleToolMessage[] = [
      {
        role: 'user',
        content: buildSubagentPrompt(params, action, toolNames, plan)
      }
    ];
    let assistantMessage = '';
    let stepCount = 0;
    let finishReason: string | undefined;
    const toolCalls: string[] = [];
    const compatibleToolDefinitions = toolPool.openAiCompatibleTools;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const stepAbort = createNativeProviderStepAbort(params.abortSignal, subagentProvider);
      let stepResult: Awaited<ReturnType<typeof generateOpenAiCompatibleStreamingToolStep>>;
      try {
        stepResult = await generateOpenAiCompatibleStreamingToolStep({
            provider: subagentProvider,
            system: systemPrompt,
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
      } finally {
        stepAbort.dispose();
      }
      stepCount += 1;
      finishReason = stepResult.finishReason;
      const stepUsage = normalizeOpenAiUsage(stepResult.usage, {
        provider: subagentProvider.id,
        model: subagentProvider.model
      });
      if (stepUsage) {
        emitRuntimeUsage(params, stepUsage);
      }
      if (stepResult.toolCalls.length === 0 && stepResult.text.trim()) {
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

    if (!assistantMessage.trim() && toolCalls.length > 0) {
      const finalAbort = createNativeProviderStepAbort(params.abortSignal, subagentProvider);
      try {
        const finalResult = await generateOpenAiCompatibleStreamingToolStep({
            provider: subagentProvider,
            system: systemPrompt,
            messages: [
              ...messages,
              {
                role: 'user',
                content: buildSubagentFinalPrompt(action, maxSteps)
              }
            ],
            tools: [],
            maxOutputTokens: 2048,
            abortSignal: finalAbort.signal
          })
          .catch((error: unknown) => rethrowNativeProviderStepTimeout(
            error,
            finalAbort,
            'Native subagent final summary provider step'
          ));
        finishReason = finalResult.finishReason ?? finishReason;
        const finalUsage = normalizeOpenAiUsage(finalResult.usage, {
          provider: subagentProvider.id,
          model: subagentProvider.model
        });
        if (finalUsage) {
          emitRuntimeUsage(params, finalUsage);
        }
        if (finalResult.text.trim()) {
          assistantMessage = finalResult.text.trim();
        }
      } finally {
        finalAbort.dispose();
      }
    }

    const answer = assistantMessage.trim() || '子任务没有返回可用结论。';
    return {
      ok: Boolean(assistantMessage.trim()),
      isError: !assistantMessage.trim(),
      summary: [
        ...buildSubagentSummaryHeader(action, plan, stepCount, maxSteps, finishReason, toolCalls),
        '',
        truncateSubagentOutput(answer, plan.maxOutputChars)
      ].join('\n')
    };
  }

  const subagentAbort = createNativeProviderStepAbort(params.abortSignal, subagentProvider);
  const result = streamText({
    model: createLanguageModel(subagentProvider),
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: buildSubagentPrompt(params, action, toolNames, plan)
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
          provider: subagentProvider.id,
          model: subagentProvider.model
        });
        if (stepUsage) {
          emitRuntimeUsage(params, stepUsage);
        }
      }
    }
  } catch (error) {
    rethrowNativeProviderStepTimeout(
      error,
      subagentAbort,
      'Native subagent provider step'
    );
  } finally {
    subagentAbort.dispose();
  }

  let finishReason: string | undefined;
  let responseMessages: Awaited<typeof result.response>['messages'] = [];
  try {
    finishReason = await result.finishReason;
  } catch {
    finishReason = undefined;
  }
  try {
    const steps = await result.steps;
    const lastStep = steps[steps.length - 1];
    assistantMessage = lastStep && lastStep.toolCalls.length === 0
      ? lastStep.text.trim()
      : '';
    responseMessages = steps.flatMap((step) => step.response.messages);
  } catch {
    assistantMessage = assistantMessage.trim();
  }

  if (!assistantMessage.trim() && responseMessages.length > 0) {
    const finalAbort = createNativeProviderStepAbort(params.abortSignal, subagentProvider);
    try {
      const finalResult = await generateText({
        model: createLanguageModel(subagentProvider),
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: buildSubagentPrompt(params, action, toolNames, plan)
          },
          ...responseMessages,
          {
            role: 'user',
            content: buildSubagentFinalPrompt(action, maxSteps)
          }
        ],
        maxOutputTokens: 2048,
        abortSignal: finalAbort.signal
      }).catch((error: unknown) => rethrowNativeProviderStepTimeout(
        error,
        finalAbort,
        'Native subagent final summary provider step'
      ));
      finishReason = finalResult.finishReason ?? finishReason;
      const finalUsage = normalizeAiSdkUsage(finalResult.usage, {
        provider: subagentProvider.id,
        model: subagentProvider.model
      });
      if (finalUsage) {
        emitRuntimeUsage(params, finalUsage);
      }
      if (finalResult.text.trim()) {
        assistantMessage = finalResult.text.trim();
      }
    } finally {
      finalAbort.dispose();
    }
  }
  const answer = assistantMessage.trim() || '子任务没有返回可用结论。';
  return {
    ok: Boolean(assistantMessage.trim()),
    isError: !assistantMessage.trim(),
    summary: [
      ...buildSubagentSummaryHeader(action, plan, stepCount, maxSteps, finishReason, toolCalls),
      '',
      truncateSubagentOutput(answer, plan.maxOutputChars)
    ].join('\n')
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
      agent: task.agent,
      mode: action.mode,
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
      settled.value.task.agent ? `Agent: ${settled.value.task.agent}` : '',
      settled.value.task.scope ? `Scope: ${settled.value.task.scope}` : '',
      '',
      settled.value.result.summary
    ].filter((line) => line !== '').join('\n');
  });
  const failedCount = results.filter((result) => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.result.ok)).length;

  return {
    ok: failedCount === 0,
    isError: failedCount > 0,
    summary: [
      `Parallel subagents: ${results.length} task(s), ${failedCount} failed.`,
      `Max turns per subagent: ${maxSteps}`,
      action.mode === 'worker' ? 'Mode: worker' : '',
      '',
      summaries.join('\n\n')
    ].filter((line) => line !== '').join('\n')
  };
}

function clipNoticeText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

function buildBackgroundSubagentCompletionNotice(
  task: NativeBackgroundSubagentTask,
  status: 'completed' | 'failed',
  summary: string
): string {
  return [
    `后台子任务已${status === 'completed' ? '完成' : '失败'}：taskId=${task.id}${task.name ? `，名称=${task.name}` : ''}${task.agentName ? `，agent=${task.agentName}` : ''}。`,
    `任务：${clipNoticeText(task.task, NATIVE_SUBAGENT_NOTICE_TASK_CHARS)}`,
    `结果摘要：${clipNoticeText(summary, NATIVE_SUBAGENT_NOTICE_SUMMARY_CHARS)}`,
    '需要完整结果时调用 subagent_status 并传入该 taskId。'
  ].join('\n');
}

function persistBackgroundSubagentTask(task: NativeBackgroundSubagentTask, status: SubagentRunRecord['status']): void {
  tryUpsertSubagentRun({
    id: task.id,
    parentSessionId: task.sessionId,
    status,
    agentName: task.agentName ?? task.name,
    prompt: task.task,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    resultSummary: task.summary
  });
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
    agentName: action.agent,
    mode: action.mode === 'worker' ? 'worker' : 'investigator',
    task: action.task,
    scope: action.scope,
    expectedOutput: action.expectedOutput,
    maxSteps,
    status: 'running',
    startedAt: new Date().toISOString()
  };
  backgroundSubagentTasks.set(id, taskRecord);
  persistBackgroundSubagentTask(taskRecord, 'running');

  void runNativeSubagent(params, {
    type: 'run_subagent',
    task: action.task,
    scope: action.scope,
    expectedOutput: action.expectedOutput,
    agent: action.agent,
    mode: action.mode,
    model: action.model,
    maxSteps
  }).then((result) => {
    const status = result.ok ? 'completed' as const : 'failed' as const;
    const current = backgroundSubagentTasks.get(id) ?? taskRecord;
    current.status = status;
    current.finishedAt = new Date().toISOString();
    current.summary = result.summary;
    current.error = result.isError ? result.summary : undefined;
    persistBackgroundSubagentTask(current, status);
    enqueueNativeSubagentCompletionNotice({
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      notice: buildBackgroundSubagentCompletionNotice(current, status, result.summary)
    });
    void emitNativeSubagentStopHook(params, {
      toolName: 'subagent_start',
      status,
      metadata: {
        taskId: id,
        name: action.name,
        agent: action.agent,
        mode: current.mode,
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
    const message = error instanceof Error ? error.message : String(error);
    const current = backgroundSubagentTasks.get(id) ?? taskRecord;
    current.status = 'failed';
    current.finishedAt = new Date().toISOString();
    current.error = message;
    current.summary = message;
    persistBackgroundSubagentTask(current, 'failed');
    enqueueNativeSubagentCompletionNotice({
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      notice: buildBackgroundSubagentCompletionNotice(current, 'failed', message)
    });
    void emitNativeSubagentStopHook(params, {
      toolName: 'subagent_start',
      status: 'failed',
      metadata: {
        taskId: id,
        name: action.name,
        agent: action.agent,
        mode: current.mode,
        task: action.task,
        scope: action.scope,
        expectedOutput: action.expectedOutput,
        maxSteps,
        ok: false,
        isError: true,
        summary: message
      }
    });
  });

  return {
    ok: true,
    summary: [
      `Background subagent started: ${id}`,
      action.name ? `Name: ${action.name}` : '',
      action.agent ? `Agent: ${action.agent}` : '',
      action.mode === 'worker' ? 'Mode: worker' : '',
      `Task: ${action.task}`,
      action.scope ? `Scope: ${action.scope}` : '',
      `Max steps: ${maxSteps}`,
      'Use subagent_status with this taskId to read progress or the final result.',
      '任务记录已持久化；完成时会在下一次工具结果中附带完成通知。'
    ].filter((line) => line !== '').join('\n')
  };
}

interface NativeSubagentStatusView {
  id: string;
  name?: string;
  agentName?: string;
  mode?: NativeSubagentMode;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  task?: string;
  scope?: string;
  summary?: string;
  persisted: boolean;
}

function toHotStatusView(task: NativeBackgroundSubagentTask): NativeSubagentStatusView {
  return {
    id: task.id,
    name: task.name,
    agentName: task.agentName,
    mode: task.mode,
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    task: task.task,
    scope: task.scope,
    summary: task.summary,
    persisted: false
  };
}

function toStoredStatusView(record: SubagentRunRecord): NativeSubagentStatusView {
  return {
    id: record.id,
    agentName: record.agentName,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    task: record.prompt,
    summary: record.resultSummary,
    persisted: true
  };
}

function formatSubagentStatusView(view: NativeSubagentStatusView): string {
  return [
    `Task ID: ${view.id}`,
    view.name ? `Name: ${view.name}` : '',
    view.agentName ? `Agent: ${view.agentName}` : '',
    view.mode === 'worker' ? 'Mode: worker' : '',
    `Status: ${view.status}`,
    view.status === 'interrupted' ? 'Note: 应用重启时该任务仍在运行，已标记为 interrupted。' : '',
    `Started: ${view.startedAt}`,
    view.finishedAt ? `Finished: ${view.finishedAt}` : '',
    view.task ? `Task: ${view.task}` : '',
    view.scope ? `Scope: ${view.scope}` : '',
    view.summary ? ['', truncateSubagentOutput(view.summary)].join('\n') : ''
  ].filter((line) => line !== '').join('\n');
}

export async function readNativeBackgroundSubagentStatus(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'subagent_status' }>
): Promise<WorkspaceToolActionResult> {
  const projectSessionIds = new Set(ensureProjectSessions(params.project).sessions.map((session) => session.id));
  const isStoredRecordVisible = (record: SubagentRunRecord): boolean =>
    Boolean(record.parentSessionId) &&
    (record.parentSessionId === params.context.activeSessionId || projectSessionIds.has(record.parentSessionId ?? ''));

  if (action.taskId) {
    const hot = backgroundSubagentTasks.get(action.taskId);
    if (hot && hot.projectId === params.project.id) {
      return {
        ok: true,
        summary: formatSubagentStatusView(toHotStatusView(hot))
      };
    }
    const stored = getSubagentRun(action.taskId);
    if (stored && isStoredRecordVisible(stored)) {
      return {
        ok: true,
        summary: formatSubagentStatusView(toStoredStatusView(stored))
      };
    }
    return {
      ok: false,
      isError: true,
      summary: `Background subagent not found: ${action.taskId}`
    };
  }

  const includeCompleted = action.includeCompleted ?? true;
  const hotViews = [...backgroundSubagentTasks.values()]
    .filter((task) => task.projectId === params.project.id)
    .filter((task) => task.sessionId === params.context.activeSessionId || !params.context.activeSessionId)
    .map(toHotStatusView);
  const hotIds = new Set(hotViews.map((view) => view.id));
  // Read-through: persisted records survive restarts (running ones are marked
  // interrupted at startup) and stay queryable after the hot cache is gone.
  const storedViews = (params.context.activeSessionId ? listSubagentRuns(params.context.activeSessionId) : [])
    .filter((record) => !hotIds.has(record.id))
    .map(toStoredStatusView);
  const views = [...hotViews, ...storedViews]
    .filter((view) => includeCompleted || view.status === 'running')
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 12);

  return {
    ok: true,
    summary: views.length
      ? views.map(formatSubagentStatusView).join('\n\n')
      : 'No background subagent tasks found for this session.'
  };
}
