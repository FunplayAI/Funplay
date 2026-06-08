import { ensureProjectSessions, getActiveProjectSession, replaceProjectSession, syncProjectChatFromActiveSession } from '../../../shared/project-sessions';
import type { AppState, Project } from '../../../shared/types';
import { resolveProjectPluginByKind, resolveProjectPlugins } from '../mcp-plugin-service';
import { resolveAgentProvider } from './provider-resolver';
import type { ResolvedAgentProjectContext } from './persistence';

export function resolveAgentProjectContext(state: AppState, projectId: string, targetSessionId?: string): ResolvedAgentProjectContext {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const ensured = ensureProjectSessions(state.projects[index]);
  if (targetSessionId && !ensured.sessions.some((session) => session.id === targetSessionId)) {
    throw new Error('Session not found.');
  }

  const current = syncProjectChatFromActiveSession({
    ...ensured,
    activeSessionId: targetSessionId ?? ensured.activeSessionId
  });
  const provider = resolveAgentProvider(state, current);
  const mcpPlugins = resolveProjectPlugins(state, current);
  const enginePlugin =
    current.engine?.platform === 'unity' || current.engine?.platform === 'cocos'
      ? resolveProjectPluginByKind(state, current.mcpBindings, 'engine', current.id)
      : undefined;
  const assetPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'asset', current.id);
  const qaPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'qa', current.id);
  const customPlugin = resolveProjectPluginByKind(state, current.mcpBindings, 'custom', current.id);
  const sessionId = getActiveProjectSession(current).id;

  return {
    index,
    current,
    provider,
    enginePlugin,
    assetPlugin,
    qaPlugin,
    customPlugin,
    mcpPlugins,
    sessionId
  };
}

export function mergeUpdatedProjectIntoState(
  state: AppState,
  resolved: ResolvedAgentProjectContext,
  updated: Project,
  targetSessionId?: string
): Project {
  const latestProject = ensureProjectSessions(state.projects[resolved.index]);
  const updatedProject = ensureProjectSessions(updated);
  const sessionId = targetSessionId ?? updatedProject.activeSessionId ?? updatedProject.sessions[0]?.id;
  const updatedSession =
    updatedProject.sessions.find((session) => session.id === sessionId) ?? getActiveProjectSession(updatedProject);

  const mergedProject = replaceProjectSession(
    {
      ...latestProject,
      updatedAt: updatedProject.updatedAt,
      status: updatedProject.status,
      runtimeState: updatedProject.runtimeState,
      blueprint: updatedProject.blueprint,
      tasks: [...updatedProject.tasks],
      assets: [...updatedProject.assets],
      activity: [...updatedProject.activity],
      snapshots: [...updatedProject.snapshots],
      memory: updatedProject.memory,
      contextSummary: updatedProject.contextSummary,
      lastAgentRun: updatedProject.lastAgentRun,
      currentExecutionPlan: updatedProject.currentExecutionPlan,
      lastExecutedPlan: updatedProject.lastExecutedPlan
    },
    {
      ...updatedSession,
      chat: [...updatedSession.chat]
    },
    latestProject.activeSessionId
  );

  state.projects[resolved.index] = mergedProject;
  return mergedProject;
}
