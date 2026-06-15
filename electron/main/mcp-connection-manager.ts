import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { Client as SdkMcpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport as SdkMcpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpConnectionSnapshot, McpConnectionStatus, McpProcessStatus, McpTransport, UnityMcpJsonRpcResponse, UnityMcpServerInfo } from '../../shared/types';
import { makeId } from '../../shared/utils';
import { logEngineWarn } from './engine-log';

export interface McpConnectionConfig {
  id?: string;
  name?: string;
  transport?: McpTransport;
  baseUrl?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface PendingStdioRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface StdioMcpProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: Interface;
  pending: Map<string | number, PendingStdioRequest>;
  stderrTail: string[];
  clientRequestHandler?: McpClientRequestHandler;
  closed: boolean;
  stopRequested: boolean;
  startedAt: string;
  stoppedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
}

interface SdkMcpConnection {
  client: SdkMcpClient;
  transport: SdkMcpTransport;
  transportName: 'streamable-http' | 'sse';
  clientRequestHandler?: McpClientRequestHandler;
  closed: boolean;
}

interface McpConnectionEntry {
  key: string;
  baseUrl: string;
  config: Required<Pick<McpConnectionConfig, 'transport'>> & McpConnectionConfig;
  status: McpConnectionStatus;
  serverInfo?: UnityMcpServerInfo;
  lastCheckedAt?: string;
  lastConnectedAt?: string;
  lastError?: string;
  initializeCount: number;
  initialization?: Promise<UnityMcpServerInfo>;
  stdio?: StdioMcpProcess;
  sdk?: SdkMcpConnection;
}

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
const connections = new Map<string, McpConnectionEntry>();

export interface McpClientRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export type McpClientRequestHandler = (request: McpClientRequest) => Promise<Record<string, unknown>>;

export class McpJsonRpcError extends Error {
  code?: number;
  httpStatus?: number;
  data?: unknown;

  constructor(message: string, options: { code?: number; httpStatus?: number; data?: unknown } = {}) {
    super(message);
    this.name = 'McpJsonRpcError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.data = options.data;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Whether a failed MCP operation warrants tearing down + rebuilding the cached
 * connection. Only TRANSPORT-dead errors should reset; resetting on a caller
 * abort/timeout (the connection is fine) or a JSON-RPC application error (a
 * successful round-trip carrying a tool-level error, httpStatus 200) just churns
 * a healthy connection — re-spawning servers and doubling latency. A JSON-RPC
 * error with a 5xx http status, or any raw network/transport error, IS treated
 * as a dead transport.
 */
export function shouldResetConnectionForError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted || isAbortError(error)) {
    return false;
  }
  if (error instanceof McpJsonRpcError) {
    return typeof error.httpStatus === 'number' && error.httpStatus >= 500;
  }
  // Raw fetch/network/transport failures (ECONNREFUSED, EPIPE, socket hang up, …).
  return true;
}

export function normalizeMcpBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function normalizeMcpConnectionConfig(input: string | McpConnectionConfig): Required<Pick<McpConnectionConfig, 'transport'>> & McpConnectionConfig {
  if (typeof input === 'string') {
    return {
      transport: 'http',
      baseUrl: normalizeMcpBaseUrl(input)
    };
  }

  if (input.transport === 'stdio') {
    return {
      ...input,
      transport: 'stdio',
      baseUrl: input.baseUrl?.trim() ?? '',
      command: input.command?.trim() ?? '',
      args: input.args ?? [],
      cwd: input.cwd?.trim() || undefined,
      env: input.env ?? {}
    };
  }

  const transport = input.transport === 'streamable-http' || input.transport === 'sse'
    ? input.transport
    : 'http';
  return {
    ...input,
    transport,
    baseUrl: normalizeMcpBaseUrl(input.baseUrl ?? '')
  };
}

