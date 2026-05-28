import { useEffect, useId, useState, type JSX, type ReactNode } from 'react';
import { localize, useUiLanguage } from '../../../i18n';
import { Button } from '../../ui/index';
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

export function ToolDetailOverlay(props: {
  items: UiDisclosureItem[];
  title?: string;
  trigger?: (input: { open: boolean; panelId: string; toggle: () => void }) => ReactNode;
}): JSX.Element | null {
  const language = useUiLanguage();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const firstItem = props.items[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!firstItem) {
    return null;
  }

  const toggle = (): void => setOpen((current) => !current);
  const title = props.title ?? localize(language, '工具详情', 'Tool details');

  return (
    <div className={`tool-detail-disclosure ${open ? 'open' : ''}`}>
      {props.trigger ? (
        props.trigger({ open, panelId, toggle })
      ) : (
        <Button
          variant="secondary"
          size="compact"
          className="tool-detail-trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          {localize(language, '详情', 'Details')}
        </Button>
      )}
      <div id={panelId} className="tool-detail-popover" role="region" aria-label={title} hidden={!open}>
        <ul className="tool-detail-list">
          {props.items.map((item) => (
            <li
              key={item.id}
              className={`tool-detail-item ${item.status}`}
              data-debug-summary={item.compactSummary}
              data-debug-detail={item.status === 'failed' ? item.rawDebugText : undefined}
            >
              <div className="tool-detail-line-body">
                {item.detail}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
