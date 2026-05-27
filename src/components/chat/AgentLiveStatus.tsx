import { Square } from 'lucide-react';
import type { JSX } from 'react';
import { localize, useUiLanguage } from '../../i18n';
import { Button } from '../ui/index';
import type { RuntimeTaskStatus, RuntimeTaskSummary } from './runtime-task-summary';

export function AgentLiveStatus(props: {
  message: string;
  detail?: string;
  taskSummary?: RuntimeTaskSummary | null;
  compactTaskSummary?: boolean;
  onCancel?: () => void;
}): JSX.Element {
  const language = useUiLanguage();
  const taskSummary = props.taskSummary;
  const visibleTaskItems = props.compactTaskSummary
    ? []
    : taskSummary?.items ?? [];
  const taskSummaryLabel = taskSummary
    ? localize(
        language,
        `${taskSummary.completed}/${taskSummary.total} 完成 · ${taskSummary.inProgress} 进行中`,
        `${taskSummary.completed}/${taskSummary.total} done · ${taskSummary.inProgress} running`
      )
    : '';

  return (
    <div className={`agent-live-status ${props.compactTaskSummary ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="agent-live-status-main">
        <span className="agent-live-spinner" aria-hidden="true">
          <span />
        </span>
        <span className="agent-live-copy">
          <strong>{props.message}</strong>
          {props.detail ? <em>{props.detail}</em> : null}
        </span>
        {props.compactTaskSummary && taskSummaryLabel ? (
          <span className="agent-live-task-pill">{taskSummaryLabel}</span>
        ) : null}
        <span className="agent-live-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {props.onCancel ? (
          <Button size="sm" variant="secondary" leadingIcon={<Square size={12} aria-hidden="true" />} onClick={props.onCancel}>
            {localize(language, '停止', 'Stop')}
          </Button>
        ) : null}
      </div>
      {taskSummary && visibleTaskItems.length > 0 ? (
        <div className="agent-live-task-panel" aria-label={localize(language, '任务清单', 'Task list')}>
          <div className="agent-live-task-header">
            <strong>{localize(language, '任务清单', 'Task list')}</strong>
            <span>{taskSummaryLabel}</span>
          </div>
          <div className="agent-live-task-list">
            {visibleTaskItems.map((item, index) => (
              <div key={`${item.id ?? index}:${item.content}`} className={`agent-live-task-item ${item.status}`}>
                <span className="agent-live-task-dot" aria-hidden="true" />
                <span className="agent-live-task-copy">
                  <strong>{item.content}</strong>
                  <em>
                    {[item.id, formatRuntimeTaskStatus(item.status, language), item.priority].filter(Boolean).join(' · ')}
                  </em>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatRuntimeTaskStatus(status: RuntimeTaskStatus, language: 'zh-CN' | 'en-US'): string {
  const labels: Record<RuntimeTaskStatus, string> = {
    pending: localize(language, '待处理', 'Pending'),
    in_progress: localize(language, '进行中', 'Running'),
    completed: localize(language, '已完成', 'Done'),
    cancelled: localize(language, '已取消', 'Cancelled')
  };
  return labels[status];
}
