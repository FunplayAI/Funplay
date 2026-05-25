import type {
  AiProvider,
  AiProviderRoleModels
} from '../../../../shared/types';
import { resolveProviderForClaudeCode } from '../provider-resolver';
import type { ResolvedClaudeCodeProvider } from './types';

export function isClaudeSideRuntimeModel(provider?: AiProvider): boolean {
  const resolved = resolveProviderForClaudeCode(provider);
  if (!resolved.canUseClaudeCode) {
    return false;
  }
  if (!provider || provider.protocol === 'bedrock' || provider.protocol === 'vertex' || provider.claudeCodeCompatible || provider.sdkProxyOnly) {
    return true;
  }
  const model = (resolved.upstreamModel ?? resolved.model ?? provider.model).trim().toLowerCase();
  if (!model) {
    return true;
  }
  return /(^|[/._:-])(claude|sonnet|opus|haiku)([/._:-]|$)/i.test(model);
}

function normalizeClaudeRoleModels(input?: AiProviderRoleModels): AiProviderRoleModels {
  const normalized: AiProviderRoleModels = {};
  for (const key of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
    const value = input?.[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function resolveClaudeCodeRoleModels(provider?: AiProvider): AiProviderRoleModels {
  const resolved = resolveProviderForClaudeCode(provider);
  const configured = normalizeClaudeRoleModels(resolved.roleModels);
  const defaultModel = configured.default ?? resolved.upstreamModel ?? resolved.model ?? provider?.model.trim();
  if (!defaultModel) {
    return configured;
  }

  return {
    default: defaultModel,
    reasoning: configured.reasoning ?? defaultModel,
    small: configured.small ?? defaultModel,
    haiku: configured.haiku ?? defaultModel,
    sonnet: configured.sonnet ?? defaultModel,
    opus: configured.opus ?? defaultModel
  };
}

export function resolveClaudeCodeProvider(provider?: AiProvider): ResolvedClaudeCodeProvider {
  const resolved = resolveProviderForClaudeCode(provider);
  const roleModels = resolveClaudeCodeRoleModels(provider);
  const model = resolved.upstreamModel ?? roleModels.default ?? resolved.model;
  const injectAnthropicEnv = Boolean(
    provider &&
    resolved.canUseClaudeCode &&
    resolved.authStyle !== 'env_only' &&
    (resolved.protocol === 'anthropic' || resolved.sdkProxyOnly)
  );

  return {
    provider: resolved.provider,
    providerId: resolved.providerId,
    providerName: resolved.providerName,
    protocol: resolved.protocol,
    authStyle: resolved.provider ? resolved.authStyle : 'none',
    hasCredentials: resolved.hasCredentials,
    canUseClaudeCode: resolved.canUseClaudeCode && isClaudeSideRuntimeModel(provider),
    injectAnthropicEnv,
    useShadowHome: resolved.useShadowHome,
    baseUrl: resolved.baseUrl,
    model,
    upstreamModel: resolved.upstreamModel,
    roleModels,
    settingSources: resolved.settingSources,
    sdkProxyOnly: resolved.sdkProxyOnly,
    diagnostic: {
      providerId: resolved.providerId,
      providerName: resolved.providerName,
      protocol: resolved.protocol,
      authStyle: resolved.provider ? resolved.authStyle : 'none',
      baseUrl: resolved.baseUrl,
      model,
      upstreamModel: resolved.upstreamModel,
      hasApiKey: Boolean(provider?.apiKey.trim()),
      claudeCodeCompatible: resolved.canUseClaudeCode,
      sdkProxyOnly: resolved.sdkProxyOnly
    }
  };
}