function getMcpConnectionKey(config: Required<Pick<McpConnectionConfig, 'transport'>> & McpConnectionConfig): string {
  if (config.transport === 'stdio') {
    if (config.id) {
      return `stdio\u0000${config.id}`;
    }
    return ['stdio', config.command ?? '', JSON.stringify(config.args ?? []), config.cwd ?? ''].join('\u0000');
  }

  return `${config.transport}\u0000${normalizeMcpBaseUrl(config.baseUrl ?? '')}`;
}

function describeMcpConnection(config: Required<Pick<McpConnectionConfig, 'transport'>> & McpConnectionConfig): string {
  if (config.transport === 'stdio') {
    return `stdio://${config.name || config.id || config.command || 'mcp-server'}`;
  }
  return normalizeMcpBaseUrl(config.baseUrl ?? '');
}

function makeMcpRequestHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json'
  };
}

function makeAbortSignal(abortSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

function getConnectionEntry(input: string | McpConnectionConfig): McpConnectionEntry {
  const config = normalizeMcpConnectionConfig(input);
  const key = getMcpConnectionKey(config);
  const existing = connections.get(key);
  if (existing) {
    existing.config = config;
    existing.baseUrl = describeMcpConnection(config);
    return existing;
  }
  const entry: McpConnectionEntry = {
    key,
    baseUrl: describeMcpConnection(config),
    config,
    status: 'idle',
    initializeCount: 0
  };
  connections.set(key, entry);
  return entry;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeServerInfo(result: Record<string, unknown>): UnityMcpServerInfo {
  const serverInfo = (result.serverInfo ?? {}) as Record<string, unknown>;
  return {
    name: typeof serverInfo.name === 'string' ? serverInfo.name : 'Unknown MCP Server',
    version: typeof serverInfo.version === 'string' ? serverInfo.version : '0.0.0',
    protocolVersion: typeof result.protocolVersion === 'string' ? result.protocolVersion : '2024-11-05',
    capabilities: (result.capabilities ?? {}) as Record<string, unknown>
  };
}

async function readMcpJsonRpcResponse<T>(
  response: Response,
  input: {
    baseUrl: string;
    method: string;
    abortSignal?: AbortSignal;
    timeoutMs: number;
    clientRequestHandler?: McpClientRequestHandler;
  }
): Promise<T> {
  const json = (await response.json()) as UnityMcpJsonRpcResponse<T> & {
    method?: string;
    params?: Record<string, unknown>;
    error?: {
      code: number;
      message: string;
      data?: unknown;
    };
  };

  if (json.method && typeof json.id !== 'undefined' && !json.error && typeof json.result === 'undefined') {
    if (!input.clientRequestHandler) {
      throw new McpJsonRpcError(`MCP server requested ${json.method}, but no client request handler is available.`, {
        code: -32000,
        httpStatus: response.status
      });
    }
    const result = await input.clientRequestHandler({
      id: typeof json.id === 'number' || typeof json.id === 'string' ? json.id : String(json.id),
      method: json.method,
      params: json.params && typeof json.params === 'object' ? json.params : {}
    });
    return postMcpJsonRpcResponse<T>(input.baseUrl, json.id, result, input.abortSignal, input.timeoutMs, input.clientRequestHandler);
  }

  if (json.error) {
    throw new McpJsonRpcError(json.error.message || `JSON-RPC error ${json.error.code}`, {
      code: json.error.code,
      httpStatus: response.status,
      data: json.error.data
    });
  }

  if (typeof json.result === 'undefined') {
    throw new Error(`MCP returned no result for ${input.method}`);
  }

  return json.result;
}

async function postMcpJsonRpcResponse<T>(
  baseUrl: string,
  id: unknown,
  result: Record<string, unknown>,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  clientRequestHandler?: McpClientRequestHandler
): Promise<T> {
  const response = await fetch(normalizeMcpBaseUrl(baseUrl), {
    method: 'POST',
    headers: makeMcpRequestHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      result
    }),
    signal: makeAbortSignal(abortSignal, timeoutMs)
  });

  if (!response.ok) {
    try {
      return await readMcpJsonRpcResponse<T>(response, {
        baseUrl,
        method: 'client/response',
        abortSignal,
        timeoutMs,
        clientRequestHandler
      });
    } catch (error) {
      if (error instanceof McpJsonRpcError) {
        throw error;
      }
      throw new Error(`MCP HTTP ${response.status}`);
    }
  }

  if (response.status === 202 || response.status === 204) {
    return undefined as T;
  }

  return readMcpJsonRpcResponse(response, {
    baseUrl,
    method: 'client/response',
    abortSignal,
    timeoutMs,
    clientRequestHandler
  });
}

