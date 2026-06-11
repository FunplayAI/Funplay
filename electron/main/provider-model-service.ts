import type { AiProvider, AiProviderModel, AiProviderModelListRequest, AiProviderModelListResult, AppState } from '../../shared/types';
import {
  getProviderPresetDefaults,
  inferOpenAiCompatibleApiMode,
  normalizeProviderAuthStyle
} from '../../shared/provider-catalog';
import {
  normalizeProviderChunkTimeoutMs,
  normalizeProviderContextWindowTokens,
  normalizeProviderMaxOutputTokens,
  normalizeProviderRequestTimeoutMs
} from './provider-runtime-options';
import { nowIso } from '../../shared/utils';

const MODEL_LIST_LIMIT = 100;

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeBaseUrlForProvider(provider: AiProvider): string {
  const baseUrl = trimSlash(provider.baseUrl);
  if (!baseUrl) {
    return baseUrl;
  }
  try {
    const parsed = new URL(baseUrl);
    const marker = `${provider.name} ${parsed.hostname}`.toLowerCase();
    if (
      marker.includes('packy') &&
      parsed.hostname === 'www.packyapi.com' &&
      parsed.pathname.replace(/\/+$/, '') === ''
    ) {
      parsed.pathname = '/v1';
      return trimSlash(parsed.toString());
    }
  } catch {
    return baseUrl;
  }
  return baseUrl;
}

function removeKnownCompletionPath(pathname: string): string {
  return pathname
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/models$/i, '');
}

function buildModelListUrl(provider: AiProvider): string {
  const baseUrl = normalizeBaseUrlForProvider(provider);
  if (!baseUrl) {
    throw new Error('Base URL is required before fetching models.');
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Base URL must be a valid URL before fetching models.');
  }

  const path = removeKnownCompletionPath(parsed.pathname);
  if (provider.protocol === 'anthropic') {
    parsed.pathname = path && path !== '/' && /\/v\d+(?:\/|$)/i.test(path) ? `${path}/models` : '/v1/models';
  } else if (provider.protocol === 'google') {
    parsed.pathname = path && path !== '/' && /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(path) ? `${path}/models` : '/v1beta/models';
  } else {
    parsed.pathname = `${path && path !== '/' ? path : '/v1'}/models`;
  }
  return parsed.toString();
}

function buildProviderForModelList(state: AppState, request: AiProviderModelListRequest): AiProvider {
  const current = request.providerId
    ? state.providers.find((provider) => provider.id === request.providerId)
    : undefined;
  const input = request.provider;
  const presetDefaults = getProviderPresetDefaults(input);
  const apiKey = input.apiKey.trim() || current?.apiKey.trim() || '';
  return {
    id: current?.id ?? 'provider-preview',
    name: input.name.trim(),
    protocol: input.protocol,
    apiMode: input.protocol === 'openai-compatible' ? inferOpenAiCompatibleApiMode(input) : undefined,
    authStyle: normalizeProviderAuthStyle({
      authStyle: input.authStyle ?? current?.authStyle ?? presetDefaults.authStyle,
      protocol: input.protocol,
      baseUrl: input.baseUrl
    }),
    baseUrl: input.baseUrl.trim(),
    apiKey,
    hasStoredApiKey: Boolean(apiKey),
    model: input.model.trim(),
    upstreamModel: input.upstreamModel?.trim() || current?.upstreamModel || presetDefaults.upstreamModel,
    headers: input.headers ?? current?.headers ?? presetDefaults.headers,
    envOverrides: input.envOverrides ?? current?.envOverrides ?? presetDefaults.envOverrides,
    availableModels: input.availableModels ?? current?.availableModels ?? presetDefaults.availableModels,
    providerMeta: input.providerMeta ?? current?.providerMeta ?? presetDefaults.providerMeta,
    contextWindowTokens: normalizeProviderContextWindowTokens(input.contextWindowTokens),
    maxOutputTokens: normalizeProviderMaxOutputTokens(input.maxOutputTokens),
    requestTimeoutMs: normalizeProviderRequestTimeoutMs(input.requestTimeoutMs),
    chunkTimeoutMs: normalizeProviderChunkTimeoutMs(input.chunkTimeoutMs),
    enabled: input.enabled ?? current?.enabled ?? true,
    isDefault: current?.isDefault ?? false,
    notes: input.notes?.trim() ?? current?.notes ?? '',
    createdAt: current?.createdAt ?? nowIso(),
    updatedAt: nowIso()
  };
}

