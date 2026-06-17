import { useEffect, useState, type JSX } from 'react';
import { ChevronLeft, Plus, RefreshCw, RotateCw, Settings2, Square, Trash2 } from 'lucide-react';
import type { McpConnectionSnapshot, McpPlugin, McpRawAuditEntry, McpRawRequestResult, McpToolSnapshot, UnityMcpPrompt, UnityMcpResource, UnityMcpResourceTemplate, UnityMcpServerInfo, UnityMcpTool } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Card, InfoRow, List } from '../shared/InfoComponents';
import { CapabilityBadgeRow, McpRawAuditCard, McpRawDiagnosticsCard, McpToolSnapshotCard } from './McpManagementPage';
import { Button, ConfigDetailActionBar, ConfigListPanel, ToggleSwitch, type ConfigListItem } from '../ui/index';

function formatMcpEndpoint(plugin: McpPlugin): string {
  return plugin.transport === 'stdio'
    ? [plugin.command, ...(plugin.args ?? [])].filter(Boolean).join(' ') || 'stdio'
    : plugin.baseUrl;
}

function formatConnectionStatus(language: 'zh-CN' | 'en-US', snapshot: McpConnectionSnapshot | null): string {
  if (!snapshot) {
    return localize(language, '未检测', 'Not checked');
  }
  const statusLabel = snapshot.status === 'online'
    ? localize(language, '在线', 'Online')
    : snapshot.status === 'connecting'
      ? localize(language, '连接中', 'Connecting')
      : snapshot.status === 'offline'
        ? localize(language, '离线', 'Offline')
        : localize(language, '空闲', 'Idle');
  if (!snapshot.processStatus) {
    return statusLabel;
  }
  const processLabel = snapshot.processStatus === 'running'
    ? localize(language, '进程运行中', 'process running')
    : snapshot.processStatus === 'stopped'
      ? localize(language, '已停止', 'stopped')
      : snapshot.processStatus === 'exited'
        ? localize(language, '已退出', 'exited')
        : localize(language, '未启动', 'not started');
  return `${statusLabel} · ${processLabel}`;
}

