import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { z } from 'zod';
import { canTransitionAgentCoreState, createAgentCoreStateMachine } from '../../../../shared/agent-core-v2';
import { createLanguageModel } from '../../ai-provider';
import { inferOpenAiCompatibleApiMode } from '../../../../shared/provider-catalog';
import { ensureProjectSessions } from '../../../../shared/project-sessions';
import type { AgentCoreProviderStepResult, AgentCoreState, AgentCoreStateMachineSnapshot, AgentLifecycleHookTrigger, AgentToolTransactionSummary, AiProvider, AiProviderApiMode, ChatContentBlock, Project, ProjectSession } from '../../../../shared/types';
import {
  generateOpenAiCompatibleStreamingToolStep,
  type OpenAiCompatibleToolCall,
  type OpenAiCompatibleToolDefinition,
  type OpenAiCompatibleToolMessage,
  type OpenAiCompatibleToolStepResult
} from '../../openai-compatible-client';
import { buildNativeToolLoopMessages } from '../model-message-builder';
import { createNativeRuntimeSystemPrompt, createNativeRuntimeUserPrompt } from './prompt';
import {
  createNativeWorkspaceTools,
  listNativeWorkspaceToolDefinitions,
  NATIVE_WRITE_WORKSPACE_TOOL_NAMES
} from './tool-adapter';
import type { NativeRuntimeToolDefinition, NativeWorkspaceToolAdapterOptions } from './tool-adapter';
import { materializeNativeMcpTools, type NativeMcpMaterializationFailure } from './mcp-tool-materializer';
import type { ConversationOperationStageEvent } from '../operation-log';
import {
  aiSdkStepToAgentCoreProviderStepResult,
  openAiCompatibleStepToAgentCoreProviderStepResult
} from '../provider-step-adapter';
import { createAgentRunController, type AgentRunControllerSnapshot } from '../agent-run-controller';
import {
  executeNativeWorkspaceToolSetTool,
  executeNativeWorkspaceToolTransaction,
  recordNativeWorkspaceToolTransactionResult,
  type NativeWorkspaceToolOutput
} from './tool-executor';
import {
  DYNAMIC_PROJECT_INSTRUCTIONS_MARKER,
  ProjectInstructionTracker
} from '../project-instruction-tracker';
import { normalizeModelReplyText } from './text';
import type { GenericAgentRuntimeParams } from '../types';
import { normalizeAiSdkUsage, normalizeOpenAiUsage } from '../usage';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from '../workspace-tools';
import { makeId } from '../../../../shared/utils';
import {
  createProviderRequestAbort,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  normalizeProviderContextWindowTokens,
  normalizeProviderMaxOutputTokens
} from '../../provider-runtime-options';
import { runAgentLifecycleHooks } from '../agent-hooks';

export interface NativeToolLoopRunResult {
  assistantMessage: string;
  finishReason?: string;
  stepCount: number;
  toolCalls: string[];
  streamedText?: boolean;
  usage?: unknown;
  coreState?: AgentCoreStateMachineSnapshot;
}

const NATIVE_SUBAGENT_DEFAULT_MAX_STEPS = 8;
const NATIVE_SUBAGENT_MAX_STEPS = 12;
const NATIVE_SUBAGENT_MAX_OUTPUT_CHARS = 8000;
const NATIVE_PARALLEL_SUBAGENT_MIN_TASKS = 2;
const NATIVE_PARALLEL_SUBAGENT_MAX_TASKS = 4;
const NATIVE_BACKGROUND_SUBAGENT_MAX_RECORDS = 40;
const NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT = 2;
const NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT = 4;
export const NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS = 32_000;
export const NATIVE_MAIN_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
export const NATIVE_SUBAGENT_PROVIDER_STEP_TIMEOUT_MS = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
const NEVER_STOP_ON_STEP_COUNT = (): false => false;

interface NativeProviderStepAbort {
  signal?: AbortSignal;
  timeoutMs: number | false;
  timedOut: () => boolean;
}

function createNativeProviderStepAbort(parentSignal: AbortSignal | undefined, provider?: AiProvider): NativeProviderStepAbort {
  const abort = createProviderRequestAbort(parentSignal, provider);
  return {
    signal: abort.signal,
    timeoutMs: abort.timeoutMs,
    timedOut: abort.timedOut
  };
}

function rethrowNativeProviderStepTimeout(error: unknown, abort: NativeProviderStepAbort, label: string): never {
  if (abort.timedOut()) {
    const seconds = abort.timeoutMs === false ? 0 : Math.round(abort.timeoutMs / 1000);
    const timeoutError = new Error(`${label} timed out after ${seconds}s.`);
    timeoutError.name = 'NativeProviderStepTimeoutError';
    timeoutError.cause = error;
    throw timeoutError;
  }
  throw error;
}

type NativeToolLoopStatePart =
  | {
      type: 'assistant_text';
      stepIndex: number;
      text: string;
      final: boolean;
    }
  | {
      type: 'tool_use';
      stepIndex: number;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      stepIndex: number;
      toolUseId: string;
      content: string;
      isError?: boolean;
    }
  | {
      type: 'continuation';
      stepIndex: number;
      reason: 'partial_write' | 'incomplete_todo' | 'edit_recovery';
      text: string;
    };

type NativeTodoItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface NativeTodoItemSnapshot {
  id?: string;
  content: string;
  status: NativeTodoItemStatus;
  priority?: 'high' | 'medium' | 'low';
}

interface NativeTodoSnapshot {
  items: NativeTodoItemSnapshot[];
  incompleteItems: NativeTodoItemSnapshot[];
  hasInProgress: boolean;
}

interface NativeToolLoopState {
  messages: OpenAiCompatibleToolMessage[];
  parts: NativeToolLoopStatePart[];
  finalText: string;
  stepCount: number;
  finishReason?: string;
  toolCalls: string[];
  streamedText: boolean;
  thinking: string;
  usage?: unknown;
  partialWriteContinuationCount: number;
  editFailureContinuationCount: number;
  incompleteTodoContinuationCount: number;
  latestTodoSnapshot?: NativeTodoSnapshot;
  completedToolResultsByUseId: Map<string, {
    name: string;
    summary: string;
    isError?: boolean;
    media?: WorkspaceToolActionResult['media'];
    changedFiles?: WorkspaceToolActionResult['changedFiles'];
    command?: WorkspaceToolActionResult['command'];
    terminal?: WorkspaceToolActionResult['terminal'];
    browser?: WorkspaceToolActionResult['browser'];
    edit?: WorkspaceToolActionResult['edit'];
    mcp?: WorkspaceToolActionResult['mcp'];
    artifacts?: WorkspaceToolActionResult['artifacts'];
  }>;
}

interface NativeOpenAiToolInvocation {
  toolCall: OpenAiCompatibleToolCall;
  toolUseId: string;
  stepIndex: number;
  started: boolean;
  completed: boolean;
}

interface NativeEditFailureRecovery {
  toolName: string;
  path?: string;
  summary: string;
  failureKind?: string;
  recoveryHint?: string;
}

function formatInterruptedToolResult(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    '[Error]',
    'Tool execution was interrupted before returning a result.',
    detail ? `Cause: ${detail}` : ''
  ].filter(Boolean).join('\n');
}

function isAbortLikeError(error: unknown, abortSignal?: AbortSignal): boolean {
  return Boolean(
    abortSignal?.aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'NativeProviderStepTimeoutError'))
  );
}

function createNativeToolLoopState(messages: OpenAiCompatibleToolMessage[]): NativeToolLoopState {
  return {
    messages,
    parts: [],
    finalText: '',
    stepCount: 0,
    toolCalls: [],
    streamedText: false,
    thinking: '',
    partialWriteContinuationCount: 0,
    editFailureContinuationCount: 0,
    incompleteTodoContinuationCount: 0,
    completedToolResultsByUseId: new Map()
  };
}

function recordNativeToolLoopAssistantText(
  state: NativeToolLoopState,
  stepIndex: number,
  text: string,
  options: {
    final: boolean;
  }
): string {
  const normalized = normalizeModelReplyText(text);
  if (!normalized.trim()) {
    return '';
  }

  state.parts.push({
    type: 'assistant_text',
    stepIndex,
    text: normalized,
    final: options.final
  });
  if (options.final) {
    state.finalText = normalized;
  }
  return normalized;
}

function appendNativeToolLoopAssistantToolMessage(
  state: NativeToolLoopState,
  stepResult: OpenAiCompatibleToolStepResult,
  options: {
    apiMode: AiProviderApiMode;
    assistantText: string;
  }
): void {
  if (options.apiMode === 'responses' && stepResult.responseOutputItems?.length) {
    state.messages.push({
      role: 'responses_output',
      items: stepResult.responseOutputItems
    });
    return;
  }

  state.messages.push({
    role: 'assistant',
    content: options.assistantText.trim() || undefined,
    reasoningContent: stepResult.reasoningContent,
    toolCalls: stepResult.toolCalls
  });
}

function createNativeToolLoopRunResult(state: NativeToolLoopState, coreState?: AgentCoreStateMachineSnapshot): NativeToolLoopRunResult {
  return {
    assistantMessage: normalizeModelReplyText(state.finalText),
    finishReason: state.finishReason,
    stepCount: state.stepCount,
    toolCalls: state.toolCalls,
    streamedText: state.streamedText,
    usage: state.usage,
    coreState
  };
}

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

function normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function containsFileReference(value: string): boolean {
  return /(?:^|[\s"'`（(：:])[\w@./\\-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt|yml|yaml|xml|svg|py|cs|java|go|rs|sh|sql|vue|svelte)(?:$|[\s"'`，,。.!！?？）)；;:：])/i.test(value);
}

function looksLikeUnfinishedWriteReply(value: string): boolean {
  const normalized = value.trim();
  if (!containsFileReference(normalized)) {
    return false;
  }
  return /(现在|接下来|继续|马上|下一步|最后|再来|还要|还需要|开始)(?:[\s\S]{0,40})(写|创建|生成|实现|补上)|(?:now|next|then|continue|will|going to)(?:[\s\S]{0,40})(write|create|implement|add)/i.test(normalized);
}

function shouldContinueAfterPartialWriteReply(input: {
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  assistantMessage: string;
}): boolean {
  if (!input.includeWriteTools || input.permissionMode === 'read-only') {
    return false;
  }
  return looksLikeUnfinishedWriteReply(input.assistantMessage);
}

function createPartialWriteContinuationPrompt(assistantMessage: string): string {
  return [
    '你的上一条回复看起来还在执行多文件写入任务，而不是最终答复：',
    assistantMessage,
    '',
    '如果还有文件要创建或修改，请继续调用协议级工具（write_file、edit_file、multi_edit、patch_file 或 create_directory）完成剩余文件。',
    '不要只在正文里说“现在写/接下来写”；只有确认全部请求的文件都已经通过工具写入后，才能给最终答复。'
  ].join('\n');
}

function isEditRecoveryToolName(toolName: string): boolean {
  return toolName === 'edit_file' || toolName === 'multi_edit' || toolName === 'patch_file';
}

function formatEditRecoveryPath(input: Record<string, unknown>): string | undefined {
  return typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
}

function collectEditFailureRecovery(toolCall: OpenAiCompatibleToolCall, toolResult: NativeWorkspaceToolOutput): NativeEditFailureRecovery | undefined {
  if (!toolResult.isError || !isEditRecoveryToolName(toolCall.name) || !toolResult.edit || toolResult.edit.preflight !== 'failed') {
    return undefined;
  }
  return {
    toolName: toolCall.name,
    path: formatEditRecoveryPath(toolCall.arguments),
    summary: toolResult.summary ?? '编辑工具失败。',
    failureKind: toolResult.edit.failureKind,
    recoveryHint: toolResult.edit.recoveryHint
  };
}

function createInvalidMultiEditInputResult(toolCall: OpenAiCompatibleToolCall): NativeWorkspaceToolOutput | undefined {
  if (toolCall.name !== 'multi_edit') {
    return undefined;
  }
  const edits = toolCall.arguments.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    return undefined;
  }
  return {
    ok: false,
    isError: true,
    summary: [
      'multi_edit 参数无效：edits 至少需要 1 个编辑操作，未执行真实写入。',
      '恢复方式：先用 read_file 读取目标片段，再用 edit_file/multi_edit 提供逐字匹配的 oldText；如果 oldText 不确定，改用 preview_patch/patch_file。'
    ].join('\n'),
    edit: {
      strategy: 'multi_edit',
      patchFirst: false,
      preflight: 'failed',
      editCount: Array.isArray(edits) ? edits.length : 0,
      failureKind: 'unknown',
      recoveryHint: '不要调用空 edits 的 multi_edit；读取目标片段后构造至少 1 个精确编辑，或改用 unified patch。'
    }
  };
}

function createEditFailureRecoveryPrompt(recoveries: NativeEditFailureRecovery[]): string {
  const lines = recoveries.slice(0, 6).map((recovery, index) => {
    const path = recovery.path ? ` ${recovery.path}` : '';
    const failureKind = recovery.failureKind ? ` (${recovery.failureKind})` : '';
    const hint = recovery.recoveryHint ? `；建议：${recovery.recoveryHint}` : '';
    return `${index + 1}. ${recovery.toolName}${path}${failureKind}: ${truncateToolArgumentPreview(recovery.summary, 500)}${hint}`;
  });
  const paths = [...new Set(recoveries.map((recovery) => recovery.path).filter((path): path is string => Boolean(path)))];
  return [
    '上一轮文件编辑工具失败，失败的工具没有修改项目文件。下一步必须按恢复流程继续，不要把失败当成功。',
    '',
    '失败详情：',
    ...lines,
    '',
    '恢复规则：',
    paths.length
      ? `- 先重新读取失败文件的最新相关片段：${paths.map((path) => `read_file ${path}`).join('；')}。`
      : '- 先用 read_file 重新读取失败文件的最新相关片段。',
    '- 不要复用刚才失败的 oldText；新的 oldText 必须从最新 read_file 输出中逐字复制，并且能唯一匹配。',
    '- 如果目标变更跨多处、上下文不确定，优先使用 preview_patch 预检 unified diff，再用 patch_file 应用。',
    '- 不要调用 edits 为空的 multi_edit；multi_edit 至少需要 1 个有效编辑操作。',
    '- 修复后继续完成用户原始任务，并在最终答复里只总结实际成功写入的内容。'
  ].join('\n');
}

function normalizeTodoStatus(value: unknown): NativeTodoItemStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled' ? value : undefined;
}

function normalizeTodoPriority(value: unknown): NativeTodoItemSnapshot['priority'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

function createTodoSnapshot(items: NativeTodoItemSnapshot[]): NativeTodoSnapshot | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const incompleteItems = items.filter((item) => item.status === 'pending' || item.status === 'in_progress');
  return {
    items,
    incompleteItems,
    hasInProgress: incompleteItems.some((item) => item.status === 'in_progress')
  };
}

function parseTodoInputAlias(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function resolveTodoInputItems(input: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!input) {
    return undefined;
  }
  const candidates = [
    input.items,
    parseTodoInputAlias(input.todos)
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.items)) {
        return record.items;
      }
      if (Array.isArray(record.todos)) {
        return record.todos;
      }
    }
  }
  return undefined;
}

function parseTodoSnapshotFromInput(input: Record<string, unknown> | undefined): NativeTodoSnapshot | undefined {
  const rawItems = resolveTodoInputItems(input);
  if (!rawItems) {
    return undefined;
  }
  const items = rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item): NativeTodoItemSnapshot | undefined => {
      const status = normalizeTodoStatus(item.status);
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!status || !content) {
        return undefined;
      }
      return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
        content,
        status,
        priority: normalizeTodoPriority(item.priority)
      };
    })
    .filter((item): item is NativeTodoItemSnapshot => Boolean(item));
  return createTodoSnapshot(items);
}

function parseTodoSnapshotFromSummary(summary: string): NativeTodoSnapshot | undefined {
  const items = summary
    .split('\n')
    .map((line): NativeTodoItemSnapshot | undefined => {
      const match = line.match(/^-\s+\[(pending|in_progress|completed|cancelled)]\s+(.+?)(?:\s+\((high|medium|low)\))?:\s+(.+)$/);
      if (!match) {
        return undefined;
      }
      return {
        id: match[2]?.trim() || undefined,
        content: match[4]?.trim() || '',
        status: match[1] as NativeTodoItemStatus,
        priority: normalizeTodoPriority(match[3])
      };
    })
    .filter((item): item is NativeTodoItemSnapshot => Boolean(item?.content));
  return createTodoSnapshot(items);
}

function resolveTodoSnapshotFromToolResult(input: {
  toolName: string;
  toolInput?: Record<string, unknown>;
  summary: string;
  isError?: boolean;
}): NativeTodoSnapshot | undefined {
  if (input.toolName !== 'update_todo_list' || input.isError) {
    return undefined;
  }
  return parseTodoSnapshotFromInput(input.toolInput) ?? parseTodoSnapshotFromSummary(input.summary);
}

function selectNativeToolLoopSession(project: Project, sessionId?: string): ProjectSession | undefined {
  const ensured = ensureProjectSessions(project);
  return sessionId
    ? ensured.sessions.find((session) => session.id === sessionId)
    : ensured.sessions.find((session) => session.id === ensured.activeSessionId) ?? ensured.sessions[0];
}

function resolveLatestTodoSnapshotFromBlocks(blocks: ChatContentBlock[] | undefined): NativeTodoSnapshot | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const toolInputs = new Map<string, {
    name: string;
    input?: Record<string, unknown>;
  }>();
  let latestSnapshot: NativeTodoSnapshot | undefined;
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolInputs.set(block.toolUseId, {
        name: block.name,
        input: normalizeToolInput(block.input)
      });
      continue;
    }
    if (block.type !== 'tool_result') {
      continue;
    }
    const toolUse = toolInputs.get(block.toolUseId);
    const snapshot = resolveTodoSnapshotFromToolResult({
      toolName: toolUse?.name ?? '',
      toolInput: toolUse?.input,
      summary: block.content,
      isError: block.isError
    });
    if (snapshot) {
      latestSnapshot = snapshot;
    }
  }
  return latestSnapshot;
}

