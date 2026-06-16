import { useEffect, useState, type JSX } from 'react';
import { Activity, BadgeCheck, ChevronLeft, Plus, RefreshCw, Save, Settings2, Stethoscope, TestTube2, Trash2 } from 'lucide-react';
import type { AiProvider, AiProviderInput, AiTestResult, RuntimeDoctorResult, RuntimeRepairAction } from '../../../shared/types';
import { resolveProviderTokenLimits } from '../../../shared/provider-catalog';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { ModalShell } from '../settings-modals';
import { buildProviderRepairGuidance } from './provider-repair-guidance';
import { Badge, Button, ConfigDetailActionBar, ConfigListPanel, TextAreaField, ToggleSwitch, type ConfigDetailAction, type ConfigListItem } from '../ui/index';

export function ProviderSettingsPage(props: {
  providers: AiProvider[];
  providerTests: Record<string, AiTestResult>;
  testingProviderIds?: Set<string>;
  selectedProjectId?: string;
  onAddProvider: () => void;
  onEditProvider: (provider: AiProvider) => void;
  onDeleteProvider: (providerId: string) => void;
  onTestProvider: (providerId: string) => void;
  onSetDefaultProvider: (providerId: string) => void;
  onToggleProvider: (provider: AiProvider, enabled: boolean) => void;
  embedded?: boolean;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const defaultProvider = props.providers.find((provider) => provider.isDefault) ?? null;

  function handleToggleProvider(provider: AiProvider, enabled: boolean): void {
    if (!enabled && provider.isDefault) {
      const enabledOthers = props.providers.filter((item) => item.id !== provider.id && item.enabled);
      const message = enabledOthers.length > 0
        ? t('这是默认 Provider，停用后系统会改用其他启用的 Provider 作为默认。确定停用?', 'This is the default provider. Disabling it will reassign the default to another enabled provider. Disable anyway?')
        : t('这是默认 Provider，且没有其他启用的 Provider。停用后将没有可用的默认 Provider。确定停用?', 'This is the default provider and no other provider is enabled. Disabling it leaves no usable default. Disable anyway?');
      if (!window.confirm(message)) {
        return;
      }
    }
    props.onToggleProvider(provider, enabled);
  }
  const [doctorProvider, setDoctorProvider] = useState<AiProvider | null>(null);
  const [doctorResult, setDoctorResult] = useState<RuntimeDoctorResult | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState('');
  const [doctorExport, setDoctorExport] = useState('');
  const [detailProviderId, setDetailProviderId] = useState('');
  const detailProvider = props.providers.find((provider) => provider.id === detailProviderId) ?? null;
  const providerItems: ConfigListItem[] = props.providers.map((provider) => ({
    id: provider.id,
    title: provider.name,
    subtitle: provider.isDefault ? t('默认 Provider', 'Default provider') : formatProviderProtocol(provider, language),
    description: [provider.model, provider.baseUrl].filter(Boolean).join(' · '),
    statusLabel: provider.enabled ? t('启用', 'Enabled') : t('停用', 'Disabled'),
    statusTone: provider.enabled ? 'success' : 'neutral',
    enabled: provider.enabled,
    meta: [
      provider.protocol === 'openai-compatible' ? formatProviderApiMode(provider, language) : provider.protocol,
      provider.hasStoredApiKey ? t('密钥已保存', 'Key saved') : t('缺少密钥', 'Missing key')
    ],
    searchText: [provider.protocol, provider.apiMode, provider.model, provider.baseUrl, provider.notes].filter(Boolean).join(' ')
  }));
  useEffect(() => {
    if (detailProviderId && !props.providers.some((provider) => provider.id === detailProviderId)) {
      setDetailProviderId('');
    }
  }, [detailProviderId, props.providers]);

  function openProviderDetail(provider: AiProvider): void {
    setDetailProviderId(provider.id);
  }

  function closeProviderDetail(): void {
    setDetailProviderId('');
  }

  async function runDoctor(provider: AiProvider, live = false): Promise<void> {
    setDoctorProvider(provider);
    setDoctorLoading(true);
    setDoctorError('');
    setDoctorExport('');
    try {
      const result = await window.funplay.runProviderDoctor(provider.id, {
        projectId: props.selectedProjectId,
        live
      });
      setDoctorResult(result);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('诊断失败。', 'Doctor failed.'));
    } finally {
      setDoctorLoading(false);
    }
  }

  async function repairDoctor(action: RuntimeRepairAction): Promise<void> {
    if (!doctorProvider) {
      return;
    }
    setDoctorLoading(true);
    setDoctorError('');
    try {
      await window.funplay.repairProviderDiagnostic({
        actionId: action.id,
        providerId: action.params?.providerId ?? doctorProvider.id,
        projectId: action.params?.projectId ?? props.selectedProjectId,
        sessionId: action.params?.sessionId,
        authStyle: action.params?.authStyle as Parameters<typeof window.funplay.repairProviderDiagnostic>[0]['authStyle']
      });
      await runDoctor(doctorProvider, false);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('修复失败。', 'Repair failed.'));
      setDoctorLoading(false);
    }
  }

  async function exportDoctor(): Promise<void> {
    if (!doctorProvider) {
      return;
    }
    setDoctorLoading(true);
    setDoctorError('');
    try {
      const json = await window.funplay.exportRuntimeDiagnostics({
        providerId: doctorProvider.id,
        projectId: props.selectedProjectId
      });
      setDoctorExport(json);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('导出失败。', 'Export failed.'));
    } finally {
      setDoctorLoading(false);
    }
  }

  return (
    <div className={`provider-settings-page ${props.embedded ? 'embedded' : ''}`}>
      <div className={`settings-header ${props.embedded ? 'embedded' : ''}`}>
        <div>
          <h2>AI Provider</h2>
          <p>{t('集中配置模型服务、默认模型与测试连接。这些设置会持久化保存，并应用到所有项目。', 'Configure model services, default models, and connection tests here. These settings are persisted and shared across all projects.')}</p>
          <div className="provider-settings-meta">
            <span>{t(`已配置 ${props.providers.length} 个 Provider`, `${props.providers.length} providers configured`)}</span>
            <span>{defaultProvider ? t(`默认：${defaultProvider.name}`, `Default: ${defaultProvider.name}`) : t('未设置默认 Provider', 'No default provider')}</span>
          </div>
        </div>
        <Button
          variant="primary"
          className="provider-add-button"
          onClick={props.onAddProvider}
          leadingIcon={<Plus size={15} aria-hidden="true" />}
        >
          {t('添加 Provider', 'Add Provider')}
        </Button>
      </div>
      {detailProvider ? (
        <div className="settings-detail-panel provider-settings-detail-route">
          <ProviderDetail
            provider={detailProvider}
            providerTest={props.providerTests[detailProvider.id]}
            isTesting={props.testingProviderIds?.has(detailProvider.id) ?? false}
            language={language}
            onBack={closeProviderDetail}
            onEdit={() => props.onEditProvider(detailProvider)}
            onDelete={() => props.onDeleteProvider(detailProvider.id)}
            onTest={() => props.onTestProvider(detailProvider.id)}
            onDoctor={() => void runDoctor(detailProvider)}
            onSetDefault={() => props.onSetDefaultProvider(detailProvider.id)}
          />
        </div>
      ) : (
        <ConfigListPanel
          className="provider-settings-list-panel"
          items={providerItems}
          emptyTitle={t('暂无 Provider', 'No providers yet')}
          emptyDescription={t('添加一个模型服务后，就可以在所有项目里使用。', 'Add a model service to use it across projects.')}
          onOpenItem={(providerId) => {
            const provider = props.providers.find((item) => item.id === providerId);
            if (provider) openProviderDetail(provider);
          }}
          renderItemActions={(item) => {
            const provider = props.providers.find((candidate) => candidate.id === item.id);
            return provider ? (
              <ToggleSwitch
                label={provider.enabled ? t('停用 Provider', 'Disable provider') : t('启用 Provider', 'Enable provider')}
                checked={provider.enabled}
                onCheckedChange={(enabled) => handleToggleProvider(provider, enabled)}
              />
            ) : null;
          }}
        />
      )}
      {doctorProvider ? (
        <RuntimeDoctorDialog
          provider={doctorProvider}
          result={doctorResult}
          loading={doctorLoading}
          error={doctorError}
          exportedJson={doctorExport}
          onRunDry={() => void runDoctor(doctorProvider, false)}
          onRunLive={() => void runDoctor(doctorProvider, true)}
          onRepair={(action) => void repairDoctor(action)}
          onExport={() => void exportDoctor()}
          onClose={() => {
            setDoctorProvider(null);
            setDoctorResult(null);
            setDoctorError('');
            setDoctorExport('');
          }}
        />
      ) : null}
    </div>
  );
}

