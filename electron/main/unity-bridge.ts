import type { UnityHealthResult } from '../../shared/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeMcpConnection,
  normalizeMcpBaseUrl,
  postMcpJsonRpc,
  reconnectMcpConnection
} from './mcp-connection-manager';

const execFileAsync = promisify(execFile);
const HEALTH_ONLINE_CACHE_TTL_MS = 30_000;
const HEALTH_OFFLINE_CACHE_TTL_MS = 10_000;

type UnityHealthCacheEntry = {
  expiresAt: number;
  result: UnityHealthResult;
};

const healthCache = new Map<string, UnityHealthCacheEntry>();

function normalizeProjectPathForCompare(projectPath: string): string {
  const expanded = projectPath.trim().replace(/^~/, process.env.HOME ?? '~');
  const normalized = resolve(expanded).replace(/\/+$/g, '');
  try {
    return existsSync(normalized) ? realpathSync(normalized).replace(/\/+$/g, '') : normalized;
  } catch {
    return normalized;
  }
}

function makeHealthCacheKey(baseUrl: string, expectedProjectPath?: string): string {
  return [
    normalizeMcpBaseUrl(baseUrl),
    expectedProjectPath ? normalizeProjectPathForCompare(expectedProjectPath) : ''
  ].join('\n');
}

function readCachedHealth(cacheKey: string): UnityHealthResult | undefined {
  const cached = healthCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    healthCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function writeCachedHealth(cacheKey: string, result: UnityHealthResult): UnityHealthResult {
  healthCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + (result.status === 'online' ? HEALTH_ONLINE_CACHE_TTL_MS : HEALTH_OFFLINE_CACHE_TTL_MS)
  });
  return result;
}

function extractProjectPathFromText(text: string): string | undefined {
  const match = text.match(/^\s*-\s*Project Path:\s*(.+?)\s*$/m);
  return match?.[1]?.trim();
}

async function discoverUnityListenPorts(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-a', '-c', 'Unity', '-iTCP', '-sTCP:LISTEN'], {
      timeout: 1500,
      maxBuffer: 512 * 1024
    });
    const ports = [...stdout.matchAll(/(?:127\.0\.0\.1|\*|\[::1\]):(\d+)\s+\(LISTEN\)/g)]
      .map((match) => Number(match[1]))
      .filter((port) => Number.isInteger(port) && port > 0);
    return [...new Set(ports)];
  } catch {
    return [];
  }
}

