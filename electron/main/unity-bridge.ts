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

async function buildCandidateUrls(baseUrl: string): Promise<string[]> {
  const normalizedBaseUrl = normalizeMcpBaseUrl(baseUrl);
  const ports = await discoverUnityListenPorts();
  const urls = [
    normalizedBaseUrl,
    'http://127.0.0.1:8765/',
    ...ports.map((port) => `http://127.0.0.1:${port}/`)
  ];
  return [...new Set(urls)];
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

export async function checkUnityHealth(baseUrl: string, options: { expectedProjectPath?: string; bypassCache?: boolean } = {}): Promise<UnityHealthResult> {
  const cacheKey = makeHealthCacheKey(baseUrl, options.expectedProjectPath);
  if (!options.bypassCache) {
    const cached = readCachedHealth(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const checkedAt = new Date().toISOString();
  const candidateUrls = await buildCandidateUrls(baseUrl);
  const failures: string[] = [];

  for (const url of candidateUrls) {
    const result = await probeMcpJsonRpc(url, options.expectedProjectPath);
    if (result) {
      return writeCachedHealth(cacheKey, {
        status: 'online',
        checkedAt,
        url,
        projectPath: result.projectPath,
        message: `Unity MCP 已连通：${result.serverInfo}。`
      });
    }
    failures.push(url);
  }

  return writeCachedHealth(cacheKey, {
    status: 'offline',
    checkedAt,
    url: normalizeMcpBaseUrl(baseUrl),
    message: options.expectedProjectPath
      ? `Unity MCP 连接失败或项目不匹配：目标项目 ${normalizeProjectPathForCompare(options.expectedProjectPath)}，已尝试 ${failures.join('、') || normalizeMcpBaseUrl(baseUrl)}`
      : `Unity MCP 连接失败：已尝试 ${failures.join('、') || normalizeMcpBaseUrl(baseUrl)}`
  });
}

export async function reconnectUnityHealth(baseUrl: string): Promise<UnityHealthResult> {
  const serverInfo = await reconnectMcpConnection(baseUrl);
  const checkedAt = new Date().toISOString();
  const url = normalizeMcpBaseUrl(baseUrl);
  healthCache.delete(makeHealthCacheKey(baseUrl));
  return writeCachedHealth(makeHealthCacheKey(baseUrl), {
    status: 'online',
    checkedAt,
    url,
    message: `Unity MCP 已重新连接：${serverInfo.name} ${serverInfo.version}。`
  });
}
