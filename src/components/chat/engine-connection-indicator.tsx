import type { CSSProperties, JSX } from 'react';
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

const engineLogoUrls: Partial<Record<EngineConnectionSummary['platform'], string>> = {
  unity: './engine-logos/unity.svg',
  cocos: './engine-logos/cocos.svg',
  godot: './engine-logos/godotengine.svg',
  unreal: './engine-logos/unrealengine.svg'
};

function EngineIcon(props: { platform: EngineConnectionSummary['platform'] }): JSX.Element {
  const logoUrl = engineLogoUrls[props.platform];

  if (logoUrl) {
    const logoStyle: CSSProperties = {
      WebkitMaskImage: `url("${logoUrl}")`,
      maskImage: `url("${logoUrl}")`
    };

    return <span className={`agent-engine-logo ${props.platform}`} style={logoStyle} aria-hidden="true" />;
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6.4 4.8V12.6C6.4 16.55 8.55 19.2 12 19.2C15.45 19.2 17.6 16.55 17.6 12.6V4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M9.15 4.8V12.7C9.15 14.65 10.2 15.95 12 15.95C13.8 15.95 14.85 14.65 14.85 12.7V4.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}
