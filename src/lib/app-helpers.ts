import { formatProjectDocument } from '../../shared/planner';
import { agentCorePartsToPlainText } from '../../shared/agent-core-v2';
import { ensureProjectSessions } from '../../shared/project-sessions';
import {
  type AgentOperationRecord,
  type AgentRuntimeStatus,
  type AgentSkillCatalogItem,
  type AppNotification,
  type AppUpdateSnapshot,
  type EngineProjectDimension,
  type EnvironmentDiagnostics,
  type EnvironmentTask,
  type McpPlugin,
  type PlatformChoice,
  type Project,
  type ProjectAgentAggregateState,
  type ProjectFileEntry,
  type ProjectMemoryFileSummary,
  type ProjectSetupMode,
  type ScheduledNotificationTask
} from '../../shared/types';
import { getDocumentLanguage, localize } from '../i18n';
import type { ProjectFileItem } from '../components/layout/WorkspacePanels';
import type { QueuedPromptItem } from '../components/chat/ChatComposer';
import type { SessionListState } from '../components/layout/SessionManagementPanel';
import {
  type StreamSessionState
} from '../lib/stream-session-manager';
import type {
  AssetLibraryCategoryId,
  AssetLibraryCategory,
  AssetLibraryFileItem,
  LanguagePreference,
  ProjectAgentSkillDraft,
  UiPreferences
} from './app-types';

const workspaceLayoutStorageKey = 'funplay.workspace.layout.v1';
const uiPreferencesStorageKey = 'funplay.ui.preferences.v1';

function resolveSystemLanguagePreference(): LanguagePreference {
  if (typeof navigator === 'undefined') {
    return 'en-US';
  }
  const languages = [
    ...Array.from(navigator.languages ?? []),
    navigator.language
  ].filter((language): language is string => typeof language === 'string' && language.trim().length > 0);
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith('zh')) {
      return 'zh-CN';
    }
    if (normalized.startsWith('en')) {
      return 'en-US';
    }
  }
  return 'en-US';
}

function createDefaultUiPreferences(): UiPreferences {
  return {
    theme: 'light',
    language: resolveSystemLanguagePreference(),
    developerMode: false
  };
}

export function countProjectMessages(project: Project): number {
  return project.sessions.reduce((total, session) => total + session.chat.length, 0);
}

export function mergeProjectRuntimeRefresh(current: Project, incoming: Project): Project {
  const currentUpdatedAt = new Date(current.updatedAt).getTime();
  const incomingUpdatedAt = new Date(incoming.updatedAt).getTime();
  const shouldPreserveConversation =
    currentUpdatedAt > incomingUpdatedAt || countProjectMessages(current) > countProjectMessages(incoming);

  if (!shouldPreserveConversation) {
    return incoming;
  }

  return {
    ...current,
    engine: incoming.engine,
    runtimeState: incoming.runtimeState
  };
}

export function mergeProjectSessionSelection(current: Project, incoming: Project): Project {
  const currentEnsured = ensureProjectSessions(current);
  const incomingEnsured = ensureProjectSessions(incoming);
  const incomingSessionById = new Map(incomingEnsured.sessions.map((session) => [session.id, session]));

  const mergedSessions = currentEnsured.sessions.map((session) => {
    const incomingSession = incomingSessionById.get(session.id);
    if (!incomingSession) {
      return session;
    }

    return {
      ...session,
      title: incomingSession.title,
      autoTitle: incomingSession.autoTitle,
      updatedAt: incomingSession.updatedAt,
      runtimeOverrides: incomingSession.runtimeOverrides ? { ...incomingSession.runtimeOverrides } : undefined,
      chat: [...incomingSession.chat]
    };
  });

  for (const incomingSession of incomingEnsured.sessions) {
    if (!mergedSessions.some((session) => session.id === incomingSession.id)) {
      mergedSessions.push({
        ...incomingSession,
        runtimeOverrides: incomingSession.runtimeOverrides ? { ...incomingSession.runtimeOverrides } : undefined,
        chat: [...incomingSession.chat]
      });
    }
  }

  const resolvedActiveSessionId =
    incomingEnsured.activeSessionId && mergedSessions.some((session) => session.id === incomingEnsured.activeSessionId)
      ? incomingEnsured.activeSessionId
      : currentEnsured.activeSessionId || mergedSessions[0]?.id;
  const activeSession = mergedSessions.find((session) => session.id === resolvedActiveSessionId) ?? mergedSessions[0];

  return {
    ...incomingEnsured,
    sessions: mergedSessions,
    activeSessionId: resolvedActiveSessionId,
    chat: [...(activeSession?.chat ?? [])]
  };
}

