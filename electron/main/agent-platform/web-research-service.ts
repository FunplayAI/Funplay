import { isIP } from 'node:net';
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  type WebResearchMetrics,
  type WebSearchProvider,
  type WebSearchQualityCaseResult,
  type WebSearchQualityReport,
  type WebSearchSettings
} from '../../../shared/types';
import { getState } from '../store';

export type { WebSearchProvider } from '../../../shared/types';

const DEFAULT_WEB_TIMEOUT_MS = 12_000;
const MAX_WEB_TIMEOUT_MS = 30_000;
const MAX_WEB_FETCH_CHARS = 20_000;
const MAX_WEB_SEARCH_RESULTS = 8;
const WEB_USER_AGENT = 'FunplayAgent/0.1 (+https://funplay.local)';
const MIN_BROWSER_FALLBACK_TEXT_CHARS = 500;

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  domains?: string[];
  blockedDomains?: string[];
  preferOfficial?: boolean;
  provider?: WebSearchProvider;
}

export interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export interface WebToolExecutionOptions {
  abortSignal?: AbortSignal;
}

export interface WebToolActionResult {
  ok: boolean;
  summary: string;
  isError?: boolean;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: Exclude<WebSearchProvider, 'auto'>;
  publishedAt?: string;
}

interface FetchRawResult {
  finalUrl: string;
  contentType: string;
  body: string;
  bytes: Buffer;
  byteLength: number;
}

interface ReadablePage {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  extraction: string;
  browserFallbackUsed?: boolean;
  text: string;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<WebToolActionResult>>();
const fetchCache = new Map<string, CacheEntry<WebToolActionResult>>();
const metrics: WebResearchMetrics = {
  searchRequests: 0,
  fetchRequests: 0,
  cacheHits: 0,
  failures: 0,
  browserFallbacks: 0,
  documentExtractions: 0,
  providerRequests: {},
  totalDurationMs: 0
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

export function getConfiguredWebSearchSettings(): WebSearchSettings {
  try {
    const configured = getState().aiSettings.webSearch;
    return {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      ...(configured ?? {})
    };
  } catch {
    return DEFAULT_WEB_SEARCH_SETTINGS;
  }
}

function normalizeCacheTtl(): number {
  const raw = Number(process.env.FUNPLAY_WEB_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) {
    return Math.min(raw, 24 * 60 * 60 * 1000);
  }
  return getConfiguredWebSearchSettings().cacheTtlMs;
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  const ttl = normalizeCacheTtl();
  if (ttl <= 0) {
    return;
  }
  cache.set(key, {
    expiresAt: Date.now() + ttl,
    value
  });
}

function recordMetrics(input: {
  kind: 'search' | 'fetch';
  provider?: string;
  cacheHit: boolean;
  durationMs: number;
  ok: boolean;
  extraction?: string;
  browserFallbackUsed?: boolean;
  documentExtraction?: boolean;
}): void {
  if (!getConfiguredWebSearchSettings().telemetryEnabled) {
    return;
  }
  if (input.kind === 'search') {
    metrics.searchRequests += 1;
  } else {
    metrics.fetchRequests += 1;
  }
  if (input.cacheHit) {
    metrics.cacheHits += 1;
  }
  if (!input.ok) {
    metrics.failures += 1;
  }
  if (input.provider) {
    metrics.providerRequests[input.provider] = (metrics.providerRequests[input.provider] ?? 0) + 1;
  }
  if (input.browserFallbackUsed) {
    metrics.browserFallbacks += 1;
  }
  if (input.documentExtraction) {
    metrics.documentExtractions += 1;
  }
  metrics.totalDurationMs += input.durationMs;
  metrics.lastRequest = {
    kind: input.kind,
    provider: input.provider,
    cacheHit: input.cacheHit,
    durationMs: input.durationMs,
    ok: input.ok,
    extraction: input.extraction,
    at: new Date().toISOString()
  };
}

export function clearWebResearchCache(): void {
  searchCache.clear();
  fetchCache.clear();
}

export function resetWebResearchMetrics(): void {
  metrics.searchRequests = 0;
  metrics.fetchRequests = 0;
  metrics.cacheHits = 0;
  metrics.failures = 0;
  metrics.browserFallbacks = 0;
  metrics.documentExtractions = 0;
  metrics.providerRequests = {};
  metrics.totalDurationMs = 0;
  delete metrics.lastRequest;
}

export function getWebResearchMetrics(): WebResearchMetrics {
  return {
    searchRequests: metrics.searchRequests,
    fetchRequests: metrics.fetchRequests,
    cacheHits: metrics.cacheHits,
    failures: metrics.failures,
    browserFallbacks: metrics.browserFallbacks,
    documentExtractions: metrics.documentExtractions,
    providerRequests: { ...metrics.providerRequests },
    totalDurationMs: metrics.totalDurationMs,
    lastRequest: metrics.lastRequest ? { ...metrics.lastRequest } : undefined
  };
}

function createAbortSignal(timeoutMs = DEFAULT_WEB_TIMEOUT_MS, abortSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(timeoutMs, MAX_WEB_TIMEOUT_MS)));
  timeout.unref?.();
  const abort = () => controller.abort();
  abortSignal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', abort);
    }
  };
}

