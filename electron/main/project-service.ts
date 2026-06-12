import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProjectFromInput, createSnapshot } from '../../shared/planner';
import {
  appendProjectAssistantMessage,
  createProjectSessionRecord,
  deriveSessionTitleFromPrompt,
  ensureProjectSessions,
  getActiveProjectSession,
  getChatMessageContextText,
  replaceProjectSession,
  syncProjectChatFromActiveSession
} from '../../shared/project-sessions';
import type {
  AiProvider,
  AppState,
  CreateProjectInput,
  DeleteProjectResult,
  McpPlugin,
  McpPluginKind,
  Project,
  ProjectAgentSkill,
  ProjectSession,
  SessionCheckpointPreview
} from '../../shared/types';
import {
  ensureEngineProjectMcpBinding,
  resolveProjectPluginByKind,
  resolveProjectPlugins,
  updateProjectMcpServers
} from './mcp-plugin-service';
import { executeGenericAgentTask as executeAgentTask } from './agent-platform/task-executor';
import { resolveAgentProvider } from './agent-platform/provider-resolver';
import { refreshProjectContext } from './game-context-manager';
import { getProjectRuntimeState } from './environment-service';
import { previewFileCheckpointChanges, restoreFileCheckpoint } from './agent-platform/file-checkpoint-store';

function buildFreshSession(_project: Project, title?: string): ProjectSession {
  const createdAt = new Date().toISOString();
  return createProjectSessionRecord({
    title: title?.trim() || 'New Session',
    chat: [],
    createdAt,
    updatedAt: createdAt,
    autoTitle: !title?.trim()
  });
}

export interface ResolvedProjectChatContext {
  index: number;
  current: Project;
  provider?: AiProvider;
  enginePlugin?: McpPlugin;
  assetPlugin?: McpPlugin;
  qaPlugin?: McpPlugin;
  customPlugin?: McpPlugin;
  mcpPlugins: McpPlugin[];
  sessionId: string;
}

function resolveUserPath(projectPath: string): string {
  return resolve(projectPath.replace(/^~/, process.env.HOME ?? '~'));
}

async function ensureGenericProjectDirectory(input: CreateProjectInput): Promise<void> {
  if (input.engine?.platform !== 'web' || input.engine.setupMode !== 'create' || !input.engine.projectPath?.trim()) {
    return;
  }

  await mkdir(resolveUserPath(input.engine.projectPath), { recursive: true });
}

export function resolveProjectChatContext(
  state: AppState,
  projectId: string,
  targetSessionId?: string
): ResolvedProjectChatContext {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const ensured = ensureProjectSessions(state.projects[index]);
  state.projects[index] = ensured;
  if (targetSessionId && !ensured.sessions.some((session) => session.id === targetSessionId)) {
    throw new Error('Session not found.');
  }

  const current = syncProjectChatFromActiveSession({
    ...ensured,
    activeSessionId: targetSessionId ?? ensured.activeSessionId
  });
  const provider = resolveAgentProvider(state, current);
  const activeMcpPlugins = resolveProjectPlugins(state, current);
  const activeEnginePlugin =
    current.engine?.platform === 'unity' || current.engine?.platform === 'cocos'
      ? resolveProjectPluginByKind(state, current.mcpBindings, 'engine', current.id)
      : undefined;
  const activeAssetPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'asset', current.id);
  const activeQaPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'qa', current.id);
  const activeCustomPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'custom', current.id);

  return {
    index,
    current,
    provider,
    enginePlugin: activeEnginePlugin,
    assetPlugin: activeAssetPlugin,
    qaPlugin: activeQaPlugin,
    customPlugin: activeCustomPlugin,
    mcpPlugins: activeMcpPlugins,
    sessionId: getActiveProjectSession(current).id
  };
}

