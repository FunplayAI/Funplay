import { useState, type JSX } from 'react';
import type { McpConnectionSnapshot, McpPlugin, McpRawAuditEntry, McpRawRequestResult, McpToolSnapshot, Project, UnityMcpPrompt, UnityMcpResource, UnityMcpResourceTemplate, UnityMcpServerInfo, UnityMcpTool } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import type { ProjectMcpBindingDraft } from '../../lib/app-types';
import { Card, InfoRow, List } from '../shared/InfoComponents';

function canProjectUsePlugin(project: Project | null, plugin: McpPlugin): boolean {
  return Boolean(project && (!plugin.projectId || plugin.projectId === project.id));
}

function serverScopeLabel(language: 'zh-CN' | 'en-US', plugin: McpPlugin): string {
  return plugin.projectId
    ? localize(language, '项目', 'Project')
    : localize(language, '全局', 'Global');
}

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

function connectionStatusClass(snapshot: McpConnectionSnapshot | null | undefined): string {
  if (!snapshot) {
    return 'idle';
  }
  return snapshot.status;
}

export function formatMcpCapabilitySummary(
  language: 'zh-CN' | 'en-US',
  tools: number,
  resources: number,
  prompts: number,
  resourceTemplates: number
): string {
  return localize(
    language,
    `能力：Tools ${tools} · Resources ${resources} · Prompts ${prompts} · Templates ${resourceTemplates}`,
    `Capabilities: Tools ${tools} · Resources ${resources} · Prompts ${prompts} · Templates ${resourceTemplates}`
  );
}

export function formatMcpPolicySummary(language: 'zh-CN' | 'en-US', plugin: McpPlugin): string {
  const permission = plugin.defaultToolPermission ?? 'infer';
  const risk = plugin.defaultToolRisk ?? 'infer';
  const overrideCount = Object.keys(plugin.toolPolicies ?? {}).length;
  const overrideText = overrideCount > 0
    ? localize(language, ` · 覆盖 ${overrideCount}`, ` · overrides ${overrideCount}`)
    : '';
  return localize(
    language,
    `策略：默认 ${permission} / 风险 ${risk}${overrideText}`,
    `Policy: default ${permission} / risk ${risk}${overrideText}`
  );
}

function formatSnapshotChange(language: 'zh-CN' | 'en-US', change: McpToolSnapshot['changeKind']): string {
  const labels: Record<McpToolSnapshot['changeKind'], string> = {
    added: localize(language, '新增', 'Added'),
    changed: localize(language, '已变化', 'Changed'),
    unchanged: localize(language, '未变化', 'Unchanged'),
    removed: localize(language, '已移除', 'Removed')
  };
  return labels[change];
}

export function McpToolSnapshotCard(props: { snapshots: McpToolSnapshot[] }): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const changed = props.snapshots.filter((snapshot) => snapshot.changeKind === 'changed' || snapshot.changeKind === 'removed');
  return (
    <Card title={t('工具映射审计', 'Tool Mapping Audit')}>
      <div className="helper-copy">{t(`已记录 ${props.snapshots.length} 个工具映射`, `${props.snapshots.length} tool mappings recorded`)}</div>
      {changed.length > 0 ? (
        <div className="warning-banner compact">
          {t(`有 ${changed.length} 个工具发生变化或被移除，Agent 下次会按最新 tools/list 重新映射。`, `${changed.length} tools changed or were removed; the Agent will remap from the latest tools/list next time.`)}
        </div>
      ) : null}
      <List
        items={props.snapshots.slice(0, 8).map((snapshot) => [
          snapshot.originalName,
          snapshot.exposedName ? `→ ${snapshot.exposedName}` : t('未暴露', 'not exposed'),
          formatSnapshotChange(language, snapshot.changeKind)
        ].filter(Boolean).join(' · '))}
      />
    </Card>
  );
}

const rawMcpDiagnosticMethods = [
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'resources/templates/list',
  'completion/complete'
];

