import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import type { LanguageModel } from 'ai';
import type { AiProvider } from '../../shared/types';
import { materializeNativeProvider } from './agent-platform/provider-resolver';
import { createProviderFetch } from './provider-runtime-options';
import { normalizeAnthropicBaseUrl } from './provider-base-url';

function readEnvOverride(provider: AiProvider, key: string): string | undefined {
  return provider.envOverrides?.[key]?.trim() || process.env[key]?.trim() || undefined;
}

export function createLanguageModel(provider: AiProvider, modelOverride?: string): LanguageModel {
  const resolvedProvider = materializeNativeProvider(provider);
  const modelId = modelOverride?.trim() || resolvedProvider.model.trim();
  const apiKey = resolvedProvider.apiKey.trim();
  const authStyle = resolvedProvider.authStyle ?? 'api_key';

  if (!modelId) {
    throw new Error('Provider model is required.');
  }

  switch (resolvedProvider.protocol) {
    case 'anthropic': {
      if (!apiKey && authStyle !== 'custom_header') {
        throw new Error('Anthropic API key/auth token is required.');
      }
      const anthropic = createAnthropic({
        apiKey: authStyle === 'api_key' ? apiKey : undefined,
        authToken: authStyle === 'auth_token' ? apiKey : undefined,
        baseURL: normalizeAnthropicBaseUrl(resolvedProvider.baseUrl),
        headers: resolvedProvider.headers,
        fetch: createProviderFetch(resolvedProvider)
      });
      return anthropic(modelId);
    }

    case 'google': {
      if (!apiKey) {
        throw new Error('Google API key is required.');
      }
      const google = createGoogleGenerativeAI({
        apiKey,
        baseURL: resolvedProvider.baseUrl.trim() || undefined,
        fetch: createProviderFetch(resolvedProvider)
      });
      return google(modelId);
    }

    case 'openai-compatible': {
      throw new Error('OpenAI-compatible providers use Funplay native protocol adapters, not AI SDK language models.');
    }

    case 'bedrock': {
      const bedrock = createBedrockAnthropic({
        region: readEnvOverride(resolvedProvider, 'AWS_REGION') ?? readEnvOverride(resolvedProvider, 'AWS_DEFAULT_REGION'),
        accessKeyId: readEnvOverride(resolvedProvider, 'AWS_ACCESS_KEY_ID'),
        secretAccessKey: readEnvOverride(resolvedProvider, 'AWS_SECRET_ACCESS_KEY'),
        sessionToken: readEnvOverride(resolvedProvider, 'AWS_SESSION_TOKEN'),
        apiKey: readEnvOverride(resolvedProvider, 'AWS_BEARER_TOKEN_BEDROCK'),
        baseURL: resolvedProvider.baseUrl.trim() || undefined,
        headers: resolvedProvider.headers,
        fetch: createProviderFetch(resolvedProvider)
      });
      return bedrock(modelId);
    }

    case 'vertex': {
      const vertex = createVertexAnthropic({
        project:
          readEnvOverride(resolvedProvider, 'GOOGLE_VERTEX_PROJECT') ??
          readEnvOverride(resolvedProvider, 'ANTHROPIC_PROJECT_ID'),
        location:
          readEnvOverride(resolvedProvider, 'GOOGLE_VERTEX_LOCATION') ??
          readEnvOverride(resolvedProvider, 'CLOUD_ML_REGION'),
        baseURL: resolvedProvider.baseUrl.trim() || undefined,
        headers: resolvedProvider.headers,
        fetch: createProviderFetch(resolvedProvider)
      });
      return vertex(modelId);
    }

    default: {
      throw new Error(`Unsupported provider protocol: ${resolvedProvider.protocol}`);
    }
  }
}
