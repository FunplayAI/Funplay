import type { AppState } from '../../../shared/types';
import { getAgentSettings } from '../store';
import { getActiveEnginePlugin } from '../mcp-plugin-service';

export function requirePluginBaseUrl(getState: () => AppState, pluginId?: string): string {
  const state = getState();
  const plugin = pluginId
    ? state.mcpPlugins.find((item) => item.id === pluginId)
    : getActiveEnginePlugin(state);

  if (!plugin?.baseUrl) {
    throw new Error('No active MCP plugin configured.');
  }

  return plugin.baseUrl;
}

export function requireSafeToolInvocation(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const permissionMode = getAgentSettings().permissionMode;

  if (toolName !== 'execute_code') {
    return args;
  }

  if (permissionMode === 'read-only') {
    throw new Error('Current permission mode is read-only, so execute_code is blocked.');
  }

  if (args.confirmedByUser !== true) {
    throw new Error('Direct execute_code calls require args.confirmedByUser=true.');
  }

  const { confirmedByUser: _confirmedByUser, ...rest } = args;
  return rest;
}
