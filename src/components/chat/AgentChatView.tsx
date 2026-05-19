import { useMemo, type JSX } from 'react';
import type {
  AgentPermissionMode,
  AgentCoreMessagePart,
  AgentPermissionImpact,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentUserInputOption,
  AgentUserInputResponse,
  AiProvider,
  ChatContentBlock,
  ChatMediaBlock,
  ChatMessage,
  PromptAttachment,
  Project,
  ProjectSessionEffort,
  ProjectSessionRuntimeId,
  RuntimeRecoveryAction
} from '../../../shared/types';
import { resolveProviderTokenLimits } from '../../../shared/provider-catalog';
import { agentCorePartsToPlainText } from '../../../shared/agent-core-v2';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { ChatComposer, type AgentContextUsageSummary, type EngineConnectionSummary, type QueuedPromptItem } from './ChatComposer';
import { MessageList, type EmptyChatAction } from './MessageList';
import { getVisibleRuntimeStatusMessage } from './runtime-display';
import { buildRuntimeTaskSummaryFromTools } from './runtime-task-summary';

const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const TOKEN_ESTIMATE_CACHE_LIMIT = 5000;
const messageTokenEstimateByObject = new WeakMap<ChatMessage, {
  signature: string;
  tokens: number;
}>();
const messageTokenEstimateBySignature = new Map<string, number>();
const streamTokenEstimateBySignature = new Map<string, number>();

export interface AgentPromptStreamState {
  streamId: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  content: string;
  thinkingContent: string;
  toolUses: Array<{
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>;
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
    media?: ChatMediaBlock[];
    changedFiles?: AgentToolChangedFile[];
    browser?: AgentToolBrowserResult;
    edit?: AgentToolEditMetrics;
    mcp?: AgentToolMcpResult;
    artifacts?: AgentToolArtifact[];
  }>;
  stages: Array<{
    stageId: string;
    phase?: string;
    title: string;
    target: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    input?: Record<string, unknown>;
    summary?: string;
    errorMessage?: string;
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    errorCode?: string;
    suggestedAction?: string;
    recoveryActions?: RuntimeRecoveryAction[];
  }>;
  activityItems: Array<{
    id: string;
    type: 'tool' | 'stage' | 'context' | 'timeout';
    offset: number;
    status: 'running' | 'completed' | 'failed';
    title: string;
    summary?: string;
    toolUseIds?: string[];
    stageId?: string;
    createdAt: string;
  }>;
  agentCoreParts?: AgentCoreMessagePart[];
  pendingPermission?: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    impact?: AgentPermissionImpact;
  };
  pendingUserInput?: {
    requestId: string;
    title: string;
    question: string;
    detail?: string;
    options?: AgentUserInputOption[];
    multiSelect?: boolean;
    allowFreeText?: boolean;
    placeholder?: string;
  };
  phase: string;
  statusMessage: string;
  startedAt: string;
}

