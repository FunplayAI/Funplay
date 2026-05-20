import { useEffect, useMemo, useState, type JSX } from 'react';
import { PROJECT_SESSION_RUNTIME_OPTIONS, getProjectSessionRuntimeLabel } from '../../../shared/agent-runtimes';
import type {
  AgentPermissionMode,
  AgentRuntimeStrategy,
  AgentRuntimeStatus,
  AgentSkillCatalogItem,
  AgentSkillCatalogResult,
  AgentSkillRegistrySnapshot,
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
  ProjectSessionRuntimeId,
  RuntimeUsageTotals,
  UnityMcpPrompt,
  UnityMcpResource,
  UnityMcpResourceTemplate,
  UnityMcpServerInfo,
  UnityMcpTool
} from '../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import type { ProjectAgentSkillDraft, ProjectMcpBindingDraft, ProjectSettingsTab } from '../../lib/app-types';
import {
  buildRuntimeSummary,
  formatAbsoluteTime,
  formatDimensionLabel,
  formatPlatformLabel,
  formatProjectStatus
} from '../../lib/app-helpers';
import { Card, InfoRow } from '../shared/InfoComponents';
import { Button, TextField } from '../ui/index';
import { McpManagementPage } from './McpManagementPage';
import { SkillsPage } from './SkillsPage';

