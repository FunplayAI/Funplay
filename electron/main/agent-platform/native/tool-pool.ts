import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { OpenAiCompatibleToolDefinition } from '../../openai-compatible-client';
import type { ConversationOperationStageEvent } from '../operation-log';
import type { GenericAgentRuntimeParams } from '../types';
import { emitRuntimeLifecycleHook } from '../runtime-event-emitter';
import type { WorkspaceToolAction } from '../workspace-tools';
import { materializeNativeMcpTools, type NativeMcpMaterializationFailure } from './mcp-tool-materializer';
import {
  createNativeWorkspaceTools,
  listNativeWorkspaceToolDefinitions,
  type NativeRuntimeToolDefinition,
  type NativeWorkspaceToolAdapterOptions
} from './tool-adapter';

export interface NativeToolPoolMode {
  includeWriteTools: boolean;
  includeMcpToolCalls: boolean;
  includeCommandTools: boolean;
  excludeTools?: Array<WorkspaceToolAction['type']>;
}

export type NativeToolPoolDelegates = Pick<
  NativeWorkspaceToolAdapterOptions,
  | 'requestUserInput'
  | 'requestMcpUserInput'
  | 'runSubagent'
  | 'runSubagents'
  | 'startSubagent'
  | 'readSubagentStatus'
>;

export interface NativeToolPool {
  definitions: NativeRuntimeToolDefinition[];
  names: string[];
  dynamicMcpTools: NativeRuntimeToolDefinition[];
  toolSet: ToolSet;
  openAiCompatibleTools: OpenAiCompatibleToolDefinition[];
  refresh: (input: {
    stepIndex: number;
    emitStage?: (stage: ConversationOperationStageEvent) => void;
  }) => Promise<boolean>;
}

function summarizeMcpMaterializationFailures(failures: NativeMcpMaterializationFailure[]): string {
  return failures
    .slice(0, 6)
    .map((failure) => `${failure.pluginName}: ${failure.message}`)
    .join('；');
}

function diffNativeRuntimeToolNames(previous: NativeRuntimeToolDefinition[], next: NativeRuntimeToolDefinition[]): {
  added: string[];
  removed: string[];
} {
  const previousNames = new Set(previous.map((definition) => definition.name));
  const nextNames = new Set(next.map((definition) => definition.name));
  return {
    added: [...nextNames].filter((name) => !previousNames.has(name)),
    removed: [...previousNames].filter((name) => !nextNames.has(name))
  };
}

async function prepareNativeDynamicMcpTools(
  params: GenericAgentRuntimeParams,
  includeMcpToolCalls: boolean,
  emitStage?: (stage: ConversationOperationStageEvent) => void
): Promise<NativeRuntimeToolDefinition[]> {
  if (!includeMcpToolCalls) {
    return [];
  }

  const enabledPlugins = (params.plugins ?? []).filter((plugin) =>
    plugin.enabled && (plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl.trim()))
  );
  if (enabledPlugins.length === 0) {
    return [];
  }

  emitStage?.({
    stageId: 'stage:native_mcp_tool_materialization',
    title: '发现 MCP 工具',
    target: 'stage:native_mcp_tool_materialization',
    status: 'running',
    summary: `正在从 ${enabledPlugins.length} 个 MCP Server 读取 tools/list。`
  });

  const result = await materializeNativeMcpTools({
    plugins: enabledPlugins,
    abortSignal: params.abortSignal
  });
  params.abortSignal?.throwIfAborted();

  emitStage?.({
    stageId: 'stage:native_mcp_tool_materialization',
    title: '发现 MCP 工具',
    target: 'stage:native_mcp_tool_materialization',
    status: result.failures.length > 0 && result.tools.length === 0 ? 'failed' : 'completed',
    summary: [
      result.tools.length > 0 ? `已物化 ${result.tools.length} 个 Claude-style MCP 工具。` : '没有发现可物化的 MCP 工具。',
      result.failures.length > 0 ? `失败：${summarizeMcpMaterializationFailures(result.failures)}` : ''
    ].filter(Boolean).join(' '),
    input: {
      tools: result.tools.map((toolDefinition) => toolDefinition.name),
      failures: result.failures
    }
  });

  return result.tools;
}

async function refreshNativeDynamicMcpToolsBetweenTurns(input: {
  params: GenericAgentRuntimeParams;
  includeMcpToolCalls: boolean;
  previousTools: NativeRuntimeToolDefinition[];
  stepIndex: number;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
}): Promise<NativeRuntimeToolDefinition[]> {
  if (!input.includeMcpToolCalls || input.stepIndex === 0 || input.previousTools.length === 0 && (input.params.plugins ?? []).length === 0) {
    return input.previousTools;
  }

  const nextTools = await prepareNativeDynamicMcpTools(input.params, input.includeMcpToolCalls);
  const diff = diffNativeRuntimeToolNames(input.previousTools, nextTools);
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return input.previousTools;
  }

  input.emitStage?.({
    stageId: 'stage:native_mcp_tool_refresh',
    title: '刷新 MCP 工具',
    target: 'stage:native_mcp_tool_refresh',
    status: 'completed',
    summary: [
      diff.added.length > 0 ? `新增 ${diff.added.join(', ')}` : '',
      diff.removed.length > 0 ? `移除 ${diff.removed.join(', ')}` : ''
    ].filter(Boolean).join('；') || 'MCP 工具集合未变化。',
    input: {
      step: input.stepIndex,
      added: diff.added,
      removed: diff.removed,
      tools: nextTools.map((definition) => definition.name)
    }
  });

  return nextTools;
}