function makeStdioEnvironment(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(env ?? {})
  };
}

function writeStdioPayload(entry: McpConnectionEntry, payload: Record<string, unknown>): void {
  const stdio = entry.stdio;
  if (!stdio || stdio.closed || stdio.child.killed || !stdio.child.stdin.writable) {
    throw new Error('MCP stdio process is not writable.');
  }
  stdio.child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function rejectPendingStdioRequests(entry: McpConnectionEntry, error: Error): void {
  const pending = entry.stdio?.pending;
  if (!pending) {
    return;
  }
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function getStdioProcessStatus(stdio: StdioMcpProcess | undefined): McpProcessStatus {
  if (!stdio) {
    return 'not_started';
  }
  if (!stdio.closed) {
    return 'running';
  }
  return stdio.stopRequested ? 'stopped' : 'exited';
}

// Close the readline interface + drop its 'line' listener so the wrapped
// child.stdout readable is released. Without this the Interface keeps the stream
// referenced after the child exits — a leaked active handle that accumulates
// across reconnect churn (and pins the event loop in tests). Idempotent.
function teardownStdioReadline(stdio: StdioMcpProcess): void {
  try {
    stdio.stdout.removeAllListeners('line');
    stdio.stdout.close();
  } catch {
    // Already closed.
  }
}

function markStdioProcessStopped(stdio: StdioMcpProcess): void {
  stdio.stopRequested = true;
  stdio.stoppedAt = stdio.stoppedAt ?? new Date().toISOString();
  teardownStdioReadline(stdio);
}

function handleStdioJsonRpcMessage(entry: McpConnectionEntry, message: Record<string, unknown>): void {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : undefined;
  if (method && (typeof id === 'string' || typeof id === 'number') && typeof message.result === 'undefined' && typeof message.error === 'undefined') {
    const handler = entry.stdio?.clientRequestHandler;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    if (!handler) {
      writeStdioPayload(entry, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: `MCP server requested ${method}, but no client request handler is available.`
        }
      });
      return;
    }
    void handler({
      id,
      method,
      params
    }).then((result) => {
      try {
        writeStdioPayload(entry, {
          jsonrpc: '2.0',
          id,
          result
        });
      } catch {
      }
    }).catch((error) => {
      try {
        writeStdioPayload(entry, {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: toErrorMessage(error)
          }
        });
      } catch {
      }
    });
    return;
  }

  if (typeof id !== 'string' && typeof id !== 'number') {
    return;
  }

  const pending = entry.stdio?.pending.get(id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  entry.stdio?.pending.delete(id);

  const error = message.error && typeof message.error === 'object' ? message.error as { code?: number; message?: string; data?: unknown } : undefined;
  if (error) {
    pending.reject(new McpJsonRpcError(error.message || `JSON-RPC error ${error.code}`, {
      code: error.code,
      data: error.data
    }));
    return;
  }

  if (typeof message.result === 'undefined') {
    pending.reject(new Error(`MCP returned no result for ${pending.method}`));
    return;
  }

  pending.resolve(message.result);
}