export function commitProjectChatResponse(
  state: AppState,
  resolved: ResolvedProjectChatContext,
  message: string,
  updated: Project,
  targetSessionId?: string
): Project {
  const currentWithSessions = ensureProjectSessions(resolved.current);
  const activeSession =
    currentWithSessions.sessions.find((session) => session.id === targetSessionId) ??
    getActiveProjectSession(currentWithSessions);
  const previousUserMessageCount = activeSession.chat.filter((item) => item.role === 'user').length;
  const nextTitle =
    activeSession.autoTitle && previousUserMessageCount === 0
      ? deriveSessionTitleFromPrompt(message)
      : activeSession.title;
  const nextProject = replaceProjectSession(
    updated,
    {
      ...activeSession,
      title: nextTitle,
      autoTitle: activeSession.autoTitle && previousUserMessageCount === 0 ? false : activeSession.autoTitle,
      chat: [...updated.chat],
      updatedAt: updated.updatedAt
    },
    resolved.current.activeSessionId
  );

  state.projects[resolved.index] = nextProject;
  return nextProject;
}

export async function createProject(state: AppState, input: CreateProjectInput): Promise<Project> {
  await ensureGenericProjectDirectory(input);

  const seeded = createProjectFromInput(input);
  const activeEnginePlugin = ensureEngineProjectMcpBinding(state, seeded);
  const defaultProvider = resolveAgentProvider(state, ensureProjectSessions(seeded));
  const activeAssetPlugin = resolveProjectPluginByKind(state, seeded.mcpBindings, 'asset');
  const activeQaPlugin = resolveProjectPluginByKind(state, seeded.mcpBindings, 'qa');
  const activeCustomPlugin = resolveProjectPluginByKind(state, seeded.mcpBindings, 'custom');

  seeded.mcpBindings = {
    ...(seeded.mcpBindings ?? {}),
    engine: activeEnginePlugin?.id ?? seeded.mcpBindings?.engine,
    asset: activeAssetPlugin?.id,
    qa: activeQaPlugin?.id,
    custom: activeCustomPlugin?.id
  };
  const effectiveProvider = defaultProvider ? { ...defaultProvider } : undefined;

  if (input.engine?.platform === 'web') {
    if (seeded.engine?.projectPath) {
      seeded.runtimeState = await getProjectRuntimeState(state, {
        platform: seeded.engine.platform,
        projectPath: seeded.engine.projectPath
      });
    }

    const hydratedProject = ensureProjectSessions(seeded);
    state.projects = [hydratedProject, ...state.projects];
    return hydratedProject;
  }

  const bootstrapResult = await executeAgentTask({
    kind: 'bootstrap',
    project: seeded,
    input,
    provider: effectiveProvider,
    mcpPlugins: [activeEnginePlugin, activeAssetPlugin, activeQaPlugin, activeCustomPlugin].filter(
      Boolean
    ) as McpPlugin[],
    enginePlugin: activeEnginePlugin,
    assetPlugin: activeAssetPlugin,
    qaPlugin: activeQaPlugin,
    customPlugin: activeCustomPlugin
  });
  const project = bootstrapResult.project;

  if (project.engine?.projectPath) {
    project.runtimeState = await getProjectRuntimeState(state, {
      platform: project.engine.platform,
      projectPath: project.engine.projectPath
    });
  }

  const hydratedProject = ensureProjectSessions(project);
  state.projects = [hydratedProject, ...state.projects];
  return hydratedProject;
}

export async function refreshProjectRuntimeState(state: AppState, projectId: string): Promise<Project | null> {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    return null;
  }

  const current = state.projects[index];
  if (!current.engine?.projectPath) {
    return current;
  }

  const runtimeState = await getProjectRuntimeState(state, {
    platform: current.engine.platform,
    projectPath: current.engine.projectPath
  });
  const updated: Project = {
    ...current,
    runtimeState,
    engine: {
      ...current.engine,
      dimension:
        current.engine.dimension === 'unknown' && runtimeState.detectedDimension
          ? runtimeState.detectedDimension
          : current.engine.dimension
    }
  };

  state.projects[index] = updated;
  return updated;
}

export async function deleteProject(
  state: AppState,
  projectId: string,
  deleteSourceFiles = false
): Promise<DeleteProjectResult> {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const target = state.projects[index];
  let deletedSource = false;

  if (deleteSourceFiles && target.engine?.projectPath) {
    const resolvedProjectPath = resolveUserPath(target.engine.projectPath);
    await rm(resolvedProjectPath, { recursive: true, force: true, maxRetries: 2 });
    deletedSource = true;
  }

  state.projects = state.projects.filter((project) => project.id !== projectId);

  return {
    deletedProjectId: projectId,
    remainingProjects: state.projects,
    deletedSourceFiles: deletedSource
  };
}

