import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '../../../shared/types';
import { resolveProjectRootPathForProject } from '../project-file-service';

type BrowserWindow = import('electron').BrowserWindow;

interface BrowserInspectionSession {
  id: string;
  projectId: string;
  url: string;
  createdAt: string;
  lastActionAt: string;
  width: number;
  height: number;
  window: BrowserWindow;
  consoleMessages: BrowserConsoleMessage[];
}

interface BrowserConsoleMessage {
  level: string;
  message: string;
  line: number;
  sourceId: string;
  timestamp: string;
}

interface BrowserDomNodeSummary {
  index: number;
  tag: string;
  text: string;
  selector: string;
  ariaLabel?: string;
  role?: string;
  testId?: string;
  href?: string;
  disabled?: boolean;
}

export interface BrowserOpenInput {
  url: string;
  width?: number;
  height?: number;
}

export interface BrowserReadInput {
  sessionId: string;
  maxTextChars?: number;
}

export interface BrowserNavigateInput {
  sessionId: string;
  url: string;
}

export interface BrowserScreenshotInput {
  sessionId: string;
  fullPage?: boolean;
}

export interface BrowserClickInput {
  sessionId: string;
  selector?: string;
  text?: string;
}

export interface BrowserTypeInput {
  sessionId: string;
  selector: string;
  text: string;
  clear?: boolean;
}

const sessions = new Map<string, BrowserInspectionSession>();
const MAX_BROWSER_SESSIONS = 4;
const DEFAULT_VIEWPORT_WIDTH = 1440;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const MAX_BODY_TEXT_CHARS = 6000;
const MAX_CONSOLE_MESSAGES = 80;
const SCREENSHOT_DIR = join(tmpdir(), 'funplay-browser-inspections');

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(value), max));
}

function normalizeBrowserHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isAllowedLocalBrowserHost(hostname: string): boolean {
  const normalized = normalizeBrowserHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 127 || normalized === '0.0.0.0';
  }

  if (isIP(normalized) === 6) {
    return normalized === '::1';
  }

  return false;
}

function isBlockedBrowserHost(hostname: string): boolean {
  if (isAllowedLocalBrowserHost(hostname)) {
    return false;
  }

  const normalized = normalizeBrowserHostname(hostname);
  if (normalized.endsWith('.local')) {
    return true;
  }

  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    );
  }

  if (isIP(normalized) === 6) {
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  return false;
}