function ensureStdioProcess(entry: McpConnectionEntry): StdioMcpProcess {
  if (entry.stdio && !entry.stdio.closed && !entry.stdio.child.killed) {
    return entry.stdio;
  }

  const command = entry.config.command?.trim();
  if (!command) {
    throw new Error('MCP stdio command is required.');
  }

  const child = spawn(command, entry.config.args ?? [], {
    cwd: entry.config.cwd,
    env: makeStdioEnvironment(entry.config.env),
    stdio: 'pipe'
  });
  const stdio: StdioMcpProcess = {
    child,
    stdout: createInterface({
      input: child.stdout
    }),
    pending: new Map(),
    stderrTail: [],
    closed: false,
    stopRequested: false,
    startedAt: new Date().toISOString()
  };
  entry.stdio = stdio;

  stdio.stdout.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      handleStdioJsonRpcMessage(entry, JSON.parse(trimmed) as Record<string, unknown>);
    } catch (error) {
      rejectPendingStdioRequests(entry, new Error(`Invalid MCP stdio JSON: ${toErrorMessage(error)}`));
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stdio.stderrTail.push(...text.split(/\r?\n/).filter(Boolean));
    if (stdio.stderrTail.length > 20) {
      stdio.stderrTail.splice(0, stdio.stderrTail.length - 20);
    }
  });

  child.on('error', (error) => {
    stdio.closed = true;
    entry.status = 'offline';
    stdio.exitCode = child.exitCode;
    stdio.exitSignal = child.signalCode;
    entry.lastError = error.message;
    teardownStdioReadline(stdio);
    rejectPendingStdioRequests(entry, error);
  });

  child.on('exit', (code, signal) => {
    stdio.closed = true;
    stdio.exitCode = code;
    stdio.exitSignal = signal;
    teardownStdioReadline(stdio);
    stdio.stoppedAt = stdio.stoppedAt ?? new Date().toISOString();
    entry.status = 'offline';
    entry.serverInfo = undefined;
    if (stdio.stopRequested) {
      entry.lastError = undefined;
      rejectPendingStdioRequests(entry, new Error('MCP stdio process stopped.'));
      return;
    }
    entry.lastError = `MCP stdio process exited${typeof code === 'number' ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`;
    rejectPendingStdioRequests(entry, new Error(entry.lastError));
  });

  return stdio;
}