function normalizeWebUrl(url: string): URL {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('web_fetch 只支持 http/https URL。');
  }
  return parsed;
}

function isBlockedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS === '1') {
    return false;
  }
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    );
  }
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<(?:br|p|div|section|article|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractAttribute(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : undefined;
}

function extractReadablePage(html: string, finalUrl: string, maxChars = MAX_WEB_FETCH_CHARS): ReadablePage {
  const title = stripHtmlToText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\n+/g, ' ').trim() || undefined;
  const description = extractAttribute(
    html,
    /<meta\b(?=[^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["'])[^>]*content=["']([^"']+)["'][^>]*>/i
  );
  const canonicalUrl = extractAttribute(
    html,
    /<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["'][^>]*>/i
  );
  const candidates = [
    ...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi),
    ...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi),
    ...html.matchAll(/<div\b(?=[^>]*(?:id|class)=["'][^"']*(?:content|article|post|entry|main)[^"']*["'])[^>]*>([\s\S]*?)<\/div>/gi),
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  ]
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1]))
    .map((match) => stripHtmlToText(match[1]))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const text = (candidates[0] ?? stripHtmlToText(html)).slice(0, maxChars);
  let resolvedCanonical = canonicalUrl;
  if (canonicalUrl) {
    try {
      resolvedCanonical = new URL(canonicalUrl, finalUrl).toString();
    } catch {
      resolvedCanonical = canonicalUrl;
    }
  }
  return {
    title,
    description,
    canonicalUrl: resolvedCanonical,
    extraction: 'html-static',
    text
  };
}

function normalizeExtractedText(value: string, maxChars: number): string {
  return value
    .replace(/\u0000/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);
}

function inferDocumentKind(fetched: FetchRawResult, requestedUrl: URL): 'html' | 'json' | 'pdf' | 'rtf' | 'xml' | 'text' | 'binary-document' | 'binary' {
  const contentType = fetched.contentType.toLowerCase();
  const pathname = new URL(fetched.finalUrl || requestedUrl.toString()).pathname.toLowerCase();
  if (/html|xhtml/.test(contentType) || /\.(html?|xhtml)$/.test(pathname)) return 'html';
  if (/json/.test(contentType) || /\.json$/.test(pathname)) return 'json';
  if (/pdf/.test(contentType) || /\.pdf$/.test(pathname)) return 'pdf';
  if (/rtf/.test(contentType) || /\.rtf$/.test(pathname)) return 'rtf';
  if (/xml|rss|atom|svg/.test(contentType) || /\.(xml|rss|atom|svg)$/.test(pathname)) return 'xml';
  if (/text|markdown|csv|tsv|yaml|toml/.test(contentType) || /\.(txt|md|markdown|csv|tsv|yaml|yml|toml|log)$/.test(pathname)) return 'text';
  if (/\.(docx?|pptx?|xlsx?|odt|ods|odp)$/.test(pathname)) return 'binary-document';
  return 'binary';
}

function decodePdfLiteral(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      if (char === 't') return '\t';
      if (char === 'b' || char === 'f') return ' ';
      return char;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function extractPdfText(bytes: Buffer, maxChars: number): string {
  const source = bytes.toString('latin1');
  const literals = [...source.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)]
    .map((match) => decodePdfLiteral(match[0]).replace(/\s+/g, ' ').trim())
    .filter((value) => /[A-Za-z0-9\u4e00-\u9fff]/.test(value) && value.length > 1);
  if (literals.join(' ').length >= 60) {
    return normalizeExtractedText(literals.join('\n'), maxChars);
  }
  return extractReadableBinaryText(bytes, maxChars);
}

function extractReadableBinaryText(bytes: Buffer, maxChars: number): string {
  const text = bytes.toString('latin1')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]+/g, ' ')
    .replace(/\s{2,}/g, '\n');
  return normalizeExtractedText(text, maxChars);
}

