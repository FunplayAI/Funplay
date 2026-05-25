import { BrowserWindow, session } from 'electron';
import { HTML_PROJECT_PREVIEW_PROTOCOL } from '../../shared/html-preview-protocol';

function createContentSecurityPolicy(): string {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    const url = new URL(devServerUrl);
    const origin = url.origin;
    const socketOrigins = [`ws://${url.host}`, 'ws://127.0.0.1:*', 'ws://localhost:*'].join(' ');
    const httpOrigins = [origin, 'http://127.0.0.1:*', 'http://localhost:*'].join(' ');

    return [
      "default-src 'self';",
      `script-src 'self' 'unsafe-inline' ${origin};`,
      `style-src 'self' 'unsafe-inline' ${origin};`,
      `img-src 'self' data: blob: ${origin};`,
      `font-src 'self' data: ${origin};`,
      `media-src 'self' data: blob: ${HTML_PROJECT_PREVIEW_PROTOCOL}: ${origin};`,
      `connect-src 'self' ${httpOrigins} ${socketOrigins};`,
      `frame-src 'self' ${HTML_PROJECT_PREVIEW_PROTOCOL}: http://127.0.0.1:* http://localhost:* blob: data:;`,
      "object-src 'none';",
      "base-uri 'self';",
      "form-action 'self';",
      "frame-ancestors 'none';"
    ].join(' ');
  }

  return [
    "default-src 'self';",
    "script-src 'self';",
    "style-src 'self' 'unsafe-inline';",
    "img-src 'self' data: blob:;",
    "font-src 'self' data:;",
    `media-src 'self' data: blob: ${HTML_PROJECT_PREVIEW_PROTOCOL}:;`,
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*;",
    `frame-src 'self' ${HTML_PROJECT_PREVIEW_PROTOCOL}: http://127.0.0.1:* http://localhost:* blob: data:;`,
    "object-src 'none';",
    "base-uri 'self';",
    "form-action 'self';",
    "frame-ancestors 'none';"
  ].join(' ');
}

export function installSessionSecurity(): void {
  const contentSecurityPolicy = createContentSecurityPolicy();

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(`${HTML_PROJECT_PREVIEW_PROTOCOL}://`)) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'X-Content-Type-Options': ['nosniff']
        }
      });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
        'X-Content-Type-Options': ['nosniff']
      }
    });
  });
}

export function secureBrowserWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const allowedOrigins = new Set<string>();

    if (devServerUrl) {
      allowedOrigins.add(new URL(devServerUrl).origin);
    }

    if (url.startsWith('file://')) {
      return;
    }

    try {
      const targetOrigin = new URL(url).origin;
      if (!allowedOrigins.has(targetOrigin)) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
}
