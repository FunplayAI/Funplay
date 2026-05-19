import { useEffect, useState, type JSX } from 'react';
import type { WebResearchMetrics, WebSearchQualityReport, WebSearchSettings } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { InfoRow } from '../shared/InfoComponents';

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
  const [message, setMessage] = useState('');

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  async function refreshMetrics(): Promise<void> {
    setIsLoadingMetrics(true);
    try {
      setMetrics(await window.funplay.getWebResearchMetrics());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('读取搜索指标失败。', 'Failed to load search metrics.'));
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
      setMessage(t('Web Search 配置已保存。', 'Web Search settings saved.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('保存 Web Search 配置失败。', 'Failed to save Web Search settings.'));
    } finally {
      setIsSaving(false);
    }
  }

  async function resetMetrics(): Promise<void> {
    setIsLoadingMetrics(true);
    setMessage('');
    try {
      setMetrics(await window.funplay.resetWebResearchMetrics());
      setMessage(t('搜索指标已重置。', 'Search metrics reset.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('重置搜索指标失败。', 'Failed to reset search metrics.'));
    } finally {
      setIsLoadingMetrics(false);
    }
  }

  async function runQualityEval(): Promise<void> {
    setIsRunningEval(true);
    setMessage('');
    try {
      const report = await window.funplay.runWebSearchQualityEval();
      setQualityReport(report);
      setMetrics(await window.funplay.getWebResearchMetrics());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('搜索质量评测失败。', 'Search quality evaluation failed.'));
    } finally {
      setIsRunningEval(false);
    }
  }

  const totalRequests = (metrics?.searchRequests ?? 0) + (metrics?.fetchRequests ?? 0);
  const successRate = totalRequests > 0 && metrics ? Math.round(((totalRequests - metrics.failures) / totalRequests) * 100) : 0;

  return (
    <div className="web-search-settings-page">
      <div className="claude-settings-header">
        <div>
          <strong>Web Search</strong>
          <div className="helper-copy">{t('配置搜索 provider、页面抽取 fallback、引用来源和运行指标。', 'Configure search providers, extraction fallback, citation sources, and runtime metrics.')}</div>
        </div>
        <div className="modal-actions compact">
          <button className="prototype-secondary small" onClick={() => void refreshMetrics()} disabled={isLoadingMetrics}>
            {isLoadingMetrics ? t('刷新中…', 'Refreshing…') : t('刷新指标', 'Refresh Metrics')}
          </button>
          <button className="prototype-primary small" onClick={() => void saveSettings()} disabled={isSaving}>
            {isSaving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </button>
        </div>
      </div>

      <div className="web-search-form-grid">
        <label className="settings-field">
          <span>{t('默认 Provider', 'Default Provider')}</span>
          <select
            value={draft.provider}
            onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value as WebSearchSettings['provider'] }))}
          >
            <option value="auto">{t('自动选择', 'Auto')}</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="brave">Brave Search</option>
            <option value="bing">Bing Web Search</option>
          </select>
        </label>
        <label className="settings-field">
          <span>Brave API Key</span>
          <input
            type="password"
            value={draft.braveApiKey ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, braveApiKey: event.target.value }))}
            placeholder={t('可选，自动选择时优先使用', 'Optional, preferred in auto mode')}
          />
        </label>
        <label className="settings-field">
          <span>Bing API Key</span>
          <input
            type="password"
            value={draft.bingApiKey ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, bingApiKey: event.target.value }))}
            placeholder={t('可选，Brave 未配置时使用', 'Optional, used when Brave is not configured')}
          />
        </label>
        <label className="settings-field">
          <span>{t('缓存 TTL', 'Cache TTL')}</span>
          <select
            value={String(draft.cacheTtlMs)}
            onChange={(event) => setDraft((current) => ({ ...current, cacheTtlMs: Number(event.target.value) }))}
          >
            <option value="0">{t('关闭缓存', 'Disabled')}</option>
            <option value="300000">5 min</option>
            <option value="600000">10 min</option>
            <option value="1800000">30 min</option>
            <option value="3600000">60 min</option>
          </select>
        </label>
      </div>

      <div className="web-search-toggle-row">
        <label>
          <input
            type="checkbox"
            checked={draft.browserFallbackEnabled}
            onChange={(event) => setDraft((current) => ({ ...current, browserFallbackEnabled: event.target.checked }))}
          />
          <span>{t('启用 JS 渲染页面 fallback', 'Enable JS-rendered page fallback')}</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.telemetryEnabled}
            onChange={(event) => setDraft((current) => ({ ...current, telemetryEnabled: event.target.checked }))}
          />
          <span>{t('启用搜索 telemetry', 'Enable search telemetry')}</span>
        </label>
      </div>

      <div className="web-search-metrics-grid">
        <InfoRow label={t('搜索请求', 'Searches')} value={String(metrics?.searchRequests ?? 0)} />
        <InfoRow label={t('抓取请求', 'Fetches')} value={String(metrics?.fetchRequests ?? 0)} />
        <InfoRow label={t('缓存命中', 'Cache Hits')} value={String(metrics?.cacheHits ?? 0)} />
        <InfoRow label={t('成功率', 'Success Rate')} value={totalRequests ? `${successRate}%` : '-'} />
        <InfoRow label={t('浏览器 fallback', 'Browser Fallbacks')} value={String(metrics?.browserFallbacks ?? 0)} />
        <InfoRow label={t('文档抽取', 'Document Extractions')} value={String(metrics?.documentExtractions ?? 0)} />
      </div>

      <div className="web-search-quality-panel">
        <div className="runtime-subheader">
          <strong>{t('搜索质量评测', 'Search Quality Evaluation')}</strong>
          <span>{t('内置评测集会验证官方来源优先、引用数量和 provider 可用性。', 'Built-in cases validate official-source ranking, citation count, and provider availability.')}</span>
        </div>
        <div className="modal-actions compact">
          <button className="prototype-secondary small" onClick={() => void resetMetrics()} disabled={isLoadingMetrics}>
            {t('重置指标', 'Reset Metrics')}
          </button>
          <button className="prototype-primary small" onClick={() => void runQualityEval()} disabled={isRunningEval}>
            {isRunningEval ? t('评测中…', 'Evaluating…') : t('运行评测', 'Run Evaluation')}
          </button>
        </div>
        {qualityReport ? (
          <div className="web-search-quality-report">
            <strong>{t(`通过 ${qualityReport.passedCases}/${qualityReport.totalCases} · 平均 ${qualityReport.averageDurationMs}ms`, `${qualityReport.passedCases}/${qualityReport.totalCases} passed · avg ${qualityReport.averageDurationMs}ms`)}</strong>
            {qualityReport.cases.map((item) => (
              <div key={item.id} className={`web-search-quality-row ${item.ok ? 'ok' : 'failed'}`}>
                <span>{item.query}</span>
                <em>{[item.provider, `${item.citationCount} citations`, item.requiredDomain, item.error].filter(Boolean).join(' · ')}</em>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {metrics?.lastRequest ? (
        <div className="helper-copy">
          {t('最近请求', 'Last request')}: {[metrics.lastRequest.kind, metrics.lastRequest.provider, metrics.lastRequest.extraction, `${metrics.lastRequest.durationMs}ms`, metrics.lastRequest.ok ? 'ok' : 'failed'].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      {message ? <div className="agent-composer-error neutral">{message}</div> : null}
    </div>
  );
}
