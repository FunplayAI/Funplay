import { type JSX } from 'react';
import { Boxes, FolderOpen, Gamepad2, Plus, Sparkles, WandSparkles, Workflow } from 'lucide-react';
import type { Project, McpPlugin } from '../../../shared/types';
import { StandaloneAppShell } from '../layout/AppShell';
import { localize, useUiLanguage } from '../../i18n';
import { formatProjectLocation, derivePlatform, formatRelativeDate } from '../../lib/app-helpers';
import { Button } from '../ui/index';

export function WelcomeScreen(props: {
  projects: Project[];
  mcpPlugins: McpPlugin[];
  onCreate: () => void;
  onOpen: (projectId: string) => void;
  onOpenExisting: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const recentProjects = props.projects.slice(0, 6);
  const capabilityItems = [
    {
      icon: <Sparkles size={17} aria-hidden="true" />,
      title: localize(language, '对话推进', 'Agent loop'),
      description: localize(language, '用自然语言拆任务、改文件、验证结果。', 'Plan, edit, and verify through chat.')
    },
    {
      icon: <Workflow size={17} aria-hidden="true" />,
      title: localize(language, '引擎接入', 'Engine bridge'),
      description: localize(language, '统一管理 Unity、MCP 与运行状态。', 'Coordinate Unity, MCP, and runtime state.')
    },
    {
      icon: <WandSparkles size={17} aria-hidden="true" />,
      title: localize(language, '素材生成', 'Asset generation'),
      description: localize(language, '生成图片、音频、模型并写入项目。', 'Create art, audio, and models into projects.')
    },
    {
      icon: <Boxes size={17} aria-hidden="true" />,
      title: localize(language, '项目资产', 'Project assets'),
      description: localize(language, '浏览文件树、预览素材、整理资源。', 'Browse files, preview assets, and organize work.')
    }
  ];

  return (
    <StandaloneAppShell title="Funplay">
      <div className="welcome-screen">
        <div className="welcome-content">
          <section className="welcome-hero-panel" aria-labelledby="welcome-title">
            <div className="welcome-hero-copy">
              <div className="welcome-brand-row">
                <img className="welcome-logo" src="./logo.png" alt="Funplay" />
                <div>
                  <div className="section-heading">{localize(language, 'AI 游戏开发工作台', 'AI Game Development Workbench')}</div>
                  <div className="welcome-brand-note">{localize(language, '从想法到可玩的项目', 'From idea to playable project')}</div>
                </div>
              </div>
              <h1 id="welcome-title">{localize(language, '用 AI 开始做游戏', 'Start making games with AI')}</h1>
              <p className="welcome-description">{localize(language, 'Funplay 把项目创建、Agent 对话、游戏引擎接入、文件预览和素材生成放在一个桌面工作台里，让不熟悉复杂引擎流程的人也能快速推进精品游戏原型。', 'Funplay brings project setup, agent chat, engine bridges, file previews, and asset generation into one desktop workbench so more people can move from an idea to a polished game prototype.')}</p>
            </div>

            <div className="welcome-actions">
              <Button variant="primary" leadingIcon={<Plus size={15} aria-hidden="true" />} onClick={props.onCreate}>
                {localize(language, '新建项目', 'Create Project')}
              </Button>
              <Button variant="secondary" leadingIcon={<FolderOpen size={15} aria-hidden="true" />} onClick={props.onOpenExisting}>
                {localize(language, '打开已有项目', 'Open Existing Project')}
              </Button>
            </div>

            <div className="welcome-capability-grid" aria-label={localize(language, 'Funplay 能力', 'Funplay capabilities')}>
              {capabilityItems.map((item) => (
                <div className="welcome-capability-card" key={item.title}>
                  <div className="welcome-capability-icon">{item.icon}</div>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <aside className="welcome-list-panel">
            <div className="welcome-list-header">
              <div>
                <div className="section-heading">{localize(language, '最近项目', 'Recent Projects')}</div>
                <div className="helper-copy">{localize(language, '从上次中断的地方继续。', 'Resume where you left off.')}</div>
              </div>
              <Button size="sm" variant="secondary" leadingIcon={<FolderOpen size={13} aria-hidden="true" />} onClick={props.onOpenExisting}>
                {localize(language, '打开项目', 'Open Project')}
              </Button>
            </div>

            <div className="welcome-list">
              {recentProjects.length === 0 ? (
                <div className="welcome-empty-state">
                  <div className="welcome-empty-icon"><Gamepad2 size={22} aria-hidden="true" /></div>
                  <strong>{localize(language, '还没有项目', 'No projects yet')}</strong>
                  <span>{localize(language, '创建第一个游戏项目，或者导入一个已有工程开始接入 Agent。', 'Create your first game project, or import an existing workspace to connect the agent.')}</span>
                  <Button size="sm" variant="secondary" leadingIcon={<Plus size={13} aria-hidden="true" />} onClick={props.onCreate}>
                    {localize(language, '创建项目', 'Create Project')}
                  </Button>
                </div>
              ) : null}
              {recentProjects.map((project) => (
                <Button key={project.id} variant="ghost" size="compact" className="welcome-project" onClick={() => props.onOpen(project.id)}>
                  <div className="welcome-project-icon">{project.name.charAt(0).toUpperCase()}</div>
                  <div className="welcome-project-copy">
                    <div className="welcome-project-name">{project.name}</div>
                    <div className="welcome-project-meta">
                      {`${formatProjectLocation(project.engine?.projectPath, project.name)} · ${derivePlatform(project, props.mcpPlugins)} · ${formatRelativeDate(project.updatedAt)}`}
                    </div>
                  </div>
                </Button>
              ))}
            </div>

            <div className="welcome-list-footer">
              <div>
                <div className="section-heading">{localize(language, '下一步', 'Next step')}</div>
                <div className="helper-copy">{localize(language, '选择一个入口，Funplay 会把后续配置收进向导。', 'Pick an entry point and Funplay will guide the setup from there.')}</div>
              </div>
              <div className="welcome-start-strip">
                <div>
                  <span>{localize(language, '推荐', 'Recommended')}</span>
                  <strong>{localize(language, '先创建一个轻量 Web Demo 验证玩法', 'Start with a lightweight Web demo')}</strong>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </StandaloneAppShell>
  );
}
