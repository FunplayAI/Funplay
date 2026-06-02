import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAiCompatibleToolParameters } from '../../electron/main/openai-compatible-profile-transforms.ts';

function ctx(name: string, baseUrl: string, model: string) {
  return {
    provider: { name, protocol: 'openai-compatible' as const, baseUrl, apiMode: 'chat' as const },
    model,
    apiMode: 'chat' as const
  };
}

const emptyObjectSchema = () => ({ type: 'object', properties: {} });

test('MiniMax keeps empty-object parameters instead of omitting them (fixes error 2013)', () => {
  const params = normalizeOpenAiCompatibleToolParameters(
    emptyObjectSchema(),
    ctx('MiniMax', 'https://api.minimaxi.com/v1', 'MiniMax-M3')
  );
  assert.ok(params, 'MiniMax must NOT omit empty parameters');
  assert.equal(params?.type, 'object');
});

test('MiMo still keeps empty-object parameters (regression)', () => {
  const params = normalizeOpenAiCompatibleToolParameters(
    emptyObjectSchema(),
    ctx('Xiaomi MiMo', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro')
  );
  assert.ok(params);
});

test('a generic provider still omits empty parameters (behavior unchanged)', () => {
  const params = normalizeOpenAiCompatibleToolParameters(
    emptyObjectSchema(),
    ctx('Generic', 'https://example.com/v1', 'some-model')
  );
  assert.equal(params, undefined);
});

test('non-empty parameters are preserved for every provider', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const minimax = normalizeOpenAiCompatibleToolParameters({ ...schema }, ctx('MiniMax', 'https://api.minimaxi.com/v1', 'MiniMax-M3'));
  const generic = normalizeOpenAiCompatibleToolParameters({ ...schema }, ctx('Generic', 'https://example.com/v1', 'm'));
  assert.ok(minimax && (minimax.properties as Record<string, unknown>).path, 'MiniMax keeps declared properties');
  assert.ok(generic && (generic.properties as Record<string, unknown>).path, 'generic keeps declared properties');
});