function providerToInput(provider: AiProvider, overrides: Partial<AiProviderInput> = {}): AiProviderInput {
  return {
    name: provider.name,
    protocol: provider.protocol,
    apiMode: provider.protocol === 'openai-compatible' ? provider.apiMode ?? 'chat' : undefined,
    authStyle: provider.authStyle,
    baseUrl: provider.baseUrl,
    apiKey: '',
    model: provider.model,
    upstreamModel: provider.upstreamModel,
    headers: provider.headers,
    envOverrides: provider.envOverrides,
    availableModels: provider.availableModels,
    providerMeta: provider.providerMeta,
    contextWindowTokens: provider.contextWindowTokens,
    maxOutputTokens: provider.maxOutputTokens,
    requestTimeoutMs: provider.requestTimeoutMs,
    chunkTimeoutMs: provider.chunkTimeoutMs,
    enabled: provider.enabled,
    notes: provider.notes,
    ...overrides
  };
}

export function buildProviderToggleInput(provider: AiProvider, enabled: boolean): AiProviderInput {
  return providerToInput(provider, { enabled });
}

function ProviderDetail(props: {
  provider: AiProvider;
  providerTest?: AiTestResult;
  isTesting: boolean;
  language: UiLanguage;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onDoctor: () => void;
  onSetDefault: () => void;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  const tokenLimits = resolveProviderTokenLimits(props.provider);
  const primaryActions: ConfigDetailAction[] = [
    { id: 'edit', label: t('编辑', 'Edit'), icon: <Settings2 size={14} aria-hidden="true" />, onAction: props.onEdit },
    {
      id: 'test',
      label: props.isTesting ? t('测试中…', 'Testing…') : t('测试', 'Test'),
      icon: <TestTube2 size={14} aria-hidden="true" />,
      disabled: props.isTesting,
      onAction: props.onTest
    },
    { id: 'doctor', label: t('诊断', 'Doctor'), icon: <Stethoscope size={14} aria-hidden="true" />, onAction: props.onDoctor }
  ];
  const handleDelete = async (): Promise<void> => {
    let usageNote = '';
    try {
      const usage = await window.funplay.countProviderUsage(props.provider.id);
      if (usage.projects.length > 0) {
        const preview = usage.projects.slice(0, 3).join('、');
        const suffix = usage.projects.length > 3 ? t('等', ', …') : '';
        usageNote = t(
          `\n此 Provider 正被 ${usage.projects.length} 个项目使用(${preview}${suffix}),删除会影响它们。`,
          `\nThis provider is used by ${usage.projects.length} project(s) (${preview}${suffix}); deleting it will affect them.`
        );
      }
    } catch {
      usageNote = t('\n(无法确认占用情况,该 Provider 可能正在被项目使用。)', '\n(Could not verify usage; this provider may be in use by projects.)');
    }
    const defaultNote = props.provider.isDefault
      ? t('(删除后系统会自动改用其他启用的 Provider 作为默认)', ' (another enabled provider will become the default)')
      : '';
    const message = t(`删除 Provider「${props.provider.name}」?此操作不可撤销,已保存的 API Key 会一并移除。`, `Delete provider "${props.provider.name}"? This cannot be undone — the saved API key will be removed.`);
    if (window.confirm(message + defaultNote + usageNote)) props.onDelete();
  };
  const secondaryActions: ConfigDetailAction[] = [
    ...(!props.provider.isDefault
      ? [{ id: 'default', label: t('设默认', 'Set Default'), icon: <BadgeCheck size={14} aria-hidden="true" />, onAction: props.onSetDefault }]
      : []),
    {
      id: 'delete',
      label: t('删除', 'Delete'),
      tone: 'danger',
      icon: <Trash2 size={14} aria-hidden="true" />,
      onAction: () => {
        void handleDelete();
      }
    }
  ];

  return (
    <div className="provider-channel-detail">
      <div className="settings-header compact">
        <div>
          <Button variant="ghost" size="sm" className="settings-detail-back-button" onClick={props.onBack} leadingIcon={<ChevronLeft size={14} aria-hidden="true" />}>
            {t('返回', 'Back')}
          </Button>
          <h2>{props.provider.name}</h2>
          <p>{props.provider.notes || `${formatProviderProtocol(props.provider, props.language)} · ${props.provider.model || t('未配置模型', 'No model configured')}`}</p>
        </div>
        <ConfigDetailActionBar actions={primaryActions} />
      </div>

      <div className="provider-channel-detail-grid">
        <div className="provider-detail-card">
          <span>{t('默认模型', 'Default Model')}</span>
          <strong>{props.provider.model || t('未配置', 'Not Configured')}</strong>
        </div>
        <div className="provider-detail-card">
          <span>Base URL</span>
          <strong>{props.provider.baseUrl || t('未配置', 'Not Configured')}</strong>
        </div>
        <div className="provider-detail-card">
          <span>API Key</span>
          <strong>{props.provider.hasStoredApiKey ? t('已保存', 'Saved') : t('未配置', 'Missing')}</strong>
        </div>
        <div className="provider-detail-card">
          <span>{t('上下文窗口', 'Context Window')}</span>
          <strong>{formatEffectiveTokenLimit(tokenLimits.effectiveContextWindowTokens, tokenLimits.configuredContextWindowTokens, props.language)}</strong>
        </div>
        <div className="provider-detail-card">
          <span>{t('输出上限', 'Max Output')}</span>
          <strong>{formatEffectiveTokenLimit(tokenLimits.effectiveMaxOutputTokens, tokenLimits.configuredMaxOutputTokens, props.language)}</strong>
        </div>
      </div>

      <div className="tag-row provider-channel-tags">
        <Badge>{formatProviderProtocol(props.provider, props.language)}</Badge>
        {props.provider.protocol === 'openai-compatible' ? <Badge>{formatProviderApiMode(props.provider, props.language)}</Badge> : null}
        <Badge>{props.provider.authStyle ?? 'api_key'}</Badge>
        <Badge tone={props.provider.enabled ? 'success' : 'neutral'}>{props.provider.enabled ? t('启用', 'Enabled') : t('停用', 'Disabled')}</Badge>
        {props.provider.isDefault ? <Badge tone="brand">{t('默认', 'Default')}</Badge> : null}
      </div>

      {tokenLimits.modelId ? (
        <div className="helper-copy">
          {t(`模型预设：${tokenLimits.displayName || tokenLimits.modelId}`, `Model preset: ${tokenLimits.displayName || tokenLimits.modelId}`)}
        </div>
      ) : null}
      {props.providerTest ? (
        <div className="tag-row provider-test-result" role="status">
          <Badge tone={props.providerTest.status === 'error' ? 'danger' : 'success'}>
            {props.providerTest.status === 'error' ? t('连接失败', 'Failed') : t('连接成功', 'Success')}
          </Badge>
          <span className="helper-copy">{props.providerTest.message}</span>
        </div>
      ) : null}

      <div className="provider-card-actions">
        <ConfigDetailActionBar actions={secondaryActions} />
      </div>
    </div>
  );
}

function formatProviderProtocol(provider: AiProvider, language: UiLanguage): string {
  const labels: Record<AiProvider['protocol'], string> = {
    'openai-compatible': localize(language, 'OpenAI 兼容', 'OpenAI Compatible'),
    anthropic: 'Anthropic',
    google: 'Google',
    bedrock: 'Bedrock',
    vertex: 'Vertex'
  };
  return labels[provider.protocol];
}

function formatProviderApiMode(provider: AiProvider, language: UiLanguage): string {
  return provider.apiMode === 'responses'
    ? localize(language, 'Responses API', 'Responses API')
    : localize(language, 'Chat Completions', 'Chat Completions');
}

function formatTokenLimit(value: number | undefined, language: UiLanguage): string {
  if (!value) {
    return localize(language, '按预设', 'Preset');
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

function formatEffectiveTokenLimit(value: number | undefined, configuredValue: number | undefined, language: UiLanguage): string {
  if (!value) {
    return localize(language, '未知', 'Unknown');
  }
  const formatted = formatTokenLimit(value, language);
  return configuredValue
    ? localize(language, `${formatted} · 自定义`, `${formatted} · custom`)
    : localize(language, `${formatted} · 预设`, `${formatted} · preset`);
}

export function RuntimeDoctorDialog(props: {
  provider: AiProvider;
  result: RuntimeDoctorResult | null;
  loading: boolean;
  error: string;
  exportedJson: string;
  onRunDry: () => void;
  onRunLive: () => void;
  onRepair: (action: RuntimeRepairAction) => void;
  onExport: () => void;
  onClose: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const severityLabel = (severity: RuntimeDoctorResult['overallSeverity']): string => {
    switch (severity) {
      case 'error':
        return t('错误', 'Error');
      case 'warn':
        return t('警告', 'Warning');
      default:
        return 'OK';
    }
  };
  const repairGuidance = buildProviderRepairGuidance(props.result, props.provider, language);
  return (
    <ModalShell
      title={t('Runtime 诊断', 'Runtime Doctor')}
      subtitle={`${props.provider.name} · ${props.provider.protocol} · ${props.provider.model}`}
      className="runtime-doctor-modal"
      onClose={props.onClose}
    >
      <div className="runtime-doctor-toolbar">
        <Button variant="secondary" size="sm" disabled={props.loading} onClick={props.onRunDry} leadingIcon={<RefreshCw size={14} aria-hidden="true" />}>
          {t('重新诊断', 'Run Doctor')}
        </Button>
        <Button variant="secondary" size="sm" disabled={props.loading} onClick={props.onRunLive} leadingIcon={<Activity size={14} aria-hidden="true" />}>
          Live Probe
        </Button>
        <Button variant="secondary" size="sm" disabled={props.loading || !props.result} onClick={props.onExport} leadingIcon={<Save size={14} aria-hidden="true" />}>
          {t('导出 JSON', 'Export JSON')}
        </Button>
        {props.result ? <Badge tone={props.result.overallSeverity === 'error' ? 'danger' : props.result.overallSeverity === 'warn' ? 'warning' : 'success'}>{severityLabel(props.result.overallSeverity)}</Badge> : null}
      </div>
      {props.loading ? <div className="helper-copy">{t('诊断中…', 'Running diagnostics...')}</div> : null}
      {props.error ? <div className="error-text">{props.error}</div> : null}
      {repairGuidance.length > 0 ? (
        <div className="runtime-doctor-guidance runtime-doctor-status-board">
          <div className="runtime-doctor-status-head">
            <strong>{t('建议修复顺序', 'Suggested Repair Order')}</strong>
            <span>{t(`${repairGuidance.length} 项需要处理`, `${repairGuidance.length} item${repairGuidance.length > 1 ? 's' : ''} to review`)}</span>
          </div>
          <div className="runtime-doctor-guidance-list runtime-doctor-status-grid">
            {repairGuidance.map((item) => (
              <section key={item.key} className={`runtime-doctor-guidance-item runtime-doctor-status-card ${item.severity}`} data-status-card={item.key}>
                <div className="runtime-doctor-status-card-top">
                  <Badge tone={item.severity === 'error' ? 'danger' : item.severity === 'warn' ? 'warning' : 'neutral'}>{severityLabel(item.severity)}</Badge>
                  <strong>{item.title}</strong>
                </div>
                <div className="runtime-doctor-status-card-body">
                  <span>{item.detail}</span>
                  <em>{item.action}</em>
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : null}
      {props.result ? (
        <div className="runtime-doctor-probes">
          {props.result.probes.map((probe) => (
            <section key={probe.id} className={`runtime-doctor-probe ${probe.severity}`}>
              <div className="runtime-doctor-probe-header">
                <strong>{probe.title}</strong>
                <span>{severityLabel(probe.severity)} · {probe.durationMs}ms</span>
              </div>
              {probe.findings.map((finding) => (
                <div key={`${probe.id}-${finding.code}-${finding.summary}`} className={`runtime-doctor-finding ${finding.severity}`}>
                  <div>
                    <strong>{finding.code}</strong>
                    <span>{finding.summary}</span>
                  </div>
                  {finding.detail ? <pre>{finding.detail}</pre> : null}
                  {finding.suggestedAction ? <em>{finding.suggestedAction}</em> : null}
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : null}
      {props.result?.repairs.length ? (
        <div className="runtime-doctor-repairs">
          <strong>{t('可执行修复', 'Repair Actions')}</strong>
          <div className="ghost-pill-group wrap">
            {props.result.repairs.map((action) => (
              <Button key={action.id} variant="secondary" size="sm" disabled={props.loading} onClick={() => props.onRepair(action)} title={action.description}>
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {props.exportedJson ? (
        <TextAreaField
          className="runtime-doctor-export-field"
          textareaClassName="runtime-doctor-export"
          label={t('导出的诊断 JSON', 'Exported diagnostic JSON')}
          readOnly
          value={props.exportedJson}
        />
      ) : null}
    </ModalShell>
  );
}
