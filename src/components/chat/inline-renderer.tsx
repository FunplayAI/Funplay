import { Fragment, type ReactNode } from 'react';
import { Button } from '../ui/index';

export function renderChatInline(
  line: string,
  openablePathSet: Set<string>,
  searchQuery: string,
  onOpenPath: (path: string) => void
): ReactNode {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(\[[^\]]+\]\((?:https?:\/\/[^)\s]+|file:\/\/\/?[^)\s]+|[^)\s]+)\)|https?:\/\/[^\s<>()\],，。！？；;]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|(?:file:\/\/)?\/[^\s<>()\],，。！？；;]+?\.[A-Za-z0-9]{1,12}(?::\d+)?|\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_-]+)?(?::\d+)?)/g;
  let lastIndex = 0;

  for (const match of line.matchAll(tokenPattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(<Fragment key={`text-${index}`}>{highlightSearchText(line.slice(lastIndex, index), searchQuery)}</Fragment>);
    }

    if (raw.startsWith('[')) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const label = linkMatch?.[1] ?? raw;
      const target = linkMatch?.[2] ?? '';
      const openablePath = resolveOpenablePath(target, openablePathSet);
      const localFilePath = resolveLocalFilePath(target);
      if (openablePath) {
        nodes.push(
          <Button key={`path-${index}`} size="compact" variant="ghost" className="chat-inline-path" onClick={() => onOpenPath(openablePath)}>
            {highlightSearchText(label, searchQuery)}
          </Button>
        );
      } else if (localFilePath) {
        nodes.push(renderLocalFileButton(`local-link-${index}`, localFilePath, label, searchQuery));
      } else if (/^https?:\/\//i.test(target)) {
        nodes.push(
          <Button key={`link-${index}`} size="compact" variant="ghost" className="chat-inline-link" onClick={() => openExternalUrl(target)}>
            {highlightSearchText(label, searchQuery)}
          </Button>
        );
      } else {
        nodes.push(
          <Fragment key={`plain-link-${index}`}>{highlightSearchText(label, searchQuery)}</Fragment>
        );
      }
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      const codeValue = raw.slice(1, -1);
      const openablePath = resolveOpenablePath(codeValue, openablePathSet);
      const localFilePath = resolveLocalFilePath(codeValue);
      if (openablePath) {
        nodes.push(
          <Button key={`code-path-${index}`} size="compact" variant="ghost" className="chat-inline-path" onClick={() => onOpenPath(openablePath)}>
            {highlightSearchText(openablePath, searchQuery)}
          </Button>
        );
      } else if (localFilePath) {
        nodes.push(renderLocalFileButton(`code-local-${index}`, localFilePath, formatLocalFileLabel(localFilePath), searchQuery));
      } else {
        nodes.push(
          <code key={`code-${index}`} className="chat-inline-code">
            {highlightSearchText(codeValue, searchQuery)}
          </code>
        );
      }
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      nodes.push(<strong key={`bold-${index}`}>{highlightSearchText(raw.slice(2, -2), searchQuery)}</strong>);
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      nodes.push(<em key={`em-${index}`}>{highlightSearchText(raw.slice(1, -1), searchQuery)}</em>);
    } else if (/^https?:\/\//i.test(raw)) {
      nodes.push(
        <Button key={`url-${index}`} size="compact" variant="ghost" className="chat-inline-link" onClick={() => openExternalUrl(raw)}>
          {highlightSearchText(raw, searchQuery)}
        </Button>
      );
    } else if (resolveOpenablePath(raw, openablePathSet)) {
      const openablePath = resolveOpenablePath(raw, openablePathSet)!;
      nodes.push(
        <Button key={`file-${index}`} size="compact" variant="ghost" className="chat-inline-path" onClick={() => onOpenPath(openablePath)}>
          {highlightSearchText(openablePath, searchQuery)}
        </Button>
      );
    } else if (resolveLocalFilePath(raw)) {
      const localFilePath = resolveLocalFilePath(raw)!;
      nodes.push(renderLocalFileButton(`local-file-${index}`, localFilePath, formatLocalFileLabel(localFilePath), searchQuery));
    } else {
      nodes.push(<Fragment key={`plain-${index}`}>{highlightSearchText(raw, searchQuery)}</Fragment>);
    }

    lastIndex = index + raw.length;
  }

  if (lastIndex < line.length) {
    nodes.push(<Fragment key={`tail-${lastIndex}`}>{highlightSearchText(line.slice(lastIndex), searchQuery)}</Fragment>);
  }

  return nodes.length > 0 ? <>{nodes}</> : <>{line || <br />}</>;
}

export function renderLocalFileButton(key: string, path: string, label: string, searchQuery: string): ReactNode {
  return (
    <Button
      key={key}
      size="compact"
      variant="ghost"
      className="chat-inline-file"
      title={path}
      aria-label={`Open local file ${path}`}
      onClick={() => openLocalFilePath(path)}
    >
      {highlightSearchText(label || formatLocalFileLabel(path), searchQuery)}
    </Button>
  );
}

export function resolveOpenablePath(rawTarget: string, openablePathSet: Set<string>): string | null {
  const decoded = safeDecodeUri(rawTarget)
    .replace(/^file:\/\//, '')
    .replace(/^\.?\//, '')
    .replace(/[#?].*$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '')
    .trim();
  if (!decoded) {
    return null;
  }
  if (openablePathSet.has(decoded)) {
    return decoded;
  }
  const normalized = decoded.replace(/\\/g, '/');
  for (const candidate of openablePathSet) {
    const candidateNormalized = candidate.replace(/\\/g, '/');
    if (normalized.endsWith(`/${candidateNormalized}`) || normalized === candidateNormalized) {
      return candidate;
    }
  }
  return null;
}

export function resolveLocalFilePath(rawTarget: string): string | null {
  const decoded = safeDecodeUri(rawTarget)
    .replace(/^file:\/\//i, '')
    .replace(/[#?].*$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '')
    .trim();
  if (!decoded || !decoded.startsWith('/')) {
    return null;
  }
  if (!/^\/(?:Users|Volumes|Applications|tmp|private|var|opt)\//.test(decoded)) {
    return null;
  }
  return decoded;
}

export function formatLocalFileLabel(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

export function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function openExternalUrl(url: string): void {
  void window.funplay.openExternal(url).catch(() => {});
}

export function openLocalFilePath(path: string): void {
  void window.funplay.openLocalPath(path).catch((error) => {
    window.alert(error instanceof Error ? error.message : `Failed to open local file: ${path}`);
  });
}

export function revealLocalFilePath(path: string): void {
  void window.funplay.revealLocalPath(path).catch((error) => {
    window.alert(error instanceof Error ? error.message : `Failed to reveal local file: ${path}`);
  });
}

export function highlightSearchText(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    parts.push(
      <mark key={`mark-${matchIndex}`} className="chat-search-mark">
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>
    );
    cursor = matchIndex + normalizedQuery.length;
  }

  return <>{parts}</>;
}

export function formatAbsoluteTime(language: 'zh-CN' | 'en-US', value: string): string {
  return new Intl.DateTimeFormat(language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}