export function McpRawDiagnosticsCard(props: {
  plugin: McpPlugin;
  onSendRawRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [method, setMethod] = useState(rawMcpDiagnosticMethods[0]);
  const [paramsText, setParamsText] = useState('{}');
  const [result, setResult] = useState<McpRawRequestResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <Card title={t('Raw 诊断', 'Raw Diagnostics')}>
      <div className="helper-copy">{t('只允许只读/诊断类 MCP JSON-RPC 方法；工具执行类方法不会开放。', 'Only read-only diagnostic MCP JSON-RPC methods are allowed; tool execution methods are not exposed.')}</div>
      <label className="field compact">
        <span>Method</span>
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          {rawMcpDiagnosticMethods.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label className="field compact">
        <span>Params JSON</span>
        <textarea value={paramsText} onChange={(event) => setParamsText(event.target.value)} />
      </label>
      {error ? <div className="warning-banner compact error">{error}</div> : null}
      <button
        className="prototype-secondary small"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError('');
          setResult(null);
          let params: Record<string, unknown>;
          try {
            const parsed = JSON.parse(paramsText || '{}') as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('Params must be a JSON object.');
            }
            params = parsed as Record<string, unknown>;
          } catch (parseError) {
            setError(parseError instanceof Error ? parseError.message : t('Params JSON 无效。', 'Invalid params JSON.'));
            setLoading(false);
            return;
          }
          void props.onSendRawRequest(props.plugin.id, method, params)
            .then(setResult)
            .catch((requestError) => setError(requestError instanceof Error ? requestError.message : t('Raw 请求失败。', 'Raw request failed.')))
            .finally(() => setLoading(false));
        }}
      >
        {loading ? t('发送中…', 'Sending...') : t('发送诊断请求', 'Send diagnostic request')}
      </button>
      {result ? (
        <pre className="mcp-process-log">{result.truncated ? result.resultPreview : JSON.stringify(result.result, null, 2)}</pre>
      ) : null}
    </Card>
  );
}

function formatRawAuditStatus(language: 'zh-CN' | 'en-US', status: McpRawAuditEntry['status']): string {
  return status === 'success'
    ? localize(language, '成功', 'Success')
    : localize(language, '失败', 'Failed');
}

export function McpRawAuditCard(props: { audits: McpRawAuditEntry[] }): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const failed = props.audits.filter((audit) => audit.status === 'failed').length;
  return (
    <Card title={t('Raw 操作审计', 'Raw Operation Audit')}>
      <div className="helper-copy">
        {t(`已记录 ${props.audits.length} 次诊断请求，失败 ${failed} 次。`, `${props.audits.length} diagnostic requests recorded, ${failed} failed.`)}
      </div>
      <List
        items={props.audits.slice(0, 8).map((audit) => [
          audit.method,
          formatRawAuditStatus(language, audit.status),
          `${audit.durationMs}ms`,
          audit.createdAt,
          audit.error ? t(`错误：${audit.error}`, `Error: ${audit.error}`) : ''
        ].filter(Boolean).join(' · '))}
      />
    </Card>
  );
}

