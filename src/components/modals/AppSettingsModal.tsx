import { useEffect, useState, type JSX } from 'react';
import {
  Bell,
  Cloud,
  Database,
  Download,
  Info,
  Languages,
  Monitor,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  type LucideIcon
} from 'lucide-react';
import type {
  AiProvider, AiProviderInput, AiProviderModelListRequest, AiProviderModelListResult, AiSettings,
  AiTestResult,
  AppUpdateSnapshot,
  AssetGenerationProviderConfig,
  AssetGenerationProviderInput,
  McpConnectionSnapshot,
  McpPlugin,
  McpRawAuditEntry,
  McpRawRequestResult,
  McpToolSnapshot,
  ProjectMemoryClearScope,
  ProjectMemoryFileContent,
  ProjectMemoryFileSummary,
  ScheduledNotificationTask,
  UnityMcpPrompt,
  UnityMcpResource,
  UnityMcpResourceTemplate,
  UnityMcpServerInfo,
  UnityMcpTool,
  WebSearchSettings
} from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { AppSettingsTab, LanguagePreference, ThemePreference } from '../../lib/app-types';
import {
  formatAbsoluteTime,
  formatAppUpdateFeedSource,
  formatAppUpdateStatus,
  formatFileSize,
  formatNotificationTaskStatus,
  resolveAppUpdateActionMessage
} from '../../lib/app-helpers';
import { ModalShell } from '../settings-modals';
import { InfoRow } from '../shared/InfoComponents';
import { AppSettingsAiProviderSection } from './AppSettingsAiProviderSection';
import { AppSettingsAssetProviderSection } from './AppSettingsAssetProviderSection';
import { AppSettingsMemorySection } from './AppSettingsMemorySection';
import { McpRegistrySettingsPage } from '../pages/McpRegistrySettingsPage';
import { WebSearchSettingsPage } from '../pages/WebSearchSettingsPage';
import { Button, SwitchField } from '../ui/index';

