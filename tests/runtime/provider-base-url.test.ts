import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnthropicBaseUrl,
  stripOpenAiCompatibleEndpointSuffix
} from '../../electron/main/provider-base-url.ts';

test('normalizeAnthropicBaseUrl keeps a /v1 base url unchanged', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.minimaxi.com/anthropic/v1'),
    'https://api.minimaxi.com/anthropic/v1'
  );
});

test('normalizeAnthropicBaseUrl strips a pasted /messages endpoint', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.minimaxi.com/anthropic/v1/messages'),
    'https://api.minimaxi.com/anthropic/v1'
  );
});

test('normalizeAnthropicBaseUrl strips /messages even with a trailing slash', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.minimaxi.com/anthropic/v1/messages/'),
    'https://api.minimaxi.com/anthropic/v1'
  );
});

test('normalizeAnthropicBaseUrl appends /v1 for a bare host', () => {
  assert.equal(normalizeAnthropicBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1');
});

test('normalizeAnthropicBaseUrl falls back to the official base url when empty', () => {
  assert.equal(normalizeAnthropicBaseUrl('   '), 'https://api.anthropic.com/v1');
});

test('stripOpenAiCompatibleEndpointSuffix strips /chat/completions', () => {
  assert.equal(
    stripOpenAiCompatibleEndpointSuffix('https://api.minimaxi.com/v1/chat/completions'),
    'https://api.minimaxi.com/v1'
  );
});

test('stripOpenAiCompatibleEndpointSuffix strips /responses', () => {
  assert.equal(
    stripOpenAiCompatibleEndpointSuffix('https://api.example.com/v1/responses'),
    'https://api.example.com/v1'
  );
});

test('stripOpenAiCompatibleEndpointSuffix leaves a /v1 base url unchanged', () => {
  assert.equal(
    stripOpenAiCompatibleEndpointSuffix('https://api.minimaxi.com/v1'),
    'https://api.minimaxi.com/v1'
  );
});

test('stripOpenAiCompatibleEndpointSuffix is case-insensitive and tolerates a trailing slash', () => {
  assert.equal(
    stripOpenAiCompatibleEndpointSuffix('https://api.example.com/v1/Chat/Completions/'),
    'https://api.example.com/v1'
  );
});
