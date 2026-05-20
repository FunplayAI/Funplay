import { useMemo, useState, type JSX } from 'react';
import { Code2, Eye, RotateCcw, Save, Search, X } from 'lucide-react';
import type { Project, ProjectFileContent, ProjectFileEntry, ProjectSession } from '../../../shared/types';
import type { HtmlProjectPreviewMode } from '../../../shared/html-preview-protocol';
import { localize, useUiLanguage } from '../../i18n';
import { SessionManagementPanel, type SessionListState } from './SessionManagementPanel';
import { getFileIconInfo, FolderTreeIcon, FileTypeIcon } from './file-icons';
import { highlightSourceLine, type CodeToken } from './source-highlighter';
import { isHtmlFile, isPreviewableFile } from './file-type-detection';
import { BinaryPreviewFallback, formatBytes, renderFilePreview, type ProjectFileItem } from './file-preview-components';
import { Button, IconButton, TextAreaField, TextField } from '../ui/index';

export type { ProjectFileItem } from './file-preview-components';

export type FileInspectorMode = 'edit' | 'preview';

export interface SidebarNavItem {
  id: string;
  label: string;
  icon: string;
}

interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'folder' | 'file';
  fileId?: string;
  badge?: string;
  children: FileTreeNode[];
}

export function SidebarPanel(props: {
  files: ProjectFileEntry[];
  selectedFileId: string;
  sessions: ProjectSession[];
  activeSessionId?: string;
  streamingSessionId?: string;
  sessionStates?: Record<string, SessionListState | undefined>;
  navItems: SidebarNavItem[];
  activeNavId: string;
  width: number;
  onOpenFile: (fileId: string) => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectNav: (navId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [query, setQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const fileTree = useMemo(() => buildProjectFileTree(props.files), [props.files]);
  const filteredTree = useMemo(() => filterFileTree(fileTree, query), [fileTree, query]);
  const searching = query.trim().length > 0;

  function toggleFolder(folderId: string): void {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  return (
    <aside className="workspace-sidebar" style={{ width: props.width, flexBasis: props.width }}>
      <nav className="workspace-sidebar-nav" aria-label={localize(language, '项目导航', 'Project navigation')}>
        {props.navItems.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            className={`workspace-sidebar-nav-item ${props.activeNavId === item.id ? 'active' : ''}`}
            aria-current={props.activeNavId === item.id ? 'page' : undefined}
            onClick={() => props.onSelectNav(item.id)}
          >
            <span className="workspace-sidebar-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </Button>
        ))}
      </nav>

      <SessionManagementPanel
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        streamingSessionId={props.streamingSessionId}
        sessionStates={props.sessionStates}
        onCreateSession={props.onCreateSession}
        onSelectSession={(sessionId) => {
          props.onSelectSession(sessionId);
          props.onSelectNav('agent');
        }}
        onRenameSession={props.onRenameSession}
        onDeleteSession={props.onDeleteSession}
      />

      <div className="sidebar-section-row">
        <div className="sidebar-section-label">{localize(language, '项目文件', 'Project files')}</div>
        <IconButton
          className={`sidebar-tool-icon ${searchVisible ? 'active' : ''}`}
          icon={<Search size={14} aria-hidden="true" />}
          label={searchVisible ? localize(language, '隐藏文件搜索', 'Hide file search') : localize(language, '显示文件搜索', 'Show file search')}
          onClick={() => setSearchVisible((current) => !current)}
        />
      </div>
      {searchVisible ? (
        <TextField
          className="sidebar-search"
          label={localize(language, '文件搜索', 'File search')}
          value={query}
          onValueChange={setQuery}
          placeholder={localize(language, '搜索文件…', 'Search files…')}
        />
      ) : null}
      <div className="file-tree">
        <FileTreeView
          nodes={filteredTree}
          selectedFileId={props.selectedFileId}
          collapsedFolderIds={collapsedFolderIds}
          forceExpanded={searching}
          onToggleFolder={toggleFolder}
          onOpenFile={props.onOpenFile}
        />
      </div>
    </aside>
  );
}

export function FileInspectorPanel(props: {
  file: ProjectFileItem | null;
  project: Project | null;
  draft: string;
  mode: FileInspectorMode;
  width: number;
  isDirty: boolean;
  isSaving: boolean;
  saveError: string;
  savedAt: string;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: FileInspectorMode) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const [htmlPreviewMode, setHtmlPreviewMode] = useState<HtmlProjectPreviewMode>('actual');
  const previewable = props.file ? isPreviewableFile(props.file.path) : false;
  const showHtmlPreviewMode = Boolean(props.file && isHtmlFile(props.file.path) && props.mode === 'preview');
  const canEdit = Boolean(props.file && !props.file.isBinary && props.file.badge !== 'Truncated');
  const statusLabel = !props.file
    ? ''
    : !canEdit
      ? localize(language, '只读', 'Read only')
      : props.isDirty
        ? localize(language, '未保存', 'Unsaved')
        : props.savedAt
          ? localize(language, `已保存 ${formatInspectorTime(props.savedAt)}`, `Saved ${formatInspectorTime(props.savedAt)}`)
          : localize(language, '已同步', 'Synced');

  return (
    <aside className="file-inspector-shell">
      <div className="file-inspector-panel" style={{ width: props.width, flexBasis: props.width }}>
        <div className="file-inspector-header">
          <div className="file-inspector-title-block">
            <div className="file-inspector-path">
              {props.file?.path || localize(language, '文件预览', 'File preview')}
            </div>
            <div className="file-inspector-meta">
              {props.file
                ? `${props.project?.name || localize(language, '当前项目', 'Current project')} · ${formatBytes(props.file.size ?? 0)}`
                : localize(language, '从左侧文件树选择文件', 'Select a file from the file tree')}
            </div>
          </div>
          <div className="file-inspector-actions">
            {props.file ? <span className={`file-inspector-status ${props.isDirty ? 'dirty' : ''}`}>{statusLabel}</span> : null}
            {props.file && canEdit && props.isDirty ? (
              <Button size="sm" variant="secondary" leadingIcon={<RotateCcw size={13} aria-hidden="true" />} onClick={props.onReset} disabled={props.isSaving}>
                {localize(language, '还原', 'Reset')}
              </Button>
            ) : null}
            {props.file && canEdit ? (
              <Button size="sm" variant="primary" leadingIcon={<Save size={13} aria-hidden="true" />} onClick={props.onSave} disabled={!props.isDirty || props.isSaving} loading={props.isSaving}>
                {props.isSaving ? localize(language, '保存中…', 'Saving…') : localize(language, '保存', 'Save')}
              </Button>
            ) : null}
            <IconButton
              className="file-inspector-close"
              icon={<X size={15} aria-hidden="true" />}
              label={localize(language, '关闭文件面板', 'Close file panel')}
              onClick={props.onClose}
            />
          </div>
        </div>

        {props.file ? (
          <div className="file-inspector-toolbar">
            <div className="file-inspector-tabs">
              <Button className={`file-mode-button ${props.mode === 'edit' ? 'active' : ''}`} size="compact" variant="secondary" leadingIcon={<Code2 size={13} aria-hidden="true" />} onClick={() => props.onModeChange('edit')}>
                {localize(language, '源码', 'Source')}
              </Button>
              {previewable ? (
                <Button
                  className={`file-mode-button ${props.mode === 'preview' ? 'active' : ''}`}
                  size="compact"
                  variant="secondary"
                  leadingIcon={<Eye size={13} aria-hidden="true" />}
                  onClick={() => props.onModeChange('preview')}
                >
                  {localize(language, '预览', 'Preview')}
                </Button>
              ) : null}
              {showHtmlPreviewMode ? (
                <div className="html-preview-mode-group inline" role="group" aria-label={localize(language, 'HTML 预览模式', 'HTML preview mode')}>
                  <Button
                    className={`html-preview-mode-button ${htmlPreviewMode === 'fit' ? 'active' : ''}`}
                    size="compact"
                    variant="ghost"
                    onClick={() => setHtmlPreviewMode('fit')}
                  >
                    {localize(language, '适应窗口', 'Fit')}
                  </Button>
                  <Button
                    className={`html-preview-mode-button ${htmlPreviewMode === 'actual' ? 'active' : ''}`}
                    size="compact"
                    variant="ghost"
                    onClick={() => setHtmlPreviewMode('actual')}
                  >
                    {localize(language, '真实尺寸', 'Actual')}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className={props.saveError ? 'file-inspector-save-message error' : 'file-inspector-meta'}>
              {props.saveError || props.file.badge || (canEdit ? localize(language, '可编辑文本', 'Editable text') : localize(language, '预览模式', 'Preview mode'))}
            </div>
          </div>
        ) : null}

        <div className="file-inspector-body">
          {!props.file ? (
            <div className="file-inspector-empty">
              <div className="empty-agent-icon">📄</div>
              <strong>{localize(language, '打开一个项目文件', 'Open a project file')}</strong>
              <span>{localize(language, '左侧点击文件后，这里会显示源码编辑区；Markdown 和 HTML 文件可直接预览。', 'Click a file on the left to inspect source here; Markdown and HTML files can be previewed directly.')}</span>
            </div>
          ) : props.mode === 'preview' && previewable ? (
            renderFilePreview(props.file, props.draft, props.project, htmlPreviewMode)
          ) : canEdit ? (
            <SourceEditor file={props.file} value={props.draft} onChange={props.onDraftChange} />
          ) : (
            <BinaryPreviewFallback file={props.file} project={props.project} />
          )}
        </div>
      </div>
    </aside>
  );
}

export function mapProjectFileContentToOverlay(file: ProjectFileContent): ProjectFileItem {
  return {
    id: file.id,
    label: file.name,
    path: file.path,
    badge: file.isBinary ? 'Binary' : file.truncated ? 'Truncated' : undefined,
    content: file.content,
    isBinary: file.isBinary,
    mimeType: file.mimeType,
    previewDataUrl: file.previewDataUrl,
    documentPreview: file.documentPreview,
    size: file.size
  };
}

function FileTreeView(props: {
  nodes: FileTreeNode[];
  selectedFileId: string;
  collapsedFolderIds: Set<string>;
  forceExpanded: boolean;
  onToggleFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
  depth?: number;
}): JSX.Element {
  const language = useUiLanguage();
  const depth = props.depth ?? 0;

  return (
    <div className={depth === 0 ? 'file-tree-root' : 'file-tree-children'}>
      {depth === 0 && props.nodes.length === 0 ? <div className="file-tree-empty">{localize(language, '未读取到真实项目文件', 'No project files were loaded')}</div> : null}
      {props.nodes.map((node) => {
        const collapsed = !props.forceExpanded && props.collapsedFolderIds.has(node.id);
        const fileIcon = node.type === 'file' ? getFileIconInfo(node.path) : null;
        return node.type === 'folder' ? (
          <div key={node.id} className="file-tree-node">
            <Button
              className={`file-tree-folder-label ${collapsed ? 'collapsed' : 'expanded'}`}
              variant="ghost"
              size="compact"
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              onClick={() => props.onToggleFolder(node.id)}
            >
              <span className="file-tree-folder-caret">›</span>
              <FolderTreeIcon />
              <span className="file-item-label">{node.name}</span>
            </Button>
            {!collapsed && node.children.length > 0 ? (
              <FileTreeView
                nodes={node.children}
                selectedFileId={props.selectedFileId}
                collapsedFolderIds={props.collapsedFolderIds}
                forceExpanded={props.forceExpanded}
                onToggleFolder={props.onToggleFolder}
                onOpenFile={props.onOpenFile}
                depth={depth + 1}
              />
            ) : null}
          </div>
        ) : (
          <Button
            key={node.id}
            className={`file-item tree ${props.selectedFileId === node.fileId ? 'active' : ''}`}
            variant="ghost"
            size="compact"
            onClick={() => node.fileId && props.onOpenFile(node.fileId)}
            style={{ paddingLeft: `${depth * 14 + 28}px` }}
          >
            {fileIcon ? <FileTypeIcon kind={fileIcon.kind} /> : null}
            <span className="file-item-label">{node.name}</span>
            {node.badge ? <span className="file-badge">{node.badge}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

function buildProjectFileTree(files: ProjectFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const segments = file.path.split('/').filter(Boolean);
    let cursor = root;
    let currentPath = '';

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = file.type !== 'directory' && index === segments.length - 1;

      let existing = cursor.find((node) => node.name === segment && node.type === (isFile ? 'file' : 'folder'));
      if (!existing) {
        existing = {
          id: isFile ? file.id : `folder:${currentPath}`,
          name: segment,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          fileId: isFile ? file.path : undefined,
          badge: undefined,
          children: []
        };
        cursor.push(existing);
        cursor.sort((left, right) => {
          if (left.type !== right.type) {
            return left.type === 'folder' ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
      } else if (isFile) {
        existing.fileId = file.path;
        existing.badge = undefined;
      }

      cursor = existing.children;
    });
  }

  return root;
}

function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.reduce<FileTreeNode[]>((accumulator, node) => {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(normalizedQuery) || node.path.toLowerCase().includes(normalizedQuery)) {
        accumulator.push(node);
      }
      return accumulator;
    }

    const children = filterFileTree(node.children, normalizedQuery);
    if (children.length > 0 || node.name.toLowerCase().includes(normalizedQuery)) {
      accumulator.push({
        ...node,
        children
      });
    }
    return accumulator;
  }, []);
}

function SourceEditor(props: {
  file: ProjectFileItem;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const lineCount = useMemo(() => Math.max(1, props.value.split('\n').length), [props.value]);
  const highlightedLines = useMemo(
    () => props.value.split('\n').map((line) => highlightSourceLine(line, props.file.path)),
    [props.file.path, props.value]
  );
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1), [lineCount]);

  return (
    <div className="file-editor-shell">
      <div className="file-editor-gutter" aria-hidden="true">
        <div className="file-editor-gutter-lines" style={{ transform: `translateY(${-scroll.top}px)` }}>
          {lineNumbers.map((lineNumber) => (
            <span key={lineNumber} className="file-editor-gutter-line">
              {lineNumber}
            </span>
          ))}
        </div>
      </div>
      <div className="file-editor-code-area">
        <pre
          className="file-editor-highlight"
          aria-hidden="true"
          style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
        >
          {highlightedLines.map((tokens, lineIndex) => (
            <span key={`${lineIndex}-${tokens.length}`} className="file-editor-highlight-line">
              {tokens.length ? tokens.map((token, tokenIndex) => (
                token.kind ? (
                  <span key={`${lineIndex}-${tokenIndex}`} className={`editor-token ${token.kind}`}>
                    {token.text}
                  </span>
                ) : token.text
              )) : ' '}
            </span>
          ))}
        </pre>
        <TextAreaField
          className="file-editor-field"
          textareaClassName="file-editor-textarea"
          label="Source editor"
          spellCheck={false}
          wrap="off"
          value={props.value}
          onValueChange={props.onChange}
          onScroll={(event) => {
            setScroll({
              left: event.currentTarget.scrollLeft,
              top: event.currentTarget.scrollTop
            });
          }}
        />
      </div>
    </div>
  );
}

function formatInspectorTime(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}
