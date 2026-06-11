import type {
  AiProvider,
  AiProviderAuthStyle,
  AiProviderProtocol,
  AppState,
  Project,
  ProjectSession
} from '../../../shared/types';
import { ensureProjectSessions, getActiveProjectSession } from '../../../shared/project-sessions';
import {
  getProviderPresetDefaults,
  normalizeProviderAuthStyle,
  resolveProviderUpstreamModel
} from '../../../shared/provider-catalog';

export interface ResolveProviderForRuntimeOptions {
  state?: AppState;
  project?: Project;
  session?: ProjectSession;
  explicitProvider?: AiProvider;
  explicitProviderId?: string;
  sessionProviderId?: string;
  sessionModel?: string;
  sessionUpstreamModel?: string;
  model?: string;
}

export interface ResolvedRuntimeProvider {
  provider?: AiProvider;
  providerId?: string;
  providerName?: string;
  protocol: AiProviderProtocol;
  authStyle: AiProviderAuthStyle;
  model?: string;
  upstreamModel?: string;
  baseUrl?: string;
  headers: Record<string, string>;
  envOverrides: Record<string, string>;
  hasCredentials: boolean;
  diagnostic: {
    providerId?: string;
    providerName?: string;
    protocol: AiProviderProtocol;
    authStyle: AiProviderAuthStyle;
    baseUrl?: string;
    model?: string;
    upstreamModel?: string;
    hasApiKey: boolean;
  };
}

export interface NativeProviderConfig {
  provider?: AiProvider;
  protocol: AiProviderProtocol;
  authStyle: AiProviderAuthStyle;
  model?: string;
  upstreamModel?: string;
  baseUrl?: string;
  headers: Record<string, string>;
  apiKey?: string;
  authToken?: string;
  hasCredentials: boolean;
  canUseNative: boolean;
  nativeUnsupportedReason?: string;
}

function normalizeStringRecord(input?: Record<string, string>): Record<string, string> {
  if (!input) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key && value)
  );
}

function normalizeBaseUrl(provider?: AiProvider): string | undefined {
  const cleaned = provider?.baseUrl.trim().replace(/\/+$/, '');
  return cleaned || undefined;
}

function getDefaultProvider(state?: AppState): AiProvider | undefined {
  if (!state) {
    return undefined;
  }
  const configured = state.providers.find(
    (provider) => provider.id === state.aiSettings.defaultProviderId && provider.enabled
  );
  return configured ?? state.providers.find((provider) => provider.enabled);
}

function resolveSession(options: ResolveProviderForRuntimeOptions): ProjectSession | undefined {
  if (options.session) {
    return options.session;
  }
  if (!options.project) {
    return undefined;
  }
  const ensured = ensureProjectSessions(options.project);
  return getActiveProjectSession(ensured);
}

function resolveProviderCandidate(options: ResolveProviderForRuntimeOptions): AiProvider | undefined {
  if (options.explicitProvider) {
    return options.explicitProvider;
  }
  const state = options.state;
  if (!state) {
    return undefined;
  }
  const session = resolveSession(options);
  const ids = [
    options.sessionProviderId,
    session?.runtimeOverrides?.providerId,
    options.explicitProviderId,
    state.aiSettings.defaultProviderId
  ].filter(Boolean);
  for (const id of ids) {
    const matched = state.providers.find((provider) => provider.id === id && provider.enabled);
    if (matched) {
      return matched;
    }
  }
  return getDefaultProvider(state);
}

function resolveProviderModel(provider: AiProvider | undefined, options: ResolveProviderForRuntimeOptions): string | undefined {
  const session = resolveSession(options);
  return (
    options.model?.trim() ||
    options.sessionModel?.trim() ||
    session?.runtimeOverrides?.model?.trim() ||
    provider?.model.trim() ||
    undefined
  );
}