export async function updateProjectWithPrompt(state: AppState, projectId: string, message: string): Promise<Project> {
  const resolved = resolveProjectChatContext(state, projectId);
  const result = await executeAgentTask({
    kind: 'conversation',
    project: resolved.current,
    sessionId: resolved.sessionId,
    message,
    appState: state,
    provider: resolved.provider,
    mcpPlugins: resolved.mcpPlugins,
    enginePlugin: resolved.enginePlugin,
    assetPlugin: resolved.assetPlugin,
    qaPlugin: resolved.qaPlugin,
    customPlugin: resolved.customPlugin
  });
  if (message.trim() === '/compact') {
    state.projects[resolved.index] = result.project;
    return result.project;
  }
  return commitProjectChatResponse(state, resolved, message, result.project, resolved.sessionId);
}

export function addProjectSnapshot(state: AppState, projectId: string, note: string): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const project = syncProjectChatFromActiveSession(state.projects[index]);
  const snapshot = createSnapshot(project, note, {
    sessionId: getActiveProjectSession(project).id,
    includeSessionCheckpoint: true
  });
  const updated: Project = {
    ...refreshProjectContext(project),
    updatedAt: new Date().toISOString(),
    snapshots: [snapshot, ...project.snapshots],
    activity: [
      {
        id: `act_${Date.now()}`,
        kind: 'snapshot',
        title: '已创建项目快照',
        detail: snapshot.note,
        createdAt: snapshot.createdAt
      },
      ...project.activity
    ],
    lastAgentRun: project.lastAgentRun
  };

  state.projects[index] = updated;
  return updated;
}

export function addSessionCheckpointSnapshot(
  state: AppState,
  projectId: string,
  sessionId: string | undefined,
  note: string,
  options?: {
    triggerUserMessageId?: string;
  }
): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const project = ensureProjectSessions(state.projects[index]);
  const snapshot = createSnapshot(project, note, {
    sessionId,
    includeSessionCheckpoint: true,
    triggerUserMessageId: options?.triggerUserMessageId
  });
  const updated: Project = {
    ...project,
    snapshots: [snapshot, ...project.snapshots].slice(0, 50),
    updatedAt: new Date().toISOString()
  };

  state.projects[index] = updated;
  return updated;
}

export async function restoreSessionCheckpoint(
  state: AppState,
  projectId: string,
  snapshotId: string
): Promise<Project> {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const project = ensureProjectSessions(state.projects[index]);
  const snapshot = project.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot?.sessionCheckpoint) {
    throw new Error('Session checkpoint not found.');
  }

  const checkpoint = snapshot.sessionCheckpoint;
  const targetSession =
    project.sessions.find((session) => session.id === checkpoint.sessionId) ??
    createProjectSessionRecord({
      title: checkpoint.sessionTitle || 'Restored Session',
      chat: [],
      autoTitle: false
    });
  const updatedAt = new Date().toISOString();
  const restoredSession: ProjectSession = {
    ...targetSession,
    title: checkpoint.sessionTitle || targetSession.title,
    autoTitle: false,
    chat: [...checkpoint.chat],
    updatedAt
  };
  const sessions = project.sessions.some((session) => session.id === restoredSession.id)
    ? project.sessions.map((session) => (session.id === restoredSession.id ? restoredSession : session))
    : [restoredSession, ...project.sessions];
  const activeSessionId = restoredSession.id;
  let updated: Project = {
    ...project,
    sessions,
    activeSessionId,
    chat: [...restoredSession.chat],
    updatedAt,
    activity: [
      {
        id: `act_${Date.now()}`,
        kind: 'snapshot',
        title: '已恢复会话检查点',
        detail: snapshot.note,
        createdAt: updatedAt
      },
      ...project.activity
    ]
  };

  let restoredFileSummary = '';
  try {
    const result = await restoreFileCheckpoint(project, snapshot.id);
    restoredFileSummary =
      result.restoredFiles.length > 0 ? `已同步恢复 ${result.restoredFiles.length} 个被 Agent 写入过的文件。` : '';
  } catch {
    restoredFileSummary = '';
  }

  const restoreSummary = [
    `已恢复到检查点“${snapshot.note}”。`,
    checkpoint.triggerUserMessageId
      ? '你可以从标记的那条用户消息继续往下推进。'
      : '你可以从当前恢复后的会话状态继续往下推进。',
    restoredFileSummary
  ].join('\n');

  updated = appendProjectAssistantMessage(updated, {
    sessionId: restoredSession.id,
    assistantMessage: restoreSummary,
    assistantMetadata: {
      intent: 'chat'
    },
    updatedAt
  });

  state.projects[index] = updated;
  return updated;
}

