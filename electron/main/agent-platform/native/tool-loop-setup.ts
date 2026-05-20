import type { GenericAgentRuntimeParams } from '../types';
import type { NativeToolLoopCallbacks } from './tool-loop-controller';
import { createNativeToolLoopDelegates } from './tool-loop-delegates';
import { createNativeToolPool, type NativeToolPool } from './tool-pool';

export interface NativeToolLoopFeatureFlags {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
}

export type NativeToolLoopSetupCallbacks = Pick<
  NativeToolLoopCallbacks,
  'emitStage' | 'includeWriteTools' | 'includeMcpToolCalls' | 'includeCommandTools'
>;

export interface NativeToolLoopToolPoolSetup {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  toolPool: NativeToolPool;
  toolNames: string[];
}

export function resolveNativeToolLoopFeatureFlags(callbacks?: NativeToolLoopSetupCallbacks): NativeToolLoopFeatureFlags {
  return {
    includeWriteTools: Boolean(callbacks?.includeWriteTools),
    includeMcpToolCalls: Boolean(callbacks?.includeMcpToolCalls),
    includeCommandTools: Boolean(callbacks?.includeCommandTools)
  };
}

export async function initializeNativeToolLoopToolPool(
  params: GenericAgentRuntimeParams,
  callbacks: NativeToolLoopSetupCallbacks | undefined,
  stage: {
    title: string;
    runningSummary: string;
    completedSummary: (toolCount: number) => string;
  }
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
    emitStage: callbacks?.emitStage
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
      dynamicMcpToolCount: toolPool.dynamicMcpTools.length
    }
  });

  return {
    ...flags,
    toolPool,
    toolNames
  };
}
