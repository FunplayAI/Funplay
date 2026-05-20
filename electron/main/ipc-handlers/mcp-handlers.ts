import type { IpcMain } from 'electron';
import type { McpPlugin, UnityHealthResult } from '../../../shared/types';
import type { HandlerContext } from './types';
import {
  mcpPluginInputSchema,
  mcpCompletionContextSchema,
  mcpCompletionRefSchema,
  mcpCompletionValueSchema,
  mcpPromptArgsSchema,
  mcpPromptNameSchema,
  pluginIdSchema,
  projectIdSchema,
  resourceUriSchema,
  toolArgsSchema,
  toolNameSchema,
  validateIpcInput
} from '../ipc-validation';
import {
  createMcpPlugin,
  deleteMcpPlugin,
  setActiveMcpPlugin,
  updateMcpPlugin
} from '../mcp-plugin-service';
import { checkUnityHealth, reconnectUnityHealth } from '../unity-bridge';
import { getMcpConnectionSnapshot, reconnectMcpConnection, resetMcpConnection, stopMcpConnection } from '../mcp-connection-manager';
import {
  initializeUnityMcp,
  completeUnityMcpArgument,
  getUnityPrompt,
  listUnityPrompts,
  listUnityResourceTemplates,
  listUnityResources,
  listUnityTools,
  readUnityResource
} from '../unity-mcp-client';
import { executeUnityTool } from '../game-tool-layer';
import { requireSafeToolInvocation } from './helpers';
import { listMcpRawAudits, listMcpToolSnapshots } from '../store';
import { sendRawMcpControlRequest } from '../mcp-raw-control';

function resolveMcpPlugin(ctx: HandlerContext, pluginId?: string): McpPlugin | undefined {
  if (!pluginId) {
    return undefined;
  }
  const plugin = ctx.getState().mcpPlugins.find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error('MCP plugin not found.');
  }
  return plugin;
}

function resolveMcpEndpoint(ctx: HandlerContext, pluginId?: string): McpPlugin | string {
  return resolveMcpPlugin(ctx, pluginId) ?? ctx.requirePluginBaseUrl();
}

function describeMcpHealthEndpoint(plugin: McpPlugin | string): string {
  if (typeof plugin === 'string') {
    return plugin;
  }
  return plugin.transport === 'stdio'
    ? `stdio://${plugin.name || plugin.id}`
    : plugin.baseUrl;
}

function formatMcpHealthError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return cause ? `${error.message}: ${cause}` : error.message;
}

function makeOfflineMcpHealthResult(plugin: McpPlugin | string, error: unknown): UnityHealthResult {
  return {
    status: 'offline',
    checkedAt: new Date().toISOString(),
    url: describeMcpHealthEndpoint(plugin),
    message: `MCP 连接失败：${formatMcpHealthError(error)}`
  };
}

function makeOnlineMcpHealthResult(plugin: McpPlugin, serverInfo: Awaited<ReturnType<typeof initializeUnityMcp>>): UnityHealthResult {
  return {
    status: 'online',
    checkedAt: new Date().toISOString(),
    url: describeMcpHealthEndpoint(plugin),
    message: `MCP 已连通：${serverInfo.name} ${serverInfo.version}。`
  };
}

async function checkMcpPluginHealth(plugin: McpPlugin | string): Promise<UnityHealthResult> {
  try {
    if (typeof plugin === 'string') {
      return checkUnityHealth(plugin, {
        bypassCache: true
      });
    }
    return makeOnlineMcpHealthResult(plugin, await initializeUnityMcp(plugin));
  } catch (error) {
    return makeOfflineMcpHealthResult(plugin, error);
  }
}

async function reconnectMcpPlugin(plugin: McpPlugin | string): Promise<UnityHealthResult> {
  try {
    if (typeof plugin === 'string') {
      return reconnectUnityHealth(plugin);
    }
    const serverInfo = plugin.transport === 'http'
      ? await reconnectMcpConnection(plugin.baseUrl)
      : await reconnectMcpConnection(plugin);
    return {
      status: 'online',
      checkedAt: new Date().toISOString(),
      url: describeMcpHealthEndpoint(plugin),
      message: `MCP 已重新连接：${serverInfo.name} ${serverInfo.version}。`
    };
  } catch (error) {
    return makeOfflineMcpHealthResult(plugin, error);
  }
}

function hasMcpLaunchConfigChanged(before: McpPlugin, after: McpPlugin): boolean {
  return before.transport !== after.transport ||
    before.baseUrl !== after.baseUrl ||
    before.command !== after.command ||
    JSON.stringify(before.args ?? []) !== JSON.stringify(after.args ?? []) ||
    before.cwd !== after.cwd ||
    JSON.stringify(before.env ?? {}) !== JSON.stringify(after.env ?? {});
}

