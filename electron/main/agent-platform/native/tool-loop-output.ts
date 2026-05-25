import type { WorkspaceToolActionResult } from '../workspace-tools';

export function formatInterruptedToolResult(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    '[Error]',
    'Tool execution was interrupted before returning a result.',
    detail ? `Cause: ${detail}` : ''
  ].filter(Boolean).join('\n');
}

export function formatFailedToolResult(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    '[Error]',
    'Tool execution failed before returning a result.',
    detail ? `Cause: ${detail}` : ''
  ].filter(Boolean).join('\n');
}

export function isAbortLikeError(error: unknown, abortSignal?: AbortSignal): boolean {
  return Boolean(
    abortSignal?.aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'NativeProviderStepTimeoutError'))
  );
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function truncateToolArgumentPreview(value: string, maxLength = 1200): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function normalizeToolOutputForStream(output: unknown): {
  summary: string;
  isError?: boolean;
  media?: WorkspaceToolActionResult['media'];
  changedFiles?: WorkspaceToolActionResult['changedFiles'];
  command?: WorkspaceToolActionResult['command'];
  terminal?: WorkspaceToolActionResult['terminal'];
  browser?: WorkspaceToolActionResult['browser'];
  edit?: WorkspaceToolActionResult['edit'];
  mcp?: WorkspaceToolActionResult['mcp'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
  searchText?: string;
} {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as {
      summary?: unknown;
      isError?: unknown;
      media?: unknown;
      changedFiles?: unknown;
      command?: unknown;
      terminal?: unknown;
      browser?: unknown;
      edit?: unknown;
      mcp?: unknown;
      artifacts?: unknown;
      searchText?: unknown;
    };
    return {
      summary: typeof record.summary === 'string' ? record.summary : stringifyToolOutput(output),
      isError: typeof record.isError === 'boolean' ? record.isError : undefined,
      media: Array.isArray(record.media) ? record.media as WorkspaceToolActionResult['media'] : undefined,
      changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles as WorkspaceToolActionResult['changedFiles'] : undefined,
      command: record.command && typeof record.command === 'object' && !Array.isArray(record.command) ? record.command as WorkspaceToolActionResult['command'] : undefined,
      terminal: record.terminal && typeof record.terminal === 'object' && !Array.isArray(record.terminal) ? record.terminal as WorkspaceToolActionResult['terminal'] : undefined,
      browser: record.browser && typeof record.browser === 'object' && !Array.isArray(record.browser) ? record.browser as WorkspaceToolActionResult['browser'] : undefined,
      edit: record.edit && typeof record.edit === 'object' && !Array.isArray(record.edit) ? record.edit as WorkspaceToolActionResult['edit'] : undefined,
      mcp: record.mcp && typeof record.mcp === 'object' && !Array.isArray(record.mcp) ? record.mcp as WorkspaceToolActionResult['mcp'] : undefined,
      artifacts: Array.isArray(record.artifacts) ? record.artifacts as WorkspaceToolActionResult['artifacts'] : undefined,
      searchText: typeof record.searchText === 'string' ? record.searchText : undefined
    };
  }

  return {
    summary: stringifyToolOutput(output)
  };
}