function resolveLatestTodoSnapshotFromHistory(params: Pick<GenericAgentRuntimeParams, 'project' | 'context'>): NativeTodoSnapshot | undefined {
  const session = selectNativeToolLoopSession(params.project, params.context.activeSessionId);
  const chat = session?.chat ?? [];
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const snapshot = resolveLatestTodoSnapshotFromBlocks(chat[index]?.contentBlocks);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

function resolveNativeMainToolLoopMaxOutputTokens(provider?: AiProvider): number {
  const configured = Number(process.env.FUNPLAY_NATIVE_MAIN_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const providerConfigured = normalizeProviderMaxOutputTokens(provider?.maxOutputTokens);
  if (providerConfigured) {
    return providerConfigured;
  }
  const modelCapabilities = provider?.availableModels?.find(
    (model) =>
      model.modelId === provider.model ||
      model.upstreamModelId === provider.model ||
      model.upstreamModelId === provider.upstreamModel
  )?.capabilities;
  const modelMaxOutputTokens = normalizeProviderMaxOutputTokens(modelCapabilities?.maxOutputTokens);
  if (modelMaxOutputTokens) {
    return modelMaxOutputTokens;
  }
  const providerContextWindow = normalizeProviderContextWindowTokens(provider?.contextWindowTokens);
  if (providerContextWindow) {
    return Math.max(4096, Math.min(NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS, Math.floor(providerContextWindow / 4)));
  }
  const contextWindow = normalizeProviderContextWindowTokens(modelCapabilities?.contextWindow);
  if (contextWindow && contextWindow < 96_000) {
    return Math.max(4096, Math.min(NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4)));
  }
  return NATIVE_MAIN_TOOL_LOOP_MAX_OUTPUT_TOKENS;
}

function shouldContinueAfterIncompleteTodo(input: {
  includeWriteTools: boolean;
  permissionMode: GenericAgentRuntimeParams['permission']['mode'];
  latestTodoSnapshot?: NativeTodoSnapshot;
  assistantMessage: string;
}): boolean {
  if (!input.includeWriteTools || input.permissionMode === 'read-only') {
    return false;
  }
  const incompleteItems = input.latestTodoSnapshot?.incompleteItems ?? [];
  if (incompleteItems.length === 0) {
    return false;
  }
  if (!input.assistantMessage.trim()) {
    return true;
  }
  if (input.latestTodoSnapshot?.hasInProgress) {
    return true;
  }
  return looksLikeUnfinishedWriteReply(input.assistantMessage) || /还没|未完成|继续|马上|下一步|pending|in_progress|not done|continue|next/i.test(input.assistantMessage);
}

function createIncompleteTodoContinuationPrompt(snapshot: NativeTodoSnapshot, assistantMessage: string): string {
  const incomplete = snapshot.incompleteItems.slice(0, 10).map((item, index) => {
    const id = item.id ?? String(index + 1);
    return `- [${item.status}] ${id}: ${item.content}`;
  });
  return [
    '你的上一轮工具状态显示任务清单还没有完成，但你已经结束了回复：',
    assistantMessage.trim() || '<empty assistant reply>',
    '',
    '未完成项：',
    ...incomplete,
    '',
    '请继续调用协议级工具完成这些 in_progress/pending 项，并在每个关键步骤后更新 update_todo_list。',
    '如果需要创建或修改文件，下一步必须调用 write_file、edit_file、multi_edit、patch_file 或 create_directory；不要在正文里输出完整源码来代替工具调用。',
    '只有全部必要项都完成后，才能给用户最终答复；如果确实需要用户选择或外部信息，请调用 ask_user。'
  ].join('\n');
}

function isLengthLimitedFinishReason(finishReason?: string): boolean {
  return /^(length|max_tokens|max_output_tokens)$/i.test(finishReason?.trim() ?? '');
}

function createLengthContinuationPrompt(assistantMessage: string): string {
  return [
    '上一轮模型输出因为长度限制被截断，任务不能在这里结束。',
    assistantMessage.trim() ? '继续上一轮未完成的位置，不要重复已经完成的说明。' : '上一轮没有返回可显示文本，请继续推进任务。',
    '如果仍有未完成改动，必须继续调用工具完成；只有确认任务完成后，才用简短最终回复收尾。'
  ].join('\n');
}

function isDynamicInstructionMessage(message: ModelMessage): boolean {
  return message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(DYNAMIC_PROJECT_INSTRUCTIONS_MARKER);
}

function withDynamicInstructionMessage(messages: ModelMessage[], content: string): ModelMessage[] {
  return [
    ...messages.filter((message) => !isDynamicInstructionMessage(message)),
    {
      role: 'user',
      content
    }
  ];
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

async function requestUserInputFromTool(
  params: GenericAgentRuntimeParams,
  action: Extract<WorkspaceToolAction, { type: 'ask_user' }>
): Promise<WorkspaceToolActionResult> {
  if (!params.requestUserInput) {
    return {
      ok: false,
      isError: true,
      summary: '当前运行环境不支持向用户提问。'
    };
  }

  const response = await params.requestUserInput({
    title: action.title,
    question: action.question,
    detail: action.detail,
    options: action.options?.map((option, index) => ({
      id: option.id || `option_${index + 1}`,
      label: option.label,
      description: option.description
    })),
    multiSelect: action.multiSelect,
    allowFreeText: action.allowFreeText ?? true,
    placeholder: action.placeholder,
    toolName: 'ask_user'
  });

  if (response.cancelled) {
    return {
      ok: false,
      isError: true,
      summary: '用户没有回答这个问题，当前请求已取消或超时。'
    };
  }

  return {
    ok: true,
    summary: [
      'User answered the question.',
      response.optionIds?.length ? `Selected options: ${response.optionIds.join(', ')}` : '',
      response.optionId ? `Selected option: ${response.optionId}` : '',
      `Answer: ${response.answer}`
    ].filter(Boolean).join('\n')
  };
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

async function runNativeSubagent(
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
  const subagentToolOptions: Pick<NativeWorkspaceToolAdapterOptions, 'includeWriteTools' | 'includeMcpToolCalls' | 'includeCommandTools' | 'excludeTools'> = {
    includeWriteTools: false,
    includeMcpToolCalls: false,
    includeCommandTools: false,
    excludeTools: ['ask_user', 'run_subagent', 'run_subagents', 'subagent_start', 'subagent_status']
  };
  const toolDefinitions = listNativeWorkspaceToolDefinitions({
    project: params.project,
    ...subagentToolOptions
  });
  const toolNames = toolDefinitions.map((definition) => definition.name);
  const tools = createNativeWorkspaceTools({
    project: params.project,
    plugins: params.plugins,
    checkpointSnapshotId: params.checkpointSnapshotId,
    abortSignal: params.abortSignal,
    ...subagentToolOptions,
    permissionContext: {
      permission: params.permission,
      requestPermission: params.requestPermission
    },
    lifecycleHooks: params.lifecycleHooks,
    lifecycleHookContext: {
      runId: params.activeRunId,
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath
    },
    onLifecycleHook: params.onLifecycleHook
  });

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
    const compatibleToolDefinitions = toOpenAiCompatibleToolDefinitions(toolDefinitions);

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

async function runNativeParallelSubagents(
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

async function startNativeBackgroundSubagent(
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

async function readNativeBackgroundSubagentStatus(
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

export function createNativeToolLoopPermissionInstructions(params: Pick<GenericAgentRuntimeParams, 'permission'>, options: {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
}): string[] {
  const hasSideEffectTools = options.includeWriteTools || options.includeMcpToolCalls || options.includeCommandTools;

  const modeLine =
    hasSideEffectTools
      ? params.permission.mode === 'read-only'
        ? '当前界面模式：Plan。工具列表由 host 生成，实际权限只在工具执行点判定。'
        : '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。'
      : params.permission.mode === 'read-only'
        ? '当前界面模式：Plan。工具列表由 host 生成，实际权限只在工具执行点判定。'
        : params.permission.mode === 'ask'
          ? '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。'
          : '当前界面模式：Build。工具列表由 host 生成，实际权限只在工具执行点判定。';

  const writeLine = options.includeWriteTools
    ? 'create_directory、write_file、edit_file、multi_edit、patch_file 等项目写入工具出现在工具列表中；当用户任务需要实际修改项目时应调用对应工具，host 会在执行点完成权限、checkpoint 和拒绝处理。不要根据模式自行声称工具被禁用。'
    : params.permission.mode === 'read-only'
      ? options.includeCommandTools
        ? 'create_directory、write_file、edit_file、multi_edit、patch_file 等项目写入工具未出现在工具列表中；不要声称已经写入文件。run_command、terminal_start 等命令工具可用于检查和验证，host 会在执行点完成权限判断。'
        : '项目写入工具未出现在工具列表中；不要声称已经写入文件。'
      : params.permission.mode === 'ask'
        ? '当前工具列表不包含项目写入工具；不要声称已经写入文件。'
        : '当前工具列表不包含项目写入工具；不要声称已经写入文件。';

  return [modeLine, writeLine];
}

function createNativeToolLoopPrompt(params: GenericAgentRuntimeParams, toolNames: string[], options: {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  dynamicMcpToolNames?: string[];
}): string {
  return [
    createNativeRuntimeUserPrompt(params, undefined, {
      includeRecentTurns: false
    }),
    '',
    ...createNativeToolLoopPermissionInstructions(params, options),
    '你可以使用这些工具来理解项目：',
    ...toolNames.map((toolName) => `- ${toolName}`),
    '',
    '规则：',
    '- 对多步骤任务，使用 update_todo_list 维护简短任务清单；优先传 todos 数组，可用 pending/in_progress/completed/cancelled 状态，并在关键步骤完成时更新状态。',
    '- 如果缺少继续执行所必需的用户偏好、业务选择或冲突决策，可调用 ask_user 向用户提一个简短明确的问题；不要用 ask_user 做工具权限确认，也不要询问可以通过读取项目或搜索自行确定的信息。',
    '- 当用户目标涉及游戏、可玩页面、资源目录、Unity、素材或玩法验证时，优先调用 inspect_game_project 识别 Web/Unity 结构、资源工作流和验证路径。',
    '- 对范围明确、可独立调查的问题，可调用 run_subagent；如果有 2-4 个互不重叠的调查方向，优先 run_subagents 并行收集证据；较长的旁路调查可用 subagent_start 后用 subagent_status 读取结果；不要把用户的主任务整体转交给子任务。',
    '- 写入项目记忆时用 funplay_memory_remember，并设置 memoryKind：用户偏好 user_preference、稳定项目事实 project_fact、已确认决策 decision、临时任务状态 task_state。',
    options.includeWriteTools
      ? '- 用户任务需要创建目录、创建文件、修改文件或回滚文件时，调用 create_directory、write_file、edit_file、multi_edit、patch_file 或 checkpoint_rollback；host 会在工具执行点处理权限、checkpoint、拒绝和错误回放。同一文件多处修改优先用 multi_edit；能构造 unified diff 时可先 preview_patch 再 patch_file；完整重写前可用 preview_file_diff 检查变更范围；需要汇总本轮文件变更时用 checkpoint_diff。'
      : params.permission.mode === 'read-only'
        ? '- 当前工具列表不包含项目写入工具；如用户要求实现或修改文件，不要伪造写入，可给计划、方案或建议切换到 Build。'
        : '- 当前工具列表只包含只读工具；不要声称已经写入文件。',
    options.includeWriteTools
      ? '- 调用 edit_file/multi_edit 时，oldText 必须逐字来自最近 read_file 输出并且唯一匹配；如果编辑失败、上下文不确定或需要多处结构性修改，先 read_file，再优先 preview_patch + patch_file。不要调用 edits 为空的 multi_edit。'
      : '',
    options.includeMcpToolCalls
      ? options.dynamicMcpToolNames?.length
        ? '- MCP Server tools 已按 Claude 风格直接暴露为 mcp__server__tool 工具；优先直接调用这些 mcp__ 工具并按其 schema 传参。list_mcp_tools/list_mcp_resources 用于重新发现或排查，call_mcp_tool 仅作动态工具缺失时的备用入口。'
        : '- 需要使用 MCP 时，先用 list_mcp_tools 或 list_mcp_resources 发现当前项目启用的 MCP 能力；确认 toolName/inputSchema 后再调用 call_mcp_tool，确认 uri 后再调用 read_mcp_resource。host 会在 MCP 工具执行点处理权限、拒绝和错误回放。'
      : '- 不要调用 MCP 写入工具；如需 Unity 状态，先用 list_mcp_resources 发现可读资源，再 read_mcp_resource。',
    '- 查网页资料时可用 web_search/web_fetch；技术资料优先设置 preferOfficial=true，用户指定站点时使用 domains 过滤。',
    options.includeCommandTools
      ? params.permission.mode === 'read-only'
        ? '- 为了只读检查、测试、构建诊断或验证页面而确实需要时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务，持续任务必须用 terminal_start。'
        : '- 用户任务需要运行测试、构建、诊断命令、持久 dev server 或浏览器验证时，可调用 run_command、terminal_start/terminal_write/terminal_stop 或 browser_open/browser_navigate/browser_click/browser_type/browser_close；host 会在执行点处理权限、拒绝和错误回放；run_command 只能执行会自行结束的命令，不能使用 & 启动后台任务；持续任务必须用 terminal_start，然后用 terminal_read 观察日志；网页验证优先 browser_open 后用 browser_snapshot/browser_screenshot/browser_console。'
      : '- 不要运行 shell 命令。',
    '- 需要使用工具时必须返回协议级 tool_calls/function calls；不要把工具调用写成 `[Tool] name {...}`、JSON 代码块或普通正文。',
    '- 如果问题已经能回答，就直接结束并给用户最终答复。',
    '- 如果需要引用文件或目录，优先给出项目内相对路径。',
    '- 回答面向小白用户，直接、清楚、可执行。'
  ].join('\n');
}

function summarizeMcpMaterializationFailures(failures: NativeMcpMaterializationFailure[]): string {
  return failures
    .slice(0, 6)
    .map((failure) => `${failure.pluginName}: ${failure.message}`)
    .join('；');
}

function diffNativeRuntimeToolNames(previous: NativeRuntimeToolDefinition[], next: NativeRuntimeToolDefinition[]): {
  added: string[];
  removed: string[];
} {
  const previousNames = new Set(previous.map((definition) => definition.name));
  const nextNames = new Set(next.map((definition) => definition.name));
  return {
    added: [...nextNames].filter((name) => !previousNames.has(name)),
    removed: [...previousNames].filter((name) => !nextNames.has(name))
  };
}

async function prepareNativeDynamicMcpTools(params: GenericAgentRuntimeParams, includeMcpToolCalls: boolean, emitStage?: (stage: ConversationOperationStageEvent) => void): Promise<NativeRuntimeToolDefinition[]> {
  if (!includeMcpToolCalls) {
    return [];
  }

  const enabledPlugins = (params.plugins ?? []).filter((plugin) =>
    plugin.enabled && (plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl.trim()))
  );
  if (enabledPlugins.length === 0) {
    return [];
  }

  emitStage?.({
    stageId: 'stage:native_mcp_tool_materialization',
    title: '发现 MCP 工具',
    target: 'stage:native_mcp_tool_materialization',
    status: 'running',
    summary: `正在从 ${enabledPlugins.length} 个 MCP Server 读取 tools/list。`
  });

  const result = await materializeNativeMcpTools({
    plugins: enabledPlugins,
    abortSignal: params.abortSignal
  });
  params.abortSignal?.throwIfAborted();

  emitStage?.({
    stageId: 'stage:native_mcp_tool_materialization',
    title: '发现 MCP 工具',
    target: 'stage:native_mcp_tool_materialization',
    status: result.failures.length > 0 && result.tools.length === 0 ? 'failed' : 'completed',
    summary: [
      result.tools.length > 0 ? `已物化 ${result.tools.length} 个 Claude-style MCP 工具。` : '没有发现可物化的 MCP 工具。',
      result.failures.length > 0 ? `失败：${summarizeMcpMaterializationFailures(result.failures)}` : ''
    ].filter(Boolean).join(' '),
    input: {
      tools: result.tools.map((toolDefinition) => toolDefinition.name),
      failures: result.failures
    }
  });

  return result.tools;
}

async function refreshNativeDynamicMcpToolsBetweenTurns(input: {
  params: GenericAgentRuntimeParams;
  includeMcpToolCalls: boolean;
  previousTools: NativeRuntimeToolDefinition[];
  stepIndex: number;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
}): Promise<NativeRuntimeToolDefinition[]> {
  if (!input.includeMcpToolCalls || input.stepIndex === 0 || input.previousTools.length === 0 && (input.params.plugins ?? []).length === 0) {
    return input.previousTools;
  }

  const nextTools = await prepareNativeDynamicMcpTools(input.params, input.includeMcpToolCalls);
  const diff = diffNativeRuntimeToolNames(input.previousTools, nextTools);
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return input.previousTools;
  }

  input.emitStage?.({
    stageId: 'stage:native_mcp_tool_refresh',
    title: '刷新 MCP 工具',
    target: 'stage:native_mcp_tool_refresh',
    status: 'completed',
    summary: [
      diff.added.length > 0 ? `新增 ${diff.added.join(', ')}` : '',
      diff.removed.length > 0 ? `移除 ${diff.removed.join(', ')}` : ''
    ].filter(Boolean).join('；') || 'MCP 工具集合未变化。',
    input: {
      step: input.stepIndex,
      added: diff.added,
      removed: diff.removed,
      tools: nextTools.map((definition) => definition.name)
    }
  });

  return nextTools;
}

function toOpenAiCompatibleToolParameters(definition: NativeRuntimeToolDefinition): Record<string, unknown> {
  if (definition.inputJsonSchema) {
    const schema = { ...definition.inputJsonSchema };
    delete schema.$schema;
    return schema;
  }
  const schema = z.toJSONSchema(definition.inputSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function toOpenAiCompatibleToolDefinitions(definitions: NativeRuntimeToolDefinition[]): OpenAiCompatibleToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: toOpenAiCompatibleToolParameters(definition)
  }));
}

function collectTextFromModelContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function safeStringifyOpenAiCompatibleValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectHistoricToolResultText(content: ModelMessage['content']): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'tool-result') {
        return '';
      }
      const output =
        'output' in part && part.output && typeof part.output === 'object' && 'value' in part.output && typeof part.output.value === 'string'
          ? part.output.value
          : 'output' in part
            ? safeStringifyOpenAiCompatibleValue(part.output)
            : '';
      return output.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function convertModelMessagesToOpenAiCompatible(messages: ModelMessage[], options: {
  preserveToolMessages?: boolean;
} = {}): OpenAiCompatibleToolMessage[] {
  const preserveToolMessages = options.preserveToolMessages ?? true;
  const converted: OpenAiCompatibleToolMessage[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content = collectTextFromModelContent(message.content);
      if (content.trim()) {
        converted.push({
          role: 'user',
          content
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (!preserveToolMessages) {
        const content = collectTextFromModelContent(message.content);
        if (content.trim()) {
          converted.push({
            role: 'assistant',
            content
          });
        }
        continue;
      }

      const toolCalls: OpenAiCompatibleToolCall[] = [];
      let text = '';
      let reasoningContent = '';
      if (typeof message.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        text = message.content
          .map((part) => {
            if (!part || typeof part !== 'object') {
              return '';
            }
            if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
              return part.text;
            }
            if ('type' in part && part.type === 'reasoning' && 'text' in part && typeof part.text === 'string') {
              reasoningContent = [reasoningContent, part.text].filter(Boolean).join('\n\n');
              return '';
            }
            if ('type' in part && part.type === 'tool-call') {
              const input = 'input' in part && normalizeToolInput(part.input) ? normalizeToolInput(part.input) : {};
              toolCalls.push({
                id: typeof part.toolCallId === 'string' ? part.toolCallId : makeId('tool'),
                name: typeof part.toolName === 'string' ? part.toolName : 'unknown_tool',
                arguments: input ?? {}
              });
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
      }
      if (text.trim() || reasoningContent.trim() || toolCalls.length > 0) {
        converted.push({
          role: 'assistant',
          content: text.trim() || undefined,
          reasoningContent: reasoningContent.trim() || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        });
      }
      continue;
    }

    if (message.role === 'tool' && !preserveToolMessages) {
      const content = collectHistoricToolResultText(message.content);
      if (content.trim()) {
        converted.push({
          role: 'user',
          content: `历史工具结果上下文，仅用于继续任务，不要逐字复述：\n${content}`
        });
      }
      continue;
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const toolCallId = 'toolCallId' in part && typeof part.toolCallId === 'string' ? part.toolCallId : '';
        if (!toolCallId) {
          continue;
        }
        const output = 'output' in part && part.output && typeof part.output === 'object' ? part.output : undefined;
        const content =
          output && 'value' in output && typeof output.value === 'string'
            ? output.value
            : 'output' in part && typeof part.output === 'string'
              ? part.output
              : '';
        converted.push({
          role: 'tool',
          toolCallId,
          name: 'toolName' in part && typeof part.toolName === 'string' ? part.toolName : undefined,
          content
        });
      }
    }
  }

  return converted;
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

function truncateToolArgumentPreview(value: string, maxLength = 1200): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeToolOutputForStream(output: unknown): {
  summary: string;
  isError?: boolean;
  media?: WorkspaceToolActionResult['media'];
  changedFiles?: WorkspaceToolActionResult['changedFiles'];
  command?: WorkspaceToolActionResult['command'];
  terminal?: WorkspaceToolActionResult['terminal'];
  browser?: WorkspaceToolActionResult['browser'];
  edit?: WorkspaceToolActionResult['edit'];
  mcp?: WorkspaceToolActionResult['mcp'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
} {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as {
      summary?: unknown;
      isError?: unknown;
      media?: unknown;
      changedFiles?: unknown;
      command?: unknown;
      terminal?: unknown;
      browser?: unknown;
      edit?: unknown;
      mcp?: unknown;
      artifacts?: unknown;
    };
    return {
      summary: typeof record.summary === 'string' ? record.summary : stringifyToolOutput(output),
      isError: typeof record.isError === 'boolean' ? record.isError : undefined,
      media: Array.isArray(record.media) ? record.media as WorkspaceToolActionResult['media'] : undefined,
      changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles as WorkspaceToolActionResult['changedFiles'] : undefined,
      command: record.command && typeof record.command === 'object' && !Array.isArray(record.command) ? record.command as WorkspaceToolActionResult['command'] : undefined,
      terminal: record.terminal && typeof record.terminal === 'object' && !Array.isArray(record.terminal) ? record.terminal as WorkspaceToolActionResult['terminal'] : undefined,
      browser: record.browser && typeof record.browser === 'object' && !Array.isArray(record.browser) ? record.browser as WorkspaceToolActionResult['browser'] : undefined,
      edit: record.edit && typeof record.edit === 'object' && !Array.isArray(record.edit) ? record.edit as WorkspaceToolActionResult['edit'] : undefined,
      mcp: record.mcp && typeof record.mcp === 'object' && !Array.isArray(record.mcp) ? record.mcp as WorkspaceToolActionResult['mcp'] : undefined,
      artifacts: Array.isArray(record.artifacts) ? record.artifacts as WorkspaceToolActionResult['artifacts'] : undefined
    };
  }

  return {
    summary: stringifyToolOutput(output)
  };
}

export async function runOpenAiCompatibleNativeToolLoop(params: GenericAgentRuntimeParams, callbacks?: {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
  emitThinking?: (delta: string, accumulated: string) => void;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
}): Promise<NativeToolLoopRunResult> {
  if (!params.provider || params.provider.protocol !== 'openai-compatible') {
    throw new Error('OpenAI-compatible tool loop requires an OpenAI-compatible provider.');
  }

  const includeWriteTools = Boolean(callbacks?.includeWriteTools);
  const includeMcpToolCalls = Boolean(callbacks?.includeMcpToolCalls);
  const includeCommandTools = Boolean(callbacks?.includeCommandTools);
  let dynamicMcpTools = await prepareNativeDynamicMcpTools(params, includeMcpToolCalls, callbacks?.emitStage);
  let toolDefinitions = listNativeWorkspaceToolDefinitions({
    project: params.project,
    includeWriteTools,
    includeMcpToolCalls,
    includeCommandTools,
    dynamicTools: dynamicMcpTools
  });
  let toolNames = toolDefinitions.map((definition) => definition.name);
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: '准备兼容 Tool Schema',
    target: 'stage:native_tool_schema',
    status: 'running',
    summary: `正在初始化 ${toolNames.length} 个 OpenAI-compatible 工作区工具。`
  });
  const createToolSet = () => createNativeWorkspaceTools({
    project: params.project,
    plugins: params.plugins,
    checkpointSnapshotId: params.checkpointSnapshotId,
    abortSignal: params.abortSignal,
    includeWriteTools,
    includeMcpToolCalls,
    includeCommandTools,
    dynamicTools: dynamicMcpTools,
    permissionContext: {
      permission: params.permission,
      requestPermission: params.requestPermission
    },
    lifecycleHooks: params.lifecycleHooks,
    lifecycleHookContext: {
      runId: params.activeRunId,
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath
    },
    onLifecycleHook: params.onLifecycleHook,
    emitLifecycleHookStage: callbacks?.emitStage,
    requestUserInput: (action) => requestUserInputFromTool(params, action),
    requestMcpUserInput: params.requestUserInput,
    runSubagent: (action) => runNativeSubagent(params, action),
    runSubagents: (action) => runNativeParallelSubagents(params, action),
    startSubagent: (action) => startNativeBackgroundSubagent(params, action),
    readSubagentStatus: (action) => readNativeBackgroundSubagentStatus(params, action)
  });
  let tools = createToolSet();
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: '准备兼容 Tool Schema',
    target: 'stage:native_tool_schema',
    status: 'completed',
    summary: `已注册 ${toolNames.length} 个 OpenAI-compatible 工作区工具。`,
    input: {
      tools: [...toolNames],
      includeWriteTools,
      includeMcpToolCalls,
      includeCommandTools,
      dynamicMcpToolCount: dynamicMcpTools.length
    }
  });

  const instructionTracker = new ProjectInstructionTracker(params.project, params.context.projectInstructions);
  const state = createNativeToolLoopState(convertModelMessagesToOpenAiCompatible(buildNativeToolLoopMessages({
    project: params.project,
    sessionId: params.context.activeSessionId,
    currentPrompt: createNativeToolLoopPrompt(params, toolNames, {
      includeWriteTools,
      includeMcpToolCalls,
      includeCommandTools,
      dynamicMcpToolNames: dynamicMcpTools.map((definition) => definition.name)
    })
  }), {
    preserveToolMessages: true
  }));
  state.latestTodoSnapshot = resolveLatestTodoSnapshotFromHistory(params);
  let compatibleToolDefinitions = toOpenAiCompatibleToolDefinitions(toolDefinitions);
  const apiMode = inferOpenAiCompatibleApiMode(params.provider);
  const maxOutputTokens = resolveNativeMainToolLoopMaxOutputTokens(params.provider);
  let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
  const coreStateMachine = createAgentCoreStateMachine('building_model_input');
  const runController = createAgentRunController();
  let latestRunControllerSnapshot: AgentRunControllerSnapshot = runController.start();
  const transitionCoreState = (to: AgentCoreState, reason: string): void => {
    coreStateMachine.transition(to, reason, new Date().toISOString());
  };
  const summarizeRunControllerSnapshot = (snapshot: AgentRunControllerSnapshot): Record<string, unknown> => ({
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
      : undefined
  });
  const emitCoreStateStage = (status: 'running' | 'completed' | 'failed', summary: string): void => {
    callbacks?.emitStage?.({
      stageId: 'stage:native_agent_core_v2',
      title: 'Agent Core v2 状态机',
      target: 'stage:native_agent_core_v2',
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
    forceContinuation?: Parameters<typeof runController.recordProviderStep>[0]['forceContinuation']
  ): AgentRunControllerSnapshot => {
    if (!latestCoreProviderStep) {
      return latestRunControllerSnapshot;
    }
    latestRunControllerSnapshot = runController.recordProviderStep({
      providerStep: latestCoreProviderStep,
      forceContinuation
    });
    return latestRunControllerSnapshot;
  };

  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行兼容 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: `已启动 OpenAI-compatible 流式 tool-calling（${apiMode}），不设固定工具步数上限。`
  });
  emitCoreStateStage('running', 'OpenAI-compatible Native tool loop 已接入 Agent Core v2 状态机。');

  let stepIndex = 0;
  let processStreamText = '';
  const emitProcessText = (text: string): void => {
    if (!text.trim()) {
      return;
    }
    processStreamText += text;
    state.streamedText = true;
    params.onTextDelta?.(text, processStreamText);
  };
  const emitRealtimeProcessTextDelta = (
    delta: string,
    accumulated: string,
    stepStream: {
      text: string;
    }
  ): void => {
    stepStream.text = accumulated || `${stepStream.text}${delta}`;
    state.streamedText = true;
    params.onTextDelta?.(delta, `${processStreamText}${stepStream.text}`);
  };
  const commitProcessText = (text: string, stepStream: { text: string }): void => {
    const nextText = text.trim() ? text : '';
    const streamedTarget = `${processStreamText}${stepStream.text}`;
    const committedTarget = `${processStreamText}${nextText}`;
    if (stepStream.text) {
      if (streamedTarget !== committedTarget) {
        state.streamedText = true;
        params.onTextDelta?.('', committedTarget);
      }
      processStreamText = committedTarget;
      stepStream.text = '';
      return;
    }
    emitProcessText(nextText);
  };
  const discardProcessText = (stepStream: { text: string }): void => {
    if (!stepStream.text) {
      return;
    }
    state.streamedText = true;
    params.onTextDelta?.('', processStreamText);
    stepStream.text = '';
  };
  const recordToolUseStart = (invocation: NativeOpenAiToolInvocation): void => {
    if (invocation.started) {
      return;
    }
    invocation.started = true;
    state.toolCalls.push(invocation.toolCall.name);
    state.parts.push({
      type: 'tool_use',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      name: invocation.toolCall.name,
      input: invocation.toolCall.arguments
    });
  };
  const recordToolResult = (invocation: NativeOpenAiToolInvocation, toolResult: NativeWorkspaceToolOutput, summary: string, transaction?: AgentToolTransactionSummary): void => {
    invocation.completed = true;
    latestRunControllerSnapshot = runController.recordToolResult({
      toolUseId: invocation.toolUseId,
      toolName: invocation.toolCall.name,
      content: summary,
      isError: Boolean(toolResult.isError),
      failureKind: toolResult.edit?.failureKind,
      recoveryHint: toolResult.edit?.recoveryHint,
      changedFiles: toolResult.changedFiles,
      command: toolResult.command,
      terminal: toolResult.terminal,
      browser: toolResult.browser,
      edit: toolResult.edit,
      mcp: toolResult.mcp,
      artifacts: toolResult.artifacts,
      transaction
    });
    state.parts.push({
      type: 'tool_result',
      stepIndex: invocation.stepIndex,
      toolUseId: invocation.toolUseId,
      content: summary,
      isError: Boolean(toolResult.isError)
    });
    state.messages.push({
      role: 'tool',
      toolCallId: invocation.toolUseId,
      name: invocation.toolCall.name,
      content: summary
    });
  };
  const emitInterruptedToolResults = (invocations: NativeOpenAiToolInvocation[], error: unknown): void => {
    for (const invocation of invocations) {
      if (invocation.completed) {
        continue;
      }
      const summary = formatInterruptedToolResult(error);
      state.completedToolResultsByUseId.set(invocation.toolUseId, {
        name: invocation.toolCall.name,
        summary,
        isError: true
      });
      recordNativeWorkspaceToolTransactionResult({
        toolUseId: invocation.toolUseId,
        toolName: invocation.toolCall.name,
        input: invocation.toolCall.arguments,
        callbacks,
        hooks: {
          onStart: () => recordToolUseStart(invocation),
          onResult: (toolResult, resultSummary) => recordToolResult(invocation, toolResult, resultSummary)
        },
        toolResult: {
          ok: false,
          isError: true,
          summary
        }
      });
    }
  };
  while (true) {
    params.abortSignal?.throwIfAborted();
    if (coreStateMachine.getSnapshot().state === 'building_model_input') {
      transitionCoreState('streaming_model_step', `开始第 ${stepIndex + 1} 个 provider step。`);
    }
    const refreshedMcpTools = await refreshNativeDynamicMcpToolsBetweenTurns({
      params,
      includeMcpToolCalls,
      previousTools: dynamicMcpTools,
      stepIndex,
      emitStage: callbacks?.emitStage
    });
    if (refreshedMcpTools !== dynamicMcpTools) {
      dynamicMcpTools = refreshedMcpTools;
      toolDefinitions = listNativeWorkspaceToolDefinitions({
        project: params.project,
        includeWriteTools,
        includeMcpToolCalls,
        includeCommandTools,
        dynamicTools: dynamicMcpTools
      });
      toolNames = toolDefinitions.map((definition) => definition.name);
      tools = createToolSet();
      compatibleToolDefinitions = toOpenAiCompatibleToolDefinitions(toolDefinitions);
    }
    const dynamicInstructionMessage = instructionTracker.formatDynamicInstructionMessage();
    const stepMessages =
      dynamicInstructionMessage && stepIndex > 0
        ? [
            ...state.messages.filter((message) => message.role !== 'user' || !message.content.startsWith(DYNAMIC_PROJECT_INSTRUCTIONS_MARKER)),
            {
              role: 'user' as const,
              content: dynamicInstructionMessage
            }
          ]
        : state.messages;
    params.onStatus?.('thinking', '正在思考中...');
    const stepStream = {
      text: ''
    };
    const stepAbort = createNativeProviderStepAbort(params.abortSignal, params.provider);
    const stepResult = await generateOpenAiCompatibleStreamingToolStep({
        provider: params.provider,
        system: createNativeRuntimeSystemPrompt(),
        messages: stepMessages,
        tools: compatibleToolDefinitions,
        maxOutputTokens,
        abortSignal: stepAbort.signal,
        onDelta: (delta, accumulated) => {
          emitRealtimeProcessTextDelta(delta, accumulated, stepStream);
        },
        onReasoningDelta: (delta, accumulated) => {
          state.thinking = accumulated || (state.thinking + delta);
          callbacks?.emitThinking?.(delta, state.thinking);
        }
      })
      .catch((error: unknown) => rethrowNativeProviderStepTimeout(
        error,
        stepAbort,
        'Native OpenAI-compatible provider step'
      ));
    state.stepCount = stepIndex + 1;
    state.finishReason = stepResult.finishReason;
    state.usage = stepResult.usage;
    latestCoreProviderStep = openAiCompatibleStepToAgentCoreProviderStepResult(stepResult, {
      providerId: params.provider.id,
      model: params.provider.model
    });
    const stepUsage = normalizeOpenAiUsage(stepResult.usage, {
      provider: params.provider?.id,
      model: params.provider?.model
    });
    if (stepUsage) {
      params.onUsage?.(stepUsage);
    }

    if (stepResult.toolCalls.length === 0) {
      const finalCandidate = normalizeModelReplyText(stepResult.text);
      const latestTodoSnapshot = state.latestTodoSnapshot;
      if (
        latestTodoSnapshot &&
        shouldContinueAfterIncompleteTodo({
          includeWriteTools,
          permissionMode: params.permission.mode,
          latestTodoSnapshot,
          assistantMessage: finalCandidate
        })
      ) {
        recordRunControllerProviderStep({
          reason: 'incomplete_todo',
          detail: 'Todo snapshot still has pending or in-progress items.'
        });
        transitionCoreState('collecting_tool_calls', `Provider step ${stepIndex + 1} 完成，finishReason=${state.finishReason ?? 'unknown'}，toolCalls=0。`);
        state.incompleteTodoContinuationCount += 1;
        state.parts.push({
          type: 'continuation',
          stepIndex,
          reason: 'incomplete_todo',
          text: finalCandidate
        });
        const continuationPrompt = createIncompleteTodoContinuationPrompt(latestTodoSnapshot, finalCandidate);
        callbacks?.emitStage?.({
          stageId: 'stage:native_incomplete_todo_continuation',
          title: '续跑未完成任务清单',
          target: 'stage:native_incomplete_todo_continuation',
          status: 'completed',
          summary: '模型结束时仍有 in_progress/pending todo，已要求继续调用工具完成剩余步骤。',
          input: {
            continuation: state.incompleteTodoContinuationCount,
            incompleteItems: latestTodoSnapshot.incompleteItems
          }
        });
        discardProcessText(stepStream);
        state.messages.push({
          role: 'assistant',
          content: finalCandidate,
          reasoningContent: stepResult.reasoningContent
        });
        state.messages.push({
          role: 'user',
          content: continuationPrompt
        });
        transitionCoreState('building_model_input', 'Todo 仍有未完成项，继续下一轮 provider step。');
        stepIndex += 1;
        continue;
      }
      if (
        state.partialWriteContinuationCount < NATIVE_PARTIAL_WRITE_CONTINUATION_LIMIT &&
        shouldContinueAfterPartialWriteReply({
          includeWriteTools,
          permissionMode: params.permission.mode,
          assistantMessage: finalCandidate
        })
      ) {
        recordRunControllerProviderStep({
          reason: 'partial_write',
          detail: 'Assistant text looked like an unfinished file-writing promise.'
        });
        transitionCoreState('collecting_tool_calls', `Provider step ${stepIndex + 1} 完成，finishReason=${state.finishReason ?? 'unknown'}，toolCalls=0。`);
        state.partialWriteContinuationCount += 1;
        state.parts.push({
          type: 'continuation',
          stepIndex,
          reason: 'partial_write',
          text: finalCandidate
        });
        callbacks?.emitStage?.({
          stageId: 'stage:native_partial_write_continuation',
          title: '续写未完成文件',
          target: 'stage:native_partial_write_continuation',
          status: 'completed',
          summary: '模型返回了未完成的多文件写入承诺，已要求继续调用写入工具而不是结束回复。',
          input: {
            continuation: state.partialWriteContinuationCount,
            assistantMessage: finalCandidate
          }
        });
        discardProcessText(stepStream);
        state.messages.push({
          role: 'assistant',
          content: finalCandidate,
          reasoningContent: stepResult.reasoningContent
        });
        state.messages.push({
          role: 'user',
          content: createPartialWriteContinuationPrompt(finalCandidate)
        });
        transitionCoreState('building_model_input', '模型返回未完成写入承诺，继续下一轮 provider step。');
        stepIndex += 1;
        continue;
      }
      const controllerSnapshot = recordRunControllerProviderStep();
      transitionCoreState('collecting_tool_calls', `Provider step ${stepIndex + 1} 完成，finishReason=${state.finishReason ?? 'unknown'}，toolCalls=0。`);
      if (controllerSnapshot.nextAction === 'build_model_input' && isLengthLimitedFinishReason(state.finishReason)) {
        if (finalCandidate.trim()) {
          recordNativeToolLoopAssistantText(state, stepIndex, finalCandidate, {
            final: false
          });
          commitProcessText(finalCandidate, stepStream);
        } else {
          discardProcessText(stepStream);
        }
        callbacks?.emitStage?.({
          stageId: 'stage:native_length_continuation',
          title: '续跑长度截断回复',
          target: 'stage:native_length_continuation',
          status: 'completed',
          summary: 'Provider 返回 length 截断，已继续下一轮；length 不是真正完成态。',
          input: {
            step: stepIndex + 1,
            finishReason: state.finishReason,
            assistantMessage: finalCandidate
          }
        });
        appendNativeToolLoopAssistantToolMessage(state, stepResult, {
          apiMode,
          assistantText: finalCandidate
        });
        state.messages.push({
          role: 'user',
          content: createLengthContinuationPrompt(finalCandidate)
        });
        transitionCoreState('building_model_input', 'Provider 返回 length 截断，继续下一轮 provider step。');
        stepIndex += 1;
        continue;
      }
      if (controllerSnapshot.nextAction === 'fail') {
        discardProcessText(stepStream);
        transitionCoreState('failed', controllerSnapshot.lastDecision?.reason ?? 'Provider 没有 tool call，也没有可见最终文本。');
        callbacks?.emitStage?.({
          stageId: 'stage:native_tool_stream',
          title: '执行兼容 Tool Loop',
          target: 'stage:native_tool_stream',
          status: 'completed',
          summary: [
            `完成 ${stepIndex + 1} 步`,
            state.finishReason ? `finishReason=${state.finishReason}` : '',
            state.toolCalls.length > 0 ? `tools=${state.toolCalls.join(', ')}` : 'tools=none',
            'finalText=empty'
          ].filter(Boolean).join('；')
        });
        emitCoreStateStage('failed', 'Agent Core v2 判定 provider 没有返回可显示的最终文本。');
        return createNativeToolLoopRunResult(state, controllerSnapshot.coreState);
      }
      if (controllerSnapshot.nextAction !== 'complete') {
        discardProcessText(stepStream);
        transitionCoreState('failed', `Agent Run Controller 返回了无法在无工具分支处理的动作：${controllerSnapshot.nextAction}。`);
        callbacks?.emitStage?.({
          stageId: 'stage:native_tool_stream',
          title: '执行兼容 Tool Loop',
          target: 'stage:native_tool_stream',
          status: 'completed',
          summary: [
            `完成 ${stepIndex + 1} 步`,
            state.finishReason ? `finishReason=${state.finishReason}` : '',
            state.toolCalls.length > 0 ? `tools=${state.toolCalls.join(', ')}` : 'tools=none',
            `controllerAction=${controllerSnapshot.nextAction}`
          ].filter(Boolean).join('；')
        });
        emitCoreStateStage('failed', 'Agent Run Controller 返回了无工具分支无法处理的动作。');
        return createNativeToolLoopRunResult(state, controllerSnapshot.coreState);
      }
      recordNativeToolLoopAssistantText(state, stepIndex, finalCandidate, {
        final: true
      });
      commitProcessText(finalCandidate, stepStream);
      transitionCoreState('completed', 'Provider stop 且没有 tool call，并产出最终可见文本。');
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行兼容 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'completed',
        summary: [
          `完成 ${stepIndex + 1} 步`,
          state.finishReason ? `finishReason=${state.finishReason}` : '',
          state.toolCalls.length > 0 ? `tools=${state.toolCalls.join(', ')}` : 'tools=none'
        ].filter(Boolean).join('；')
      });
      emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 Native 工具循环。');
      return createNativeToolLoopRunResult(state, controllerSnapshot.coreState);
    }

    const controllerSnapshot = recordRunControllerProviderStep();
    transitionCoreState('collecting_tool_calls', `Provider step ${stepIndex + 1} 完成，finishReason=${state.finishReason ?? 'unknown'}，toolCalls=${stepResult.toolCalls.length}。`);
    if (controllerSnapshot.nextAction !== 'execute_tools') {
      discardProcessText(stepStream);
      transitionCoreState('failed', `Agent Run Controller 返回了无法在工具分支处理的动作：${controllerSnapshot.nextAction}。`);
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行兼容 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'completed',
        summary: [
          `完成 ${stepIndex + 1} 步`,
          state.finishReason ? `finishReason=${state.finishReason}` : '',
          `tools=${stepResult.toolCalls.map((toolCall) => toolCall.name).join(', ')}`,
          `controllerAction=${controllerSnapshot.nextAction}`
        ].filter(Boolean).join('；')
      });
      emitCoreStateStage('failed', 'Agent Run Controller 返回了工具分支无法处理的动作。');
      return createNativeToolLoopRunResult(state, controllerSnapshot.coreState);
    }
    transitionCoreState('executing_tools', `Provider 返回 ${stepResult.toolCalls.length} 个 tool call，进入工具执行。`);

    if (stepResult.toolCallRepair?.type === 'textual_tool_marker') {
      callbacks?.emitStage?.({
        stageId: 'stage:native_text_tool_repair',
        title: '修复文本工具调用',
        target: 'stage:native_text_tool_repair',
        status: 'completed',
        summary: `OpenAI-compatible 适配层把正文工具标记归一为结构化工具调用：${stepResult.toolCallRepair.toolNames.join(', ')}。`
      });
    }

    const assistantStepText = recordNativeToolLoopAssistantText(state, stepIndex, stepResult.text, {
      final: false
    });
    commitProcessText(assistantStepText, stepStream);
    appendNativeToolLoopAssistantToolMessage(state, stepResult, {
      apiMode,
      assistantText: assistantStepText
    });

    const toolInvocations: NativeOpenAiToolInvocation[] = stepResult.toolCalls.map((toolCall) => ({
      toolCall,
      toolUseId: toolCall.id || makeId('tool'),
      stepIndex,
      started: false,
      completed: false
    }));
    const editFailureRecoveries: NativeEditFailureRecovery[] = [];

    try {
      for (const invocation of toolInvocations) {
        const { toolCall, toolUseId } = invocation;
        const cachedToolResult = state.completedToolResultsByUseId.get(toolUseId);
        const malformedToolResult: NativeWorkspaceToolOutput | undefined = toolCall.argumentsParseError
          ? {
              ok: false,
              isError: true,
              media: undefined,
              summary: [
                `工具调用参数 JSON 无法解析，未执行 ${toolCall.name}。`,
                `错误：${toolCall.argumentsParseError}`,
                toolCall.rawArguments ? `原始参数：${truncateToolArgumentPreview(toolCall.rawArguments)}` : ''
              ].filter(Boolean).join('\n')
            }
          : undefined;
        const invalidToolInputResult = malformedToolResult ? undefined : createInvalidMultiEditInputResult(toolCall);
        const precomputedToolResult: NativeWorkspaceToolOutput | undefined = cachedToolResult
          ? {
              ok: !cachedToolResult.isError,
              summary: cachedToolResult.summary,
              isError: cachedToolResult.isError,
              media: cachedToolResult.media,
              changedFiles: cachedToolResult.changedFiles,
              command: cachedToolResult.command,
              terminal: cachedToolResult.terminal,
              browser: cachedToolResult.browser,
              edit: cachedToolResult.edit,
              mcp: cachedToolResult.mcp,
              artifacts: cachedToolResult.artifacts
            }
          : malformedToolResult ?? invalidToolInputResult;
        const transaction = await executeNativeWorkspaceToolTransaction({
          tools,
          toolUseId,
          toolName: toolCall.name,
          input: toolCall.arguments,
          callbacks,
          precomputedResult: precomputedToolResult,
          hooks: {
            onStart: () => recordToolUseStart(invocation),
            onResult: (result, resultSummary, transactionSummary) => recordToolResult(invocation, result, resultSummary, transactionSummary)
          }
        });
        const toolResult = transaction.toolResult;
        const summary = transaction.summary;
        const editRecovery = collectEditFailureRecovery(toolCall, toolResult);
        if (editRecovery) {
          editFailureRecoveries.push(editRecovery);
        }
        const todoSnapshot = resolveTodoSnapshotFromToolResult({
          toolName: toolCall.name,
          toolInput: toolCall.arguments,
          summary,
          isError: Boolean(toolResult.isError)
        });
        if (todoSnapshot) {
          state.latestTodoSnapshot = todoSnapshot;
        }
        if (cachedToolResult) {
          callbacks?.emitStage?.({
            stageId: `stage:native_duplicate_tool_result:${toolUseId}`,
            title: '跳过重复工具执行',
            target: toolCall.name,
            status: 'completed',
            summary: `检测到重复 toolUseId=${toolUseId}，已回放先前工具结果，未再次执行工具。`
          });
        } else {
          state.completedToolResultsByUseId.set(toolUseId, {
            name: toolCall.name,
            summary,
            isError: Boolean(toolResult.isError),
            media: toolResult.media,
            changedFiles: toolResult.changedFiles,
            command: toolResult.command,
            terminal: toolResult.terminal,
            browser: toolResult.browser,
            edit: toolResult.edit,
            mcp: toolResult.mcp,
            artifacts: toolResult.artifacts
          });
          if (malformedToolResult) {
            callbacks?.emitStage?.({
              stageId: `stage:native_malformed_tool_arguments:${toolUseId}`,
              title: '拒绝畸形工具参数',
              target: toolCall.name,
              status: 'completed',
              summary: `检测到 ${toolCall.name} 的工具参数不是有效 JSON，已作为工具错误回放给模型，未执行真实工具。`
            });
          } else if (invalidToolInputResult) {
            callbacks?.emitStage?.({
              stageId: `stage:native_invalid_tool_input:${toolUseId}`,
              title: '拒绝无效工具参数',
              target: toolCall.name,
              status: 'completed',
              summary: `检测到 ${toolCall.name} 的工具参数不满足执行条件，已作为工具错误回放给模型，未执行真实工具。`
            });
          }
        }
        const discoveredInstructions = instructionTracker.discoverFromToolInput(toolCall.name, toolCall.arguments);
        if (discoveredInstructions.length > 0) {
          callbacks?.emitStage?.({
            stageId: 'stage:native_dynamic_instructions',
            title: '发现局部 Agent 指令',
            target: 'stage:native_dynamic_instructions',
            status: 'completed',
            summary: `已载入 ${discoveredInstructions.map((instruction) => instruction.path).join(', ')}。`,
            input: {
              paths: discoveredInstructions.map((instruction) => instruction.path)
            }
          });
        }
      }
    } catch (error) {
      emitInterruptedToolResults(toolInvocations, error);
      if (isAbortLikeError(error, params.abortSignal)) {
        transitionCoreState('interrupted_resumable', '工具执行被中断，已把未完成工具记录为结构化错误结果。');
        emitCoreStateStage('failed', 'Agent Core v2 状态机记录可恢复中断。');
        throw error;
      }
    }
    transitionCoreState('recording_tool_results', `已记录第 ${stepIndex + 1} 步工具结果。`);

    if (
      editFailureRecoveries.length > 0 &&
      includeWriteTools &&
      params.permission.mode !== 'read-only' &&
      state.editFailureContinuationCount < NATIVE_EDIT_FAILURE_CONTINUATION_LIMIT
    ) {
      state.editFailureContinuationCount += 1;
      const recoveryPrompt = createEditFailureRecoveryPrompt(editFailureRecoveries);
      state.parts.push({
        type: 'continuation',
        stepIndex,
        reason: 'edit_recovery',
        text: recoveryPrompt
      });
      state.messages.push({
        role: 'user',
        content: recoveryPrompt
      });
      callbacks?.emitStage?.({
        stageId: 'stage:native_edit_failure_recovery',
        title: '恢复失败编辑',
        target: 'stage:native_edit_failure_recovery',
        status: 'completed',
        summary: '检测到编辑工具预检失败，已要求模型重新读取目标片段或改用 unified patch 后继续。',
        input: {
          continuation: state.editFailureContinuationCount,
          failures: editFailureRecoveries.map((recovery) => ({
            toolName: recovery.toolName,
            path: recovery.path,
            failureKind: recovery.failureKind
          }))
        }
      });
    }
    transitionCoreState('continuing_after_tools', '工具结果已进入上下文，准备回放给模型。');

    callbacks?.emitStage?.({
      stageId: 'stage:native_tool_stream',
      title: '执行兼容 Tool Loop',
      target: 'stage:native_tool_stream',
      status: 'running',
      summary: `兼容 tool loop 已完成 ${stepIndex + 1} 步。`,
      input: {
        step: stepIndex + 1,
        finishReason: state.finishReason,
        toolsUsed: [...state.toolCalls],
        usage: state.usage
      }
    });
    transitionCoreState('building_model_input', '工具结果已记录，构建下一轮 provider 输入。');
    stepIndex += 1;
  }
}

