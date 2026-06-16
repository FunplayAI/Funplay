import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AgentPermissionMode,
  AgentUserInputResponse,
  AiProvider,
  ChatMessage,
  EnvironmentActionKind,
  EnvironmentActionResult,
  EnvironmentDiagnostics,
  PromptAttachment,
  Project,
  ProjectSessionEffort,
  ProjectSessionRuntimeId
} from '../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { ChatComposer, type EngineConnectionSummary, type QueuedPromptItem } from './ChatComposer';
import { MessageList, type EmptyChatAction } from './MessageList';
import { getVisibleRuntimeStatusMessage } from './runtime-display';
import { useSessionComposerStore } from '../../stores/sessionComposerStore';
import {
  buildRuntimeTaskSummaryFromAgentCoreParts,
  buildRuntimeTaskSummaryFromTools
} from './runtime-task-summary';
import type { AgentPromptStreamState } from './agent/agent-stream-state';
import { estimateCurrentSessionContextUsage } from './agent/context-estimate';
import { EngineStatusDialog, formatEnginePlatformLabel } from './agent/EngineStatusDialog';
import { Button } from '../ui/index';

export type { AgentPromptStreamState } from './agent/agent-stream-state';

const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_ATTACHMENTS: PromptAttachment[] = [];
const EMPTY_QUEUE: QueuedPromptItem[] = [];

