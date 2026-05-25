import { Copy, X } from 'lucide-react';
import { useState, type JSX, type ReactNode } from 'react';
import { localize, useUiLanguage } from '../../../i18n';
import { Badge, Button, IconButton } from '../../ui/index';
import type { TranscriptViewItemStatus } from '../transcript/transcript-view-model';

export interface UiDisclosureItem {
  id: string;
  title: string;
  compactSummary: string;
  status: TranscriptViewItemStatus;
  timestamp?: string;
  copyText: string;
  rawDebugText: string;
  detail: ReactNode;
}

export function ToolDetailOverlay(props: { items: UiDisclosureItem[] }): JSX.Element | null {
  const language = useUiLanguage();
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const firstItem = props.items[0];
  if (!firstItem) {
    return null;
  }

  async function copyItem(item: UiDisclosureItem): Promise<void> {
    await navigator.clipboard?.writeText(item.copyText || item.rawDebugText).catch(() => undefined);
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId(''), 1200);
  }

  return (
    <div className={`tool-detail-disclosure ${open ? 'open' : ''}`}>
      <Button
        variant="secondary"
        size="compact"
        className="tool-detail-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {localize(language, '详情', 'Details')}
      </Button>
      {open ? (
        <div className="tool-detail-popover" role="dialog" aria-label={localize(language, '工具详情', 'Tool details')}>
          <div className="tool-detail-popover-head">
            <div>
              <strong>{firstItem.title}</strong>
              <span>{firstItem.compactSummary}</span>
            </div>
            <IconButton
              label={localize(language, '关闭工具详情', 'Close tool details')}
              icon={<X size={14} aria-hidden="true" />}
              onClick={() => setOpen(false)}
            />
          </div>
          <div className="tool-detail-list">
            {props.items.map((item) => (
              <section key={item.id} className={`tool-detail-item ${item.status}`}>
                <div className="tool-detail-item-head">
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.timestamp ? formatTimestamp(item.timestamp) : item.compactSummary}</span>
                  </div>
                  <div className="tool-detail-item-actions">
                    <Badge tone={item.status === 'failed' ? 'danger' : item.status === 'running' ? 'brand' : 'success'}>{formatStatus(item.status, language)}</Badge>
                    <Button variant="ghost" size="compact" onClick={() => void copyItem(item)}>
                      <Copy size={13} aria-hidden="true" />
                      {copiedId === item.id ? localize(language, '已复制', 'Copied') : localize(language, '复制', 'Copy')}
                    </Button>
                  </div>
                </div>
                <div className="tool-detail-item-body">
                  {item.detail}
                </div>
                <details className="tool-detail-raw">
                  <summary>{localize(language, '原始调试文本', 'Raw debug text')}</summary>
                  <pre>{item.rawDebugText}</pre>
                </details>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatStatus(status: TranscriptViewItemStatus, language: 'zh-CN' | 'en-US'): string {
  const labels: Record<TranscriptViewItemStatus, string> = {
    pending: localize(language, '等待', 'Pending'),
    running: localize(language, '运行中', 'Running'),
    completed: localize(language, '完成', 'Done'),
    failed: localize(language, '失败', 'Failed')
  };
  return labels[status];
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
