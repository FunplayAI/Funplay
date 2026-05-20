import { type JSX, type ReactNode } from 'react';
import { Surface } from '../ui/index';

export function Card(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Surface className="fp-info-card">
      <div className="fp-info-card-title">{props.title}</div>
      <div className="fp-info-card-body">{props.children}</div>
    </Surface>
  );
}

export function List(props: { items: string[] }): JSX.Element {
  return (
    <ul className="fp-info-list">
      {props.items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function InfoRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="info-row">
      <div className="info-label">{props.label}</div>
      <div className="info-value">{props.value}</div>
    </div>
  );
}
