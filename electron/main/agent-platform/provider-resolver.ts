import type {
  AiProvider,
  AiProviderAuthStyle,
  AiProviderProtocol,
  AiProviderRoleModels,
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
  roleModels: AiProviderRoleModels;
  hasCredentials: boolean;
  canUseClaudeCode: boolean;
  sdkProxyOnly: boolean;
  useShadowHome: boolean;
  settingSources: Array<'user' | 'project' | 'local'>;
  diagnostic: {
    providerId?: string;
    providerName?: string;
    protocol: AiProviderProtocol;
    authStyle: AiProviderAuthStyle;
    baseUrl?: string;
    model?: string;
    upstreamModel?: string;
    hasApiKey: boolean;
    claudeCodeCompatible: boolean;
    sdkProxyOnly: boolean;
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
  sdkProxyOnly: boolean;
  canUseNative: boolean;
  nativeUnsupportedReason?: string;
}

const MANAGED_CLAUDE_CODE_ENV_KEYS = [
  'API_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLOUD_ML_REGION',
  'ANTHROPIC_PROJECT_ID',
  'GEMINI_API_KEY'
] as const;

const AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL'
]);

export function isManagedClaudeCodeEnvKey(key: string): boolean {
  return key.startsWith('ANTHROPIC_') || MANAGED_CLAUDE_CODE_ENV_KEYS.includes(key as typeof MANAGED_CLAUDE_CODE_ENV_KEYS[number]);
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

function normalizeRoleModels(input?: AiProviderRoleModels): AiProviderRoleModels {
  const normalized: AiProviderRoleModels = {};
  for (const key of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
    const value = input?.[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function hasAnyRoleModel(input?: AiProviderRoleModels): boolean {
  return Object.values(input ?? {}).some((value) => Boolean(value?.trim()));
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

function resolveRoleModels(provider: AiProvider | undefined, model?: string, upstreamModel?: string): AiProviderRoleModels {
  if (!provider) {
    return {};
  }
  const configured = normalizeRoleModels(provider.claudeRoleModels);
  const hasProviderRoleModels = hasAnyRoleModel(provider.claudeRoleModels);
  const defaultModel = upstreamModel || model || configured.default;
  if (!defaultModel) {
    return configured;
  }
  return {
    default: (hasProviderRoleModels ? configured.default : undefined) ?? defaultModel,
    reasoning: configured.reasoning ?? defaultModel,
    small: configured.small ?? defaultModel,
    haiku: configured.haiku ?? defaultModel,
    sonnet: configured.sonnet ?? defaultModel,
    opus: configured.opus ?? defaultModel
  };
}

function canProviderUseClaudeCode(provider: AiProvider | undefined, protocol: AiProviderProtocol): boolean {
  if (!provider) {
    return true;
  }
  if (protocol === 'bedrock' || protocol === 'vertex' || provider.claudeCodeCompatible || provider.sdkProxyOnly) {
    return true;
  }
  if (protocol !== 'anthropic') {
    return false;
  }
  const modelMarker = `${provider.model} ${provider.upstreamModel ?? ''} ${Object.values(provider.claudeRoleModels ?? {}).join(' ')}`.toLowerCase();
  if (!modelMarker.trim()) {
    return true;
  }
  return /(^|[/._:-])(claude|sonnet|opus|haiku)([/._:-]|$)/i.test(modelMarker);
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
  const roleModels = resolveRoleModels(provider, model, upstreamModel);
  const sdkProxyOnly = Boolean(provider?.sdkProxyOnly ?? defaults?.sdkProxyOnly);
  const hasCredentials = Boolean(provider?.apiKey.trim()) || authStyle === 'env_only' || !provider;
  const canUseClaudeCode = canProviderUseClaudeCode(provider, protocol);
  const baseUrl = normalizeBaseUrl(provider);
  const useEnvOnlyFlow = authStyle === 'env_only';
  const settingSources: Array<'user' | 'project' | 'local'> = provider && !useEnvOnlyFlow
    ? ['user']
    : ['user', 'project', 'local'];

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
    roleModels,
    hasCredentials,
    canUseClaudeCode,
    sdkProxyOnly,
    useShadowHome: Boolean(provider && !useEnvOnlyFlow && canUseClaudeCode),
    settingSources,
    diagnostic: {
      providerId: provider?.id,
      providerName: provider?.name,
      protocol,
      authStyle,
      baseUrl,
      model,
      upstreamModel,
      hasApiKey: Boolean(provider?.apiKey.trim()),
      claudeCodeCompatible: canUseClaudeCode,
      sdkProxyOnly
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

export function resolveProviderForClaudeCode(provider?: AiProvider): ResolvedRuntimeProvider {
  return resolveProviderForRuntime({ explicitProvider: provider });
}

export function toClaudeCodeEnv(
  baseEnv: NodeJS.ProcessEnv,
  resolved: ResolvedRuntimeProvider
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  if (resolved.provider) {
    for (const key of Object.keys(env)) {
      if (isManagedClaudeCodeEnvKey(key)) {
        delete env[key];
      }
    }

    const apiKey = resolved.provider.apiKey.trim();
    const shouldInjectClaudeAuth = resolved.canUseClaudeCode && (resolved.protocol === 'anthropic' || resolved.sdkProxyOnly);
    if (shouldInjectClaudeAuth && apiKey && resolved.authStyle === 'auth_token') {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
      env.ANTHROPIC_API_KEY = '';
    } else if (shouldInjectClaudeAuth && apiKey && resolved.authStyle === 'api_key') {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    if (shouldInjectClaudeAuth && resolved.baseUrl) {
      env.ANTHROPIC_BASE_URL = resolved.baseUrl;
    }
  }

  if (resolved.canUseClaudeCode && resolved.roleModels.default) {
    env.ANTHROPIC_MODEL = resolved.roleModels.default;
  }
  if (resolved.canUseClaudeCode && resolved.roleModels.reasoning) {
    env.ANTHROPIC_REASONING_MODEL = resolved.roleModels.reasoning;
  }
  if (resolved.canUseClaudeCode && resolved.roleModels.small) {
    env.ANTHROPIC_SMALL_FAST_MODEL = resolved.roleModels.small;
  }
  if (resolved.canUseClaudeCode && resolved.roleModels.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolved.roleModels.haiku;
  }
  if (resolved.canUseClaudeCode && resolved.roleModels.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = resolved.roleModels.sonnet;
  }
  if (resolved.canUseClaudeCode && resolved.roleModels.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = resolved.roleModels.opus;
  }

  for (const [key, value] of Object.entries(resolved.headers)) {
    if (value && !AUTH_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(resolved.envOverrides)) {
    if (resolved.authStyle !== 'env_only' && (AUTH_ENV_KEYS.has(key) || isManagedClaudeCodeEnvKey(key))) {
      continue;
    }
    if (value === '') {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
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
    canUseNativeAuth &&
    !resolved.sdkProxyOnly
  );
  let nativeUnsupportedReason: string | undefined;
  if (!resolved.provider) {
    nativeUnsupportedReason = 'No database provider is resolved; env-mode should use Claude SDK or explicit native provider settings.';
  } else if (!canUseNativeProtocol) {
    nativeUnsupportedReason = `Protocol ${resolved.protocol} is not supported by native provider clients.`;
  } else if (!canUseNativeAuth) {
    nativeUnsupportedReason = `Auth style ${resolved.authStyle} is not supported by native provider clients.`;
  } else if (resolved.sdkProxyOnly) {
    nativeUnsupportedReason = 'Provider is marked sdkProxyOnly and should be tested/run through Claude SDK.';
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
    sdkProxyOnly: resolved.sdkProxyOnly,
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
