import { useState, type JSX } from 'react';
import type { Project, ProjectDocumentPreview } from '../../../shared/types';
import { buildHtmlProjectPreviewUrl, type HtmlProjectPreviewMode } from '../../../shared/html-preview-protocol';
import { localize, useUiLanguage } from '../../i18n';
import {
  isAudioFile,
  isHtmlFile,
  isImageFile,
  isOfficeDocumentFile,
  isPdfFile,
  isVideoFile,
} from './file-type-detection';

export interface ProjectFileItem {
  id: string;
  label: string;
  path: string;
  badge?: string;
  content: string;
  isBinary?: boolean;
  mimeType?: string;
  previewDataUrl?: string;
  documentPreview?: ProjectDocumentPreview;
  size?: number;
}

export function renderFilePreview(
  file: ProjectFileItem,
  content: string,
  project: Project | null,
  htmlPreviewMode: HtmlProjectPreviewMode
): JSX.Element {
  const path = file.path;

  if (isImageFile(path)) {
    return file.previewDataUrl ? (
      <div className="asset-preview-frame">
        <img src={file.previewDataUrl} alt={file.label} />
      </div>
    ) : (
      <BinaryPreviewFallback file={file} project={project} />
    );
  }

  if (isAudioFile(path)) {
    return file.previewDataUrl ? (
      <div className="asset-preview-frame audio">
        <audio controls src={file.previewDataUrl} />
      </div>
    ) : (
      <BinaryPreviewFallback file={file} project={project} />
    );
  }

  if (isVideoFile(path)) {
    return file.previewDataUrl ? (
      <div className="asset-preview-frame video">
        <video controls src={file.previewDataUrl} />
      </div>
    ) : (
      <BinaryPreviewFallback file={file} project={project} />
    );
  }

  if (isHtmlFile(path)) {
    return <HtmlPreviewFrame file={file} content={content} project={project} previewMode={htmlPreviewMode} />;
  }

  if (isPdfFile(path)) {
    return file.documentPreview ? <DocumentPreview file={file} project={project} preview={file.documentPreview} /> : file.previewDataUrl ? <PdfPreviewFrame file={file} project={project} /> : <BinaryPreviewFallback file={file} project={project} />;
  }

  if (isOfficeDocumentFile(path)) {
    return file.documentPreview ? <DocumentPreview file={file} project={project} preview={file.documentPreview} /> : <BinaryPreviewFallback file={file} project={project} />;
  }

  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(content) }} />;
}

