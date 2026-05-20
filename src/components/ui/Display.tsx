import { type JSX, type ReactNode } from 'react';
import { cx } from './utils';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export function Badge(props: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}): JSX.Element {
  return <span className={cx('fp-badge', `fp-badge-${props.tone ?? 'neutral'}`, props.className)}>{props.children}</span>;
}

export function MetricTile(props: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: BadgeTone;
}): JSX.Element {
  return (
    <section className={cx('fp-metric-tile', props.tone && `fp-metric-${props.tone}`)}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail ? <em>{props.detail}</em> : null}
    </section>
  );
}

export function Surface(props: {
  children: ReactNode;
  className?: string;
  density?: 'normal' | 'compact';
}): JSX.Element {
  return <section className={cx('fp-surface', props.density === 'compact' && 'fp-surface-compact', props.className)}>{props.children}</section>;
}
