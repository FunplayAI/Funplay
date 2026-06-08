import type { JSX } from 'react';
import type { Project } from '../../../../shared/types';
import { localize, useUiLanguage } from '../../../i18n';
import {
  buildRuntimeSummary,
  formatAbsoluteTime,
  formatDimensionLabel,
  formatPlatformLabel,
  formatProjectStatus
} from '../../../lib/app-helpers';
import { Card, InfoRow } from '../../shared/InfoComponents';

export function EngineProjectSettings(props: { project: Project | null }): JSX.Element {
  const language = useUiLanguage();
  const t = (zh: string, en: string): string => localize(language, zh, en);
  return (
    <div className="engine-settings-grid">
      <Card title={t('项目身份', 'Project Identity')}>
        <InfoRow label={t('平台', 'Platform')} value={formatPlatformLabel(props.project?.engine?.platform || 'web')} />
        <InfoRow label={t('项目名称', 'Project Name')} value={props.project?.name || t('未创建', 'Not Created')} />
        <InfoRow
          label={t('项目路径', 'Project Path')}
          value={props.project?.engine?.projectPath || t('未记录', 'Not Recorded')}
        />
        <InfoRow
          label={t('Unity 版本', 'Unity Version')}
          value={props.project?.engine?.unityEditorVersion || t('未记录', 'Not Recorded')}
        />
      </Card>
      <Card title={t('运行状态', 'Runtime Status')}>
        <InfoRow
          label={t('项目类型', 'Project Type')}
          value={formatDimensionLabel(
            props.project?.engine?.dimension || props.project?.runtimeState?.detectedDimension || 'unknown'
          )}
        />
        <InfoRow
          label={t('项目状态', 'Project Status')}
          value={props.project ? formatProjectStatus(props.project.status) : t('未创建', 'Not Created')}
        />
        <InfoRow
          label="Bridge / MCP"
          value={props.project ? buildRuntimeSummary(props.project.runtimeState, props.project.engine?.platform) : t('未检测', 'Not Checked')}
        />
        <InfoRow
          label={t('最近检测', 'Last Check')}
          value={
            props.project?.runtimeState?.checkedAt
              ? formatAbsoluteTime(props.project.runtimeState.checkedAt)
              : t('未检测', 'Not Checked')
          }
        />
      </Card>
    </div>
  );
}
