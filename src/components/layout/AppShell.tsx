import { Command as CommandPrimitive } from 'cmdk';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Boxes, Command as CommandIcon, Download, FolderTree, ListChecks, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings, Sparkles, X } from 'lucide-react';
import type { AppUpdateSnapshot } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Button, IconButton, useDialogFocus } from '../ui/index';

export interface AppShellProject {
  id: string;
  name: string;
  processing?: boolean;
  runningCount?: number;
  pendingApprovalCount?: number;
  failedCount?: number;
}

export interface PanelRenderArgs {
  width: number;
  close: () => void;
}

type CommandPaletteAction = {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: ReactNode;
  run: () => void;
};

export function StandaloneAppShell(props: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="fp-app-shell standalone-app-shell">
      <div className="titlebar-shell standalone-titlebar-shell">
        <div className="titlebar-top-row">
          <div className="titlebar-drag-spacer left" />
          <div className="standalone-title-copy">{props.title}</div>
          <div className="titlebar-drag-spacer right" />
        </div>
      </div>
      <div className="standalone-shell-content">{props.children}</div>
    </div>
  );
}

export function AppShell(props: {
  projects: AppShellProject[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onAddProject: () => void;
  onOpenAppSettings: () => void;
  onOpenAgentWorkspace?: () => void;
  onOpenProjectSettings?: () => void;
  onOpenAssets?: () => void;
  appUpdateStatus?: AppUpdateSnapshot | null;
  onOpenAppUpdate?: () => void;
  showChangePanelToggle?: boolean;
  changePanelOpen?: boolean;
  onToggleChangePanel?: () => void;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeftSidebar: () => void;
  onToggleRightInspector: () => void;
  leftWidth: number;
  rightWidth: number;
  onLeftWidthChange: (value: number) => void;
  onRightWidthChange: (value: number) => void;
  renderLeftPanel?: (args: PanelRenderArgs) => ReactNode;
  renderRightPanel?: (args: PanelRenderArgs) => ReactNode;
  defaultCommandPaletteOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const language = useUiLanguage();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(Boolean(props.defaultCommandPaletteOpen));
  const commandPaletteDialogRef = useRef<HTMLDivElement | null>(null);
  const commandPaletteInputRef = useRef<HTMLInputElement | null>(null);
  const handleLeftResize = useCallback((delta: number) => {
    props.onLeftWidthChange(clampNumber(props.leftWidth + delta, 240, 520));
  }, [props.leftWidth, props.onLeftWidthChange]);

  const handleRightResize = useCallback((delta: number) => {
    props.onRightWidthChange(clampNumber(props.rightWidth - delta, 320, 820));
  }, [props.rightWidth, props.onRightWidthChange]);
  const showUpdateButton = shouldShowTitlebarUpdateButton(props.appUpdateStatus);
  const updateButtonLabel = getTitlebarUpdateButtonLabel(props.appUpdateStatus, language);
  const commandPaletteLabel = localize(language, '打开命令面板', 'Open command palette');
  const commandPaletteShortcut = localize(language, '⌘K / Ctrl K', '⌘K / Ctrl K');
  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);
  const runCommandPaletteAction = useCallback((action: () => void) => {
    action();
    closeCommandPalette();
  }, [closeCommandPalette]);
  const commandPaletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    if (props.onOpenAgentWorkspace) {
      actions.push({
        id: 'open-agent',
        label: localize(language, 'Agent 工作区', 'Agent workspace'),
        description: localize(language, '回到对话和执行现场', 'Return to the chat and execution surface'),
        keywords: 'agent chat workspace',
        icon: <Sparkles size={16} aria-hidden="true" />,
        run: props.onOpenAgentWorkspace
      });
    }
    if (props.onOpenProjectSettings) {
      actions.push({
        id: 'open-project-settings',
        label: localize(language, '项目设置', 'Project settings'),
        description: localize(language, '打开当前项目的 Agent、MCP、Provider 和用量设置', 'Open Agent, MCP, provider, and usage settings for this project'),
        keywords: 'project settings agent mcp provider usage',
        icon: <Settings size={16} aria-hidden="true" />,
        run: props.onOpenProjectSettings
      });
    }
    if (props.onOpenAssets) {
      actions.push({
        id: 'open-assets',
        label: localize(language, '素材库', 'Assets'),
        description: localize(language, '查看项目资源和文件素材', 'Browse project assets and resource files'),
        keywords: 'assets files media',
        icon: <Boxes size={16} aria-hidden="true" />,
        run: props.onOpenAssets
      });
    }
    actions.push({
      id: 'toggle-files',
      label: props.leftCollapsed ? localize(language, '显示项目文件树', 'Show project files') : localize(language, '隐藏项目文件树', 'Hide project files'),
      description: localize(language, '切换左侧项目文件和会话栏', 'Toggle the left project files and session sidebar'),
      keywords: 'files sidebar sessions',
      icon: <FolderTree size={16} aria-hidden="true" />,
      run: props.onToggleLeftSidebar
    });
    if (props.renderRightPanel) {
      actions.push({
        id: 'toggle-inspector',
        label: props.rightCollapsed ? localize(language, '显示文件检查器', 'Show file inspector') : localize(language, '隐藏文件检查器', 'Hide file inspector'),
        description: localize(language, '切换右侧文件预览和编辑面板', 'Toggle the right file preview and editor panel'),
        keywords: 'inspector preview editor',
        icon: <PanelRight size={16} aria-hidden="true" />,
        run: props.onToggleRightInspector
      });
    }
    if (props.showChangePanelToggle && props.onToggleChangePanel) {
      actions.push({
        id: 'toggle-changes',
        label: props.changePanelOpen ? localize(language, '隐藏本轮变更', 'Hide current run changes') : localize(language, '打开本轮变更', 'Open current run changes'),
        description: localize(language, '查看当前 Agent 运行产生的文件变更', 'Review file changes from the current Agent run'),
        keywords: 'changes diff current run',
        icon: <ListChecks size={16} aria-hidden="true" />,
        run: props.onToggleChangePanel
      });
    }
    actions.push({
      id: 'open-app-settings',
      label: localize(language, '应用设置', 'App settings'),
      description: localize(language, '打开全局 Provider、MCP、外观和更新设置', 'Open global provider, MCP, appearance, and update settings'),
      keywords: 'app settings global provider mcp update',
      icon: <Settings size={16} aria-hidden="true" />,
      run: props.onOpenAppSettings
    });
    actions.push({
      id: 'new-project',
      label: localize(language, '新建项目', 'New project'),
      description: localize(language, '进入项目创建和导入流程', 'Start project creation or import'),
      keywords: 'new project create import',
      icon: <Plus size={16} aria-hidden="true" />,
      run: props.onAddProject
    });
    for (const project of props.projects) {
      actions.push({
        id: `switch-project-${project.id}`,
        label: localize(language, `切换到 ${project.name}`, `Switch to ${project.name}`),
        description: project.id === props.selectedProjectId
          ? localize(language, '当前项目', 'Current project')
          : localize(language, '切换工作项目', 'Switch active project'),
        keywords: `project ${project.name}`,
        icon: <span className={`command-palette-project-dot ${project.processing ? 'processing' : project.id === props.selectedProjectId ? 'active' : ''}`} aria-hidden="true" />,
        run: () => props.onSelectProject(project.id)
      });
    }
    return actions;
  }, [
    language,
    props.onOpenAgentWorkspace,
    props.onOpenProjectSettings,
    props.onOpenAssets,
    props.leftCollapsed,
    props.rightCollapsed,
    props.showChangePanelToggle,
    props.changePanelOpen,
    props.projects,
    props.selectedProjectId,
    props.onToggleLeftSidebar,
    props.onToggleRightInspector,
    props.renderRightPanel,
    props.onToggleChangePanel,
    props.onOpenAppSettings,
    props.onAddProject,
    props.onSelectProject
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key === 'Escape' && commandPaletteOpen) {
        event.preventDefault();
        closeCommandPalette();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [commandPaletteOpen, closeCommandPalette]);

  useDialogFocus({
    enabled: commandPaletteOpen,
    containerRef: commandPaletteDialogRef,
    initialFocusRef: commandPaletteInputRef,
    onEscape: closeCommandPalette
  });

  return (
    <div className="fp-app-shell">
      <div className="titlebar-shell">
        <div className="titlebar-top-row">
          <div className="titlebar-drag-spacer left" />
          <IconButton
            className="titlebar-icon-button command-palette-toggle"
            onClick={() => {
              setCommandPaletteOpen(true);
            }}
            label={commandPaletteLabel}
            aria-keyshortcuts="Meta+K Control+K"
            icon={<CommandIcon size={18} aria-hidden="true" />}
          />
          <IconButton
            className={`titlebar-icon-button file-tree-toggle ${props.leftCollapsed ? '' : 'active'}`}
            onClick={props.onToggleLeftSidebar}
            label={props.leftCollapsed ? localize(language, '显示项目文件树', 'Show project files') : localize(language, '隐藏项目文件树', 'Hide project files')}
            icon={props.leftCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          />
          <div className="project-tabs">
            {props.projects.map((project) => (
              <div key={project.id} className={`project-tab-shell ${project.id === props.selectedProjectId ? 'active' : ''}`}>
                <Button
                  variant="ghost"
                  size="compact"
                  className={`project-tab ${project.id === props.selectedProjectId ? 'active' : ''}`}
                  onClick={() => props.onSelectProject(project.id)}
                >
                  <span className={`project-tab-status ${project.processing ? 'processing' : project.id === props.selectedProjectId ? 'active' : ''}`}>
                    {project.processing ? <span className="processing-spinner" /> : <span className="project-tab-dot" />}
                  </span>
                  <span className="project-tab-label">{project.name}</span>
                  {project.runningCount || project.pendingApprovalCount || project.failedCount ? (
                    <span className="project-tab-badges">
                      {project.runningCount ? <span className="project-tab-badge running">{project.runningCount}</span> : null}
                      {project.pendingApprovalCount ? <span className="project-tab-badge approval">{project.pendingApprovalCount}</span> : null}
                      {project.failedCount ? <span className="project-tab-badge failed">{project.failedCount}</span> : null}
                    </span>
                  ) : null}
                </Button>
                <IconButton
                  className="project-tab-close"
                  onClick={() => props.onDeleteProject(project.id)}
                  label={localize(language, `删除项目 ${project.name}`, `Remove project ${project.name}`)}
                  icon={<X size={14} aria-hidden="true" />}
                />
              </div>
            ))}
            <Button className="project-tab add" variant="ghost" size="compact" leadingIcon={<Plus size={14} aria-hidden="true" />} onClick={props.onAddProject}>
              {localize(language, '新建项目', 'New Project')}
            </Button>
          </div>
          {showUpdateButton && props.onOpenAppUpdate ? (
            <Button
              variant="ghost"
              size="compact"
              className={`titlebar-icon-button titlebar-update-toggle ${props.appUpdateStatus?.status ?? 'idle'}`}
              onClick={props.onOpenAppUpdate}
              aria-label={updateButtonLabel}
              title={updateButtonLabel}
            >
              <Download size={18} aria-hidden="true" />
              {props.appUpdateStatus?.status === 'downloading' ? <span className="titlebar-update-spinner" /> : <span className="titlebar-update-dot" />}
            </Button>
          ) : null}
          {props.showChangePanelToggle && props.onToggleChangePanel ? (
            <IconButton
              className={`titlebar-icon-button titlebar-changes-toggle ${props.changePanelOpen ? 'active' : ''}`}
              onClick={props.onToggleChangePanel}
              aria-pressed={Boolean(props.changePanelOpen)}
              label={props.changePanelOpen ? localize(language, '隐藏本轮变更', 'Hide current run changes') : localize(language, '打开本轮变更', 'Open current run changes')}
              icon={<ListChecks size={18} aria-hidden="true" />}
            />
          ) : null}
          <IconButton
            className="titlebar-icon-button app-settings-toggle"
            onClick={props.onOpenAppSettings}
            label={localize(language, '打开应用设置', 'Open app settings')}
            icon={<Settings size={18} aria-hidden="true" />}
          />
        </div>
      </div>
      {commandPaletteOpen ? (
        <div className="command-palette-backdrop" data-command-palette-state="open" onMouseDown={closeCommandPalette}>
          <div
            ref={commandPaletteDialogRef}
            className="command-palette-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={localize(language, '命令面板', 'Command palette')}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <CommandPrimitive className="command-palette" label={localize(language, '命令面板', 'Command palette')}>
              <div className="command-palette-search">
                <Search size={16} aria-hidden="true" />
                <CommandPrimitive.Input
                  ref={commandPaletteInputRef}
                  className="command-palette-input"
                  placeholder={localize(language, '搜索动作、项目、设置...', 'Search actions, projects, settings...')}
                />
                <kbd>{commandPaletteShortcut}</kbd>
              </div>
              <CommandPrimitive.List className="command-palette-list">
                <CommandPrimitive.Empty className="command-palette-empty">
                  {localize(language, '没有匹配命令', 'No matching commands')}
                </CommandPrimitive.Empty>
                <CommandPrimitive.Group heading={localize(language, '常用动作', 'Common actions')} className="command-palette-group">
                  {commandPaletteActions.map((action) => (
                    <CommandPrimitive.Item
                      key={action.id}
                      value={`${action.label} ${action.description} ${action.keywords}`}
                      className="command-palette-item"
                      data-command-id={action.id}
                      onSelect={() => runCommandPaletteAction(action.run)}
                    >
                      <span className="command-palette-item-icon">{action.icon}</span>
                      <span className="command-palette-item-copy">
                        <strong>{action.label}</strong>
                        <span>{action.description}</span>
                      </span>
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              </CommandPrimitive.List>
            </CommandPrimitive>
          </div>
        </div>
      ) : null}

      <div className="desktop-workspace">
        {!props.leftCollapsed && props.renderLeftPanel ? (
          <>
            {props.renderLeftPanel({
              width: props.leftWidth,
              close: props.onToggleLeftSidebar
            })}
            <PanelResizeHandle side="right" onResize={handleLeftResize} />
          </>
        ) : null}

        <div className="workspace-center-stack">{props.children}</div>

        {!props.rightCollapsed && props.renderRightPanel ? (
          <>
            <PanelResizeHandle side="left" onResize={handleRightResize} />
            {props.renderRightPanel({
              width: props.rightWidth,
              close: props.onToggleRightInspector
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

function PanelResizeHandle(props: { side: 'left' | 'right'; onResize: (delta: number) => void }): ReactNode {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);

  return (
    <div
      className={`panel-resize-handle ${props.side}`}
      onPointerDown={(event) => {
        event.preventDefault();
        draggingRef.current = true;
        startXRef.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) {
          return;
        }
        const delta = event.clientX - startXRef.current;
        startXRef.current = event.clientX;
        props.onResize(delta);
      }}
      onPointerUp={(event) => {
        if (!draggingRef.current) {
          return;
        }
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }}
    >
      <div />
    </div>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shouldShowTitlebarUpdateButton(status: AppUpdateSnapshot | null | undefined): boolean {
  return status?.status === 'available' || status?.status === 'downloaded' || status?.status === 'downloading' || status?.status === 'installing';
}

function getTitlebarUpdateButtonLabel(status: AppUpdateSnapshot | null | undefined, language: 'zh-CN' | 'en-US'): string {
  const version = status?.updateInfo?.version ? ` ${status.updateInfo.version}` : '';
  if (status?.status === 'downloaded') {
    return localize(language, `更新已下载，打开安装${version}`, `Update downloaded, open installer${version}`);
  }
  if (status?.status === 'downloading') {
    const percent = status.progress ? ` ${Math.round(status.progress.percent)}%` : '';
    return localize(language, `正在下载更新${percent}`, `Downloading update${percent}`);
  }
  if (status?.status === 'installing') {
    return localize(language, '正在安装更新', 'Installing update');
  }
  return localize(language, `查看软件更新${version}`, `View software update${version}`);
}
