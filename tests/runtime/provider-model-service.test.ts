import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../../shared/types.ts';
import { listProviderModels } from '../../electron/main/provider-model-service.ts';
import { buildProject, buildState } from './test-helpers.ts';

test('provider model list fetches OpenAI-compatible models and reuses stored edit key', async () => {
  const state = buildState(buildProject()) as AppState;
  const existingProvider = state.providers[0]!;
  state.providers[0] = {
    ...existingProvider,
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'stored-key',
    hasStoredApiKey: true,
    model: 'gpt-4.1'
  };
  const providerId = state.providers[0]!.id;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/models');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer stored-key');
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-4.1', display_name: 'GPT 4.1', context_window: 1047576, max_output_tokens: 32768 },
          { id: 'gpt-4.1-mini', display_name: 'GPT 4.1 mini' }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;

    const result = await listProviderModels(state, {
      providerId,
      provider: {
        name: 'OpenAI',
        protocol: 'openai-compatible',
        apiMode: 'responses',
        authStyle: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4.1',
        enabled: true
      }
    });

    assert.equal(result.sourceUrl, 'https://api.openai.com/v1/models');
    assert.deepEqual(result.models.map((model) => model.modelId), ['gpt-4.1', 'gpt-4.1-mini']);
    assert.equal(result.models[0]?.displayName, 'GPT 4.1');
    assert.equal(result.models[0]?.capabilities?.contextWindow, 1047576);
    assert.equal(result.models[0]?.capabilities?.maxOutputTokens, 32768);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider model list requires an effective API key', async () => {
  const state = buildState(buildProject()) as AppState;
  state.providers = [];
  await assert.rejects(
    () => listProviderModels(state, {
      provider: {
        name: 'Custom',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        authStyle: 'api_key',
        baseUrl: 'https://example.com/v1',
        apiKey: '',
        model: 'model-list-probe',
        enabled: true
      }
    }),
    /API Key is required/
  );
});
