import { useCallback, useRef, type ReactNode } from 'react';
import type { AppUpdateSnapshot } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';

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

export function StandaloneAppShell(props: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="prototype-shell standalone-app-shell">
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
  children: ReactNode;
}): ReactNode {
  const language = useUiLanguage();
  const handleLeftResize = useCallback((delta: number) => {
    props.onLeftWidthChange(clampNumber(props.leftWidth + delta, 240, 520));
  }, [props.leftWidth, props.onLeftWidthChange]);

  const handleRightResize = useCallback((delta: number) => {
    props.onRightWidthChange(clampNumber(props.rightWidth - delta, 320, 820));
  }, [props.rightWidth, props.onRightWidthChange]);
  const showUpdateButton = shouldShowTitlebarUpdateButton(props.appUpdateStatus);
  const updateButtonLabel = getTitlebarUpdateButtonLabel(props.appUpdateStatus, language);

  return (
    <div className="prototype-shell">
      <div className="titlebar-shell">
        <div className="titlebar-top-row">
          <div className="titlebar-drag-spacer left" />
          <button
            className={`titlebar-icon-button file-tree-toggle ${props.leftCollapsed ? '' : 'active'}`}
            onClick={props.onToggleLeftSidebar}
            aria-label={props.leftCollapsed ? localize(language, '显示项目文件树', 'Show project files') : localize(language, '隐藏项目文件树', 'Hide project files')}
            title={props.leftCollapsed ? localize(language, '显示项目文件树', 'Show project files') : localize(language, '隐藏项目文件树', 'Hide project files')}
          >
            <span />
            <span />
          </button>
          <div className="project-tabs">
            {props.projects.map((project) => (
              <div key={project.id} className={`project-tab-shell ${project.id === props.selectedProjectId ? 'active' : ''}`}>
                <button
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
                </button>
                <button
                  className="project-tab-close"
                  onClick={() => props.onDeleteProject(project.id)}
                  aria-label={localize(language, `删除项目 ${project.name}`, `Remove project ${project.name}`)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="project-tab add" onClick={props.onAddProject}>
              {localize(language, '+ 新建项目', '+ New Project')}
            </button>
          </div>
          {showUpdateButton && props.onOpenAppUpdate ? (
            <button
              className={`titlebar-icon-button titlebar-update-toggle ${props.appUpdateStatus?.status ?? 'idle'}`}
              onClick={props.onOpenAppUpdate}
              aria-label={updateButtonLabel}
              title={updateButtonLabel}
            >
              <UpdateIcon />
              {props.appUpdateStatus?.status === 'downloading' ? <span className="titlebar-update-spinner" /> : <span className="titlebar-update-dot" />}
            </button>
          ) : null}
          {props.showChangePanelToggle && props.onToggleChangePanel ? (
            <button
              className={`titlebar-icon-button titlebar-changes-toggle ${props.changePanelOpen ? 'active' : ''}`}
              onClick={props.onToggleChangePanel}
              aria-pressed={Boolean(props.changePanelOpen)}
              aria-label={props.changePanelOpen ? localize(language, '隐藏本轮变更', 'Hide current run changes') : localize(language, '打开本轮变更', 'Open current run changes')}
              title={props.changePanelOpen ? localize(language, '隐藏本轮变更', 'Hide current run changes') : localize(language, '打开本轮变更', 'Open current run changes')}
            >
              <ChangesPanelIcon />
            </button>
          ) : null}
          <button
            className="titlebar-icon-button app-settings-toggle"
            onClick={props.onOpenAppSettings}
            aria-label={localize(language, '打开应用设置', 'Open app settings')}
            title={localize(language, '应用设置', 'App settings')}
          >
            <SettingsIcon />
          </button>
        </div>
      </div>

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

function ChangesPanelIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M4.5 5.5h11M4.5 10h7M4.5 14.5h5" />
      <path d="M13.5 10.5 15.5 12.5 13.5 14.5" />
    </svg>
  );
}

function UpdateIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 3.5v9" />
      <path d="M6.5 9.5 10 13l3.5-3.5" />
      <path d="M5 16.5h10" />
    </svg>
  );
}

function SettingsIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 3.2v2M10 14.8v2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M3.2 10h2M14.8 10h2M5.2 14.8l1.4-1.4M13.4 6.6l1.4-1.4" />
      <circle cx="10" cy="10" r="3.1" />
    </svg>
  );
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