export async function previewSessionCheckpoint(
  state: AppState,
  projectId: string,
  snapshotId: string
): Promise<SessionCheckpointPreview> {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const project = ensureProjectSessions(state.projects[index]);
  const snapshot = project.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot?.sessionCheckpoint) {
    throw new Error('Session checkpoint not found.');
  }

  const checkpoint = snapshot.sessionCheckpoint;
  const currentSession = project.sessions.find((session) => session.id === checkpoint.sessionId);
  const currentChat = currentSession?.chat ?? [];
  const checkpointChat = checkpoint.chat ?? [];

  let fileChanges: SessionCheckpointPreview['fileChanges'] = [];
  let skippedFileChanges: string[] = [];
  try {
    const filePreview = await previewFileCheckpointChanges(project, snapshot.id);
    fileChanges = filePreview.changedFiles;
    skippedFileChanges = filePreview.skippedFiles;
  } catch {
    fileChanges = [];
    skippedFileChanges = [];
  }

  return {
    snapshotId: snapshot.id,
    sessionId: checkpoint.sessionId,
    checkpointNote: snapshot.note,
    checkpointCreatedAt: snapshot.createdAt,
    triggerUserMessageId: checkpoint.triggerUserMessageId,
    currentMessageCount: currentChat.length,
    checkpointMessageCount: checkpointChat.length,
    addedMessages: Math.max(0, currentChat.length - checkpointChat.length),
    removedMessages: Math.max(0, checkpointChat.length - currentChat.length),
    currentLatestPreview:
      currentChat.length > 0 ? getChatMessageContextText(currentChat[currentChat.length - 1], 180) : undefined,
    checkpointLatestPreview:
      checkpointChat.length > 0 ? getChatMessageContextText(checkpointChat[checkpointChat.length - 1], 180) : undefined,
    fileChanges,
    skippedFileChanges
  };
}

export function updateProjectMcpConfig(
  state: AppState,
  projectId: string,
  kind: McpPluginKind,
  pluginId: string
): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const plugin = state.mcpPlugins.find((item) => item.id === pluginId);
  const current = ensureProjectSessions(state.projects[index]);
  const currentServers = [
    ...(current.mcpBindings?.servers ?? []),
    current.mcpBindings?.engine,
    current.mcpBindings?.asset,
    current.mcpBindings?.qa,
    current.mcpBindings?.custom
  ].filter(Boolean) as string[];
  const nextServers = pluginId
    ? [...new Set([...currentServers.filter((id) => id !== current.mcpBindings?.[kind]), pluginId])]
    : currentServers.filter((id) => id !== current.mcpBindings?.[kind]);
  const updated: Project = {
    ...current,
    mcpPluginId: kind === 'engine' ? pluginId || undefined : current.mcpPluginId,
    mcpBindings: {
      ...(current.mcpBindings ?? {}),
      servers: nextServers,
      [kind]: pluginId || undefined
    },
    updatedAt: new Date().toISOString(),
    activity: [
      {
        id: `act_${Date.now()}`,
        kind: 'planning',
        title: '项目 MCP 插件已更新',
        detail: pluginId ? `已绑定 ${kind} MCP 插件：${plugin?.name || pluginId}` : `已取消 ${kind} MCP 插件绑定`,
        createdAt: new Date().toISOString()
      },
      ...current.activity
    ]
  };

  state.projects[index] = updated;
  return updated;
}

export function updateProjectMcpServerConfig(state: AppState, projectId: string, pluginIds: string[]): Project {
  return updateProjectMcpServers(state, projectId, pluginIds);
}

