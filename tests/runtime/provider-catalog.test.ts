import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDER_PRESETS,
  resolveProviderTokenLimits,
  resolveOpenAiCompatibleChatTokenParameter,
  resolveOpenAiCompatibleProviderProfile
} from '../../shared/provider-catalog.ts';

test('provider catalog exposes common channels plus one generic OpenAI-compatible preset', () => {
  assert.deepEqual(
    AI_PROVIDER_PRESETS.map((preset) => preset.id),
    [
      'openai',
      'openrouter',
      'anthropic',
      'gemini',
      'deepseek',
      'qwen-dashscope',
      'kimi-moonshot',
      'zhipu-glm',
      'siliconflow',
      'xiaomi-mimo',
      'minimax',
      'custom-openai'
    ]
  );
  assert.equal(AI_PROVIDER_PRESETS.filter((preset) => preset.id.startsWith('custom-')).length, 1);
  assert.equal(AI_PROVIDER_PRESETS.some((preset) => preset.id === 'packyapi'), false);
  assert.equal(AI_PROVIDER_PRESETS.some((preset) => preset.id === 'claude-sdk-proxy'), false);
  assert.equal(AI_PROVIDER_PRESETS.some((preset) => preset.id === 'bedrock'), false);
  assert.equal(AI_PROVIDER_PRESETS.some((preset) => preset.id === 'vertex'), false);
});

test('provider catalog records domestic OpenAI-compatible protocol differences', () => {
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Alibaba Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  }).supportsResponses, true);
  assert.equal(resolveOpenAiCompatibleChatTokenParameter({
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6'
  }), 'max_completion_tokens');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  }).reasoningContent, true);
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1'
  }).schemaTransform, 'moonshot');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Alibaba Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  }).reasoningRequestStyle, 'dashscope-enable-thinking');
  assert.equal(resolveOpenAiCompatibleProviderProfile({
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  }).reasoningRequestStyle, 'zhipu-thinking');
});

test('provider catalog carries verified context and output limits for common providers', () => {
  const openai = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'openai');
  const gemini = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'gemini');
  const deepseek = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek');
  const zhipu = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'zhipu-glm');
  const mimo = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'xiaomi-mimo');

  assert.equal(openai?.availableModels?.find((model) => model.modelId === 'gpt-5.5')?.capabilities?.contextWindow, 400_000);
  assert.equal(openai?.availableModels?.find((model) => model.modelId === 'gpt-5.5')?.capabilities?.maxOutputTokens, 128_000);
  assert.equal(openai?.availableModels?.find((model) => model.modelId === 'gpt-5.2')?.capabilities?.contextWindow, 400_000);
  assert.equal(openai?.availableModels?.find((model) => model.modelId === 'gpt-5.2')?.capabilities?.maxOutputTokens, 128_000);

  assert.equal(gemini?.availableModels?.find((model) => model.modelId === 'gemini-3.1-pro-preview')?.capabilities?.contextWindow, 1_048_576);
  assert.equal(gemini?.availableModels?.find((model) => model.modelId === 'gemini-3.1-pro-preview')?.capabilities?.maxOutputTokens, 65_536);

  assert.equal(deepseek?.availableModels?.find((model) => model.modelId === 'deepseek-chat')?.capabilities?.maxOutputTokens, 384_000);

  assert.equal(zhipu?.availableModels?.find((model) => model.modelId === 'glm-5.1')?.capabilities?.contextWindow, 200_000);
  assert.equal(zhipu?.availableModels?.find((model) => model.modelId === 'glm-5.1')?.capabilities?.maxOutputTokens, 128_000);

  assert.equal(mimo?.availableModels?.find((model) => model.modelId === 'mimo-v2.5-pro')?.capabilities?.contextWindow, 1_000_000);
  assert.equal(mimo?.availableModels?.find((model) => model.modelId === 'mimo-v2.5-pro')?.capabilities?.maxOutputTokens, 131_072);
});

test('provider token limit resolution merges stale stored models with newer preset defaults', () => {
  const limits = resolveProviderTokenLimits({
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    availableModels: [
      { modelId: 'gpt-5.5', displayName: 'GPT-5.5', capabilities: { toolUse: true, vision: true, contextWindow: 1_000_000 } }
    ],
    contextWindowTokens: undefined,
    maxOutputTokens: undefined
  });

  assert.equal(limits.modelId, 'gpt-5.5');
  assert.equal(limits.presetContextWindowTokens, 400_000);
  assert.equal(limits.presetMaxOutputTokens, 128_000);
  assert.equal(limits.effectiveMaxOutputTokens, 128_000);
});