function extractRtfText(body: string, maxChars: number): string {
  const text = body
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\[a-z]+\d* ?/gi, '')
    .replace(/[{}]/g, ' ');
  return normalizeExtractedText(text, maxChars);
}

function extractDocumentPage(fetched: FetchRawResult, requestedUrl: URL, maxChars: number): ReadablePage {
  const kind = inferDocumentKind(fetched, requestedUrl);
  const canonicalUrl = fetched.finalUrl;
  if (kind === 'html') {
    return extractReadablePage(fetched.body, fetched.finalUrl, maxChars);
  }
  if (kind === 'json') {
    let text = fetched.body;
    try {
      text = JSON.stringify(JSON.parse(fetched.body), null, 2);
    } catch {
      text = fetched.body;
    }
    return {
      canonicalUrl,
      extraction: 'json',
      text: normalizeExtractedText(text, maxChars)
    };
  }
  if (kind === 'pdf') {
    return {
      title: requestedUrl.pathname.split('/').pop() || undefined,
      canonicalUrl,
      extraction: 'pdf-text',
      text: extractPdfText(fetched.bytes, maxChars)
    };
  }
  if (kind === 'rtf') {
    return {
      title: requestedUrl.pathname.split('/').pop() || undefined,
      canonicalUrl,
      extraction: 'rtf-text',
      text: extractRtfText(fetched.body, maxChars)
    };
  }
  if (kind === 'xml') {
    return {
      canonicalUrl,
      extraction: 'xml-text',
      text: stripHtmlToText(fetched.body).slice(0, maxChars)
    };
  }
  if (kind === 'text') {
    return {
      canonicalUrl,
      extraction: 'plain-text',
      text: normalizeExtractedText(fetched.body, maxChars)
    };
  }
  if (kind === 'binary-document') {
    return {
      title: requestedUrl.pathname.split('/').pop() || undefined,
      canonicalUrl,
      extraction: 'document-binary-text-fallback',
      text: extractReadableBinaryText(fetched.bytes, maxChars)
    };
  }
  return {
    canonicalUrl,
    extraction: 'binary-text-fallback',
    text: extractReadableBinaryText(fetched.bytes, maxChars)
  };
}

