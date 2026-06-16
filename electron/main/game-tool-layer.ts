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

// Engine-agnostic resource preferences: match by the scheme-less path SUFFIX so
// the same set applies whether the bridge speaks unity:// or cocos:// (Unity and
// the funplay-cocos-mcp bridge expose a parallel resource layout —
// project/context, scene/active, selection/current, errors/*, logs/*). This is
// what lets a Cocos engine agent warm-start instead of finding zero unity:// URIs.
const preferredResourceSuffixes: Record<string, string[]> = {
  engine: ['project/context', 'project/summary', 'scene/active'],
  asset: ['project/summary', 'project/context'],
  qa: ['errors/compilation', 'errors/console', 'errors/scripts', 'logs/editor', 'project/context'],
  custom: []
};

const PROJECT_CONTEXT_SUFFIX = 'project/context';

function uriMatchesSuffix(uri: string, suffix: string): boolean {
  return uri === suffix || uri.endsWith(`://${suffix}`) || uri.endsWith(`/${suffix}`);
}

const preferredSafeToolNames: Record<string, string[]> = {
  engine: ['get_scene_info', 'get_compilation_status', 'get_runtime_state'],
  asset: [],
  qa: ['get_compilation_status', 'get_console_logs', 'get_recent_logs', 'get_script_diagnostic_context'],
  custom: []
};

const preferredToolNames = [
  // Unity bridge
  'execute_code',
  'get_scene_info',
  'get_console_logs',
  'take_game_view_screenshot',
  'take_scene_view_screenshot',
  'get_compilation_status',
  'enter_play_mode',
  'exit_play_mode',
  // Cocos (funplay-cocos-mcp) bridge equivalents
  'execute_javascript',
  'execute_scene_script',
  'get_recent_logs',
  'capture_game_screenshot',
  'capture_scene_screenshot',
  'run_project_preview',
  'get_runtime_state',
  'get_script_diagnostic_context'
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
  const contextResource = resources.find((resource) => uriMatchesSuffix(resource.uri, PROJECT_CONTEXT_SUFFIX));

  if (contextResource) {
    try {
      const content = await readUnityResource(endpoint, contextResource.uri);
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

  const seenResourceUris = new Set<string>();
  for (const suffix of preferredResourceSuffixes[plugin.kind] ?? []) {
    const resource = assembly.resources.find(
      (entry) => uriMatchesSuffix(entry.uri, suffix) && !seenResourceUris.has(entry.uri)
    );
    if (!resource) {
      continue;
    }
    seenResourceUris.add(resource.uri);

    try {
      const result = await readUnityResource(plugin, resource.uri);
      resourceReads.push(resource.uri);
      observations.push(`${resource.uri}: ${summarizeResultText(result)}`);
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
