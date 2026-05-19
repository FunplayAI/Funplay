import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import {
  mcpCompletionContextSchema,
  mcpCompletionRefSchema,
  mcpCompletionValueSchema,
  mcpPromptArgsSchema,
  mcpPromptNameSchema,
  resourceUriSchema,
  toolArgsSchema,
  toolNameSchema,
  validateIpcInput
} from '../ipc-validation';
import { checkUnityHealth, reconnectUnityHealth } from '../unity-bridge';
import { getMcpConnectionSnapshot } from '../mcp-connection-manager';
import {
  completeUnityMcpArgument,
  getUnityPrompt,
  initializeUnityMcp,
  listUnityPrompts,
  listUnityResourceTemplates,
  listUnityResources,
  listUnityTools,
  readUnityResource
} from '../unity-mcp-client';
import { executeUnityTool } from '../game-tool-layer';
import { patchSettings } from '../store';
import { requireSafeToolInvocation } from './helpers';

export function registerUnityHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('unity:checkHealth', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    const result = await checkUnityHealth(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:checkHealth(baseUrl)') : state.settings.baseUrl, {
      bypassCache: true
    });
    await patchSettings({
      baseUrl: result.url,
      lastCheckedAt: result.checkedAt,
      lastStatus: result.status,
      lastMessage: result.message
    });
    return result;
  });

  ipcMain.handle('unity:getConnectionStatus', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return getMcpConnectionSnapshot(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:getConnectionStatus(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:reconnect', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    const result = await reconnectUnityHealth(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:reconnect(baseUrl)') : state.settings.baseUrl);
    await patchSettings({
      baseUrl: result.url,
      lastCheckedAt: result.checkedAt,
      lastStatus: result.status,
      lastMessage: result.message
    });
    return result;
  });

  ipcMain.handle('unity:getServerInfo', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return initializeUnityMcp(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:getServerInfo(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:listTools', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return listUnityTools(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:listTools(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:callTool', async (_, toolName: unknown, args?: unknown, baseUrl?: unknown) => {
    const state = ctx.getState();
    const validatedToolName = validateIpcInput(toolNameSchema, toolName, 'unity:callTool(toolName)');
    const validatedArgs = requireSafeToolInvocation(validatedToolName, validateIpcInput(toolArgsSchema, args ?? {}, 'unity:callTool(args)'));
    return executeUnityTool(
      baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:callTool(baseUrl)') : state.settings.baseUrl,
      validatedToolName,
      validatedArgs
    );
  });

  ipcMain.handle('unity:listResources', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return listUnityResources(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:listResources(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:readResource', async (_, uri: unknown, baseUrl?: unknown) => {
    const state = ctx.getState();
    return readUnityResource(
      baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:readResource(baseUrl)') : state.settings.baseUrl,
      validateIpcInput(resourceUriSchema, uri, 'unity:readResource(uri)')
    );
  });

  ipcMain.handle('unity:listPrompts', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return listUnityPrompts(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:listPrompts(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:getPrompt', async (_, name: unknown, args?: unknown, baseUrl?: unknown) => {
    const state = ctx.getState();
    return getUnityPrompt(
      baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:getPrompt(baseUrl)') : state.settings.baseUrl,
      validateIpcInput(mcpPromptNameSchema, name, 'unity:getPrompt(name)'),
      validateIpcInput(mcpPromptArgsSchema, args ?? {}, 'unity:getPrompt(args)')
    );
  });

  ipcMain.handle('unity:listResourceTemplates', async (_, baseUrl?: unknown) => {
    const state = ctx.getState();
    return listUnityResourceTemplates(baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:listResourceTemplates(baseUrl)') : state.settings.baseUrl);
  });

  ipcMain.handle('unity:completeArgument', async (_, ref: unknown, argumentName: unknown, value: unknown, context?: unknown, baseUrl?: unknown) => {
    const state = ctx.getState();
    return completeUnityMcpArgument(
      baseUrl ? validateIpcInput(resourceUriSchema, baseUrl, 'unity:completeArgument(baseUrl)') : state.settings.baseUrl,
      validateIpcInput(mcpCompletionRefSchema, ref, 'unity:completeArgument(ref)'),
      validateIpcInput(mcpPromptNameSchema, argumentName, 'unity:completeArgument(argumentName)'),
      validateIpcInput(mcpCompletionValueSchema, value, 'unity:completeArgument(value)'),
      validateIpcInput(mcpCompletionContextSchema, context ?? {}, 'unity:completeArgument(context)')
    );
  });
}
