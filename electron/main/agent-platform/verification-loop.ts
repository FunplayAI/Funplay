import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentOperationStatus,
  AgentRuntimeRunStatus,
  AgentRuntimeTimelineEntry,
  AgentVerificationCheck,
  AgentVerificationCheckKind,
  AgentVerificationReport,
  AgentVerificationStatus
} from '../../../shared/types';

const BROWSER_TOOL_NAMES = new Set([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_console',
  'browser_list',
  'browser_close'
]);

const MAX_VERIFICATION_OUTPUT_PREVIEW_CHARS = 2400;

function normalizeText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function classifyVerificationKind(entry: Pick<AgentRuntimeTimelineEntry, 'phase' | 'title' | 'target'>): AgentVerificationCheckKind | undefined {
  const haystack = [
    normalizeText(entry.phase),
    normalizeText(entry.title),
    normalizeText(entry.target)
  ].join(' ');

  if (!/\b(test|build|verify|verification|validate|validation|browser|playwright|mcp|benchmark|gate|check)\b/.test(haystack)) {
    return undefined;
  }
  if (/\b(build|compile|tsc|vite)\b/.test(haystack)) return 'build';
  if (/\b(test|vitest|jest|node --test|npm test)\b/.test(haystack)) return 'test';
  if (/\b(browser|playwright|screenshot|viewport)\b/.test(haystack)) return 'browser';
  if (/\b(mcp|tool server|resource)\b/.test(haystack)) return 'mcp';
  if (/\b(command|shell|script|benchmark|gate)\b/.test(haystack)) return 'command';
  return 'manual';
}

function mapOperationStatus(status: AgentOperationStatus): AgentVerificationStatus {
  if (status === 'completed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'running') return 'running';
  return 'pending';
}

function summarizeStatus(checks: AgentVerificationCheck[], runStatus: AgentRuntimeRunStatus): AgentVerificationStatus {
  if (checks.length === 0) {
    return runStatus === 'running' ? 'pending' : 'skipped';
  }
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => check.status === 'running')) return 'running';
  if (checks.some((check) => check.status === 'pending')) return runStatus === 'completed' ? 'skipped' : 'pending';
  if (checks.some((check) => check.status === 'passed')) return 'passed';
  return 'skipped';
}

function summarizeChecks(checks: AgentVerificationCheck[]): string {
  return `${checks.filter((check) => check.status === 'passed').length}/${checks.length} verification checks passed.`;
}

