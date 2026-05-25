import type { JSX } from 'react';
import type { PlatformChoice } from '../../../shared/types';
import { IconButton } from '../ui/index';

export interface EngineConnectionSummary {
  platform: Exclude<PlatformChoice, 'web'>;
  status: 'connected' | 'disconnected' | 'unknown';
  label: string;
}

export function EngineConnectionIndicator(props: { connection: EngineConnectionSummary; onOpen?: () => void }): JSX.Element {
  return (
    <IconButton
      className={`agent-engine-connection-indicator ${props.connection.platform} ${props.connection.status}`}
      label={props.connection.label}
      onClick={props.onOpen}
      icon={(
        <>
          <EngineIcon platform={props.connection.platform} />
          <span className={`agent-engine-connection-dot ${props.connection.status}`} aria-hidden="true" />
        </>
      )}
    />
  );
}

function EngineIcon(props: { platform: EngineConnectionSummary['platform'] }): JSX.Element {
  if (props.platform === 'unity') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M12 3.5L19 7.55V16.45L12 20.5L5 16.45V7.55L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 3.8V11.9M19 7.7L12 11.9M5 7.7L12 11.9M12 20.2V11.9" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      </svg>
    );
  }

  if (props.platform === 'cocos') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M12 3.8L19.1 7.9V16.1L12 20.2L4.9 16.1V7.9L12 3.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M14.9 9.2C14.1 8.45 13.12 8.05 12 8.05C9.78 8.05 8.05 9.78 8.05 12C8.05 14.22 9.78 15.95 12 15.95C13.12 15.95 14.1 15.55 14.9 14.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (props.platform === 'godot') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M5.2 10.4L7.2 7.8L9.4 9.1L12 6.5L14.6 9.1L16.8 7.8L18.8 10.4V17.2C17.2 19 14.85 20 12 20C9.15 20 6.8 19 5.2 17.2V10.4Z" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
        <path d="M9.3 13.2H9.32M14.7 13.2H14.72" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M10.2 16.2C11.15 16.85 12.85 16.85 13.8 16.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6.4 4.8V12.6C6.4 16.55 8.55 19.2 12 19.2C15.45 19.2 17.6 16.55 17.6 12.6V4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M9.15 4.8V12.7C9.15 14.65 10.2 15.95 12 15.95C13.8 15.95 14.85 14.65 14.85 12.7V4.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}
