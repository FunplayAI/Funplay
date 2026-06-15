import test from 'node:test';
import assert from 'node:assert/strict';
import {
  McpJsonRpcError,
  isAbortError,
  shouldResetConnectionForError
} from '../../electron/main/mcp-connection-manager.ts';

/**
 * The connection-reset classifier shared by callUnityTool (#4) and
 * runMcpInitializedOperation (#3): only a dead transport should tear down +
 * rebuild the cached MCP connection. Aborts/timeouts and tool-level JSON-RPC
 * errors (a live round-trip) must NOT churn the connection.
 */

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

test('isAbortError recognizes AbortError and TimeoutError', () => {
  assert.equal(isAbortError(abortError()), true);
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  assert.equal(isAbortError(timeout), true);
  assert.equal(isAbortError(new Error('boom')), false);
});

test('an abort never resets the connection (even with a network-shaped error)', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(shouldResetConnectionForError(new Error('ECONNREFUSED'), controller.signal), false);
  assert.equal(shouldResetConnectionForError(abortError()), false);
});

test('a tool-level JSON-RPC error over a live connection does not reset', () => {
  // httpStatus 200 → the HTTP round-trip succeeded; the error is application-level.
  const appError = new McpJsonRpcError('Unknown tool', { code: -32601, httpStatus: 200 });
  assert.equal(shouldResetConnectionForError(appError), false);
  // No httpStatus (e.g. stdio JSON-RPC error) is likewise a live-connection app error.
  assert.equal(shouldResetConnectionForError(new McpJsonRpcError('bad params', { code: -32602 })), false);
});

test('a 5xx JSON-RPC/HTTP error and raw transport errors do reset', () => {
  assert.equal(shouldResetConnectionForError(new McpJsonRpcError('server error', { httpStatus: 503 })), true);
  assert.equal(shouldResetConnectionForError(new Error('socket hang up')), true);
  assert.equal(shouldResetConnectionForError(new TypeError('fetch failed')), true);
});
