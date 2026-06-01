import type {
  AgentToolArtifact,
  AgentToolBrowserResult,
  AgentToolCommandResult,
  AgentOperationStatus,
  AgentRuntimeRunStatus,
  AgentRuntimeTimelineEntry,
  AgentVerificationCheck,
  AgentVerificationCheckKind,
  AgentVerificationFailureDiagnosis,
  AgentVerificationFailureKind,
  AgentVerificationFailureReference,
  AgentVerificationOmittedCheck,
  AgentVerificationPlannedCheck,
  AgentVerificationReport,
  AgentVerificationSideEffectEvidence,
  AgentVerificationTrigger,
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
const VERIFICATION_COMMAND_PATTERN = /\b(test|build|lint|typecheck|check|verify|verification|vitest|jest|node --test|npm test|pnpm test|yarn test|bun test|git diff --check)\b/i;

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

function isAgentVerificationFailureKind(value: string | undefined): value is AgentVerificationFailureKind {
  return value === 'test_assertion' ||
    value === 'type_error' ||
    value === 'lint_error' ||
    value === 'build_error' ||
    value === 'runtime_error' ||
    value === 'timeout' ||
    value === 'missing_command' ||
    value === 'unknown';
}

function isAgentVerificationCheckKind(value: unknown): value is AgentVerificationCheckKind {
  return value === 'command' ||
    value === 'build' ||
    value === 'test' ||
    value === 'browser' ||
    value === 'mcp' ||
    value === 'manual';
}

function isAgentVerificationTrigger(value: unknown): value is AgentVerificationTrigger {
  return value === 'manual' ||
    value === 'timeline' ||
    value === 'tool_result' ||
    value === 'active_write' ||
    value === 'active_engine';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalStringArray(value: unknown, maxItems = 16): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maxItems);
  return items.length ? items : undefined;
}

function normalizePlannedCheck(value: unknown): AgentVerificationPlannedCheck | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = optionalString(value.id);
  const kind = value.kind;
  const title = optionalString(value.title);
  if (!id || !isAgentVerificationCheckKind(kind) || !title) {
    return undefined;
  }
  return {
    id,
    kind,
    title,
    command: optionalString(value.command),
    cwd: optionalString(value.cwd),
    target: optionalString(value.target),
    required: optionalBoolean(value.required)
  };
}

function normalizeOmittedCheck(value: unknown): AgentVerificationOmittedCheck | undefined {
  const plannedCheck = normalizePlannedCheck(value);
  if (!plannedCheck || !isPlainObject(value)) {
    return undefined;
  }
  const reason = value.reason;
  if (reason !== 'max_checks' && reason !== 'duplicate') {
    return undefined;
  }
  return {
    ...plannedCheck,
    reason
  };
}

function normalizeSideEffectEvidence(value: unknown): AgentVerificationSideEffectEvidence | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const toolName = optionalString(value.toolName);
  const kind = optionalString(value.kind);
  const confidence = value.confidence;
  if (!toolName || !kind || (confidence !== 'none' && confidence !== 'medium' && confidence !== 'high')) {
    return undefined;
  }
  return {
    toolName,
    kind,
    confidence,
    verificationTrigger: isAgentVerificationTrigger(value.verificationTrigger) ? value.verificationTrigger : undefined,
    evidence: optionalStringArray(value.evidence) ?? []
  };
}

function checkKey(check: Pick<AgentVerificationPlannedCheck, 'id' | 'command' | 'cwd'>): string {
  return check.command ? `${check.cwd ?? ''}:${check.command}` : check.id;
}

function mergePlannedChecks(
  existing: AgentVerificationPlannedCheck[] | undefined,
  next: AgentVerificationPlannedCheck[] | undefined
): AgentVerificationPlannedCheck[] | undefined {
  const merged = [...(existing ?? [])];
  for (const check of next ?? []) {
    const key = checkKey(check);
    if (merged.some((candidate) => checkKey(candidate) === key)) {
      continue;
    }
    merged.push(check);
  }
  return merged.length ? merged : undefined;
}

function mergeOmittedChecks(
  existing: AgentVerificationOmittedCheck[] | undefined,
  next: AgentVerificationOmittedCheck[] | undefined
): AgentVerificationOmittedCheck[] | undefined {
  const merged = [...(existing ?? [])];
  for (const check of next ?? []) {
    const key = `${check.reason}:${checkKey(check)}`;
    if (merged.some((candidate) => `${candidate.reason}:${checkKey(candidate)}` === key)) {
      continue;
    }
    merged.push(check);
  }
  return merged.length ? merged : undefined;
}

