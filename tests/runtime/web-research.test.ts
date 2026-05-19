import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DEFAULT_AI_SETTINGS } from '../../shared/types.ts';
import { initializeStore, setState, getState } from '../../electron/main/store.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { getAgentToolDefinition } from '../../electron/main/agent-platform/tool-registry.ts';
import {
  clearWebResearchCache,
  getWebResearchMetrics,
  resetWebResearchMetrics,
  runWebSearchQualityEval
} from '../../electron/main/agent-platform/web-research-service.ts';
import { buildProject } from './test-helpers.ts';

test('native web_fetch extracts readable citations and uses cache metrics', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end([
      '<html>',
      '<head>',
      '<title>Runtime Fetch Title</title>',
      '<meta name="description" content="Readable page description">',
      '</head>',
      '<body>',
      '<nav>Navigation should be ignored</nav>',
      '<article><h1>Runtime Web Fetch</h1><p>Hello from a test page.</p></article>',
      '</body>',
      '</html>'
    ].join(''));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const previous = process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
  process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = '1';
  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_fetch',
      url: `http://127.0.0.1:${address.port}/page`
    });
    assert.equal(result.ok, true);
    assert.match(result.summary, /Tool: web_fetch/);
    assert.match(result.summary, /Citation:\n\[F1\] Runtime Fetch Title/);
    assert.match(result.summary, /Description: Readable page description/);
    assert.match(result.summary, /Runtime Web Fetch/);
    assert.match(result.summary, /Hello from a test page/);
    assert.doesNotMatch(result.summary, /Navigation should be ignored/);

    const cached = await executeAgentToolAction(buildProject(), {
      type: 'web_fetch',
      url: `http://127.0.0.1:${address.port}/page`
    });
    assert.equal(cached.ok, true);
    assert.match(cached.summary, /Cache: hit/);
    assert.equal(requestCount, 1);
    const metrics = getWebResearchMetrics();
    assert.equal(metrics.fetchRequests, 2);
    assert.equal(metrics.cacheHits, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
    } else {
      process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = previous;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    clearWebResearchCache();
  }
});

test('native web_fetch extracts PDF-like document text and tracks document extraction metrics', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end(Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog >> endobj',
      '2 0 obj << /Length 44 >> stream',
      'BT /F1 12 Tf 72 720 Td (PDF Runtime Extraction Works) Tj ET',
      'endstream endobj',
      '%%EOF'
    ].join('\n'), 'utf8'));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const previous = process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
  process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = '1';
  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_fetch',
      url: `http://127.0.0.1:${address.port}/runtime.pdf`
    });
    assert.equal(result.ok, true);
    assert.match(result.summary, /Content-Type: application\/pdf/);
    assert.match(result.summary, /Extraction: pdf-text/);
    assert.match(result.summary, /PDF Runtime Extraction Works/);
    const metrics = getWebResearchMetrics();
    assert.equal(metrics.fetchRequests, 1);
    assert.equal(metrics.documentExtractions, 1);
    assert.equal(metrics.lastRequest?.extraction, 'pdf-text');
  } finally {
    if (previous === undefined) {
      delete process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS;
    } else {
      process.env.FUNPLAY_ALLOW_LOCAL_WEB_TOOLS = previous;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    clearWebResearchCache();
  }
});

