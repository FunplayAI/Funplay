import type { AgentRuntimeStatus, AiProvider, Project, RuntimeUsageTotals } from '../../../../shared/types';
import { localize, type UiLanguage } from '../../../i18n';

// Project-settings data + formatting helpers shared by the token-usage and
// agent-runs tab components and the ProjectSettingsPage shell. Extracted from
// the former monolithic ProjectSettingsPage.tsx (U47 slice).

export interface ProjectTokenUsageSummary extends RuntimeUsageTotals {
  trackedRunCount: number;
  usageRunCount: number;
  latestUpdatedAt?: string;
  statusCounts: Record<AgentRuntimeStatus['status'], number>;
  verificationRunCount: number;
  verificationCheckCount: number;
  verificationPassedCount: number;
  verificationFailedCount: number;
  browserVerificationCount: number;
  runtimeEventCount: number;
  failedToolResultCount: number;
  toolRetryCount: number;
  providerModelGroups: Array<{
    id: string;
    label: string;
    turns: number;
    runs: number;
    totalTokens: number;
  }>;
}

export interface ProjectAgentRunListItem {
  id: string;
  kind: AgentRuntimeStatus['kind'];
  status: AgentRuntimeStatus['status'];
  updatedAt: string;
  startedAt: string;
  canResume: boolean;
  sessionTitle?: string;
  inputPreview?: string;
  lastError?: string;
  runtimeId?: string;
  providerLabel?: string;
  model?: string;
  resumeStrategy?: AgentRuntimeStatus['resumeStrategy'];
  totalTokens?: number;
  verificationCheckCount: number;
  failedToolResultCount: number;
}

export interface ProjectAgentRunSummary {
  trackedRunCount: number;
  runningRunCount: number;
  completedRunCount: number;
  failedRunCount: number;
  interruptedRunCount: number;
  resumableRunCount: number;
  latestUpdatedAt?: string;
  verificationRunCount: number;
  verificationCheckCount: number;
  verificationPassedCount: number;
  verificationFailedCount: number;
  browserVerificationCount: number;
  runtimeEventCount: number;
  failedToolResultCount: number;
  toolRetryCount: number;
  recentRuns: ProjectAgentRunListItem[];
}