function sideEffectKey(item: AgentVerificationSideEffectEvidence): string {
  return [
    item.toolName,
    item.kind,
    item.confidence,
    item.verificationTrigger ?? '',
    ...item.evidence
  ].join('\u0000');
}

function mergeSideEffects(
  existing: AgentVerificationSideEffectEvidence[] | undefined,
  next: AgentVerificationSideEffectEvidence[] | undefined
): AgentVerificationSideEffectEvidence[] | undefined {
  const merged = [...(existing ?? [])];
  for (const item of next ?? []) {
    const key = sideEffectKey(item);
    if (merged.some((candidate) => sideEffectKey(candidate) === key)) {
      continue;
    }
    merged.push(item);
  }
  return merged.length ? merged : undefined;
}

function parseActiveVerificationPlanMetadata(content: string): {
  plannedChecks?: AgentVerificationPlannedCheck[];
  omittedChecks?: AgentVerificationOmittedCheck[];
  sideEffects?: AgentVerificationSideEffectEvidence[];
} | undefined {
  const metadata = content.match(/^Plan metadata:\s*(\{.+\})$/im)?.[1];
  if (!metadata) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    const plannedChecks = Array.isArray(parsed.plannedChecks)
      ? parsed.plannedChecks
        .map((check) => normalizePlannedCheck(check))
        .filter((check): check is AgentVerificationPlannedCheck => Boolean(check))
      : undefined;
    const omittedChecks = Array.isArray(parsed.omittedChecks)
      ? parsed.omittedChecks
        .map((check) => normalizeOmittedCheck(check))
        .filter((check): check is AgentVerificationOmittedCheck => Boolean(check))
      : undefined;
    const sideEffects = Array.isArray(parsed.sideEffects)
      ? parsed.sideEffects
        .map((item) => normalizeSideEffectEvidence(item))
        .filter((item): item is AgentVerificationSideEffectEvidence => Boolean(item))
      : undefined;
    return {
      plannedChecks: plannedChecks?.length ? plannedChecks : undefined,
      omittedChecks: omittedChecks?.length ? omittedChecks : undefined,
      sideEffects: sideEffects?.length ? sideEffects : undefined
    };
  } catch {
    return undefined;
  }
}

function parseActiveVerificationReference(value: string | undefined): AgentVerificationFailureReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  const path = match?.[1]?.trim();
  if (!path) {
    return undefined;
  }
  const reference: AgentVerificationFailureReference = { path };
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
  const column = match?.[3] ? Number.parseInt(match[3], 10) : undefined;
  if (Number.isFinite(line)) {
    reference.line = line;
  }
  if (Number.isFinite(column)) {
    reference.column = column;
  }
  return reference;
}

