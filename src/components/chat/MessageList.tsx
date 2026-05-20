import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AgentCoreMessagePart, AgentPermissionImpact, AgentToolArtifact, AgentToolBrowserResult, AgentToolChangedFile, AgentToolEditMetrics, AgentToolMcpResult, AgentUserInputOption, ChatMediaBlock, ChatMessage, ProjectSessionRuntimeId, RuntimeRecoveryAction } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button } from '../ui/index';
import { ChatTranscriptMessage, StreamingTranscriptMessage, getMessagePlainText } from './ConversationMessage';

const BOTTOM_STICKINESS_PX = 48;
const SCROLL_EDGE_EPSILON_PX = 1;
const DEFAULT_RENDERED_MESSAGE_LIMIT = 80;
const MESSAGE_RENDER_BATCH_SIZE = 80;

export interface ChatStreamState {
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
  statusMessage: string;
}

export interface EmptyChatAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
}

export function MessageList(props: {
  sessionId: string;
  messages: ChatMessage[];
  stream: ChatStreamState | null;
  emptyActions?: EmptyChatAction[];
  onSelectEmptyAction?: (prompt: string) => void;
  searchQuery: string;
  openablePaths: string[];
  onOpenPath: (path: string) => void;
  rewindSnapshotIds?: Record<string, string | undefined>;
  onRestoreCheckpoint?: (snapshotId: string) => void;
  highlightMessageId?: string;
  highlightToken?: string;
  restoreNotice?: {
    checkpointNote: string;
    rolledBackCount: number;
  } | null;
  developerMode: boolean;
}): JSX.Element {
  const language = useUiLanguage();
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const previousSessionIdRef = useRef(props.sessionId);
  const lastHighlightKeyRef = useRef('');
  const scrollTopBySessionRef = useRef<Record<string, number>>({});
  const stickToBottomBySessionRef = useRef<Record<string, boolean>>({
    [props.sessionId]: true
  });
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(DEFAULT_RENDERED_MESSAGE_LIMIT);
  const normalizedSearchQuery = props.searchQuery.trim().toLowerCase();

  const filteredMessages = useMemo(() => {
    if (!normalizedSearchQuery) {
      return props.messages;
    }
    return props.messages.filter((message) => getMessagePlainText(message, false).toLowerCase().includes(normalizedSearchQuery));
  }, [normalizedSearchQuery, props.messages]);
  const shouldWindowMessages = !normalizedSearchQuery && !props.highlightMessageId && filteredMessages.length > visibleMessageLimit;
  const visibleMessages = shouldWindowMessages ? filteredMessages.slice(-visibleMessageLimit) : filteredMessages;
  const hiddenMessageCount = Math.max(0, filteredMessages.length - visibleMessages.length);

  function scrollRegionToBottom(behavior: ScrollBehavior): void {
    if (!scrollRegionRef.current) {
      return;
    }
    scrollRegionRef.current.scrollTo({
      top: scrollRegionRef.current.scrollHeight,
      behavior
    });
    stickToBottomBySessionRef.current[props.sessionId] = true;
    scrollTopBySessionRef.current[props.sessionId] = scrollRegionRef.current.scrollHeight;
    setStickToBottom(true);
  }

  function persistScrollState(sessionId = props.sessionId): void {
    if (!scrollRegionRef.current || !sessionId) {
      return;
    }

    const node = scrollRegionRef.current;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nextStickToBottom = distanceFromBottom < BOTTOM_STICKINESS_PX;
    scrollTopBySessionRef.current[sessionId] = node.scrollTop;
    stickToBottomBySessionRef.current[sessionId] = nextStickToBottom;
  }

  useEffect(() => {
    if (!scrollRegionRef.current) {
      return;
    }

    if (previousSessionIdRef.current !== props.sessionId) {
      const nextStickToBottom = stickToBottomBySessionRef.current[props.sessionId] ?? true;
      const nextScrollTop = scrollTopBySessionRef.current[props.sessionId] ?? 0;
      previousSessionIdRef.current = props.sessionId;
      setVisibleMessageLimit(DEFAULT_RENDERED_MESSAGE_LIMIT);
      setStickToBottom(nextStickToBottom);

      window.requestAnimationFrame(() => {
        if (!scrollRegionRef.current) {
          return;
        }

        scrollRegionRef.current.scrollTo({
          top: nextStickToBottom ? scrollRegionRef.current.scrollHeight : nextScrollTop,
          behavior: 'auto'
        });
        persistScrollState(props.sessionId);
      });
      return;
    }
  }, [props.sessionId]);

  useEffect(() => {
    stickToBottomBySessionRef.current[props.sessionId] = stickToBottom;
  }, [props.sessionId, stickToBottom]);

  useEffect(() => {
    const node = scrollRegionRef.current;
    if (!node) {
      return;
    }

    const preventEdgeRubberBand = (event: WheelEvent): void => {
      if (!event.cancelable || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }

      const canScroll = node.scrollHeight > node.clientHeight + SCROLL_EDGE_EPSILON_PX;
      if (!canScroll) {
        event.preventDefault();
        return;
      }

      const atTop = node.scrollTop <= SCROLL_EDGE_EPSILON_PX;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - SCROLL_EDGE_EPSILON_PX;
      if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
      }
    };

    node.addEventListener('wheel', preventEdgeRubberBand, { passive: false });
    return () => {
      node.removeEventListener('wheel', preventEdgeRubberBand);
    };
  }, []);

  useEffect(() => {
    if (!scrollRegionRef.current || normalizedSearchQuery || !stickToBottom) {
      return;
    }
    scrollRegionToBottom('smooth');
  }, [props.messages.length, stickToBottom, normalizedSearchQuery]);

  useEffect(() => {
    if (!scrollRegionRef.current || !props.highlightMessageId || !props.highlightToken) {
      return;
    }

    const highlightKey = `${props.sessionId}:${props.highlightMessageId}:${props.highlightToken}`;
    if (lastHighlightKeyRef.current === highlightKey) {
      return;
    }

    lastHighlightKeyRef.current = highlightKey;

    window.requestAnimationFrame(() => {
      if (!scrollRegionRef.current) {
        return;
      }

      const target = scrollRegionRef.current.querySelector<HTMLElement>(`[data-message-id="${props.highlightMessageId}"]`);
      if (!target) {
        return;
      }

      target.scrollIntoView({
        block: 'center',
        behavior: 'auto'
      });
      stickToBottomBySessionRef.current[props.sessionId] = false;
      setStickToBottom(false);
      persistScrollState(props.sessionId);
    });
  }, [props.highlightMessageId, props.highlightToken, props.messages, props.sessionId]);

  function updateStickiness(): void {
    if (!scrollRegionRef.current) {
      return;
    }
    const node = scrollRegionRef.current;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nextStickToBottom = distanceFromBottom < BOTTOM_STICKINESS_PX;
    scrollTopBySessionRef.current[props.sessionId] = node.scrollTop;
    stickToBottomBySessionRef.current[props.sessionId] = nextStickToBottom;
    setStickToBottom(nextStickToBottom);
  }

  function scrollToBottom(): void {
    scrollRegionToBottom('smooth');
  }

  function loadEarlierMessages(): void {
    const node = scrollRegionRef.current;
    const previousScrollHeight = node?.scrollHeight ?? 0;
    const previousScrollTop = node?.scrollTop ?? 0;
    setVisibleMessageLimit((current) => Math.min(filteredMessages.length, current + MESSAGE_RENDER_BATCH_SIZE));
    window.requestAnimationFrame(() => {
      if (!scrollRegionRef.current || !node) {
        return;
      }
      const nextScrollTop = previousScrollTop + Math.max(0, scrollRegionRef.current.scrollHeight - previousScrollHeight);
      scrollRegionRef.current.scrollTo({
        top: nextScrollTop,
        behavior: 'auto'
      });
      persistScrollState(props.sessionId);
    });
  }

  const isEmptyConversation = props.messages.length === 0;
  const hasVisibleStream = !!props.stream;

  return (
    <div
      ref={scrollRegionRef}
      className="agent-scroll-region"
      onScroll={updateStickiness}
    >
      <div className="agent-chat-column agent-message-column">
        {isEmptyConversation && !hasVisibleStream ? (
          <div className="agent-empty-state minimal compact-style">
            <div className="agent-empty-copy">
              <strong>{localize(language, '开始一个新对话', 'Start a new conversation')}</strong>
              <span>{localize(language, '选择一个常用起点，或直接在下方输入具体任务。', 'Pick a common starting point, or type a specific task below.')}</span>
            </div>
            {props.emptyActions?.length ? (
              <div className="agent-empty-suggestions" aria-label={localize(language, '常用任务起点', 'Common task starters')}>
                {props.emptyActions.map((action) => (
                  <Button key={action.id} size="compact" variant="ghost" className="agent-empty-suggestion" onClick={() => props.onSelectEmptyAction?.(action.prompt)}>
                    <strong>{action.label}</strong>
                    <span>{action.description}</span>
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="agent-message-stack agent-message-stack-centered">
            {props.restoreNotice ? (
              <div className="chat-restore-banner" role="status" aria-live="polite">
                <strong>{localize(language, '会话已恢复', 'Session restored')}</strong>
                <span>
                  {localize(
                    language,
                    `已恢复到“${props.restoreNotice.checkpointNote}”，已回退 ${props.restoreNotice.rolledBackCount} 条后续消息。`,
                    `Restored to "${props.restoreNotice.checkpointNote}" and rolled back ${props.restoreNotice.rolledBackCount} later message(s).`
                  )}
                </span>
              </div>
            ) : null}
            {normalizedSearchQuery && filteredMessages.length === 0 ? (
              <div className="agent-search-empty">{localize(language, '没有找到匹配消息。', 'No matching messages found.')}</div>
            ) : null}
            {hiddenMessageCount > 0 ? (
              <Button size="compact" variant="ghost" className="agent-hidden-history-button" onClick={loadEarlierMessages}>
                {localize(
                  language,
                  `已隐藏 ${hiddenMessageCount} 条更早消息，点击加载`,
                  `${hiddenMessageCount} earlier message(s) hidden. Click to load`
                )}
              </Button>
            ) : null}
            {visibleMessages.map((message) => (
              <ChatTranscriptMessage
                key={message.id}
                message={message}
                openablePaths={props.openablePaths}
                searchQuery={props.searchQuery}
                onOpenPath={props.onOpenPath}
                developerMode={props.developerMode}
                rewindSnapshotId={props.rewindSnapshotIds?.[message.id]}
                onRestoreCheckpoint={props.onRestoreCheckpoint}
                highlighted={message.id === props.highlightMessageId}
              />
            ))}
            {props.stream ? (
              <StreamingTranscriptMessage
                prompt={props.stream.prompt}
                content={props.stream.content}
                thinkingContent={props.stream.thinkingContent}
                toolUses={props.stream.toolUses}
                toolResults={props.stream.toolResults}
                stages={props.stream.stages}
                activityItems={props.stream.activityItems}
                agentCoreParts={props.stream.agentCoreParts}
                pendingPermission={props.stream.pendingPermission}
                pendingUserInput={props.stream.pendingUserInput}
                statusMessage={props.stream.statusMessage}
                developerMode={props.developerMode}
                openablePaths={props.openablePaths}
                onOpenPath={props.onOpenPath}
              />
            ) : null}
          </div>
        )}
      </div>
      {!stickToBottom && (props.messages.length > 0 || hasVisibleStream) ? (
        <Button size="compact" variant="ghost" className="agent-scroll-anchor-button" onClick={scrollToBottom}>
          {localize(language, '回到底部', 'Scroll to bottom')}
        </Button>
      ) : null}
    </div>
  );
}