export function createProjectSession(state: AppState, projectId: string, title?: string): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[index]);
  const session = buildFreshSession(current, title);
  const updated: Project = {
    ...current,
    updatedAt: session.updatedAt,
    sessions: [session, ...current.sessions],
    activeSessionId: session.id,
    chat: [...session.chat]
  };

  state.projects[index] = updated;
  return updated;
}

export function renameProjectSession(state: AppState, projectId: string, sessionId: string, title: string): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[index]);
  const nextTitle = title.trim();
  if (!nextTitle) {
    throw new Error('Session title cannot be empty.');
  }
  const targetSession = current.sessions.find((session) => session.id === sessionId);
  if (!targetSession) {
    throw new Error('Session not found.');
  }

  const updatedAt = new Date().toISOString();
  let updated: Project = {
    ...current,
    updatedAt,
    sessions: current.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            title: nextTitle,
            autoTitle: false,
            updatedAt
          }
        : session
    )
  };

  updated = syncProjectChatFromActiveSession(updated);

  state.projects[index] = updated;
  return state.projects[index];
}

export function setActiveProjectSession(state: AppState, projectId: string, sessionId: string): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[index]);
  if (!current.sessions.some((session) => session.id === sessionId)) {
    throw new Error('Session not found.');
  }

  const updated = syncProjectChatFromActiveSession({
    ...current,
    activeSessionId: sessionId
  });
  state.projects[index] = updated;
  return updated;
}

function normalizeProjectAgentSkills(skills: ProjectAgentSkill[]): ProjectAgentSkill[] {
  const seen = new Set<string>();
  return skills
    .map((skill) => ({
      id: skill.id.trim(),
      name: skill.name.trim(),
      description: skill.description?.trim() || undefined,
      trigger: skill.trigger?.trim() || undefined,
      instruction: skill.instruction.trim(),
      enabled: Boolean(skill.enabled),
      source: skill.source,
      sourceId: skill.sourceId?.trim() || undefined,
      sourcePath: skill.sourcePath?.trim() || undefined,
      repositoryUrl: skill.repositoryUrl?.trim() || undefined,
      repositoryRef: skill.repositoryRef?.trim() || undefined,
      version: skill.version?.trim() || undefined,
      dependencies: skill.dependencies
        ?.map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 40),
      examples: skill.examples
        ?.map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 40),
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt
    }))
    .filter((skill) => {
      if (!skill.id || !skill.name || !skill.instruction || seen.has(skill.id)) {
        return false;
      }
      seen.add(skill.id);
      return true;
    })
    .slice(0, 100);
}

export function updateProjectAgentPolicy(
  state: AppState,
  projectId: string,
  policy: {
    permissionMode?: import('../../shared/types').AgentPermissionMode;
    skills?: ProjectAgentSkill[];
  }
): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const updatedAt = new Date().toISOString();
  const current = ensureProjectSessions(state.projects[index]);
  const skills = policy.skills !== undefined ? normalizeProjectAgentSkills(policy.skills) : current.agentPolicy?.skills;
  const nextPolicy = {
    ...(current.agentPolicy ?? {}),
    ...policy,
    skills,
    updatedAt
  };
  const hasPolicy = Boolean(nextPolicy.permissionMode) || Boolean(nextPolicy.skills?.length);
  const updated: Project = {
    ...current,
    agentPolicy: hasPolicy ? nextPolicy : undefined,
    updatedAt
  };

  state.projects[index] = updated;
  return updated;
}

