import { isValidElement, useMemo, useState, type JSX, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localize, useUiLanguage } from '../../../i18n';
import { Button } from '../../ui/index';
import {
  formatLocalFileLabel,
  highlightSearchText,
  openExternalUrl,
  openLocalFilePath,
  resolveLocalFilePath,
  resolveOpenablePath,
  safeDecodeUri
} from '../inline-renderer';

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const GENERATED_PATH_PROTOCOL = 'funplay-path:';
const GENERATED_PATH_PATTERN = /(?:file:\/\/)?\/[^\s<>()\],，。！？；;]+?\.[A-Za-z0-9]{1,12}(?::\d+)?|\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_-]+)?(?::\d+)?/g;

export function renderChatContent(
  content: string,
  openablePaths: string[],
  searchQuery: string,
  onOpenPath: (path: string) => void
): JSX.Element {
  return (
    <ChatMarkdown
      content={content}
      openablePaths={openablePaths}
      searchQuery={searchQuery}
      onOpenPath={onOpenPath}
    />
  );
}

function ChatMarkdown(props: {
  content: string;
  openablePaths: string[];
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const openablePathSet = useMemo(() => new Set(props.openablePaths), [props.openablePaths]);
  const components = useMemo<Components>(() => createMarkdownComponents({
    openablePathSet,
    searchQuery: props.searchQuery,
    onOpenPath: props.onOpenPath
  }), [openablePathSet, props.searchQuery, props.onOpenPath]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkFilePathLinks]}
      components={components}
      urlTransform={(url) => url}
    >
      {normalizeMarkdownInput(props.content)}
    </ReactMarkdown>
  );
}

function createMarkdownComponents(input: {
  openablePathSet: Set<string>;
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): Components {
  return {
    p: ({ children }) => (
      <div className="chat-rich-text-block">
        <div className="chat-rich-text-line">{children}</div>
      </div>
    ),
    h1: ({ children }) => <div className="chat-rich-heading large">{children}</div>,
    h2: ({ children }) => <div className="chat-rich-heading medium">{children}</div>,
    h3: ({ children }) => <div className="chat-rich-heading small">{children}</div>,
    h4: ({ children }) => <div className="chat-rich-heading small">{children}</div>,
    h5: ({ children }) => <div className="chat-rich-heading small">{children}</div>,
    h6: ({ children }) => <div className="chat-rich-heading small">{children}</div>,
    ul: ({ children }) => <ul className="chat-rich-list-block unordered">{children}</ul>,
    ol: ({ children }) => <ol className="chat-rich-list-block ordered">{children}</ol>,
    li: ({ children, className }) => (
      <li className={`chat-rich-list-line ${className ?? ''}`}>
        <div>{children}</div>
      </li>
    ),
    blockquote: ({ children }) => <blockquote className="chat-rich-quote">{children}</blockquote>,
    hr: () => <hr className="chat-rich-divider" />,
    table: ({ children }) => (
      <div className="chat-rich-table-wrap">
        <table className="chat-rich-table">{children}</table>
      </div>
    ),
    th: ({ children }) => <th>{children}</th>,
    td: ({ children }) => <td>{children}</td>,
    a: ({ href, children }) => renderMarkdownLink({
      href,
      children,
      openablePathSet: input.openablePathSet,
      searchQuery: input.searchQuery,
      onOpenPath: input.onOpenPath
    }),
    code: ({ children, className }) => {
      const language = readMarkdownLanguage(className);
      if (language) {
        return <code className={className}>{children}</code>;
      }
      return <InlineCode value={flattenReactText(children)} openablePathSet={input.openablePathSet} searchQuery={input.searchQuery} onOpenPath={input.onOpenPath} />;
    },
    pre: ({ children }) => {
      const block = extractPreCodeBlock(children);
      if (!block) {
        return <pre className="chat-plain-text-block"><code>{flattenReactText(children)}</code></pre>;
      }
      return shouldRenderFenceAsPlainText(block.language, block.content)
        ? <PlainTextBlock content={block.content} />
        : <ChatCodeBlock language={block.language} content={block.content} />;
    }
  };
}

function renderMarkdownLink(input: {
  href?: string;
  children: ReactNode;
  openablePathSet: Set<string>;
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const href = input.href ?? '';
  const decodedHref = href.startsWith(GENERATED_PATH_PROTOCOL)
    ? safeDecodeUri(href.slice(GENERATED_PATH_PROTOCOL.length))
    : href;
  const labelText = flattenReactText(input.children) || decodedHref;
  const openablePath = resolveOpenablePath(decodedHref, input.openablePathSet);
  const localFilePath = resolveLocalFilePath(decodedHref);

  if (openablePath) {
    return (
      <Button size="compact" variant="ghost" className="chat-inline-path" onClick={() => input.onOpenPath(openablePath)}>
        {highlightSearchText(labelText, input.searchQuery)}
      </Button>
    );
  }

  if (localFilePath) {
    return (
      <Button
        size="compact"
        variant="ghost"
        className="chat-inline-file"
        title={localFilePath}
        aria-label={`Open local file ${localFilePath}`}
        onClick={() => openLocalFilePath(localFilePath)}
      >
        {highlightSearchText(labelText || formatLocalFileLabel(localFilePath), input.searchQuery)}
      </Button>
    );
  }

  if (/^https?:\/\//i.test(decodedHref)) {
    return (
      <Button size="compact" variant="ghost" className="chat-inline-link" onClick={() => openExternalUrl(decodedHref)}>
        {input.children}
      </Button>
    );
  }

  return <span>{input.children}</span>;
}

function InlineCode(props: {
  value: string;
  openablePathSet: Set<string>;
  searchQuery: string;
  onOpenPath: (path: string) => void;
}): JSX.Element {
  const openablePath = resolveOpenablePath(props.value, props.openablePathSet);
  const localFilePath = resolveLocalFilePath(props.value);

  if (openablePath) {
    return (
      <Button size="compact" variant="ghost" className="chat-inline-path" onClick={() => props.onOpenPath(openablePath)}>
        {highlightSearchText(openablePath, props.searchQuery)}
      </Button>
    );
  }

  if (localFilePath) {
    return (
      <Button
        size="compact"
        variant="ghost"
        className="chat-inline-file"
        title={localFilePath}
        aria-label={`Open local file ${localFilePath}`}
        onClick={() => openLocalFilePath(localFilePath)}
      >
        {highlightSearchText(formatLocalFileLabel(localFilePath), props.searchQuery)}
      </Button>
    );
  }

  return <code className="chat-inline-code">{highlightSearchText(props.value, props.searchQuery)}</code>;
}

function PlainTextBlock(props: { content: string }): JSX.Element {
  return (
    <pre className="chat-plain-text-block"><code>{props.content}</code></pre>
  );
}

function ChatCodeBlock(props: { language?: string; content: string }): JSX.Element {
  const language = useUiLanguage();
  const [copied, setCopied] = useState(false);
  const codeLanguage = props.language?.trim() || 'code';

  function handleCopy(): void {
    navigator.clipboard.writeText(props.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  }

  return (
    <div className="chat-code-card">
      <div className="chat-code-header">
        <span className="chat-code-language">{codeLanguage}</span>
        <Button size="compact" variant="ghost" className="chat-code-copy" onClick={handleCopy}>
          {copied ? localize(language, '已复制', 'Copied') : localize(language, '复制', 'Copy')}
        </Button>
      </div>
      <pre className="chat-code-block"><code>{props.content}</code></pre>
    </div>
  );
}

function normalizeMarkdownInput(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const normalized: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    if (!inFence && isStandaloneThematicBreak(line) && normalized.length > 0 && normalized[normalized.length - 1].trim()) {
      normalized.push('');
    }
    normalized.push(line);
  }

  return normalized.join('\n');
}

function isStandaloneThematicBreak(line: string): boolean {
  return /^([-*_])(?:\s*\1){2,}\s*$/.test(line.trim());
}

function readMarkdownLanguage(className: string | undefined): string {
  const match = /language-([^\s]+)/.exec(className ?? '');
  return match?.[1] ?? '';
}

function extractPreCodeBlock(children: ReactNode): { language?: string; content: string } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return null;
  }

  const language = readMarkdownLanguage(child.props.className);
  return {
    language: language || undefined,
    content: trimCodeBlockTrailingNewline(flattenReactText(child.props.children))
  };
}

