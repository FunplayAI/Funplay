import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectSession } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';

export interface SessionListState {
  mode: 'idle' | 'running' | 'queued' | 'error' | 'fallback';
  summary: string;
  hint?: string;
  queuedCount?: number;
}

export interface SessionCheckpointListItem {
  id: string;
  note: string;
  createdAt: string;
}

export function SessionManagementPanel(props: {
  sessions: ProjectSession[];
  activeSessionId?: string;
  streamingSessionId?: string;
  sessionStates?: Record<string, SessionListState | undefined>;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [hoveredSessionId, setHoveredSessionId] = useState('');
  const [openMenuState, setOpenMenuState] = useState<{ sessionId: string; top: number; left: number } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);

  const sessions = useMemo(
    () => [...props.sessions].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [props.sessions]
  );

  const filteredSessions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return sessions;
    }

    return sessions.filter((session) => getSessionDisplayTitle(session, language).toLowerCase().includes(normalizedQuery));
  }, [language, searchQuery, sessions]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent): void {
      if (!menuRef.current || !menuRef.current.contains(event.target as Node)) {
        setOpenMenuState(null);
      }
    }

    if (!openMenuState) {
      return;
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openMenuState]);

  useEffect(() => {
    if (!openMenuState) {
      return;
    }

    function closeMenu(): void {
      setOpenMenuState(null);
    }

    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [openMenuState]);

  function beginRename(session: ProjectSession): void {
    setOpenMenuState(null);
    setEditingSessionId(session.id);
    setEditingTitle(getSessionDisplayTitle(session, language));
  }

  function commitRename(): void {
    const title = editingTitle.trim();
    if (editingSessionId && title) {
      props.onRenameSession(editingSessionId, title);
    }
    setEditingSessionId('');
    setEditingTitle('');
  }

  return (
    <section className="sidebar-chat-section" aria-label={localize(language, '会话管理', 'Session management')}>
      <div className="sidebar-section-row sidebar-session-row">
        <div className="sidebar-section-label">{localize(language, '会话管理', 'Session Management')}</div>
        <div className="sidebar-section-actions">
          <button
            className={`sidebar-tool-icon ${searchVisible ? 'active' : ''}`}
            onClick={() => setSearchVisible((current) => !current)}
            aria-label={searchVisible ? localize(language, '隐藏会话搜索', 'Hide session search') : localize(language, '显示会话搜索', 'Show session search')}
            title={searchVisible ? localize(language, '隐藏会话搜索', 'Hide session search') : localize(language, '显示会话搜索', 'Show session search')}
          >
            ⌕
          </button>
          <button
            className="sidebar-tool-icon"
            onClick={props.onCreateSession}
            aria-label={localize(language, '新建会话', 'New session')}
            title={localize(language, '新建会话', 'New session')}
          >
            +
          </button>
        </div>
      </div>

      {searchVisible ? (
        <label className="sidebar-session-search">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={localize(language, '搜索会话…', 'Search sessions…')}
          />
        </label>
      ) : null}

      <div className="sidebar-session-list">
        {filteredSessions.length === 0 ? <div className="sidebar-session-empty">{localize(language, '暂无会话', 'No sessions yet')}</div> : null}
        {filteredSessions.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            active={props.activeSessionId === session.id}
            streaming={props.streamingSessionId === session.id}
            state={props.sessionStates?.[session.id]}
            hovered={hoveredSessionId === session.id}
            menuOpen={openMenuState?.sessionId === session.id}
            editing={editingSessionId === session.id}
            editingTitle={editingTitle}
            onMouseEnter={() => setHoveredSessionId(session.id)}
            onMouseLeave={() => setHoveredSessionId('')}
            onSelect={() => props.onSelectSession(session.id)}
            onToggleMenu={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              if (openMenuState?.sessionId === session.id) {
                setOpenMenuState(null);
                return;
              }

              const estimatedMenuWidth = 152;
              const viewportPadding = 8;
              const left = Math.min(
                Math.max(viewportPadding, rect.right - estimatedMenuWidth),
                window.innerWidth - estimatedMenuWidth - viewportPadding
              );

              setOpenMenuState({
                sessionId: session.id,
                top: Math.min(rect.bottom + 6, window.innerHeight - 120),
                left
              });
            }}
            onBeginRename={() => beginRename(session)}
            onDelete={() => {
              setOpenMenuState(null);
              props.onDeleteSession(session.id);
            }}
            onCopyId={() => {
              navigator.clipboard.writeText(session.id).catch(() => {});
              setOpenMenuState(null);
            }}
            onEditingTitleChange={setEditingTitle}
            onCommitRename={commitRename}
            onCancelRename={() => {
              setEditingSessionId('');
              setEditingTitle('');
            }}
          />
        ))}
      </div>
      {openMenuState
        ? createPortal(
            <div
              ref={menuRef}
              className="sidebar-session-menu portal"
              style={{
                top: openMenuState.top,
                left: openMenuState.left
              }}
            >
              <button
                className="sidebar-session-menu-item"
                onClick={() => {
                  const session = props.sessions.find((item) => item.id === openMenuState.sessionId);
                  if (session) {
                    beginRename(session);
                  }
                }}
              >
                {localize(language, '重命名', 'Rename')}
              </button>
              <button
                className="sidebar-session-menu-item"
                onClick={() => {
                  navigator.clipboard.writeText(openMenuState.sessionId).catch(() => {});
                  setOpenMenuState(null);
                }}
              >
                {localize(language, '复制会话 ID', 'Copy Session ID')}
              </button>
              <button
                className="sidebar-session-menu-item danger"
                onClick={() => {
                  setOpenMenuState(null);
                  props.onDeleteSession(openMenuState.sessionId);
                }}
              >
                {localize(language, '删除会话', 'Delete session')}
              </button>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}

function SessionListItem(props: {
  session: ProjectSession;
  active: boolean;
  streaming: boolean;
  state?: SessionListState;
  hovered: boolean;
  menuOpen: boolean;
  editing: boolean;
  editingTitle: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSelect: () => void;
  onToggleMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onBeginRename: () => void;
  onDelete: () => void;
  onCopyId: () => void;
  onEditingTitleChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const displayTitle = getSessionDisplayTitle(props.session, language);
  const showActions = props.hovered || props.menuOpen || props.editing;
  const mode = props.streaming ? 'running' : props.state?.mode ?? 'idle';
  const summary = props.streaming
    ? localize(language, '正在处理当前会话请求…', 'Processing the current session request…')
    : props.state?.summary || localize(language, '等待新的消息', 'Waiting for the next message');
  const hint = props.state?.hint;

  return (
    <div
      className={`sidebar-session-item ${props.active ? 'active' : ''} ${props.menuOpen ? 'menu-open' : ''}`}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      {props.editing ? (
        <input
          className="sidebar-session-rename-input"
          value={props.editingTitle}
          autoFocus
          onChange={(event) => props.onEditingTitleChange(event.target.value)}
          onBlur={props.onCommitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              props.onCommitRename();
            }
            if (event.key === 'Escape') {
              props.onCancelRename();
            }
          }}
        />
      ) : (
        <button className="sidebar-session-main" onClick={props.onSelect}>
          <span className={`sidebar-session-status ${mode}`}>
            {mode === 'running' ? (
              <span className="sidebar-session-processing-icon" aria-hidden>
                <span className="processing-spinner" />
              </span>
            ) : mode === 'error' ? (
              <span className="sidebar-session-status-badge error" aria-hidden>!</span>
            ) : mode === 'queued' ? (
              <span className="sidebar-session-status-badge queued" aria-hidden>{props.state?.queuedCount ?? 0}</span>
            ) : mode === 'fallback' ? (
              <span className="sidebar-session-status-badge fallback" aria-hidden>↺</span>
            ) : (
              <span className={`sidebar-session-dot ${props.active ? 'active' : ''}`} />
            )}
          </span>
          <span className="sidebar-session-body">
            <span className="sidebar-session-head">
              <span className="sidebar-session-title">{displayTitle}</span>
              <span className={`sidebar-session-time ${showActions ? 'hidden' : ''}`}>
                {props.streaming ? localize(language, '生成中', 'Live') : formatSessionRelativeTime(language, props.session.updatedAt)}
              </span>
            </span>
            <span className="sidebar-session-subline">
              <span className={`sidebar-session-summary ${mode}`}>{summary}</span>
              {hint ? <span className={`sidebar-session-hint ${mode}`}>{hint}</span> : null}
            </span>
          </span>
        </button>
      )}

      <div className={`sidebar-session-actions ${showActions ? 'visible' : ''}`}>
        <button
          className="sidebar-session-action menu-trigger"
          onClick={props.onToggleMenu}
          aria-label={localize(language, '打开会话菜单', 'Open session menu')}
          title={localize(language, '会话菜单', 'Session menu')}
        >
          <MoreHorizontalIcon />
        </button>
      </div>
    </div>
  );
}

function MoreHorizontalIcon(): JSX.Element {
  return (
    <svg className="sidebar-session-more-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <circle cx="5" cy="10" r="1.6" fill="currentColor" />
      <circle cx="10" cy="10" r="1.6" fill="currentColor" />
      <circle cx="15" cy="10" r="1.6" fill="currentColor" />
    </svg>
  );
}

function getSessionDisplayTitle(session: ProjectSession, language: 'zh-CN' | 'en-US'): string {
  return session.autoTitle && session.title === 'New Session' ? localize(language, '新会话', 'New Session') : session.title;
}

function formatSessionRelativeTime(language: 'zh-CN' | 'en-US', date: string): string {
  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / (1000 * 60)));
  if (diffMinutes < 1) return localize(language, '刚刚', 'Now');
  if (diffMinutes < 60) return localize(language, `${diffMinutes} 分钟`, `${diffMinutes}m`);
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return localize(language, `${diffHours} 小时`, `${diffHours}h`);
  const diffDays = Math.round(diffHours / 24);
  return localize(language, `${diffDays} 天`, `${diffDays}d`);
}