test('native web_search returns citations, filters domains, caches, and tracks metrics', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const webSearchDefinition = getAgentToolDefinition('web_search');
  assert.ok(webSearchDefinition);
  assert.equal(webSearchDefinition.inputSchema.safeParse({
    query: 'release notes',
    domains: ['react.dev', 'developer.mozilla.org', 'typescriptlang.org', 'nodejs.org', 'vite.dev', 'electronjs.org'],
    blockedDomains: ['spam.example']
  }).success, true);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (url) => {
    requestCount += 1;
    assert.match(String(url), /duckduckgo\.com\/html/);
    return new Response([
      '<html><body>',
      '<div class="result">',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fblog.example%2Freact">Blog Result</a>',
      '<div class="result__snippet">Filtered out.</div>',
      '</div>',
      '<div class="result">',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact">React Reference</a>',
      '<div class="result__snippet">Official React API reference.</div>',
      '</div>',
      '<div class="result">',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Freact.dev%2Freference%2Freact%3Futm_source%3Ddupe">React Reference Duplicate</a>',
      '<div class="result__snippet">Duplicate URL after normalization.</div>',
      '</div>',
      '</body></html>'
    ].join(''), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    });
  }) as typeof fetch;

  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_search',
      provider: 'duckduckgo',
      query: 'react reference',
      domains: ['react.dev', 'blog.example'],
      blockedDomains: ['blog.example'],
      preferOfficial: true,
      maxResults: 5
    });
    assert.equal(result.ok, true);
    assert.match(result.summary, /Tool: web_search/);
    assert.match(result.summary, /Provider: duckduckgo/);
    assert.match(result.summary, /Domain-Filter: react\.dev, blog\.example/);
    assert.match(result.summary, /Blocked-Domains: blog\.example/);
    assert.match(result.summary, /\[S1\] React Reference/);
    assert.match(result.summary, /URL: https:\/\/react\.dev\/reference\/react/);
    assert.doesNotMatch(result.summary, /Blog Result/);
    assert.doesNotMatch(result.summary, /Duplicate URL/);

    const cached = await executeAgentToolAction(buildProject(), {
      type: 'web_search',
      provider: 'duckduckgo',
      query: 'react reference',
      domains: ['react.dev', 'blog.example'],
      blockedDomains: ['blog.example'],
      preferOfficial: true,
      maxResults: 5
    });
    assert.match(cached.summary, /Cache: hit/);
    assert.equal(requestCount, 1);
    const metrics = getWebResearchMetrics();
    assert.equal(metrics.searchRequests, 2);
    assert.equal(metrics.cacheHits, 1);
    assert.equal(metrics.providerRequests.duckduckgo, 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearWebResearchCache();
  }
});

test('native web_search supports Brave provider when configured', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.BRAVE_SEARCH_API_KEY;
  let capturedUrl = '';
  let capturedToken = '';
  process.env.BRAVE_SEARCH_API_KEY = 'brave-test-key';
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    const headers = init?.headers as Record<string, string>;
    capturedToken = headers['x-subscription-token'];
    return new Response(JSON.stringify({
      web: {
        results: [
          {
            title: 'MDN Fetch API',
            url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
            description: 'Official MDN Fetch API reference.',
            age: '2026-04-20'
          }
        ]
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_search',
      provider: 'brave',
      query: 'fetch api',
      domains: ['developer.mozilla.org'],
      maxResults: 1
    });
    assert.equal(result.ok, true);
    assert.match(capturedUrl, /api\.search\.brave\.com\/res\/v1\/web\/search/);
    assert.equal(capturedToken, 'brave-test-key');
    assert.match(result.summary, /Provider: brave/);
    assert.match(result.summary, /\[S1\] MDN Fetch API/);
    assert.match(result.summary, /Published: 2026-04-20/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousKey;
    }
    clearWebResearchCache();
  }
});