export function McpManagementPage(props: {
  project: Project | null;
  plugins: McpPlugin[];
  projectBindings: ProjectMcpBindingDraft;
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
  onRefresh: () => void;
  onReconnect: () => void;
  onStop: () => void;
  onOpenRegistry: () => void;
  onSelectProjectMcpPlugin: (pluginId: string) => void;
  onToggleProjectMcpPlugin: (pluginId: string, enabled: boolean) => void;
  onAddProjectMcpPlugin: () => void;
  onEditProjectMcpPlugin: (plugin: McpPlugin) => void;
  onDeleteProjectMcpPlugin: (pluginId: string) => void;
  onSendRawMcpRequest: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<McpRawRequestResult>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const projectPlugins = props.plugins.filter((plugin) => canProjectUsePlugin(props.project, plugin));
  const enabledProjectPluginIds = new Set(props.projectBindings);
  const selectedPlugin =
    props.selectedPlugin && projectPlugins.some((plugin) => plugin.id === props.selectedPlugin?.id)
      ? props.selectedPlugin
      : projectPlugins.find((plugin) => enabledProjectPluginIds.has(plugin.id)) ?? projectPlugins[0] ?? null;

  return (
    <div className="mcp-server-settings-page">
      <div className="mcp-server-settings-header">
        <div>
          <h2>{t('Servers', 'Servers')}</h2>
          <p>{t('为当前项目选择可用 MCP。全局服务器只在这里启停，新增和删除请到全局设置。', 'Choose MCP servers for this project. Global servers can only be enabled or disabled here; add and delete them in global settings.')}</p>
        </div>
        <div className="ghost-pill-group">
          <button className="prototype-secondary small" onClick={props.onOpenRegistry}>
            {t('全局设置', 'Global Settings')}
          </button>
          <button className="prototype-primary small" disabled={!props.project} onClick={props.onAddProjectMcpPlugin}>
            + {t('添加项目 Server', 'Add project server')}
          </button>
        </div>
      </div>

      <div className="mcp-server-list" role="list">
        {projectPlugins.length === 0 ? (
          <div className="empty-note">{t('暂无 MCP Server。可以添加项目 Server，或到全局设置里添加全局 Server。', 'No MCP servers yet. Add a project server, or add a global server in global settings.')}</div>
        ) : null}
        {projectPlugins.map((plugin) => {
          const isProjectScoped = Boolean(plugin.projectId);
          const disabledByGlobal = !isProjectScoped && !plugin.enabled;
          const checked = enabledProjectPluginIds.has(plugin.id) && !disabledByGlobal;
          return (
            <ServerListRow
              key={plugin.id}
              plugin={plugin}
              selected={selectedPlugin?.id === plugin.id}
              checked={checked}
              disabled={!props.project || disabledByGlobal}
              scopeLabel={serverScopeLabel(language, plugin)}
              disabledNote={disabledByGlobal ? t('已在全局禁用', 'Disabled globally') : undefined}
              connectionStatus={props.connectionStatuses[plugin.id] ?? null}
              capabilitySummary={selectedPlugin?.id === plugin.id ? formatMcpCapabilitySummary(language, props.tools.length, props.resources.length, props.prompts.length, props.resourceTemplates.length) : undefined}
              policySummary={formatMcpPolicySummary(language, plugin)}
              onSelect={() => props.onSelectProjectMcpPlugin(plugin.id)}
              onToggle={(enabled) => props.onToggleProjectMcpPlugin(plugin.id, enabled)}
              onEdit={isProjectScoped ? () => props.onEditProjectMcpPlugin(plugin) : undefined}
              onDelete={isProjectScoped ? () => props.onDeleteProjectMcpPlugin(plugin.id) : undefined}
            />
          );
        })}
      </div>

      <div className="mcp-server-runtime-panel">
        <div className="settings-header compact">
          <div>
            <h2>{selectedPlugin?.name || t('选择一个 Server', 'Select a server')}</h2>
            <p>{selectedPlugin?.notes || selectedPlugin?.baseUrl || t('启用后 Agent 才会获得这个 MCP 的工具和资源。', 'Enable a server before the Agent can use its tools and resources.')}</p>
          </div>
          <div className="ghost-pill-group">
            {selectedPlugin?.transport === 'stdio' ? (
              <>
                <button className="prototype-secondary small" onClick={props.onReconnect} disabled={!selectedPlugin || props.isRefreshing}>
                  {t('重启', 'Restart')}
                </button>
                <button className="prototype-secondary small" onClick={props.onStop} disabled={!selectedPlugin || props.connectionStatus?.processStatus !== 'running'}>
                  {t('停止', 'Stop')}
                </button>
              </>
            ) : null}
            <button className="prototype-secondary small" onClick={props.onRefresh} disabled={!selectedPlugin || props.isRefreshing}>
              {props.isRefreshing ? t('刷新中…', 'Refreshing…') : t('刷新能力', 'Refresh')}
            </button>
          </div>
        </div>

        {props.pluginError ? <div className="warning-banner error">{props.pluginError}</div> : null}

        {selectedPlugin ? (
          <div className="detail-grid">
            <Card title={t('连接', 'Connection')}>
              <InfoRow label={t('范围', 'Scope')} value={serverScopeLabel(language, selectedPlugin)} />
              <InfoRow label="Transport" value={selectedPlugin.transport} />
              <InfoRow label="Endpoint" value={formatMcpEndpoint(selectedPlugin)} />
              <InfoRow label={t('连接状态', 'Connection Status')} value={formatConnectionStatus(language, props.connectionStatus)} />
              {props.connectionStatus?.pid ? <InfoRow label="PID" value={String(props.connectionStatus.pid)} /> : null}
              <InfoRow label={t('项目启用', 'Project Enabled')} value={enabledProjectPluginIds.has(selectedPlugin.id) ? t('是', 'Yes') : t('否', 'No')} />
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
              <List items={props.tools.slice(0, 8).map((tool) => tool.name)} />
            </Card>
            <McpToolSnapshotCard snapshots={props.toolSnapshots} />
            <McpRawDiagnosticsCard plugin={selectedPlugin} onSendRawRequest={props.onSendRawMcpRequest} />
            <McpRawAuditCard audits={props.rawAudits} />
            <Card title={t('资源上下文', 'Resource Context')}>
              <div className="helper-copy">{t(`已发现 ${props.resources.length} 个资源`, `${props.resources.length} resources detected`)}</div>
              <List items={props.resources.slice(0, 8).map((resource) => resource.uri)} />
            </Card>
            <Card title={t('提示词与模板', 'Prompts & Templates')}>
              <div className="helper-copy">{t(`已发现 ${props.prompts.length} 个 Prompt、${props.resourceTemplates.length} 个资源模板`, `${props.prompts.length} prompts, ${props.resourceTemplates.length} resource templates detected`)}</div>
              <List items={[
                ...props.prompts.slice(0, 4).map((prompt) => prompt.name),
                ...props.resourceTemplates.slice(0, 4).map((template) => template.uriTemplate)
              ]} />
            </Card>
            {selectedPlugin.transport === 'stdio' ? (
              <Card title={t('进程日志', 'Process Log')}>
                <div className="helper-copy">{props.connectionStatus?.startedAt ? t(`启动于 ${props.connectionStatus.startedAt}`, `Started at ${props.connectionStatus.startedAt}`) : t('尚未启动 stdio 进程。', 'The stdio process has not started yet.')}</div>
                <pre className="mcp-process-log">{props.connectionStatus?.stderrTail?.length ? props.connectionStatus.stderrTail.join('\n') : t('暂无 stderr 输出。', 'No stderr output yet.')}</pre>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CapabilityBadgeRow(props: {
  serverInfo: UnityMcpServerInfo | null;
  tools: UnityMcpTool[];
  resources: UnityMcpResource[];
  prompts: UnityMcpPrompt[];
  resourceTemplates: UnityMcpResourceTemplate[];
}): JSX.Element | null {
  const language = useUiLanguage();
  const caps = props.serverInfo?.capabilities ?? {};
  const hasCapability = (name: string): boolean => typeof caps[name] === 'object' && caps[name] !== null;
  const labels = [
    hasCapability('tools') || props.tools.length > 0 ? localize(language, 'Tools', 'Tools') : '',
    hasCapability('resources') || props.resources.length > 0 || props.resourceTemplates.length > 0 ? localize(language, 'Resources', 'Resources') : '',
    props.resourceTemplates.length > 0 ? localize(language, 'Templates', 'Templates') : '',
    hasCapability('prompts') || props.prompts.length > 0 ? 'Prompts' : '',
    hasCapability('completions') ? localize(language, 'Completion', 'Completion') : ''
  ].filter(Boolean);
  if (labels.length === 0) {
    return null;
  }
  return (
    <div className="ghost-pill-group wrap mcp-capability-badges" aria-label={localize(language, 'MCP 能力', 'MCP capabilities')}>
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

export function PluginListCard(props: { plugin: McpPlugin; selected: boolean; onClick: () => void }): JSX.Element {
  const language = useUiLanguage();
  return (
    <button className={`plugin-list-card ${props.selected ? 'selected' : ''}`} onClick={props.onClick}>
      <div>
        <strong>{props.plugin.name}</strong>
        <div className="helper-copy">{props.plugin.baseUrl}</div>
      </div>
      <span className={`plugin-status ${props.plugin.enabled ? 'running' : 'stopped'}`}>
        {props.plugin.enabled ? localize(language, '启用', 'Enabled') : localize(language, '禁用', 'Disabled')}
      </span>
    </button>
  );
}

export function ServerListRow(props: {
  plugin: McpPlugin;
  selected: boolean;
  checked: boolean;
  disabled?: boolean;
  scopeLabel: string;
  disabledNote?: string;
  connectionStatus?: McpConnectionSnapshot | null;
  capabilitySummary?: string;
  policySummary?: string;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  return (
    <div className={`mcp-server-row ${props.selected ? 'selected' : ''}`} role="listitem">
      <button className="mcp-server-row-main" onClick={props.onSelect}>
        <span className="mcp-server-row-copy">
          <strong>{props.plugin.name}</strong>
          <span>{formatMcpEndpoint(props.plugin) || t('未配置 Endpoint', 'No endpoint configured')}</span>
          {props.capabilitySummary ? <span className="mcp-server-row-detail">{props.capabilitySummary}</span> : null}
          {props.policySummary ? <span className="mcp-server-row-detail">{props.policySummary}</span> : null}
          {props.connectionStatus?.lastError ? <span className="mcp-server-row-error">{props.connectionStatus.lastError}</span> : null}
        </span>
        <span className="mcp-server-row-meta">
          <span className={`mcp-status-dot ${connectionStatusClass(props.connectionStatus)}`} aria-hidden="true" />
          <em>{formatConnectionStatus(language, props.connectionStatus ?? null)}</em>
          <em>{props.scopeLabel}</em>
          {props.disabledNote ? <em>{props.disabledNote}</em> : null}
        </span>
      </button>
      <div className="mcp-server-row-actions">
        {props.onEdit ? (
          <button className="icon-text-button" onClick={props.onEdit} aria-label={t('编辑 Server', 'Edit server')}>
            ⚙
          </button>
        ) : null}
        {props.onDelete ? (
          <button className="icon-text-button danger" onClick={props.onDelete} aria-label={t('删除 Server', 'Delete server')}>
            ×
          </button>
        ) : null}
        <label className="mcp-switch" aria-label={props.checked ? t('停用 Server', 'Disable server') : t('启用 Server', 'Enable server')}>
          <input
            type="checkbox"
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onToggle(event.currentTarget.checked)}
          />
          <span />
        </label>
      </div>
    </div>
  );
}
