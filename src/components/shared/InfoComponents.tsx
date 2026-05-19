import { type JSX, type ReactNode } from 'react';

export function Card(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="prototype-card">
      <div className="prototype-card-title">{props.title}</div>
      <div className="prototype-card-body">{props.children}</div>
    </section>
  );
}

export function List(props: { items: string[] }): JSX.Element {
  return (
    <ul className="prototype-list">
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