async function waitForStdioExit(stdio: StdioMcpProcess, timeoutMs: number): Promise<void> {
  if (stdio.closed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!stdio.closed && !stdio.child.killed) {
        stdio.child.kill('SIGKILL');
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    stdio.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    stdio.child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopStdioProcess(entry: McpConnectionEntry, timeoutMs = 1500): Promise<void> {
  const stdio = entry.stdio;
  if (!stdio) {
    entry.status = 'offline';
    entry.lastCheckedAt = new Date().toISOString();
    return;
  }
  markStdioProcessStopped(stdio);
  entry.status = 'offline';
  entry.serverInfo = undefined;
  entry.lastCheckedAt = stdio.stoppedAt;
  entry.lastError = undefined;
  rejectPendingStdioRequests(entry, new Error('MCP stdio process stopped.'));
  if (stdio.closed) {
    return;
  }
  try {
    if (stdio.child.stdin.writable) {
      stdio.child.stdin.end();
    }
  } catch {
  }
  if (!stdio.child.killed) {
    stdio.child.kill('SIGTERM');
  }
  await waitForStdioExit(stdio, timeoutMs);
}

function forceKillStdioProcess(entry: McpConnectionEntry): void {
  const stdio = entry.stdio;
  if (!stdio) {
    return;
  }
  markStdioProcessStopped(stdio);
  rejectPendingStdioRequests(entry, new Error('MCP stdio process reset.'));
  if (!stdio.closed && !stdio.child.killed) {
    stdio.child.kill('SIGTERM');
    // The connection map entry is deleted right after this returns, dropping the
    // manager's only reference — so escalate to SIGKILL via this closure (which
    // retains the child) if it ignores SIGTERM, instead of orphaning it.
    const killTimer = setTimeout(() => {
      if (!stdio.closed && !stdio.child.killed) {
        stdio.child.kill('SIGKILL');
      }
    }, 2000);
    killTimer.unref?.();
    stdio.child.once('exit', () => clearTimeout(killTimer));
  }
}

function isSdkHttpTransport(config: McpConnectionEntry['config']): boolean {
  return config.transport === 'streamable-http' || config.transport === 'sse';
}

function makeSdkMcpTransport(entry: McpConnectionEntry): { transport: SdkMcpTransport; transportName: 'streamable-http' | 'sse' } {
  const url = new URL(normalizeMcpBaseUrl(entry.config.baseUrl ?? ''));
  if (entry.config.transport === 'sse') {
    return {
      transport: new SSEClientTransport(url),
      transportName: 'sse'
    };
  }
  return {
    transport: new StreamableHTTPClientTransport(url),
    transportName: 'streamable-http'
  };
}

function normalizeSdkServerInfo(client: SdkMcpClient): UnityMcpServerInfo {
  const serverVersion = client.getServerVersion();
  return {
    name: serverVersion?.name ?? 'Unknown MCP Server',
    version: serverVersion?.version ?? '0.0.0',
    protocolVersion: '2024-11-05',
    capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>
  };
}

async function ensureSdkMcpClient(entry: McpConnectionEntry, abortSignal: AbortSignal | undefined, timeoutMs: number): Promise<SdkMcpConnection> {
  if (entry.sdk && !entry.sdk.closed) {
    return entry.sdk;
  }

  const { transport, transportName } = makeSdkMcpTransport(entry);
  const client = new SdkMcpClient({
    name: 'Funplay',
    version: '0.1.0'
  }, {
    capabilities: {
      elicitation: {}
    }
  });

  const sdk: SdkMcpConnection = {
    client,
    transport,
    transportName,
    closed: false
  };
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const handler = sdk.clientRequestHandler;
    if (!handler) {
      throw new Error('MCP server requested elicitation, but no client request handler is available.');
    }
    return handler({
      id: makeId('sdk_elicitation'),
      method: 'elicitation/create',
      params: request.params as Record<string, unknown>
    });
  });
  transport.onclose = () => {
    // A late onclose from a transport we already replaced must not clobber a
    // freshly-reconnected entry's online status.
    if (sdk.closed) {
      return;
    }
    sdk.closed = true;
    entry.status = 'offline';
    entry.serverInfo = undefined;
    entry.lastCheckedAt = new Date().toISOString();
    // A live, previously-online transport closing out from under us is a real
    // mid-session death (server crashed/restarted), not a routine probe miss —
    // surface it instead of silently flipping the entry offline.
    logEngineWarn('mcp', `${transportName} transport closed for ${entry.config.baseUrl ?? entry.key}`);
  };
  transport.onerror = (error) => {
    if (sdk.closed) {
      return;
    }
    entry.status = 'offline';
    entry.serverInfo = undefined;
    entry.lastCheckedAt = new Date().toISOString();
    entry.lastError = error.message;
    logEngineWarn('mcp', `${transportName} transport error for ${entry.config.baseUrl ?? entry.key}`, error);
  };

  try {
    await client.connect(transport, {
      signal: abortSignal,
      timeout: timeoutMs
    });
  } catch (error) {
    sdk.closed = true;
    // Detach our handlers first so the teardown below can't fire a late
    // onclose/onerror back into this (already-failed, never-stored) entry, then
    // close BOTH client and transport — for SSE the client owns an EventSource
    // that a bare transport.close() on a half-open connection can leave dangling.
    transport.onclose = undefined;
    transport.onerror = undefined;
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }

  entry.sdk = sdk;
  return sdk;
}

async function closeSdkMcpConnection(entry: McpConnectionEntry): Promise<void> {
  const sdk = entry.sdk;
  if (!sdk || sdk.closed) {
    return;
  }
  sdk.closed = true;
  // Detach the handlers so the closing transport stops retaining the entry and
  // can't fire a late onclose/onerror against it.
  sdk.transport.onclose = undefined;
  sdk.transport.onerror = undefined;
  await sdk.client.close().catch(() => undefined);
  entry.status = 'offline';
  entry.serverInfo = undefined;
  entry.lastCheckedAt = new Date().toISOString();
}