export function dedupeAppNotifications(notifications: AppNotification[]): AppNotification[] {
  const byId = new Map<string, AppNotification>();
  for (const notification of notifications) {
    byId.set(notification.id, notification);
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-4);
}

export function formatNotificationTaskStatus(status: ScheduledNotificationTask['status'], language: LanguagePreference): string {
  if (status === 'active') {
    return localize(language, '进行中', 'Active');
  }
  if (status === 'completed') {
    return localize(language, '已完成', 'Completed');
  }
  return localize(language, '已取消', 'Cancelled');
}

export function formatMemoryKindLabel(kind: ProjectMemoryFileSummary['kind'], language: LanguagePreference): string {
  if (kind === 'longterm') {
    return localize(language, '长期', 'Long-term');
  }
  if (kind === 'daily') {
    return localize(language, '每日', 'Daily');
  }
  return localize(language, '笔记', 'Note');
}

export function formatMemoryEntryKindLabel(kind: ProjectMemoryFileSummary['memoryKinds'][number], language: LanguagePreference): string {
  if (kind === 'user_preference') {
    return localize(language, '偏好', 'Preference');
  }
  if (kind === 'project_fact') {
    return localize(language, '事实', 'Fact');
  }
  if (kind === 'decision') {
    return localize(language, '决策', 'Decision');
  }
  return localize(language, '任务状态', 'Task State');
}

export function formatAppUpdateStatus(status: AppUpdateSnapshot['status'], language: LanguagePreference): string {
  switch (status) {
    case 'not_configured':
      return localize(language, '未配置', 'Not Configured');
    case 'unsupported':
      return localize(language, '不支持', 'Unsupported');
    case 'checking':
      return localize(language, '检查中', 'Checking');
    case 'available':
      return localize(language, '有新版本', 'Update Available');
    case 'not_available':
      return localize(language, '已是最新', 'Up to Date');
    case 'downloading':
      return localize(language, '下载中', 'Downloading');
    case 'downloaded':
      return localize(language, '待安装', 'Ready to Install');
    case 'installing':
      return localize(language, '安装中', 'Installing');
    case 'error':
      return localize(language, '更新异常', 'Update Error');
    case 'idle':
    default:
      return localize(language, '待检查', 'Idle');
  }
}

export function formatAppUpdateFeedSource(source: AppUpdateSnapshot['feedSource'], language: LanguagePreference): string {
  if (source === 'embedded') {
    return localize(language, 'GitHub Releases', 'GitHub Releases');
  }
  return localize(language, '未配置', 'Not Configured');
}

export function resolveAppUpdateActionMessage(snapshot: AppUpdateSnapshot, language: LanguagePreference): string {
  if (snapshot.error) {
    return snapshot.error;
  }
  if (snapshot.status === 'available') {
    return localize(language, `发现新版本 ${snapshot.updateInfo?.version ?? ''}。`, `Version ${snapshot.updateInfo?.version ?? ''} is available.`);
  }
  if (snapshot.status === 'not_available') {
    return localize(language, '当前已经是最新版本。', 'You are already on the latest version.');
  }
  if (snapshot.status === 'downloaded') {
    return localize(language, '更新已下载，重启后会安装。', 'The update has been downloaded and will install after restart.');
  }
  if (snapshot.status === 'installing') {
    return localize(language, '正在重启并安装更新。', 'Restarting to install the update.');
  }
  if (snapshot.status === 'not_configured') {
    return localize(language, '当前没有配置更新源。', 'No update feed is configured.');
  }
  return formatAppUpdateStatus(snapshot.status, language);
}

