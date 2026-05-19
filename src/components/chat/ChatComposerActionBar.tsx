import type { JSX, ReactNode } from 'react';

export function ChatComposerActionBar(props: {
  left?: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="agent-action-bar">
      <div className="agent-action-bar-group">{props.left}</div>
      <div className="agent-action-bar-group subtle">{props.right}</div>
    </div>
  );
}