export function AgentChatView(props: {
  project: Project | null;
  provider: AiProvider | null;
  providers: AiProvider[];
  permissionMode: AgentPermissionMode;
  openablePaths: string[];
  defaultProviderId?: string;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionEffort: ProjectSessionEffort;
  rewindSnapshotIds?: Record<string, string | undefined>;
  highlightMessageId?: string;
  highlightToken?: string;
  restoreNotice?: {
    checkpointNote: string;
    rolledBackCount: number;
  } | null;
  activePromptStream: AgentPromptStreamState | null;
  developerMode: boolean;
  isSending: boolean;
  onPickAttachments: () => void;
  onImportAttachments: (files: File[], source: 'paste' | 'drop') => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSubmit: (content?: string) => void;
  onCancelStream: () => void;
  onRespondPermission: (decision: 'allow' | 'allow_session' | 'deny') => void | Promise<unknown>;
  onRespondUserInput: (response: AgentUserInputResponse) => void | Promise<unknown>;
  onUpdateSessionRuntime: (runtime: {
    runtimeId?: ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    effort?: ProjectSessionEffort;
  }) => void;
  onUpdatePermissionMode: (mode: AgentPermissionMode) => void;
  onOpenAppSettings: () => void;
  onOpenProjectAgentSettings: () => void;
  onDiagnoseEnvironment: () => Promise<EnvironmentDiagnostics>;
  onRunEnvironmentAction: (actionId: EnvironmentActionKind) => Promise<EnvironmentActionResult>;
  onRefreshProjectRuntimeState: () => Promise<Project | null>;
  onOpenFilePath: (path: string) => void;
  onRestoreCheckpoint: (snapshotId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [engineStatusOpen, setEngineStatusOpen] = useState(false);
  const [engineDiagnostics, setEngineDiagnostics] = useState<EnvironmentDiagnostics | null>(null);
  const [engineStatusLoading, setEngineStatusLoading] = useState(false);
  const [engineActionId, setEngineActionId] = useState<EnvironmentActionKind | null>(null);
  const [engineStatusError, setEngineStatusError] = useState('');
  const [engineActionMessage, setEngineActionMessage] = useState('');

  const t = (zh: string, en: string): string => localize(language, zh, en);
  const visibleStream = props.activePromptStream?.phase === 'completed' ? null : props.activePromptStream;
  const runtimeTaskSummary = useMemo(() => {
    if (!visibleStream) {
      return null;
    }
    const agentCoreSummary = buildRuntimeTaskSummaryFromAgentCoreParts(visibleStream.agentCoreParts);
    if (agentCoreSummary) {
      return agentCoreSummary;
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
  // Per-session composer state is read directly from the session-composer store,
  // keyed by the active session id (equal to App's selectedSessionId), instead of
  // being drilled down as props.
  const composerSessionId = activeSession?.id ?? '';
  const composerDraft = useSessionComposerStore((store) => (composerSessionId ? store.drafts[composerSessionId] ?? '' : ''));
  const composerAttachments = useSessionComposerStore((store) =>
    composerSessionId ? store.attachments[composerSessionId] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS
  );
  const composerError = useSessionComposerStore((store) =>
    composerSessionId ? store.composerErrors[composerSessionId] ?? '' : ''
  );
  const queuedPrompts = useSessionComposerStore((store) =>
    composerSessionId ? store.queuedPrompts[composerSessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE
  );
  const updateDraft = useSessionComposerStore((store) => store.updateDraft);
  const queuePromptAction = useSessionComposerStore((store) => store.queuePrompt);
  const removeQueuedPromptAction = useSessionComposerStore((store) => store.removeQueuedPrompt);
  const handleComposerChange = (value: string): void => updateDraft(composerSessionId, value);
  const handleQueuePrompt = (content: string): void => queuePromptAction(composerSessionId, content);
  const handleRemoveQueuedPrompt = (promptId: string): void => removeQueuedPromptAction(composerSessionId, promptId);
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
    draft: composerDraft,
    attachments: composerAttachments,
    modelLabel: props.sessionModel || activeModelLabel,
    provider: contextUsageProvider,
    language
  }), [
    activeModelLabel,
    contextUsageProvider,
    language,
    composerAttachments,
    composerDraft,
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

  async function refreshEngineStatus(): Promise<void> {
    if (!props.project?.engine?.projectPath || props.project.engine.platform === 'web') {
      return;
    }
    setEngineStatusLoading(true);
    setEngineStatusError('');
    try {
      const diagnostics = await props.onDiagnoseEnvironment();
      setEngineDiagnostics(diagnostics);
      await props.onRefreshProjectRuntimeState().catch(() => null);
    } catch (error) {
      setEngineStatusError(error instanceof Error ? error.message : t('引擎状态检测失败。', 'Failed to inspect engine status.'));
    } finally {
      setEngineStatusLoading(false);
    }
  }

  async function runEngineAction(actionId: EnvironmentActionKind): Promise<void> {
    setEngineActionId(actionId);
    setEngineStatusError('');
    setEngineActionMessage('');
    try {
      const result = await props.onRunEnvironmentAction(actionId);
      setEngineActionMessage(result.message);
      await props.onRefreshProjectRuntimeState().catch(() => null);
      const diagnostics = await props.onDiagnoseEnvironment();
      setEngineDiagnostics(diagnostics);
    } catch (error) {
      setEngineStatusError(error instanceof Error ? error.message : t('引擎操作失败。', 'Engine action failed.'));
    } finally {
      setEngineActionId(null);
    }
  }

  useEffect(() => {
    if (!engineStatusOpen) {
      return;
    }
    void refreshEngineStatus();
  }, [engineStatusOpen, props.project?.id]);

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
    const prompt = composerDraft.trim();
    if (!prompt && composerAttachments.length === 0) {
      return;
    }

    if (!props.provider) {
      props.onOpenAppSettings();
      return;
    }

    // composer-2: attachment-only send used to silently inject synthetic text the user never
    // saw. Instead, prefill the draft with the editable fallback so the user reviews/edits it
    // and presses send again — never submitting or queuing text they didn't see.
    if (!prompt) {
      handleComposerChange(t('请查看附件并继续处理。', 'Please review the attachments and continue.'));
      return;
    }

    if (props.isSending) {
      handleQueuePrompt(prompt);
      handleComposerChange('');
      return;
    }

    handleComposerChange('');
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
                      attachments: visibleStream.attachments,
                      startedAt: visibleStream.startedAt,
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
              onSelectEmptyAction={handleComposerChange}
              onOpenPath={props.onOpenFilePath}
              rewindSnapshotIds={props.rewindSnapshotIds}
              onRestoreCheckpoint={props.onRestoreCheckpoint}
              highlightMessageId={props.highlightMessageId}
              highlightToken={props.highlightToken}
              restoreNotice={props.restoreNotice}
            />
          </div>

          <div className="agent-chat-composer-layer">
            {props.provider ? null : (
              <div className="agent-provider-gate" role="status">
                <span className="agent-provider-gate-text">
                  {t('还没配置 AI 模型，配置后即可开始对话。', 'No AI model configured yet — add one to start chatting.')}
                </span>
                <Button size="sm" variant="primary" onClick={props.onOpenAppSettings}>
                  {t('配置 AI 模型', 'Configure AI model')}
                </Button>
              </div>
            )}
            <div className="agent-chat-column">
              <ChatComposer
                draft={composerDraft}
                attachments={composerAttachments}
                contextUsage={contextUsage}
                error={composerError}
                queuedPrompts={queuedPrompts}
                isSending={props.isSending}
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
                onDraftChange={handleComposerChange}
                onPickAttachments={props.onPickAttachments}
                onImportAttachments={props.onImportAttachments}
                onRemoveAttachment={props.onRemoveAttachment}
                onSubmit={handleSend}
                onCancelStream={props.onCancelStream}
                onRespondPermission={props.onRespondPermission}
                onRespondUserInput={props.onRespondUserInput}
                onUpdateSessionRuntime={props.onUpdateSessionRuntime}
                onUpdatePermissionMode={props.onUpdatePermissionMode}
                onRemoveQueuedPrompt={handleRemoveQueuedPrompt}
                onOpenAppSettings={props.onOpenAppSettings}
                onOpenProjectAgentSettings={props.onOpenProjectAgentSettings}
                onOpenEngineStatus={() => setEngineStatusOpen(true)}
              />
            </div>
          </div>
        </div>
      </section>
      {engineStatusOpen ? (
        <EngineStatusDialog
          project={props.project}
          diagnostics={engineDiagnostics}
          loading={engineStatusLoading}
          actionId={engineActionId}
          error={engineStatusError}
          actionMessage={engineActionMessage}
          onClose={() => setEngineStatusOpen(false)}
          onRefresh={() => void refreshEngineStatus()}
          onRunAction={(actionId) => void runEngineAction(actionId)}
        />
      ) : null}
    </div>
  );
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