export function buildVirtualProjectFiles(project: Project): ProjectFileItem[] {
  const language = getDocumentLanguage();
  const baseFiles: ProjectFileItem[] = [
    {
      id: 'execution-plan',
      label: 'execution-plan.json',
      path: 'runtime/execution-plan.json',
      badge: project.currentExecutionPlan ? localize(language, '新', 'New') : undefined,
      content: JSON.stringify(project.currentExecutionPlan ?? {}, null, 2)
    },
    {
      id: 'project-doc',
      label: 'project-context.md',
      path: 'docs/project-context.md',
      content: formatProjectDocument(project)
    },
    {
      id: 'agent-run',
      label: 'agent-run.json',
      path: 'runtime/agent-run.json',
      badge: project.lastAgentRun ? localize(language, '运行', 'Run') : undefined,
      content: JSON.stringify(normalizeAgentRunForView(project.lastAgentRun), null, 2)
    },
    {
      id: 'particles',
      label: 'particles.css',
      path: 'src/styles/particles.css',
      badge: project.assets.some((asset) => asset.type === 'vfx') ? localize(language, '新', 'New') : undefined,
      content: `.particles { background: radial-gradient(circle, rgba(99,102,241,0.25), transparent 60%); }`
    },
    {
      id: 'package',
      label: 'package.json',
      path: 'package.json',
      content: `{\n  "name": "${project.name}",\n  "runtime": "funplay"\n}`
    }
  ];

  const assetFiles: ProjectFileItem[] = project.assets.slice(0, 8).map((asset) => ({
    id: `asset-${asset.id}`,
    label: asset.name,
    path: `generated-assets/${asset.type}/${slugifyAssetName(asset.name)}.md`,
    badge:
      asset.status === 'ready'
        ? localize(language, '就绪', 'Ready')
        : asset.status === 'generating'
          ? localize(language, '生成', 'Gen')
          : undefined,
    content: [
      `# ${asset.name}`,
      '',
      `${localize(language, '类型', 'type')}: ${asset.type}`,
      `${localize(language, '状态', 'status')}: ${asset.status}`,
      '',
      `${localize(language, '提示词', 'prompt')}:`,
      asset.prompt,
      '',
      `${localize(language, '备注', 'notes')}:`,
      asset.notes
    ].join('\n')
  }));

  return [...baseFiles, ...assetFiles];
}

export function normalizeAgentRunForView(run: Project['lastAgentRun']): unknown {
  if (!run) {
    return {};
  }

  const operationLog = run.operationLog ?? [];

  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    input: run.input,
    provider: run.usedProviderId,
    model: run.usedModel,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: run.steps,
    timeline: buildAgentRunTimeline(operationLog),
    operationLog,
    executionPlan: run.executionPlan
      ? {
          summary: run.executionPlan.summary,
          rationale: run.executionPlan.rationale,
          lastExecutedAt: run.executionPlan.lastExecutedAt,
          actions: run.executionPlan.actions.map((action) => ({
            id: action.id,
            pluginKind: action.pluginKind,
            pluginId: action.pluginId,
            title: action.title,
            status: action.status,
            objective: action.objective,
            operations: action.operations,
            outputSummary: action.outputSummary,
            errorMessage: action.errorMessage
          }))
        }
      : undefined
  };
}

export function buildAgentRunTimeline(operationLog: AgentOperationRecord[]): Array<{
  phase: string;
  status: AgentOperationRecord['status'];
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  counts: Record<AgentOperationRecord['status'], number>;
  entries: AgentOperationRecord[];
}> {
  const phaseOrder = ['prepare', 'checkpoint', 'execute', 'diagnose', 'repair', 'verify', 'rollback', 'replan', 'commit', 'complete'];
  const grouped = operationLog.reduce<Map<string, AgentOperationRecord[]>>((accumulator, record) => {
    const phase = record.phase || 'operation';
    accumulator.set(phase, [...(accumulator.get(phase) ?? []), record]);
    return accumulator;
  }, new Map());

  const phases = [...grouped.keys()].sort((left, right) => {
    const leftIndex = phaseOrder.indexOf(left);
    const rightIndex = phaseOrder.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });

  return phases.map((phase) => {
    const entries = [...(grouped.get(phase) ?? [])].sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
    const counts = entries.reduce<Record<AgentOperationRecord['status'], number>>(
      (accumulator, entry) => ({
        ...accumulator,
        [entry.status]: accumulator[entry.status] + 1
      }),
      {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0
      }
    );
    const status: AgentOperationRecord['status'] =
      counts.failed > 0
        ? 'failed'
        : counts.running > 0 || counts.pending > 0
          ? 'running'
          : counts.completed > 0
            ? 'completed'
            : counts.skipped > 0
              ? 'skipped'
              : 'pending';
    const latestEntry = [...entries].reverse().find((entry) => entry.summary || entry.errorMessage);

    return {
      phase,
      status,
      startedAt: entries[0]?.startedAt,
      finishedAt: [...entries].reverse().find((entry) => entry.finishedAt)?.finishedAt,
      summary: latestEntry?.errorMessage || latestEntry?.summary,
      counts,
      entries
    };
  });
}

