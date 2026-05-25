import { runAgentLifecycleHooks } from '../agent-hooks';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { GenericAgentRuntimeParams } from '../types';
import { extractToolResultForCollector } from './stream-events';
import type {
  ClaudeContentBlock,
  ClaudeRuntimeState
} from './types';

export type ClaudePostToolUseHookSource = 'sdk_assistant' | 'sdk_user' | 'cli_assistant' | 'cli_user';

export function createClaudePostToolUseHookQueue(options: {
  params: GenericAgentRuntimeParams;
  state: Pick<ClaudeRuntimeState, 'toolNamesByUseId'>;
  cwd: string;
  emitStage: (stage: ConversationOperationStageEvent) => void;
}) {
  const postToolUseHookedResults = new Set<string>();
  const pendingPostToolUseHookRuns = new Set<Promise<void>>();

  const runForContent = async (
    content: ClaudeContentBlock[] | string | undefined,
    source: ClaudePostToolUseHookSource
  ): Promise<void> => {
    if (!Array.isArray(content) || !options.params.lifecycleHooks?.rules.length) {
      return;
    }
    for (const [index, block] of content.entries()) {
      if (block.type !== 'tool_result') {
        continue;
      }
      const toolUseId = block.tool_use_id ?? `claude_tool_result_${index}`;
      if (postToolUseHookedResults.has(toolUseId)) {
        continue;
      }
      postToolUseHookedResults.add(toolUseId);
      const toolName = options.state.toolNamesByUseId.get(toolUseId) ?? 'claude_tool';
      const extracted = extractToolResultForCollector(block);
      await runAgentLifecycleHooks(options.params.lifecycleHooks, {
        event: 'PostToolUse',
        runId: options.params.activeRunId,
        projectId: options.params.project.id,
        sessionId: options.params.context.activeSessionId,
        toolUseId,
        toolName,
        status: block.is_error ? 'failed' : 'completed',
        metadata: {
          claudeTool: true,
          source,
          isError: Boolean(block.is_error),
          resultLength: extracted.content.length,
          resultPreview: extracted.content.slice(0, 2000),
          mediaCount: extracted.media?.length ?? 0
        }
      }, {
        project: options.params.project,
        permissionContext: {
          permission: options.params.permission,
          requestPermission: options.params.requestPermission
        },
        cwd: options.cwd,
        checkpointSnapshotId: options.params.checkpointSnapshotId,
        abortSignal: options.params.abortSignal,
        emitHook: options.params.onLifecycleHook,
        emitStage: (stage) => options.emitStage({
          ...stage,
          runtimeId: 'claude-code-sdk',
          providerId: options.params.provider?.id,
          model: options.params.provider?.model,
          upstreamModel: options.params.provider?.upstreamModel
        })
      });
    }
  };

  const queueForContent = (
    content: ClaudeContentBlock[] | string | undefined,
    source: ClaudePostToolUseHookSource
  ): Promise<void> => {
    let queuedRun: Promise<void>;
    queuedRun = runForContent(content, source)
      .catch((error) => {
        options.emitStage({
          stageId: 'stage:lifecycle_hook:PostToolUse:claude_error',
          phase: 'hook',
          title: '生命周期 Hook',
          target: 'hook:PostToolUse',
          status: 'failed',
          summary: error instanceof Error ? error.message : 'Claude PostToolUse hook failed.',
          errorMessage: error instanceof Error ? error.message : String(error),
          runtimeId: 'claude-code-sdk',
          providerId: options.params.provider?.id,
          model: options.params.provider?.model,
          upstreamModel: options.params.provider?.upstreamModel
        });
      })
      .finally(() => {
        pendingPostToolUseHookRuns.delete(queuedRun);
      });
    pendingPostToolUseHookRuns.add(queuedRun);
    return queuedRun;
  };

  const drain = async (): Promise<void> => {
    while (pendingPostToolUseHookRuns.size > 0) {
      await Promise.allSettled([...pendingPostToolUseHookRuns]);
    }
  };

  return {
    queueForContent,
    drain
  };
}
