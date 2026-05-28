import type { JSX } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import type { ChatMediaBlock } from '../../../../shared/types';
import { localize, useUiLanguage } from '../../../i18n';
import { Button } from '../../ui/index';

export function MediaResultGrid(props: {
  media?: ChatMediaBlock[];
  compact?: boolean;
  onOpenPath?: (path: string) => void;
  onRevealPath?: (path: string) => void;
}): JSX.Element | null {
  const language = useUiLanguage();
  const media = props.media?.filter((item) => item.data || item.localPath || item.title) ?? [];
  if (media.length === 0) {
    return null;
  }

  return (
    <div className={`chat-media-grid ${props.compact ? 'compact' : ''}`}>
      {media.map((item, index) => {
        const label = item.title || item.localPath?.split('/').pop() || item.mimeType || item.type;
        if (item.type === 'image' && item.data) {
          const src = item.data.startsWith('data:')
            ? item.data
            : `data:${item.mimeType || 'image/png'};base64,${item.data}`;
          return (
            <figure key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card image">
              <img src={src} alt={label} />
              <figcaption>{label}</figcaption>
            </figure>
          );
        }

        if (item.type === 'audio' && item.data) {
          const src = item.data.startsWith('data:')
            ? item.data
            : `data:${item.mimeType || 'audio/wav'};base64,${item.data}`;
          return (
            <div key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card audio">
              <span>{label}</span>
              <audio controls src={src} />
            </div>
          );
        }

        return (
          <div key={`${item.mediaId ?? item.localPath ?? item.type}-${index}`} className="chat-media-card file">
            <strong>{formatMediaType(item.type, language)}</strong>
            <span>{label}</span>
            {item.mimeType ? <small>{item.mimeType}</small> : null}
            {item.localPath ? <em>{item.localPath}</em> : null}
            {item.localPath && props.onOpenPath ? (
              <div className="chat-media-actions">
                <Button size="sm" variant="secondary" leadingIcon={<ExternalLink size={13} aria-hidden="true" />} onClick={() => props.onOpenPath!(item.localPath!)}>
                  {localize(language, '打开', 'Open')}
                </Button>
                {props.onRevealPath ? (
                  <Button size="sm" variant="secondary" leadingIcon={<FolderOpen size={13} aria-hidden="true" />} onClick={() => props.onRevealPath!(item.localPath!)}>
                    {localize(language, '显示位置', 'Show')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function formatMediaType(type: ChatMediaBlock['type'], language: 'zh-CN' | 'en-US'): string {
  if (type === 'image') {
    return localize(language, '图片', 'Image');
  }
  if (type === 'audio') {
    return localize(language, '音频', 'Audio');
  }
  return localize(language, '文件', 'File');
}
