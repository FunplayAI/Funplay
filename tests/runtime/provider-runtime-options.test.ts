import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProviderChunkTimeoutMs,
  resolveProviderRequestTimeoutMs,
  DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
} from '../../electron/main/provider-runtime-options.ts';

// Guards the stall-detection default: provider streaming now aborts+retries when
// no SSE chunk arrives for the chunk timeout, instead of hanging near the 5min
// request timeout. Catches the real failure seen in eval (provider stall under load).

test('chunk timeout defaults to the stall-detection default (120s)', () => {
  assert.equal(DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS, 120_000);
  assert.equal(resolveProviderChunkTimeoutMs(), DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS);
  assert.equal(resolveProviderChunkTimeoutMs(undefined), DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS);
});

test('provider can override the chunk timeout', () => {
  assert.equal(resolveProviderChunkTimeoutMs({ chunkTimeoutMs: 5_000 }), 5_000);
});

test('invalid chunk timeout falls back to the default', () => {
  assert.equal(resolveProviderChunkTimeoutMs({ chunkTimeoutMs: 0 }), DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS);
  assert.equal(resolveProviderChunkTimeoutMs({ chunkTimeoutMs: -1 }), DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS);
});

test('request timeout: default, explicit disable, and override', () => {
  assert.equal(resolveProviderRequestTimeoutMs(), DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  assert.equal(resolveProviderRequestTimeoutMs({ requestTimeoutMs: false }), false);
  assert.equal(resolveProviderRequestTimeoutMs({ requestTimeoutMs: 30_000 }), 30_000);
});
