import type { McpPlugin, McpRawRequestResult } from '../../shared/types';
import { makeId } from '../../shared/utils';
import { postMcpJsonRpcForConfig } from './mcp-connection-manager';
import { tryAppendMcpRawAudit } from './store';

const RAW_MCP_TIMEOUT_MS = 10_000;
const RAW_MCP_MAX_PARAMS_CHARS = 32_000;
const RAW_MCP_MAX_RESULT_CHARS = 64_000;
const ALLOWED_RAW_MCP_METHODS = new Set([
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'resources/templates/list',
  'completion/complete'
]);
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|token|secret|password|credential)/i;

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(item)
    ]));
  }
  return value;
}

export function assertRawMcpMethodAllowed(method: string): string {
  const normalized = method.trim();
  if (!/^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)+$/i.test(normalized)) {
    throw new Error('Invalid MCP method name.');
  }
  if (!ALLOWED_RAW_MCP_METHODS.has(normalized)) {
    throw new Error(`Raw MCP diagnostic method is not allowed: ${normalized}`);
  }
  return normalized;
}

export async function sendRawMcpControlRequest(plugin: McpPlugin, method: string, params: Record<string, unknown> = {}): Promise<McpRawRequestResult> {
  const normalizedMethod = assertRawMcpMethodAllowed(method);
  const paramsSize = stringifyJson(params).length;
  if (paramsSize > RAW_MCP_MAX_PARAMS_CHARS) {
    throw new Error(`Raw MCP params exceed ${RAW_MCP_MAX_PARAMS_CHARS} characters.`);
  }

  const startedAt = Date.now();
  try {
    const result = await postMcpJsonRpcForConfig<unknown>(
      plugin,
      normalizedMethod,
      params,
      false,
      undefined,
      RAW_MCP_TIMEOUT_MS
    );
    const redacted = redact(result);
    const resultText = stringifyJson(redacted);
    const truncated = resultText.length > RAW_MCP_MAX_RESULT_CHARS;
    const output = {
      method: normalizedMethod,
      pluginId: plugin.id,
      durationMs: Date.now() - startedAt,
      paramsSize,
      responseSize: resultText.length,
      truncated,
      result: truncated ? undefined : redacted,
      resultPreview: truncated ? resultText.slice(0, RAW_MCP_MAX_RESULT_CHARS) : undefined
    };
    tryAppendMcpRawAudit({
      id: makeId('mcp_raw'),
      pluginId: plugin.id,
      pluginName: plugin.name,
      method: normalizedMethod,
      status: 'success',
      durationMs: output.durationMs,
      paramsSize,
      responseSize: output.responseSize
    });
    return output;
  } catch (error) {
    tryAppendMcpRawAudit({
      id: makeId('mcp_raw'),
      pluginId: plugin.id,
      pluginName: plugin.name,
      method: normalizedMethod,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      paramsSize,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
