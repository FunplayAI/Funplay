import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ArrowDown } from 'lucide-react';
import type { AgentCoreMessagePart, AgentPermissionImpact, AgentToolArtifact, AgentToolBrowserResult, AgentToolChangedFile, AgentToolEditMetrics, AgentToolMcpResult, AgentUserInputOption, ChatMediaBlock, ChatMessage, ProjectSessionRuntimeId, PromptAttachment, RuntimeRecoveryAction } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button, IconButton } from '../ui/index';
import { ChatTranscriptMessage, StreamingTranscriptMessage, getMessagePlainText } from './ConversationMessage';

const BOTTOM_STICKINESS_PX = 48;
const SCROLL_EDGE_EPSILON_PX = 1;
const DEFAULT_RENDERED_MESSAGE_LIMIT = 80;
const MESSAGE_RENDER_BATCH_SIZE = 80;

export interface ChatStreamState {
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

function buildStreamScrollKey(stream: ChatStreamState | null): string {
  if (!stream) {
    return '';
  }

  return [
    stream.prompt.length,
    stream.content.length,
    stream.thinkingContent.length,
    stream.statusMessage,
    stream.toolUses.map((tool) => `${tool.toolUseId}:${tool.status}`).join(','),
    stream.toolResults.map((result) => `${result.toolUseId}:${result.content.length}:${result.isError ? '1' : '0'}`).join(','),
    stream.stages.map((stage) => `${stage.stageId}:${stage.status}:${stage.summary?.length ?? 0}:${stage.errorMessage?.length ?? 0}`).join(','),
    stream.activityItems.map((item) => `${item.id}:${item.status}:${item.summary?.length ?? 0}`).join(','),
    (stream.agentCoreParts ?? []).map(buildAgentCorePartScrollKey).join(','),
    stream.pendingPermission?.requestId ?? '',
    stream.pendingUserInput?.requestId ?? ''
  ].join('|');
}

function buildAgentCorePartScrollKey(part: AgentCoreMessagePart): string {
  if (part.kind === 'assistant_text') return `${part.id}:${part.kind}:${part.text.length}:${part.final ? '1' : '0'}`;
  if (part.kind === 'assistant_thinking') return `${part.id}:${part.kind}:${part.thinking.length}`;
  if (part.kind === 'tool_call') return `${part.id}:${part.kind}:${part.status}:${part.summary?.length ?? 0}:${part.activity?.length ?? 0}`;
  if (part.kind === 'tool_result') return `${part.id}:${part.kind}:${part.content.length}:${part.changedFiles?.length ?? 0}:${part.artifacts?.length ?? 0}`;
  if (part.kind === 'tool_error') return `${part.id}:${part.kind}:${part.error.length}:${part.recoveryHint?.length ?? 0}`;
  if (part.kind === 'permission_request') return `${part.id}:${part.kind}:${part.requestId}`;
  if (part.kind === 'user_input_request') return `${part.id}:${part.kind}:${part.requestId}:${part.question.length}`;
  if (part.kind === 'todo_update') return `${part.id}:${part.kind}:${part.items.map((item) => `${item.id}:${item.status}`).join(',')}`;
  if (part.kind === 'context_summary') return `${part.id}:${part.kind}:${part.summary.length}`;
  if (part.kind === 'system_event') return `${part.id}:${part.kind}:${part.state ?? ''}:${part.title.length}:${part.summary?.length ?? 0}`;
  return `${part.id}:${part.kind}`;
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
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const previousSessionIdRef = useRef(props.sessionId);
  const lastHighlightKeyRef = useRef('');
  const autoScrollAnimationFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const normalizedSearchQueryRef = useRef('');
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
  const streamScrollKey = buildStreamScrollKey(props.stream);

  function scrollRegionToBottom(behavior: ScrollBehavior): void {
    if (!scrollRegionRef.current) {
      return;
    }
    scrollRegionRef.current.scrollTo({
      top: scrollRegionRef.current.scrollHeight,
      behavior
    });
    stickToBottomBySessionRef.current[props.sessionId] = true;
    stickToBottomRef.current = true;
    scrollTopBySessionRef.current[props.sessionId] = scrollRegionRef.current.scrollHeight;
    setStickToBottom(true);
  }

  function scheduleBottomFollow(behavior: ScrollBehavior = 'auto'): void {
    if (!scrollRegionRef.current || normalizedSearchQueryRef.current || !stickToBottomRef.current) {
      return;
    }

    if (autoScrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollAnimationFrameRef.current);
    }

    autoScrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollAnimationFrameRef.current = null;
      if (!scrollRegionRef.current || normalizedSearchQueryRef.current || !stickToBottomRef.current) {
        return;
      }
      scrollRegionToBottom(behavior);
    });
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
    stickToBottomRef.current = nextStickToBottom;
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
      stickToBottomRef.current = nextStickToBottom;
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
    stickToBottomRef.current = stickToBottom;
    stickToBottomBySessionRef.current[props.sessionId] = stickToBottom;
  }, [props.sessionId, stickToBottom]);

  useEffect(() => {
    normalizedSearchQueryRef.current = normalizedSearchQuery;
  }, [normalizedSearchQuery]);

  useEffect(() => {
    return () => {
      if (autoScrollAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollAnimationFrameRef.current);
      }
    };
  }, []);

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
    scheduleBottomFollow('auto');
  }, [props.messages.length, streamScrollKey, visibleMessageLimit, stickToBottom, normalizedSearchQuery]);

  useEffect(() => {
    const node = messageContentRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleBottomFollow('auto');
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [props.sessionId]);

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
      stickToBottomRef.current = false;
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
    stickToBottomRef.current = nextStickToBottom;
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
      <div ref={messageContentRef} className="agent-chat-column agent-message-column">
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
                attachments={props.stream.attachments}
                startedAt={props.stream.startedAt}
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
        <IconButton
          size="compact"
          variant="ghost"
          className="agent-scroll-anchor-button"
          label={localize(language, '回到底部', 'Scroll to bottom')}
          icon={<ArrowDown aria-hidden="true" size={20} strokeWidth={2.2} />}
          onClick={scrollToBottom}
        />
      ) : null}
    </div>
  );
}