export function AppSettingsModal(props: {
  initialTab: AppSettingsTab;
  theme: ThemePreference;
  language: LanguagePreference;
  developerMode: boolean;
  aiSettings: AiSettings;
  providers: AiProvider[];
  assetGenerationProviderConfigs?: AssetGenerationProviderConfig[];
  providerTests: Record<string, AiTestResult>;
  testingProviderIds?: Set<string>;
  mcpPlugins: McpPlugin[];
  selectedMcpPlugin: McpPlugin | null;
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
  isRefreshingPlugin: boolean;
  memoryFiles: ProjectMemoryFileSummary[];
  selectedMemoryPath: string;
  selectedMemoryFile: ProjectMemoryFileContent | null;
  memoryDraft: string;
  isLoadingMemory: boolean;
  isSavingMemory: boolean;
  memoryError: string;
  notificationTasks: ScheduledNotificationTask[];
  isLoadingNotificationTasks: boolean;
  notificationTaskError: string;
  appUpdateStatus: AppUpdateSnapshot | null;
  selectedProjectId?: string;
  onChangeTheme: (theme: ThemePreference) => void;
  onChangeLanguage: (language: LanguagePreference) => void;
  onChangeDeveloperMode: (developerMode: boolean) => void;
  onUpdateWebSearchSettings: (settings: Partial<WebSearchSettings>) => Promise<void>;
  onCreateProvider: (input: AiProviderInput) => Promise<void>;
  onUpdateProvider: (providerId: string, input: AiProviderInput) => Promise<void>;
  onListProviderModels: (input: AiProviderModelListRequest) => Promise<AiProviderModelListResult>;
  onDeleteProvider: (providerId: string) => void;
  onTestProvider: (providerId: string) => void;
  onSetDefaultProvider: (providerId: string) => void;
  onCreateAssetGenerationProvider?: (input: AssetGenerationProviderInput) => Promise<void>;
  onUpdateAssetGenerationProvider?: (providerId: string, input: AssetGenerationProviderInput) => Promise<void>;
  onDeleteAssetGenerationProvider?: (providerId: string) => void;
  onSelectMcpPlugin: (pluginId: string) => void;
  onRefreshMcpPluginMeta: () => void;
  onToggleMcpPlugin: (plugin: McpPlugin, enabled: boolean) => void | Promise<void>;
  onAddMcpPlugin: () => void;
  onEditMcpPlugin: (plugin: McpPlugin) => void;
  onDeleteMcpPlugin: (pluginId: string) => void;
  onSendRawMcpRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
  onReconnectMcpPlugin: () => void;
  onStopMcpPlugin: () => void;
  onRefreshMemoryFiles: () => Promise<void>;
  onSelectMemoryFile: (filePath: string) => Promise<void>;
  onChangeMemoryDraft: (value: string) => void;
  onSaveMemoryFile: () => Promise<void>;
  onClearMemory: (scope: ProjectMemoryClearScope, filePath?: string) => Promise<void>;
  onRefreshNotificationTasks: () => Promise<void>;
  onCancelNotificationTask: (taskId: string) => Promise<void>;
  onRefreshAppUpdateStatus: () => Promise<AppUpdateSnapshot>;
  onCheckForUpdates: () => Promise<AppUpdateSnapshot>;
  onDownloadUpdate: () => Promise<AppUpdateSnapshot>;
  onInstallUpdate: () => Promise<AppUpdateSnapshot>;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<AppSettingsTab>(props.initialTab);
  const [updateAction, setUpdateAction] = useState<'check' | 'download' | 'install' | ''>('');
  const [updateActionMessage, setUpdateActionMessage] = useState('');
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  useEffect(() => {
    setTab(props.initialTab);
  }, [props.initialTab]);

  useEffect(() => {
    if (tab !== 'notifications') {
      return;
    }
    void props.onRefreshNotificationTasks();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'about') {
      return;
    }
    void props.onRefreshAppUpdateStatus();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'memory') {
      return;
    }
    void props.onRefreshMemoryFiles();
  }, [tab, props.selectedProjectId]);

  async function runUpdateAction(action: 'check' | 'download' | 'install'): Promise<void> {
    setUpdateAction(action);
    setUpdateActionMessage('');
    try {
      const snapshot =
        action === 'check'
          ? await props.onCheckForUpdates()
          : action === 'download'
            ? await props.onDownloadUpdate()
            : await props.onInstallUpdate();
      setUpdateActionMessage(resolveAppUpdateActionMessage(snapshot, language));
    } catch (error) {
      setUpdateActionMessage(error instanceof Error ? error.message : t('更新操作失败。', 'Update action failed.'));
    } finally {
      setUpdateAction('');
    }
  }

  const memoryDirty = !!props.selectedMemoryFile && props.memoryDraft !== props.selectedMemoryFile.content;
  // Guard the modal close path when there are unsaved memory edits (memory-dirty-state-7).
  function requestClose(): void {
    if (tab === 'memory' && memoryDirty && !window.confirm(t('记忆有未保存的修改，确定关闭？', 'Memory has unsaved changes. Close anyway?'))) {
      return;
    }
    props.onClose();
  }
  const navItems: Array<{ id: AppSettingsTab; label: string; desc: string; Icon: LucideIcon }> = [
    { id: 'appearance', label: t('外观', 'Appearance'), desc: t('主题与界面外观', 'Theme and window appearance'), Icon: Monitor },
    { id: 'language', label: t('语言', 'Language'), desc: t('界面语言与文案', 'Interface language and copy'), Icon: Languages },
    { id: 'provider', label: t('AI 服务商', 'AI Provider'), desc: t('模型服务与默认渠道', 'Model services and default providers'), Icon: Cloud },
    { id: 'asset-provider', label: t('素材 Provider', 'Asset Provider'), desc: t('图片、3D 与音频生成', 'Image, 3D, and audio generation'), Icon: Sparkles },
    { id: 'mcp', label: 'MCP', desc: t('全局 MCP Registry', 'Global MCP Registry'), Icon: Plug },
    { id: 'web-search', label: t('网页搜索', 'Web Search'), desc: t('搜索来源、抽取与评测', 'Sources, extraction, and evaluation'), Icon: Search },
    { id: 'memory', label: t('记忆', 'Memory'), desc: t('浏览、编辑与清理项目记忆', 'Browse, edit, and clear project memory'), Icon: Database },
    { id: 'notifications', label: t('通知', 'Notifications'), desc: t('提醒任务与系统通知', 'Reminder tasks and system alerts'), Icon: Bell },
    { id: 'about', label: t('关于', 'About'), desc: t('产品信息与说明', 'Product info and notes'), Icon: Info }
  ];
  return (
    <ModalShell
      title={t('应用设置', 'App Settings')}
      subtitle={t('统一管理 Funplay 的界面、语言与模型服务。', 'Manage Funplay appearance, language, and model services in one place.')}
      className="app-settings-modal"
      onClose={requestClose}
    >
      <div className="app-settings-layout">
        <aside className="app-settings-sidebar">
          <div className="app-settings-sidebar-title">{t('设置分类', 'Settings')}</div>
          {navItems.map(({ id, label, desc, Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className={`app-settings-nav-item ${tab === id ? 'active' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <span className="app-settings-nav-icon" aria-hidden="true">
                <Icon size={15} />
              </span>
              <span className="app-settings-nav-copy">
                <strong>{label}</strong>
                <span>{desc}</span>
              </span>
            </Button>
          ))}
        </aside>

        <div className="app-settings-detail">
          {tab === 'appearance' ? (
            <section className="app-settings-section">
              <div>
                <strong>{t('主题', 'Theme')}</strong>
                <div className="helper-copy">{t('选择工作台的显示外观。', 'Choose the workspace appearance.')}</div>
              </div>
              <div className="segmented-options">
                {([
                  ['system', t('跟随系统', 'System')],
                  ['light', t('浅色', 'Light')],
                  ['dark', t('深色', 'Dark')]
                ] as Array<[ThemePreference, string]>).map(([theme, label]) => (
                  <Button key={theme} size="sm" variant="secondary" className={`settings-choice-button ${props.theme === theme ? 'active' : ''}`} onClick={() => props.onChangeTheme(theme)}>
                    {label}
                  </Button>
                ))}
              </div>
              <div className="app-settings-divider" />
              <SwitchField
                checked={props.developerMode}
                onCheckedChange={props.onChangeDeveloperMode}
                label={t('开发者模式', 'Developer Mode')}
                description={t('显示运行时阶段、工具边界等调试级运行细节。默认关闭。', 'Show debug-level runtime details such as runtime stages and tool-boundary events. Off by default.')}
              />
            </section>
          ) : null}

          {tab === 'language' ? (
            <section className="app-settings-section">
              <div>
                <strong>{t('语言', 'Language')}</strong>
                <div className="helper-copy">{t('设置界面语言偏好。', 'Set the preferred interface language.')}</div>
              </div>
              <div className="segmented-options two-columns">
                {([
                  ['zh-CN', t('简体中文', 'Simplified Chinese')],
                  ['en-US', 'English']
                ] as Array<[LanguagePreference, string]>).map(([nextLanguage, label]) => (
                  <Button key={nextLanguage} size="sm" variant="secondary" className={`settings-choice-button ${props.language === nextLanguage ? 'active' : ''}`} onClick={() => props.onChangeLanguage(nextLanguage)}>
                    {label}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}

          {tab === 'provider' ? (
            <AppSettingsAiProviderSection
              providers={props.providers}
              providerTests={props.providerTests}
              testingProviderIds={props.testingProviderIds}
              selectedProjectId={props.selectedProjectId}
              onCreateProvider={props.onCreateProvider}
              onUpdateProvider={props.onUpdateProvider}
              onListProviderModels={props.onListProviderModels}
              onDeleteProvider={props.onDeleteProvider}
              onTestProvider={props.onTestProvider}
              onSetDefaultProvider={props.onSetDefaultProvider}
            />
          ) : null}

          {tab === 'asset-provider' ? (
            <AppSettingsAssetProviderSection
              providers={props.assetGenerationProviderConfigs ?? []}
              onCreateProvider={props.onCreateAssetGenerationProvider}
              onUpdateProvider={props.onUpdateAssetGenerationProvider}
              onDeleteProvider={props.onDeleteAssetGenerationProvider}
            />
          ) : null}

          {tab === 'mcp' ? (
            <section className="app-settings-section provider-settings-embedded">
              <McpRegistrySettingsPage
                plugins={props.mcpPlugins}
                selectedPlugin={props.selectedMcpPlugin}
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
                isRefreshing={props.isRefreshingPlugin}
                onSelectPlugin={props.onSelectMcpPlugin}
                onRefresh={props.onRefreshMcpPluginMeta}
                onReconnect={props.onReconnectMcpPlugin}
                onStop={props.onStopMcpPlugin}
                onTogglePlugin={props.onToggleMcpPlugin}
                onAddPlugin={props.onAddMcpPlugin}
                onEditPlugin={props.onEditMcpPlugin}
                onDeletePlugin={props.onDeleteMcpPlugin}
                onSendRawMcpRequest={props.onSendRawMcpRequest}
              />
            </section>
          ) : null}

          {tab === 'web-search' ? (
            <section className="app-settings-section web-search-settings-section">
              <WebSearchSettingsPage
                settings={props.aiSettings.webSearch}
                onUpdateSettings={props.onUpdateWebSearchSettings}
              />
            </section>
          ) : null}

          {tab === 'memory' ? (
            <AppSettingsMemorySection
              language={language}
              selectedProjectId={props.selectedProjectId}
              memoryFiles={props.memoryFiles}
              selectedMemoryPath={props.selectedMemoryPath}
              selectedMemoryFile={props.selectedMemoryFile}
              memoryDraft={props.memoryDraft}
              isLoadingMemory={props.isLoadingMemory}
              isSavingMemory={props.isSavingMemory}
              memoryError={props.memoryError}
              onRefreshMemoryFiles={props.onRefreshMemoryFiles}
              onSelectMemoryFile={props.onSelectMemoryFile}
              onChangeMemoryDraft={props.onChangeMemoryDraft}
              onSaveMemoryFile={props.onSaveMemoryFile}
              onClearMemory={props.onClearMemory}
            />
          ) : null}

          {tab === 'notifications' ? (
            <section className="app-settings-section notification-settings-section">
              <div className="settings-section-header">
                <div>
                  <strong>{t('通知与提醒', 'Notifications and Reminders')}</strong>
                  <div className="helper-copy">{t('这里显示 Agent 通过内置通知工具创建的提醒任务。', 'Shows reminder tasks created by the built-in notification tools.')}</div>
                </div>
                <Button size="sm" variant="secondary" leadingIcon={<RefreshCw size={14} aria-hidden="true" />} loading={props.isLoadingNotificationTasks} onClick={() => void props.onRefreshNotificationTasks()}>
                  {props.isLoadingNotificationTasks ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}
                </Button>
              </div>

              <div className="notification-task-list">
                {props.notificationTasks.length > 0 ? (
                  props.notificationTasks.map((task) => (
                    <div key={task.id} className={`notification-task-row ${task.status}`}>
                      <div className="notification-task-copy">
                        <strong>{task.name}</strong>
                        <span>{task.prompt || t('无提醒正文', 'No reminder body')}</span>
                        <em>
                          {[
                            `${t('状态', 'Status')}: ${formatNotificationTaskStatus(task.status, language)}`,
                            `${task.scheduleType}: ${task.scheduleValue}`,
                            task.nextRun ? t(`下次：${formatAbsoluteTime(task.nextRun)}`, `Next: ${formatAbsoluteTime(task.nextRun)}`) : ''
                          ].filter(Boolean).join(' · ')}
                        </em>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void props.onCancelNotificationTask(task.id)}
                        disabled={task.status !== 'active'}
                      >
                        {t('取消', 'Cancel')}
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="helper-copy">
                    {props.isLoadingNotificationTasks
                      ? t('正在读取提醒任务…', 'Loading reminder tasks…')
                      : t('暂无提醒任务。', 'No reminder tasks yet.')}
                  </div>
                )}
              </div>

              {props.notificationTaskError ? <div className="agent-composer-error neutral">{props.notificationTaskError}</div> : null}
            </section>
          ) : null}

          {tab === 'about' ? (
            <section className="app-settings-section">
              <div className="settings-section-header">
                <div>
                  <strong>{t('关于 Funplay', 'About Funplay')}</strong>
                  <div className="helper-copy">{t('桌面端 AI 游戏创作工作台。', 'A desktop AI game creation workspace.')}</div>
                </div>
              </div>
              <div className="app-settings-about-grid">
                <InfoRow label={t('应用定位', 'Product')} value={t('AI 游戏开发工作台', 'AI Game Creation Workspace')} />
                <InfoRow label={t('主要场景', 'Use Case')} value={t('项目创建、AI 对话、文件查看、引擎接入', 'Project setup, AI chat, file review, engine integration')} />
                <InfoRow label={t('界面风格', 'UI Style')} value={t('桌面端原生双栏设置布局', 'Desktop-style split settings layout')} />
                <InfoRow label={t('配置范围', 'Scope')} value={t('主题、语言、AI Provider', 'Theme, language, AI providers')} />
              </div>

              <div className="app-update-panel">
                <div className="app-update-header">
                  <div>
                    <strong>{t('软件更新', 'Software Update')}</strong>
                    <div className="helper-copy">
                      {t('自动检查新版本；发现更新后由你确认下载与重启安装。', 'Automatically checks for new versions; you choose when to download and restart to install.')}
                    </div>
                  </div>
                  <span className={`app-update-status-pill ${props.appUpdateStatus?.status ?? 'idle'}`}>
                    {formatAppUpdateStatus(props.appUpdateStatus?.status ?? 'idle', language)}
                  </span>
                </div>

                <div className="app-settings-about-grid">
                  <InfoRow label={t('当前版本', 'Current Version')} value={props.appUpdateStatus?.currentVersion ?? '-'} />
                  <InfoRow label={t('最新版本', 'Latest Version')} value={props.appUpdateStatus?.updateInfo?.version ?? '-'} />
                  <InfoRow label={t('更新源', 'Update Source')} value={formatAppUpdateFeedSource(props.appUpdateStatus?.feedSource ?? 'none', language)} />
                  <InfoRow
                    label={t('上次检查', 'Last Checked')}
                    value={props.appUpdateStatus?.lastCheckedAt ? formatAbsoluteTime(props.appUpdateStatus.lastCheckedAt) : '-'}
                  />
                </div>

                {props.appUpdateStatus?.status === 'downloading' && props.appUpdateStatus.progress ? (
                  <div>
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${Math.round(props.appUpdateStatus.progress.percent)}%` }} />
                    </div>
                    <div className="helper-copy">
                      {t(
                        `正在下载 ${Math.round(props.appUpdateStatus.progress.percent)}% · ${formatFileSize(props.appUpdateStatus.progress.transferred)} / ${formatFileSize(props.appUpdateStatus.progress.total)}`,
                        `Downloading ${Math.round(props.appUpdateStatus.progress.percent)}% · ${formatFileSize(props.appUpdateStatus.progress.transferred)} / ${formatFileSize(props.appUpdateStatus.progress.total)}`
                      )}
                    </div>
                  </div>
                ) : null}

                {props.appUpdateStatus?.updateInfo?.releaseNotes ? (
                  <details className="app-update-release-notes">
                    <summary>{t('查看更新说明', 'Release Notes')}</summary>
                    <pre>{props.appUpdateStatus.updateInfo.releaseNotes}</pre>
                  </details>
                ) : null}

                {props.appUpdateStatus?.error ? <div className="agent-composer-error neutral">{props.appUpdateStatus.error}</div> : null}
                {updateActionMessage ? <div className="agent-composer-error neutral">{updateActionMessage}</div> : null}

                <div className="modal-actions compact">
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<RefreshCw size={14} aria-hidden="true" />}
                    onClick={() => void runUpdateAction('check')}
                    disabled={Boolean(updateAction) || !props.appUpdateStatus?.canCheck || props.appUpdateStatus?.status === 'checking' || props.appUpdateStatus?.status === 'downloading'}
                    loading={updateAction === 'check' || props.appUpdateStatus?.status === 'checking'}
                  >
                    {updateAction === 'check' || props.appUpdateStatus?.status === 'checking' ? t('检查中…', 'Checking…') : t('检查更新', 'Check for Updates')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    leadingIcon={<Download size={14} aria-hidden="true" />}
                    onClick={() => void runUpdateAction('download')}
                    disabled={Boolean(updateAction) || !props.appUpdateStatus?.canDownload}
                    loading={updateAction === 'download' || props.appUpdateStatus?.status === 'downloading'}
                  >
                    {updateAction === 'download' || props.appUpdateStatus?.status === 'downloading' ? t('下载中…', 'Downloading…') : t('下载更新', 'Download Update')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    leadingIcon={<Download size={14} aria-hidden="true" />}
                    onClick={() => void runUpdateAction('install')}
                    disabled={Boolean(updateAction) || !props.appUpdateStatus?.canInstall}
                    loading={updateAction === 'install' || props.appUpdateStatus?.status === 'installing'}
                  >
                    {updateAction === 'install' || props.appUpdateStatus?.status === 'installing' ? t('准备重启…', 'Restarting…') : t('重启并安装', 'Restart and Install')}
                  </Button>
                </div>

                {props.appUpdateStatus?.feedSource === 'none' ? (
                  <div className="helper-copy">
                    {t(
                      '当前没有配置更新源。自动更新仅在正式打包应用中使用 GitHub Releases。',
                      'No update feed is configured. Auto update uses GitHub Releases in packaged production builds.'
                    )}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}
