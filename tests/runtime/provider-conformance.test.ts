import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, AiProvider } from '../../shared/types.ts';
import {
  AI_PROVIDER_PRESETS,
  resolveOpenAiCompatibleChatTokenParameter,
  resolveOpenAiCompatibleProviderProfile
} from '../../shared/provider-catalog.ts';
import { classifyNativeRuntimeError } from '../../electron/main/agent-platform/native/diagnostics.ts';
import { runRuntimeDoctor } from '../../electron/main/runtime-doctor-service.ts';
import { buildProject, buildState } from './test-helpers.ts';

const openAiCompatiblePresets = AI_PROVIDER_PRESETS.filter((preset) => preset.protocol === 'openai-compatible');

function buildOpenAiProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'provider_conformance',
    name: 'Xiaomi MiMo',
    protocol: 'openai-compatible',
    apiMode: 'chat',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: 'test-key',
    hasStoredApiKey: true,
    model: 'mimo-v2.5-pro',
    enabled: true,
    isDefault: false,
    notes: '',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    ...overrides
  };
}

test('openai-compatible provider presets declare a runnable streaming tool profile', () => {
  assert.equal(openAiCompatiblePresets.length >= 8, true);

  for (const preset of openAiCompatiblePresets) {
    const profile = resolveOpenAiCompatibleProviderProfile({
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      apiMode: preset.apiMode
    });

    assert.equal(profile.streamingToolCalls, true, `${preset.id} should support streaming tool calls`);
    if (profile.apiMode === 'chat') {
      assert.equal(profile.supportsChatCompletions, true, `${preset.id} should support Chat Completions`);
    }
    if (profile.apiMode === 'responses') {
      assert.equal(profile.supportsResponses, true, `${preset.id} should support Responses`);
    }
    assert.equal(profile.toolChoiceModes.includes('auto') || profile.omitToolChoice, true, `${preset.id} should either support auto tool_choice or omit it intentionally`);
  }
});

test('provider conformance captures domestic channel quirks used by the native adapter', () => {
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1'
  }).omitToolChoice, true);
  assert.equal(resolveOpenAiCompatibleChatTokenParameter({
    name: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro'
  }), 'max_completion_tokens');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1'
  }).interleavedReasoningField, 'reasoning_content');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Alibaba Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  }).reasoningRequestStyle, 'dashscope-enable-thinking');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1'
  }).schemaTransform, 'moonshot');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  }).reasoningRequestStyle, 'zhipu-thinking');
});

test('custom openai-compatible preset remains the generic escape hatch', () => {
  const custom = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'custom-openai');
  assert.equal(custom?.protocol, 'openai-compatible');
  const profile = resolveOpenAiCompatibleProviderProfile({
    name: custom?.name,
    protocol: custom?.protocol,
    baseUrl: custom?.baseUrl,
    apiMode: custom?.apiMode
  });

  assert.equal(profile.supportsChatCompletions, true);
  assert.equal(profile.supportsResponses, true);
  assert.equal(profile.streamingToolCalls, true);
  assert.deepEqual(profile.toolChoiceModes, ['auto', 'none', 'required']);
});

test('native provider diagnostics classify protocol failures with actionable codes', () => {
  const provider = buildOpenAiProvider();

  assert.equal(classifyNativeRuntimeError({
    provider,
    error: new Error('Provider Xiaomi MiMo does not support the OpenAI-compatible Responses API. Switch this provider to Chat Completions mode.')
  }).code, 'native_provider_api_mode_unsupported');

  assert.equal(classifyNativeRuntimeError({
    provider,
    error: new Error('Tool arguments are not valid JSON.')
  }).code, 'native_malformed_tool_arguments');

  assert.equal(classifyNativeRuntimeError({
    provider,
    error: new Error('tool_choice is unsupported for this function schema')
  }).code, 'native_tool_schema_invalid');

  assert.equal(classifyNativeRuntimeError({
    provider,
    error: Object.assign(new Error('The origin web server returned an invalid or incomplete response to Cloudflare.'), {
      statusCode: 502,
      code: 'origin_bad_gateway',
      responseBody: JSON.stringify({
        cloudflare_error: true,
        retryable: true,
        retry_after: 60
      })
    })
  }).code, 'native_overloaded');

  assert.match(classifyNativeRuntimeError({
    provider,
    error: Object.assign(new Error('模型返回了空回复。'), { code: 'MODEL_EMPTY_RESPONSE' })
  }).suggestedAction, /API mode/);
});

test('runtime doctor exposes native OpenAI-compatible protocol profile hints', async () => {
  const project = buildProject('/tmp/funplay-provider-conformance-doctor');
  const state = buildState(project) as AppState;
  const provider = buildOpenAiProvider({
    id: 'provider_mimo_responses',
    apiMode: 'responses'
  });
  state.providers.push(provider);

  const doctor = await runRuntimeDoctor(state, {
    providerId: provider.id,
    projectId: project.id
  });
  const nativeProbe = doctor.probes.find((probe) => probe.id === 'native-openai-compatible');

  assert.equal(doctor.runtimeId, 'native');
  assert.ok(nativeProbe);
  assert.ok(nativeProbe.findings.some((finding) =>
    finding.code === 'native_api_mode_unsupported' &&
    finding.runtimeId === 'native' &&
    /Chat Completions/.test(finding.suggestedAction ?? '')
  ));
  assert.ok(nativeProbe.findings.some((finding) => finding.code === 'native_streaming_tools_supported'));
  assert.ok(nativeProbe.findings.some((finding) => finding.code === 'native_tool_choice_profile'));
});