export function updateProjectSessionRuntime(
  state: AppState,
  projectId: string,
  sessionId: string,
  runtime: {
    runtimeId?: import('../../shared/types').ProjectSessionRuntimeId;
    providerId?: string;
    model?: string;
    upstreamModel?: string;
    permissionMode?: import('../../shared/types').AgentPermissionMode;
    effort?: import('../../shared/types').ProjectSessionEffort;
    context1m?: boolean;
    thinking?: Record<string, unknown>;
    outputFormat?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    agent?: string;
  }
): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[index]);
  const session = current.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error('Session not found.');
  }

  if (runtime.providerId) {
    const provider = state.providers.find((item) => item.id === runtime.providerId && item.enabled);
    if (!provider) {
      throw new Error('Provider not found or disabled.');
    }
  }

  const updatedAt = new Date().toISOString();
  const hasRuntimeId = Object.prototype.hasOwnProperty.call(runtime, 'runtimeId');
  const hasProviderId = Object.prototype.hasOwnProperty.call(runtime, 'providerId');
  const hasModel = Object.prototype.hasOwnProperty.call(runtime, 'model');
  const hasUpstreamModel = Object.prototype.hasOwnProperty.call(runtime, 'upstreamModel');
  const hasPermissionMode = Object.prototype.hasOwnProperty.call(runtime, 'permissionMode');
  const hasEffort = Object.prototype.hasOwnProperty.call(runtime, 'effort');
  const hasContext1m = Object.prototype.hasOwnProperty.call(runtime, 'context1m');
  const hasThinking = Object.prototype.hasOwnProperty.call(runtime, 'thinking');
  const hasOutputFormat = Object.prototype.hasOwnProperty.call(runtime, 'outputFormat');
  const hasAgents = Object.prototype.hasOwnProperty.call(runtime, 'agents');
  const hasAgent = Object.prototype.hasOwnProperty.call(runtime, 'agent');
  const currentOverrides = session.runtimeOverrides ?? {};
  const overrides = {
    runtimeId: hasRuntimeId ? runtime.runtimeId : currentOverrides.runtimeId,
    providerId: hasProviderId ? runtime.providerId?.trim() || undefined : currentOverrides.providerId,
    model: hasModel ? runtime.model?.trim() || undefined : currentOverrides.model,
    upstreamModel: hasUpstreamModel ? runtime.upstreamModel?.trim() || undefined : currentOverrides.upstreamModel,
    permissionMode: hasPermissionMode ? runtime.permissionMode : currentOverrides.permissionMode,
    effort: hasEffort ? runtime.effort : currentOverrides.effort,
    context1m: hasContext1m ? runtime.context1m : currentOverrides.context1m,
    thinking: hasThinking ? runtime.thinking : currentOverrides.thinking,
    outputFormat: hasOutputFormat ? runtime.outputFormat : currentOverrides.outputFormat,
    agents: hasAgents ? runtime.agents : currentOverrides.agents,
    agent: hasAgent ? runtime.agent?.trim() || undefined : currentOverrides.agent,
    nativeContextSummary: currentOverrides.nativeContextSummary,
    nativeContextSummaryUpdatedAt: currentOverrides.nativeContextSummaryUpdatedAt,
    nativeContextSummaryTurnCount: currentOverrides.nativeContextSummaryTurnCount,
    nativeContextSummaryCoverage: currentOverrides.nativeContextSummaryCoverage,
    sessionWritePermissionGrant: currentOverrides.sessionWritePermissionGrant
  };

  const updated = syncProjectChatFromActiveSession({
    ...current,
    updatedAt,
    sessions: current.sessions.map((item) =>
      item.id === sessionId
        ? {
            ...item,
            runtimeOverrides:
              overrides.runtimeId ||
              overrides.providerId ||
              overrides.model ||
              overrides.upstreamModel ||
              overrides.permissionMode ||
              overrides.effort ||
              overrides.context1m ||
              overrides.thinking ||
              overrides.outputFormat ||
              overrides.agents ||
              overrides.agent ||
              overrides.nativeContextSummary ||
              overrides.sessionWritePermissionGrant
                ? overrides
                : undefined,
            updatedAt
          }
        : item
    )
  });

  state.projects[index] = updated;
  return updated;
}

export function deleteProjectSession(state: AppState, projectId: string, sessionId: string): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = ensureProjectSessions(state.projects[index]);
  const deletedSession = current.sessions.find((session) => session.id === sessionId);
  if (!deletedSession) {
    throw new Error('Session not found.');
  }
  const remainingSessions = current.sessions.filter((session) => session.id !== sessionId);
  const nextSessions = remainingSessions.length > 0 ? remainingSessions : [buildFreshSession(current)];
  const nextActiveSessionId =
    current.activeSessionId === sessionId ? nextSessions[0].id : (current.activeSessionId ?? nextSessions[0].id);
  const updated = syncProjectChatFromActiveSession({
    ...current,
    updatedAt: new Date().toISOString(),
    sessions: nextSessions,
    activeSessionId: nextActiveSessionId
  });

  state.projects[index] = updated;
  return updated;
}