function HtmlPreviewFrame(props: {
  file: ProjectFileItem;
  content: string;
  project: Project | null;
  previewMode: HtmlProjectPreviewMode;
}): JSX.Element {
  const language = useUiLanguage();
  const requiresDevServer = htmlRequiresDevServer(props.content);
  const [devPreview, setDevPreview] = useState<{
    status: 'idle' | 'starting' | 'ready' | 'error';
    url?: string;
    sessionId?: string;
    command?: string;
    error?: string;
  }>({ status: 'idle' });
  const previewUrl = props.project
    ? buildHtmlProjectPreviewUrl(props.project.id, props.file.path, props.previewMode === 'fit' ? { mode: 'fit' } : {})
    : undefined;
  const frameUrl = devPreview.url ?? previewUrl;

  async function startDevPreview(): Promise<void> {
    if (!props.project || devPreview.status === 'starting') {
      return;
    }
    setDevPreview({ status: 'starting' });
    try {
      const result = await window.funplay.startProjectHtmlPreviewServer(props.project.id);
      setDevPreview({
        status: 'ready',
        url: result.url,
        sessionId: result.sessionId,
        command: result.command
      });
    } catch (error) {
      setDevPreview({
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function stopDevPreview(): Promise<void> {
    if (!props.project || devPreview.status !== 'ready') {
      return;
    }
    const previousUrl = devPreview.url;
    setDevPreview({ status: 'starting', url: previousUrl });
    try {
      await window.funplay.stopProjectHtmlPreviewServer(props.project.id);
      setDevPreview({ status: 'idle' });
    } catch (error) {
      setDevPreview({
        status: 'error',
        url: previousUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return (
    <div className={`html-preview-shell ${requiresDevServer ? 'with-notice' : ''}`}>
      {requiresDevServer ? (
        <div className="html-preview-notice">
          <div className="html-preview-notice-copy">
            <strong>
              {devPreview.status === 'ready'
                ? localize(language, '正在使用本地服务预览', 'Previewing from local server')
                : localize(language, '需要启动项目预览服务', 'Project preview server required')}
            </strong>
            <span>
              {devPreview.status === 'ready' && devPreview.url
                ? devPreview.url
                : devPreview.status === 'error'
                  ? devPreview.error
                  : localize(
                    language,
                    '检测到 TypeScript/Vite 入口。静态预览不会编译源码，可以自动运行项目脚本后在这里预览。',
                    'TypeScript/Vite entry detected. Static preview cannot compile source files; start the project script to preview it here.'
                  )}
            </span>
          </div>
          <button
            className="prototype-secondary small"
            onClick={devPreview.status === 'ready' ? stopDevPreview : startDevPreview}
            disabled={!props.project || devPreview.status === 'starting'}
          >
            {devPreview.status === 'starting'
              ? localize(language, '处理中…', 'Working…')
              : devPreview.status === 'ready'
                ? localize(language, '停止预览', 'Stop preview')
                : localize(language, '启动预览', 'Start preview')}
          </button>
        </div>
      ) : null}
      <iframe
        key={frameUrl ?? props.file.path}
        className="html-preview-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals"
        src={frameUrl}
        srcDoc={frameUrl ? undefined : props.content}
        title={props.file.path}
      />
    </div>
  );
}

function htmlRequiresDevServer(content: string): boolean {
  return /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']+\.(?:ts|tsx)(?:[?#][^"']*)?["']/i.test(content);
}

function PdfPreviewFrame(props: { file: ProjectFileItem; project: Project | null }): JSX.Element {
  const language = useUiLanguage();
  return (
    <div className="pdf-preview-shell">
      <div className="pdf-preview-toolbar">
        <div>
          <strong>{props.file.label}</strong>
          <span>{localize(language, 'PDF 预览', 'PDF preview')}</span>
        </div>
        <div className="pptx-preview-actions">
          <button className="prototype-secondary small" onClick={() => openProjectFile(props.project, props.file)}>
            {localize(language, '打开 PDF', 'Open PDF')}
          </button>
          <button className="prototype-secondary small" onClick={() => revealProjectFile(props.project, props.file)}>
            {localize(language, '显示位置', 'Show in Finder')}
          </button>
        </div>
      </div>
      <iframe className="pdf-preview-frame" src={props.file.previewDataUrl} title={props.file.path} />
    </div>
  );
}

function DocumentPreview(props: { file: ProjectFileItem; project: Project | null; preview: ProjectDocumentPreview }): JSX.Element {
  const language = useUiLanguage();
  const isDocx = props.preview.kind === 'docx';
  const isPdf = props.preview.kind === 'pdf';
  const previewLabel = isDocx
    ? localize(language, `DOCX 文档预览 · ${props.preview.pageCount} 段`, `DOCX document preview · ${props.preview.pageCount} sections`)
    : isPdf
      ? localize(language, `PDF 页面预览 · ${props.preview.pageCount} 页`, `PDF page preview · ${props.preview.pageCount} page`)
    : localize(language, `PPTX 幻灯片预览 · ${props.preview.pageCount} 页`, `PPTX slide preview · ${props.preview.pageCount} slides`);
  const openLabel = isDocx
    ? localize(language, '打开文档', 'Open document')
    : isPdf
      ? localize(language, '打开 PDF', 'Open PDF')
      : localize(language, '打开 PPT', 'Open PPT');
  return (
    <div className={`pptx-preview-frame ${isDocx ? 'docx-preview-frame' : ''} ${isPdf ? 'pdf-document-preview-frame' : ''}`}>
      <div className="pptx-preview-header">
        <div>
          <strong>{props.file.label}</strong>
          <span>{previewLabel}</span>
        </div>
        <div className="pptx-preview-actions">
          <button className="prototype-secondary small" onClick={() => openProjectFile(props.project, props.file)}>
            {openLabel}
          </button>
          <button className="prototype-secondary small" onClick={() => revealProjectFile(props.project, props.file)}>
            {localize(language, '显示位置', 'Show in Finder')}
          </button>
        </div>
      </div>
      {props.preview.warning ? <div className="pptx-preview-warning">{props.preview.warning}</div> : null}
      {isPdf ? (
        <div className="pdf-document-page-list">
          {props.preview.pages.map((page) => (
            <article key={page.index} className="pdf-document-page-card">
              {page.thumbnailDataUrl ? (
                <img className="pdf-document-page-image" src={page.thumbnailDataUrl} alt={page.title || `PDF page ${page.index}`} />
              ) : (
                <p>{localize(language, '该页无法生成缩略图。', 'This page thumbnail could not be generated.')}</p>
              )}
            </article>
          ))}
        </div>
      ) : isDocx ? (
        <div className="docx-page-list">
          {props.preview.pages.map((page) => (
            <article key={page.index} className="docx-page-card">
              <div className="pptx-slide-index">{page.index}</div>
              <div className="pptx-slide-body">
                <strong>{page.title || localize(language, `第 ${page.index} 段`, `Section ${page.index}`)}</strong>
                <p>{page.text || localize(language, '该段没有可提取文本。', 'No extractable text in this section.')}</p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="pptx-slide-grid">
          {props.preview.pages.map((page) => (
            <article key={page.index} className={`pptx-slide-card ${page.thumbnailDataUrl ? 'thumbnail' : 'text-only'}`}>
              <div className="pptx-slide-index">{page.index}</div>
              <div className="pptx-slide-body">
                <strong>{page.title || localize(language, `第 ${page.index} 页`, `Slide ${page.index}`)}</strong>
                {page.thumbnailDataUrl ? (
                  <img className="pptx-slide-thumbnail" src={page.thumbnailDataUrl} alt={page.title || `Slide ${page.index}`} />
                ) : (
                  <p>{page.text || localize(language, '该页没有可提取文本。', 'No extractable text on this slide.')}</p>
                )}
                {page.thumbnailDataUrl && page.text ? (
                  <details className="pptx-slide-text">
                    <summary>{localize(language, '提取文本', 'Extracted text')}</summary>
                    <p>{page.text}</p>
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function BinaryPreviewFallback(props: { file: ProjectFileItem; project: Project | null }): JSX.Element {
  const language = useUiLanguage();
  return (
    <div className="binary-preview-fallback">
      <strong>{localize(language, '该素材无法内联预览', 'This asset cannot be previewed inline')}</strong>
      <span>{props.file.path}</span>
      <span>{props.file.mimeType || localize(language, '未知类型', 'Unknown type')}</span>
      {props.file.size ? <span>{formatBytes(props.file.size)}</span> : null}
      <div className="binary-preview-actions">
        <button className="prototype-secondary small" onClick={() => openProjectFile(props.project, props.file)}>
          {localize(language, '打开文件', 'Open file')}
        </button>
        <button className="prototype-secondary small" onClick={() => revealProjectFile(props.project, props.file)}>
          {localize(language, '显示位置', 'Show in Finder')}
        </button>
      </div>
    </div>
  );
}

function openProjectFile(project: Project | null, file: ProjectFileItem): void {
  if (!project) {
    return;
  }
  void window.funplay.openProjectFile(project.id, file.path).catch((error) => {
    window.alert(error instanceof Error ? error.message : `Failed to open ${file.path}`);
  });
}

function revealProjectFile(project: Project | null, file: ProjectFileItem): void {
  if (!project) {
    return;
  }
  void window.funplay.revealProjectFile(project.id, file.path).catch((error) => {
    window.alert(error instanceof Error ? error.message : `Failed to reveal ${file.path}`);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdown(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return output;
}

function renderMarkdownPreview(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  const paragraph: string[] = [];
  const listItems: string[] = [];
  const codeLines: string[] = [];
  let inCodeBlock = false;

  function flushParagraph(): void {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  }

  function flushList(): void {
    if (listItems.length === 0) {
      return;
    }
    html.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
    listItems.length = 0;
  }

  function flushCode(): void {
    if (codeLines.length === 0) {
      return;
    }
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines.length = 0;
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCode();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return html.join('');
}