test('native web_search reads provider keys from persisted web search settings', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-web-search-settings-'));
  const originalFetch = globalThis.fetch;
  const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
  const previousBingKey = process.env.BING_SEARCH_API_KEY;
  let capturedToken = '';
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BING_SEARCH_API_KEY;
  await initializeStore(userDataPath);
  await setState({
    ...getState(),
    aiSettings: {
      ...getState().aiSettings,
      webSearch: {
        ...getState().aiSettings.webSearch,
        provider: 'brave',
        braveApiKey: 'persisted-brave-key'
      }
    }
  });
  globalThis.fetch = (async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    capturedToken = headers['x-subscription-token'];
    return new Response(JSON.stringify({
      web: {
        results: [
          {
            title: 'Configured Provider Result',
            url: 'https://docs.example.com/result',
            description: 'Result from persisted provider settings.'
          }
        ]
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_search',
      query: 'configured provider',
      domains: ['docs.example.com'],
      maxResults: 1
    });
    assert.equal(result.ok, true);
    assert.equal(capturedToken, 'persisted-brave-key');
    assert.match(result.summary, /Provider: brave/);
    assert.match(result.summary, /\[S1\] Configured Provider Result/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBraveKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
    }
    if (previousBingKey === undefined) {
      delete process.env.BING_SEARCH_API_KEY;
    } else {
      process.env.BING_SEARCH_API_KEY = previousBingKey;
    }
    await setState({
      ...getState(),
      aiSettings: DEFAULT_AI_SETTINGS
    });
    await rm(userDataPath, { recursive: true, force: true });
    clearWebResearchCache();
  }
});

test('native web_search auto-selects Bing provider when configured', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const originalFetch = globalThis.fetch;
  const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
  const previousBingKey = process.env.BING_SEARCH_API_KEY;
  let capturedUrl = '';
  let capturedKey = '';
  delete process.env.BRAVE_SEARCH_API_KEY;
  process.env.BING_SEARCH_API_KEY = 'bing-test-key';
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    const headers = init?.headers as Record<string, string>;
    capturedKey = headers['ocp-apim-subscription-key'];
    return new Response(JSON.stringify({
      webPages: {
        value: [
          {
            name: 'TypeScript Handbook',
            url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
            snippet: 'The official TypeScript handbook.',
            datePublished: '2026-04-18'
          }
        ]
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }) as typeof fetch;

  try {
    const result = await executeAgentToolAction(buildProject(), {
      type: 'web_search',
      provider: 'auto',
      query: 'typescript handbook',
      domains: ['typescriptlang.org'],
      maxResults: 1
    });
    assert.equal(result.ok, true);
    assert.match(capturedUrl, /api\.bing\.microsoft\.com\/v7\.0\/search/);
    assert.equal(capturedKey, 'bing-test-key');
    assert.match(result.summary, /Provider: bing/);
    assert.match(result.summary, /\[S1\] TypeScript Handbook/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBraveKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
    }
    if (previousBingKey === undefined) {
      delete process.env.BING_SEARCH_API_KEY;
    } else {
      process.env.BING_SEARCH_API_KEY = previousBingKey;
    }
    clearWebResearchCache();
  }
});

test('web search quality evaluation returns structured citation results', async () => {
  clearWebResearchCache();
  resetWebResearchMetrics();
  const originalFetch = globalThis.fetch;
  const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
  const previousBingKey = process.env.BING_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BING_SEARCH_API_KEY;
  globalThis.fetch = (async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get('q') ?? '';
    const domain = query.includes('electronjs.org')
      ? 'electronjs.org'
      : query.includes('typescriptlang.org')
        ? 'typescriptlang.org'
        : 'openai.com';
    return new Response([
      '<html><body>',
      '<div class="result">',
      `<a class="result__a" href="/l/?uddg=${encodeURIComponent(`https://${domain}/docs`)}">${domain} Docs</a>`,
      '<div class="result__snippet">Official documentation result.</div>',
      '</div>',
      '</body></html>'
    ].join(''), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    });
  }) as typeof fetch;

  try {
    const report = await runWebSearchQualityEval();
    assert.equal(report.totalCases, 3);
    assert.equal(report.passedCases, 3);
    assert.equal(report.failedCases, 0);
    assert.equal(report.cases.every((item) => item.citationCount === 1), true);
    assert.equal(getWebResearchMetrics().searchRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBraveKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
    }
    if (previousBingKey === undefined) {
      delete process.env.BING_SEARCH_API_KEY;
    } else {
      process.env.BING_SEARCH_API_KEY = previousBingKey;
    }
    clearWebResearchCache();
  }
});
