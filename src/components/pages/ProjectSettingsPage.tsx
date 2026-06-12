import { useMemo, type JSX } from 'react';
import { Bot, Cpu, Gauge, History, Plug, Sparkles, type LucideIcon } from 'lucide-react';
import type {
  AgentPermissionMode,
  AgentRuntimeStatus,
  AgentSkillCatalogItem,
  AgentSkillCatalogResult,
  AiProvider,
  McpConnectionSnapshot,
  McpPlugin,
  McpRawAuditEntry,
  McpRawRequestResult,
  McpToolSnapshot,
  Project,
  ProjectAgentSkill,
  ProjectSession,
  ProjectSessionEffort,
  UnityMcpPrompt,
  UnityMcpResource,
  UnityMcpResourceTemplate,
  UnityMcpServerInfo,
  UnityMcpTool
} from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { ProjectAgentSkillDraft, ProjectMcpBindingDraft, ProjectSettingsTab } from '../../lib/app-types';
import { formatPlatformLabel } from '../../lib/app-helpers';
import { Button } from '../ui/index';
import { McpManagementPage } from './McpManagementPage';
import { SkillsPage } from './SkillsPage';
import { EngineProjectSettings } from './project-settings/EngineProjectSettings';
import { ProjectTokenUsageSettings } from './project-settings/ProjectTokenUsageSettings';
import { ProjectAgentRunsSettings } from './project-settings/ProjectAgentRunsSettings';
import { ProjectAgentSettings, type SessionRuntimeUpdate } from './project-settings/ProjectAgentSettings';
import {
  buildProjectAgentRunSummary,
  buildProjectTokenUsage,
  formatNumber,
  formatTokenCount
} from './project-settings/metrics';

