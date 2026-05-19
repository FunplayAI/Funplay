import type { JSX, ReactNode } from 'react';
import type { Project } from '../../../shared/types';

export function AgentWorkbench(props: {
  project: Project | null;
  children: ReactNode;
  sidePanel?: ReactNode;
}): JSX.Element {
  if (!props.project) {
    return <div className="agent-workbench-shell no-project">{props.children}</div>;
  }

  return (
    <div className={`agent-workbench-shell ${props.sidePanel ? 'with-side-panel' : ''}`}>
      <div className="agent-workbench-body">
        <div className="agent-workbench-chat-pane">{props.children}</div>
        {props.sidePanel ? <aside className="agent-workbench-side-pane">{props.sidePanel}</aside> : null}
      </div>
    </div>
  );
}