async function postSdkMcpJsonRpc<T>(
  entry: McpConnectionEntry,
  method: string,
  params: Record<string, unknown>,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  clientRequestHandler?: McpClientRequestHandler
): Promise<T> {
  const sdk = await ensureSdkMcpClient(entry, abortSignal, timeoutMs);
  if (clientRequestHandler) {
    sdk.clientRequestHandler = clientRequestHandler;
  }
  const options = {
    signal: abortSignal,
    timeout: timeoutMs
  };
  if (method === 'tools/list') {
    return sdk.client.listTools(params, options) as Promise<T>;
  }
  if (method === 'tools/call') {
    return sdk.client.callTool(params as { name: string; arguments?: Record<string, unknown> }, undefined, options) as Promise<T>;
  }
  if (method === 'resources/list') {
    return sdk.client.listResources(params, options) as Promise<T>;
  }
  if (method === 'resources/read') {
    return sdk.client.readResource(params as { uri: string }, options) as Promise<T>;
  }
  if (method === 'prompts/list') {
    return sdk.client.listPrompts(params, options) as Promise<T>;
  }
  if (method === 'prompts/get') {
    return sdk.client.getPrompt(params as { name: string; arguments?: Record<string, string> }, options) as Promise<T>;
  }
  if (method === 'resources/templates/list') {
    return sdk.client.listResourceTemplates(params, options) as Promise<T>;
  }
  if (method === 'completion/complete') {
    return sdk.client.complete(params as never, options) as Promise<T>;
  }
  throw new Error(`Unsupported MCP SDK method: ${method}`);
}

