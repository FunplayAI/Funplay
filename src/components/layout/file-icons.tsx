import type { JSX } from 'react';
import { getFileExtension } from './file-type-detection';

export function getFileIconInfo(path: string): { kind: string } {
  const extension = getFileExtension(path);
  const baseName = path.split('/').pop()?.toLowerCase() ?? '';

  if (baseName === 'package.json' || baseName.endsWith('.json')) return { kind: 'json' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' };
  if (extension === 'ts' || extension === 'tsx') return { kind: 'ts' };
  if (extension === 'js' || extension === 'jsx') return { kind: 'js' };
  if (extension === 'html' || extension === 'htm') return { kind: 'html' };
  if (extension === 'css' || extension === 'scss') return { kind: 'css' };
  if (extension === 'cs') return { kind: 'csharp' };
  if (extension === 'unity') return { kind: 'unity' };
  if (extension === 'asset' || extension === 'prefab' || extension === 'mat' || extension === 'controller') return { kind: 'unity-asset' };
  if (extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'webp' || extension === 'svg') return { kind: 'image' };
  if (extension === 'wav' || extension === 'mp3' || extension === 'ogg') return { kind: 'audio' };
  if (extension === 'meta') return { kind: 'meta' };
  return { kind: 'file' };
}

export function FolderTreeIcon(): JSX.Element {
  return (
    <span className="file-tree-folder-icon" aria-hidden="true">
      <svg viewBox="0 0 20 16" fill="none">
        <path d="M2.25 4.25A1.75 1.75 0 0 1 4 2.5h3.1c.42 0 .82.15 1.14.43l1.08.9c.14.11.31.17.49.17H16A1.75 1.75 0 0 1 17.75 5.75v6A1.75 1.75 0 0 1 16 13.5H4A1.75 1.75 0 0 1 2.25 11.75v-7.5Z" />
        <path d="M2.75 5h14.5" />
      </svg>
    </span>
  );
}

export function FileTypeIcon(props: { kind: string }): JSX.Element {
  return (
    <span className={`file-type-icon ${props.kind}`} aria-hidden="true">
      {renderFileTypeSvg(props.kind)}
    </span>
  );
}

function renderFileTypeSvg(kind: string): JSX.Element {
  if (kind === 'ts') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3.2" />
        <text x="10" y="10.7">TS</text>
      </svg>
    );
  }

  if (kind === 'js') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M5.4 2.9h9.2l2 3.4-2 3.4H5.4l-2-3.4 2-3.4Z" />
        <path d="M5.4 9.8h9.2l2 3.4-2 3.4H5.4l-2-3.4 2-3.4Z" />
        <text x="10" y="11.15">JS</text>
      </svg>
    );
  }

  if (kind === 'json') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M6.2 3.5c-1.4 0-2.2.9-2.2 2.3v1.3c0 .9-.3 1.5-1 1.9.7.3 1 .9 1 1.8v1.4c0 1.4.8 2.3 2.2 2.3" />
        <path d="M13.8 3.5c1.4 0 2.2.9 2.2 2.3v1.3c0 .9.3 1.5 1 1.9-.7.3-1 .9-1 1.8v1.4c0 1.4-.8 2.3-2.2 2.3" />
        <path d="M8.2 10h3.6" />
        <circle cx="10" cy="6.85" r=".9" />
        <circle cx="10" cy="13.15" r=".9" />
      </svg>
    );
  }

  if (kind === 'markdown') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="3" y="3" width="14" height="14" rx="2.8" />
        <path d="M6.4 13V7.2l2.15 2.45 2.15-2.45V13" />
        <path d="m12.3 10.2 1.75 0" />
        <path d="m13.2 9.1 0 2.2" />
      </svg>
    );
  }

  if (kind === 'image') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="3" y="4" width="14" height="12" rx="2.6" />
        <circle cx="7.3" cy="8" r="1.25" />
        <path d="m4.9 13.2 2.6-2.9 2.5 2.3 1.9-1.7 3.2 2.3" />
      </svg>
    );
  }

  if (kind === 'audio') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M11.8 4.4v7.1" />
        <path d="m11.8 4.4 3.2-.9" />
        <circle cx="8.2" cy="13.2" r="2.05" />
        <circle cx="14" cy="12.1" r="2.05" />
        <path d="M14 6.2v5.9" />
      </svg>
    );
  }

  if (kind === 'html') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="m7.1 5.7-3.2 4.2 3.2 4.4" />
        <path d="m12.9 5.7 3.2 4.2-3.2 4.4" />
        <path d="m10.9 4.9-1.8 10.2" />
      </svg>
    );
  }

  if (kind === 'css') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M8.2 4.4c-1.3 0-2.1.8-2.1 2.1v1c0 .8-.3 1.3-.9 1.6.6.2.9.8.9 1.6v1.1c0 1.3.8 2.1 2.1 2.1" />
        <path d="M11.8 4.4c1.3 0 2.1.8 2.1 2.1v1c0 .8.3 1.3.9 1.6-.6.2-.9.8-.9 1.6v1.1c0 1.3-.8 2.1-2.1 2.1" />
        <path d="M9.3 7.1h1.4" />
        <path d="M9 10h2" />
        <path d="M9.3 12.9h1.4" />
      </svg>
    );
  }

  if (kind === 'csharp') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M10 2.8 15.4 5.9v6.2L10 15.2 4.6 12.1V5.9Z" />
        <path d="M8.4 8.1c-.3-.4-.8-.6-1.3-.6-1 0-1.8.8-1.8 1.9s.8 1.9 1.8 1.9c.5 0 1-.2 1.3-.6" />
        <path d="M10.3 8v3" />
        <path d="M12 8v3" />
        <path d="M9.2 9.5h3.9" />
      </svg>
    );
  }

  if (kind === 'unity' || kind === 'unity-asset') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="m10 3.2 3.7 2.1 1.3 4.2-2.5 4.6L8 15.3 4.2 12l-.5-4.7 3.2-3.2Z" />
        <path d="m10 3.2-.8 4 2.7 2.2 3.1-.1" />
        <path d="m8 15.3 1.2-4.8-5-3.2" />
        <path d="m12.5 14.1-3.3-3.6" />
      </svg>
    );
  }

  if (kind === 'meta') {
    return (
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="4" y="4" width="12" height="12" rx="2.6" />
        <path d="M6.8 8.1h6.4" />
        <path d="M6.8 10.4h6.4" />
        <path d="M6.8 12.7h4.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M5 3.25h6.5L15 6.75v10H5z" />
      <path d="M11.5 3.25v3.5H15" />
      <path d="M7.4 9.5h5.2" />
      <path d="M7.4 12h3.6" />
    </svg>
  );
}