function normalizeBrowserUrl(project: Project, inputUrl: string, toolName = 'browser_open'): string {
  const trimmed = inputUrl.trim();
  if (!trimmed) {
    throw new Error(`${toolName} 缺少 url。`);
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (isBlockedBrowserHost(parsed.hostname)) {
      throw new Error('浏览器工具不访问内网、链路本地或 .local 地址；可访问公网 http/https 和本机 localhost。');
    }
    return parsed.toString();
  }

  if (parsed.protocol === 'file:') {
    const rootPath = resolveProjectRootPathForProject(project);
    const filePath = fileURLToPath(parsed);
    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}/`)) {
      throw new Error('浏览器检查工具仅允许打开项目目录内的 file URL。');
    }
    return parsed.toString();
  }

  throw new Error(`${toolName} 仅支持公网/本机 http/https 或项目内 file URL。`);
}

async function loadElectronMain(): Promise<typeof import('electron')> {
  const electronModule = await import('electron');
  if (typeof electronModule.BrowserWindow !== 'function' || !electronModule.app) {
    throw new Error('浏览器检查工具只能在 Electron 主进程中使用。');
  }
  if (!electronModule.app.isReady()) {
    await electronModule.app.whenReady();
  }
  return electronModule;
}

async function loadUrl(window: BrowserWindow, url: string): Promise<void> {
  await Promise.race([
    window.loadURL(url),
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('页面加载超时。'));
      }, 20_000);
      timeout.unref?.();
    })
  ]);
}

function formatBrowserLoadError(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }

  if (
    parsed &&
    isAllowedLocalBrowserHost(parsed.hostname) &&
    /ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_ABORTED|页面加载超时/i.test(message)
  ) {
    return [
      `浏览器无法打开 ${url}。`,
      '本地服务没有响应或还没启动；请先用 terminal_start 启动 dev server/HTTP server，terminal_read 确认出现 localhost 地址后再调用 browser_open。',
      `原始错误：${message}`
    ].join('\n');
  }

  return message;
}

function getSession(sessionId: string): BrowserInspectionSession {
  const session = sessions.get(sessionId);
  if (!session || session.window.isDestroyed()) {
    throw new Error(`浏览器会话不存在或已关闭：${sessionId}`);
  }
  session.lastActionAt = new Date().toISOString();
  return session;
}

function pushConsoleMessage(session: BrowserInspectionSession, message: BrowserConsoleMessage): void {
  session.consoleMessages.push(message);
  if (session.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
    session.consoleMessages.splice(0, session.consoleMessages.length - MAX_CONSOLE_MESSAGES);
  }
}

function pruneClosedSessions(): void {
  for (const [id, session] of sessions) {
    if (session.window.isDestroyed()) {
      sessions.delete(id);
    }
  }
}

async function enforceSessionLimit(): Promise<void> {
  pruneClosedSessions();
  if (sessions.size < MAX_BROWSER_SESSIONS) {
    return;
  }

  const oldest = [...sessions.values()].sort((left, right) => left.lastActionAt.localeCompare(right.lastActionAt))[0];
  if (oldest) {
    closeBrowserPage(oldest.id);
  }
}

function formatBrowserSessions(project?: Project): string {
  const items = [...sessions.values()]
    .filter((session) => !project || session.projectId === project.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (items.length === 0) {
    return 'No browser inspection sessions.';
  }

  return items.map((session, index) =>
    `${index + 1}. [${session.id}] ${session.url}\nViewport: ${session.width}x${session.height} | Created: ${session.createdAt} | Last action: ${session.lastActionAt}`
  ).join('\n\n');
}

export async function openBrowserPage(project: Project, input: BrowserOpenInput): Promise<string> {
  await enforceSessionLimit();
  const electronModule = await loadElectronMain();
  const url = normalizeBrowserUrl(project, input.url, 'browser_open');
  const width = clampInteger(input.width, DEFAULT_VIEWPORT_WIDTH, 320, 2400);
  const height = clampInteger(input.height, DEFAULT_VIEWPORT_HEIGHT, 320, 1800);
  const id = `browser_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const window = new electronModule.BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true
    }
  });

  const session: BrowserInspectionSession = {
    id,
    projectId: project.id,
    url,
    createdAt,
    lastActionAt: createdAt,
    width,
    height,
    window,
    consoleMessages: []
  };
  sessions.set(id, session);

  window.webContents.on('console-message', (details) => {
    pushConsoleMessage(session, {
      level: String(details.level),
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId,
      timestamp: new Date().toISOString()
    });
  });
  window.on('closed', () => {
    sessions.delete(id);
  });

  try {
    await loadUrl(window, url);
  } catch (error) {
    closeBrowserPage(id);
    throw new Error(formatBrowserLoadError(url, error));
  }

  const title = await window.webContents.executeJavaScript('document.title || ""', true) as string;
  return [
    `Browser session: ${id}`,
    `URL: ${window.webContents.getURL() || url}`,
    `Title: ${title || '(untitled)'}`,
    `Viewport: ${width}x${height}`
  ].join('\n');
}

export async function navigateBrowserPage(project: Project, input: BrowserNavigateInput): Promise<string> {
  const session = getSession(input.sessionId);
  const url = normalizeBrowserUrl(project, input.url, 'browser_navigate');
  await loadUrl(session.window, url);
  session.url = session.window.webContents.getURL() || url;
  session.lastActionAt = new Date().toISOString();
  const title = await session.window.webContents.executeJavaScript('document.title || ""', true) as string;
  return [
    `Browser session: ${session.id}`,
    `URL: ${session.url}`,
    `Title: ${title || '(untitled)'}`
  ].join('\n');
}

export function listBrowserPages(project?: Project): string {
  pruneClosedSessions();
  return formatBrowserSessions(project);
}

