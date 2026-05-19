import { protocol } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import type { AppState } from '../../shared/types';
import {
  decodeHtmlPreviewProjectHost,
  HTML_PROJECT_PREVIEW_PROTOCOL
} from '../../shared/html-preview-protocol';
import { getProjectFileMimeType, resolveProjectFileAbsolutePath } from './project-file-service';

const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob:;",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;",
  "style-src 'self' 'unsafe-inline' data:;",
  "img-src 'self' data: blob:;",
  "font-src 'self' data:;",
  "media-src 'self' data: blob:;",
  "connect-src 'self' data: blob:;",
  "worker-src 'self' blob:;",
  "object-src 'none';",
  "base-uri 'self';"
].join(' ');

const HTML_PREVIEW_FIT_SCRIPT = `
<script>
(function () {
  var ROOT_ID = '__funplay_preview_fit_root';
  var STYLE_ID = '__funplay_preview_fit_style';
  var scheduled = false;

  function ensureRoot() {
    if (document.getElementById(ROOT_ID) || !document.body) {
      return document.getElementById(ROOT_ID);
    }

    var root = document.createElement('div');
    root.id = ROOT_ID;
    while (document.body.firstChild) {
      root.appendChild(document.body.firstChild);
    }
    document.body.appendChild(root);
    return root;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) || !document.head) {
      return;
    }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      'html.funplay-preview-fit, html.funplay-preview-fit body {',
      '  width: 100%; height: 100%; margin: 0; overflow: hidden !important;',
      '}',
      'html.funplay-preview-fit body {',
      '  display: block !important;',
      '}',
      '#__funplay_preview_fit_root {',
      '  display: inline-block; transform-origin: top left; will-change: transform;',
      '}'
    ].join('\\n');
    document.head.appendChild(style);
  }

  function fit() {
    scheduled = false;
    var root = ensureRoot();
    if (!root) {
      return;
    }

    root.style.transform = 'none';
    root.style.marginLeft = '0px';
    root.style.marginTop = '0px';
    var rect = root.getBoundingClientRect();
    var contentWidth = Math.max(root.scrollWidth, rect.width, 1);
    var contentHeight = Math.max(root.scrollHeight, rect.height, 1);
    var availableWidth = Math.max(window.innerWidth, 1);
    var availableHeight = Math.max(window.innerHeight, 1);
    var scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight, 1);
    var left = Math.max(0, (availableWidth - contentWidth * scale) / 2);
    var top = Math.max(0, (availableHeight - contentHeight * scale) / 2);

    root.style.marginLeft = left + 'px';
    root.style.marginTop = top + 'px';
    root.style.transform = 'scale(' + scale + ')';
  }

  function scheduleFit() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.requestAnimationFrame(fit);
  }

  function start() {
    document.documentElement.classList.add('funplay-preview-fit');
    ensureStyle();
    ensureRoot();
    scheduleFit();
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('load', scheduleFit);
    window.setTimeout(scheduleFit, 250);
    window.setTimeout(scheduleFit, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
</script>`;

export function registerProjectPreviewProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HTML_PROJECT_PREVIEW_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        stream: true
      }
    }
  ]);
}

export function installProjectPreviewProtocol(getState: () => AppState): void {
  protocol.handle(HTML_PROJECT_PREVIEW_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const projectId = decodeHtmlPreviewProjectHost(url.hostname);
      const filePath = decodePreviewPath(url.pathname);
      if (!projectId || !filePath) {
        return createPreviewErrorResponse('Not found.', 404);
      }

      const absolutePath = resolveProjectFileAbsolutePath(getState(), projectId, filePath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return createPreviewErrorResponse('Not found.', 404);
      }

      const mimeType = getProjectFileMimeType(filePath);
      const content = await readFile(absolutePath);
      const responseBody = url.searchParams.get('funplayPreviewMode') === 'fit' && mimeType.startsWith('text/html')
        ? Buffer.from(injectHtmlPreviewFitScript(content.toString('utf8')), 'utf8')
        : new Uint8Array(content);
      return new Response(responseBody, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': PREVIEW_CONTENT_SECURITY_POLICY,
          'Content-Type': mimeType,
          'X-Content-Type-Options': 'nosniff'
        }
      });
    } catch {
      return createPreviewErrorResponse('Not found.', 404);
    }
  });
}

function injectHtmlPreviewFitScript(html: string): string {
  if (html.includes('__funplay_preview_fit_root')) {
    return html;
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${HTML_PREVIEW_FIT_SCRIPT}</body>`);
  }
  return `${html}${HTML_PREVIEW_FIT_SCRIPT}`;
}

function decodePreviewPath(pathname: string): string | undefined {
  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    if (!segment) {
      continue;
    }
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return segments.length ? segments.join('/') : undefined;
}

function createPreviewErrorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PREVIEW_CONTENT_SECURITY_POLICY,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