export function ProjectSettingsPage(props: {
  tab: ProjectSettingsTab;
  onTabChange: (tab: ProjectSettingsTab) => void;
  project: Project | null;
  plugins: McpPlugin[];
  selectedPlugin: McpPlugin | null;
  serverInfo: UnityMcpServerInfo | null;
  tools: UnityMcpTool[];
  toolSnapshots: McpToolSnapshot[];
  rawAudits: McpRawAuditEntry[];
  resources: UnityMcpResource[];
  prompts: UnityMcpPrompt[];
  resourceTemplates: UnityMcpResourceTemplate[];
  connectionStatus: McpConnectionSnapshot | null;
  connectionStatuses: Record<string, McpConnectionSnapshot>;
  pluginError: string;
  isRefreshing: boolean;
  projectBindings: ProjectMcpBindingDraft;
  skillDraft: ProjectAgentSkillDraft;
  editingSkillId: string;
  skillCatalog: AgentSkillCatalogResult | null;
  isLoadingSkillCatalog: boolean;
  skillCatalogError: string;
  providers: AiProvider[];
  activeProvider: AiProvider | null;
  defaultProviderId?: string;
  activeSession: ProjectSession | null;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionEffort: ProjectSessionEffort;
  runtimeStatuses: AgentRuntimeStatus[];
  onUpdateProjectPermissionMode: (permissionMode: AgentPermissionMode) => Promise<void>;
  onUpdateSessionRuntime: (runtime: SessionRuntimeUpdate) => Promise<void>;
  onRefreshSkillCatalog: () => Promise<void>;
  onInstallCatalogSkill: (skill: AgentSkillCatalogItem) => Promise<void>;
  onChangeSkillDraft: (draft: ProjectAgentSkillDraft) => void;
  onSaveProjectSkill: () => Promise<void>;
  onEditProjectSkill: (skill: ProjectAgentSkill) => void;
  onCancelProjectSkillEdit: () => void;
  onToggleProjectSkill: (skillId: string) => Promise<void>;
  onDeleteProjectSkill: (skillId: string) => Promise<void>;
  onRefreshPluginMeta: () => void;
  onOpenMcpRegistry: () => void;
  onSelectProjectMcpPlugin: (pluginId: string) => void;
  onToggleProjectMcpPlugin: (pluginId: string, enabled: boolean) => void;
  onAddProjectMcpPlugin: () => void;
  onEditProjectMcpPlugin: (plugin: McpPlugin) => void;
  onDeleteProjectMcpPlugin: (pluginId: string) => void;
  onSendRawMcpRequest: (
    pluginId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<McpRawRequestResult>;
  onReconnectMcpPlugin: () => void;
  onStopMcpPlugin: () => void;
  onResumeAgentRun: (runId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const projectUsage = useMemo(
    () =>
      buildProjectTokenUsage({
        project: props.project,
        runtimeStatuses: props.runtimeStatuses,
        providers: props.providers
      }),
    [props.project?.id, props.providers, props.runtimeStatuses]
  );
  const projectRuns = useMemo(
    () =>
      buildProjectAgentRunSummary({
        project: props.project,
        runtimeStatuses: props.runtimeStatuses,
        providers: props.providers
      }),
    [props.project?.id, props.providers, props.runtimeStatuses]
  );
  const projectMcpServerCount = useMemo(() => {
    const bindings = props.project?.mcpBindings ?? {};
    return new Set(
      [...(bindings.servers ?? []), bindings.engine, bindings.asset, bindings.qa, bindings.custom].filter(Boolean)
    ).size;
  }, [props.project?.mcpBindings]);
  const settingsNavItems: Array<{
    id: ProjectSettingsTab;
    label: string;
    description: string;
    badge: string;
    Icon: LucideIcon;
  }> = [
    {
      id: 'engine',
      label: t('引擎项目', 'Engine Project'),
      description: t('路径、平台、运行状态', 'Path, platform, runtime'),
      badge: props.project?.engine?.platform
        ? formatPlatformLabel(props.project.engine.platform)
        : t('未绑定', 'Unbound'),
      Icon: Cpu
    },
    {
      id: 'agent',
      label: 'Agent',
      description: t('模型与项目策略', 'Model and project policy'),
      badge: props.activeSession
        ? props.sessionModel || props.activeProvider?.model || t('默认模型', 'Default Model')
        : t('未选择', 'No Session'),
      Icon: Bot
    },
    {
      id: 'usage',
      label: t('用量', 'Usage'),
      description: t('项目 Token 统计', 'Project token usage'),
      badge: formatTokenCount(projectUsage.totalTokens, language),
      Icon: Gauge
    },
    {
      id: 'runs',
      label: t('Agent 运行', 'Agent Runs'),
      description: t('历史、恢复与验证', 'History, recovery, verification'),
      badge:
        projectRuns.resumableRunCount > 0
          ? t(`${projectRuns.resumableRunCount} 可恢复`, `${projectRuns.resumableRunCount} resumable`)
          : formatNumber(projectRuns.trackedRunCount, language),
      Icon: History
    },
    {
      id: 'mcp',
      label: 'MCP',
      description: t('项目级 Server 与运行检查', 'Project servers and runtime checks'),
      badge: t(`${projectMcpServerCount} 启用`, `${projectMcpServerCount} enabled`),
      Icon: Plug
    },
    {
      id: 'skills',
      label: 'Skills',
      description: t('用户赋予 Agent 的项目技能', 'User-provided agent skills'),
      badge: t(
        `${props.project?.agentPolicy?.skills?.filter((skill) => skill.enabled).length ?? 0} 启用`,
        `${props.project?.agentPolicy?.skills?.filter((skill) => skill.enabled).length ?? 0} enabled`
      ),
      Icon: Sparkles
    }
  ];
  const activeItem = settingsNavItems.find((item) => item.id === props.tab) ?? settingsNavItems[0];

  return (
    <div className="project-settings-page">
      <aside className="project-settings-sidebar">
        <div className="project-settings-sidebar-header">
          <div className="sidebar-section-label">{t('项目设置', 'Project Settings')}</div>
          <h2>{props.project?.name || t('当前项目', 'Current Project')}</h2>
        </div>

        <nav className="project-settings-nav" aria-label={t('项目设置分类', 'Project settings categories')}>
          {settingsNavItems.map((item) => (
            <Button
              key={item.id}
              size="compact"
              variant="ghost"
              className={`project-settings-nav-item ${props.tab === item.id ? 'active' : ''}`}
              aria-current={props.tab === item.id ? 'page' : undefined}
              title={`${item.label} · ${item.description} · ${item.badge}`}
              onClick={() => props.onTabChange(item.id)}
            >
              <span className="project-settings-nav-icon" aria-hidden="true">
                <item.Icon size={15} />
              </span>
              <span className="project-settings-nav-copy">
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </span>
              <span className="project-settings-nav-badge">{item.badge}</span>
            </Button>
          ))}
        </nav>
      </aside>

      <section className="project-settings-detail">
        <div className="project-settings-detail-header">
          <div>
            <h2>{activeItem.label}</h2>
            <p>{activeItem.description}</p>
          </div>
        </div>

        <div className="project-settings-detail-body">
          {props.tab === 'engine' ? <EngineProjectSettings project={props.project} /> : null}
          {props.tab === 'agent' ? (
            <ProjectAgentSettings
              project={props.project}
              providers={props.providers}
              activeProvider={props.activeProvider}
              defaultProviderId={props.defaultProviderId}
              activeSession={props.activeSession}
              sessionProviderId={props.sessionProviderId}
              sessionModel={props.sessionModel}
              sessionEffort={props.sessionEffort}
              onUpdatePermissionMode={props.onUpdateProjectPermissionMode}
              onUpdateSessionRuntime={props.onUpdateSessionRuntime}
            />
          ) : null}
          {props.tab === 'usage' ? <ProjectTokenUsageSettings project={props.project} usage={projectUsage} /> : null}
          {props.tab === 'runs' ? (
            <ProjectAgentRunsSettings project={props.project} runs={projectRuns} onResumeRun={props.onResumeAgentRun} />
          ) : null}
          {props.tab === 'mcp' ? (
            <McpManagementPage
              project={props.project}
              plugins={props.plugins}
              projectBindings={props.projectBindings}
              selectedPlugin={props.selectedPlugin}
              serverInfo={props.serverInfo}
              tools={props.tools}
              toolSnapshots={props.toolSnapshots}
              rawAudits={props.rawAudits}
              resources={props.resources}
              prompts={props.prompts}
              resourceTemplates={props.resourceTemplates}
              connectionStatus={props.connectionStatus}
              connectionStatuses={props.connectionStatuses}
              pluginError={props.pluginError}
              isRefreshing={props.isRefreshing}
              onRefresh={props.onRefreshPluginMeta}
              onReconnect={props.onReconnectMcpPlugin}
              onStop={props.onStopMcpPlugin}
              onOpenRegistry={props.onOpenMcpRegistry}
              onSelectProjectMcpPlugin={props.onSelectProjectMcpPlugin}
              onToggleProjectMcpPlugin={props.onToggleProjectMcpPlugin}
              onAddProjectMcpPlugin={props.onAddProjectMcpPlugin}
              onEditProjectMcpPlugin={props.onEditProjectMcpPlugin}
              onDeleteProjectMcpPlugin={props.onDeleteProjectMcpPlugin}
              onSendRawMcpRequest={props.onSendRawMcpRequest}
            />
          ) : null}
          {props.tab === 'skills' ? (
            <SkillsPage
              project={props.project}
              draft={props.skillDraft}
              editingSkillId={props.editingSkillId}
              catalog={props.skillCatalog}
              isLoadingCatalog={props.isLoadingSkillCatalog}
              catalogError={props.skillCatalogError}
              onRefreshCatalog={props.onRefreshSkillCatalog}
              onInstallCatalogSkill={props.onInstallCatalogSkill}
              onChangeDraft={props.onChangeSkillDraft}
              onSaveSkill={props.onSaveProjectSkill}
              onEditSkill={props.onEditProjectSkill}
              onCancelEdit={props.onCancelProjectSkillEdit}
              onToggleSkill={props.onToggleProjectSkill}
              onDeleteSkill={props.onDeleteProjectSkill}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
