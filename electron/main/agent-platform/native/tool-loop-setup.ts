import type { GenericAgentRuntimeParams } from '../types';
import type { AgentToolFamily } from '../tool-policy';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import { createNativeToolLoopDelegates } from './tool-loop-delegates';
import { createNativeToolPool, type NativeToolPool, type NativeToolPoolProjectInstructionGuard } from './tool-pool';

export interface NativeToolLoopFeatureFlags {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  allowedToolFamilies?: AgentToolFamily[];
}

export type NativeToolLoopSetupCallbacks = Pick<
  NativeToolLoopCallbacks,
  'emitStage' | 'includeWriteTools' | 'includeMcpToolCalls' | 'includeCommandTools'
> & Pick<NativeToolLoopCallbacks, 'allowedToolFamilies'>;

export interface NativeToolLoopToolPoolSetup {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  allowedToolFamilies?: AgentToolFamily[];
  toolPool: NativeToolPool;
  toolNames: string[];
}

export function resolveNativeToolLoopFeatureFlags(callbacks?: NativeToolLoopSetupCallbacks): NativeToolLoopFeatureFlags {
  return {
    includeWriteTools: Boolean(callbacks?.includeWriteTools),
    includeMcpToolCalls: Boolean(callbacks?.includeMcpToolCalls),
    includeCommandTools: Boolean(callbacks?.includeCommandTools),
    allowedToolFamilies: callbacks?.allowedToolFamilies
  };
}

export async function initializeNativeToolLoopToolPool(
  params: GenericAgentRuntimeParams,
  callbacks: NativeToolLoopSetupCallbacks | undefined,
  stage: {
    title: string;
    runningSummary: string;
    completedSummary: (toolCount: number) => string;
  },
  options: {
    projectInstructionGuard?: NativeToolPoolProjectInstructionGuard;
  } = {}
): Promise<NativeToolLoopToolPoolSetup> {
  const flags = resolveNativeToolLoopFeatureFlags(callbacks);
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: stage.title,
    target: 'stage:native_tool_schema',
    status: 'running',
    summary: stage.runningSummary
  });
  const toolPool = await createNativeToolPool({
    params,
    mode: flags,
    delegates: createNativeToolLoopDelegates(params),
    emitStage: callbacks?.emitStage,
    projectInstructionGuard: options.projectInstructionGuard
  });
  const toolNames = toolPool.names;
  callbacks?.emitStage?.({
    stageId: 'stage:native_tool_schema',
    title: stage.title,
    target: 'stage:native_tool_schema',
    status: 'completed',
    summary: stage.completedSummary(toolNames.length),
    input: {
      tools: [...toolNames],
      includeWriteTools: flags.includeWriteTools,
      includeMcpToolCalls: flags.includeMcpToolCalls,
      includeCommandTools: flags.includeCommandTools,
      allowedToolFamilies: flags.allowedToolFamilies,
      dynamicMcpToolCount: toolPool.dynamicMcpTools.length
    }
  });

  return {
    ...flags,
    toolPool,
    toolNames
  };
}