export async function runNativeReadOnlyToolLoop(params: GenericAgentRuntimeParams, callbacks?: {
  emitToolUse?: GenericAgentRuntimeParams['onToolUse'];
  emitToolResult?: GenericAgentRuntimeParams['onToolResult'];
  emitThinking?: (delta: string, accumulated: string) => void;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
  includeWriteTools?: boolean;
  includeMcpToolCalls?: boolean;
  includeCommandTools?: boolean;
}): Promise<NativeToolLoopRunResult> {
  if (!params.provider) {
    throw new Error('Native tool loop requires a provider.');
  }
  if (params.provider.protocol === 'openai-compatible') {
    return runOpenAiCompatibleNativeToolLoop(params, callbacks);
  }

  const model = createLanguageModel(params.provider);
  const includeWriteTools = Boolean(callbacks?.includeWriteTools);
  const includeMcpToolCalls = Boolean(callbacks?.includeMcpToolCalls);
  const includeCommandTools = Boolean(callbacks?.includeCommandTools);
  let dynamicMcpTools = await prepareNativeDynamicMcpTools(params, includeMcpToolCalls, callbacks?.emitStage);
  let toolDefinitions = listNativeWorkspaceToolDefinitions({
    project: params.project,
    includeWriteTools,
    includeMcpToolCalls,
    includeCommandTools,
    dynamicTools: dynamicMcpTools
  });
  let toolNames = toolDefinitions.map((definition) => definition.name);
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: '准备真实 Tool Schema',
    target: 'stage:native_tool_schema',
    status: 'running',
    summary: `正在初始化 ${toolNames.length} 个 Native 工作区工具。`
  });
  const createToolSet = () => createNativeWorkspaceTools({
    project: params.project,
    plugins: params.plugins,
    checkpointSnapshotId: params.checkpointSnapshotId,
    abortSignal: params.abortSignal,
    includeWriteTools,
    includeMcpToolCalls,
    includeCommandTools,
    dynamicTools: dynamicMcpTools,
    permissionContext: {
      permission: params.permission,
      requestPermission: params.requestPermission
    },
    lifecycleHooks: params.lifecycleHooks,
    lifecycleHookContext: {
      runId: params.activeRunId,
      projectId: params.project.id,
      sessionId: params.context.activeSessionId,
      cwd: params.context.runtimeEnvironment?.workingDirectory ?? params.context.projectPath
    },
    onLifecycleHook: params.onLifecycleHook,
    emitLifecycleHookStage: callbacks?.emitStage,
    requestUserInput: (action) => requestUserInputFromTool(params, action),
    requestMcpUserInput: params.requestUserInput,
    runSubagent: (action) => runNativeSubagent(params, action),
    runSubagents: (action) => runNativeParallelSubagents(params, action),
    startSubagent: (action) => startNativeBackgroundSubagent(params, action),
    readSubagentStatus: (action) => readNativeBackgroundSubagentStatus(params, action)
  });
  let tools = createToolSet();
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: '准备真实 Tool Schema',
    target: 'stage:native_tool_schema',
    status: 'completed',
    summary: `已注册 ${toolNames.length} 个 Native 工作区工具。`,
    input: {
      tools: [...toolNames],
      includeWriteTools,
      includeMcpToolCalls,
      includeCommandTools,
      dynamicMcpToolCount: dynamicMcpTools.length
    }
  });
  const instructionTracker = new ProjectInstructionTracker(params.project, params.context.projectInstructions);

  let messages: ModelMessage[] = buildNativeToolLoopMessages({
    project: params.project,
    sessionId: params.context.activeSessionId,
    currentPrompt: createNativeToolLoopPrompt(params, toolNames, {
      includeWriteTools,
      includeMcpToolCalls,
      includeCommandTools,
      dynamicMcpToolNames: dynamicMcpTools.map((definition) => definition.name)
    })
  });
  let assistantMessage = '';
  let thinking = '';
  let stepCount = 0;
  let streamedText = false;
  const toolCalls: string[] = [];
  const toolCallIds = new Map<string, string>();
  const toolCallInputs = new Map<string, {
    toolName: string;
    input?: Record<string, unknown>;
  }>();
  const completedToolCallIds = new Set<string>();
  let latestTodoSnapshot: NativeTodoSnapshot | undefined = resolveLatestTodoSnapshotFromHistory(params);
  let incompleteTodoContinuationCount = 0;
  const maxOutputTokens = resolveNativeMainToolLoopMaxOutputTokens(params.provider);
  let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
  const coreStateMachine = createAgentCoreStateMachine('building_model_input');
  const runController = createAgentRunController();
  let latestRunControllerSnapshot: AgentRunControllerSnapshot = runController.start();
  const transitionCoreState = (to: AgentCoreState, reason: string): void => {
    const current = coreStateMachine.getSnapshot().state;
    if (current === to || !canTransitionAgentCoreState(current, to)) {
      return;
    }
    coreStateMachine.transition(to, reason, new Date().toISOString());
  };
  const summarizeRunControllerSnapshot = (snapshot: AgentRunControllerSnapshot): Record<string, unknown> => ({
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
      : undefined
  });
  const emitCoreStateStage = (status: 'running' | 'completed' | 'failed', summary: string): void => {
    callbacks?.emitStage?.({
      stageId: 'stage:native_ai_sdk_agent_core_v2',
      title: 'Agent Core v2 状态机',
      target: 'stage:native_ai_sdk_agent_core_v2',
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
    forceContinuation?: Parameters<typeof runController.recordProviderStep>[0]['forceContinuation']
  ): AgentRunControllerSnapshot => {
    if (!latestCoreProviderStep) {
      return latestRunControllerSnapshot;
    }
    latestRunControllerSnapshot = runController.recordProviderStep({
      providerStep: latestCoreProviderStep,
      forceContinuation
    });
    return latestRunControllerSnapshot;
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

  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_stream',
    title: '执行真实 Tool Loop',
    target: 'stage:native_tool_stream',
    status: 'running',
    summary: '已启动真实 tool-calling 流，不设固定工具步数上限。'
  });
  emitCoreStateStage('running', 'AI SDK Native tool loop 已接入 Agent Core v2 状态机。');

  while (true) {
    params.abortSignal?.throwIfAborted();
    markCoreStreaming(`开始第 ${stepCount + 1} 个 AI SDK provider step。`);
    const refreshedMcpTools = await refreshNativeDynamicMcpToolsBetweenTurns({
      params,
      includeMcpToolCalls,
      previousTools: dynamicMcpTools,
      stepIndex: stepCount,
      emitStage: callbacks?.emitStage
    });
    if (refreshedMcpTools !== dynamicMcpTools) {
      dynamicMcpTools = refreshedMcpTools;
      toolDefinitions = listNativeWorkspaceToolDefinitions({
        project: params.project,
        includeWriteTools,
        includeMcpToolCalls,
        includeCommandTools,
        dynamicTools: dynamicMcpTools
      });
      toolNames = toolDefinitions.map((definition) => definition.name);
      tools = createToolSet();
    }
    toolCallIds.clear();
    toolCallInputs.clear();
    completedToolCallIds.clear();
    const stepToolCallInputs = new Map<string, {
      toolUseId: string;
      toolName: string;
      input?: Record<string, unknown>;
    }>();
    const stepToolResults = new Map<string, {
      toolUseId: string;
      toolName?: string;
      content: string;
      isError?: boolean;
      failureKind?: string;
      recoveryHint?: string;
    }>();
    const stepAbort = createNativeProviderStepAbort(params.abortSignal, params.provider);
    const result = streamText({
      model,
      system: createNativeRuntimeSystemPrompt(),
      messages,
      tools,
      activeTools: [...toolNames],
      toolChoice: 'auto',
      prepareStep: ({ messages, stepNumber }) => {
        const dynamicInstructionMessage = instructionTracker.formatDynamicInstructionMessage();
        if (!dynamicInstructionMessage || stepNumber === 0) {
          return undefined;
        }

        return {
          messages: withDynamicInstructionMessage(messages, dynamicInstructionMessage)
        };
      },
      stopWhen: NEVER_STOP_ON_STEP_COUNT,
      maxOutputTokens,
      abortSignal: stepAbort.signal
    });

    try {
      for await (const event of result.fullStream) {
        switch (event.type) {
          case 'text-delta':
            markCoreStreaming('AI SDK provider 正在流式输出文本。');
            assistantMessage += event.text;
            streamedText = true;
            params.onTextDelta?.(event.text, assistantMessage);
            break;
          case 'reasoning-delta': {
            markCoreStreaming('AI SDK provider 正在流式输出推理内容。');
            thinking += event.text;
            callbacks?.emitThinking?.(event.text, thinking);
            break;
          }
          case 'tool-call': {
            markCoreExecuting(`AI SDK provider 请求工具 ${event.toolName}。`);
            const toolUseId = event.toolCallId || makeId('tool');
            toolCallIds.set(event.toolCallId, toolUseId);
            toolCallInputs.set(event.toolCallId, {
              toolName: event.toolName,
              input: normalizeToolInput(event.input)
            });
            stepToolCallInputs.set(event.toolCallId, {
              toolUseId,
              toolName: event.toolName,
              input: normalizeToolInput(event.input)
            });
            toolCalls.push(event.toolName);
            callbacks?.emitToolUse?.({
              toolUseId,
              name: event.toolName,
              input: event.input as Record<string, unknown> | undefined,
              status: 'running'
            });
            break;
          }
          case 'tool-result': {
            markCoreRecording(`AI SDK 工具 ${event.toolName} 返回结果。`);
            const toolUseId = toolCallIds.get(event.toolCallId) ?? event.toolCallId ?? makeId('tool');
            const toolCallInput = toolCallInputs.get(event.toolCallId);
            completedToolCallIds.add(event.toolCallId);
            const toolOutput = normalizeToolOutputForStream(event.output);
            const toolName = toolCallInput?.toolName ?? event.toolName;
            const todoSnapshot = resolveTodoSnapshotFromToolResult({
              toolName,
              toolInput: toolCallInput?.input,
              summary: toolOutput.summary,
              isError: Boolean(toolOutput.isError)
            });
            if (todoSnapshot) {
              latestTodoSnapshot = todoSnapshot;
            }
            const discoveredInstructions = instructionTracker.discoverFromToolInput(
              toolName,
              toolCallInput?.input
            );
            if (discoveredInstructions.length > 0) {
              callbacks?.emitStage?.({
                stageId: 'stage:native_dynamic_instructions',
                title: '发现局部 Agent 指令',
                target: 'stage:native_dynamic_instructions',
                status: 'completed',
                summary: `已载入 ${discoveredInstructions.map((instruction) => instruction.path).join(', ')}。`,
                input: {
                  paths: discoveredInstructions.map((instruction) => instruction.path)
                }
              });
            }
            callbacks?.emitToolResult?.({
              toolUseId,
              content: toolOutput.summary,
              isError: Boolean(toolOutput.isError),
              media: toolOutput.media,
              changedFiles: toolOutput.changedFiles,
              command: toolOutput.command,
              terminal: toolOutput.terminal,
              browser: toolOutput.browser,
              edit: toolOutput.edit,
              mcp: toolOutput.mcp,
              artifacts: toolOutput.artifacts
            });
            callbacks?.emitToolUse?.({
              toolUseId,
              name: event.toolName,
              input: undefined,
              status: toolOutput.isError ? 'failed' : 'completed'
            });
            stepToolResults.set(event.toolCallId, {
              toolUseId,
              toolName,
              content: toolOutput.summary,
              isError: Boolean(toolOutput.isError),
              failureKind: toolOutput.edit?.failureKind,
              recoveryHint: toolOutput.edit?.recoveryHint
            });
            break;
          }
          case 'finish-step': {
            stepCount += 1;
            if (toolCallIds.size > 0) {
              markCoreRecording(`AI SDK provider step ${stepCount} 已记录工具结果。`);
              transitionCoreState('continuing_after_tools', `AI SDK provider step ${stepCount} 准备继续。`);
              transitionCoreState('building_model_input', `AI SDK provider step ${stepCount} 工具结果已进入上下文。`);
            } else {
              markCoreCollecting(`AI SDK provider step ${stepCount} 完成，未返回工具调用。`);
            }
            params.onStatus?.('thinking', `Native tool loop 已完成 ${stepCount} 步。`);
            callbacks?.emitStage?.({
              stageId: 'stage:native_tool_stream',
              title: '执行真实 Tool Loop',
              target: 'stage:native_tool_stream',
              status: 'running',
              summary: `真实 tool loop 已完成 ${stepCount} 步。`,
              input: {
                step: stepCount,
                toolsUsed: [...toolCalls]
              }
            });
            const stepUsage = normalizeAiSdkUsage(event.usage, {
              provider: params.provider?.id,
              model: params.provider?.model
            });
            const providerStepToolCalls = [...stepToolCallInputs.values()].map((toolCall) => ({
              toolCallId: toolCall.toolUseId,
              toolName: toolCall.toolName,
              input: toolCall.input
            }));
            latestCoreProviderStep = aiSdkStepToAgentCoreProviderStepResult({
              text: assistantMessage,
              thinking,
              finishReason: event.finishReason,
              usage: event.usage,
              toolCalls: providerStepToolCalls.map((toolCall) => ({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: toolCall.input
              }))
            }, {
              providerId: params.provider?.id,
              model: params.provider?.model
            });
            if (providerStepToolCalls.length > 0) {
              latestRunControllerSnapshot = runController.recordProviderStep({
                providerStep: latestCoreProviderStep
              });
              for (const toolResult of stepToolResults.values()) {
                latestRunControllerSnapshot = runController.recordToolResult(toolResult);
              }
            }
            stepToolCallInputs.clear();
            stepToolResults.clear();
            toolCallIds.clear();
            toolCallInputs.clear();
            completedToolCallIds.clear();
            if (stepUsage) {
              params.onUsage?.(stepUsage);
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      for (const [rawToolCallId, toolUseId] of toolCallIds) {
        if (completedToolCallIds.has(rawToolCallId)) {
          continue;
        }
        const toolCallInput = toolCallInputs.get(rawToolCallId);
        callbacks?.emitToolResult?.({
          toolUseId,
          toolName: toolCallInput?.toolName,
          content: formatInterruptedToolResult(error),
          isError: true
        });
        callbacks?.emitToolUse?.({
          toolUseId,
          name: toolCallInput?.toolName ?? 'tool',
          input: undefined,
          status: 'failed'
        });
      }
      if (stepAbort.timedOut()) {
        markCoreFailed('AI SDK provider step 超时。');
        emitCoreStateStage('failed', 'Agent Core v2 记录 AI SDK provider step 超时。');
        rethrowNativeProviderStepTimeout(
          error,
          stepAbort,
          'Native AI SDK provider step'
        );
      }
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行真实 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'failed',
        summary: error instanceof Error ? error.message : '真实 tool-calling 流执行失败。',
        errorMessage: error instanceof Error ? error.message : '真实 tool-calling 流执行失败。'
      });
      if (params.abortSignal?.aborted) {
        transitionCoreState('interrupted_resumable', 'AI SDK Native tool loop 被中断。');
        emitCoreStateStage('failed', 'Agent Core v2 记录可恢复中断。');
      } else {
        markCoreFailed(error instanceof Error ? error.message : 'AI SDK Native tool loop 执行失败。');
        emitCoreStateStage('failed', 'Agent Core v2 记录 AI SDK Native tool loop 失败。');
      }
      throw error;
    }

    const finishReason = await result.finishReason;
    const usage = await Promise.resolve(result.usage).catch(() => undefined);
    const response = await Promise.resolve(result.response).catch(() => undefined);
    const finalCandidate = normalizeModelReplyText(assistantMessage);
    latestCoreProviderStep = aiSdkStepToAgentCoreProviderStepResult({
      text: finalCandidate,
      thinking,
      finishReason,
      usage,
      toolCalls: [...toolCallInputs.entries()].map(([toolCallId, toolCall]) => ({
        toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input
      }))
    }, {
      providerId: params.provider.id,
      model: params.provider.model
    });
    if (
      latestTodoSnapshot &&
      shouldContinueAfterIncompleteTodo({
        includeWriteTools,
        permissionMode: params.permission.mode,
        latestTodoSnapshot,
        assistantMessage: finalCandidate
      })
    ) {
      recordRunControllerProviderStep({
        reason: 'incomplete_todo',
        detail: 'Todo snapshot still has pending or in-progress items.'
      });
      incompleteTodoContinuationCount += 1;
      const continuationPrompt = createIncompleteTodoContinuationPrompt(latestTodoSnapshot, finalCandidate);
      callbacks?.emitStage?.({
        stageId: 'stage:native_incomplete_todo_continuation',
        title: '续跑未完成任务清单',
        target: 'stage:native_incomplete_todo_continuation',
        status: 'completed',
        summary: '模型结束时仍有 in_progress/pending todo，已要求继续调用工具完成剩余步骤。',
        input: {
          continuation: incompleteTodoContinuationCount,
          incompleteItems: latestTodoSnapshot.incompleteItems,
          finishReason
        }
      });
      transitionCoreState('building_model_input', 'Todo 仍有未完成项，继续下一轮 AI SDK provider step。');
      messages = [
        ...messages,
        ...((response?.messages ?? []) as ModelMessage[]),
        {
          role: 'user',
          content: continuationPrompt
        }
      ];
      assistantMessage = '';
      continue;
    }

    const controllerSnapshot = recordRunControllerProviderStep();
    if (controllerSnapshot.nextAction === 'build_model_input' && isLengthLimitedFinishReason(finishReason)) {
      callbacks?.emitStage?.({
        stageId: 'stage:native_length_continuation',
        title: '续跑长度截断回复',
        target: 'stage:native_length_continuation',
        status: 'completed',
        summary: 'AI SDK provider 返回 length 截断，已继续下一轮；length 不是真正完成态。',
        input: {
          step: stepCount,
          finishReason,
          assistantMessage: finalCandidate
        }
      });
      transitionCoreState('building_model_input', 'AI SDK provider 返回 length 截断，继续下一轮 provider step。');
      messages = [
        ...messages,
        ...((response?.messages ?? []) as ModelMessage[]),
        {
          role: 'user',
          content: createLengthContinuationPrompt(finalCandidate)
        }
      ];
      assistantMessage = '';
      continue;
    }

    if (controllerSnapshot.nextAction === 'fail') {
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行真实 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'completed',
        summary: [
          `完成 ${stepCount} 步`,
          finishReason ? `finishReason=${finishReason}` : '',
          toolCalls.length > 0 ? `tools=${toolCalls.join(', ')}` : 'tools=none',
          'controllerAction=fail'
        ]
          .filter(Boolean)
          .join('；'),
        input: {
          step: stepCount,
          finishReason,
          toolsUsed: [...toolCalls],
          usage
        }
      });
      markCoreFailed(controllerSnapshot.lastDecision?.reason ?? 'AI SDK provider 没有产出可完成的最终步骤。');
      emitCoreStateStage('failed', 'Agent Run Controller 判定 AI SDK Native 工具循环失败。');
      return {
        assistantMessage: finalCandidate,
        finishReason,
        stepCount,
        toolCalls,
        streamedText,
        usage,
        coreState: controllerSnapshot.coreState
      };
    }

    if (controllerSnapshot.nextAction !== 'complete') {
      callbacks?.emitStage?.({
        stageId: 'stage:native_tool_stream',
        title: '执行真实 Tool Loop',
        target: 'stage:native_tool_stream',
        status: 'completed',
        summary: [
          `完成 ${stepCount} 步`,
          finishReason ? `finishReason=${finishReason}` : '',
          toolCalls.length > 0 ? `tools=${toolCalls.join(', ')}` : 'tools=none',
          `controllerAction=${controllerSnapshot.nextAction}`
        ]
          .filter(Boolean)
          .join('；'),
        input: {
          step: stepCount,
          finishReason,
          toolsUsed: [...toolCalls],
          usage
        }
      });
      markCoreFailed(`Agent Run Controller 返回了无法完成的动作：${controllerSnapshot.nextAction}。`);
      emitCoreStateStage('failed', 'Agent Run Controller 返回了 AI SDK 分支无法完成的动作。');
      return {
        assistantMessage: finalCandidate,
        finishReason,
        stepCount,
        toolCalls,
        streamedText,
        usage,
        coreState: controllerSnapshot.coreState
      };
    }

    callbacks?.emitStage?.({
      stageId: 'stage:native_tool_stream',
      title: '执行真实 Tool Loop',
      target: 'stage:native_tool_stream',
      status: 'completed',
      summary: [
        `完成 ${stepCount} 步`,
        finishReason ? `finishReason=${finishReason}` : '',
        toolCalls.length > 0 ? `tools=${toolCalls.join(', ')}` : 'tools=none'
      ]
        .filter(Boolean)
        .join('；'),
      input: {
        step: stepCount,
        finishReason,
        toolsUsed: [...toolCalls],
        usage
      }
    });
    markCoreCompleted('AI SDK provider stop 且没有待处理工具，产出最终回复。');
    emitCoreStateStage('completed', 'Agent Core v2 状态机完成本轮 AI SDK Native 工具循环。');

    return {
      assistantMessage: finalCandidate,
      finishReason,
      stepCount,
      toolCalls,
      streamedText,
      usage,
      coreState: controllerSnapshot.coreState
    };
  }
}