function countRepeatedToolResults(run: AgentRuntimeStatus): number {
  const counts = new Map<string, number>();
  for (const event of run.events ?? []) {
    if (event.type !== 'tool_result' || !event.toolResult?.toolUseId) {
      continue;
    }
    counts.set(event.toolResult.toolUseId, (counts.get(event.toolResult.toolUseId) ?? 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

export function buildProjectTokenUsage(input: {
  project: Project | null;
  runtimeStatuses: AgentRuntimeStatus[];
  providers: AiProvider[];
}): ProjectTokenUsageSummary {
  const providerNames = new Map(input.providers.map((provider) => [provider.id, provider.name]));
  const projectRuns = input.project
    ? input.runtimeStatuses.filter((status) => status.projectId === input.project?.id)
    : [];
  const statusCounts: ProjectTokenUsageSummary['statusCounts'] = {
    running: 0,
    interrupted: 0,
    failed: 0,
    completed: 0
  };
  const usageTotals: RuntimeUsageTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  };
  const groups = new Map<string, ProjectTokenUsageSummary['providerModelGroups'][number]>();
  let usageRunCount = 0;
  let latestUpdatedAt: string | undefined;
  let verificationRunCount = 0;
  let verificationCheckCount = 0;
  let verificationPassedCount = 0;
  let verificationFailedCount = 0;
  let browserVerificationCount = 0;
  let runtimeEventCount = 0;
  let failedToolResultCount = 0;
  let toolRetryCount = 0;

  for (const run of projectRuns) {
    statusCounts[run.status] += 1;
    if (!latestUpdatedAt || run.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = run.updatedAt;
    }
    if (run.verification) {
      verificationRunCount += 1;
      verificationCheckCount += run.verification.checks.length;
      verificationPassedCount += run.verification.checks.filter((check) => check.status === 'passed').length;
      verificationFailedCount += run.verification.checks.filter((check) => check.status === 'failed').length;
      browserVerificationCount += run.verification.checks.filter((check) => check.kind === 'browser').length;
    }
    runtimeEventCount += run.events?.length ?? 0;
    failedToolResultCount +=
      run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0;
    toolRetryCount += countRepeatedToolResults(run);

    if (!run.usage) {
      continue;
    }

    usageRunCount += 1;
    usageTotals.turns += run.usage.turns;
    usageTotals.inputTokens += run.usage.inputTokens;
    usageTotals.outputTokens += run.usage.outputTokens;
    usageTotals.cacheCreationTokens += run.usage.cacheCreationTokens;
    usageTotals.cacheReadTokens += run.usage.cacheReadTokens;
    usageTotals.totalTokens += run.usage.totalTokens;

    const providerLabel = run.providerId ? (providerNames.get(run.providerId) ?? run.providerId) : 'Provider';
    const modelLabel = run.model?.trim();
    const label = modelLabel ? `${providerLabel} · ${modelLabel}` : providerLabel;
    const groupId = `${run.providerId ?? 'provider'}:${modelLabel ?? 'model'}`;
    const existing = groups.get(groupId) ?? {
      id: groupId,
      label,
      turns: 0,
      runs: 0,
      totalTokens: 0
    };
    existing.turns += run.usage.turns;
    existing.runs += 1;
    existing.totalTokens += run.usage.totalTokens;
    groups.set(groupId, existing);
  }

  return {
    trackedRunCount: projectRuns.length,
    usageRunCount,
    latestUpdatedAt,
    statusCounts,
    verificationRunCount,
    verificationCheckCount,
    verificationPassedCount,
    verificationFailedCount,
    browserVerificationCount,
    runtimeEventCount,
    failedToolResultCount,
    toolRetryCount,
    providerModelGroups: [...groups.values()].sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 6),
    ...usageTotals
  };
}

export function buildProjectAgentRunSummary(input: {
  project: Project | null;
  runtimeStatuses: AgentRuntimeStatus[];
  providers: AiProvider[];
}): ProjectAgentRunSummary {
  const providerNames = new Map(input.providers.map((provider) => [provider.id, provider.name]));
  const sessionTitles = new Map(input.project?.sessions.map((session) => [session.id, session.title]) ?? []);
  const projectRuns = input.project
    ? input.runtimeStatuses.filter((status) => status.projectId === input.project?.id)
    : [];
  let latestUpdatedAt: string | undefined;
  let verificationRunCount = 0;
  let verificationCheckCount = 0;
  let verificationPassedCount = 0;
  let verificationFailedCount = 0;
  let browserVerificationCount = 0;
  let runtimeEventCount = 0;
  let failedToolResultCount = 0;
  let toolRetryCount = 0;

  for (const run of projectRuns) {
    if (!latestUpdatedAt || run.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = run.updatedAt;
    }
    if (run.verification) {
      verificationRunCount += 1;
      verificationCheckCount += run.verification.checks.length;
      verificationPassedCount += run.verification.checks.filter((check) => check.status === 'passed').length;
      verificationFailedCount += run.verification.checks.filter((check) => check.status === 'failed').length;
      browserVerificationCount += run.verification.checks.filter((check) => check.kind === 'browser').length;
    }
    runtimeEventCount += run.events?.length ?? 0;
    failedToolResultCount +=
      run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0;
    toolRetryCount += countRepeatedToolResults(run);
  }

  const recentRuns = projectRuns
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 10)
    .map<ProjectAgentRunListItem>((run) => ({
      id: run.id,
      kind: run.kind,
      status: run.status,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      canResume: run.canResume,
      sessionTitle: run.sessionId ? sessionTitles.get(run.sessionId) : undefined,
      inputPreview: run.inputPreview,
      lastError: run.lastError,
      runtimeId: run.runtimeId,
      providerLabel: run.providerId ? (providerNames.get(run.providerId) ?? run.providerId) : undefined,
      model: run.model,
      resumeStrategy: run.resumeStrategy,
      totalTokens: run.usage?.totalTokens,
      verificationCheckCount: run.verification?.checks.length ?? 0,
      failedToolResultCount:
        run.events?.filter((event) => event.type === 'tool_result' && event.toolResult?.isError).length ?? 0
    }));

  return {
    trackedRunCount: projectRuns.length,
    runningRunCount: projectRuns.filter((run) => run.status === 'running').length,
    completedRunCount: projectRuns.filter((run) => run.status === 'completed').length,
    failedRunCount: projectRuns.filter((run) => run.status === 'failed').length,
    interruptedRunCount: projectRuns.filter((run) => run.status === 'interrupted').length,
    resumableRunCount: projectRuns.filter((run) => run.canResume).length,
    latestUpdatedAt,
    verificationRunCount,
    verificationCheckCount,
    verificationPassedCount,
    verificationFailedCount,
    browserVerificationCount,
    runtimeEventCount,
    failedToolResultCount,
    toolRetryCount,
    recentRuns
  };
}

export function formatRunKind(kind: AgentRuntimeStatus['kind'], language: UiLanguage): string {
  if (kind === 'bootstrap') {
    return localize(language, '初始化', 'Bootstrap');
  }
  return localize(language, '会话', 'Conversation');
}

export function formatRuntimeRunStatus(status: AgentRuntimeStatus['status'], language: UiLanguage): string {
  const labels: Record<AgentRuntimeStatus['status'], string> = {
    running: localize(language, '运行中', 'Running'),
    interrupted: localize(language, '已中断', 'Interrupted'),
    failed: localize(language, '失败', 'Failed'),
    completed: localize(language, '完成', 'Completed')
  };
  return labels[status];
}

export function formatResumeStrategy(
  strategy: NonNullable<AgentRuntimeStatus['resumeStrategy']>,
  language: UiLanguage
): string {
  const labels: Record<NonNullable<AgentRuntimeStatus['resumeStrategy']>, string> = {
    restart_prompt: localize(language, '重新执行请求', 'Restart prompt'),
    resume_after_last_completed_tool: localize(language, '从最近工具边界继续', 'Resume after last tool'),
    resume_from_checkpoint: localize(language, '从检查点恢复', 'Resume from checkpoint')
  };
  return labels[strategy];
}

export function formatNumber(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language).format(value);
}

export function formatTokenCount(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language, {
    notation: 'compact',
    maximumFractionDigits: value >= 1000 ? 1 : 0
  }).format(value);
}