export function resolveProviderForRuntime(options: ResolveProviderForRuntimeOptions = {}): ResolvedRuntimeProvider {
  const provider = resolveProviderCandidate(options);
  const session = resolveSession(options);
  const protocol = provider?.protocol ?? 'anthropic';
  const defaults = provider ? getProviderPresetDefaults(provider) : undefined;
  const authStyle = normalizeProviderAuthStyle({
    authStyle: provider?.authStyle ?? defaults?.authStyle,
    protocol,
    baseUrl: provider?.baseUrl
  });
  const model = resolveProviderModel(provider, options);
  const upstreamModel =
    options.sessionUpstreamModel?.trim() ||
    session?.runtimeOverrides?.upstreamModel?.trim() ||
    (provider && model
      ? resolveProviderUpstreamModel({
          ...provider,
          model
        })
      : model);
  const hasCredentials = Boolean(provider?.apiKey.trim()) || authStyle === 'env_only' || !provider;
  const baseUrl = normalizeBaseUrl(provider);

  return {
    provider,
    providerId: provider?.id,
    providerName: provider?.name,
    protocol,
    authStyle,
    model,
    upstreamModel,
    baseUrl,
    headers: normalizeStringRecord(provider?.headers ?? defaults?.headers),
    envOverrides: normalizeStringRecord(provider?.envOverrides ?? defaults?.envOverrides),
    hasCredentials,
    diagnostic: {
      providerId: provider?.id,
      providerName: provider?.name,
      protocol,
      authStyle,
      baseUrl,
      model,
      upstreamModel,
      hasApiKey: Boolean(provider?.apiKey.trim())
    }
  };
}

export function resolveAgentProvider(
  state: AppState,
  project: Project,
  explicitProviderId?: string
): AiProvider | undefined {
  const ensured = ensureProjectSessions(project);
  const activeSession = getActiveProjectSession(ensured);
  const resolved = resolveProviderForRuntime({
    state,
    project,
    session: activeSession,
    explicitProviderId
  });
  const baseProvider = resolved.provider ?? getDefaultProvider(state);
  if (!baseProvider) {
    return undefined;
  }

  if (!resolved.model && !resolved.upstreamModel) {
    return baseProvider;
  }

  return {
    ...baseProvider,
    model: resolved.model ?? baseProvider.model,
    upstreamModel: resolved.upstreamModel ?? baseProvider.upstreamModel
  };
}

export function toNativeProviderConfig(resolved: ResolvedRuntimeProvider): NativeProviderConfig {
  const apiKey = resolved.provider?.apiKey.trim();
  const canUseNativeProtocol =
    resolved.protocol === 'anthropic' ||
    resolved.protocol === 'openai-compatible' ||
    resolved.protocol === 'google' ||
    resolved.protocol === 'bedrock' ||
    resolved.protocol === 'vertex';
  const canUseEnvOnlyNative = (resolved.protocol === 'bedrock' || resolved.protocol === 'vertex') && resolved.authStyle === 'env_only';
  const canUseNativeAuth =
    resolved.authStyle === 'api_key' ||
    resolved.authStyle === 'auth_token' ||
    resolved.authStyle === 'custom_header' ||
    canUseEnvOnlyNative;
  const canUseNative = Boolean(
    resolved.provider &&
    canUseNativeProtocol &&
    canUseNativeAuth
  );
  let nativeUnsupportedReason: string | undefined;
  if (!resolved.provider) {
    nativeUnsupportedReason = 'No AI provider is configured; add and enable a provider before running the native runtime.';
  } else if (!canUseNativeProtocol) {
    nativeUnsupportedReason = `Protocol ${resolved.protocol} is not supported by native provider clients.`;
  } else if (!canUseNativeAuth) {
    nativeUnsupportedReason = `Auth style ${resolved.authStyle} is not supported by native provider clients.`;
  }

  return {
    provider: resolved.provider,
    protocol: resolved.protocol,
    authStyle: resolved.authStyle,
    model: resolved.model,
    upstreamModel: resolved.upstreamModel,
    baseUrl: resolved.baseUrl,
    headers: resolved.headers,
    apiKey: resolved.authStyle === 'api_key' ? apiKey : undefined,
    authToken: resolved.authStyle === 'auth_token' ? apiKey : undefined,
    hasCredentials: resolved.hasCredentials,
    canUseNative,
    nativeUnsupportedReason
  };
}

export function materializeNativeProvider(provider: AiProvider): AiProvider {
  const resolved = resolveProviderForRuntime({ explicitProvider: provider });
  const nativeConfig = toNativeProviderConfig(resolved);
  if (!nativeConfig.canUseNative) {
    throw new Error(nativeConfig.nativeUnsupportedReason ?? 'Provider is not supported by native runtime.');
  }
  return {
    ...provider,
    authStyle: nativeConfig.authStyle,
    baseUrl: nativeConfig.baseUrl ?? provider.baseUrl,
    model: nativeConfig.upstreamModel ?? nativeConfig.model ?? provider.model,
    headers: nativeConfig.headers,
    apiKey: nativeConfig.apiKey ?? nativeConfig.authToken ?? provider.apiKey
  };
}
