import { memo, useEffect, useState, type JSX } from 'react';
import type {
  AgentCoreMessagePart,
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolChangedFile,
  AgentToolEditMetrics,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  AgentPermissionImpact,
  AgentUserInputOption,
  ChatMediaBlock,
  ChatMessage,
  PromptAttachment
} from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button } from '../ui/index';
import { getVisibleRuntimeStages } from './runtime-display';
import {
  type StageExecutionEntry,
  type StreamActivityEntry,
  ToolActivityGroup,
  ChevronDownIcon,
  AssistantMetadataPanel,
  pairStreamingToolExecutions,
  buildCompletedMessageProcessTools,
  formatCompletedProcessTitle,
  formatDuration,
  formatAbsoluteTime
} from './tool-activity';
import { getMessagePlainText } from './transcript/message-plain-text';
import { renderChatContent } from './transcript/chat-markdown';
import {
  hasStructuredToolBlocks,
  renderAgentCoreParts,
  renderProcessTimeline,
  PermissionImpactBlock
} from './transcript/message-process';
import { renderChatMessageBlocks } from './transcript/message-blocks';

export { getMessagePlainText } from './transcript/message-plain-text';

export const ChatTranscriptMessage = memo(function ChatTranscriptMessage(props: {
  message: ChatMessage;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
  developerMode: boolean;
  rewindSnapshotId?: string;
  onRestoreCheckpoint?: (snapshotId: string) => void;
  highlighted?: boolean;
}): JSX.Element {
  const language = useUiLanguage();
  const isAssistant = props.message.role === 'assistant';
  const copyText = getMessagePlainText(props.message, props.developerMode);
  const userAttachments = !isAssistant ? (props.message.metadata?.promptAttachments ?? []) : [];

  return (
    <div
      className={`chat-transcript-row ${props.message.role} ${props.highlighted ? 'restored-target' : ''}`}
      data-message-id={props.message.id}
    >
      <div className={`chat-transcript-avatar ${props.message.role}`}>{isAssistant ? 'AI' : 'You'}</div>
      <div className={`chat-transcript-bubble ${props.message.role}`}>
        <div className="chat-transcript-meta">
          {isAssistant ? (
            <CompletedMessageProcessSummary
              message={props.message}
              developerMode={props.developerMode}
              openablePaths={props.openablePaths}
              onOpenPath={props.onOpenPath}
            />
          ) : (
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
          )}
          <div className="chat-transcript-meta-right">
            <span className="chat-transcript-time">{formatAbsoluteTime(language, props.message.createdAt)}</span>
            {!isAssistant && props.rewindSnapshotId && props.onRestoreCheckpoint ? (
              <Button
                size="compact"
                variant="ghost"
                className="chat-transcript-rewind"
                onClick={() => props.onRestoreCheckpoint?.(props.rewindSnapshotId!)}
                aria-label={localize(language, '回退到这里', 'Rewind to here')}
                title={localize(language, '回退到这里', 'Rewind to here')}
              >
                {localize(language, '回退到这里', 'Rewind to here')}
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="ghost"
              className="chat-transcript-copy"
              onClick={() => navigator.clipboard.writeText(copyText).catch(() => {})}
              aria-label={localize(language, '复制消息', 'Copy message')}
              title={localize(language, '复制消息', 'Copy message')}
            >
              {localize(language, '复制', 'Copy')}
            </Button>
          </div>
        </div>
        <div className="chat-transcript-content">
          {userAttachments.length > 0 ? <UserAttachmentStrip attachments={userAttachments} /> : null}
          {renderChatMessageBlocks(
            props.message,
            props.openablePaths,
            props.searchQuery,
            props.onOpenPath,
            props.developerMode
          )}
        </div>
        {isAssistant ? (
          <AssistantMetadataPanel metadata={props.message.metadata} developerMode={props.developerMode} />
        ) : null}
      </div>
    </div>
  );
});

function CompletedMessageProcessSummary(props: {
  message: ChatMessage;
  developerMode: boolean;
  openablePaths: string[];
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const processTools = buildCompletedMessageProcessTools(props.message);
  const title = formatCompletedProcessTitle(props.message.metadata, props.message.createdAt, language, {
    includeTokenUsage: props.developerMode
  });
  const rendersProcessInline = hasStructuredToolBlocks(props.message);

  if (processTools.length === 0 || rendersProcessInline) {
    return <span className="chat-transcript-author">{title}</span>;
  }

  return (
    <details className="chat-completed-process">
      <summary className="chat-completed-process-summary">
        <span>{title}</span>
        <ChevronDownIcon className="chat-completed-process-chevron" />
      </summary>
      <div className="chat-completed-process-detail">
        <ToolActivityGroup
          tools={processTools}
          defaultOpen
          openablePaths={props.openablePaths}
          searchQuery=""
          onOpenPath={props.onOpenPath}
          showDiagnosticMeta={props.developerMode}
          renderContent={renderChatContent}
        />
        {!props.developerMode ? null : (
          <div className="chat-completed-process-note">
            {localize(
              language,
              '开发者模式：正文只渲染最终回复，工具过程来自结构化历史块。',
              'Developer mode: the body renders only the final reply; tool activity comes from structured history blocks.'
            )}
          </div>
        )}
      </div>
    </details>
  );
}

export function PendingTranscriptMessage(props: { prompt: string }): JSX.Element {
  const language = useUiLanguage();
  if (!props.prompt.trim()) {
    return <></>;
  }

  const now = new Date().toISOString();

  return (
    <>
      <div className="chat-transcript-row user pending">
        <div className="chat-transcript-avatar user">You</div>
        <div className="chat-transcript-bubble user pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
            <span className="chat-transcript-time">{formatAbsoluteTime(language, now)}</span>
          </div>
          <div className="chat-transcript-content">
            <div className="chat-rich-text-line">{props.prompt}</div>
          </div>
        </div>
      </div>

      <div className="chat-transcript-row assistant pending">
        <div className="chat-transcript-avatar assistant">AI</div>
        <div className="chat-transcript-bubble assistant pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '正在处理', 'Processing')}</span>
            <span className="chat-transcript-time">{localize(language, '生成中…', 'Generating…')}</span>
          </div>
          <div className="chat-pending-stack" aria-live="polite">
            <div className="chat-pending-line strong">{localize(language, '正在准备回复…', 'Preparing response…')}</div>
            <div className="chat-pending-line">
              {localize(
                language,
                '运行状态会在输入框上方持续更新。',
                'Runtime status will update above the input box.'
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function UserAttachmentStrip(props: { attachments: PromptAttachment[] }): JSX.Element | null {
  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <div className="chat-user-attachments">
      {props.attachments.map((attachment) => (
        <span
          key={attachment.id}
          className={`chat-user-attachment-chip ${attachment.kind}`}
          title={attachment.relativePath || attachment.path}
        >
          {attachment.previewDataUrl ? (
            <img src={attachment.previewDataUrl} alt="" />
          ) : (
            <span className="chat-user-attachment-icon" aria-hidden="true">
              {attachment.kind === 'image' ? 'IMG' : 'FILE'}
            </span>
          )}
          <span>{attachment.name}</span>
        </span>
      ))}
    </div>
  );
}

export function StreamingTranscriptMessage(props: {
  prompt: string;
  attachments?: PromptAttachment[];
  startedAt?: string;
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
    transaction?: AgentToolTransactionSummary;
  }>;
  stages: StageExecutionEntry[];
  activityItems: StreamActivityEntry[];
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
  statusMessage: string;
  developerMode: boolean;
  openablePaths: string[];
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const now = new Date().toISOString();
  const elapsed = useElapsedDuration(props.startedAt, language);
  const agentCoreToolExecutions = props.agentCoreParts?.length
    ? buildCompletedMessageProcessTools({ agentCoreParts: props.agentCoreParts })
    : [];
  const toolExecutions =
    agentCoreToolExecutions.length > 0
      ? agentCoreToolExecutions
      : pairStreamingToolExecutions(props.toolUses, props.toolResults);
  const visibleStages = getVisibleRuntimeStages(props.stages, props.developerMode);
  const agentCoreTimeline = props.agentCoreParts?.length
    ? renderAgentCoreParts({
        parts: props.agentCoreParts,
        developerMode: props.developerMode,
        assistantTextRenderMode: 'streaming-hybrid',
        openablePaths: props.openablePaths,
        searchQuery: '',
        onOpenPath: props.onOpenPath
      })
    : [];
  const processTimeline = renderProcessTimeline({
    content: props.content,
    activityItems: props.activityItems,
    toolExecutions,
    visibleStages,
    autoExpandActiveToolGroup: true,
    developerMode: props.developerMode,
    assistantTextRenderMode: 'streaming-hybrid',
    openablePaths: props.openablePaths,
    searchQuery: '',
    onOpenPath: props.onOpenPath
  });
  const hasAgentCoreTimeline = agentCoreTimeline.length > 0;
  const hasProcessTimeline = processTimeline.length > 0;

  return (
    <>
      <div className="chat-transcript-row user pending">
        <div className="chat-transcript-avatar user">You</div>
        <div className="chat-transcript-bubble user pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">{localize(language, '你', 'You')}</span>
            <span className="chat-transcript-time">{formatAbsoluteTime(language, now)}</span>
          </div>
          <div className="chat-transcript-content">
            {props.attachments?.length ? <UserAttachmentStrip attachments={props.attachments} /> : null}
            <div className="chat-rich-text-line">{props.prompt}</div>
          </div>
        </div>
      </div>

      <div className="chat-transcript-row assistant pending">
        <div className="chat-transcript-avatar assistant">AI</div>
        <div className="chat-transcript-bubble assistant pending">
          <div className="chat-transcript-meta">
            <span className="chat-transcript-author">
              {localize(language, '正在处理', 'Processing')}
              {elapsed ? <em className="chat-transcript-elapsed">{elapsed}</em> : null}
            </span>
            <span className="chat-transcript-time">
              {props.statusMessage || localize(language, '生成中…', 'Generating…')}
            </span>
          </div>
          <div className="chat-transcript-content">
            {props.pendingPermission ? (
              <div className={`chat-content-block permission ${props.pendingPermission.risk}`}>
                <div className="chat-content-block-title">
                  {localize(language, '等待权限确认', 'Permission Required')}
                </div>
                <div className="chat-content-block-body">
                  <strong>{props.pendingPermission.title}</strong>
                  <span>{props.pendingPermission.detail}</span>
                  <PermissionImpactBlock impact={props.pendingPermission.impact} />
                </div>
              </div>
            ) : null}
            {props.pendingUserInput ? (
              <div className="chat-content-block permission">
                <div className="chat-content-block-title">{localize(language, '等待用户回答', 'Waiting for User')}</div>
                <div className="chat-content-block-body">
                  <strong>{props.pendingUserInput.title}</strong>
                  <span>{props.pendingUserInput.question}</span>
                </div>
              </div>
            ) : null}
            {hasAgentCoreTimeline ? (
              agentCoreTimeline
            ) : hasProcessTimeline ? (
              processTimeline
            ) : (
              <div className="chat-pending-stack" aria-live="polite">
                <div className="chat-pending-line strong">
                  {props.statusMessage || localize(language, '正在准备回复…', 'Preparing response…')}
                </div>
                <div className="chat-pending-line">
                  {localize(
                    language,
                    '消息会实时出现在这里；系统会根据当前会话与工作区上下文持续生成。',
                    'The reply will stream here in real time based on the current session and workspace context.'
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function useElapsedDuration(startedAt: string | undefined, language: 'zh-CN' | 'en-US'): string {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt || Number.isNaN(Date.parse(startedAt))) {
      return undefined;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) {
    return '';
  }
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return '';
  }
  return formatDuration(language, nowMs - startedAtMs);
}