export function McpRegistrySettingsPage(props: {
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
  onSelectPlugin: (pluginId: string) => void;
  onRefresh: () => void;
  onReconnect: () => void;
  onStop: () => void;
  onTogglePlugin: (plugin: McpPlugin, enabled: boolean) => void | Promise<void>;
  onAddPlugin: () => void;
  onEditPlugin: (plugin: McpPlugin) => void;
  onDeletePlugin: (pluginId: string) => void;
  onSendRawMcpRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [detailPluginId, setDetailPluginId] = useState('');
  const [togglingPluginId, setTogglingPluginId] = useState('');

  async function handleTogglePlugin(plugin: McpPlugin, enabled: boolean): Promise<void> {
    setTogglingPluginId(plugin.id);
    try {
      await props.onTogglePlugin(plugin, enabled);
    } finally {
      setTogglingPluginId('');
    }
  }

  function confirmDeletePlugin(pluginId: string): void {
    if (window.confirm(t('删除此 MCP Server？此操作不可撤销，并会从所有项目解绑。', 'Delete this MCP server? This cannot be undone and unbinds it from all projects.'))) {
      props.onDeletePlugin(pluginId);
    }
  }

  const detailPlugin = props.plugins.find((plugin) => plugin.id === detailPluginId) ?? null;
  const pluginItems: ConfigListItem[] = props.plugins.map((plugin) => {
    const snapshot = props.connectionStatuses[plugin.id] ?? (props.selectedPlugin?.id === plugin.id ? props.connectionStatus : null);
    const online = snapshot?.status === 'online';
    const connecting = snapshot?.status === 'connecting';
    return {
      id: plugin.id,
      title: plugin.name,
      subtitle: `${plugin.kind} · ${plugin.transport}`,
      description: formatMcpEndpoint(plugin),
      statusLabel: plugin.enabled
        ? online
          ? t('在线', 'Online')
          : connecting
            ? t('连接中', 'Connecting')
            : t('已启用', 'Enabled')
        : t('停用', 'Disabled'),
      statusTone: !plugin.enabled ? 'neutral' : online ? 'success' : connecting ? 'warning' : 'brand',
      enabled: plugin.enabled,
      meta: [
        plugin.defaultToolPermission ? t(`权限：${plugin.defaultToolPermission}`, `Permission: ${plugin.defaultToolPermission}`) : '',
        plugin.defaultToolRisk ? t(`风险：${plugin.defaultToolRisk}`, `Risk: ${plugin.defaultToolRisk}`) : ''
      ].filter(Boolean),
      rowMainClassName: 'mcp-server-row-main',
      searchText: [plugin.baseUrl, plugin.command, plugin.args?.join(' '), plugin.notes].filter(Boolean).join(' ')
    };
  });

  useEffect(() => {
    if (detailPluginId && !props.plugins.some((plugin) => plugin.id === detailPluginId)) {
      setDetailPluginId('');
    }
  }, [detailPluginId, props.plugins]);

  function openPluginDetail(plugin: McpPlugin): void {
    setDetailPluginId(plugin.id);
    props.onSelectPlugin(plugin.id);
  }

  return (
    <div className="mcp-registry-settings">
      <div className="settings-header embedded">
        <div>
          <h2>{t('MCP Registry', 'MCP Registry')}</h2>
          <div className="provider-settings-meta">
            <span>{t(`已登记 ${props.plugins.length} 个 Server`, `${props.plugins.length} servers registered`)}</span>
            <span>{props.selectedPlugin ? t(`当前：${props.selectedPlugin.name}`, `Selected: ${props.selectedPlugin.name}`) : t('未选择', 'None selected')}</span>
          </div>
        </div>
        <Button variant="primary" onClick={props.onAddPlugin} leadingIcon={<Plus size={15} aria-hidden="true" />}>
          {t('添加 Server', 'Add server')}
        </Button>
      </div>

      {detailPlugin ? (
        <div className="settings-detail-panel mcp-settings-detail-route">
          <div className="settings-header">
            <div>
              <Button variant="ghost" size="sm" className="settings-detail-back-button" onClick={() => setDetailPluginId('')} leadingIcon={<ChevronLeft size={14} aria-hidden="true" />}>
                {t('返回', 'Back')}
              </Button>
              <h2>{detailPlugin.name}</h2>
              <p>{detailPlugin.notes || formatMcpEndpoint(detailPlugin) || t('管理 MCP 的全局连接定义、启停状态和元数据检测。', 'Manage global MCP connection definitions, enabled state, and metadata checks.')}</p>
            </div>
            <ConfigDetailActionBar actions={[
              { id: 'edit', label: t('编辑', 'Edit'), icon: <Settings2 size={14} aria-hidden="true" />, onAction: () => props.onEditPlugin(detailPlugin) },
              ...(detailPlugin.transport === 'stdio'
                ? [
                    { id: 'restart', label: t('重启', 'Restart'), icon: <RotateCw size={14} aria-hidden="true" />, disabled: props.isRefreshing, onAction: props.onReconnect },
                    { id: 'stop', label: t('停止', 'Stop'), icon: <Square size={13} aria-hidden="true" />, disabled: props.connectionStatus?.processStatus !== 'running', onAction: props.onStop }
                  ]
                : []),
              { id: 'refresh', label: props.isRefreshing ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh'), icon: <RefreshCw size={14} aria-hidden="true" />, disabled: props.isRefreshing, onAction: props.onRefresh },
              { id: 'delete', label: t('删除', 'Delete'), tone: 'danger', icon: <Trash2 size={14} aria-hidden="true" />, onAction: () => confirmDeletePlugin(detailPlugin.id) }
            ]} />
          </div>

          {props.pluginError ? <div className="warning-banner error mcp-plugin-error" style={{ whiteSpace: 'pre-line' }}>{props.pluginError}</div> : null}

          <div className="detail-grid">
            <Card title={t('连接定义', 'Connection')}>
              <InfoRow label={t('范围', 'Scope')} value={t('全局', 'Global')} />
              <InfoRow label="Transport" value={detailPlugin.transport} />
              <InfoRow label="Endpoint" value={formatMcpEndpoint(detailPlugin)} />
              <InfoRow label={t('连接状态', 'Connection Status')} value={formatConnectionStatus(language, props.connectionStatus)} />
              {props.connectionStatus?.pid ? <InfoRow label="PID" value={String(props.connectionStatus.pid)} /> : null}
              <InfoRow label={t('状态', 'Status')} value={detailPlugin.enabled ? t('启用', 'Enabled') : t('禁用', 'Disabled')} />
              {props.connectionStatus?.lastError ? <div className="warning-banner compact error">{props.connectionStatus.lastError}</div> : null}
            </Card>
            <Card title={t('服务端信息', 'Server Info')}>
              <div className="info-line">{props.serverInfo ? `${props.serverInfo.name} · ${props.serverInfo.version}` : t('尚未检测', 'Not checked yet')}</div>
              <div className="helper-copy">{props.serverInfo ? `protocol ${props.serverInfo.protocolVersion}` : t('点击刷新读取 MCP 元数据。', 'Click refresh to load MCP metadata.')}</div>
              <CapabilityBadgeRow
                serverInfo={props.serverInfo}
                tools={props.tools}
                resources={props.resources}
                prompts={props.prompts}
                resourceTemplates={props.resourceTemplates}
              />
            </Card>
            <Card title={t('工具能力', 'Tool Capabilities')}>
              <div className="helper-copy">{t(`已发现 ${props.tools.length} 个工具`, `${props.tools.length} tools detected`)}</div>
              <List items={props.tools.slice(0, 10).map((tool) => tool.name)} />
            </Card>
            <McpToolSnapshotCard snapshots={props.toolSnapshots} />
            <McpRawDiagnosticsCard plugin={detailPlugin} onSendRawRequest={props.onSendRawMcpRequest} />
            <McpRawAuditCard audits={props.rawAudits} />
            <Card title={t('资源上下文', 'Resource Context')}>
              <div className="helper-copy">{t(`已发现 ${props.resources.length} 个资源`, `${props.resources.length} resources detected`)}</div>
              <List items={props.resources.slice(0, 10).map((resource) => resource.uri)} />
            </Card>
            <Card title={t('提示词与模板', 'Prompts & Templates')}>
              <div className="helper-copy">{t(`已发现 ${props.prompts.length} 个 Prompt、${props.resourceTemplates.length} 个资源模板`, `${props.prompts.length} prompts, ${props.resourceTemplates.length} resource templates detected`)}</div>
              <List items={[
                ...props.prompts.slice(0, 5).map((prompt) => prompt.name),
                ...props.resourceTemplates.slice(0, 5).map((template) => template.uriTemplate)
              ]} />
            </Card>
            {detailPlugin.transport === 'stdio' ? (
              <Card title={t('进程日志', 'Process Log')}>
                <div className="helper-copy">{props.connectionStatus?.startedAt ? t(`启动于 ${props.connectionStatus.startedAt}`, `Started at ${props.connectionStatus.startedAt}`) : t('尚未启动 stdio 进程。', 'The stdio process has not started yet.')}</div>
                <pre className="mcp-process-log">{props.connectionStatus?.stderrTail?.length ? props.connectionStatus.stderrTail.join('\n') : t('暂无 stderr 输出。', 'No stderr output yet.')}</pre>
              </Card>
            ) : null}
          </div>
        </div>
      ) : (
        <ConfigListPanel
          className="mcp-settings-list-panel"
          items={pluginItems}
          emptyTitle={t('暂无全局 MCP Server', 'No global MCP servers yet')}
          emptyDescription=""
          onOpenItem={(pluginId) => {
            const plugin = props.plugins.find((item) => item.id === pluginId);
            if (plugin) openPluginDetail(plugin);
          }}
          renderItemActions={(item) => {
            const plugin = props.plugins.find((candidate) => candidate.id === item.id);
            return plugin ? (
              <ToggleSwitch
                label={plugin.enabled ? t('停用 MCP Server', 'Disable MCP server') : t('启用 MCP Server', 'Enable MCP server')}
                checked={plugin.enabled}
                disabled={togglingPluginId === plugin.id}
                onCheckedChange={(enabled) => void handleTogglePlugin(plugin, enabled)}
              />
            ) : null;
          }}
        />
      )}
    </div>
  );
}
