import type { AiProvider, CreateProjectInput, GameAgentRun, McpPlugin, Project } from '../../shared/types';
import { executeGenericAgentTask as executeAgentTask } from './agent-platform/task-executor';

interface RuntimeResult {
  project: Project;
  run: GameAgentRun;
}

export async function runBootstrapAgent(params: {
  project: Project;
  input: CreateProjectInput;
  provider?: AiProvider;
  enginePlugin?: McpPlugin;
  assetPlugin?: McpPlugin;
  qaPlugin?: McpPlugin;
  customPlugin?: McpPlugin;
}): Promise<RuntimeResult> {
  const result = await executeAgentTask({
    kind: 'bootstrap',
    ...params
  });

  if (!result.run) {
    throw new Error('Bootstrap agent task did not return a run.');
  }

  return {
    project: result.project,
    run: result.run
  };
}

export async function runChatAgent(params: {
  project: Project;
  message: string;
  provider?: AiProvider;
  enginePlugin?: McpPlugin;
  assetPlugin?: McpPlugin;
  qaPlugin?: McpPlugin;
  customPlugin?: McpPlugin;
  abortSignal?: AbortSignal;
  onStatus?: (phase: 'thinking' | 'streaming', message: string) => void;
  onTextDelta?: (delta: string, accumulated: string) => void;
}): Promise<RuntimeResult> {
  const result = await executeAgentTask({
    kind: 'conversation',
    ...params
  });

  if (!result.run) {
    throw new Error('Conversation agent task did not return a run.');
  }

  return {
    project: result.project,
    run: result.run
  };
}