type SessionRuntimeUpdate = {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  effort?: ProjectSessionEffort;
};

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
  globalPermissionMode: AgentPermissionMode;
  globalRuntimeStrategy: AgentRuntimeStrategy;
  projectBindings: ProjectMcpBindingDraft;
  skillDraft: ProjectAgentSkillDraft;
  editingSkillId: string;
  skillCatalog: AgentSkillCatalogResult | null;
  skillRegistry: AgentSkillRegistrySnapshot | null;
  isLoadingSkillCatalog: boolean;
  isLoadingSkillRegistry: boolean;
  skillCatalogError: string;
  skillRegistryError: string;
  providers: AiProvider[];
  activeProvider: AiProvider | null;
  defaultProviderId?: string;
  activeSession: ProjectSession | null;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionRuntimeId?: ProjectSessionRuntimeId;
  sessionEffort: ProjectSessionEffort;
  runtimeStatuses: AgentRuntimeStatus[];
  onUpdateProjectPermissionMode: (permissionMode: AgentPermissionMode) => Promise<void>;
  onUpdateSessionRuntime: (runtime: SessionRuntimeUpdate) => Promise<void>;
  onRefreshSkillCatalog: () => Promise<void>;
  onRefreshSkillRegistry: () => Promise<void>;
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
  onSendRawMcpRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
  onReconnectMcpPlugin: () => void;
  onStopMcpPlugin: () => void;
  onResumeAgentRun: (runId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const projectUsage = useMemo(
    () => buildProjectTokenUsage({
      project: props.project,
      runtimeStatuses: props.runtimeStatuses,
      providers: props.providers
    }),
    [props.project?.id, props.providers, props.runtimeStatuses]
  );
  const projectRuns = useMemo(
    () => buildProjectAgentRunSummary({
      project: props.project,
      runtimeStatuses: props.runtimeStatuses,
      providers: props.providers
    }),
    [props.project?.id, props.providers, props.runtimeStatuses]
  );
  const projectMcpServerCount = useMemo(() => {
    const bindings = props.project?.mcpBindings ?? {};
    return new Set([
      ...(bindings.servers ?? []),
      bindings.engine,
      bindings.asset,
      bindings.qa,
      bindings.custom
    ].filter(Boolean)).size;
  }, [props.project?.mcpBindings]);
  const settingsNavItems: Array<{
    id: ProjectSettingsTab;
    label: string;
    description: string;
    badge: string;
  }> = [
    {
      id: 'engine',
      label: t('引擎项目', 'Engine Project'),
      description: t('路径、平台、运行状态', 'Path, platform, runtime'),
      badge: props.project?.engine?.platform ? formatPlatformLabel(props.project.engine.platform) : t('未绑定', 'Unbound')
    },
    {
      id: 'agent',
      label: 'Agent',
      description: t('模型、Runtime 与项目策略', 'Model, runtime, project policy'),
      badge: props.activeSession ? getProjectSessionRuntimeLabel(props.sessionRuntimeId) : t('未选择', 'No Session')
    },
    {
      id: 'usage',
      label: t('用量', 'Usage'),
      description: t('项目 Token 统计', 'Project token usage'),
      badge: formatTokenCount(projectUsage.totalTokens, language)
    },
    {
      id: 'runs',
      label: t('Agent 运行', 'Agent Runs'),
      description: t('历史、恢复与验证', 'History, recovery, verification'),
      badge: projectRuns.resumableRunCount > 0
        ? t(`${projectRuns.resumableRunCount} 可恢复`, `${projectRuns.resumableRunCount} resumable`)
        : formatNumber(projectRuns.trackedRunCount, language)
    },
    {
      id: 'mcp',
      label: 'MCP',
      description: t('项目级 Server 与运行检查', 'Project servers and runtime checks'),
      badge: t(`${projectMcpServerCount} 启用`, `${projectMcpServerCount} enabled`)
    },
    {
      id: 'skills',
      label: 'Skills',
      description: t('用户赋予 Agent 的项目技能', 'User-provided agent skills'),
      badge: t(`${props.project?.agentPolicy?.skills?.filter((skill) => skill.enabled).length ?? 0} 启用`, `${props.project?.agentPolicy?.skills?.filter((skill) => skill.enabled).length ?? 0} enabled`)
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
              onClick={() => props.onTabChange(item.id)}
            >
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
          {props.tab === 'engine' ? (
            <EngineProjectSettings project={props.project} />
          ) : null}
          {props.tab === 'agent' ? (
            <ProjectAgentSettings
              project={props.project}
              providers={props.providers}
              activeProvider={props.activeProvider}
              defaultProviderId={props.defaultProviderId}
              activeSession={props.activeSession}
              sessionProviderId={props.sessionProviderId}
              sessionModel={props.sessionModel}
              sessionRuntimeId={props.sessionRuntimeId}
              sessionEffort={props.sessionEffort}
              globalPermissionMode={props.globalPermissionMode}
              globalRuntimeStrategy={props.globalRuntimeStrategy}
              onUpdatePermissionMode={props.onUpdateProjectPermissionMode}
              onUpdateSessionRuntime={props.onUpdateSessionRuntime}
            />
          ) : null}
          {props.tab === 'usage' ? (
            <ProjectTokenUsageSettings
              project={props.project}
              usage={projectUsage}
            />
          ) : null}
          {props.tab === 'runs' ? (
            <ProjectAgentRunsSettings
              project={props.project}
              runs={projectRuns}
              onResumeRun={props.onResumeAgentRun}
            />
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
              registry={props.skillRegistry}
              isLoadingCatalog={props.isLoadingSkillCatalog}
              isLoadingRegistry={props.isLoadingSkillRegistry}
              catalogError={props.skillCatalogError}
              registryError={props.skillRegistryError}
              onRefreshCatalog={props.onRefreshSkillCatalog}
              onRefreshRegistry={props.onRefreshSkillRegistry}
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

export function EngineProjectSettings(props: { project: Project | null }): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  return (
    <div className="engine-settings-grid">
      <Card title={t('项目身份', 'Project Identity')}>
        <InfoRow label={t('平台', 'Platform')} value={formatPlatformLabel(props.project?.engine?.platform || 'web')} />
        <InfoRow label={t('项目名称', 'Project Name')} value={props.project?.name || t('未创建', 'Not Created')} />
        <InfoRow label={t('项目路径', 'Project Path')} value={props.project?.engine?.projectPath || t('未记录', 'Not Recorded')} />
        <InfoRow label={t('Unity 版本', 'Unity Version')} value={props.project?.engine?.unityEditorVersion || t('未记录', 'Not Recorded')} />
      </Card>
      <Card title={t('运行状态', 'Runtime Status')}>
        <InfoRow
          label={t('项目类型', 'Project Type')}
          value={formatDimensionLabel(props.project?.engine?.dimension || props.project?.runtimeState?.detectedDimension || 'unknown')}
        />
        <InfoRow label={t('项目状态', 'Project Status')} value={props.project ? formatProjectStatus(props.project.status) : t('未创建', 'Not Created')} />
        <InfoRow label="Bridge / MCP" value={props.project ? buildRuntimeSummary(props.project.runtimeState) : t('未检测', 'Not Checked')} />
        <InfoRow label={t('最近检测', 'Last Check')} value={props.project?.runtimeState?.checkedAt ? formatAbsoluteTime(props.project.runtimeState.checkedAt) : t('未检测', 'Not Checked')} />
      </Card>
    </div>
  );
}

interface ProjectTokenUsageSummary extends RuntimeUsageTotals {
  trackedRunCount: number;
  usageRunCount: number;
  latestUpdatedAt?: string;
  statusCounts: Record<AgentRuntimeStatus['status'], number>;
  verificationRunCount: number;
  verificationCheckCount: number;
  verificationPassedCount: number;
  verificationFailedCount: number;
  browserVerificationCount: number;
  runtimeEventCount: number;
  failedToolResultCount: number;
  toolRetryCount: number;
  providerModelGroups: Array<{
    id: string;
    label: string;
    turns: number;
    runs: number;
    totalTokens: number;
  }>;
}

interface ProjectAgentRunListItem {
  id: string;
  kind: AgentRuntimeStatus['kind'];
  status: AgentRuntimeStatus['status'];
  updatedAt: string;
  startedAt: string;
  canResume: boolean;
  sessionTitle?: string;
  inputPreview?: string;
  lastError?: string;
  runtimeId?: string;
  providerLabel?: string;
  model?: string;
  resumeStrategy?: AgentRuntimeStatus['resumeStrategy'];
  totalTokens?: number;
  verificationCheckCount: number;
  failedToolResultCount: number;
}

interface ProjectAgentRunSummary {
  trackedRunCount: number;
  runningRunCount: number;
  completedRunCount: number;
  failedRunCount: number;
  interruptedRunCount: number;
  resumableRunCount: number;
  latestUpdatedAt?: string;
  verificationRunCount: number;
  verificationCheckCount: number;
  verificationPassedCount: number;
  verificationFailedCount: number;
  browserVerificationCount: number;
  runtimeEventCount: number;
  failedToolResultCount: number;
  toolRetryCount: number;
  recentRuns: ProjectAgentRunListItem[];
}

export function ProjectTokenUsageSettings(props: {
  project: Project | null;
  usage: ProjectTokenUsageSummary;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);

  return (
    <div className="engine-settings-grid project-token-usage-grid">
      <Card title={t('项目 Token 概览', 'Project Token Overview')}>
        <div className="project-token-hero">
          <span>{t('总 Token', 'Total Tokens')}</span>
          <strong>{formatNumber(props.usage.totalTokens, language)}</strong>
          <em>
            {props.project
              ? t(
                  `${props.usage.usageRunCount} 次运行 · ${props.usage.turns} 轮调用`,
                  `${props.usage.usageRunCount} runs · ${props.usage.turns} turns`
                )
              : t('未选择项目', 'No project selected')}
          </em>
        </div>
      </Card>

      <Card title={t('Token 构成', 'Token Breakdown')}>
        <div className="project-token-metric-grid">
          <TokenMetric label={t('输入', 'Input')} value={props.usage.inputTokens} language={language} />
          <TokenMetric label={t('输出', 'Output')} value={props.usage.outputTokens} language={language} />
          <TokenMetric label={t('缓存读', 'Cache Read')} value={props.usage.cacheReadTokens} language={language} />
          <TokenMetric label={t('缓存写', 'Cache Write')} value={props.usage.cacheCreationTokens} language={language} />
        </div>
      </Card>

      <Card title={t('运行记录', 'Run Records')}>
        <InfoRow label={t('已记录运行', 'Tracked Runs')} value={formatNumber(props.usage.trackedRunCount, language)} />
        <InfoRow label={t('有 Token 数据', 'Runs With Usage')} value={formatNumber(props.usage.usageRunCount, language)} />
        <InfoRow label={t('最近更新', 'Last Updated')} value={props.usage.latestUpdatedAt ? formatAbsoluteTime(props.usage.latestUpdatedAt) : t('暂无', 'None')} />
        <InfoRow
          label={t('状态', 'Status')}
          value={t(
            `运行中 ${props.usage.statusCounts.running} · 完成 ${props.usage.statusCounts.completed} · 失败 ${props.usage.statusCounts.failed} · 中断 ${props.usage.statusCounts.interrupted}`,
            `${props.usage.statusCounts.running} running · ${props.usage.statusCounts.completed} completed · ${props.usage.statusCounts.failed} failed · ${props.usage.statusCounts.interrupted} interrupted`
          )}
        />
      </Card>

      <Card title="Provider / Model">
        {props.usage.providerModelGroups.length > 0 ? (
          <div className="project-token-provider-list">
            {props.usage.providerModelGroups.map((group) => (
              <div key={group.id} className="project-token-provider-row">
                <div>
                  <strong>{group.label}</strong>
                  <span>
                    {t(
                      `${group.runs} 次运行 · ${group.turns} 轮调用`,
                      `${group.runs} runs · ${group.turns} turns`
                    )}
                  </span>
                </div>
                <strong>{formatTokenCount(group.totalTokens, language)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div className="helper-copy">{t('暂无 token 统计。', 'No token usage yet.')}</div>
        )}
      </Card>
    </div>
  );
}

export function ProjectAgentRunsSettings(props: {
  project: Project | null;
  runs: ProjectAgentRunSummary;
  onResumeRun?: (runId: string) => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);

  return (
    <div className="engine-settings-grid project-agent-runs-grid">
      <Card title={t('Agent 运行概览', 'Agent Run Overview')}>
        <div className="project-agent-run-metric-grid">
          <RunMetric label={t('已记录', 'Tracked')} value={props.runs.trackedRunCount} language={language} />
          <RunMetric label={t('运行中', 'Running')} value={props.runs.runningRunCount} language={language} />
          <RunMetric label={t('失败', 'Failed')} value={props.runs.failedRunCount} language={language} />
          <RunMetric label={t('可恢复', 'Resumable')} value={props.runs.resumableRunCount} language={language} />
        </div>
      </Card>

      <Card title={t('恢复状态', 'Recovery State')}>
        <InfoRow label={t('最近更新', 'Last Updated')} value={props.runs.latestUpdatedAt ? formatAbsoluteTime(props.runs.latestUpdatedAt) : t('暂无', 'None')} />
        <InfoRow
          label={t('完成情况', 'Completion')}
          value={t(
            `完成 ${props.runs.completedRunCount} · 中断 ${props.runs.interruptedRunCount}`,
            `${props.runs.completedRunCount} completed · ${props.runs.interruptedRunCount} interrupted`
          )}
        />
        <InfoRow
          label={t('恢复入口', 'Recovery')}
          value={props.runs.resumableRunCount > 0
            ? t(`${props.runs.resumableRunCount} 次运行可恢复`, `${props.runs.resumableRunCount} runs can resume`)
            : t('暂无可恢复运行', 'No resumable runs')}
        />
      </Card>

      <Card title={t('验证与质量', 'Verification And Quality')}>
        <InfoRow label={t('有验证报告', 'Runs With Verification')} value={formatNumber(props.runs.verificationRunCount, language)} />
        <InfoRow
          label={t('验证结果', 'Verification Results')}
          value={t(
            `通过 ${props.runs.verificationPassedCount} · 失败 ${props.runs.verificationFailedCount} · 浏览器 ${props.runs.browserVerificationCount}`,
            `${props.runs.verificationPassedCount} passed · ${props.runs.verificationFailedCount} failed · ${props.runs.browserVerificationCount} browser`
          )}
        />
        <InfoRow
          label={t('工具质量', 'Tool Quality')}
          value={t(
            `事件 ${props.runs.runtimeEventCount} · 工具失败 ${props.runs.failedToolResultCount} · 重试 ${props.runs.toolRetryCount}`,
            `${props.runs.runtimeEventCount} events · ${props.runs.failedToolResultCount} tool failures · ${props.runs.toolRetryCount} retries`
          )}
        />
      </Card>

      <Card title={t('运行历史', 'Run History')}>
        {props.runs.recentRuns.length > 0 ? (
          <div className="project-agent-run-list">
            {props.runs.recentRuns.map((run) => (
              <div key={run.id} className={`project-agent-run-row ${run.status}`}>
                <div className="project-agent-run-copy">
                  <strong>{formatRunKind(run.kind, language)} · {run.sessionTitle || t('未命名会话', 'Untitled session')}</strong>
                  <span>{run.inputPreview || run.lastError || t('无摘要', 'No summary')}</span>
                  <em>
                    {[
                      formatAbsoluteTime(run.updatedAt),
                      formatRuntimeRunStatus(run.status, language),
                      run.resumeStrategy ? formatResumeStrategy(run.resumeStrategy, language) : '',
                      run.providerLabel && run.model ? `${run.providerLabel} / ${run.model}` : run.providerLabel || run.model || '',
                      typeof run.totalTokens === 'number' ? t(`${formatNumber(run.totalTokens, language)} tokens`, `${formatNumber(run.totalTokens, language)} tokens`) : '',
                      run.verificationCheckCount > 0 ? t(`${run.verificationCheckCount} 个验证`, `${run.verificationCheckCount} checks`) : '',
                      run.failedToolResultCount > 0 ? t(`${run.failedToolResultCount} 个工具失败`, `${run.failedToolResultCount} tool failures`) : ''
                    ].filter(Boolean).join(' · ')}
                  </em>
                </div>
                {run.canResume ? (
                  <Button size="sm" variant="secondary" onClick={() => props.onResumeRun?.(run.id)} disabled={!props.onResumeRun}>
                    {t('恢复', 'Resume')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="helper-copy">
            {props.project ? t('这个项目还没有 Agent 运行记录。', 'This project has no Agent runs yet.') : t('未选择项目。', 'No project selected.')}
          </div>
        )}
      </Card>
    </div>
  );
}

export function ProjectAgentSettings(props: {
  project: Project | null;
  providers: AiProvider[];
  activeProvider: AiProvider | null;
  defaultProviderId?: string;
  activeSession: ProjectSession | null;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionRuntimeId?: ProjectSessionRuntimeId;
  sessionEffort: ProjectSessionEffort;
  globalPermissionMode: AgentPermissionMode;
  globalRuntimeStrategy: AgentRuntimeStrategy;
  onUpdatePermissionMode: (permissionMode: AgentPermissionMode) => Promise<void>;
  onUpdateSessionRuntime: (runtime: SessionRuntimeUpdate) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [modelDraft, setModelDraft] = useState(props.sessionModel ?? '');
  const projectPermissionMode = props.project?.agentPolicy?.permissionMode;
  const effectivePermissionMode = projectPermissionMode ?? props.globalPermissionMode;
  const defaultProvider = props.providers.find((provider) => provider.id === props.defaultProviderId) ?? props.providers.find((provider) => provider.isDefault) ?? props.activeProvider;
  const providerOverrideActive = Boolean(
    props.sessionProviderId && props.sessionProviderId !== (props.defaultProviderId || '')
  );
  const activeProviderLabel = props.activeProvider?.name ?? t('本地规划器', 'Local Planner');
  const defaultProviderLabel = defaultProvider?.name ?? t('未配置', 'Not Configured');
  const defaultModelLabel = defaultProvider?.model || t('未配置', 'Not Configured');
  const activeModelLabel = props.sessionModel || props.activeProvider?.model || t('本地规划器', 'Local Planner');
  const globalRuntimeLabel = formatRuntimeStrategyLabel(props.globalRuntimeStrategy, language);
  const runtimeLabel = props.sessionRuntimeId
    ? getProjectSessionRuntimeLabel(props.sessionRuntimeId)
    : t(`默认 · ${globalRuntimeLabel}`, `Default · ${globalRuntimeLabel}`);
  const permissionOptions: Array<[AgentPermissionMode, string]> = [
    ['full-access', t('Build', 'Build')],
    ['read-only', t('Plan', 'Plan')]
  ];
  const effortOptions: Array<{ value: ProjectSessionEffort; label: string }> = [
    { value: 'auto', label: t('自动', 'Auto') },
    { value: 'low', label: t('低', 'Low') },
    { value: 'medium', label: t('中', 'Medium') },
    { value: 'high', label: t('高', 'High') },
    { value: 'xhigh', label: t('极高', 'XHigh') },
    { value: 'max', label: t('最大', 'Max') }
  ];
  const modelOptions = useMemo(
    () => [
      ...new Set(
        [
          props.activeProvider?.model,
          ...props.providers.map((provider) => provider.model)
        ].map((model) => model?.trim()).filter((model): model is string => Boolean(model))
      )
    ],
    [props.activeProvider?.model, props.providers]
  );

  useEffect(() => {
    setModelDraft(props.sessionModel ?? '');
  }, [props.sessionModel, props.activeSession?.id]);

  function updateRuntime(runtime: SessionRuntimeUpdate): void {
    if (!props.activeSession) {
      return;
    }
    void props.onUpdateSessionRuntime(runtime);
  }

  function applyModel(model: string): void {
    const normalized = model.trim();
    setModelDraft(normalized);
    updateRuntime({ model: normalized || undefined });
  }

  return (
    <div className="engine-settings-grid">
      <div className="agent-settings-wide-card">
        <Card title={t('设置作用域', 'Settings Scope')}>
          <div className="agent-settings-scope-flow" aria-label={t('设置覆盖顺序', 'Settings override order')}>
            <span>{t('全局默认', 'Global Default')}</span>
            <strong aria-hidden="true">→</strong>
            <span>{t('项目默认', 'Project Default')}</span>
            <strong aria-hidden="true">→</strong>
            <span>{t('当前会话', 'Current Session')}</span>
          </div>
          <div className="agent-settings-scope-grid">
            <div className="agent-settings-scope-step">
              <div className="agent-settings-scope-header">
                <span>{t('全局默认', 'Global Default')}</span>
                <strong>{t('应用设置', 'App Settings')}</strong>
              </div>
              <dl>
                <div>
                  <dt>Provider</dt>
                  <dd>{defaultProviderLabel}</dd>
                </div>
                <div>
                  <dt>{t('模型', 'Model')}</dt>
                  <dd>{defaultModelLabel}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{globalRuntimeLabel}</dd>
                </div>
                <div>
                  <dt>{t('模式', 'Mode')}</dt>
                  <dd>{formatPermissionModeLabel(props.globalPermissionMode, language)}</dd>
                </div>
              </dl>
            </div>
            <div className="agent-settings-scope-step">
              <div className="agent-settings-scope-header">
                <span>{t('项目默认', 'Project Default')}</span>
                <strong>{props.project?.name || t('未选择项目', 'No Project')}</strong>
              </div>
              <dl>
                <div>
                  <dt>{t('模式', 'Mode')}</dt>
                  <dd>
                    {projectPermissionMode
                      ? formatPermissionModeLabel(projectPermissionMode, language)
                      : t('跟随全局默认', 'Follow Global Default')}
                  </dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{t('跟随全局默认', 'Follow Global Default')}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{t('跟随全局默认', 'Follow Global Default')}</dd>
                </div>
              </dl>
            </div>
            <div className="agent-settings-scope-step active">
              <div className="agent-settings-scope-header">
                <span>{t('当前会话', 'Current Session')}</span>
                <strong>{props.activeSession?.title || t('未选择会话', 'No Session')}</strong>
              </div>
              <dl>
                <div>
                  <dt>{t('生效配置', 'Effective Config')}</dt>
                  <dd>{formatPermissionModeLabel(effectivePermissionMode, language)} · {runtimeLabel}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{providerOverrideActive ? activeProviderLabel : t(`默认 · ${activeProviderLabel}`, `Default · ${activeProviderLabel}`)}</dd>
                </div>
                <div>
                  <dt>{t('模型', 'Model')}</dt>
                  <dd>{activeModelLabel}</dd>
                </div>
                <div>
                  <dt>{t('智能强度', 'Effort')}</dt>
                  <dd>{formatEffortLabel(props.sessionEffort, language)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </Card>
      </div>
      <Card title={t('当前会话运行', 'Current Session Runtime')}>
        <InfoRow label={t('会话', 'Session')} value={props.activeSession?.title || t('未选择', 'No Session')} />
        <InfoRow
          label="Provider"
          value={providerOverrideActive ? activeProviderLabel : t(`默认 · ${activeProviderLabel}`, `Default · ${activeProviderLabel}`)}
        />
        <InfoRow label={t('模型', 'Model')} value={activeModelLabel} />
        <InfoRow label="Runtime" value={runtimeLabel} />
      </Card>
      <Card title={t('模型', 'Model')}>
        <div className="agent-settings-control-stack">
          <TextField
            label={t('当前会话模型覆盖', 'Current session model override')}
            value={modelDraft}
            disabled={!props.activeSession}
            onValueChange={setModelDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyModel(modelDraft);
              }
            }}
            placeholder={props.activeProvider?.model || t('跟随 Provider 默认模型', 'Use provider default model')}
          />
          <div className="agent-settings-button-row">
            <Button size="sm" variant="primary" disabled={!props.activeSession} onClick={() => applyModel(modelDraft)}>
              {t('应用模型', 'Apply Model')}
            </Button>
            <Button size="sm" variant="secondary" disabled={!props.activeSession || !props.sessionModel} onClick={() => applyModel('')}>
              {t('跟随默认模型', 'Use Default Model')}
            </Button>
          </div>
          {modelOptions.length > 0 ? (
            <div className="agent-settings-chip-grid">
              {modelOptions.map((model) => (
                <Button
                  key={model}
                  size="compact"
                  variant="ghost"
                  className={`agent-settings-chip-button ${(props.sessionModel || props.activeProvider?.model) === model ? 'active' : ''}`}
                  disabled={!props.activeSession}
                  onClick={() => applyModel(model)}
                >
                  {model}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
      <Card title="Runtime">
        <div className="agent-settings-control-stack">
          <div className="segmented-options">
            <Button
              size="compact"
              variant="ghost"
              className={`settings-choice-button ${!props.sessionRuntimeId ? 'active' : ''}`}
              disabled={!props.activeSession}
              onClick={() => updateRuntime({ runtimeId: undefined })}
            >
              {t('跟随默认', 'Use Default')}
            </Button>
            {PROJECT_SESSION_RUNTIME_OPTIONS.map((runtime) => (
              <Button
                key={runtime.id}
                size="compact"
                variant="ghost"
                className={`settings-choice-button ${props.sessionRuntimeId === runtime.id ? 'active' : ''}`}
                disabled={!props.activeSession}
                onClick={() => updateRuntime({ runtimeId: runtime.id })}
              >
                {runtime.label}
              </Button>
            ))}
          </div>
          <div className="helper-copy">
            {props.sessionRuntimeId === 'claude-code-sdk'
              ? t('Claude Code SDK 运行时会使用本地 Claude Code 链路。', 'Claude Code SDK runtime uses the local Claude Code path.')
              : t('Native 运行时使用 Funplay 内置多 Provider 工具循环。', 'Native runtime uses Funplay built-in multi-provider tool loop.')}
          </div>
        </div>
      </Card>
      <Card title={t('智能强度', 'Reasoning Effort')}>
        <div className="agent-settings-control-stack">
          <div className="agent-settings-section-label">{t('智能强度', 'Reasoning Effort')}</div>
          <div className="segmented-options">
            {effortOptions.map((option) => (
              <Button
                key={option.value}
                size="compact"
                variant="ghost"
                className={`settings-choice-button ${props.sessionEffort === option.value ? 'active' : ''}`}
                disabled={!props.activeSession}
                onClick={() => updateRuntime({ effort: option.value })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>
      <Card title={t('项目 Agent 策略', 'Project Agent Policy')}>
        <InfoRow label={t('全局默认', 'Global Default')} value={formatPermissionModeLabel(props.globalPermissionMode, language)} />
        <InfoRow label={t('项目默认', 'Project Default')} value={projectPermissionMode ? formatPermissionModeLabel(projectPermissionMode, language) : t('跟随全局默认', 'Follow Global Default')} />
        <InfoRow label={t('当前生效', 'Effective Mode')} value={formatPermissionModeLabel(effectivePermissionMode, language)} />
      </Card>
      <Card title={t('Agent 模式', 'Agent Mode')}>
        <div className="helper-copy">
          {t(
            'Build 用于直接开发；Plan 用于只读探索和方案规划，写文件会被拒绝，运行命令前会确认。',
            'Build is for direct development; Plan is for read-only exploration and planning, rejects file writes, and asks before running commands.'
          )}
        </div>
        <div className="segmented-options">
          {permissionOptions.map(([mode, label]) => (
            <Button
              key={mode}
              size="compact"
              variant="ghost"
              className={`settings-choice-button ${effectivePermissionMode === mode ? 'active' : ''}`}
              disabled={!props.project}
              onClick={() => void props.onUpdatePermissionMode(mode)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function formatPermissionModeLabel(mode: AgentPermissionMode, language: UiLanguage): string {
  const labels: Record<AgentPermissionMode, string> = {
    'full-access': localize(language, 'Build', 'Build'),
    ask: localize(language, '询问确认', 'Ask'),
    'read-only': localize(language, 'Plan', 'Plan')
  };
  return labels[mode];
}

function formatRuntimeStrategyLabel(strategy: AgentRuntimeStrategy, language: UiLanguage): string {
  const labels: Record<AgentRuntimeStrategy, string> = {
    auto: localize(language, 'Auto', 'Auto'),
    native: localize(language, 'Native', 'Native'),
    'claude-code-sdk': localize(language, 'Claude Code', 'Claude Code')
  };
  return labels[strategy];
}

function formatEffortLabel(effort: ProjectSessionEffort, language: UiLanguage): string {
  const labels: Record<ProjectSessionEffort, string> = {
    auto: localize(language, '自动', 'Auto'),
    low: localize(language, '低', 'Low'),
    medium: localize(language, '中', 'Medium'),
    high: localize(language, '高', 'High'),
    xhigh: localize(language, '极高', 'XHigh'),
    max: localize(language, '最大', 'Max')
  };
  return labels[effort];
}

function TokenMetric(props: { label: string; value: number; language: UiLanguage }): JSX.Element {
  return (
    <div className="project-token-metric">
      <span>{props.label}</span>
      <strong>{formatNumber(props.value, props.language)}</strong>
    </div>
  );
}

function RunMetric(props: { label: string; value: number; language: UiLanguage }): JSX.Element {
  return (
    <div className="project-agent-run-metric">
      <span>{props.label}</span>
      <strong>{formatNumber(props.value, props.language)}</strong>
    </div>
  );
}

function buildProjectTokenUsage(input: {
  project: Project | null;
  runtimeStatuses: AgentRuntimeStatus[];
  providers: AiProvider[];
}): ProjectTokenUsageSummary {
  const providerNames = new Map(input.providers.map((provider) => [provider.id, provider.name]));
  const projectRuns = input.project
    ? input.runtimeStatuses.filter((status) => status.projectId === input.project?.id)
    : [];
  const statusCounts: ProjectTokenUsageSummary['statusCounts'] = {
    running: 0,
    interrupted: 0,
    failed: 0,
    completed: 0
  };
  const usageTotals: RuntimeUsageTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  };
  const groups = new Map<string, ProjectTokenUsageSummary['providerModelGroups'][number]>();
  let usageRunCount = 0;
  let latestUpdatedAt: string | undefined;
  let verificationRunCount = 0;
  let verificationCheckCount = 0;
  let verificationPassedCount = 0;
  let verificationFailedCount = 0;
  let browserVerificationCount = 0;
  let runtimeEventCount = 0;
  let failedToolResultCount = 0;
  let toolRetryCount = 0;

  for (const run of projectRuns) {
    statusCounts[run.status] += 1;
    if (!latestUpdatedAt || run.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = run.updatedAt;
    }
    if (run.verification) {
      verificationRunCount += 1;
      verificationCheckCount += run.verification.checks.length;
      verificationPassedCount += run.verification.checks.filter((check) => check.status === 'passed').length;
      verificationFailedCount += run.verification.checks.filter((check) => check.status === 'failed').length;
      browserVerificationCount += run.verification.checks.filter((check) => check.kind === 'browser').length;
    }
    runtimeEventCount += run.events?.length ?? 0;
    failedToolResultCount += run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0;
    toolRetryCount += countRepeatedToolResults(run);

    if (!run.usage) {
      continue;
    }

    usageRunCount += 1;
    usageTotals.turns += run.usage.turns;
    usageTotals.inputTokens += run.usage.inputTokens;
    usageTotals.outputTokens += run.usage.outputTokens;
    usageTotals.cacheCreationTokens += run.usage.cacheCreationTokens;
    usageTotals.cacheReadTokens += run.usage.cacheReadTokens;
    usageTotals.totalTokens += run.usage.totalTokens;

    const providerLabel = run.providerId ? providerNames.get(run.providerId) ?? run.providerId : 'Provider';
    const modelLabel = run.model?.trim();
    const label = modelLabel ? `${providerLabel} · ${modelLabel}` : providerLabel;
    const groupId = `${run.providerId ?? 'provider'}:${modelLabel ?? 'model'}`;
    const existing = groups.get(groupId) ?? {
      id: groupId,
      label,
      turns: 0,
      runs: 0,
      totalTokens: 0
    };
    existing.turns += run.usage.turns;
    existing.runs += 1;
    existing.totalTokens += run.usage.totalTokens;
    groups.set(groupId, existing);
  }

  return {
    trackedRunCount: projectRuns.length,
    usageRunCount,
    latestUpdatedAt,
    statusCounts,
    verificationRunCount,
    verificationCheckCount,
    verificationPassedCount,
    verificationFailedCount,
    browserVerificationCount,
    runtimeEventCount,
    failedToolResultCount,
    toolRetryCount,
    providerModelGroups: [...groups.values()]
      .sort((left, right) => right.totalTokens - left.totalTokens)
      .slice(0, 6),
    ...usageTotals
  };
}

function buildProjectAgentRunSummary(input: {
  project: Project | null;
  runtimeStatuses: AgentRuntimeStatus[];
  providers: AiProvider[];
}): ProjectAgentRunSummary {
  const providerNames = new Map(input.providers.map((provider) => [provider.id, provider.name]));
  const sessionTitles = new Map(input.project?.sessions.map((session) => [session.id, session.title]) ?? []);
  const projectRuns = input.project
    ? input.runtimeStatuses.filter((status) => status.projectId === input.project?.id)
    : [];
  let latestUpdatedAt: string | undefined;
  let verificationRunCount = 0;
  let verificationCheckCount = 0;
  let verificationPassedCount = 0;
  let verificationFailedCount = 0;
  let browserVerificationCount = 0;
  let runtimeEventCount = 0;
  let failedToolResultCount = 0;
  let toolRetryCount = 0;

  for (const run of projectRuns) {
    if (!latestUpdatedAt || run.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = run.updatedAt;
    }
    if (run.verification) {
      verificationRunCount += 1;
      verificationCheckCount += run.verification.checks.length;
      verificationPassedCount += run.verification.checks.filter((check) => check.status === 'passed').length;
      verificationFailedCount += run.verification.checks.filter((check) => check.status === 'failed').length;
      browserVerificationCount += run.verification.checks.filter((check) => check.kind === 'browser').length;
    }
    runtimeEventCount += run.events?.length ?? 0;
    failedToolResultCount += run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0;
    toolRetryCount += countRepeatedToolResults(run);
  }

  const recentRuns = projectRuns
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 10)
    .map<ProjectAgentRunListItem>((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      canResume: run.canResume,
      sessionTitle: run.sessionId ? sessionTitles.get(run.sessionId) : undefined,
      inputPreview: run.inputPreview,
      lastError: run.lastError,
      runtimeId: run.runtimeId,
      providerLabel: run.providerId ? providerNames.get(run.providerId) ?? run.providerId : undefined,
      model: run.model,
      resumeStrategy: run.resumeStrategy,
      totalTokens: run.usage?.totalTokens,
      verificationCheckCount: run.verification?.checks.length ?? 0,
      failedToolResultCount: run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0
    }));

  return {
    trackedRunCount: projectRuns.length,
    runningRunCount: projectRuns.filter((run) => run.status === 'running').length,
    completedRunCount: projectRuns.filter((run) => run.status === 'completed').length,
    failedRunCount: projectRuns.filter((run) => run.status === 'failed').length,
    interruptedRunCount: projectRuns.filter((run) => run.status === 'interrupted').length,
    resumableRunCount: projectRuns.filter((run) => run.canResume).length,
    latestUpdatedAt,
    verificationRunCount,
    verificationCheckCount,
    verificationPassedCount,
    verificationFailedCount,
    browserVerificationCount,
    runtimeEventCount,
    failedToolResultCount,
    toolRetryCount,
    recentRuns
  };
}

function countRepeatedToolResults(run: AgentRuntimeStatus): number {
  const counts = new Map<string, number>();
  for (const event of run.events ?? []) {
    if (event.type !== 'tool_result' || !event.toolResult?.toolUseId) {
      continue;
    }
    counts.set(event.toolResult.toolUseId, (counts.get(event.toolResult.toolUseId) ?? 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function formatRunKind(kind: AgentRuntimeStatus['kind'], language: UiLanguage): string {
  if (kind === 'execute-plan') {
    return localize(language, '执行计划', 'Execution Plan');
  }
  if (kind === 'bootstrap') {
    return localize(language, '初始化', 'Bootstrap');
  }
  return localize(language, '会话', 'Conversation');
}

function formatRuntimeRunStatus(status: AgentRuntimeStatus['status'], language: UiLanguage): string {
  const labels: Record<AgentRuntimeStatus['status'], string> = {
    running: localize(language, '运行中', 'Running'),
    interrupted: localize(language, '已中断', 'Interrupted'),
    failed: localize(language, '失败', 'Failed'),
    completed: localize(language, '完成', 'Completed')
  };
  return labels[status];
}

function formatResumeStrategy(strategy: NonNullable<AgentRuntimeStatus['resumeStrategy']>, language: UiLanguage): string {
  const labels: Record<NonNullable<AgentRuntimeStatus['resumeStrategy']>, string> = {
    restart_prompt: localize(language, '重新执行请求', 'Restart prompt'),
    resume_after_last_completed_tool: localize(language, '从最近工具边界继续', 'Resume after last tool'),
    resume_from_checkpoint: localize(language, '从检查点恢复', 'Resume from checkpoint')
  };
  return labels[strategy];
}

function formatNumber(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language).format(value);
}

function formatTokenCount(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language, {
    notation: 'compact',
    maximumFractionDigits: value >= 1000 ? 1 : 0
  }).format(value);
}