export function buildSessionListState(input: {
  session: Project['sessions'][number];
  language: LanguagePreference;
  isStreaming: boolean;
  statusMessage?: string;
  queuedCount: number;
  composerError?: string;
}): SessionListState {
  if (input.isStreaming) {
    return {
      mode: 'running',
      summary: input.statusMessage || localize(input.language, '正在运行中…', 'Running…'),
      hint: localize(input.language, '可随时停止', 'Can be stopped anytime')
    };
  }

  if (input.composerError?.trim() && !isCancellationMessage(input.composerError)) {
    return {
      mode: 'error',
      summary: truncateInlineText(input.composerError.trim(), 64),
      hint: localize(input.language, '选择后可继续', 'Resume by reopening')
    };
  }

  if (input.queuedCount > 0) {
    return {
      mode: 'queued',
      summary: localize(
        input.language,
        `已排队 ${input.queuedCount} 条消息`,
        `${input.queuedCount} queued prompt${input.queuedCount > 1 ? 's' : ''}`
      ),
      hint: localize(input.language, '等待当前运行完成', 'Waiting for the current run'),
      queuedCount: input.queuedCount
    };
  }

  const latestAssistantMessage = [...input.session.chat].reverse().find((message) => message.role === 'assistant');

  if (latestAssistantMessage?.metadata?.intent === 'fallback') {
    return {
      mode: 'fallback',
      summary:
        latestAssistantMessage.metadata?.executionSummary ||
        latestAssistantMessage.metadata?.activitySummary ||
        truncateInlineText(extractSessionMessagePreview(latestAssistantMessage), 64),
      hint: localize(input.language, '当前为回退回复', 'Currently using fallback')
    };
  }

  const latestMessage = latestAssistantMessage ?? [...input.session.chat].reverse().find((message) => message.role === 'user');
  const latestSummary = latestMessage ? truncateInlineText(extractSessionMessagePreview(latestMessage), 64) : '';
  return {
    mode: 'idle',
    summary: latestSummary || localize(input.language, '等待新的消息', 'Waiting for the next message')
  };
}

export function buildProjectSwitcherItem(input: {
  project: Project;
  activeStreams: StreamSessionState[];
  runtimeStatuses: AgentRuntimeStatus[];
  queuedPromptsBySession: Record<string, QueuedPromptItem[]>;
  composerErrors: Record<string, string>;
  activeSessionByProject: Record<string, string>;
}) {
  const aggregate = buildProjectAgentAggregateState(input);
  const activeSession = input.project.sessions.find((session) => session.id === aggregate.lastActiveSessionId) ?? input.project.sessions[0];

  return {
    id: input.project.id,
    name: input.project.name,
    path: input.project.engine?.projectPath,
    sessionCount: input.project.sessions.length,
    runningCount: aggregate.runningSessionCount,
    queuedCount: aggregate.queuedSessionCount,
    pendingApprovalCount: aggregate.pendingApprovalCount,
    failedCount: aggregate.failedSessionCount,
    resumableCount: aggregate.resumableRunCount,
    activeSessionTitle: activeSession?.title
  };
}

export function buildProjectAgentAggregateState(input: {
  project: Project;
  activeStreams: StreamSessionState[];
  runtimeStatuses: AgentRuntimeStatus[];
  queuedPromptsBySession: Record<string, QueuedPromptItem[]>;
  composerErrors: Record<string, string>;
  activeSessionByProject: Record<string, string>;
}): ProjectAgentAggregateState {
  const sessionIds = new Set(input.project.sessions.map((session) => session.id));
  const activeSessionId =
    input.activeSessionByProject[input.project.id] ||
    input.project.activeSessionId ||
    input.project.sessions[0]?.id ||
    '';
  const activeStreams = input.activeStreams.filter((stream) =>
    stream.projectId === input.project.id &&
    sessionIds.has(stream.sessionId) &&
    !['completed', 'cancelled', 'error'].includes(stream.phase)
  );
  const queuedCount = input.project.sessions.reduce(
    (total, session) => total + (input.queuedPromptsBySession[session.id]?.length ?? 0),
    0
  );
  const failedComposerCount = input.project.sessions.filter((session) => {
    const error = input.composerErrors[session.id];
    return Boolean(error?.trim() && !isCancellationMessage(error));
  }).length;
  const failedRunCount = input.runtimeStatuses.filter(
    (status) => status.projectId === input.project.id && status.status === 'failed'
  ).length;
  const resumableCount = input.runtimeStatuses.filter(
    (status) => status.projectId === input.project.id && status.canResume
  ).length;

  return {
    runningSessionCount: activeStreams.length,
    queuedSessionCount: queuedCount,
    pendingApprovalCount: activeStreams.filter((stream) => stream.pendingPermission || stream.pendingUserInput).length,
    failedSessionCount: failedComposerCount + failedRunCount,
    resumableRunCount: resumableCount,
    lastActiveSessionId: activeSessionId,
    lastActiveAt: input.project.updatedAt
  };
}