export async function readBrowserSnapshot(input: BrowserReadInput): Promise<string> {
  const session = getSession(input.sessionId);
  const maxTextChars = clampInteger(input.maxTextChars, MAX_BODY_TEXT_CHARS, 1000, 20000);
  const snapshot = await session.window.webContents.executeJavaScript(
    `(${(bodyTextLimit: number) => {
      const visibleText = (value: string | null | undefined) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const createSelector = (element: Element): string => {
        const testId = element.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        if (element.id) return `#${CSS.escape(element.id)}`;
        const label = element.getAttribute('aria-label');
        if (label) return `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(label)}"]`;
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 4) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current!.tagName);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
          current = parent;
        }
        return parts.join(' > ');
      };
      const summarize = (selector: string, limit: number) => Array.from(document.querySelectorAll(selector))
        .slice(0, limit)
        .map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          text: visibleText(element.textContent).slice(0, 160),
          selector: createSelector(element),
          ariaLabel: element.getAttribute('aria-label') || undefined,
          role: element.getAttribute('role') || undefined,
          testId: element.getAttribute('data-testid') || undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
            ? element.disabled
            : undefined
        }));
      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        },
        bodyText: visibleText(document.body?.innerText).slice(0, bodyTextLimit),
        headings: summarize('h1,h2,h3', 30),
        controls: summarize('button,a,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]', 80)
      };
    }})(${JSON.stringify(maxTextChars)})`,
    true
  ) as {
    title: string;
    url: string;
    readyState: string;
    viewport: Record<string, number>;
    bodyText: string;
    headings: BrowserDomNodeSummary[];
    controls: BrowserDomNodeSummary[];
  };

  return JSON.stringify(snapshot, null, 2);
}

export async function captureBrowserScreenshot(input: BrowserScreenshotInput): Promise<string> {
  const session = getSession(input.sessionId);
  if (input.fullPage) {
    await session.window.webContents.executeJavaScript('window.scrollTo(0, 0)', true);
  }
  const image = await session.window.webContents.capturePage();
  const png = image.toPNG();
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const safeUrlName = basename(new URL(session.url).pathname || 'page').replace(/[^a-z0-9_.-]/gi, '_') || 'page';
  const path = join(SCREENSHOT_DIR, `${session.id}-${Date.now()}-${safeUrlName}.png`);
  await writeFile(path, png);
  return [
    `Screenshot saved: ${path}`,
    `Bytes: ${png.length}`,
    `URL: ${session.window.webContents.getURL() || session.url}`
  ].join('\n');
}

export async function clickBrowserPage(input: BrowserClickInput): Promise<string> {
  const session = getSession(input.sessionId);
  const selector = input.selector?.trim();
  const text = input.text?.trim();
  if (!selector && !text) {
    throw new Error('browser_click 需要 selector 或 text。');
  }
  const result = await session.window.webContents.executeJavaScript(
    `(${(targetSelector: string | null, targetText: string | null) => {
      const matchesText = (element: Element) => {
        const textContent = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const ariaLabel = String(element.getAttribute('aria-label') ?? '').trim();
        return textContent.includes(targetText ?? '') || ariaLabel.includes(targetText ?? '');
      };
      const element = targetSelector
        ? document.querySelector(targetSelector)
        : Array.from(document.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="link"]')).find(matchesText);
      if (!element) {
        return { ok: false, message: '未找到可点击元素。' };
      }
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (element instanceof HTMLElement) {
        element.click();
        return {
          ok: true,
          message: `Clicked ${element.tagName.toLowerCase()} ${String(element.textContent ?? element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`
        };
      }
      return { ok: false, message: '匹配元素不是 HTMLElement。' };
    }})(${JSON.stringify(selector || null)}, ${JSON.stringify(text || null)})`,
    true
  ) as { ok: boolean; message: string };
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.message;
}

export async function typeBrowserPage(input: BrowserTypeInput): Promise<string> {
  const session = getSession(input.sessionId);
  const selector = input.selector.trim();
  if (!selector) {
    throw new Error('browser_type 缺少 selector。');
  }
  const result = await session.window.webContents.executeJavaScript(
    `(${(targetSelector: string, text: string, clear: boolean) => {
      const element = document.querySelector(targetSelector);
      if (!element) {
        return { ok: false, message: '未找到输入元素。' };
      }
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.focus();
        const nextValue = clear ? text : `${element.value}${text}`;
        element.value = nextValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, message: `Typed ${text.length} chars into ${targetSelector}` };
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        element.focus();
        if (clear) {
          element.textContent = text;
        } else {
          element.textContent = `${element.textContent ?? ''}${text}`;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return { ok: true, message: `Typed ${text.length} chars into ${targetSelector}` };
      }
      return { ok: false, message: '目标元素不是可输入控件。' };
    }})(${JSON.stringify(selector)}, ${JSON.stringify(input.text)}, ${JSON.stringify(Boolean(input.clear))})`,
    true
  ) as { ok: boolean; message: string };
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.message;
}

export function readBrowserConsole(sessionId: string): string {
  const session = getSession(sessionId);
  if (session.consoleMessages.length === 0) {
    return 'No browser console messages.';
  }
  return session.consoleMessages
    .map((message, index) => `${index + 1}. [${message.timestamp}] level=${message.level} ${message.message}${message.sourceId ? ` (${message.sourceId}:${message.line})` : ''}`)
    .join('\n');
}

export function closeBrowserPage(sessionId?: string): string {
  if (!sessionId) {
    const count = sessions.size;
    for (const session of sessions.values()) {
      if (!session.window.isDestroyed()) {
        session.window.close();
      }
    }
    sessions.clear();
    return `Closed ${count} browser inspection session(s).`;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return `Browser session already closed: ${sessionId}`;
  }
  if (!session.window.isDestroyed()) {
    session.window.close();
  }
  sessions.delete(sessionId);
  return `Closed browser session: ${sessionId}`;
}

export function closeBrowserPagesForProject(projectId: string): string {
  const projectSessions = [...sessions.values()].filter((session) => session.projectId === projectId);
  for (const session of projectSessions) {
    if (!session.window.isDestroyed()) {
      session.window.close();
    }
    sessions.delete(session.id);
  }
  return `Closed ${projectSessions.length} browser inspection session(s).`;
}

export function disposeBrowserInspectionSessions(): void {
  closeBrowserPage();
}
