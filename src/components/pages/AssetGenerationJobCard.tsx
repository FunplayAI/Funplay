import { CheckCircle2, Clock3, Loader2, XCircle, type LucideIcon } from 'lucide-react';
import type { JSX } from 'react';
import type { AssetGenerationJob } from '../../../shared/types';
import { localize, type UiLanguage } from '../../i18n';
import { formatGenerationJobStatus, formatGenerationKind } from '../../lib/asset-generation-ui';
import { Button } from '../ui/index';

function jobStatusIcon(job: AssetGenerationJob): LucideIcon {
  if (job.status === 'completed') return CheckCircle2;
  if (job.status === 'failed') return XCircle;
  if (job.status === 'running' || job.status === 'queued') return Loader2;
  return Clock3;
}

export function AssetGenerationJobCard(props: {
  job: AssetGenerationJob;
  language: UiLanguage;
  onOpenOutput: (path: string) => void;
  onImport?: (jobId: string) => Promise<unknown>;
  onCancel?: (jobId: string) => Promise<unknown>;
  compact?: boolean;
}): JSX.Element {
  const t = (zh: string, en: string): string => localize(props.language, zh, en);
  const StatusIcon = jobStatusIcon(props.job);
  const progressPercent = Math.max(0, Math.min(100, Math.round(props.job.progress * 100)));
  return (
    <section className={`asset-generation-job ${props.job.status} ${props.compact ? 'compact' : ''}`}>
      <div className="asset-generation-job-main">
        <span className="asset-generation-job-icon" aria-hidden="true">
          <StatusIcon size={17} />
        </span>
        <div>
          <h3>{props.job.title}</h3>
          <p>{formatGenerationKind(props.job.kind, props.language)} · {props.job.providerName} · {formatGenerationJobStatus(props.job, props.language)}</p>
        </div>
        <span className="asset-generation-progress-stack">
          <span className="asset-generation-progress">{progressPercent}%</span>
          <span className="asset-generation-progress-track" aria-hidden="true">
            <span style={{ width: `${progressPercent}%` }} />
          </span>
        </span>
      </div>
      <p className="asset-generation-job-prompt">{props.job.prompt}</p>
      {props.job.error ? <div className="asset-generation-error">{props.job.error}</div> : null}
      <div className="asset-generation-output-list">
        {props.job.outputs.map((output) => (
          <Button
            key={output.id}
            variant="ghost"
            size="compact"
            className="asset-generation-output"
            onClick={() => props.onOpenOutput(output.path)}
          >
            <span>{output.name}</span>
            <span>{output.path}</span>
          </Button>
        ))}
      </div>
      <div className="asset-generation-job-actions">
        {props.job.status === 'completed' ? (
          <Button size="compact" variant="secondary" onClick={() => void props.onImport?.(props.job.id)}>
            {t('标记已导入', 'Mark Imported')}
          </Button>
        ) : null}
        {props.job.status === 'running' || props.job.status === 'queued' ? (
          <Button size="compact" variant="secondary" onClick={() => void props.onCancel?.(props.job.id)}>
            {t('取消', 'Cancel')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
