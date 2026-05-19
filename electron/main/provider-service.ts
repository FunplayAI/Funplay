import type { AiProvider, AiProviderInput, AiProviderMeta, AiProviderModel, AiProviderRoleModels, AiSettings, AppState } from '../../shared/types';
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

function normalizeProviderRoleModels(input?: AiProviderRoleModels): AiProviderRoleModels | undefined {
  if (!input) {
    return undefined;
  }

  const normalized: AiProviderRoleModels = {};
  for (const key of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
    const value = input[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

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

function resolveClaudeCodeCompatible(input: Pick<AiProviderInput, 'protocol'>): boolean {
  return input.protocol === 'anthropic';
}

function resolveClaudeRoleModels(input: Pick<AiProviderInput, 'protocol' | 'claudeRoleModels'>): AiProviderRoleModels | undefined {
  return input.protocol === 'anthropic' ? normalizeProviderRoleModels(input.claudeRoleModels) : undefined;
}

export async function createProvider(state: AppState, input: AiProviderInput): Promise<AiProvider> {
  const timestamp = nowIso();
  const firstProvider = state.providers.length === 0;
  const hasEnabledProvider = state.providers.some((provider) => provider.enabled);
  const secret = input.apiKey.trim();
  const presetDefaults = getProviderPresetDefaults(input);
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
    authStyle: normalizeProviderAuthStyle({ authStyle: input.authStyle ?? presetDefaults.authStyle, protocol: input.protocol, baseUrl: input.baseUrl }),
    baseUrl: input.baseUrl.trim(),
    apiKey: secret,
    hasStoredApiKey: Boolean(secret),
    model: input.model.trim(),
    upstreamModel: resolveProviderUpstreamModel(providerForUpstream),
    headers: normalizeStringRecord(input.headers) ?? presetDefaults.headers,
    envOverrides: normalizeStringRecord(input.envOverrides) ?? presetDefaults.envOverrides,
    claudeCodeCompatible: resolveClaudeCodeCompatible(input),
    claudeRoleModels: resolveClaudeRoleModels(input) ?? presetDefaults.roleModels,
    availableModels,
    sdkProxyOnly: input.sdkProxyOnly ?? presetDefaults.sdkProxyOnly,
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
  const availableModels = normalizeProviderModels(input.availableModels) ?? current.availableModels ?? presetDefaults.availableModels;
  const upstreamModel = resolveProviderUpstreamModel({
    model: input.model.trim(),
    upstreamModel: input.upstreamModel?.trim() || current.upstreamModel || presetDefaults.upstreamModel,
    availableModels
  });
  const claudeCodeCompatible = input.protocol === 'anthropic';
  const claudeRoleModels = input.protocol === 'anthropic'
    ? input.claudeRoleModels === undefined
      ? normalizeProviderRoleModels(current.claudeRoleModels)
      : normalizeProviderRoleModels(input.claudeRoleModels)
    : undefined;
  const updated: AiProvider = {
    ...current,
    name: input.name.trim(),
    protocol: input.protocol,
    apiMode: input.protocol === 'openai-compatible' ? inferOpenAiCompatibleApiMode({ ...input, apiMode: input.apiMode ?? current.apiMode }) : undefined,
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
    claudeCodeCompatible,
    claudeRoleModels: claudeRoleModels ?? presetDefaults.roleModels,
    availableModels,
    sdkProxyOnly: input.sdkProxyOnly ?? current.sdkProxyOnly ?? presetDefaults.sdkProxyOnly,
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
