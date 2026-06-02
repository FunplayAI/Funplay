import type { JSX } from 'react';
import type { Project } from '../../../../shared/types';
import { localize, useUiLanguage, type UiLanguage } from '../../../i18n';
import { formatAbsoluteTime } from '../../../lib/app-helpers';
import { Card, InfoRow } from '../../shared/InfoComponents';
import { Button } from '../../ui/index';
import {
  formatNumber,
  formatResumeStrategy,
  formatRunKind,
  formatRuntimeRunStatus,
  type ProjectAgentRunSummary
} from './metrics';

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
        <InfoRow
          label={t('最近更新', 'Last Updated')}
          value={props.runs.latestUpdatedAt ? formatAbsoluteTime(props.runs.latestUpdatedAt) : t('暂无', 'None')}
        />
        <InfoRow
          label={t('完成情况', 'Completion')}
          value={t(
            `完成 ${props.runs.completedRunCount} · 中断 ${props.runs.interruptedRunCount}`,
            `${props.runs.completedRunCount} completed · ${props.runs.interruptedRunCount} interrupted`
          )}
        />
        <InfoRow
          label={t('恢复入口', 'Recovery')}
          value={
            props.runs.resumableRunCount > 0
              ? t(`${props.runs.resumableRunCount} 次运行可恢复`, `${props.runs.resumableRunCount} runs can resume`)
              : t('暂无可恢复运行', 'No resumable runs')
          }
        />
      </Card>

      <Card title={t('验证与质量', 'Verification And Quality')}>
        <InfoRow
          label={t('有验证报告', 'Runs With Verification')}
          value={formatNumber(props.runs.verificationRunCount, language)}
        />
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
                  <strong>
                    {formatRunKind(run.kind, language)} · {run.sessionTitle || t('未命名会话', 'Untitled session')}
                  </strong>
                  <span>{run.inputPreview || run.lastError || t('无摘要', 'No summary')}</span>
                  <em>
                    {[
                      formatAbsoluteTime(run.updatedAt),
                      formatRuntimeRunStatus(run.status, language),
                      run.resumeStrategy ? formatResumeStrategy(run.resumeStrategy, language) : '',
                      run.providerLabel && run.model
                        ? `${run.providerLabel} / ${run.model}`
                        : run.providerLabel || run.model || '',
                      typeof run.totalTokens === 'number'
                        ? t(
                            `${formatNumber(run.totalTokens, language)} tokens`,
                            `${formatNumber(run.totalTokens, language)} tokens`
                          )
                        : '',
                      run.verificationCheckCount > 0
                        ? t(`${run.verificationCheckCount} 个验证`, `${run.verificationCheckCount} checks`)
                        : '',
                      run.failedToolResultCount > 0
                        ? t(`${run.failedToolResultCount} 个工具失败`, `${run.failedToolResultCount} tool failures`)
                        : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </em>
                </div>
                {run.canResume ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => props.onResumeRun?.(run.id)}
                    disabled={!props.onResumeRun}
                  >
                    {t('恢复', 'Resume')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="helper-copy">
            {props.project
              ? t('这个项目还没有 Agent 运行记录。', 'This project has no Agent runs yet.')
              : t('未选择项目。', 'No project selected.')}
          </div>
        )}
      </Card>
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