function trimCodeBlockTrailingNewline(value: string): string {
  return value.replace(/\n$/, '');
}

function flattenReactText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenReactText(item)).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return flattenReactText(value.props.children);
  }
  return '';
}

function shouldRenderFenceAsPlainText(language: string | undefined, content: string): boolean {
  const normalized = language?.trim().toLowerCase();
  if (normalized === 'text' || normalized === 'txt' || normalized === 'plain' || normalized === 'plaintext') {
    return true;
  }
  if (normalized && normalized !== 'code') {
    return false;
  }
  return !looksLikeSourceCode(content);
}

function looksLikeSourceCode(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  const codeLineCount = lines.filter((line) => (
    /^(import|export|const|let|var|function|class|interface|type|enum|return|if|for|while|switch|case|break|async|await)\b/.test(line) ||
    /^(def|class|from|import|return|if|elif|else|for|while|try|except|with)\b/.test(line) ||
    /^<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(line) ||
    /^[.#]?[\w-]+\s*\{/.test(line) ||
    /^[\]}),;]+$/.test(line) ||
    /[{};]\s*$/.test(line) ||
    /=>/.test(line) ||
    /^\s*["']?[\w-]+["']?\s*:\s*["'{[\d]/.test(line)
  )).length;
  const codeRatio = codeLineCount / Math.max(lines.length, 1);
  if (codeRatio >= 0.34) {
    return true;
  }
  return /```/.test(trimmed) || /\b(document|window|canvas|getElementById|addEventListener|console\.log|npm\s+\w+|pnpm\s+\w+|yarn\s+\w+)\b/.test(trimmed);
}

function remarkFilePathLinks() {
  return (tree: MarkdownNode): void => {
    transformFilePathTextNodes(tree);
  };
}

function transformFilePathTextNodes(node: MarkdownNode): void {
  if (!node.children?.length || shouldSkipFilePathTransform(node.type)) {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      nextChildren.push(...splitTextNodeByFilePath(child.value));
      continue;
    }
    transformFilePathTextNodes(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function shouldSkipFilePathTransform(type: string | undefined): boolean {
  return type === 'link' || type === 'linkReference' || type === 'inlineCode' || type === 'code';
}

function splitTextNodeByFilePath(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(GENERATED_PATH_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push({ type: 'text', value: value.slice(cursor, index) });
    }
    nodes.push({
      type: 'link',
      url: `${GENERATED_PATH_PROTOCOL}${encodeURIComponent(raw)}`,
      children: [{ type: 'text', value: raw }]
    });
    cursor = index + raw.length;
  }
  if (cursor < value.length) {
    nodes.push({ type: 'text', value: value.slice(cursor) });
  }
  return nodes.length > 0 ? nodes : [{ type: 'text', value }];
}