export function AgentChatView(props: {
  project: Project | null;
  provider: AiProvider | null;
  providers: AiProvider[];
  permissionMode: AgentPermissionMode;
  openablePaths: string[];
  defaultProviderId?: string;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionRuntimeId?: ProjectSessionRuntimeId;
  sessionEffort: ProjectSessionEffort;
  rewindSnapshotIds?: Record<string, string | undefined>;
  highlightMessageId?: string;
  highlightToken?: string;
  restoreNotice?: {
    checkpointNote: string;
    rolledBackCount: number;
  } | null;
  composerDraft: string;
  composerAttachments: PromptAttachment[];
  activePromptStream: AgentPromptStreamState | null;
  developerMode: boolean;
  composerError: string;
  queuedPrompts: QueuedPromptItem[];
  isSending: boolean;
  isExecutingPlan: boolean;
  onComposerChange: (value: string) => void;
  onPickAttachments: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSubmit: (content?: string) => void;
  onQueuePrompt: (content: string) => void;
  onRemoveQueuedPrompt: (promptId: string) => void;
  onCancelStream: () => void;
  onRespondPermission: (decision: 'allow' | 'allow_session' | 'deny') => void;
  onRespondUserInput: (response: AgentUserInputResponse) => void;
  onUpdateSessionRuntime: (runtime: {
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    effort?: ProjectSessionEffort;
  }) => void;
  onUpdatePermissionMode: (mode: AgentPermissionMode) => void;
  onOpenAppSettings: () => void;
  onOpenProjectAgentSettings: () => void;
  onOpenFilePath: (path: string) => void;
  onRestoreCheckpoint: (snapshotId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();

  const t = (zh: string, en: string): string => localize(language, zh, en);
  const visibleStream = props.activePromptStream?.phase === 'completed' ? null : props.activePromptStream;
  const runtimeTaskSummary = useMemo(() => {
    if (!visibleStream) {
      return null;
    }
    const resultsById = new Map(visibleStream.toolResults.map((result) => [result.toolUseId, result]));
    return buildRuntimeTaskSummaryFromTools(visibleStream.toolUses.map((tool) => ({
      name: tool.name,
      input: tool.input,
      resultContent: resultsById.get(tool.toolUseId)?.content
    })));
  }, [visibleStream]);

  const activeSession = useMemo(() => {
    if (!props.project) {
      return null;
    }
    return props.project.sessions.find((session) => session.id === props.project?.activeSessionId) ?? props.project.sessions[0] ?? null;
  }, [props.project]);
  const sessionMessages: ChatMessage[] = props.project ? activeSession?.chat ?? props.project.chat : EMPTY_CHAT_MESSAGES;
  const visibleStreamStatusMessage = getVisibleRuntimeStatusMessage(visibleStream?.statusMessage, props.developerMode, language);
  const activeModelLabel = props.provider?.model || t('本地规划器', 'Local Planner');
  const activeProviderLabel = props.provider?.name || 'Local';
  const contextUsageProvider = useMemo(() => props.provider
    ? {
        ...props.provider,
        model: props.sessionModel || props.provider.model
      }
    : null, [props.provider, props.sessionModel]);
  const contextUsage = useMemo(() => estimateCurrentSessionContextUsage({
    messages: sessionMessages,
    stream: visibleStream,
    draft: props.composerDraft,
    attachments: props.composerAttachments,
    modelLabel: props.sessionModel || activeModelLabel,
    provider: contextUsageProvider,
    language
  }), [
    activeModelLabel,
    contextUsageProvider,
    language,
    props.composerAttachments,
    props.composerDraft,
    props.sessionModel,
    sessionMessages,
    visibleStream
  ]);
  const engineConnection = useMemo<EngineConnectionSummary | undefined>(() => {
    const platform = props.project?.engine?.platform;
    if (!platform || platform === 'web') {
      return undefined;
    }

    const platformLabel = formatEnginePlatformLabel(platform);
    const runtimeState = props.project?.runtimeState;
    const status: EngineConnectionSummary['status'] = runtimeState?.bridgeHealth?.status === 'online'
      ? 'connected'
      : runtimeState
        ? 'disconnected'
        : 'unknown';
    const label = status === 'connected'
      ? t(`${platformLabel} 已连接`, `${platformLabel} connected`)
      : status === 'disconnected'
        ? t(`${platformLabel} 未连接`, `${platformLabel} disconnected`)
        : t(`${platformLabel} 连接状态未检测`, `${platformLabel} connection not checked`);

    return {
      platform,
      status,
      label
    };
  }, [props.project, t]);

  if (!props.project) {
    return (
      <div className="agent-workspace-shell">
        <section className="agent-column chat-primary-column">
          <div className="agent-empty-state minimal compact-style">
            <div className="agent-empty-copy">
              <strong>{t('暂无项目', 'No Project')}</strong>
              <span>{t('先从欢迎页创建一个新项目。', 'Create a new project from the welcome screen first.')}</span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const permissionLabel =
    props.permissionMode === 'full-access'
      ? t('Build', 'Build')
      : t('Plan', 'Plan');
  const emptyChatActions = buildEmptyChatActions(language, props.permissionMode);

  function handleSend(): void {
    const prompt = props.composerDraft.trim();
    if (!prompt && props.composerAttachments.length === 0) {
      return;
    }

    if (props.isSending) {
      props.onQueuePrompt(prompt || t('请查看附件并继续处理。', 'Please review the attachments and continue.'));
      props.onComposerChange('');
      return;
    }

    props.onComposerChange('');
    props.onSubmit(prompt);
  }

  return (
    <div className="agent-workspace-shell">
      <section className="agent-column chat-primary-column">
        <div className="agent-chat-shell">
          <div className="agent-chat-scroll-layer">
            <MessageList
              sessionId={activeSession?.id || ''}
              messages={sessionMessages}
              stream={
                visibleStream
                  ? {
                      prompt: visibleStream.prompt,
                      content: visibleStream.content,
                      thinkingContent: visibleStream.thinkingContent,
                      toolUses: visibleStream.toolUses,
                      toolResults: visibleStream.toolResults,
                      stages: visibleStream.stages,
                      activityItems: visibleStream.activityItems,
                      agentCoreParts: visibleStream.agentCoreParts,
                      pendingPermission: visibleStream.pendingPermission,
                      pendingUserInput: visibleStream.pendingUserInput,
                      statusMessage: visibleStreamStatusMessage || visibleStream.statusMessage
                    }
                  : null
              }
              developerMode={props.developerMode}
              searchQuery=""
              openablePaths={props.openablePaths}
              emptyActions={emptyChatActions}
              onSelectEmptyAction={props.onComposerChange}
              onOpenPath={props.onOpenFilePath}
              rewindSnapshotIds={props.rewindSnapshotIds}
              onRestoreCheckpoint={props.onRestoreCheckpoint}
              highlightMessageId={props.highlightMessageId}
              highlightToken={props.highlightToken}
              restoreNotice={props.restoreNotice}
            />
          </div>

          <div className="agent-chat-composer-layer">
            <div className="agent-chat-column">
              <ChatComposer
                draft={props.composerDraft}
                attachments={props.composerAttachments}
                contextUsage={contextUsage}
                error={props.composerError}
                queuedPrompts={props.queuedPrompts}
                isSending={props.isSending}
                isExecutingPlan={props.isExecutingPlan}
                statusMessage={visibleStreamStatusMessage}
                runtimeTaskSummary={runtimeTaskSummary}
                engineConnection={engineConnection}
                pendingPermission={visibleStream?.pendingPermission}
                pendingUserInput={visibleStream?.pendingUserInput}
                permissionContextLabel={`${props.project.name} · ${activeSession?.title || t('未命名会话', 'Untitled session')}${visibleStream ? ` · Run ${visibleStream.streamId}` : ''}`}
                permissionLabel={permissionLabel}
                activeProviderLabel={activeProviderLabel}
                providers={props.providers}
                defaultProviderId={props.defaultProviderId}
                activeProviderId={props.provider?.id}
                sessionProviderId={props.sessionProviderId}
                permissionMode={props.permissionMode}
                onDraftChange={props.onComposerChange}
                onPickAttachments={props.onPickAttachments}
                onRemoveAttachment={props.onRemoveAttachment}
                onSubmit={handleSend}
                onCancelStream={props.onCancelStream}
                onRespondPermission={props.onRespondPermission}
                onRespondUserInput={props.onRespondUserInput}
                onUpdateSessionRuntime={props.onUpdateSessionRuntime}
                onUpdatePermissionMode={props.onUpdatePermissionMode}
                onRemoveQueuedPrompt={props.onRemoveQueuedPrompt}
                onOpenAppSettings={props.onOpenAppSettings}
                onOpenProjectAgentSettings={props.onOpenProjectAgentSettings}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatEnginePlatformLabel(platform: Exclude<Project['engine'], undefined>['platform']): string {
  if (platform === 'unity') return 'Unity';
  if (platform === 'cocos') return 'Cocos';
  if (platform === 'godot') return 'Godot';
  if (platform === 'unreal') return 'Unreal';
  return 'Engine';
}

function estimateCurrentSessionContextUsage(input: {
  messages: ChatMessage[];
  stream: AgentPromptStreamState | null;
  draft: string;
  attachments: PromptAttachment[];
  modelLabel: string;
  provider: AiProvider | null;
  language: UiLanguage;
}): AgentContextUsageSummary {
  const sessionTokens = input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const streamTokens = input.stream ? estimateStreamTokens(input.stream) : 0;
  const draftTokens = estimateTextTokens(input.draft);
  const attachmentTokens = estimateAttachmentTokens(input.attachments);
  const tokenBudget = resolveContextTokenBudget(input.modelLabel, input.provider);
  const usedTokens = Math.max(0, sessionTokens + streamTokens + draftTokens + attachmentTokens);
  const budgetLabel = describeContextBudget({
    language: input.language,
    modelLabel: input.modelLabel,
    provider: input.provider,
    tokenBudget
  });

  return {
    usedTokens,
    tokenBudget,
    percent: tokenBudget > 0 ? usedTokens / tokenBudget : 0,
    sessionTokens,
    draftTokens,
    attachmentTokens,
    streamTokens,
    messageCount: input.messages.length + (input.stream ? 1 : 0),
    modelLabel: input.modelLabel || 'model',
    budgetLabel
  };
}

function buildEmptyChatActions(language: UiLanguage, permissionMode: AgentPermissionMode): EmptyChatAction[] {
  const buildMode = permissionMode === 'full-access';
  return [
    {
      id: 'continue-work',
      label: localize(language, '继续完成项目', 'Continue Project'),
      description: buildMode
        ? localize(language, '让 Agent 检查当前状态、补齐未完成实现并验证。', 'Ask Agent to inspect current state, finish missing work, and verify it.')
        : localize(language, '先只读梳理当前状态和下一步计划。', 'Read the current state and propose the next plan first.'),
      prompt: buildMode
        ? localize(language, '检查当前项目状态，继续完成未完成的实现。完成后运行必要验证，并总结实际改动。', 'Inspect the current project state, continue unfinished implementation, run necessary verification, and summarize actual changes.')
        : localize(language, '只读分析当前项目状态，列出未完成工作、风险和下一步实施计划。', 'Read-only analyze the current project state and list unfinished work, risks, and the next implementation plan.')
    },
    {
      id: 'setup-assets',
      label: localize(language, '整理资源目录', 'Organize Assets'),
      description: buildMode
        ? localize(language, '创建或整理图片、音频、字体和杂项资源结构。', 'Create or organize image, audio, font, and miscellaneous asset folders.')
        : localize(language, '先规划资源目录和命名规范，不写入文件。', 'Plan asset folders and naming conventions without writing files.'),
      prompt: buildMode
        ? localize(language, '在项目中整理资源目录：图片、音频、字体和杂项资源分别归类；如果目录缺失就创建，并更新项目记忆说明目录用途。', 'Organize project asset folders for images, audio, fonts, and miscellaneous assets; create missing folders and update project memory with their purpose.')
        : localize(language, '只读查看项目资源结构，给出图片、音频、字体和杂项资源的目录规划与命名建议。', 'Read-only inspect the project asset structure and propose folder and naming conventions for images, audio, fonts, and miscellaneous assets.')
    },
    {
      id: 'verify-run',
      label: localize(language, '运行验证', 'Verify Run'),
      description: localize(language, '找出可用启动/测试命令，执行前按权限策略处理。', 'Find available run/test commands and handle execution according to permission policy.'),
      prompt: localize(language, '检查这个项目可以如何运行和验证。优先使用 package scripts 或已知入口，执行必要命令后汇报结果、失败原因和下一步修复建议。', 'Check how this project can be run and verified. Prefer package scripts or known entrypoints, run necessary commands, then report results, failures, and next fixes.')
    },
    {
      id: 'research-plan',
      label: localize(language, '先做方案', 'Plan First'),
      description: localize(language, '适合复杂需求：先收集上下文，再给可执行方案。', 'Good for complex requests: gather context first, then produce an executable plan.'),
      prompt: localize(language, '先不要改文件。请分析当前项目结构和目标，必要时查找相关文件，给出分阶段实施计划、验收标准和潜在风险。', 'Do not modify files yet. Analyze the current project structure and goal, inspect relevant files if needed, then provide a staged implementation plan, acceptance criteria, and risks.')
    }
  ];
}

function estimateMessageTokens(message: ChatMessage): number {
  const signature = createMessageTokenEstimateSignature(message);
  const cachedObject = messageTokenEstimateByObject.get(message);
  if (cachedObject?.signature === signature) {
    return cachedObject.tokens;
  }
  const cachedSignature = messageTokenEstimateBySignature.get(signature);
  if (typeof cachedSignature === 'number') {
    messageTokenEstimateByObject.set(message, {
      signature,
      tokens: cachedSignature
    });
    return cachedSignature;
  }

  const tokens = estimateTextTokens(getMessageTextForTokenEstimate(message)) + 4;
  rememberTokenEstimate(messageTokenEstimateBySignature, signature, tokens);
  messageTokenEstimateByObject.set(message, {
    signature,
    tokens
  });
  return tokens;
}

function getMessageTextForTokenEstimate(message: ChatMessage): string {
  if (message.role === 'assistant' && message.metadata?.agentCoreParts?.length) {
    return agentCorePartsToPlainText(message.metadata.agentCoreParts);
  }

  return message.contentBlocks?.length
    ? message.contentBlocks.map(getBlockTextForTokenEstimate).filter(Boolean).join('\n\n')
    : message.content;
}

function getBlockTextForTokenEstimate(block: ChatContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'fallback':
      return block.text;
    case 'thinking':
      return block.thinking;
    case 'tool_use':
      return `${block.name}\n${block.input ? safeStringify(block.input) : ''}`;
    case 'tool_result':
      return [
        block.content,
        ...(block.media ?? []).map((media) => media.title || media.localPath || media.mimeType || media.type)
      ].filter(Boolean).join('\n');
    default:
      return '';
  }
}

function estimateStreamTokens(stream: AgentPromptStreamState): number {
  const signature = createStreamTokenEstimateSignature(stream);
  const cached = streamTokenEstimateBySignature.get(signature);
  if (typeof cached === 'number') {
    return cached;
  }

  const tokens = estimateTextTokens(getStreamTextForTokenEstimate(stream));
  rememberTokenEstimate(streamTokenEstimateBySignature, signature, tokens);
  return tokens;
}

function getStreamTextForTokenEstimate(stream: AgentPromptStreamState): string {
  if (stream.agentCoreParts?.length) {
    return [
      stream.prompt,
      agentCorePartsToPlainText(stream.agentCoreParts)
    ].filter(Boolean).join('\n\n');
  }

  return [
    stream.prompt,
    stream.content,
    stream.thinkingContent,
    ...stream.toolUses.map((tool) => `${tool.name}\n${tool.input ? safeStringify(tool.input) : ''}`),
    ...stream.toolResults.map((result) => result.content)
  ].filter(Boolean).join('\n\n');
}

function rememberTokenEstimate(cache: Map<string, number>, signature: string, tokens: number): void {
  cache.set(signature, tokens);
  while (cache.size > TOKEN_ESTIMATE_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) {
      return;
    }
    cache.delete(firstKey);
  }
}

function createMessageTokenEstimateSignature(message: ChatMessage): string {
  const contentSignature = message.role === 'assistant' && message.metadata?.agentCoreParts?.length
    ? createAgentCorePartsTokenEstimateSignature(message.metadata.agentCoreParts)
    : message.contentBlocks?.length
    ? message.contentBlocks.map(createBlockTokenEstimateSignature).join('|')
    : createTextTokenEstimateSignature(message.content);
  return [
    message.id,
    message.role,
    message.createdAt,
    contentSignature
  ].join(':');
}

function createAgentCorePartsTokenEstimateSignature(parts: AgentCoreMessagePart[]): string {
  return parts
    .map((part) => `${part.id}:${part.kind}:${part.sequence}:${part.createdAt}:${createUnknownTokenEstimateSignature(part)}`)
    .join('|');
}

function createBlockTokenEstimateSignature(block: ChatContentBlock): string {
  if (block.type === 'text') return `text:${createTextTokenEstimateSignature(block.text)}`;
  if (block.type === 'fallback') return `fallback:${createTextTokenEstimateSignature(block.text)}:${createTextTokenEstimateSignature(block.reason ?? '')}`;
  if (block.type === 'thinking') return `thinking:${createTextTokenEstimateSignature(block.thinking)}`;
  if (block.type === 'tool_use') return `tool_use:${block.toolUseId}:${block.name}:${createUnknownTokenEstimateSignature(block.input)}`;
  if (block.type === 'tool_result') {
    const mediaSignature = (block.media ?? [])
      .map((media) => `${media.type}:${media.mimeType ?? ''}:${createTextTokenEstimateSignature(media.title ?? '')}:${createTextTokenEstimateSignature(media.localPath ?? '')}`)
      .join(',');
    return `tool_result:${block.toolUseId}:${block.isError ? '1' : '0'}:${createTextTokenEstimateSignature(block.content)}:${mediaSignature}`;
  }
  return 'unknown';
}

function createStreamTokenEstimateSignature(stream: AgentPromptStreamState): string {
  if (stream.agentCoreParts?.length) {
    return [
      stream.streamId,
      createTextTokenEstimateSignature(stream.prompt),
      createAgentCorePartsTokenEstimateSignature(stream.agentCoreParts)
    ].join(':');
  }

  return [
    stream.streamId,
    createTextTokenEstimateSignature(stream.prompt),
    createTextTokenEstimateSignature(stream.content),
    createTextTokenEstimateSignature(stream.thinkingContent),
    stream.toolUses.map((tool) => `${tool.toolUseId}:${tool.name}:${tool.status}:${createUnknownTokenEstimateSignature(tool.input)}`).join('|'),
    stream.toolResults.map((result) => `${result.toolUseId}:${result.isError ? '1' : '0'}:${createTextTokenEstimateSignature(result.content)}`).join('|')
  ].join(':');
}

function createTextTokenEstimateSignature(value: string): string {
  return `${value.length}:${value.slice(0, 16)}:${value.slice(-16)}`;
}

function createUnknownTokenEstimateSignature(value: unknown, depth = 0): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return `s:${createTextTokenEstimateSignature(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) {
    if (depth >= 2) return `array:${value.length}`;
    return `array:${value.length}:${value.slice(0, 8).map((item) => createUnknownTokenEstimateSignature(item, depth + 1)).join(',')}`;
  }
  if (typeof value === 'object') {
    if (depth >= 2) return 'object';
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([key, item]) => `${key}:${createUnknownTokenEstimateSignature(item, depth + 1)}`)
      .join(',');
  }
  return typeof value;
}

function estimateAttachmentTokens(attachments: PromptAttachment[]): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind === 'image') {
      return total + 1600;
    }
    return total + Math.min(6000, Math.ceil(attachment.size / 6));
  }, 0);
}

function estimateTextTokens(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const asciiChars = [...trimmed].filter((char) => char.charCodeAt(0) <= 0x7f).length;
  const nonAsciiChars = trimmed.length - asciiChars;
  return Math.ceil(asciiChars / 3.8 + nonAsciiChars / 1.6);
}

function resolveContextTokenBudget(modelLabel: string, provider: AiProvider | null): number {
  const resolvedLimits = provider ? resolveProviderTokenLimits(provider) : null;
  if (resolvedLimits?.effectiveContextWindowTokens) {
    return resolvedLimits.effectiveContextWindowTokens;
  }
  const model = modelLabel.toLowerCase();
  if (model.includes('gemini-1.5') || model.includes('gemini-2.5')) {
    return 1_048_576;
  }
  if (model.includes('gpt-4.1')) {
    return 1_047_576;
  }
  if (model.includes('gpt-5.4')) {
    return 1_050_000;
  }
  if (model.includes('gpt-5')) {
    return 400_000;
  }
  if (model.includes('claude')) {
    return 200_000;
  }
  if (model.includes('glm-5.1') || model.includes('glm-4.6')) {
    return 200_000;
  }
  if (model.includes('mimo-v2.5-pro') || model.includes('mimo-v2.5')) {
    return 1_000_000;
  }
  if (model.includes('mimo-v2-pro')) {
    return 131_072;
  }
  if (model.includes('mimo-v2-flash')) {
    return 65_536;
  }
  if (model.includes('mimo-v2-omni')) {
    return 32_768;
  }
  if (model.includes('deepseek')) {
    return 1_000_000;
  }
  if (model.includes('qwen') || model.includes('llama')) {
    return 128_000;
  }
  return 128_000;
}

function describeContextBudget(input: {
  language: UiLanguage;
  modelLabel: string;
  provider: AiProvider | null;
  tokenBudget: number;
}): string {
  const resolvedLimits = input.provider ? resolveProviderTokenLimits(input.provider) : null;
  const matchedLabel = resolvedLimits?.displayName || resolvedLimits?.modelId || input.modelLabel;
  const formattedBudget = formatCompactTokenLimit(input.tokenBudget);
  if (resolvedLimits?.configuredContextWindowTokens) {
    return localize(
      input.language,
      `上下文窗口按 Provider 自定义 ${formattedBudget} 估算`,
      `context window uses provider custom ${formattedBudget}`
    );
  }
  if (resolvedLimits?.presetContextWindowTokens) {
    return localize(
      input.language,
      `上下文窗口按 ${matchedLabel} 预设 ${formattedBudget} 估算`,
      `context window uses ${matchedLabel} preset ${formattedBudget}`
    );
  }
  return localize(
    input.language,
    `模型窗口按 ${input.modelLabel} 估算`,
    `window estimated for ${input.modelLabel}`
  );
}

function formatCompactTokenLimit(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
