import type { GenericAgentRuntimeParams } from '../types';
import type { ConversationOperationStageEvent } from '../operation-log';
import { runAgentLifecycleHooks } from '../agent-hooks';

export function createClaudeRuntimeLifecycle(input: {
  params: GenericAgentRuntimeParams;
  getCwd: () => string | undefined;
  emitStage: (stage: ConversationOperationStageEvent) => void;
}) {
  const appendContext = (contexts: string[]): void => {
    if (contexts.length === 0) {
      return;
    }
    input.params.lifecycleHookContext = [
      ...(input.params.lifecycleHookContext ?? []),
      ...contexts
    ];
  };

  const runHooks = (trigger: Parameters<typeof runAgentLifecycleHooks>[1]) => runAgentLifecycleHooks(
    input.params.lifecycleHooks,
    {
      runId: input.params.activeRunId,
      projectId: input.params.project.id,
      sessionId: input.params.context.activeSessionId,
      ...trigger
    },
    {
      project: input.params.project,
      permissionContext: {
        permission: input.params.permission,
        requestPermission: input.params.requestPermission
      },
      cwd: input.getCwd() ?? input.params.context.runtimeEnvironment?.workingDirectory ?? input.params.context.projectPath,
      checkpointSnapshotId: input.params.checkpointSnapshotId,
      abortSignal: input.params.abortSignal,
      emitHook: input.params.onLifecycleHook,
      emitStage: (stage) => input.emitStage({
        ...stage,
        runtimeId: 'claude-code-sdk',
        providerId: input.params.provider?.id,
        model: input.params.provider?.model,
        upstreamModel: input.params.provider?.upstreamModel
      })
    }
  );

  return {
    appendContext,
    runHooks
  };
}
