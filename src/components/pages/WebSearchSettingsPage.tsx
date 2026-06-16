import { useEffect, useState, type JSX } from 'react';
import { KeyRound, PlayCircle, RefreshCw, RotateCcw, Save } from 'lucide-react';
import type { WebResearchMetrics, WebSearchQualityReport, WebSearchSettings, WebSearchTestResult } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { Badge, Button, MetricTile, SelectField, Surface, SwitchField, TextField, type SelectOption } from '../ui/index';

export function WebSearchSettingsPage(props: {
  settings: WebSearchSettings;
  onUpdateSettings: (settings: Partial<WebSearchSettings>) => Promise<void>;
}): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  const [draft, setDraft] = useState<WebSearchSettings>(props.settings);
  const [metrics, setMetrics] = useState<WebResearchMetrics | null>(null);
  const [qualityReport, setQualityReport] = useState<WebSearchQualityReport | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMetrics, setIsLoadingMetrics] = useState(false);
  const [isRunningEval, setIsRunningEval] = useState(false);
  const [evaluationFailed, setEvaluationFailed] = useState(false);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [testingKeyProvider, setTestingKeyProvider] = useState<'brave' | 'bing' | ''>('');
  const [keyTestResults, setKeyTestResults] = useState<Partial<Record<'brave' | 'bing', WebSearchTestResult>>>({});

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  function setStatus(text: string, tone: 'neutral' | 'success' | 'error'): void {
    setMessage(text);
    setMessageTone(tone);
  }

  async function refreshMetrics(): Promise<void> {
    setIsLoadingMetrics(true);
    try {
      setMetrics(await window.funplay.getWebResearchMetrics());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('读取搜索指标失败。', 'Failed to load search metrics.'), 'error');
    } finally {
      setIsLoadingMetrics(false);
    }
  }

  useEffect(() => {
    void refreshMetrics();
  }, []);

  async function saveSettings(): Promise<void> {
    setIsSaving(true);
    setMessage('');
    try {
      await props.onUpdateSettings({
        provider: draft.provider,
        braveApiKey: draft.braveApiKey ?? '',
        bingApiKey: draft.bingApiKey ?? '',
        cacheTtlMs: draft.cacheTtlMs,
        browserFallbackEnabled: draft.browserFallbackEnabled,
        telemetryEnabled: draft.telemetryEnabled
      });
      setStatus(t('Web Search 配置已保存。', 'Web Search settings saved.'), 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('保存 Web Search 配置失败。', 'Failed to save Web Search settings.'), 'error');
    } finally {
      setIsSaving(false);
    }
  }

  async function testKey(provider: 'brave' | 'bing'): Promise<void> {
    setTestingKeyProvider(provider);
    try {
      const result = await window.funplay.testWebSearchKey(provider, (provider === 'brave' ? draft.braveApiKey : draft.bingApiKey) ?? '');
      setKeyTestResults((current) => ({ ...current, [provider]: result }));
    } catch (error) {
      setKeyTestResults((current) => ({ ...current, [provider]: { provider, status: 'error', message: error instanceof Error ? error.message : t('密钥测试失败。', 'Key test failed.'), testedAt: new Date().toISOString() } }));
    } finally {
      setTestingKeyProvider('');
    }
  }

  async function resetMetrics(): Promise<void> {
    setIsLoadingMetrics(true);
    setMessage('');
    try {
      setMetrics(await window.funplay.resetWebResearchMetrics());
      setStatus(t('搜索指标已重置。', 'Search metrics reset.'), 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('重置搜索指标失败。', 'Failed to reset search metrics.'), 'error');
    } finally {
      setIsLoadingMetrics(false);
    }
  }

  async function runQualityEval(): Promise<void> {
    setIsRunningEval(true);
    setMessage('');
    setEvaluationFailed(false);
    try {
      const report = await window.funplay.runWebSearchQualityEval();
      setQualityReport(report);
      setMetrics(await window.funplay.getWebResearchMetrics());
    } catch (error) {
      setEvaluationFailed(true);
      setStatus(error instanceof Error ? error.message : t('搜索质量评测失败。', 'Search quality evaluation failed.'), 'error');
    } finally {
      setIsRunningEval(false);
    }
  }

  const totalRequests = (metrics?.searchRequests ?? 0) + (metrics?.fetchRequests ?? 0);
  const successRate = totalRequests > 0 && metrics ? Math.round(((totalRequests - metrics.failures) / totalRequests) * 100) : 0;
  const providerOptions: SelectOption[] = [
    { value: 'auto', label: t('自动选择', 'Auto') },
    { value: 'duckduckgo', label: 'DuckDuckGo' },
    { value: 'brave', label: 'Brave Search' },
    { value: 'bing', label: 'Bing Web Search' }
  ];
  const cacheTtlOptions: SelectOption[] = [
    { value: '0', label: t('关闭缓存', 'Disabled') },
    { value: '300000', label: '5 min' },
    { value: '600000', label: '10 min' },
    { value: '1800000', label: '30 min' },
    { value: '3600000', label: '60 min' }
  ];

  return (
    <div className="web-search-settings-page">
      <div className="settings-section-header">
        <div>
          <strong>Web Search</strong>
          <div className="helper-copy">{t('配置搜索 provider、页面抽取 fallback、引用来源和运行指标。', 'Configure search providers, extraction fallback, citation sources, and runtime metrics.')}</div>
        </div>
        <div className="modal-actions compact">
          <Button variant="secondary" size="sm" onClick={() => void refreshMetrics()} disabled={isLoadingMetrics} leadingIcon={<RefreshCw size={14} aria-hidden="true" />}>
            {isLoadingMetrics ? t('刷新中…', 'Refreshing…') : t('刷新指标', 'Refresh Metrics')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void saveSettings()} disabled={isSaving} leadingIcon={<Save size={14} aria-hidden="true" />}>
            {isSaving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </Button>
        </div>
      </div>

      <div className="web-search-form-grid">
        <SelectField
          label={t('默认 Provider', 'Default Provider')}
          value={draft.provider}
          options={providerOptions}
          onValueChange={(provider) => setDraft((current) => ({ ...current, provider: provider as WebSearchSettings['provider'] }))}
        />
        <div className="web-search-key-field">
          <TextField
            label={t('Brave API 密钥', 'Brave API Key')}
            type="password"
            value={draft.braveApiKey ?? ''}
            onValueChange={(braveApiKey) => setDraft((current) => ({ ...current, braveApiKey }))}
            placeholder={t('可选，自动选择时优先使用', 'Optional, preferred in auto mode')}
            autoComplete="off"
          />
          <div className="web-search-key-test-row">
            <Button variant="secondary" size="compact" onClick={() => void testKey('brave')} disabled={testingKeyProvider === 'brave'} leadingIcon={<KeyRound size={13} aria-hidden="true" />}>
              {testingKeyProvider === 'brave' ? t('测试中…', 'Testing…') : t('测试密钥', 'Test Key')}
            </Button>
            {keyTestResults.brave ? <span className={`web-search-key-test-result ${keyTestResults.brave.status}`}>{keyTestResults.brave.message}</span> : null}
          </div>
        </div>
        <div className="web-search-key-field">
          <TextField
            label={t('Bing API 密钥', 'Bing API Key')}
            type="password"
            value={draft.bingApiKey ?? ''}
            onValueChange={(bingApiKey) => setDraft((current) => ({ ...current, bingApiKey }))}
            placeholder={t('可选，Brave 未配置时使用', 'Optional, used when Brave is not configured')}
            autoComplete="off"
          />
          <div className="web-search-key-test-row">
            <Button variant="secondary" size="compact" onClick={() => void testKey('bing')} disabled={testingKeyProvider === 'bing'} leadingIcon={<KeyRound size={13} aria-hidden="true" />}>
              {testingKeyProvider === 'bing' ? t('测试中…', 'Testing…') : t('测试密钥', 'Test Key')}
            </Button>
            {keyTestResults.bing ? <span className={`web-search-key-test-result ${keyTestResults.bing.status}`}>{keyTestResults.bing.message}</span> : null}
          </div>
        </div>
        <SelectField
          label={t('缓存 TTL', 'Cache TTL')}
          value={String(draft.cacheTtlMs)}
          options={cacheTtlOptions}
          onValueChange={(cacheTtlMs) => setDraft((current) => ({ ...current, cacheTtlMs: Number(cacheTtlMs) }))}
        />
      </div>

      <div className="web-search-toggle-row">
        <SwitchField
          checked={draft.browserFallbackEnabled}
          onCheckedChange={(browserFallbackEnabled) => setDraft((current) => ({ ...current, browserFallbackEnabled }))}
          label={t('启用 JS 渲染页面 fallback', 'Enable JS-rendered page fallback')}
          description={t('用于需要浏览器执行脚本后才能抽取正文的网页。', 'Use a browser extractor when pages need client-side rendering.')}
        />
        <SwitchField
          checked={draft.telemetryEnabled}
          onCheckedChange={(telemetryEnabled) => setDraft((current) => ({ ...current, telemetryEnabled }))}
          label={t('启用搜索 telemetry', 'Enable search telemetry')}
          description={t('记录搜索、抓取、缓存和 fallback 指标。', 'Track search, fetch, cache, and fallback metrics.')}
        />
      </div>

      <div className="web-search-metrics-grid">
        <MetricTile label={t('搜索请求', 'Searches')} value={String(metrics?.searchRequests ?? 0)} />
        <MetricTile label={t('抓取请求', 'Fetches')} value={String(metrics?.fetchRequests ?? 0)} />
        <MetricTile label={t('缓存命中', 'Cache Hits')} value={String(metrics?.cacheHits ?? 0)} />
        <MetricTile label={t('成功率', 'Success Rate')} value={totalRequests ? `${successRate}%` : '-'} tone={successRate >= 90 ? 'success' : successRate > 0 ? 'warning' : 'neutral'} />
        <MetricTile label={t('浏览器 fallback', 'Browser Fallbacks')} value={String(metrics?.browserFallbacks ?? 0)} />
        <MetricTile label={t('文档抽取', 'Document Extractions')} value={String(metrics?.documentExtractions ?? 0)} />
      </div>

      <Surface className="web-search-quality-panel" density="compact">
        <div className="runtime-subheader">
          <strong>{t('搜索质量评测', 'Search Quality Evaluation')}</strong>
          <span>{t('内置评测集会验证官方来源优先、引用数量和 provider 可用性。', 'Built-in cases validate official-source ranking, citation count, and provider availability.')}</span>
        </div>
        <div className="modal-actions compact">
          <Button variant="secondary" size="sm" onClick={() => void resetMetrics()} disabled={isLoadingMetrics} leadingIcon={<RotateCcw size={14} aria-hidden="true" />}>
            {t('重置指标', 'Reset Metrics')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void runQualityEval()} disabled={isRunningEval} leadingIcon={<PlayCircle size={14} aria-hidden="true" />}>
            {isRunningEval ? t('评测中…', 'Evaluating…') : t('运行评测', 'Run Evaluation')}
          </Button>
        </div>
        {evaluationFailed ? (
          <div className="warning-banner error web-search-eval-failed">
            <span>{t('上次评测失败，未能生成质量报告。', 'The last evaluation failed and no quality report was produced.')}</span>
            <Button variant="secondary" size="compact" onClick={() => void runQualityEval()} disabled={isRunningEval} leadingIcon={<RotateCcw size={13} aria-hidden="true" />}>
              {t('重试', 'Retry')}
            </Button>
          </div>
        ) : null}
        {qualityReport ? (
          <div className="web-search-quality-report">
            <Badge tone={qualityReport.passedCases === qualityReport.totalCases ? 'success' : 'warning'}>
              {t(`通过 ${qualityReport.passedCases}/${qualityReport.totalCases} · 平均 ${qualityReport.averageDurationMs}ms`, `${qualityReport.passedCases}/${qualityReport.totalCases} passed · avg ${qualityReport.averageDurationMs}ms`)}
            </Badge>
            {qualityReport.cases.map((item) => (
              <div key={item.id} className={`web-search-quality-row ${item.ok ? 'ok' : 'failed'}`}>
                <span>{item.query}</span>
                <em>{[item.provider, `${item.citationCount} citations`, item.requiredDomain, item.error].filter(Boolean).join(' · ')}</em>
              </div>
            ))}
          </div>
        ) : null}
      </Surface>

      {metrics?.lastRequest ? (
        <div className="helper-copy">
          {t('最近请求', 'Last request')}: {[metrics.lastRequest.kind, metrics.lastRequest.provider, metrics.lastRequest.extraction, `${metrics.lastRequest.durationMs}ms`, metrics.lastRequest.ok ? 'ok' : 'failed'].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      {message ? <div className={`web-search-status-banner ${messageTone}`}>{message}</div> : null}
    </div>
  );
}
