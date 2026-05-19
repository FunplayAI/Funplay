import type { AppState, Project } from '../../../shared/types';
import { mergeUpdatedProjectIntoState, resolveAgentProjectContext } from './session-store';
import type { AgentStateAdapter, ResolvedAgentProjectContext } from './persistence';

export function createStateAdapter(params: {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
}): AgentStateAdapter {
  return {
    getState: params.getState,
    persistState: params.persistState,
    resolveProjectContext: (projectId: string, sessionId?: string): ResolvedAgentProjectContext =>
      resolveAgentProjectContext(params.getState(), projectId, sessionId),
    mergeUpdatedProject: (resolved: ResolvedAgentProjectContext, updated: Project, sessionId?: string): Project =>
      mergeUpdatedProjectIntoState(params.getState(), resolved, updated, sessionId)
  };
}