function buildModelListHeaders(provider: AiProvider): Record<string, string> {
  const headers: Record<string, string> = {
    ...(provider.headers ?? {}),
    Accept: 'application/json'
  };
  const apiKey = provider.apiKey.trim();
  if (!apiKey) {
    return headers;
  }
  if (provider.protocol === 'anthropic' && provider.authStyle !== 'auth_token') {
    headers['x-api-key'] = headers['x-api-key'] ?? apiKey;
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    return headers;
  }
  if (provider.protocol !== 'google' && !headers.Authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchModelListJson(provider: AiProvider, url: string): Promise<unknown> {
  const requestUrl = new URL(url);
  if (provider.protocol === 'google') {
    requestUrl.searchParams.set('key', provider.apiKey.trim());
  }
  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: buildModelListHeaders(provider),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500);
    throw new Error(`Model list request failed (${response.status}): ${detail}`);
  }
  return body;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

function normalizeRemoteModelEntry(item: unknown, provider: AiProvider): AiProviderModel | undefined {
  if (typeof item === 'string') {
    return { modelId: item };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const rawId = readString(record, ['id', 'model', 'name', 'modelId']);
  if (!rawId) {
    return undefined;
  }
  const modelId = provider.protocol === 'google' ? rawId.replace(/^models\//, '') : rawId;
  const displayName = readString(record, ['display_name', 'displayName', 'name', 'description']);
  const contextWindow = readNumber(record, ['context_window', 'contextWindow', 'context_length', 'contextLength', 'inputTokenLimit', 'max_context_length']);
  const maxOutputTokens = readNumber(record, ['max_output_tokens', 'maxOutputTokens', 'outputTokenLimit', 'max_tokens']);
  const supportedMethods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods.map(String) : [];
  return {
    modelId,
    upstreamModelId: rawId !== modelId ? rawId : undefined,
    displayName: displayName && displayName !== rawId ? displayName : undefined,
    capabilities: {
      toolUse: supportedMethods.length ? supportedMethods.some((method) => /generate|tool/i.test(method)) : undefined,
      contextWindow,
      maxOutputTokens
    }
  };
}

function extractModelEntries(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (!body || typeof body !== 'object') {
    return [];
  }
  const record = body as Record<string, unknown>;
  for (const key of ['data', 'models', 'items']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function normalizeRemoteModels(body: unknown, provider: AiProvider): AiProviderModel[] {
  const byId = new Map<string, AiProviderModel>();
  for (const item of extractModelEntries(body)) {
    const model = normalizeRemoteModelEntry(item, provider);
    if (!model?.modelId || byId.has(model.modelId)) {
      continue;
    }
    byId.set(model.modelId, model);
    if (byId.size >= MODEL_LIST_LIMIT) {
      break;
    }
  }
  return [...byId.values()];
}

export async function listProviderModels(state: AppState, request: AiProviderModelListRequest): Promise<AiProviderModelListResult> {
  const provider = buildProviderForModelList(state, request);
  if (!provider.baseUrl.trim()) {
    throw new Error('Base URL is required before fetching models.');
  }
  if (!provider.apiKey.trim()) {
    throw new Error('API Key is required before fetching models.');
  }
  if (provider.protocol !== 'openai-compatible' && provider.protocol !== 'anthropic' && provider.protocol !== 'google') {
    throw new Error(`Fetching model lists for ${provider.protocol} providers is not supported yet.`);
  }

  const sourceUrl = buildModelListUrl(provider);
  const body = await fetchModelListJson(provider, sourceUrl);
  return {
    models: normalizeRemoteModels(body, provider),
    fetchedAt: nowIso(),
    sourceUrl
  };
}
