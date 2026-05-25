import { useEffect, useState, type JSX } from 'react';
import { Activity, BadgeCheck, ChevronLeft, Plus, RefreshCw, Save, Settings2, Stethoscope, TestTube2, Trash2 } from 'lucide-react';
import type { AiProvider, AiProviderInput, AiTestResult, RuntimeDoctorFinding, RuntimeDoctorResult, RuntimeRepairAction } from '../../../shared/types';
import { resolveProviderTokenLimits } from '../../../shared/provider-catalog';
import { localize, useUiLanguage, type UiLanguage } from '../../i18n';
import { ModalShell } from '../settings-modals';
import { Badge, Button, ConfigDetailActionBar, ConfigListPanel, TextAreaField, ToggleSwitch, type ConfigDetailAction, type ConfigListItem } from '../ui/index';

export function ProviderSettingsPage(props: {
  providers: AiProvider[];
  providerTests: Record<string, AiTestResult>;
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
                onCheckedChange={(enabled) => props.onToggleProvider(provider, enabled)}
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
    claudeCodeCompatible: provider.claudeCodeCompatible,
    claudeRoleModels: provider.claudeRoleModels,
    availableModels: provider.availableModels,
    sdkProxyOnly: provider.sdkProxyOnly,
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
    { id: 'test', label: t('测试', 'Test'), icon: <TestTube2 size={14} aria-hidden="true" />, onAction: props.onTest },
    { id: 'doctor', label: t('诊断', 'Doctor'), icon: <Stethoscope size={14} aria-hidden="true" />, onAction: props.onDoctor }
  ];
  const secondaryActions: ConfigDetailAction[] = [
    ...(!props.provider.isDefault
      ? [{ id: 'default', label: t('设默认', 'Set Default'), icon: <BadgeCheck size={14} aria-hidden="true" />, onAction: props.onSetDefault }]
      : []),
    { id: 'delete', label: t('删除', 'Delete'), tone: 'danger', icon: <Trash2 size={14} aria-hidden="true" />, onAction: props.onDelete }
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
      {props.providerTest ? <div className="helper-copy">{props.providerTest.message}</div> : null}

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

interface ProviderRepairGuidance {
  key: string;
  severity: RuntimeDoctorFinding['severity'];
  title: string;
  detail: string;
  action: string;
}

function buildProviderRepairGuidance(result: RuntimeDoctorResult | null, provider: AiProvider, language: UiLanguage): ProviderRepairGuidance[] {
  if (!result) {
    return [];
  }

  const items = new Map<string, ProviderRepairGuidance>();
  for (const finding of result.probes.flatMap((probe) => probe.findings)) {
    if (finding.severity === 'ok') {
      continue;
    }
    const guidance = mapProviderFindingToGuidance(finding, provider, language);
    const existing = items.get(guidance.key);
    if (!existing || severityRank(guidance.severity) > severityRank(existing.severity)) {
      items.set(guidance.key, guidance);
    }
  }

  return [...items.values()]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, 4);
}

function severityRank(severity: RuntimeDoctorFinding['severity']): number {
  if (severity === 'error') return 2;
  if (severity === 'warn') return 1;
  return 0;
}

function mapProviderFindingToGuidance(finding: RuntimeDoctorFinding, provider: AiProvider, language: UiLanguage): ProviderRepairGuidance {
  const code = finding.code;
  if ([
    'provider_auth_missing',
    'native_auth_failed',
    'native_auth_style_mismatch',
    'provider_custom_header_missing',
    'auth_ambiguous_env'
  ].includes(code)) {
    return {
      key: 'auth',
      severity: finding.severity,
      title: localize(language, '补全认证配置', 'Fix Authentication'),
      detail: localize(language, `${provider.name} 需要有效 API Key、Token 或正确的认证方式。`, `${provider.name} needs a valid API key, token, or matching auth style.`),
      action: finding.suggestedAction ?? localize(language, '在 Provider 设置中保存密钥后重新诊断。', 'Save credentials in Provider settings, then run doctor again.')
    };
  }
  if ([
    'native_api_mode_unsupported',
    'native_provider_api_mode_unsupported',
    'native_empty_response'
  ].includes(code)) {
    return {
      key: 'api-mode',
      severity: finding.severity,
      title: localize(language, '切换 API Mode', 'Switch API Mode'),
      detail: localize(language, 'OpenAI 官方优先 Responses；多数国内兼容通道优先 Chat Completions。', 'Official OpenAI usually prefers Responses; most domestic compatible gateways prefer Chat Completions.'),
      action: finding.suggestedAction ?? localize(language, '切换 Chat Completions / Responses 后重试。', 'Switch Chat Completions / Responses, then retry.')
    };
  }
  if (['provider_model_missing', 'native_model_invalid'].includes(code)) {
    return {
      key: 'model',
      severity: finding.severity,
      title: localize(language, '校正模型 ID', 'Fix Model ID'),
      detail: localize(language, `当前模型：${provider.model || '未配置'}`, `Current model: ${provider.model || 'not configured'}`),
      action: finding.suggestedAction ?? localize(language, '填写服务商真实支持的 model 或 upstreamModel。', 'Use a model or upstreamModel actually supported by the provider.')
    };
  }
  if ([
    'provider_base_url_invalid',
    'native_base_url_invalid',
    'network_provider_unreachable',
    'native_network_error'
  ].includes(code)) {
    return {
      key: 'network',
      severity: finding.severity,
      title: localize(language, '检查 Base URL 与网络', 'Check Base URL And Network'),
      detail: localize(language, `当前地址：${provider.baseUrl || '未配置'}`, `Current URL: ${provider.baseUrl || 'not configured'}`),
      action: finding.suggestedAction ?? localize(language, '确认 URL 包含 /v1 等服务商要求路径，并检查代理或服务商状态。', 'Confirm the URL includes required paths such as /v1, then check proxy or provider status.')
    };
  }
  if ([
    'native_tool_schema_invalid',
    'native_malformed_tool_arguments',
    'native_tool_loop_failed'
  ].includes(code)) {
    return {
      key: 'tools',
      severity: finding.severity,
      title: localize(language, '调整工具调用兼容性', 'Adjust Tool-Calling Compatibility'),
      detail: localize(language, '模型或通道没有稳定接受当前工具 schema。', 'The model or gateway is not reliably accepting the current tool schema.'),
      action: finding.suggestedAction ?? localize(language, '优先使用已验证 Provider 预设，或切换工具调用更稳定的模型。', 'Prefer a verified provider preset, or switch to a model with more stable tool calling.')
    };
  }
  if (['native_rate_limited', 'native_overloaded', 'provider_rate_limit_or_overload'].includes(code)) {
    return {
      key: 'capacity',
      severity: finding.severity,
      title: localize(language, '检查额度与限速', 'Check Quota And Rate Limits'),
      detail: localize(language, '服务商返回限速、过载或额度相关信号。', 'The provider returned rate-limit, overload, or quota signals.'),
      action: finding.suggestedAction ?? localize(language, '稍后重试，或检查服务商控制台额度。', 'Retry later, or check quota in the provider console.')
    };
  }
  if (code === 'provider_default_missing') {
    return {
      key: 'default-provider',
      severity: finding.severity,
      title: localize(language, '设置默认 Provider', 'Set Default Provider'),
      detail: localize(language, '当前默认 Provider 不可用或已停用。', 'The current default provider is unavailable or disabled.'),
      action: finding.suggestedAction ?? localize(language, '选择一个启用的 Provider 作为默认。', 'Choose an enabled provider as default.')
    };
  }
  return {
    key: code,
    severity: finding.severity,
    title: finding.summary,
    detail: finding.detail?.split('\n')[0] ?? code,
    action: finding.suggestedAction ?? localize(language, '根据诊断详情修复后重新运行诊断。', 'Fix according to the diagnostic details, then run doctor again.')
  };
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
      title={t('Claude Runtime 诊断', 'Claude Runtime Doctor')}
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