async function postStdioMcpJsonRpc<T>(
  entry: McpConnectionEntry,
  method: string,
  params: Record<string, unknown>,
  notification: boolean,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  clientRequestHandler?: McpClientRequestHandler
): Promise<T> {
  const stdio = ensureStdioProcess(entry);
  if (clientRequestHandler) {
    stdio.clientRequestHandler = clientRequestHandler;
  }
  const id = notification ? undefined : makeId('rpc');
  const payload = {
    jsonrpc: '2.0' as const,
    ...(notification ? {} : { id }),
    method,
    params
  };

  if (notification) {
    writeStdioPayload(entry, payload);
    return undefined as T;
  }

  return new Promise<T>((resolve, reject) => {
    const requestId = id as string;
    const timer = setTimeout(() => {
      stdio.pending.delete(requestId);
      // Remove the abort listener too — the {once:true} listener only self-removes
      // if abort actually fires, so a timeout would otherwise leak it on the
      // (often long-lived) caller signal across many timed-out requests.
      abortSignal?.removeEventListener('abort', abort);
      reject(new Error(`MCP stdio ${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();

    const abort = () => {
      clearTimeout(timer);
      stdio.pending.delete(requestId);
      reject(new Error(`MCP stdio ${method} aborted.`));
    };
    abortSignal?.addEventListener('abort', abort, { once: true });

    stdio.pending.set(requestId, {
      method,
      resolve: (value) => {
        abortSignal?.removeEventListener('abort', abort);
        resolve(value as T);
      },
      reject: (error) => {
        abortSignal?.removeEventListener('abort', abort);
        reject(error);
      },
      timer
    });

    try {
      writeStdioPayload(entry, payload);
    } catch (error) {
      clearTimeout(timer);
      stdio.pending.delete(requestId);
      abortSignal?.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

export async function postMcpJsonRpc<T>(
  baseUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  notification = false,
  abortSignal?: AbortSignal,
  timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  clientRequestHandler?: McpClientRequestHandler
): Promise<T> {
  const url = normalizeMcpBaseUrl(baseUrl);
  const payload = {
    jsonrpc: '2.0' as const,
    ...(notification ? {} : { id: makeId('rpc') }),
    method,
    params
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: makeMcpRequestHeaders(),
    body: JSON.stringify(payload),
    signal: makeAbortSignal(abortSignal, timeoutMs)
  });

  if (!response.ok) {
    try {
      return await readMcpJsonRpcResponse<T>(response, {
        baseUrl,
        method,
        abortSignal,
        timeoutMs,
        clientRequestHandler
      });
    } catch (error) {
      if (error instanceof McpJsonRpcError) {
        throw error;
      }
      throw new Error(`MCP HTTP ${response.status}`);
    }
  }

  if (notification || response.status === 202 || response.status === 204) {
    return undefined as T;
  }

  return readMcpJsonRpcResponse(response, {
    baseUrl,
    method,
    abortSignal,
    timeoutMs,
    clientRequestHandler
  });
}

export async function postMcpJsonRpcForConfig<T>(
  input: string | McpConnectionConfig,
  method: string,
  params: Record<string, unknown> = {},
  notification = false,
  abortSignal?: AbortSignal,
  timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  clientRequestHandler?: McpClientRequestHandler
): Promise<T> {
  const entry = getConnectionEntry(input);
  if (entry.config.transport === 'stdio') {
    return postStdioMcpJsonRpc(entry, method, params, notification, abortSignal, timeoutMs, clientRequestHandler);
  }
  if (isSdkHttpTransport(entry.config)) {
    if (notification) {
      return undefined as T;
    }
    return postSdkMcpJsonRpc(entry, method, params, abortSignal, timeoutMs, clientRequestHandler);
  }
  return postMcpJsonRpc(entry.config.baseUrl ?? '', method, params, notification, abortSignal, timeoutMs, clientRequestHandler);
}

async function initializeMcpConnectionFresh(entry: McpConnectionEntry, abortSignal?: AbortSignal): Promise<UnityMcpServerInfo> {
  entry.status = 'connecting';
  entry.lastCheckedAt = new Date().toISOString();
  entry.lastError = undefined;

  if (isSdkHttpTransport(entry.config)) {
    const sdk = await ensureSdkMcpClient(entry, abortSignal, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    const serverInfo = normalizeSdkServerInfo(sdk.client);
    entry.status = 'online';
    entry.serverInfo = serverInfo;
    entry.lastConnectedAt = new Date().toISOString();
    entry.lastCheckedAt = entry.lastConnectedAt;
    entry.lastError = undefined;
    entry.initializeCount += 1;
    return serverInfo;
  }

  const result = await postMcpJsonRpcForConfig<Record<string, unknown>>(entry.config, 'initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: {
      name: 'Funplay',
      version: '0.1.0'
    },
    capabilities: {}
  }, false, abortSignal);

  await postMcpJsonRpcForConfig<void>(entry.config, 'notifications/initialized', {}, true, abortSignal);

  const serverInfo = normalizeServerInfo(result);
  entry.status = 'online';
  entry.serverInfo = serverInfo;
  entry.lastConnectedAt = new Date().toISOString();
  entry.lastCheckedAt = entry.lastConnectedAt;
  entry.lastError = undefined;
  entry.initializeCount += 1;
  return serverInfo;
}

export async function initializeMcpConnection(input: string | McpConnectionConfig, options: {
  abortSignal?: AbortSignal;
  force?: boolean;
} = {}): Promise<UnityMcpServerInfo> {
  const entry = getConnectionEntry(input);
  if (options.force) {
    forceKillStdioProcess(entry);
    await closeSdkMcpConnection(entry);
    entry.serverInfo = undefined;
    entry.initialization = undefined;
    entry.status = 'idle';
  }
  if (entry.serverInfo && entry.status === 'online') {
    entry.lastCheckedAt = new Date().toISOString();
    return entry.serverInfo;
  }
  if (entry.initialization) {
    return entry.initialization;
  }

  const initialization = initializeMcpConnectionFresh(entry, options.abortSignal);
  entry.initialization = initialization;
  try {
    return await initialization;
  } catch (error) {
    entry.status = 'offline';
    entry.serverInfo = undefined;
    entry.lastCheckedAt = new Date().toISOString();
    entry.lastError = toErrorMessage(error);
    throw error;
  } finally {
    if (entry.initialization === initialization) {
      entry.initialization = undefined;
    }
  }
}

export function resetMcpConnection(input: string | McpConnectionConfig): void {
  const entry = getConnectionEntry(input);
  forceKillStdioProcess(entry);
  void closeSdkMcpConnection(entry);
  connections.delete(entry.key);
}

export function resetMcpConnectionForConfig(input: string | McpConnectionConfig): void {
  const entry = getConnectionEntry(input);
  forceKillStdioProcess(entry);
  void closeSdkMcpConnection(entry);
  connections.delete(entry.key);
}

export async function stopMcpConnection(input: string | McpConnectionConfig): Promise<McpConnectionSnapshot> {
  const entry = getConnectionEntry(input);
  if (entry.config.transport === 'stdio') {
    await stopStdioProcess(entry);
  } else if (isSdkHttpTransport(entry.config)) {
    await closeSdkMcpConnection(entry);
  } else {
    entry.status = 'offline';
    entry.serverInfo = undefined;
    entry.lastCheckedAt = new Date().toISOString();
    entry.lastError = undefined;
  }
  return getMcpConnectionSnapshot(input);
}

export async function reconnectMcpConnection(input: string | McpConnectionConfig, abortSignal?: AbortSignal): Promise<UnityMcpServerInfo> {
  // Serialize close -> re-init: await the old transport's close before rebuilding,
  // so a new SDK client is never created against a still-closing transport.
  const entry = getConnectionEntry(input);
  forceKillStdioProcess(entry);
  await closeSdkMcpConnection(entry);
  connections.delete(entry.key);
  return initializeMcpConnection(input, {
    abortSignal,
    force: true
  });
}

export function getMcpConnectionSnapshot(input: string | McpConnectionConfig): McpConnectionSnapshot {
  const entry = getConnectionEntry(input);
  const stdio = entry.stdio;
  return {
    baseUrl: entry.baseUrl,
    transport: entry.config.transport,
    status: entry.status,
    serverInfo: entry.serverInfo,
    lastCheckedAt: entry.lastCheckedAt,
    lastConnectedAt: entry.lastConnectedAt,
    lastError: entry.lastError,
    initializeCount: entry.initializeCount,
    processStatus: entry.config.transport === 'stdio' ? getStdioProcessStatus(stdio) : undefined,
    pid: stdio && !stdio.closed ? stdio.child.pid : undefined,
    command: entry.config.transport === 'stdio' ? entry.config.command : undefined,
    args: entry.config.transport === 'stdio' ? [...(entry.config.args ?? [])] : undefined,
    cwd: entry.config.transport === 'stdio' ? entry.config.cwd : undefined,
    startedAt: stdio?.startedAt,
    stoppedAt: stdio?.stoppedAt,
    exitCode: stdio?.exitCode,
    exitSignal: stdio?.exitSignal,
    stderrTail: stdio ? [...stdio.stderrTail] : undefined
  };
}

export async function runMcpInitializedOperation<T>(
  baseUrl: string | McpConnectionConfig,
  abortSignal: AbortSignal | undefined,
  action: () => Promise<T>
): Promise<T> {
  await initializeMcpConnection(baseUrl, { abortSignal });
  try {
    return await action();
  } catch (error) {
    // Don't churn a healthy connection on an abort/timeout or an application-level
    // JSON-RPC error — rethrow the original immediately.
    if (!shouldResetConnectionForError(error, abortSignal)) {
      throw error;
    }
    resetMcpConnectionForConfig(baseUrl);
    try {
      await initializeMcpConnection(baseUrl, { abortSignal });
      return await action();
    } catch (retryError) {
      // Preserve the first failure as the cause rather than discarding it.
      if (retryError instanceof Error && error instanceof Error && retryError.cause === undefined) {
        retryError.cause = error;
      }
      throw retryError;
    }
  }
}