function toOpenAiCompatibleToolParameters(definition: NativeRuntimeToolDefinition): Record<string, unknown> {
  if (definition.inputJsonSchema) {
    const schema = { ...definition.inputJsonSchema };
    delete schema.$schema;
    return schema;
  }
  const schema = z.toJSONSchema(definition.inputSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function toOpenAiCompatibleToolDescription(definition: NativeRuntimeToolDefinition): string {
  const language = definition.toolLanguage;
  return [
    definition.description,
    language?.canonicalName ? `Claude-like tool role: ${language.canonicalName}.` : '',
    language?.aliases?.length ? `Aliases the model may think of: ${language.aliases.join(', ')}.` : '',
    language?.usageHint ? `Use when: ${language.usageHint}` : '',
    language?.failureHint ? `If it fails: ${language.failureHint}` : ''
  ].filter(Boolean).join('\n');
}

export function toOpenAiCompatibleToolDefinitions(definitions: NativeRuntimeToolDefinition[]): OpenAiCompatibleToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: toOpenAiCompatibleToolDescription(definition),
    parameters: toOpenAiCompatibleToolParameters(definition)
  }));
}

function createNativeToolAdapterOptions(input: {
  params: GenericAgentRuntimeParams;
  mode: NativeToolPoolMode;
  dynamicMcpTools: NativeRuntimeToolDefinition[];
  delegates?: NativeToolPoolDelegates;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
}): NativeWorkspaceToolAdapterOptions {
  return {
    project: input.params.project,
    plugins: input.params.plugins,
    checkpointSnapshotId: input.params.checkpointSnapshotId,
    abortSignal: input.params.abortSignal,
    appState: input.params.appState,
    persistAppState: input.params.persistAppState,
    includeWriteTools: input.mode.includeWriteTools,
    includeMcpToolCalls: input.mode.includeMcpToolCalls,
    includeCommandTools: input.mode.includeCommandTools,
    excludeTools: input.mode.excludeTools,
    dynamicTools: input.dynamicMcpTools,
    permissionContext: {
      permission: input.params.permission,
      requestPermission: input.params.requestPermission
    },
    lifecycleHooks: input.params.lifecycleHooks,
    lifecycleHookContext: {
      runId: input.params.activeRunId,
      projectId: input.params.project.id,
      sessionId: input.params.context.activeSessionId,
      cwd: input.params.context.runtimeEnvironment?.workingDirectory ?? input.params.context.projectPath
    },
    onLifecycleHook: (hook) => emitRuntimeLifecycleHook(input.params, hook),
    emitLifecycleHookStage: input.emitStage,
    requestUserInput: input.delegates?.requestUserInput,
    requestMcpUserInput: input.delegates?.requestMcpUserInput,
    runSubagent: input.delegates?.runSubagent,
    runSubagents: input.delegates?.runSubagents,
    startSubagent: input.delegates?.startSubagent,
    readSubagentStatus: input.delegates?.readSubagentStatus
  };
}

export async function createNativeToolPool(input: {
  params: GenericAgentRuntimeParams;
  mode: NativeToolPoolMode;
  delegates?: NativeToolPoolDelegates;
  emitStage?: (stage: ConversationOperationStageEvent) => void;
}): Promise<NativeToolPool> {
  const dynamicMcpTools = await prepareNativeDynamicMcpTools(
    input.params,
    input.mode.includeMcpToolCalls,
    input.emitStage
  );
  const pool = {
    definitions: [] as NativeRuntimeToolDefinition[],
    names: [] as string[],
    dynamicMcpTools,
    toolSet: {} as ToolSet,
    openAiCompatibleTools: [] as OpenAiCompatibleToolDefinition[],
    refresh: async (refreshInput: {
      stepIndex: number;
      emitStage?: (stage: ConversationOperationStageEvent) => void;
    }): Promise<boolean> => {
      const nextDynamicTools = await refreshNativeDynamicMcpToolsBetweenTurns({
        params: input.params,
        includeMcpToolCalls: input.mode.includeMcpToolCalls,
        previousTools: pool.dynamicMcpTools,
        stepIndex: refreshInput.stepIndex,
        emitStage: refreshInput.emitStage ?? input.emitStage
      });
      if (nextDynamicTools === pool.dynamicMcpTools) {
        return false;
      }
      pool.dynamicMcpTools = nextDynamicTools;
      rebuild();
      return true;
    }
  };

  function rebuild(): void {
    const adapterOptions = createNativeToolAdapterOptions({
      params: input.params,
      mode: input.mode,
      dynamicMcpTools: pool.dynamicMcpTools,
      delegates: input.delegates,
      emitStage: input.emitStage
    });
    pool.definitions = listNativeWorkspaceToolDefinitions(adapterOptions);
    pool.names = pool.definitions.map((definition) => definition.name);
    pool.toolSet = createNativeWorkspaceTools(adapterOptions);
    pool.openAiCompatibleTools = toOpenAiCompatibleToolDefinitions(pool.definitions);
  }

  rebuild();
  return pool;
}
