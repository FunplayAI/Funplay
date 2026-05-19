import { executeProjectPlanTurn } from './execution-engine';
import { createGenericAgentRuntimeCapabilities } from './runtime-capabilities';
import type { GenericAgentRuntime } from './types';

export const executionPlanRuntime: GenericAgentRuntime = {
  id: 'execute-plan',
  displayName: 'Execution Plan',
  description: 'Specialized Unity execution runtime with checkpoint, diagnostics, repair, replan, and rollback stages.',
  capabilities: createGenericAgentRuntimeCapabilities({
    executePlan: true,
    toolLoop: true,
    workspaceWrite: true,
    mcpTools: true,
    sessionPermission: true,
    checkpoint: true,
    toolCheckpoint: true,
    resume: true,
    toolResume: true,
    hostControlledWrites: true
  }),
  isAvailable: () => true,
  interrupt: () => undefined,
  dispose: () => undefined,
  executePlan: (task) =>
    executeProjectPlanTurn(
      task.state,
      task.projectId,
      {
        onStatus: task.onStatus,
        onToolUse: task.onToolUse,
        onToolResult: task.onToolResult,
        onStage: task.onStage,
        onPermissionRequest: task.onPermissionRequest,
        requestPermission: task.requestPermission
      },
      task.controller,
      task.checkpointSnapshotId
    )
};