export function extractSessionMessagePreview(message: Project['sessions'][number]['chat'][number]): string {
  if (message.metadata?.executionSummary) {
    return message.metadata.executionSummary;
  }

  if (message.metadata?.activitySummary) {
    return message.metadata.activitySummary;
  }

  if (message.metadata?.agentCoreParts?.length) {
    const agentCoreText = agentCorePartsToPlainText(message.metadata.agentCoreParts, false);
    if (agentCoreText.trim()) {
      return agentCoreText;
    }
  }

  return stripInternalSessionPreviewNoise(message.content);
}

export function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stripInternalSessionPreviewNoise(value: string): string {
  const visibleLines = value
    .split(/\r?\n/)
    .filter((line) => !isUsagePreviewLine(line))
    .join('\n')
    .trim();
  const normalized = visibleLines.replace(/\s+/g, ' ').trim();
  if (!normalized || isUsageOnlyPreview(normalized)) {
    return '';
  }
  return visibleLines;
}

function isUsagePreviewLine(value: string): boolean {
  return /^Usage:\s*[\d,.]+(?:[kKmM])?$/i.test(value.trim());
}

function isUsageOnlyPreview(value: string): boolean {
  return /^(?:Usage:\s*[\d,.]+(?:[kKmM])?\s*)+$/i.test(value.trim());
}

export function isCancellationMessage(value: string): boolean {
  return /取消|cancell?ed|stopped/i.test(value);
}

export function buildAssetLibraryCategories(
  existingAssetFiles: AssetLibraryFileItem[],
  language: LanguagePreference
): AssetLibraryCategory[] {
  const labels: Record<AssetLibraryCategoryId, string> = {
    image: localize(language, '图片 / UI', 'Images / UI'),
    audio: localize(language, '音频', 'Audio'),
    model: localize(language, '模型 / 3D', 'Models / 3D'),
    animation: localize(language, '动画', 'Animation')
  };
  const order: AssetLibraryCategoryId[] = ['image', 'audio', 'model', 'animation'];

  return order
    .map((id) => ({
      id,
      label: labels[id],
      items: existingAssetFiles.filter((item) => item.category === id)
    }))
    .filter((category) => category.items.length > 0);
}

export function buildExistingAssetFileItems(files: ProjectFileEntry[]): AssetLibraryFileItem[] {
  const items: AssetLibraryFileItem[] = [];

  files.filter((file) => file.type !== 'directory').forEach((file) => {
    const category = classifyProjectAssetFile(file.path);
    if (!category) {
      return;
    }

    items.push({
      id: `file:${file.path}`,
      source: 'project-file',
      openId: file.path,
      name: file.name,
      path: file.path,
      description: summarizeProjectAssetFile(file),
      meta: `${formatAssetFileCategory(category)} · ${formatFileSize(file.size)}`,
      category,
      statusKind: 'ready',
      statusLabel: localize(getDocumentLanguage(), '项目内', 'In Project'),
      previewable: isAssetFilePreviewable(file.path)
    });
  });

  return items.sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
}

export function classifyProjectAssetFile(path: string): AssetLibraryCategoryId | null {
  const extension = getPathExtension(path);
  const normalizedPath = path.toLowerCase();

  if (['gif', 'mp4', 'mov', 'webm', 'anim', 'controller'].includes(extension) || normalizedPath.includes('animation')) return 'animation';
  if (['png', 'jpg', 'jpeg', 'bmp', 'webp', 'svg', 'tga', 'psd'].includes(extension)) return 'image';
  if (['wav', 'mp3', 'ogg', 'aiff'].includes(extension)) return 'audio';
  if (['fbx', 'blend', 'glb', 'gltf', 'obj'].includes(extension)) return 'model';
  return null;
}

export function isAssetFilePreviewable(path: string): boolean {
  const extension = getPathExtension(path);
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'wav', 'mp3', 'ogg', 'aiff', 'mp4', 'mov', 'webm', 'md', 'markdown', 'html', 'htm'].includes(extension);
}

