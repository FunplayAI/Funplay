import type {
  AiProvider,
  AiProviderInput,
  AiProviderMeta,
  AiProviderModel,
  AiSettings,
  AppState
} from '../../shared/types';
import {
  getProviderPresetDefaults,
  inferOpenAiCompatibleApiMode,
  normalizeProviderAuthStyle,
  resolveProviderUpstreamModel
} from '../../shared/provider-catalog';
import { deleteProviderSecret, persistProviderSecret } from './provider-secret-store';
import {
  normalizeProviderChunkTimeoutMs,
  normalizeProviderContextWindowTokens,
  normalizeProviderMaxOutputTokens,
  normalizeProviderRequestTimeoutMs
} from './provider-runtime-options';
import { makeId, nowIso } from '../../shared/utils';

function normalizeStringRecord(input?: Record<string, string>): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key && value)
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderModels(input?: AiProviderModel[]): AiProviderModel[] | undefined {
  if (!input?.length) {
    return undefined;
  }
  const normalized = input
    .map((model) => ({
      ...model,
      modelId: model.modelId?.trim(),
      upstreamModelId: model.upstreamModelId?.trim() || undefined,
      displayName: model.displayName?.trim() || undefined
    }))
    .filter((model) => model.modelId);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderMeta(input?: AiProviderMeta): AiProviderMeta | undefined {
  if (!input) {
    return undefined;
  }
  const normalized: AiProviderMeta = {
    apiKeyUrl: input.apiKeyUrl?.trim() || undefined,
    docsUrl: input.docsUrl?.trim() || undefined,
    pricingUrl: input.pricingUrl?.trim() || undefined,
    statusPageUrl: input.statusPageUrl?.trim() || undefined,
    billingModel: input.billingModel,
    notes: input.notes?.map((note) => note.trim()).filter(Boolean)
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

export async function createProvider(state: AppState, input: AiProviderInput): Promise<AiProvider> {
  const timestamp = nowIso();
  const firstProvider = state.providers.length === 0;
  const hasEnabledProvider = state.providers.some((provider) => provider.enabled);
  const secret = input.apiKey.trim();
  const presetDefaults = getProviderPresetDefaults(input);
  const resolvedAuthStyle = normalizeProviderAuthStyle({
    authStyle: input.authStyle ?? presetDefaults.authStyle,
    protocol: input.protocol,
    baseUrl: input.baseUrl
  });
  // A new api_key-style provider with no key would silently fail at runtime; reject it up front.
  if (resolvedAuthStyle === 'api_key' && !secret) {
    throw new Error('api_key 认证方式需要填写 API Key。/ The api_key auth style requires an API Key.');
  }
  const availableModels = normalizeProviderModels(input.availableModels) ?? presetDefaults.availableModels;
  const providerForUpstream = {
    model: input.model.trim(),
    upstreamModel: input.upstreamModel?.trim() || presetDefaults.upstreamModel,
    availableModels
  };
  const provider: AiProvider = {
    id: makeId('provider'),
    name: input.name.trim(),
    protocol: input.protocol,
    apiMode: input.protocol === 'openai-compatible' ? inferOpenAiCompatibleApiMode(input) : undefined,
    authStyle: normalizeProviderAuthStyle({
      authStyle: input.authStyle ?? presetDefaults.authStyle,
      protocol: input.protocol,
      baseUrl: input.baseUrl
    }),
    baseUrl: input.baseUrl.trim(),
    apiKey: secret,
    hasStoredApiKey: Boolean(secret),
    model: input.model.trim(),
    upstreamModel: resolveProviderUpstreamModel(providerForUpstream),
    headers: normalizeStringRecord(input.headers) ?? presetDefaults.headers,
    envOverrides: normalizeStringRecord(input.envOverrides) ?? presetDefaults.envOverrides,
    availableModels,
    providerMeta: normalizeProviderMeta(input.providerMeta) ?? presetDefaults.providerMeta,
    contextWindowTokens: normalizeProviderContextWindowTokens(input.contextWindowTokens),
    maxOutputTokens: normalizeProviderMaxOutputTokens(input.maxOutputTokens),
    requestTimeoutMs: normalizeProviderRequestTimeoutMs(input.requestTimeoutMs),
    chunkTimeoutMs: normalizeProviderChunkTimeoutMs(input.chunkTimeoutMs),
    enabled: input.enabled ?? true,
    isDefault: firstProvider || !hasEnabledProvider,
    notes: input.notes?.trim() ?? '',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  if (provider.isDefault) {
    state.aiSettings.defaultProviderId = provider.id;
    state.providers = state.providers.map((item) => ({
      ...item,
      isDefault: false
    }));
  }

  state.providers = [provider, ...state.providers];
  await persistProviderSecret(provider.id, secret);
  return provider;
}

export async function updateProvider(state: AppState, providerId: string, input: AiProviderInput): Promise<AiProvider> {
  const index = state.providers.findIndex((provider) => provider.id === providerId);
  if (index === -1) {
    throw new Error('Provider not found.');
  }

  const current = state.providers[index];
  const nextSecret = input.apiKey.trim() || current.apiKey.trim();
  const presetDefaults = getProviderPresetDefaults(input);
  const availableModels =
    normalizeProviderModels(input.availableModels) ?? current.availableModels ?? presetDefaults.availableModels;
  const upstreamModel = resolveProviderUpstreamModel({
    model: input.model.trim(),
    upstreamModel: input.upstreamModel?.trim() || current.upstreamModel || presetDefaults.upstreamModel,
    availableModels
  });
  const updated: AiProvider = {
    ...current,
    name: input.name.trim(),
    protocol: input.protocol,
    apiMode:
      input.protocol === 'openai-compatible'
        ? inferOpenAiCompatibleApiMode({ ...input, apiMode: input.apiMode ?? current.apiMode })
        : undefined,
    authStyle: normalizeProviderAuthStyle({
      authStyle: input.authStyle ?? current.authStyle ?? presetDefaults.authStyle,
      protocol: input.protocol,
      baseUrl: input.baseUrl
    }),
    baseUrl: input.baseUrl.trim(),
    apiKey: nextSecret,
    hasStoredApiKey: Boolean(nextSecret),
    model: input.model.trim(),
    upstreamModel,
    headers: normalizeStringRecord(input.headers) ?? current.headers ?? presetDefaults.headers,
    envOverrides: normalizeStringRecord(input.envOverrides) ?? current.envOverrides ?? presetDefaults.envOverrides,
    availableModels,
    providerMeta: normalizeProviderMeta(input.providerMeta) ?? current.providerMeta ?? presetDefaults.providerMeta,
    contextWindowTokens: normalizeProviderContextWindowTokens(input.contextWindowTokens),
    maxOutputTokens: normalizeProviderMaxOutputTokens(input.maxOutputTokens),
    requestTimeoutMs: normalizeProviderRequestTimeoutMs(input.requestTimeoutMs),
    chunkTimeoutMs: normalizeProviderChunkTimeoutMs(input.chunkTimeoutMs),
    enabled: input.enabled ?? current.enabled,
    notes: input.notes?.trim() ?? '',
    updatedAt: nowIso()
  };

  state.providers[index] = updated;
  await persistProviderSecret(updated.id, nextSecret);

  if (!updated.enabled && state.aiSettings.defaultProviderId === updated.id) {
    const nextDefault = state.providers.find((provider) => provider.id !== updated.id && provider.enabled);
    state.aiSettings.defaultProviderId = nextDefault?.id;
    state.providers = state.providers.map((provider) => ({
      ...provider,
      isDefault: provider.id === nextDefault?.id
    }));
  }

  return updated;
}

export interface ProviderUsage {
  projects: string[];
}

export function countProviderUsage(state: AppState, providerId: string): ProviderUsage {
  const projectNames = new Set<string>();
  for (const project of state.projects) {
    const referencedByProject = project.providerId === providerId;
    const referencedBySession = project.sessions?.some(
      (session) => session.runtimeOverrides?.providerId === providerId
    );
    if (referencedByProject || referencedBySession) {
      projectNames.add(project.name);
    }
  }
  return { projects: [...projectNames] };
}

export async function deleteProvider(state: AppState, providerId: string): Promise<void> {
  const exists = state.providers.some((provider) => provider.id === providerId);
  if (!exists) {
    throw new Error('Provider not found.');
  }

  state.providers = state.providers.filter((provider) => provider.id !== providerId);

  if (state.aiSettings.defaultProviderId === providerId) {
    const nextDefault = state.providers.find((provider) => provider.enabled) ?? state.providers[0];
    state.aiSettings.defaultProviderId = nextDefault?.id;
    state.providers = state.providers.map((provider) => ({
      ...provider,
      isDefault: provider.id === nextDefault?.id
    }));
  }

  await deleteProviderSecret(providerId);
}

export function setDefaultProvider(state: AppState, providerId: string): AiSettings {
  const target = state.providers.find((provider) => provider.id === providerId);
  if (!target) {
    throw new Error('Provider not found.');
  }

  state.aiSettings = {
    ...state.aiSettings,
    defaultProviderId: providerId
  };
  state.providers = state.providers.map((provider) => ({
    ...provider,
    isDefault: provider.id === providerId
  }));

  return state.aiSettings;
}

export function getDefaultProvider(state: AppState): AiProvider | undefined {
  const configured = state.providers.find(
    (provider) => provider.id === state.aiSettings.defaultProviderId && provider.enabled
  );
  return configured ?? state.providers.find((provider) => provider.enabled);
}
