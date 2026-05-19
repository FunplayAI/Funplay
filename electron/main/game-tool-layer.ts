import type { GameAgentPluginReport, McpPlugin, UnityMcpCallResult, UnityMcpResource, UnityMcpTool } from '../../shared/types';
import type { McpClientRequestHandler } from './mcp-connection-manager';
import {
  callUnityTool,
  initializeUnityMcp,
  listUnityResources,
  listUnityTools,
  readUnityResource,
  type UnityMcpEndpoint
} from './unity-mcp-client';

export interface GameToolAssembly {
  available: boolean;
  serverInfo?: {
    name: string;
    version: string;
  };
  preferredTools: UnityMcpTool[];
  allTools: UnityMcpTool[];
  resources: UnityMcpResource[];
  projectContext?: string;
}

const preferredResourceUris: Record<string, string[]> = {
  engine: ['unity://project/context', 'unity://project/summary', 'unity://scene/active'],
  asset: ['unity://project/summary', 'unity://project/context'],
  qa: ['unity://errors/compilation', 'unity://errors/console', 'unity://project/context'],
  custom: []
};

const preferredSafeToolNames: Record<string, string[]> = {
  engine: ['get_scene_info', 'get_compilation_status'],
  asset: [],
  qa: ['get_compilation_status', 'get_console_logs'],
  custom: []
};

const preferredToolNames = [
  'execute_code',
  'get_scene_info',
  'get_console_logs',
  'take_game_view_screenshot',
  'take_scene_view_screenshot',
  'get_compilation_status',
  'enter_play_mode',
  'exit_play_mode'
];

function extractText(result: UnityMcpCallResult): string {
  return result.content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export async function assembleGameTools(endpoint: UnityMcpEndpoint): Promise<GameToolAssembly> {
  const serverInfo = await initializeUnityMcp(endpoint);
  const [allTools, resources] = await Promise.all([listUnityTools(endpoint), listUnityResources(endpoint)]);
  const preferredTools = allTools.filter((tool) => preferredToolNames.includes(tool.name));

  let projectContext = '';
  const hasProjectContext = resources.some((resource) => resource.uri === 'unity://project/context');

  if (hasProjectContext) {
    try {
      const content = await readUnityResource(endpoint, 'unity://project/context');
      projectContext = extractText(content);
    } catch {
      projectContext = '';
    }
  }

  return {
    available: true,
    serverInfo: {
      name: serverInfo.name,
      version: serverInfo.version
    },
    preferredTools,
    allTools,
    resources,
    projectContext
  };
}

export async function executeUnityTool(
  endpoint: UnityMcpEndpoint,
  toolName: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  clientRequestHandler?: McpClientRequestHandler
): Promise<UnityMcpCallResult> {
  return callUnityTool(endpoint, toolName, args, abortSignal, clientRequestHandler);
}

function hasEmptyInputSchema(tool: UnityMcpTool): boolean {
  const schema = tool.inputSchema ?? {};
  const properties = typeof schema.properties === 'object' && schema.properties ? Object.keys(schema.properties as Record<string, unknown>) : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return properties.length === 0 && required.length === 0;
}

function summarizeResultText(result: UnityMcpCallResult): string {
  const text = extractText(result);
  if (!text) {
    return 'No text output.';
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export async function collectPluginObservations(plugin: McpPlugin): Promise<{
  assembly: GameToolAssembly;
  report: GameAgentPluginReport;
}> {
  const assembly = await assembleGameTools(plugin);
  const resourceReads: string[] = [];
  const toolCalls: string[] = [];
  const observations: string[] = [];

  for (const uri of preferredResourceUris[plugin.kind] ?? []) {
    if (!assembly.resources.some((resource) => resource.uri === uri)) {
      continue;
    }

    try {
      const result = await readUnityResource(plugin, uri);
      resourceReads.push(uri);
      observations.push(`${uri}: ${summarizeResultText(result)}`);
    } catch {
      // best effort
    }
  }

  for (const toolName of preferredSafeToolNames[plugin.kind] ?? []) {
    const tool = assembly.allTools.find((entry) => entry.name === toolName);
    if (!tool || !hasEmptyInputSchema(tool)) {
      continue;
    }

    try {
      const result = await callUnityTool(plugin, toolName, {});
      toolCalls.push(toolName);
      observations.push(`${toolName}: ${summarizeResultText(result)}`);
    } catch {
      // best effort
    }
  }

  const report: GameAgentPluginReport = {
    pluginId: plugin.id,
    pluginName: plugin.name,
    kind: plugin.kind,
    status: 'completed',
    resourceReads,
    toolCalls,
    observations: observations.slice(0, 8)
  };

  return {
    assembly,
    report
  };
}
