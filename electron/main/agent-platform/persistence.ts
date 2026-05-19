import type { AiProvider, AppState, McpPlugin, Project } from '../../../shared/types';

export interface ResolvedAgentProjectContext {
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

export interface AgentStateAdapter {
  getState: () => AppState;
  persistState: (state: AppState) => Promise<void>;
  resolveProjectContext: (projectId: string, sessionId?: string) => ResolvedAgentProjectContext;
  mergeUpdatedProject: (resolved: ResolvedAgentProjectContext, updated: Project, sessionId?: string) => Project;
}
