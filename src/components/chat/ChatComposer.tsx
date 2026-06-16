import { useMemo, useState, type JSX, type PointerEvent } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import type { AgentPermissionImpact, AgentPermissionMode, AgentUserInputOption, AgentUserInputResponse, AiProvider, PromptAttachment } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button, IconButton, TextAreaControl } from '../ui/index';
import { AgentLiveStatus } from './AgentLiveStatus';
import { AgentPermissionCard, AgentUserInputCard } from './AgentPromptCards';
import { useComposerAttachmentDrop } from './composer-attachment-drop';
import { resolveComposerState, type RuntimeMenuKey } from './composer-state';
import { EngineConnectionIndicator, type EngineConnectionSummary } from './engine-connection-indicator';
import type { RuntimeTaskSummary } from './runtime-task-summary';
export type { ComposerState } from './composer-state';
export type { EngineConnectionSummary } from './engine-connection-indicator';

export interface QueuedPromptItem {
  id: string;
  content: string;
  // composer-8: marks queue items that were auto-generated (e.g. an attachment-only
  // synthetic fallback) rather than typed by the user, so they render distinctly.
  isSynthetic?: boolean;
}

export interface AgentContextUsageSummary {
  usedTokens: number;
  tokenBudget: number;
  percent: number;
  sessionTokens: number;
  draftTokens: number;
  attachmentTokens: number;
  streamTokens: number;
  messageCount: number;
  modelLabel: string;
  budgetLabel: string;
}