export function summarizeProjectAssetFile(file: ProjectFileEntry): string {
  const language = getDocumentLanguage();
  const modified = formatAbsoluteTime(file.modifiedAt);
  return localize(language, `项目文件 · 修改于 ${modified}`, `Project file · Modified ${modified}`);
}

export function formatAssetFileCategory(category: AssetLibraryCategoryId): string {
  const language = getDocumentLanguage();
  const labels: Record<AssetLibraryCategoryId, string> = {
    image: localize(language, '图片', 'Image'),
    audio: localize(language, '音频', 'Audio'),
    model: localize(language, '模型', 'Model'),
    animation: localize(language, '动画', 'Animation')
  };
  return labels[category];
}

export function mapGeneratedAssetCategory(type: Project['assets'][number]['type']): AssetLibraryCategoryId {
  if (type === 'audio') return 'audio';
  if (type === 'vfx') return 'animation';
  return 'image';
}

export function assetCategorySymbol(category: AssetLibraryCategoryId): string {
  const symbols: Record<AssetLibraryCategoryId, string> = {
    image: '◧',
    audio: '♪',
    model: '◇',
    animation: '▻'
  };
  return symbols[category];
}

export function getPathExtension(path: string): string {
  return path.toLowerCase().match(/\.([a-z0-9]+)$/i)?.[1] ?? '';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function assetTypeLabel(type: Project['assets'][number]['type']): string {
  const language = getDocumentLanguage();
  const labels: Record<Project['assets'][number]['type'], string> = {
    character: localize(language, '角色', 'Character'),
    environment: localize(language, '环境', 'Environment'),
    ui: 'UI',
    audio: localize(language, '音频', 'Audio'),
    vfx: localize(language, '特效', 'VFX')
  };
  return labels[type];
}

export function assetStatusRank(status: Project['assets'][number]['status']): number {
  if (status === 'ready') return 3;
  if (status === 'generating') return 2;
  return 1;
}

export function formatAssetStatus(status: Project['assets'][number]['status']): string {
  const language = getDocumentLanguage();
  if (status === 'ready') return localize(language, '✓ 已写入', '✓ Written');
  if (status === 'generating') return localize(language, '生成中', 'Generating');
  return localize(language, '已规划', 'Planned');
}

export function formatDiagnosticStatus(status: NonNullable<EnvironmentDiagnostics>['checks'][number]['status']): string {
  const language = getDocumentLanguage();
  const labels: Record<NonNullable<EnvironmentDiagnostics>['checks'][number]['status'], string> = {
    passed: localize(language, '已通过', 'Passed'),
    warning: localize(language, '待处理', 'Needs Attention'),
    failed: localize(language, '未就绪', 'Not Ready'),
    pending: localize(language, '待检测', 'Pending')
  };
  return labels[status];
}

export function formatEnvironmentTaskStatus(status: EnvironmentTask['status']): string {
  const language = getDocumentLanguage();
  const labels: Record<EnvironmentTask['status'], string> = {
    queued: localize(language, '排队中', 'Queued'),
    running: localize(language, '执行中', 'Running'),
    completed: localize(language, '已完成', 'Completed'),
    failed: localize(language, '失败', 'Failed'),
    needs_user: localize(language, '待手动完成', 'Needs Manual Step')
  };
  return labels[status];
}

export function mapTaskStatusToDiagnostic(status: EnvironmentTask['status']): 'passed' | 'warning' | 'failed' | 'pending' {
  if (status === 'completed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'needs_user') return 'warning';
  return 'pending';
}

export function formatEnvironmentTaskStage(stage: EnvironmentTask['stage']): string {
  const language = getDocumentLanguage();
  const labels: Record<EnvironmentTask['stage'], string> = {
    queued: localize(language, '排队中', 'Queued'),
    checking: localize(language, '检查环境', 'Checking'),
    downloading: localize(language, '下载中', 'Downloading'),
    installing: localize(language, '安装中', 'Installing'),
    waiting_login: localize(language, '等待登录 Hub', 'Waiting for Hub Login'),
    waiting_manual: localize(language, '等待手动处理', 'Waiting for Manual Action'),
    validating: localize(language, '校验中', 'Validating'),
    completed: localize(language, '完成', 'Completed'),
    failed: localize(language, '失败', 'Failed')
  };
  return labels[stage];
}

export function formatActionStatus(status: NonNullable<Project['currentExecutionPlan']>['actions'][number]['status']): string {
  const language = getDocumentLanguage();
  const labels: Record<NonNullable<Project['currentExecutionPlan']>['actions'][number]['status'], string> = {
    planned: localize(language, '已规划', 'Planned'),
    suggested: localize(language, '已建议', 'Suggested'),
    running: localize(language, '执行中', 'Running'),
    completed: localize(language, '已完成', 'Completed'),
    failed: localize(language, '失败', 'Failed'),
    skipped: localize(language, '跳过', 'Skipped')
  };
  return labels[status];
}

export function slugifyAssetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'asset';
}

export function formatPlatformLabel(platform: PlatformChoice): string {
  const language = getDocumentLanguage();
  if (platform === 'unity') return 'Unity';
  if (platform === 'cocos') return 'Cocos';
  if (platform === 'godot') return 'Godot';
  if (platform === 'unreal') return 'Unreal';
  return localize(language, '通用项目', 'Generic Project');
}

export function formatDimensionLabel(dimension: EngineProjectDimension): string {
  const language = getDocumentLanguage();
  if (dimension === '2d') return '2D';
  if (dimension === '3d') return '3D';
  return localize(language, '未识别', 'Unknown');
}

export function formatProjectStatus(status: Project['status']): string {
  const language = getDocumentLanguage();
  const labels: Record<Project['status'], string> = {
    planning: localize(language, '规划中', 'Planning'),
    active: localize(language, '进行中', 'Active'),
    blocked: localize(language, '已阻塞', 'Blocked')
  };
  return labels[status];
}

export function buildRuntimeSummary(runtimeState?: Project['runtimeState']): string {
  const language = getDocumentLanguage();
  if (!runtimeState) {
    return localize(language, '还没有读取到项目运行态。', 'Project runtime state has not been loaded yet.');
  }
  if (!runtimeState.projectExists) {
    return localize(language, '项目目录不存在。', 'Project directory does not exist.');
  }
  if (!runtimeState.unityProjectValid) {
    return localize(language, '当前路径还不是有效的 Unity 项目。', 'The current path is not a valid Unity project.');
  }
  if (!runtimeState.bridgeInstalled) {
    return localize(language, 'Bridge 未安装。', 'Bridge is not installed.');
  }
  if (runtimeState.bridgeHealth?.status === 'online') {
    return localize(language, 'Bridge / MCP 已连通。', 'Bridge / MCP is connected.');
  }
  if (runtimeState.projectOpen) {
    return localize(language, 'Unity 已打开，等待 MCP 连通。', 'Unity is open and waiting for MCP connection.');
  }
  return localize(language, '项目未打开或 MCP 尚未启动。', 'The project is not open or MCP has not started yet.');
}

export function resolveEngineProjectPath(mode: ProjectSetupMode, projectPath: string, projectName: string): string {
  const normalizedBase = projectPath.trim().replace(/\/+$/g, '');
  if (mode !== 'create') {
    return normalizedBase;
  }
  const trimmedName = projectName.trim();
  return trimmedName ? `${normalizedBase}/${trimmedName}` : normalizedBase;
}

export function getFolderNameFromPath(projectPath: string): string {
  return projectPath.trim().replace(/\/+$/g, '').split('/').filter(Boolean).pop() ?? '';
}

export function formatAbsoluteTime(date: string): string {
  const language = getDocumentLanguage();
  return new Date(date).toLocaleString(language === 'en-US' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function derivePlatform(project: Project, plugins: McpPlugin[]): string {
  const engineId = project.mcpBindings?.engine || project.mcpPluginId;
  if (!engineId) return 'Web';
  const plugin = plugins.find((item) => item.id === engineId);
  if (!plugin) return 'Web';
  if (/unity/i.test(plugin.name)) return 'Unity';
  if (/cocos/i.test(plugin.name)) return 'Cocos';
  if (/godot/i.test(plugin.name)) return 'Godot';
  return plugin.name;
}

export function formatRelativeDate(date: string): string {
  const language = getDocumentLanguage();
  const diffHours = Math.round((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60));
  if (diffHours <= 1) return localize(language, '1 小时内', 'Within 1 hour');
  if (diffHours < 24) return localize(language, `${diffHours} 小时前`, `${diffHours}h ago`);
  return localize(language, '昨天', 'Yesterday');
}

export function formatProjectLocation(projectPath: string | undefined, fallbackName: string): string {
  if (!projectPath?.trim()) {
    return `~/projects/${fallbackName}`;
  }

  return projectPath.replace(/^\/Users\/[^/]+/, '~');
}

export function readWorkspaceLayoutPrefs(): {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
} {
  if (typeof window === 'undefined') {
    return { leftCollapsed: false, rightCollapsed: true, leftWidth: 300, rightWidth: 420 };
  }

  try {
    const raw = window.localStorage.getItem(workspaceLayoutStorageKey);
    if (!raw) {
      return { leftCollapsed: false, rightCollapsed: true, leftWidth: 300, rightWidth: 420 };
    }

    const parsed = JSON.parse(raw) as Partial<{
      leftCollapsed: boolean;
      rightCollapsed: boolean;
      leftWidth: number;
      rightWidth: number;
    }>;

    return {
      leftCollapsed: !!parsed.leftCollapsed,
      rightCollapsed: !!parsed.rightCollapsed,
      leftWidth: clampNumber(parsed.leftWidth, 240, 520, 300),
      rightWidth: clampNumber(parsed.rightWidth, 320, 820, 420)
    };
  } catch {
    return { leftCollapsed: false, rightCollapsed: true, leftWidth: 300, rightWidth: 420 };
  }
}

export function persistWorkspaceLayoutPrefs(value: {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
}): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(
    workspaceLayoutStorageKey,
    JSON.stringify({
      leftCollapsed: value.leftCollapsed,
      rightCollapsed: value.rightCollapsed,
      leftWidth: clampNumber(value.leftWidth, 240, 520, 300),
      rightWidth: clampNumber(value.rightWidth, 320, 820, 420)
    })
  );
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

export function shouldUseFastRuntimeRefresh(project: Project | null): boolean {
  const runtimeState = project?.runtimeState;
  if (!project?.engine?.projectPath) {
    return false;
  }
  if (!runtimeState) {
    return true;
  }
  if (runtimeState.bridgeHealth?.status === 'online') {
    return false;
  }
  return runtimeState.projectOpen && runtimeState.bridgeInstalled;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function readUiPreferences(): UiPreferences {
  const defaults = createDefaultUiPreferences();
  if (typeof window === 'undefined') {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(uiPreferencesStorageKey);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : defaults.theme,
      language: parsed.language === 'en-US' || parsed.language === 'zh-CN' ? parsed.language : defaults.language,
      developerMode: parsed.developerMode === true
    };
  } catch {
    return defaults;
  }
}

export function persistUiPreferences(value: UiPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(uiPreferencesStorageKey, JSON.stringify(value));
}

export function applyUiPreferences(value: UiPreferences): void {
  if (typeof document === 'undefined') {
    return;
  }

  const systemDark =
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
  const resolvedTheme = value.theme === 'system' ? (systemDark ? 'dark' : 'light') : value.theme;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = value.theme;
  document.documentElement.dataset.developerMode = value.developerMode ? 'true' : 'false';
  document.documentElement.lang = value.language;
}

export function createEmptyProjectSkillDraft(): ProjectAgentSkillDraft {
  return {
    name: '',
    description: '',
    trigger: '',
    instruction: '',
    enabled: true
  };
}

export function makeProjectSkillId(): string {
  return `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCatalogProjectSkillId(skillId: string): string {
  return `funplay-skill:${skillId}`;
}

export function formatCatalogSkillInstruction(skill: AgentSkillCatalogItem): string {
  const parts = [
    skill.inputs.length ? ['Inputs:', ...skill.inputs.map((item) => `- ${item}`)].join('\n') : '',
    skill.outputs.length ? ['Outputs:', ...skill.outputs.map((item) => `- ${item}`)].join('\n') : '',
    skill.examples.length ? ['Examples:', ...skill.examples.map((item) => `- ${item}`)].join('\n') : '',
    skill.instruction
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 6000);
}

export function getPlatformCards(language: LanguagePreference): Array<{
  id: PlatformChoice;
  name: string;
  description: string;
  disabled?: boolean;
}> {
  return [
    { id: 'web', name: localize(language, '通用项目', 'Generic Project'), description: localize(language, '代码 / 文档 / Web', 'Code / Docs / Web') },
    { id: 'unity', name: 'Unity', description: localize(language, '需要绑定 unity-mcp', 'Requires unity-mcp binding') },
    { id: 'cocos', name: 'Cocos', description: localize(language, '仅支持 2D', '2D only') },
    { id: 'godot', name: 'Godot', description: localize(language, '即将支持', 'Coming soon'), disabled: true },
    { id: 'unreal', name: 'Unreal', description: localize(language, '即将支持', 'Coming soon'), disabled: true }
  ];
}