async function readMcpProjectPath(url: string, abortSignal: AbortSignal): Promise<string | undefined> {
  const result = await postMcpJsonRpc<{
    content?: Array<{ text?: string }>;
    contents?: Array<{ text?: string }>;
  }>(url, 'resources/read', {
    uri: 'unity://project/context'
  }, false, abortSignal, 1500);
  const rawContent = result.content ?? result.contents ?? [];
  const text = rawContent.map((part) => part.text).find((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return text ? extractProjectPathFromText(text) : undefined;
}

async function probeMcpJsonRpc(url: string, expectedProjectPath?: string): Promise<{ serverInfo: string; projectPath?: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const serverInfo = await initializeMcpConnection(url, {
      abortSignal: controller.signal
    });
    const projectPath = expectedProjectPath ? await readMcpProjectPath(url, controller.signal) : undefined;
    if (expectedProjectPath) {
      if (!projectPath) {
        return null;
      }
      if (normalizeProjectPathForCompare(projectPath) !== normalizeProjectPathForCompare(expectedProjectPath)) {
        return null;
      }
    }
    return {
      serverInfo: `${serverInfo.name} ${serverInfo.version}`,
      projectPath
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Probe a set of URLs concurrently and resolve to the first that is online (and,
// when an expected project path is given, matching) — or null once all fail.
// Bounds offline detection to ~one probe timeout instead of summing them.
async function raceFirstOnlineProbe(
  urls: string[],
  expectedProjectPath?: string
): Promise<{ url: string; result: { serverInfo: string; projectPath?: string } } | null> {
  if (urls.length === 0) {
    return null;
  }
  return new Promise((resolve) => {
    let remaining = urls.length;
    let settled = false;
    for (const url of urls) {
      void probeMcpJsonRpc(url, expectedProjectPath).then((result) => {
        if (settled) {
          return;
        }
        if (result) {
          settled = true;
          resolve({ url, result });
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          resolve(null);
        }
      });
    }
  });
}

export async function checkUnityHealth(baseUrl: string, options: { expectedProjectPath?: string; bypassCache?: boolean } = {}): Promise<UnityHealthResult> {
  const cacheKey = makeHealthCacheKey(baseUrl, options.expectedProjectPath);
  if (!options.bypassCache) {
    const cached = readCachedHealth(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const checkedAt = new Date().toISOString();
  const normalizedBaseUrl = normalizeMcpBaseUrl(baseUrl);
  const ports = await discoverUnityListenPorts();
  // Tier 1: the configured endpoint + the default port (prefer these over any
  // arbitrary discovered editor when the project identity can't be verified).
  // Tier 2: other discovered Unity listen ports, only if tier 1 is offline.
  const primaryUrls = [...new Set([normalizedBaseUrl, 'http://127.0.0.1:8765/'])];
  const discoveredUrls = [...new Set(ports.map((port) => `http://127.0.0.1:${port}/`))].filter(
    (url) => !primaryUrls.includes(url)
  );

  const hit =
    (await raceFirstOnlineProbe(primaryUrls, options.expectedProjectPath)) ??
    (await raceFirstOnlineProbe(discoveredUrls, options.expectedProjectPath));

  if (hit) {
    return writeCachedHealth(cacheKey, {
      status: 'online',
      checkedAt,
      url: hit.url,
      projectPath: hit.result.projectPath,
      message: `Unity MCP 已连通：${hit.result.serverInfo}。`
    });
  }

  const attempted = [...primaryUrls, ...discoveredUrls].join('、') || normalizedBaseUrl;
  return writeCachedHealth(cacheKey, {
    status: 'offline',
    checkedAt,
    url: normalizedBaseUrl,
    message: options.expectedProjectPath
      ? `Unity MCP 连接失败或项目不匹配：目标项目 ${normalizeProjectPathForCompare(options.expectedProjectPath)}，已尝试 ${attempted}`
      : `Unity MCP 连接失败：已尝试 ${attempted}`
  });
}

export async function reconnectUnityHealth(baseUrl: string, expectedProjectPath?: string): Promise<UnityHealthResult> {
  const checkedAt = new Date().toISOString();
  const url = normalizeMcpBaseUrl(baseUrl);
  // Cache under the SAME project-scoped key that project-scoped readers use, not
  // a project-less key they never look up (which made the write dead).
  const cacheKey = makeHealthCacheKey(baseUrl, expectedProjectPath);
  healthCache.delete(cacheKey);

  try {
    const serverInfo = await reconnectMcpConnection(baseUrl);
    // Verify the editor that answered actually serves this project — otherwise a
    // different Unity editor listening at the port would be falsely confirmed.
    if (expectedProjectPath) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const projectPath = await readMcpProjectPath(url, controller.signal).catch(() => undefined);
        if (
          !projectPath ||
          normalizeProjectPathForCompare(projectPath) !== normalizeProjectPathForCompare(expectedProjectPath)
        ) {
          return writeCachedHealth(cacheKey, {
            status: 'offline',
            checkedAt,
            url,
            projectPath,
            message: projectPath
              ? `Unity MCP 已响应，但当前连接的是 ${projectPath}，不是目标项目 ${expectedProjectPath}。`
              : 'Unity MCP 已响应，但还不能确认它连接的是当前项目。'
          });
        }
        return writeCachedHealth(cacheKey, {
          status: 'online',
          checkedAt,
          url,
          projectPath,
          message: `Unity MCP 已重新连接：${serverInfo.name} ${serverInfo.version}。`
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return writeCachedHealth(cacheKey, {
      status: 'online',
      checkedAt,
      url,
      message: `Unity MCP 已重新连接：${serverInfo.name} ${serverInfo.version}。`
    });
  } catch (error) {
    return writeCachedHealth(cacheKey, {
      status: 'offline',
      checkedAt,
      url,
      message: `Unity MCP 重新连接失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
}