function shouldUseBrowserFallback(fetched: FetchRawResult, page: ReadablePage): boolean {
  if (!getConfiguredWebSearchSettings().browserFallbackEnabled) {
    return false;
  }
  if (inferDocumentKind(fetched, new URL(fetched.finalUrl)) !== 'html') {
    return false;
  }
  const body = fetched.body.toLowerCase();
  return (
    page.text.trim().length < MIN_BROWSER_FALLBACK_TEXT_CHARS ||
    /enable javascript|requires javascript|javascript is disabled|__next_data__|id=["']root["']|id=["']app["']/.test(body)
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function renderPageWithBrowserFallback(url: URL, maxChars: number, options: WebToolExecutionOptions): Promise<ReadablePage | undefined> {
  if (isBlockedHost(url.hostname)) {
    return undefined;
  }
  try {
    const electron = await import('electron');
    const BrowserWindowCtor = electron.BrowserWindow;
    if (!BrowserWindowCtor || typeof BrowserWindowCtor !== 'function' || !electron.app?.isReady?.()) {
      return undefined;
    }
    const window = new BrowserWindowCtor({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    try {
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('web_fetch browser fallback aborted.'));
        options.abortSignal?.addEventListener('abort', abort, { once: true });
        window.once('closed', () => options.abortSignal?.removeEventListener('abort', abort));
      });
      await withTimeout(Promise.race([window.loadURL(url.toString(), { userAgent: WEB_USER_AGENT }), abortPromise]), MAX_WEB_TIMEOUT_MS, 'web_fetch browser fallback');
      await new Promise((resolve) => setTimeout(resolve, 800));
      const rendered = await withTimeout(
        window.webContents.executeJavaScript(`(() => {
          const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
          const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
          return {
            title: document.title || '',
            description: meta('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]'),
            canonicalUrl: canonical,
            text: document.body?.innerText || ''
          };
        })()`),
        5_000,
        'web_fetch browser extraction'
      ) as { title?: string; description?: string; canonicalUrl?: string; text?: string };
      const text = normalizeExtractedText(rendered.text ?? '', maxChars);
      if (!text) {
        return undefined;
      }
      return {
        title: rendered.title || undefined,
        description: rendered.description || undefined,
        canonicalUrl: rendered.canonicalUrl || url.toString(),
        extraction: 'browser-rendered',
        browserFallbackUsed: true,
        text
      };
    } finally {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  } catch {
    return undefined;
  }
}

async function fetchRaw(url: URL, options: WebToolExecutionOptions, maxChars = MAX_WEB_FETCH_CHARS): Promise<FetchRawResult> {
  if (isBlockedHost(url.hostname)) {
    throw new Error('出于安全考虑，web_fetch 默认不访问 localhost、内网或链路本地地址。');
  }
  const abort = createAbortSignal(DEFAULT_WEB_TIMEOUT_MS, options.abortSignal);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      redirect: 'follow',
      headers: {
        'user-agent': WEB_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/pdf,application/xml,application/rtf,*/*;q=0.2'
      }
    });
    const contentType = response.headers.get('content-type') ?? '';
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = bytes.toString('utf8');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(body, 800)}`);
    }
    return {
      finalUrl: response.url,
      contentType,
      body: body.slice(0, Math.max(1000, Math.min(maxChars, MAX_WEB_FETCH_CHARS))),
      bytes,
      byteLength: bytes.byteLength
    };
  } finally {
    abort.cleanup();
  }
}

function normalizeDuckDuckGoUrl(href: string): string {
  const decoded = decodeHtmlEntities(href);
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return decoded;
  }
}

function normalizeSearchDomains(domains: string[] | undefined): string[] {
  return unique((domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, ''))
    .filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)))
    .slice(0, 5);
}

function normalizeSearchResultKey(resultUrl: string): string {
  try {
    const parsed = new URL(resultUrl);
    parsed.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'].forEach((key) => {
      parsed.searchParams.delete(key);
    });
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return resultUrl.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function resultMatchesDomains(resultUrl: string, domains: string[]): boolean {
  if (domains.length === 0) {
    return true;
  }
  try {
    const hostname = new URL(resultUrl).hostname.toLowerCase().replace(/^www\./, '');
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function resultMatchesBlockedDomains(resultUrl: string, blockedDomains: string[]): boolean {
  return blockedDomains.length > 0 && resultMatchesDomains(resultUrl, blockedDomains);
}

function officialSearchScore(result: { title: string; url: string; snippet: string }): number {
  try {
    const parsed = new URL(result.url);
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const text = `${result.title}\n${result.snippet}`.toLowerCase();
    let score = 0;
    if (/(^|\.)docs?\.|developer|developers|learn|reference|api/.test(hostname)) score += 4;
    if (/(\/docs?\/|\/documentation\/|\/reference\/|\/api\/|\/learn\/)/.test(path)) score += 3;
    if (/(official|documentation|docs|reference|api|developer)/.test(text)) score += 2;
    if (/(github\.com|wikipedia\.org|medium\.com|stackoverflow\.com|reddit\.com)/.test(hostname)) score -= 1;
    return score;
  } catch {
    return 0;
  }
}

function readSearchProviderApiKey(provider: 'brave' | 'bing'): string {
  const settings = getConfiguredWebSearchSettings();
  if (provider === 'brave') {
    return settings.braveApiKey?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim() || '';
  }
  return settings.bingApiKey?.trim() || process.env.BING_SEARCH_API_KEY?.trim() || '';
}

function resolveSearchProvider(provider: WebSearchProvider | undefined): Exclude<WebSearchProvider, 'auto'> {
  const configuredProvider = provider ?? getConfiguredWebSearchSettings().provider;
  if (configuredProvider && configuredProvider !== 'auto') {
    return configuredProvider;
  }
  if (readSearchProviderApiKey('brave')) {
    return 'brave';
  }
  if (readSearchProviderApiKey('bing')) {
    return 'bing';
  }
  return 'duckduckgo';
}

function buildSearchQuery(query: string, domains: string[]): string {
  return domains.length
    ? `${query} ${domains.map((domain) => `site:${domain}`).join(' OR ')}`
    : query;
}

async function searchDuckDuckGo(query: string, domains: string[], limit: number, options: WebToolExecutionOptions): Promise<WebSearchResult[]> {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', buildSearchQuery(query, domains));
  const fetched = await fetchRaw(url, options, MAX_WEB_FETCH_CHARS);
  const html = fetched.body;
  const results: WebSearchResult[] = [];
  const resultBlocks = [...html.matchAll(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result|<\/body>)/gi)];
  for (const block of resultBlocks) {
    const source = block[0];
    const anchor = source.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? source.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) {
      continue;
    }
    const title = stripHtmlToText(anchor[2]).replace(/\n+/g, ' ').trim();
    const resultUrl = normalizeDuckDuckGoUrl(anchor[1]);
    if (!title || !/^https?:\/\//i.test(resultUrl) || !resultMatchesDomains(resultUrl, domains)) {
      continue;
    }
    const snippetMatch = source.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      ?? source.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title,
      url: resultUrl,
      snippet: snippetMatch ? stripHtmlToText(snippetMatch[1]).replace(/\n+/g, ' ').trim() : '',
      provider: 'duckduckgo'
    });
    if (results.length >= limit * 3) {
      break;
    }
  }
  return results;
}

async function searchBrave(query: string, domains: string[], limit: number, options: WebToolExecutionOptions): Promise<WebSearchResult[]> {
  const apiKey = readSearchProviderApiKey('brave');
  if (!apiKey) {
    throw new Error('Brave Search API key is required for provider=brave.');
  }
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', buildSearchQuery(query, domains));
  url.searchParams.set('count', String(Math.max(1, Math.min(limit, 10))));
  const abort = createAbortSignal(DEFAULT_WEB_TIMEOUT_MS, options.abortSignal);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: {
        accept: 'application/json',
        'user-agent': WEB_USER_AGENT,
        'x-subscription-token': apiKey
      }
    });
    const body = await response.json() as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };
    if (!response.ok) {
      throw new Error(`Brave Search HTTP ${response.status}: ${JSON.stringify(body).slice(0, 800)}`);
    }
    return (body.web?.results ?? [])
      .map((result) => ({
        title: stripHtmlToText(result.title ?? '').replace(/\n+/g, ' ').trim(),
        url: result.url ?? '',
        snippet: stripHtmlToText(result.description ?? '').replace(/\n+/g, ' ').trim(),
        publishedAt: result.age,
        provider: 'brave' as const
      }))
      .filter((result) => result.title && /^https?:\/\//i.test(result.url) && resultMatchesDomains(result.url, domains));
  } finally {
    abort.cleanup();
  }
}

async function searchBing(query: string, domains: string[], limit: number, options: WebToolExecutionOptions): Promise<WebSearchResult[]> {
  const apiKey = readSearchProviderApiKey('bing');
  if (!apiKey) {
    throw new Error('Bing Search API key is required for provider=bing.');
  }
  const url = new URL('https://api.bing.microsoft.com/v7.0/search');
  url.searchParams.set('q', buildSearchQuery(query, domains));
  url.searchParams.set('count', String(Math.max(1, Math.min(limit, 10))));
  const abort = createAbortSignal(DEFAULT_WEB_TIMEOUT_MS, options.abortSignal);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: {
        accept: 'application/json',
        'user-agent': WEB_USER_AGENT,
        'ocp-apim-subscription-key': apiKey
      }
    });
    const body = await response.json() as {
      webPages?: {
        value?: Array<{
          name?: string;
          url?: string;
          snippet?: string;
          datePublished?: string;
        }>;
      };
    };
    if (!response.ok) {
      throw new Error(`Bing Search HTTP ${response.status}: ${JSON.stringify(body).slice(0, 800)}`);
    }
    return (body.webPages?.value ?? [])
      .map((result) => ({
        title: stripHtmlToText(result.name ?? '').replace(/\n+/g, ' ').trim(),
        url: result.url ?? '',
        snippet: stripHtmlToText(result.snippet ?? '').replace(/\n+/g, ' ').trim(),
        publishedAt: result.datePublished,
        provider: 'bing' as const
      }))
      .filter((result) => result.title && /^https?:\/\//i.test(result.url) && resultMatchesDomains(result.url, domains));
  } finally {
    abort.cleanup();
  }
}

function dedupeSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const output: WebSearchResult[] = [];
  for (const result of results) {
    const key = normalizeSearchResultKey(result.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(result);
  }
  return output;
}

function rankSearchResults(results: WebSearchResult[], preferOfficial: boolean): WebSearchResult[] {
  const deduped = dedupeSearchResults(results);
  if (!preferOfficial) {
    return deduped;
  }
  return deduped
    .map((result, index) => ({ result, index, score: officialSearchScore(result) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.result);
}

function formatSearchSummary(input: {
  query: string;
  provider: Exclude<WebSearchProvider, 'auto'>;
  domains: string[];
  blockedDomains: string[];
  preferOfficial?: boolean;
  results: WebSearchResult[];
  durationMs: number;
  cacheHit: boolean;
}): string {
  const fetchedAt = new Date().toISOString();
  return [
    'Tool: web_search',
    `Provider: ${input.provider}`,
    `Query: ${input.query}`,
    `Fetched-At: ${fetchedAt}`,
    `Duration: ${input.durationMs}ms`,
    `Cache: ${input.cacheHit ? 'hit' : 'miss'}`,
    input.domains.length ? `Domain-Filter: ${input.domains.join(', ')}` : '',
    input.blockedDomains.length ? `Blocked-Domains: ${input.blockedDomains.join(', ')}` : '',
    input.preferOfficial ? 'Ranking: official-docs-first' : '',
    '',
    'Citations:',
    input.results.map((result, index) => {
      const citationId = `S${index + 1}`;
      return [
        `[${citationId}] ${result.title}`,
        `URL: ${result.url}`,
        `Provider: ${result.provider}`,
        result.publishedAt ? `Published: ${result.publishedAt}` : '',
        result.snippet ? `Snippet: ${result.snippet}` : '',
        `Official-Score: ${officialSearchScore(result)}`
      ].filter(Boolean).join('\n');
    }).join('\n\n')
  ].filter((line) => line !== '').join('\n');
}

function formatFetchSummary(input: {
  requestedUrl: string;
  fetched: FetchRawResult;
  page: ReadablePage;
  durationMs: number;
  cacheHit: boolean;
  maxChars: number;
}): string {
  const citationUrl = input.page.canonicalUrl || input.fetched.finalUrl;
  const citationTitle = input.page.title || citationUrl;
  return [
    'Tool: web_fetch',
    `Requested-URL: ${input.requestedUrl}`,
    `Final-URL: ${input.fetched.finalUrl}`,
    `Fetched-At: ${new Date().toISOString()}`,
    `Duration: ${input.durationMs}ms`,
    `Cache: ${input.cacheHit ? 'hit' : 'miss'}`,
    input.fetched.contentType ? `Content-Type: ${input.fetched.contentType}` : '',
    `Bytes: ${input.fetched.byteLength}`,
    `Extraction: ${input.page.extraction}`,
    input.page.browserFallbackUsed ? 'Browser-Fallback: rendered-page' : '',
    '',
    'Citation:',
    `[F1] ${citationTitle}`,
    `URL: ${citationUrl}`,
    input.page.description ? `Description: ${input.page.description}` : '',
    '',
    'Extracted-Text:',
    truncate(input.page.text.trim() || '(empty response)', input.maxChars)
  ].filter((line) => line !== '').join('\n');
}

export async function performWebSearchAction(action: WebSearchInput, options: WebToolExecutionOptions = {}): Promise<WebToolActionResult> {
  const startedAt = Date.now();
  const normalizedQuery = action.query.trim();
  if (!normalizedQuery) {
    throw new Error('web_search 缺少 query。');
  }
  const provider = resolveSearchProvider(action.provider);
  const domains = normalizeSearchDomains(action.domains);
  const blockedDomains = normalizeSearchDomains(action.blockedDomains);
  const limit = Math.max(1, Math.min(action.maxResults ?? 5, MAX_WEB_SEARCH_RESULTS));
  const cacheKey = JSON.stringify({
    provider,
    query: normalizedQuery,
    domains,
    blockedDomains,
    limit,
    preferOfficial: Boolean(action.preferOfficial)
  });
  const cached = readCache(searchCache, cacheKey);
  if (cached) {
    recordMetrics({
      kind: 'search',
      provider,
      cacheHit: true,
      durationMs: Date.now() - startedAt,
      ok: cached.ok
    });
    return {
      ...cached,
      summary: cached.summary.replace(/^Cache: miss$/m, 'Cache: hit')
    };
  }

  try {
    const rawResults =
      provider === 'brave'
        ? await searchBrave(normalizedQuery, domains, limit, options)
        : provider === 'bing'
          ? await searchBing(normalizedQuery, domains, limit, options)
          : await searchDuckDuckGo(normalizedQuery, domains, limit, options);
    const selected = rankSearchResults(
      rawResults.filter((result) => !resultMatchesBlockedDomains(result.url, blockedDomains)),
      Boolean(action.preferOfficial)
    ).slice(0, limit);
    const durationMs = Date.now() - startedAt;
    const result: WebToolActionResult = selected.length === 0
      ? {
          ok: true,
          summary: [
            'Tool: web_search',
            `Provider: ${provider}`,
            `Query: ${normalizedQuery}`,
            `Duration: ${durationMs}ms`,
            'Cache: miss',
            domains.length ? `Domain-Filter: ${domains.join(', ')}` : '',
            blockedDomains.length ? `Blocked-Domains: ${blockedDomains.join(', ')}` : '',
            '',
            `没有找到可解析的网络搜索结果：${normalizedQuery}${domains.length ? ` (domains: ${domains.join(', ')})` : ''}`
          ].filter((line) => line !== '').join('\n')
        }
      : {
          ok: true,
          summary: formatSearchSummary({
            query: normalizedQuery,
            provider,
            domains,
            blockedDomains,
            preferOfficial: action.preferOfficial,
            results: selected,
            durationMs,
            cacheHit: false
          })
        };
    writeCache(searchCache, cacheKey, result);
    recordMetrics({
      kind: 'search',
      provider,
      cacheHit: false,
      durationMs,
      ok: true
    });
    return result;
  } catch (error) {
    recordMetrics({
      kind: 'search',
      provider,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      ok: false
    });
    throw error;
  }
}

export async function performWebFetchAction(action: WebFetchInput, options: WebToolExecutionOptions = {}): Promise<WebToolActionResult> {
  const startedAt = Date.now();
  const url = normalizeWebUrl(action.url);
  const maxChars = Math.max(1000, Math.min(action.maxChars ?? MAX_WEB_FETCH_CHARS, MAX_WEB_FETCH_CHARS));
  const cacheKey = JSON.stringify({
    url: url.toString(),
    maxChars
  });
  const cached = readCache(fetchCache, cacheKey);
  if (cached) {
    recordMetrics({
      kind: 'fetch',
      cacheHit: true,
      durationMs: Date.now() - startedAt,
      ok: cached.ok
    });
    return {
      ...cached,
      summary: cached.summary.replace(/^Cache: miss$/m, 'Cache: hit')
    };
  }

  try {
    const fetched = await fetchRaw(url, options, maxChars);
    const initialPage = extractDocumentPage(fetched, url, maxChars);
    const browserPage = shouldUseBrowserFallback(fetched, initialPage)
      ? await renderPageWithBrowserFallback(new URL(fetched.finalUrl), maxChars, options)
      : undefined;
    const page = browserPage && browserPage.text.length > initialPage.text.length ? browserPage : initialPage;
    const result = {
      ok: true,
      summary: formatFetchSummary({
        requestedUrl: url.toString(),
        fetched,
        page,
        durationMs: Date.now() - startedAt,
        cacheHit: false,
        maxChars
      })
    };
    writeCache(fetchCache, cacheKey, result);
    recordMetrics({
      kind: 'fetch',
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      ok: true,
      extraction: page.extraction,
      browserFallbackUsed: Boolean(page.browserFallbackUsed),
      documentExtraction: !['html-static', 'browser-rendered', 'json', 'plain-text', 'xml-text'].includes(page.extraction)
    });
    return result;
  } catch (error) {
    recordMetrics({
      kind: 'fetch',
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      ok: false
    });
    throw error;
  }
}

function countCitations(summary: string): number {
  return [...summary.matchAll(/^\[(?:S|F)\d+\]\s+/gm)].length;
}

function summaryContainsDomain(summary: string, domain: string): boolean {
  return new RegExp(`https?://(?:[^/]+\\.)?${domain.replace(/\./g, '\\.')}(?:/|$)`, 'i').test(summary);
}

export async function runWebSearchQualityEval(options: WebToolExecutionOptions = {}): Promise<WebSearchQualityReport> {
  const runId = `web_eval_${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const cases = [
    {
      id: 'official-openai-docs',
      query: 'OpenAI API official documentation Responses API',
      requiredDomain: 'openai.com'
    },
    {
      id: 'electron-browserwindow-docs',
      query: 'Electron BrowserWindow official documentation',
      requiredDomain: 'electronjs.org'
    },
    {
      id: 'typescript-release-notes',
      query: 'TypeScript official release notes',
      requiredDomain: 'typescriptlang.org'
    }
  ];
  const results: WebSearchQualityCaseResult[] = [];

  for (const testCase of cases) {
    const caseStartedAt = Date.now();
    const provider = resolveSearchProvider(undefined);
    try {
      const result = await performWebSearchAction({
        query: testCase.query,
        maxResults: 5,
        preferOfficial: true,
        domains: [testCase.requiredDomain]
      }, options);
      const citationCount = countCitations(result.summary);
      results.push({
        id: testCase.id,
        query: testCase.query,
        provider,
        ok: result.ok && citationCount > 0 && summaryContainsDomain(result.summary, testCase.requiredDomain),
        durationMs: Date.now() - caseStartedAt,
        citationCount,
        requiredDomain: testCase.requiredDomain
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        query: testCase.query,
        provider,
        ok: false,
        durationMs: Date.now() - caseStartedAt,
        citationCount: 0,
        requiredDomain: testCase.requiredDomain,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const totalDurationMs = results.reduce((total, item) => total + item.durationMs, 0);
  const passedCases = results.filter((item) => item.ok).length;
  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    averageDurationMs: results.length ? Math.round(totalDurationMs / results.length) : 0,
    cases: results
  };
}