export function ChatComposer(props: {
  draft: string;
  attachments: PromptAttachment[];
  contextUsage: AgentContextUsageSummary;
  error: string;
  queuedPrompts: QueuedPromptItem[];
  isSending: boolean;
  statusMessage?: string;
  runtimeTaskSummary?: RuntimeTaskSummary | null;
  engineConnection?: EngineConnectionSummary;
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
  permissionContextLabel?: string;
  permissionLabel: string;
  activeProviderLabel: string;
  providers: AiProvider[];
  defaultProviderId?: string;
  activeProviderId?: string;
  sessionProviderId?: string;
  permissionMode: AgentPermissionMode;
  onDraftChange: (value: string) => void;
  onPickAttachments: () => void;
  onImportAttachments: (files: File[], source: 'paste' | 'drop') => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSubmit: () => void;
  onCancelStream: () => void;
  onRespondPermission: (decision: 'allow' | 'allow_session' | 'deny') => void | Promise<unknown>;
  onRespondUserInput: (response: AgentUserInputResponse) => void | Promise<unknown>;
  onUpdateSessionRuntime: (runtime: { providerId?: string }) => void;
  onUpdatePermissionMode: (mode: AgentPermissionMode) => void;
  onRemoveQueuedPrompt: (id: string) => void;
  onOpenAppSettings: () => void;
  onOpenProjectAgentSettings: () => void;
  onOpenEngineStatus?: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState<RuntimeMenuKey>(null);
  const attachmentDrop = useComposerAttachmentDrop(props.onImportAttachments);
  const defaultProviderId = props.defaultProviderId || props.activeProviderId || '';
  const normalizedSessionProviderId =
    props.sessionProviderId && props.sessionProviderId !== defaultProviderId ? props.sessionProviderId : undefined;
  const providerSelectValue = normalizedSessionProviderId || '';
  const providerOptions = useMemo(() => props.providers, [props.providers]);
  const overrideProviderOptions = useMemo(
    () => providerOptions.filter((provider) => !defaultProviderId || provider.id !== defaultProviderId),
    [defaultProviderId, providerOptions]
  );
  const providerDisplayLabel = providerSelectValue
    ? providerOptions.find((provider) => provider.id === providerSelectValue)?.name ?? props.activeProviderLabel
    : localize(language, `默认 · ${props.activeProviderLabel}`, `Default · ${props.activeProviderLabel}`);
  const permissionOptions: Array<{ value: AgentPermissionMode; label: string }> = [
    { value: 'full-access', label: localize(language, 'Build', 'Build') },
    { value: 'read-only', label: localize(language, 'Plan', 'Plan') }
  ];
  const slashCommands = useMemo(() => [
    {
      command: '/files',
      title: localize(language, '扫描文件树', 'Scan file tree'),
      prompt: localize(language, '请扫描当前项目文件树，并总结最重要的目录和文件。', 'Scan the current project file tree and summarize the most important folders and files.')
    },
    {
      command: '/context',
      title: localize(language, '总结上下文', 'Summarize context'),
      prompt: localize(language, '请基于当前项目、最近会话和可用工具，总结我们现在的上下文和下一步。', 'Summarize the current project context, recent conversation, available tools, and next step.')
    },
    {
      command: '/fix',
      title: localize(language, '定位并修复', 'Diagnose and fix'),
      prompt: localize(language, '请先定位问题，再读取必要文件，最后给出或执行最小修复。', 'Diagnose the issue first, read necessary files, then propose or apply the smallest fix.')
    }
  ], [language]);
  const showSlashCommands = slashPopoverOpen || props.draft.trim().startsWith('/');
  const canSubmit = Boolean(props.draft.trim() || props.attachments.length > 0);
  const activePermissionLabel = permissionOptions.find((option) => option.value === props.permissionMode)?.label ?? props.permissionLabel;
  const contextUsagePercent = Math.min(0.96, Math.max(0, props.contextUsage.percent));
  const awaitingUserInput = Boolean(props.pendingUserInput);
  const composerState = resolveComposerState({
    draft: props.draft,
    attachments: props.attachments,
    isSending: props.isSending,
    queuedPrompts: props.queuedPrompts,
    pendingPermission: props.pendingPermission,
    pendingUserInput: props.pendingUserInput,
    runtimeMenuOpen
  });
  const contextUsageLabel = localize(
    language,
    `当前 session 上下文约 ${Math.round(contextUsagePercent * 100)}%`,
    `Current session context about ${Math.round(contextUsagePercent * 100)}%`
  );
  const contextTokenBudget = props.contextUsage.tokenBudget;
  const contextUsedTokens = props.contextUsage.usedTokens;
  // composer-7: a pending prompt must be answered before the stream can be stopped.
  const hasPendingPrompt = Boolean(props.pendingPermission || props.pendingUserInput);

  function applySlashCommand(prompt: string): void {
    props.onDraftChange(prompt);
    setSlashPopoverOpen(false);
  }

  function toggleRuntimeMenu(key: Exclude<RuntimeMenuKey, null>): void {
    setRuntimeMenuOpen((current) => current === key ? null : key);
  }

  function selectProvider(providerId: string): void {
    props.onUpdateSessionRuntime({
      providerId: providerId && providerId !== defaultProviderId ? providerId : undefined
    });
    setRuntimeMenuOpen(null);
  }

  function selectPermission(permissionMode: AgentPermissionMode): void {
    props.onUpdatePermissionMode(permissionMode);
    setRuntimeMenuOpen(null);
  }

  function closeMenuFromComposerSurface(event: PointerEvent<HTMLDivElement>): void {
    if (!runtimeMenuOpen) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '.agent-plus-menu, .agent-agent-menu, .agent-runtime-menu, .agent-composer-icon-button, .agent-permission-trigger, .agent-combo-trigger, .agent-engine-connection-indicator'
      )
    ) {
      return;
    }
    setRuntimeMenuOpen(null);
  }

  return (
    <div className={`agent-input-shell ${runtimeMenuOpen ? 'menu-open' : ''}`} data-composer-state={composerState}>
      {runtimeMenuOpen ? (
        <Button
          size="compact"
          variant="ghost"
          className="agent-menu-dismiss-layer"
          onClick={() => setRuntimeMenuOpen(null)}
          aria-label={localize(language, '关闭菜单', 'Close menu')}
        />
      ) : null}

      <div className={`agent-composer-status-stack ${awaitingUserInput ? 'awaiting-user-input' : ''}`}>
        {props.queuedPrompts.length > 0 ? (
          <div className="agent-queue-stack">
            {props.queuedPrompts.map((item, index) => (
              <div key={item.id} className={`agent-queue-item ${item.isSynthetic ? 'is-synthetic' : ''}`}>
                <div className="agent-queue-copy">
                  <strong>
                    {localize(language, `排队消息 ${index + 1}`, `Queued ${index + 1}`)}
                    {item.isSynthetic ? localize(language, ' (自动)', ' (auto)') : ''}
                  </strong>
                  <span style={item.isSynthetic ? { fontStyle: 'italic' } : undefined}>{item.content}</span>
                </div>
                <IconButton
                  className="agent-queue-remove"
                  icon={<X size={13} aria-hidden="true" />}
                  label={localize(language, '移除排队消息', 'Remove queued prompt')}
                  onClick={() => props.onRemoveQueuedPrompt(item.id)}
                />
              </div>
            ))}
          </div>
        ) : null}

        {props.isSending ? (
          <AgentLiveStatus
            message={props.statusMessage || localize(language, 'AI 正在生成回复…', 'AI is generating a reply…')}
            taskSummary={props.runtimeTaskSummary}
            compactTaskSummary={awaitingUserInput}
            cancelDisabled={hasPendingPrompt}
            onCancel={props.onCancelStream}
          />
        ) : null}

        {props.pendingPermission ? (
          <AgentPermissionCard
            pending={props.pendingPermission}
            contextLabel={props.permissionContextLabel}
            onRespond={props.onRespondPermission}
          />
        ) : null}

        {props.pendingUserInput ? (
          <AgentUserInputCard pending={props.pendingUserInput} onRespond={props.onRespondUserInput} />
        ) : null}

        {props.error ? <div className="agent-composer-error">{props.error}</div> : null}
      </div>

      {showSlashCommands ? (
        <div className="agent-command-popover">
          {slashCommands.map((command) => (
            <Button key={command.command} size="compact" variant="ghost" onClick={() => applySlashCommand(command.prompt)}>
              <strong>{command.command}</strong>
              <span>{command.title}</span>
            </Button>
          ))}
        </div>
      ) : null}

      <div
        className="agent-composer-shell"
        onPointerDownCapture={closeMenuFromComposerSurface}
        {...attachmentDrop.dropProps}
      >
        {attachmentDrop.attachmentDropActive ? (
          <div className="agent-composer-drop-overlay" aria-hidden="true">
            <strong>{localize(language, '松开添加附件', 'Drop to attach')}</strong>
            <span>{localize(language, '图片和文件会随本轮请求一起发送', 'Images and files will be sent with this request')}</span>
          </div>
        ) : null}
        {props.attachments.length > 0 ? (
          <div className="agent-composer-attachment-stack">
            {props.attachments.map((attachment) => (
              <Button key={attachment.id} size="compact" variant="ghost" className={`agent-file-chip ${attachment.kind}`} onClick={() => props.onRemoveAttachment(attachment.id)}>
                {attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt="" /> : null}
                <span>{attachment.name}</span>
                <em>×</em>
              </Button>
            ))}
          </div>
        ) : null}

        <div className="agent-composer-main">
          <TextAreaControl
            className="agent-composer-textarea"
            value={props.draft}
            onValueChange={props.onDraftChange}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
            {...attachmentDrop.pasteProps}
            placeholder={localize(language, '要求后续变更', 'Request follow-up changes')}
          />
        </div>

        <div className="agent-composer-footer">
          <div className="agent-composer-left-controls">
            <div className="agent-plus-control">
              <IconButton
                className="agent-composer-icon-button"
                icon={<Paperclip size={17} aria-hidden="true" />}
                label={localize(language, '添加附件', 'Add attachments')}
                onClick={() => toggleRuntimeMenu('plus')}
              />
              {runtimeMenuOpen === 'plus' ? (
                <div className="agent-plus-menu">
                  <div className="agent-context-picker-panel">
                    <div className="agent-menu-section-title">{localize(language, '附件', 'Attachments')}</div>
                    <Button className="agent-context-upload-button" variant="ghost" onClick={props.onPickAttachments}>
                      <strong>{localize(language, '选择文件或图片', 'Choose files or images')}</strong>
                      <span>{localize(language, '随本轮请求一起发送', 'Send with this request')}</span>
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="agent-permission-control">
              <Button
                className={`agent-permission-trigger ${props.permissionMode}`}
                variant="ghost"
                size="sm"
                trailingIcon={<ChevronDownIcon className="agent-chevron-icon" />}
                title={props.isSending ? localize(language, '切换模式将在下一轮运行生效，不影响当前进行中的回复。', 'Switching mode applies to the next run; it does not affect the in-flight reply.') : undefined}
                onClick={() => toggleRuntimeMenu('permission')}
              >
                {activePermissionLabel}
              </Button>
              {runtimeMenuOpen === 'permission' ? (
                <div className="agent-runtime-menu permission-menu">
                  {permissionOptions.map((option) => (
                    <Button
                      key={option.value}
                      variant="ghost"
                      className={props.permissionMode === option.value ? 'selected' : ''}
                      title={props.isSending ? localize(language, '下一轮运行生效', 'Applies to the next run') : undefined}
                      onClick={() => selectPermission(option.value)}
                    >
                      <strong>{option.label}</strong>
                      {props.isSending ? <span>{localize(language, '下一轮运行生效', 'Applies to the next run')}</span> : null}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            {props.engineConnection ? (
              <EngineConnectionIndicator
                connection={props.engineConnection}
                onOpen={() => {
                  setRuntimeMenuOpen(null);
                  props.onOpenEngineStatus?.();
                }}
              />
            ) : null}
          </div>

          <div className="agent-composer-right-controls">
            <div className="agent-context-ring-wrap">
              <div
                className="agent-context-ring"
                style={{ background: `conic-gradient(var(--brand) ${Math.round(contextUsagePercent * 360)}deg, rgba(148, 163, 184, 0.24) 0deg)` }}
                aria-label={contextUsageLabel}
              >
                <span />
              </div>
              <div className="agent-context-popover" role="tooltip">
                <span>{localize(language, '当前 session 上下文：', 'Current session context:')}</span>
                <strong>{localize(language, `${Math.round(contextUsagePercent * 100)}% 已用`, `${Math.round(contextUsagePercent * 100)}% used`)}</strong>
                <em>
                  {localize(
                    language,
                    `已用 ${formatTokenCount(contextUsedTokens)} 标记，共 ${formatTokenCount(contextTokenBudget)}`,
                    `${formatTokenCount(contextUsedTokens)} tokens used of ${formatTokenCount(contextTokenBudget)}`
                  )}
                </em>
                <em>
                  {localize(
                    language,
                    `会话 ${formatTokenCount(props.contextUsage.sessionTokens)} · 当前回复 ${formatTokenCount(props.contextUsage.streamTokens)} · 草稿 ${formatTokenCount(props.contextUsage.draftTokens)} · 附件 ${formatTokenCount(props.contextUsage.attachmentTokens)}`,
                    `Session ${formatTokenCount(props.contextUsage.sessionTokens)} · Stream ${formatTokenCount(props.contextUsage.streamTokens)} · Draft ${formatTokenCount(props.contextUsage.draftTokens)} · Attachments ${formatTokenCount(props.contextUsage.attachmentTokens)}`
                  )}
                </em>
                <b>
                  {localize(
                    language,
                    `${props.contextUsage.messageCount} 条消息，仅统计当前 session；${props.contextUsage.budgetLabel}`,
                    `${props.contextUsage.messageCount} messages, current session only; ${props.contextUsage.budgetLabel}`
                  )}
                </b>
              </div>
            </div>
            <div className="agent-combo-control">
              <Button
                className="agent-combo-trigger"
                variant="secondary"
                title={props.isSending ? localize(language, '切换 Provider 将在下一轮运行生效，不影响当前进行中的回复。', 'Switching provider applies to the next run; it does not affect the in-flight reply.') : undefined}
                onClick={() => toggleRuntimeMenu('agent')}
              >
                <strong>{providerDisplayLabel}</strong>
                <em>Provider</em>
                <ChevronDownIcon className="agent-combo-chevron" />
              </Button>
              {runtimeMenuOpen === 'agent' ? (
                <div className="agent-agent-menu">
                  <div className="agent-menu-section">
                    <div className="agent-menu-section-title">
                      Provider{props.isSending ? ` · ${localize(language, '下一轮运行生效', 'Applies to next run')}` : ''}
                    </div>
                    <div className="agent-menu-option-list">
                      <Button variant="ghost" onClick={props.onOpenAppSettings}>
                        <strong>{localize(language, '管理 Provider', 'Manage providers')}</strong>
                        <span>{localize(language, '配置模型服务和默认模型', 'Configure model services and defaults')}</span>
                      </Button>
                      <Button variant="ghost" onClick={props.onOpenProjectAgentSettings}>
                        <strong>{localize(language, '会话运行设置', 'Session runtime settings')}</strong>
                        <span>{localize(language, '模型、Runtime、模式', 'Model, runtime, mode')}</span>
                      </Button>
                      <Button variant="ghost" className={!providerSelectValue ? 'selected' : ''} onClick={() => selectProvider('')}>
                        <strong>{localize(language, '跟随默认', 'Use Default')}</strong>
                        <span>{props.activeProviderLabel}</span>
                      </Button>
                      {overrideProviderOptions.map((provider) => (
                        <Button key={provider.id} variant="ghost" className={providerSelectValue === provider.id ? 'selected' : ''} onClick={() => selectProvider(provider.id)}>
                          <strong>{provider.name}</strong>
                          <span>{provider.model}</span>
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <Button className="send-button agent-send-button" variant="primary" onClick={props.onSubmit} disabled={!canSubmit} aria-label={localize(language, '发送消息', 'Send message')}>
              {props.isSending ? <Square size={14} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronDownIcon(props: { className: string }): JSX.Element {
  return (
    <svg className={props.className} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M5.5 7.75L10 12.25L14.5 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return `${value}`;
}
