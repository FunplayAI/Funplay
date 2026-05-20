import { type JSX } from 'react';
import { Plus, RefreshCw, RotateCw, Settings2, Square, Trash2 } from 'lucide-react';
import type { McpConnectionSnapshot, McpPlugin, McpRawAuditEntry, McpRawRequestResult, McpToolSnapshot, UnityMcpPrompt, UnityMcpResource, UnityMcpResourceTemplate, UnityMcpServerInfo, UnityMcpTool } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Card, InfoRow, List } from '../shared/InfoComponents';
import { CapabilityBadgeRow, McpRawAuditCard, McpRawDiagnosticsCard, McpToolSnapshotCard, ServerListRow, formatMcpCapabilitySummary, formatMcpPolicySummary } from './McpManagementPage';
import { Button } from '../ui/index';

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
  onTogglePlugin: (plugin: McpPlugin, enabled: boolean) => void;
  onAddPlugin: () => void;
  onEditPlugin: (plugin: McpPlugin) => void;
  onDeletePlugin: (pluginId: string) => void;
  onSendRawMcpRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);

  return (
    <div className="mcp-registry-settings">
      <div className="settings-header embedded">
        <div>
          <h2>{t('MCP Registry', 'MCP Registry')}</h2>
          <p>{t('管理全局 MCP Server。项目设置里可以选择启用这些全局 Server，但不能删除它们。', 'Manage global MCP servers. Project settings can enable these servers, but cannot delete them.')}</p>
          <div className="provider-settings-meta">
            <span>{t(`已登记 ${props.plugins.length} 个 Server`, `${props.plugins.length} servers registered`)}</span>
            <span>{props.selectedPlugin ? t(`当前：${props.selectedPlugin.name}`, `Selected: ${props.selectedPlugin.name}`) : t('未选择', 'None selected')}</span>
          </div>
        </div>
        <Button variant="primary" onClick={props.onAddPlugin} leadingIcon={<Plus size={15} aria-hidden="true" />}>
          {t('添加 Server', 'Add server')}
        </Button>
      </div>

      <div className="settings-page mcp-registry-layout">
        <div className="settings-list-panel">
          {props.plugins.length === 0 ? <div className="empty-note">{t('暂无全局 MCP Server，请先添加。', 'No global MCP servers yet. Add one first.')}</div> : null}
          <div className="mcp-server-list">
            {props.plugins.map((plugin) => (
              <ServerListRow
                key={plugin.id}
                plugin={plugin}
                selected={props.selectedPlugin?.id === plugin.id}
                checked={plugin.enabled}
                scopeLabel={t('全局', 'Global')}
                connectionStatus={props.connectionStatuses[plugin.id] ?? null}
                capabilitySummary={props.selectedPlugin?.id === plugin.id ? formatMcpCapabilitySummary(language, props.tools.length, props.resources.length, props.prompts.length, props.resourceTemplates.length) : undefined}
                policySummary={formatMcpPolicySummary(language, plugin)}
                onSelect={() => props.onSelectPlugin(plugin.id)}
                onToggle={(enabled) => props.onTogglePlugin(plugin, enabled)}
                onEdit={() => props.onEditPlugin(plugin)}
                onDelete={() => props.onDeletePlugin(plugin.id)}
              />
            ))}
          </div>
        </div>

        <div className="settings-detail-panel">
          <div className="settings-header">
            <div>
              <h2>{props.selectedPlugin?.name || t('选择一个 MCP', 'Select an MCP')}</h2>
              <p>{props.selectedPlugin?.notes || (props.selectedPlugin ? formatMcpEndpoint(props.selectedPlugin) : t('管理 MCP 的全局连接定义、启停状态和元数据检测。', 'Manage global MCP connection definitions, enabled state, and metadata checks.'))}</p>
            </div>
            <div className="ghost-pill-group">
              {props.selectedPlugin ? (
                <Button variant="secondary" size="sm" onClick={() => props.onEditPlugin(props.selectedPlugin!)} leadingIcon={<Settings2 size={14} aria-hidden="true" />}>
                  {t('编辑', 'Edit')}
                </Button>
              ) : null}
              {props.selectedPlugin?.transport === 'stdio' ? (
                <>
                  <Button variant="secondary" size="sm" onClick={props.onReconnect} disabled={props.isRefreshing} leadingIcon={<RotateCw size={14} aria-hidden="true" />}>
                    {t('重启', 'Restart')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={props.onStop} disabled={props.connectionStatus?.processStatus !== 'running'} leadingIcon={<Square size={13} aria-hidden="true" />}>
                    {t('停止', 'Stop')}
                  </Button>
                </>
              ) : null}
              <Button variant="secondary" size="sm" onClick={props.onRefresh} disabled={!props.selectedPlugin || props.isRefreshing} leadingIcon={<RefreshCw size={14} aria-hidden="true" />}>
                {props.isRefreshing ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}
              </Button>
              {props.selectedPlugin ? (
                <Button variant="danger" size="sm" onClick={() => props.onDeletePlugin(props.selectedPlugin!.id)} leadingIcon={<Trash2 size={14} aria-hidden="true" />}>
                  {t('删除', 'Delete')}
                </Button>
              ) : null}
            </div>
          </div>

          {props.pluginError ? <div className="warning-banner error">{props.pluginError}</div> : null}

          {props.selectedPlugin ? (
            <>
              <div className="detail-grid">
                <Card title={t('连接定义', 'Connection')}>
                  <InfoRow label={t('范围', 'Scope')} value={t('全局', 'Global')} />
                  <InfoRow label="Transport" value={props.selectedPlugin.transport} />
                  <InfoRow label="Endpoint" value={formatMcpEndpoint(props.selectedPlugin)} />
                  <InfoRow label={t('连接状态', 'Connection Status')} value={formatConnectionStatus(language, props.connectionStatus)} />
                  {props.connectionStatus?.pid ? <InfoRow label="PID" value={String(props.connectionStatus.pid)} /> : null}
                  <InfoRow label={t('状态', 'Status')} value={props.selectedPlugin.enabled ? t('启用', 'Enabled') : t('禁用', 'Disabled')} />
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
                <McpRawDiagnosticsCard plugin={props.selectedPlugin} onSendRawRequest={props.onSendRawMcpRequest} />
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
                {props.selectedPlugin.transport === 'stdio' ? (
                  <Card title={t('进程日志', 'Process Log')}>
                    <div className="helper-copy">{props.connectionStatus?.startedAt ? t(`启动于 ${props.connectionStatus.startedAt}`, `Started at ${props.connectionStatus.startedAt}`) : t('尚未启动 stdio 进程。', 'The stdio process has not started yet.')}</div>
                    <pre className="mcp-process-log">{props.connectionStatus?.stderrTail?.length ? props.connectionStatus.stderrTail.join('\n') : t('暂无 stderr 输出。', 'No stderr output yet.')}</pre>
                  </Card>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-note">{t('选择左侧 MCP 查看连接信息。', 'Select an MCP entry on the left to inspect it.')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
