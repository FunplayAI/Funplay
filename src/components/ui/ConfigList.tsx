import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { localize, useUiLanguage } from '../../i18n';
import { Badge, type BadgeTone } from './Display';
import { Button } from './Button';
import { TextField, SelectField } from './FormControls';
import { cx } from './utils';

export interface ConfigListItem {
  id: string;
  title: string;
  subtitle: string;
  description?: string;
  statusLabel?: string;
  statusTone?: BadgeTone;
  meta?: string[];
  enabled?: boolean;
  searchText?: string;
  rowClassName?: string;
  rowMainClassName?: string;
  rowActionsClassName?: string;
}

export interface ConfigDetailAction {
  id: string;
  label: string;
  tone?: 'neutral' | 'primary' | 'danger';
  icon?: ReactNode;
  disabled?: boolean;
  onAction: () => void;
}

export function ConfigListPanel(props: {
  items: ConfigListItem[];
  searchPlaceholder?: string;
  emptyTitle: string;
  emptyDescription?: string;
  onOpenItem: (id: string) => void;
  renderItemActions?: (item: ConfigListItem) => ReactNode;
  className?: string;
}): JSX.Element {
  const language = useUiLanguage();
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState('status');
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return props.items
      .filter((item) => {
        if (!normalizedQuery) return true;
        return [
          item.title,
          item.subtitle,
          item.description,
          item.statusLabel,
          ...(item.meta ?? []),
          item.searchText
        ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (sortMode === 'name') {
          return left.title.localeCompare(right.title);
        }
        const enabledDelta = Number(right.enabled ?? false) - Number(left.enabled ?? false);
        if (enabledDelta !== 0) return enabledDelta;
        return left.title.localeCompare(right.title);
      });
  }, [props.items, query, sortMode]);

  return (
    <div className={cx('settings-list-panel config-list-panel', props.className)}>
      <div className="config-list-toolbar">
        <TextField
          label={localize(language, '搜索配置', 'Search configurations')}
          value={query}
          placeholder={props.searchPlaceholder ?? localize(language, '搜索名称、模型、地址或状态', 'Search name, model, URL, or status')}
          onValueChange={setQuery}
          inputClassName="config-list-search-input"
        />
        <SelectField
          label={localize(language, '排序', 'Sort')}
          value={sortMode}
          options={[
            { value: 'status', label: localize(language, '启用优先', 'Enabled first') },
            { value: 'name', label: localize(language, '名称 A-Z', 'Name A-Z') }
          ]}
          onValueChange={setSortMode}
        />
        <span className="config-list-search-icon" aria-hidden="true">
          <Search size={15} />
        </span>
      </div>

      {visibleItems.length === 0 ? (
        <div className="config-list-empty">
          <strong>{query ? localize(language, '没有匹配结果', 'No matches') : props.emptyTitle}</strong>
          {query ? <span>{localize(language, '换个关键词试试。', 'Try another keyword.')}</span> : props.emptyDescription ? <span>{props.emptyDescription}</span> : null}
        </div>
      ) : (
        <div className="provider-channel-list config-list" role="list">
          {visibleItems.map((item) => (
            <div key={item.id} className={cx('provider-channel-row config-list-row', item.rowClassName, item.enabled === false && 'disabled')} role="listitem">
              <Button
                variant="ghost"
                size="compact"
                className={cx('provider-channel-row-main config-list-row-main', item.rowMainClassName)}
                onClick={() => props.onOpenItem(item.id)}
              >
                <span className="provider-channel-row-copy config-list-row-copy">
                  <strong>{item.title}</strong>
                  <span>{item.subtitle}</span>
                  {item.description ? <em>{item.description}</em> : null}
                </span>
                {item.statusLabel ? <Badge tone={item.statusTone ?? 'neutral'}>{item.statusLabel}</Badge> : null}
              </Button>
              <div className={cx('provider-channel-row-actions config-list-row-actions', item.rowActionsClassName)}>
                {item.meta?.slice(0, 2).map((meta) => <span key={meta} className="config-list-row-meta">{meta}</span>)}
                <Button
                  variant="secondary"
                  size="sm"
                  className="settings-row-detail-button"
                  onClick={() => props.onOpenItem(item.id)}
                  trailingIcon={<ChevronRight size={14} aria-hidden="true" />}
                >
                  {localize(language, '详情', 'Details')}
                </Button>
                {props.renderItemActions?.(item)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConfigDetailActionBar(props: { actions: ConfigDetailAction[] }): JSX.Element | null {
  const visibleActions = props.actions.filter(Boolean);
  if (visibleActions.length === 0) {
    return null;
  }
  return (
    <div className="ghost-pill-group config-detail-actions">
      {visibleActions.map((action) => (
        <Button
          key={action.id}
          className={`provider-action-button ${action.id}`}
          variant={action.tone === 'danger' ? 'danger' : action.tone === 'primary' ? 'primary' : 'secondary'}
          size="sm"
          disabled={action.disabled}
          onClick={action.onAction}
          leadingIcon={action.icon}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
