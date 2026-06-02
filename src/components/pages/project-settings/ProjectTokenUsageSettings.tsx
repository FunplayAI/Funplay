import type { JSX } from 'react';
import type { Project } from '../../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../../i18n';
import { formatAbsoluteTime } from '../../../lib/app-helpers';
import { Card, InfoRow } from '../../shared/InfoComponents';
import { formatNumber, formatTokenCount, type ProjectTokenUsageSummary } from './metrics';

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
        <InfoRow
          label={t('有 Token 数据', 'Runs With Usage')}
          value={formatNumber(props.usage.usageRunCount, language)}
        />
        <InfoRow
          label={t('最近更新', 'Last Updated')}
          value={props.usage.latestUpdatedAt ? formatAbsoluteTime(props.usage.latestUpdatedAt) : t('暂无', 'None')}
        />
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
                    {t(`${group.runs} 次运行 · ${group.turns} 轮调用`, `${group.runs} runs · ${group.turns} turns`)}
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

function TokenMetric(props: { label: string; value: number; language: UiLanguage }): JSX.Element {
  return (
    <div className="project-token-metric">
      <span>{props.label}</span>
      <strong>{formatNumber(props.value, props.language)}</strong>
    </div>
  );
}