function parseActiveVerificationFailureDiagnosis(content: string): AgentVerificationFailureDiagnosis | undefined {
  const kind = content.match(/^Diagnosis:\s*([a-z_]+)/im)?.[1];
  if (!isAgentVerificationFailureKind(kind)) {
    return undefined;
  }
  const suggestedFocus = content.match(/^Suggested focus:\s*(.+)$/im)?.[1]?.trim() ?? 'Inspect the failing verification output and changed files.';
  const evidence = Array.from(content.matchAll(/^Diagnosis evidence:\s*(.+)$/gim))
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
  const references = Array.from(content.matchAll(/^Diagnosis reference:\s*(.+)$/gim))
    .map((match) => parseActiveVerificationReference(match[1]))
    .filter((item): item is AgentVerificationFailureReference => Boolean(item))
    .slice(0, 8);
  const diagnosis: AgentVerificationFailureDiagnosis = {
    kind,
    summary: `${kind} during active verification`,
    evidence,
    suggestedFocus
  };
  if (references.length > 0) {
    diagnosis.references = references;
  }
  return diagnosis;
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

function classifyCommandVerificationKind(command: string, content: string): AgentVerificationCheckKind | undefined {
  const haystack = `${command}\n${content}`;
  if (!VERIFICATION_COMMAND_PATTERN.test(haystack)) {
    return undefined;
  }
  if (/\b(test|vitest|jest|node --test|npm test|pnpm test|yarn test|bun test)\b/i.test(haystack)) {
    return 'test';
  }
  if (/\b(build|typecheck|tsc|compile)\b/i.test(haystack)) {
    return 'build';
  }
  return 'command';
}

function commandCheckId(command: AgentToolCommandResult): string {
  const suffix = `${command.cwd}:${command.command}`.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  return `check_command_${suffix || 'task'}`;
}

export function createVerificationReport(params: {
  runId: string;
  createdAt: string;
  trigger?: AgentVerificationReport['trigger'];
  blocking?: boolean;
  plannedChecks?: AgentVerificationReport['plannedChecks'];
  omittedChecks?: AgentVerificationReport['omittedChecks'];
  sideEffects?: AgentVerificationReport['sideEffects'];
}): AgentVerificationReport {
  return {
    id: `verify_${params.runId}`,
    runId: params.runId,
    status: 'pending',
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    trigger: params.trigger,
    blocking: params.blocking,
    plannedChecks: params.plannedChecks,
    omittedChecks: params.omittedChecks,
    sideEffects: params.sideEffects,
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
    command?: AgentToolCommandResult;
    browser?: AgentToolBrowserResult;
    artifacts?: AgentToolArtifact[];
  },
  updatedAt: string
): AgentVerificationReport | undefined {
  if (!report) {
    return report;
  }

  if (result.command) {
    const kind = classifyCommandVerificationKind(result.command.command, result.content);
    if (kind) {
      const activeTriggerMatch = result.content.match(/Trigger:\s*(active_write|active_engine)/);
      const activeTrigger = activeTriggerMatch?.[1] as AgentVerificationReport['trigger'] | undefined;
      const isActiveVerification = result.content.includes('[Active verification]');
      const activePlanMetadata = isActiveVerification
        ? parseActiveVerificationPlanMetadata(result.content)
        : undefined;
      const checkId = commandCheckId(result.command);
      const existingIndex = report.checks.findIndex((check) => check.id === checkId);
      const existing = existingIndex >= 0 ? report.checks[existingIndex] : undefined;
      const status: AgentVerificationStatus = result.isError || result.command.exitCode ? 'failed' : 'passed';
      const toolUseIds = Array.from(new Set([...(existing?.toolUseIds ?? []), result.toolUseId]));
      const nextCheck: AgentVerificationCheck = {
        id: checkId,
        kind,
        title: existing?.title ?? (result.content.includes('[Active verification]') ? 'Active verification command' : 'Command verification'),
        command: result.command.command,
        cwd: result.command.cwd,
        target: result.command.command,
        status,
        startedAt: existing?.startedAt ?? updatedAt,
        finishedAt: updatedAt,
        exitCode: result.command.exitCode ?? undefined,
        outputPreview: appendVerificationOutputPreview(
          existing?.outputPreview,
          `[${result.toolName ?? 'run_command'}] ${result.content}`
        ),
        errorMessage: status === 'failed' ? result.content : existing?.errorMessage,
        timelineEntryIds: existing?.timelineEntryIds,
        toolUseIds,
        artifacts: mergeArtifacts(existing?.artifacts, result.artifacts)
      };
      const checks =
        existingIndex >= 0
          ? report.checks.map((check, index) => (index === existingIndex ? nextCheck : check))
          : [...report.checks, nextCheck];
      const nextStatus = summarizeStatus(checks, 'running');
      const activeDiagnosis = result.content.includes('[Active verification]')
        ? parseActiveVerificationFailureDiagnosis(result.content)
        : undefined;

      return {
        ...report,
        updatedAt,
        trigger: isActiveVerification ? (report.trigger ?? activeTrigger ?? 'active_write') : (report.trigger ?? 'tool_result'),
        blocking: isActiveVerification ? true : report.blocking,
        plannedChecks: isActiveVerification
          ? mergePlannedChecks(report.plannedChecks, activePlanMetadata?.plannedChecks ?? [{
              id: checkId,
              kind,
              title: nextCheck.title,
              command: result.command.command,
              cwd: result.command.cwd,
              target: result.command.command,
              required: true
            }])
          : report.plannedChecks,
        omittedChecks: isActiveVerification
          ? mergeOmittedChecks(report.omittedChecks, activePlanMetadata?.omittedChecks)
          : report.omittedChecks,
        sideEffects: isActiveVerification
          ? mergeSideEffects(report.sideEffects, activePlanMetadata?.sideEffects)
          : report.sideEffects,
        failureDiagnosis: nextStatus === 'failed'
          ? activeDiagnosis ?? report.failureDiagnosis
          : undefined,
        status: nextStatus,
        checks,
        summary: summarizeChecks(checks)
      };
    }
  }

  const hasBrowserArtifact = result.artifacts?.some((artifact) => artifact.type === 'browser_screenshot') ?? false;
  const isBrowserTool = result.toolName ? BROWSER_TOOL_NAMES.has(result.toolName) : false;
  if (!isBrowserTool && !result.browser && !hasBrowserArtifact) {
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
