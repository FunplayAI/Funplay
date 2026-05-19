import { type JSX } from 'react';
import type { Project, McpPlugin } from '../../../shared/types';
import { StandaloneAppShell } from '../layout/AppShell';
import { localize, useUiLanguage } from '../../i18n';
import { formatProjectLocation, derivePlatform, formatRelativeDate } from '../../lib/app-helpers';

export function WelcomeScreen(props: {
  projects: Project[];
  mcpPlugins: McpPlugin[];
  onCreate: () => void;
  onOpen: (projectId: string) => void;
  onOpenExisting: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const recentProjects = props.projects.slice(0, 6);

  return (
    <StandaloneAppShell title="Funplay">
      <div className="welcome-screen">
        <div className="welcome-content">
          <section className="welcome-hero-panel">
            <div className="welcome-hero-copy">
              <img className="welcome-logo" src="./logo.png" alt="Funplay" />
              <div className="section-heading">Desktop Workspace</div>
              <h1>Funplay</h1>
              <p className="welcome-subtitle">{localize(language, 'AI 项目工作台', 'AI Project Workspace')}</p>
              <p className="welcome-description">{localize(language, '在一个桌面应用里完成通用项目创建、AI 对话、文件查看、引擎接入和执行推进。', 'Create generic projects, chat with AI, inspect files, connect engines, and push execution forward in one desktop app.')}</p>
            </div>

            <div className="welcome-actions">
              <button className="prototype-primary" onClick={props.onCreate}>
                {localize(language, '创建新项目', 'Create New Project')}
              </button>
              <button className="prototype-secondary" onClick={props.onOpenExisting}>
                {localize(language, '打开已有项目', 'Open Existing Project')}
              </button>
            </div>
          </section>

          <aside className="welcome-list-panel">
            <div className="welcome-list-header">
              <div>
                <div className="section-heading">{localize(language, '最近项目', 'Recent Projects')}</div>
                <div className="helper-copy">{localize(language, '从上次中断的地方继续。', 'Resume where you left off.')}</div>
              </div>
              <button className="prototype-secondary small" onClick={props.onOpenExisting}>
                {localize(language, '打开项目', 'Open Project')}
              </button>
            </div>

            <div className="welcome-list">
              {recentProjects.length === 0 ? <div className="empty-note welcome-empty-state">{localize(language, '暂无最近项目', 'No recent projects')}</div> : null}
              {recentProjects.map((project) => (
                <button key={project.id} className="welcome-project" onClick={() => props.onOpen(project.id)}>
                  <div className="welcome-project-icon">{project.name.charAt(0).toUpperCase()}</div>
                  <div className="welcome-project-copy">
                    <div className="welcome-project-name">{project.name}</div>
                    <div className="welcome-project-meta">
                      {`${formatProjectLocation(project.engine?.projectPath, project.name)} · ${derivePlatform(project, props.mcpPlugins)} · ${formatRelativeDate(project.updatedAt)}`}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="welcome-list-footer">
              <div className="section-heading">{localize(language, '工作台能力', 'Workspace Capabilities')}</div>
              <div className="welcome-capability-list">
                <div>{localize(language, 'AI 对话驱动项目推进', 'AI chat drives project progress')}</div>
                <div>{localize(language, 'Unity / MCP 环境接入', 'Unity / MCP integration')}</div>
                <div>{localize(language, '项目文件树与预览面板', 'Project file tree and preview panel')}</div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </StandaloneAppShell>
  );
}