function compactVerificationOutputPreview(value: string): string {
  if (value.length <= MAX_VERIFICATION_OUTPUT_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_VERIFICATION_OUTPUT_PREVIEW_CHARS - 1)}…`;
}

function appendVerificationOutputPreview(existing: string | undefined, next: string | undefined): string | undefined {
  const parts = [existing, next?.trim()].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return undefined;
  }
  return compactVerificationOutputPreview(parts.join('\n\n'));
}

function mergeBrowserMetadata(existing: AgentToolBrowserResult | undefined, next: AgentToolBrowserResult | undefined): AgentToolBrowserResult | undefined {
  if (!existing && !next) {
    return undefined;
  }
  const merged: AgentToolBrowserResult = { ...(existing ?? {}) };
  if (next?.sessionId !== undefined) merged.sessionId = next.sessionId;
  if (next?.url !== undefined) merged.url = next.url;
  if (next?.title !== undefined) merged.title = next.title;
  if (next?.viewport !== undefined) merged.viewport = next.viewport;
  if (next?.screenshotPath !== undefined) merged.screenshotPath = next.screenshotPath;
  if (next?.consoleMessageCount !== undefined) merged.consoleMessageCount = next.consoleMessageCount;
  return merged;
}

function mergeArtifacts(existing: AgentToolArtifact[] | undefined, next: AgentToolArtifact[] | undefined): AgentToolArtifact[] | undefined {
  const merged = [...(existing ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  return merged.filter((artifact) => {
    const key = `${artifact.type}:${artifact.path ?? artifact.title ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function browserCheckId(browser: AgentToolBrowserResult | undefined): string {
  const suffix = (browser?.sessionId ?? 'task').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `check_browser_${suffix}`;
}

export function createVerificationReport(params: {
  runId: string;
  createdAt: string;
}): AgentVerificationReport {
  return {
    id: `verify_${params.runId}`,
    runId: params.runId,
    status: 'pending',
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    checks: [],
    summary: 'No automated verification checks have run yet.'
  };
}

export function updateVerificationReportFromTimelineEntry(
  report: AgentVerificationReport | undefined,
  entry: AgentRuntimeTimelineEntry,
  updatedAt: string
): AgentVerificationReport | undefined {
  const kind = classifyVerificationKind(entry);
  if (!report || !kind) {
    return report;
  }

  const checkId = `check_${entry.id}`;
  const existingIndex = report.checks.findIndex((check) => check.id === checkId);
  const existing = existingIndex >= 0 ? report.checks[existingIndex] : undefined;
  const nextCheck: AgentVerificationCheck = {
    id: checkId,
    kind,
    title: entry.title || entry.target || `${kind} check`,
    target: entry.target,
    status: mapOperationStatus(entry.status),
    startedAt: existing?.startedAt ?? entry.startedAt ?? updatedAt,
    finishedAt: entry.finishedAt ?? (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'skipped' ? updatedAt : existing?.finishedAt),
    outputPreview: entry.summary ?? existing?.outputPreview,
    errorMessage: entry.errorMessage ?? existing?.errorMessage,
    timelineEntryIds: Array.from(new Set([...(existing?.timelineEntryIds ?? []), entry.id]))
  };
  const checks =
    existingIndex >= 0
      ? report.checks.map((check, index) => (index === existingIndex ? nextCheck : check))
      : [...report.checks, nextCheck];

  return {
    ...report,
    updatedAt,
    status: summarizeStatus(checks, 'running'),
    checks,
    summary: summarizeChecks(checks)
  };
}

export function updateVerificationReportFromToolResult(
  report: AgentVerificationReport | undefined,
  result: {
    toolUseId: string;
    toolName?: string;
    content: string;
    isError?: boolean;
    browser?: AgentToolBrowserResult;
    artifacts?: AgentToolArtifact[];
  },
  updatedAt: string
): AgentVerificationReport | undefined {
  const hasBrowserArtifact = result.artifacts?.some((artifact) => artifact.type === 'browser_screenshot') ?? false;
  const isBrowserTool = result.toolName ? BROWSER_TOOL_NAMES.has(result.toolName) : false;
  if (!report || (!isBrowserTool && !result.browser && !hasBrowserArtifact)) {
    return report;
  }

  const checkId = browserCheckId(result.browser);
  const existingIndex = report.checks.findIndex((check) => check.id === checkId);
  const existing = existingIndex >= 0 ? report.checks[existingIndex] : undefined;
  const status: AgentVerificationStatus = result.isError || existing?.status === 'failed' ? 'failed' : 'passed';
  const browser = mergeBrowserMetadata(existing?.browser, result.browser);
  const toolUseIds = Array.from(new Set([...(existing?.toolUseIds ?? []), result.toolUseId]));
  const nextCheck: AgentVerificationCheck = {
    id: checkId,
    kind: 'browser',
    title: existing?.title ?? 'Browser verification',
    target: browser?.url ?? browser?.title ?? existing?.target ?? result.toolName ?? 'browser',
    status,
    startedAt: existing?.startedAt ?? updatedAt,
    finishedAt: updatedAt,
    outputPreview: appendVerificationOutputPreview(
      existing?.outputPreview,
      `[${result.toolName ?? 'browser'}] ${result.content}`
    ),
    errorMessage: result.isError ? result.content : existing?.errorMessage,
    timelineEntryIds: existing?.timelineEntryIds,
    toolUseIds,
    browser,
    artifacts: mergeArtifacts(existing?.artifacts, result.artifacts)
  };
  const checks =
    existingIndex >= 0
      ? report.checks.map((check, index) => (index === existingIndex ? nextCheck : check))
      : [...report.checks, nextCheck];

  return {
    ...report,
    updatedAt,
    status: summarizeStatus(checks, 'running'),
    checks,
    summary: summarizeChecks(checks)
  };
}

export function finalizeVerificationReport(
  report: AgentVerificationReport | undefined,
  runStatus: AgentRuntimeRunStatus,
  updatedAt: string
): AgentVerificationReport | undefined {
  if (!report) {
    return undefined;
  }

  const checks = report.checks.map((check) => {
    if (check.status !== 'running') {
      return check;
    }
    return {
      ...check,
      status: runStatus === 'completed' ? 'passed' as const : runStatus === 'failed' ? 'failed' as const : 'skipped' as const,
      finishedAt: check.finishedAt ?? updatedAt
    };
  });
  const status = summarizeStatus(checks, runStatus);

  return {
    ...report,
    updatedAt,
    status,
    checks,
    summary: checks.length > 0
      ? summarizeChecks(checks)
      : 'No automated verification checks were recorded.'
  };
}