export function registerMcpHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('mcp:createPlugin', async (_, input: unknown) => {
    const state = ctx.getState();
    const plugin = createMcpPlugin(state, validateIpcInput(mcpPluginInputSchema, input, 'mcp:createPlugin'));
    await ctx.setState({ ...state });
    return plugin;
  });

  ipcMain.handle('mcp:updatePlugin', async (_, pluginId: unknown, input: unknown) => {
    const state = ctx.getState();
    const validatedPluginId = validateIpcInput(pluginIdSchema, pluginId, 'mcp:updatePlugin(pluginId)');
    const before = state.mcpPlugins.find((item) => item.id === validatedPluginId);
    const plugin = updateMcpPlugin(
      state,
      validatedPluginId,
      validateIpcInput(mcpPluginInputSchema, input, 'mcp:updatePlugin(input)')
    );
    if (before && hasMcpLaunchConfigChanged(before, plugin)) {
      resetMcpConnection(before);
    }
    await ctx.setState({ ...state });
    return plugin;
  });

  ipcMain.handle('mcp:deletePlugin', async (_, pluginId: unknown) => {
    const state = ctx.getState();
    const validatedPluginId = validateIpcInput(pluginIdSchema, pluginId, 'mcp:deletePlugin');
    const plugin = state.mcpPlugins.find((item) => item.id === validatedPluginId);
    if (plugin) {
      resetMcpConnection(plugin);
    }
    deleteMcpPlugin(state, validatedPluginId);
    await ctx.setState({ ...state });
    return { success: true as const };
  });

  ipcMain.handle('mcp:setActivePlugin', async (_, pluginId: unknown) => {
    const state = ctx.getState();
    const mcpSettings = setActiveMcpPlugin(state, validateIpcInput(pluginIdSchema, pluginId, 'mcp:setActivePlugin'));
    await ctx.setState({ ...state });
    return mcpSettings;
  });

  ipcMain.handle('mcp:checkHealth', async (_, pluginId?: unknown) => {
    return checkMcpPluginHealth(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:checkHealth(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:getConnectionStatus', async (_, pluginId?: unknown) => {
    return getMcpConnectionSnapshot(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:getConnectionStatus(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:reconnect', async (_, pluginId?: unknown) => {
    return reconnectMcpPlugin(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:reconnect(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:stop', async (_, pluginId?: unknown) => {
    return stopMcpConnection(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:stop(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:getServerInfo', async (_, pluginId?: unknown) => {
    return initializeUnityMcp(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:getServerInfo(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:listToolSnapshots', async (_, pluginId?: unknown) => {
    return listMcpToolSnapshots(pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listToolSnapshots(pluginId)') : undefined);
  });

  ipcMain.handle('mcp:listRawAudits', async (_, pluginId?: unknown) => {
    return listMcpRawAudits(pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listRawAudits(pluginId)') : undefined);
  });

  ipcMain.handle('mcp:sendRawRequest', async (_, pluginId: unknown, method: unknown, params?: unknown) => {
    const plugin = resolveMcpPlugin(ctx, validateIpcInput(pluginIdSchema, pluginId, 'mcp:sendRawRequest(pluginId)'));
    if (!plugin) {
      throw new Error('MCP plugin not found.');
    }
    return sendRawMcpControlRequest(
      plugin,
      validateIpcInput(toolNameSchema, method, 'mcp:sendRawRequest(method)'),
      validateIpcInput(toolArgsSchema, params ?? {}, 'mcp:sendRawRequest(params)')
    );
  });

  ipcMain.handle('mcp:listTools', async (_, pluginId?: unknown) => {
    return listUnityTools(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listTools(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:callTool', async (_, toolName: unknown, args?: unknown, pluginId?: unknown) => {
    const validatedToolName = validateIpcInput(toolNameSchema, toolName, 'mcp:callTool(toolName)');
    const validatedArgs = requireSafeToolInvocation(validatedToolName, validateIpcInput(toolArgsSchema, args ?? {}, 'mcp:callTool(args)'));
    return executeUnityTool(
      resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:callTool(pluginId)') : undefined),
      validatedToolName,
      validatedArgs
    );
  });

  ipcMain.handle('mcp:listResources', async (_, pluginId?: unknown) => {
    return listUnityResources(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listResources(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:readResource', async (_, uri: unknown, pluginId?: unknown) => {
    return readUnityResource(
      resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:readResource(pluginId)') : undefined),
      validateIpcInput(resourceUriSchema, uri, 'mcp:readResource(uri)')
    );
  });

  ipcMain.handle('mcp:listPrompts', async (_, pluginId?: unknown) => {
    return listUnityPrompts(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listPrompts(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:getPrompt', async (_, name: unknown, args?: unknown, pluginId?: unknown) => {
    return getUnityPrompt(
      resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:getPrompt(pluginId)') : undefined),
      validateIpcInput(mcpPromptNameSchema, name, 'mcp:getPrompt(name)'),
      validateIpcInput(mcpPromptArgsSchema, args ?? {}, 'mcp:getPrompt(args)')
    );
  });

  ipcMain.handle('mcp:listResourceTemplates', async (_, pluginId?: unknown) => {
    return listUnityResourceTemplates(resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:listResourceTemplates(pluginId)') : undefined));
  });

  ipcMain.handle('mcp:completeArgument', async (_, ref: unknown, argumentName: unknown, value: unknown, context?: unknown, pluginId?: unknown) => {
    return completeUnityMcpArgument(
      resolveMcpEndpoint(ctx, pluginId ? validateIpcInput(pluginIdSchema, pluginId, 'mcp:completeArgument(pluginId)') : undefined),
      validateIpcInput(mcpCompletionRefSchema, ref, 'mcp:completeArgument(ref)'),
      validateIpcInput(mcpPromptNameSchema, argumentName, 'mcp:completeArgument(argumentName)'),
      validateIpcInput(mcpCompletionValueSchema, value, 'mcp:completeArgument(value)'),
      validateIpcInput(mcpCompletionContextSchema, context ?? {}, 'mcp:completeArgument(context)')
    );
  });
}
