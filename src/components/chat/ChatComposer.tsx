import { useEffect, useMemo, useState, type JSX, type PointerEvent } from 'react';
import type { AgentPermissionImpact, AgentPermissionMode, AgentUserInputOption, AgentUserInputResponse, AiProvider, PlatformChoice, PromptAttachment } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { RuntimeTaskStatus, RuntimeTaskSummary } from './runtime-task-summary';

export interface QueuedPromptItem {
  id: string;
  content: string;
}

type RuntimeMenuKey = 'agent' | 'plus' | 'permission' | null;

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

export interface EngineConnectionSummary {
  platform: Exclude<PlatformChoice, 'web'>;
  status: 'connected' | 'disconnected' | 'unknown';
  label: string;
}

export function ChatComposer(props: {
  draft: string;
  attachments: PromptAttachment[];
  contextUsage: AgentContextUsageSummary;
  error: string;
  queuedPrompts: QueuedPromptItem[];
  isSending: boolean;
  isExecutingPlan: boolean;
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
  onRemoveAttachment: (attachmentId: string) => void;
  onSubmit: () => void;
  onCancelStream: () => void;
  onRespondPermission: (decision: 'allow' | 'allow_session' | 'deny') => void;
  onRespondUserInput: (response: AgentUserInputResponse) => void;
  onUpdateSessionRuntime: (runtime: { providerId?: string }) => void;
  onUpdatePermissionMode: (mode: AgentPermissionMode) => void;
  onRemoveQueuedPrompt: (id: string) => void;
  onOpenAppSettings: () => void;
  onOpenProjectAgentSettings: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [slashPopoverOpen, setSlashPopoverOpen] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState<RuntimeMenuKey>(null);
  const [userInputDraft, setUserInputDraft] = useState('');
  const [selectedUserInputOptionIds, setSelectedUserInputOptionIds] = useState<string[]>([]);
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
  const contextUsageLabel = localize(
    language,
    `当前 session 上下文约 ${Math.round(contextUsagePercent * 100)}%`,
    `Current session context about ${Math.round(contextUsagePercent * 100)}%`
  );
  const contextTokenBudget = props.contextUsage.tokenBudget;
  const contextUsedTokens = props.contextUsage.usedTokens;

  useEffect(() => {
    setUserInputDraft('');
    setSelectedUserInputOptionIds([]);
  }, [props.pendingUserInput?.requestId]);

  function toggleUserInputOption(optionId: string): void {
    if (props.pendingUserInput?.multiSelect) {
      setSelectedUserInputOptionIds((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
      );
      return;
    }

    setSelectedUserInputOptionIds([optionId]);
  }

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

  function submitUserInput(cancelled = false): void {
    if (!props.pendingUserInput) {
      return;
    }

    if (cancelled) {
      props.onRespondUserInput({
        answer: '',
        cancelled: true
      });
      return;
    }

    const selectedOptions = props.pendingUserInput.options?.filter((option) => selectedUserInputOptionIds.includes(option.id)) ?? [];
    const selectedAnswer = selectedOptions.map((option) => option.label).join(', ');
    const draftAnswer = userInputDraft.trim();
    const answer = [selectedAnswer, draftAnswer].filter(Boolean).join(draftAnswer && selectedAnswer ? '\n' : '');
    if (!answer) {
      return;
    }

    props.onRespondUserInput({
      answer,
      optionId: selectedOptions[0]?.id,
      optionIds: selectedOptions.length > 0 ? selectedOptions.map((option) => option.id) : undefined
    });
  }

  function closeMenuFromComposerSurface(event: PointerEvent<HTMLDivElement>): void {
    if (!runtimeMenuOpen) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '.agent-plus-menu, .agent-agent-menu, .agent-runtime-menu, .agent-composer-icon-button, .agent-permission-trigger, .agent-combo-trigger'
      )
    ) {
      return;
    }
    setRuntimeMenuOpen(null);
  }

  return (
    <div className={`agent-input-shell ${runtimeMenuOpen ? 'menu-open' : ''}`}>
      {runtimeMenuOpen ? (
        <button
          className="agent-menu-dismiss-layer"
          onClick={() => setRuntimeMenuOpen(null)}
          aria-label={localize(language, '关闭菜单', 'Close menu')}
        />
      ) : null}

      <div className={`agent-composer-status-stack ${awaitingUserInput ? 'awaiting-user-input' : ''}`}>
        {props.queuedPrompts.length > 0 ? (
          <div className="agent-queue-stack">
            {props.queuedPrompts.map((item, index) => (
              <div key={item.id} className="agent-queue-item">
                <div className="agent-queue-copy">
                  <strong>{localize(language, `排队消息 ${index + 1}`, `Queued ${index + 1}`)}</strong>
                  <span>{item.content}</span>
                </div>
                <button className="agent-queue-remove" onClick={() => props.onRemoveQueuedPrompt(item.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {props.isExecutingPlan ? (
          <AgentLiveStatus
            message={localize(language, 'Agent 正在执行当前计划', 'Agent is running the current plan')}
            detail={localize(language, '运行反馈会在会话中更新。', 'Runtime feedback will update in the session.')}
          />
        ) : null}

        {props.isSending ? (
          <AgentLiveStatus
            message={props.statusMessage || localize(language, 'AI 正在生成回复…', 'AI is generating a reply…')}
            detail={localize(language, '工具调用、任务状态和回复内容会持续更新。', 'Tool calls, task states, and reply content will keep updating.')}
            taskSummary={props.runtimeTaskSummary}
            compactTaskSummary={awaitingUserInput}
            onCancel={props.onCancelStream}
          />
        ) : null}

        {props.pendingPermission ? (
          <div className={`agent-permission-card ${props.pendingPermission.risk}`}>
            <div className="agent-permission-copy">
              <strong>{props.pendingPermission.title}</strong>
              {props.permissionContextLabel ? <em>{props.permissionContextLabel}</em> : null}
              <span>{props.pendingPermission.detail}</span>
              <PermissionImpactSummary impact={props.pendingPermission.impact} />
            </div>
            <div className="agent-permission-actions">
              <button className="prototype-secondary small" onClick={() => props.onRespondPermission('deny')}>
                {localize(language, '拒绝', 'Deny')}
              </button>
              <button className="prototype-secondary small" onClick={() => props.onRespondPermission('allow_session')}>
                {localize(language, '允许本会话', 'Allow Session')}
              </button>
              <button className="prototype-primary small" onClick={() => props.onRespondPermission('allow')}>
                {localize(language, '允许本次', 'Allow Once')}
              </button>
            </div>
          </div>
        ) : null}

        {props.pendingUserInput ? (
          <div className="agent-user-input-card">
            <div className="agent-user-input-scroll">
              <div className="agent-permission-copy">
                <strong>{props.pendingUserInput.title}</strong>
                <span>{props.pendingUserInput.question}</span>
                {props.pendingUserInput.detail ? <em>{props.pendingUserInput.detail}</em> : null}
              </div>
              {props.pendingUserInput.options?.length ? (
                <div className="agent-user-input-options">
                  {props.pendingUserInput.options.map((option) => (
                    <button
                      key={option.id}
                      className={selectedUserInputOptionIds.includes(option.id) ? 'selected' : ''}
                      onClick={() => toggleUserInputOption(option.id)}
                    >
                      <strong>{option.label}</strong>
                      {option.description ? <span>{option.description}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {props.pendingUserInput.allowFreeText !== false ? (
                <textarea
                  className="agent-user-input-textarea"
                  value={userInputDraft}
                  onChange={(event) => setUserInputDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      submitUserInput();
                    }
                  }}
                  placeholder={props.pendingUserInput.placeholder || localize(language, '输入你的回答…', 'Enter your answer…')}
                />
              ) : null}
            </div>
            <div className="agent-permission-actions agent-user-input-actions">
              <button className="prototype-secondary small" onClick={() => submitUserInput(true)}>
                {localize(language, '取消', 'Cancel')}
              </button>
              <button
                className="prototype-primary small"
                onClick={() => submitUserInput()}
                disabled={!userInputDraft.trim() && selectedUserInputOptionIds.length === 0}
              >
                {localize(language, '提交回答', 'Submit Answer')}
              </button>
            </div>
          </div>
        ) : null}

        {props.error ? <div className="agent-composer-error">{props.error}</div> : null}
      </div>

      {showSlashCommands ? (
        <div className="agent-command-popover">
          {slashCommands.map((command) => (
            <button key={command.command} onClick={() => applySlashCommand(command.prompt)}>
              <strong>{command.command}</strong>
              <span>{command.title}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="agent-composer-shell" onPointerDownCapture={closeMenuFromComposerSurface}>
        {props.attachments.length > 0 ? (
          <div className="agent-composer-attachment-stack">
            {props.attachments.map((attachment) => (
              <button key={attachment.id} className={`agent-file-chip ${attachment.kind}`} onClick={() => props.onRemoveAttachment(attachment.id)}>
                {attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt="" /> : null}
                <span>{attachment.name}</span>
                <em>×</em>
              </button>
            ))}
          </div>
        ) : null}

        <div className="agent-composer-main">
          <textarea
            className="agent-composer-textarea"
            value={props.draft}
            onChange={(event) => props.onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
            placeholder={localize(language, '要求后续变更', 'Request follow-up changes')}
          />
        </div>

        <div className="agent-composer-footer">
          <div className="agent-composer-left-controls">
            <div className="agent-plus-control">
              <button
                className="agent-composer-icon-button"
                onClick={() => toggleRuntimeMenu('plus')}
                aria-label={localize(language, '添加附件', 'Add attachments')}
              >
                <PlusIcon className="agent-plus-icon" />
              </button>
              {runtimeMenuOpen === 'plus' ? (
                <div className="agent-plus-menu">
                  <div className="agent-context-picker-panel">
                    <div className="agent-menu-section-title">{localize(language, '附件', 'Attachments')}</div>
                    <button className="agent-context-upload-button" onClick={props.onPickAttachments}>
                      <strong>{localize(language, '选择文件或图片', 'Choose files or images')}</strong>
                      <span>{localize(language, '随本轮请求一起发送', 'Send with this request')}</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="agent-permission-control">
              <button className={`agent-permission-trigger ${props.permissionMode}`} onClick={() => toggleRuntimeMenu('permission')}>
                <strong>{activePermissionLabel}</strong>
                <ChevronDownIcon className="agent-chevron-icon" />
              </button>
              {runtimeMenuOpen === 'permission' ? (
                <div className="agent-runtime-menu permission-menu">
                  {permissionOptions.map((option) => (
                    <button key={option.value} className={props.permissionMode === option.value ? 'selected' : ''} onClick={() => selectPermission(option.value)}>
                      <strong>{option.label}</strong>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {props.engineConnection ? <EngineConnectionIndicator connection={props.engineConnection} /> : null}
          </div>

          <div className="agent-composer-right-controls">
            <div className="agent-context-ring-wrap">
              <div
                className="agent-context-ring"
                style={{ background: `conic-gradient(var(--brand) ${Math.round(contextUsagePercent * 360)}deg, rgba(148, 163, 184, 0.24) 0deg)` }}
                aria-label={contextUsageLabel}
                tabIndex={0}
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
              <button className="agent-combo-trigger" onClick={() => toggleRuntimeMenu('agent')}>
                <strong>{providerDisplayLabel}</strong>
                <em>Provider</em>
                <ChevronDownIcon className="agent-combo-chevron" />
              </button>
              {runtimeMenuOpen === 'agent' ? (
                <div className="agent-agent-menu">
                  <div className="agent-menu-section">
                    <div className="agent-menu-section-title">Provider</div>
                    <div className="agent-menu-option-list">
                      <button onClick={props.onOpenAppSettings}>
                        <strong>{localize(language, '管理 Provider', 'Manage providers')}</strong>
                        <span>{localize(language, '配置模型服务和默认模型', 'Configure model services and defaults')}</span>
                      </button>
                      <button onClick={props.onOpenProjectAgentSettings}>
                        <strong>{localize(language, '会话运行设置', 'Session runtime settings')}</strong>
                        <span>{localize(language, '模型、Runtime、模式', 'Model, runtime, mode')}</span>
                      </button>
                      <button className={!providerSelectValue ? 'selected' : ''} onClick={() => selectProvider('')}>
                        <strong>{localize(language, '跟随默认', 'Use Default')}</strong>
                        <span>{props.activeProviderLabel}</span>
                      </button>
                      {overrideProviderOptions.map((provider) => (
                        <button key={provider.id} className={providerSelectValue === provider.id ? 'selected' : ''} onClick={() => selectProvider(provider.id)}>
                          <strong>{provider.name}</strong>
                          <span>{provider.model}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <button className="send-button agent-send-button" onClick={props.onSubmit} disabled={!canSubmit}>
              {props.isSending ? '+' : '↑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EngineConnectionIndicator(props: { connection: EngineConnectionSummary }): JSX.Element {
  return (
    <span
      className={`agent-engine-connection-indicator ${props.connection.platform} ${props.connection.status}`}
      title={props.connection.label}
      aria-label={props.connection.label}
      role="status"
    >
      <EngineIcon platform={props.connection.platform} />
      <span className={`agent-engine-connection-dot ${props.connection.status}`} aria-hidden="true" />
    </span>
  );
}

function EngineIcon(props: { platform: EngineConnectionSummary['platform'] }): JSX.Element {
  if (props.platform === 'unity') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M12 3.5L19 7.55V16.45L12 20.5L5 16.45V7.55L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 3.8V11.9M19 7.7L12 11.9M5 7.7L12 11.9M12 20.2V11.9" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      </svg>
    );
  }

  if (props.platform === 'cocos') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M12 3.8L19.1 7.9V16.1L12 20.2L4.9 16.1V7.9L12 3.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M14.9 9.2C14.1 8.45 13.12 8.05 12 8.05C9.78 8.05 8.05 9.78 8.05 12C8.05 14.22 9.78 15.95 12 15.95C13.12 15.95 14.1 15.55 14.9 14.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (props.platform === 'godot') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M5.2 10.4L7.2 7.8L9.4 9.1L12 6.5L14.6 9.1L16.8 7.8L18.8 10.4V17.2C17.2 19 14.85 20 12 20C9.15 20 6.8 19 5.2 17.2V10.4Z" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
        <path d="M9.3 13.2H9.32M14.7 13.2H14.72" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M10.2 16.2C11.15 16.85 12.85 16.85 13.8 16.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6.4 4.8V12.6C6.4 16.55 8.55 19.2 12 19.2C15.45 19.2 17.6 16.55 17.6 12.6V4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M9.15 4.8V12.7C9.15 14.65 10.2 15.95 12 15.95C13.8 15.95 14.85 14.65 14.85 12.7V4.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function AgentLiveStatus(props: {
  message: string;
  detail?: string;
  taskSummary?: RuntimeTaskSummary | null;
  compactTaskSummary?: boolean;
  onCancel?: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const taskSummary = props.taskSummary;
  const visibleTaskItems = props.compactTaskSummary
    ? []
    : taskSummary?.items ?? [];
  const taskSummaryLabel = taskSummary
    ? localize(
        language,
        `${taskSummary.completed}/${taskSummary.total} 完成 · ${taskSummary.inProgress} 进行中`,
        `${taskSummary.completed}/${taskSummary.total} done · ${taskSummary.inProgress} running`
      )
    : '';

  return (
    <div className={`agent-live-status ${props.compactTaskSummary ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="agent-live-status-main">
        <span className="agent-live-spinner" aria-hidden="true">
          <span />
        </span>
        <span className="agent-live-copy">
          <strong>{props.message}</strong>
          {props.detail ? <em>{props.detail}</em> : null}
        </span>
        {props.compactTaskSummary && taskSummaryLabel ? (
          <span className="agent-live-task-pill">{taskSummaryLabel}</span>
        ) : null}
        <span className="agent-live-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {props.onCancel ? (
          <button className="prototype-secondary small" onClick={props.onCancel}>
            {localize(language, '停止', 'Stop')}
          </button>
        ) : null}
      </div>
      {taskSummary && visibleTaskItems.length > 0 ? (
        <div className="agent-live-task-panel" aria-label={localize(language, '任务清单', 'Task list')}>
          <div className="agent-live-task-header">
            <strong>{localize(language, '任务清单', 'Task list')}</strong>
            <span>{taskSummaryLabel}</span>
          </div>
          <div className="agent-live-task-list">
            {visibleTaskItems.map((item, index) => (
              <div key={`${item.id ?? index}:${item.content}`} className={`agent-live-task-item ${item.status}`}>
                <span className="agent-live-task-dot" aria-hidden="true" />
                <span className="agent-live-task-copy">
                  <strong>{item.content}</strong>
                  <em>
                    {[item.id, formatRuntimeTaskStatus(item.status, language), item.priority].filter(Boolean).join(' · ')}
                  </em>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatRuntimeTaskStatus(status: RuntimeTaskStatus, language: 'zh-CN' | 'en-US'): string {
  const labels: Record<RuntimeTaskStatus, string> = {
    pending: localize(language, '待处理', 'Pending'),
    in_progress: localize(language, '进行中', 'Running'),
    completed: localize(language, '已完成', 'Done'),
    cancelled: localize(language, '已取消', 'Cancelled')
  };
  return labels[status];
}

function PermissionImpactSummary(props: { impact?: AgentPermissionImpact }): JSX.Element | null {
  const language = useUiLanguage();
  const impact = props.impact;
  if (!impact) {
    return null;
  }

  const entries = [
    impact.toolTitle || impact.toolName
      ? localize(language, `工具：${impact.toolTitle || impact.toolName}`, `Tool: ${impact.toolTitle || impact.toolName}`)
      : '',
    impact.paths?.length
      ? localize(language, `路径：${impact.paths.join(' · ')}`, `Paths: ${impact.paths.join(' · ')}`)
      : '',
    impact.commands?.length
      ? localize(language, `命令：${impact.commands.join(' · ')}`, `Commands: ${impact.commands.join(' · ')}`)
      : '',
    impact.mcp?.pluginName || impact.mcp?.pluginId || impact.mcp?.toolName
      ? localize(language, `MCP：${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`, `MCP: ${[impact.mcp.pluginName ?? impact.mcp.pluginId, impact.mcp.toolName].filter(Boolean).join(' / ')}`)
      : '',
    impact.mcp?.permission || impact.mcp?.risk || impact.mcp?.policySource
      ? localize(language, `MCP 策略：${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`, `MCP policy: ${[impact.mcp.permission, impact.mcp.risk, impact.mcp.policySource].filter(Boolean).join(' / ')}`)
      : '',
    impact.cwd ? localize(language, `目录：${impact.cwd}`, `Directory: ${impact.cwd}`) : '',
    impact.reason ? localize(language, `原因：${impact.reason}`, `Reason: ${impact.reason}`) : '',
    impact.checkpointPolicy
      ? localize(language, `恢复策略：${impact.checkpointPolicy}`, `Recovery: ${impact.checkpointPolicy}`)
      : ''
  ].filter(Boolean);

  const detailEntries = impact.inputSummary?.filter(Boolean).slice(0, 4) ?? [];
  if (entries.length === 0 && detailEntries.length === 0) {
    return null;
  }

  return (
    <div className="agent-permission-impact">
      {entries.map((entry) => <span key={entry}>{entry}</span>)}
      {detailEntries.map((entry) => <span key={`detail:${entry}`}>{entry}</span>)}
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

function PlusIcon(props: { className: string }): JSX.Element {
  return (
    <svg className={props.className} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M10 4.75V15.25M4.75 10H15.25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return `${value}`;
}
