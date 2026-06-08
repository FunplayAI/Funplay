import type { AppState, McpPlugin, McpPluginBindings, McpPluginInput, McpPluginKind, McpSettings, Project } from '../../shared/types';
import { makeId, nowIso } from '../../shared/utils';
import { DEFAULT_COCOS_MCP_BASE_URL } from './agent-platform/cocos-adapter';

const DEFAULT_UNITY_MCP_BASE_URL = 'http://127.0.0.1:8765/';

function isUnityEnginePlugin(plugin: McpPlugin): boolean {
  return plugin.kind === 'engine' && /\bunity\b/i.test(`${plugin.name} ${plugin.notes ?? ''}`);
}

function isCocosEnginePlugin(plugin: McpPlugin): boolean {
  return plugin.kind === 'engine' && /\bcocos\b/i.test(`${plugin.name} ${plugin.notes ?? ''}`);
}

function normalizeProjectMcpServerIds(bindings: McpPluginBindings | undefined): string[] {
  const ids = [
    ...(bindings?.servers ?? []),
    bindings?.engine,
    bindings?.asset,
    bindings?.qa,
    bindings?.custom
  ].filter(Boolean) as string[];
  return [...new Set(ids)];
}

function canProjectUsePlugin(plugin: McpPlugin, projectId: string): boolean {
  return !plugin.projectId || plugin.projectId === projectId;
}

function normalizeEngineMcpProjectName(project: { name?: string; id?: string }): string {
  const name = project.name?.trim().replace(/\s+/g, ' ');
  return name || project.id || 'Untitled Project';
}

function buildEngineMcpPluginName(platform: 'unity' | 'cocos', project: { name?: string; id?: string }): string {
  return `${platform === 'cocos' ? 'Cocos' : 'Unity'} MCP - ${normalizeEngineMcpProjectName(project)}`;
}

function isEnginePluginForPlatform(plugin: McpPlugin, platform: 'unity' | 'cocos'): boolean {
  return platform === 'cocos' ? isCocosEnginePlugin(plugin) : isUnityEnginePlugin(plugin);
}

function isGlobalUnityEnginePlugin(plugin: McpPlugin): boolean {
  return !plugin.projectId && isUnityEnginePlugin(plugin);
}

function isGlobalCocosEnginePlugin(plugin: McpPlugin): boolean {
  return !plugin.projectId && isCocosEnginePlugin(plugin);
}

function buildBindingsFromServerIds(plugins: McpPlugin[], pluginIds: string[]): McpPluginBindings {
  const bindings: McpPluginBindings = {
    servers: pluginIds
  };
  for (const kind of ['engine', 'asset', 'qa', 'custom'] as const) {
    bindings[kind] = pluginIds.find((pluginId) => plugins.find((plugin) => plugin.id === pluginId)?.kind === kind);
  }
  return bindings;
}

export function createMcpPlugin(state: AppState, input: McpPluginInput): McpPlugin {
  const projectId = input.projectId?.trim() || undefined;
  if (projectId && !state.projects.some((project) => project.id === projectId)) {
    throw new Error('Project not found.');
  }

  const timestamp = nowIso();
  const plugin: McpPlugin = {
    id: makeId('mcp'),
    projectId,
    name: input.name.trim(),
    kind: input.kind,
    transport: input.transport,
    baseUrl: input.baseUrl.trim(),
    command: input.command?.trim() || undefined,
    args: input.args?.filter((arg) => arg.trim().length > 0),
    cwd: input.cwd?.trim() || undefined,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
    defaultToolPermission: input.defaultToolPermission,
    defaultToolRisk: input.defaultToolRisk,
    toolPolicies: input.toolPolicies && Object.keys(input.toolPolicies).length > 0 ? input.toolPolicies : undefined,
    enabled: input.enabled ?? true,
    isDefault: false,
    notes: input.notes?.trim() ?? '',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  state.mcpPlugins = [plugin, ...state.mcpPlugins];

  return plugin;
}

export function updateMcpPlugin(state: AppState, pluginId: string, input: McpPluginInput): McpPlugin {
  const index = state.mcpPlugins.findIndex((plugin) => plugin.id === pluginId);
  if (index === -1) {
    throw new Error('MCP plugin not found.');
  }

  const current = state.mcpPlugins[index];
  const updated: McpPlugin = {
    ...current,
    projectId: current.projectId,
    name: input.name.trim(),
    kind: input.kind,
    transport: input.transport,
    baseUrl: input.baseUrl.trim(),
    command: input.command?.trim() || undefined,
    args: input.args?.filter((arg) => arg.trim().length > 0),
    cwd: input.cwd?.trim() || undefined,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
    defaultToolPermission: input.defaultToolPermission,
    defaultToolRisk: input.defaultToolRisk,
    toolPolicies: input.toolPolicies && Object.keys(input.toolPolicies).length > 0 ? input.toolPolicies : undefined,
    enabled: input.enabled ?? current.enabled,
    isDefault: false,
    notes: input.notes?.trim() ?? '',
    updatedAt: nowIso()
  };

  state.mcpPlugins[index] = updated;
  return updated;
}

export function deleteMcpPlugin(state: AppState, pluginId: string): void {
  const target = state.mcpPlugins.find((plugin) => plugin.id === pluginId);
  if (!target) {
    throw new Error('MCP plugin not found.');
  }

  state.mcpPlugins = state.mcpPlugins.filter((plugin) => plugin.id !== pluginId);

  state.projects = state.projects.map((project) =>
    (normalizeProjectMcpServerIds(project.mcpBindings).includes(pluginId) || (target.kind === 'engine' && project.mcpPluginId === pluginId))
      ? {
          ...project,
          mcpPluginId: target.kind === 'engine' ? undefined : project.mcpPluginId,
          mcpBindings: buildBindingsFromServerIds(
            state.mcpPlugins,
            normalizeProjectMcpServerIds(project.mcpBindings).filter((id) => id !== pluginId)
          )
        }
      : project
  );
}

export function setActiveMcpPlugin(state: AppState, pluginId: string): McpSettings {
  const target = state.mcpPlugins.find((plugin) => plugin.id === pluginId);
  if (!target) {
    throw new Error('MCP plugin not found.');
  }

  return state.mcpSettings;
}

export function getActiveEnginePlugin(state: AppState): McpPlugin | undefined {
  return getActivePluginByKind(state, 'engine');
}

export function getActivePluginByKind(_state: AppState, _kind: McpPluginKind): McpPlugin | undefined {
  return undefined;
}

export function ensureUnityMcpPlugin(state: AppState): McpPlugin {
  const baseUrl = state.settings.baseUrl?.trim() || DEFAULT_UNITY_MCP_BASE_URL;
  const timestamp = nowIso();
  const existingIndex = state.mcpPlugins.findIndex(isGlobalUnityEnginePlugin);
  if (existingIndex >= 0) {
    const current = state.mcpPlugins[existingIndex];
    const updated: McpPlugin = {
      ...current,
      baseUrl: current.baseUrl?.trim() || baseUrl,
      enabled: true,
      updatedAt: current.enabled && current.baseUrl?.trim() ? current.updatedAt : timestamp
    };
    state.mcpPlugins[existingIndex] = updated;
    return updated;
  }

  const plugin: McpPlugin = {
    id: makeId('mcp'),
    name: 'Unity MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl,
    enabled: true,
    isDefault: false,
    notes: 'Funplay built-in Unity MCP bridge.',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.mcpPlugins = [plugin, ...state.mcpPlugins];
  return plugin;
}

function bindEnginePlugin(project: { mcpPluginId?: string; mcpBindings?: McpPluginBindings }, plugin: McpPlugin): McpPlugin {
  project.mcpPluginId = plugin.id;
  project.mcpBindings = {
    ...(project.mcpBindings ?? {}),
    servers: [...new Set([...(project.mcpBindings?.servers ?? []), plugin.id])],
    engine: plugin.id
  };
  return plugin;
}

export function ensureCocosMcpPlugin(state: AppState): McpPlugin {
  const timestamp = nowIso();
  const existingIndex = state.mcpPlugins.findIndex(isGlobalCocosEnginePlugin);
  if (existingIndex >= 0) {
    const current = state.mcpPlugins[existingIndex];
    const updated: McpPlugin = {
      ...current,
      baseUrl: current.baseUrl?.trim() || DEFAULT_COCOS_MCP_BASE_URL,
      enabled: true,
      updatedAt: current.enabled && current.baseUrl?.trim() ? current.updatedAt : timestamp
    };
    state.mcpPlugins[existingIndex] = updated;
    return updated;
  }

  const plugin: McpPlugin = {
    id: makeId('mcp'),
    name: 'Funplay Cocos MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl: DEFAULT_COCOS_MCP_BASE_URL,
    enabled: true,
    isDefault: false,
    notes: 'Funplay built-in Cocos Creator MCP bridge. Install from https://github.com/FunplayAI/funplay-cocos-mcp.',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.mcpPlugins = [plugin, ...state.mcpPlugins];
  return plugin;
}

function findProjectEngineMcpPlugin(
  state: AppState,
  project: { id?: string },
  platform: 'unity' | 'cocos'
): McpPlugin | undefined {
  if (!project.id) {
    return undefined;
  }
  return state.mcpPlugins.find((plugin) =>
    plugin.projectId === project.id &&
    plugin.kind === 'engine' &&
    isEnginePluginForPlatform(plugin, platform)
  );
}

function upsertProjectEngineMcpPlugin(
  state: AppState,
  project: { id?: string; name?: string },
  platform: 'unity' | 'cocos'
): McpPlugin {
  if (!project.id) {
    return platform === 'cocos' ? ensureCocosMcpPlugin(state) : ensureUnityMcpPlugin(state);
  }

  const baseUrl = platform === 'cocos'
    ? DEFAULT_COCOS_MCP_BASE_URL
    : state.settings.baseUrl?.trim() || DEFAULT_UNITY_MCP_BASE_URL;
  const name = buildEngineMcpPluginName(platform, project);
  const notes = platform === 'cocos'
    ? 'Funplay built-in Cocos Creator MCP bridge. Install from https://github.com/FunplayAI/funplay-cocos-mcp.'
    : 'Funplay built-in Unity MCP bridge.';
  const timestamp = nowIso();
  const existingIndex = state.mcpPlugins.findIndex((plugin) =>
    plugin.projectId === project.id &&
    plugin.kind === 'engine' &&
    isEnginePluginForPlatform(plugin, platform)
  );
  if (existingIndex >= 0) {
    const current = state.mcpPlugins[existingIndex];
    const updated: McpPlugin = {
      ...current,
      name,
      baseUrl: current.baseUrl?.trim() || baseUrl,
      enabled: true,
      notes: current.notes?.trim() || notes,
      updatedAt: current.name === name && current.enabled && current.baseUrl?.trim() ? current.updatedAt : timestamp
    };
    state.mcpPlugins[existingIndex] = updated;
    return updated;
  }

  const plugin: McpPlugin = {
    id: makeId('mcp'),
    projectId: project.id,
    name,
    kind: 'engine',
    transport: 'http',
    baseUrl,
    enabled: true,
    isDefault: false,
    notes,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.mcpPlugins = [plugin, ...state.mcpPlugins];
  return plugin;
}

export function ensureEngineProjectMcpBinding(state: AppState, project: { id?: string; name?: string; engine?: { platform?: string }; mcpPluginId?: string; mcpBindings?: McpPluginBindings }): McpPlugin | undefined {
  if (project.engine?.platform !== 'unity' && project.engine?.platform !== 'cocos') {
    return undefined;
  }
  const platform = project.engine.platform;
  const projectPlugin = findProjectEngineMcpPlugin(state, project, platform);
  if (projectPlugin) {
    return bindEnginePlugin(project, upsertProjectEngineMcpPlugin(state, project, platform));
  }

  const boundPlugin = resolveProjectPluginByKind(state, project.mcpBindings, 'engine');
  if (
    boundPlugin &&
    boundPlugin.projectId === project.id &&
    isEnginePluginForPlatform(boundPlugin, platform)
  ) {
    return bindEnginePlugin(project, upsertProjectEngineMcpPlugin(state, project, platform));
  }

  const plugin = upsertProjectEngineMcpPlugin(state, project, platform);
  return bindEnginePlugin(project, plugin);
}

export function ensureUnityProjectMcpBinding(state: AppState, project: { id?: string; name?: string; engine?: { platform?: string }; mcpPluginId?: string; mcpBindings?: McpPluginBindings }): McpPlugin | undefined {
  if (project.engine?.platform !== 'unity') {
    return undefined;
  }
  return ensureEngineProjectMcpBinding(state, project);
}

export function resolveProjectPlugins(state: AppState, project: { id: string; mcpBindings?: McpPluginBindings }): McpPlugin[] {
  const ids = normalizeProjectMcpServerIds(project.mcpBindings);
  return ids
    .map((pluginId) => state.mcpPlugins.find((plugin) => plugin.id === pluginId && plugin.enabled && canProjectUsePlugin(plugin, project.id)))
    .filter(Boolean) as McpPlugin[];
}

export function listProjectAvailableMcpPlugins(state: AppState, projectId: string): McpPlugin[] {
  return state.mcpPlugins.filter((plugin) => canProjectUsePlugin(plugin, projectId));
}

export function updateProjectMcpServers(state: AppState, projectId: string, pluginIds: string[]): Project {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const current = state.projects[index];
  const available = listProjectAvailableMcpPlugins(state, projectId);
  const normalized = [...new Set(pluginIds)].filter((pluginId) => available.some((plugin) => plugin.id === pluginId));
  const bindings = buildBindingsFromServerIds(available, normalized);
  const updatedAt = nowIso();
  const updated: Project = {
    ...current,
    mcpPluginId: bindings.engine,
    mcpBindings: bindings,
    updatedAt,
    activity: [
      {
        id: makeId('act'),
        kind: 'planning' as const,
        title: '项目 MCP 服务器已更新',
        detail: normalized.length ? `已启用 ${normalized.length} 个 MCP 服务器。` : '已停用项目 MCP 服务器。',
        createdAt: updatedAt
      },
      ...current.activity
    ]
  };

  state.projects[index] = updated;
  return updated;
}

export function resolveProjectPluginByKind(
  state: AppState,
  bindings: McpPluginBindings | undefined,
  kind: McpPluginKind,
  projectId?: string
): McpPlugin | undefined {
  const directId = bindings?.[kind];
  const direct = directId
    ? state.mcpPlugins.find((plugin) =>
        plugin.id === directId &&
        plugin.kind === kind &&
        plugin.enabled &&
        (!projectId || canProjectUsePlugin(plugin, projectId))
      )
    : undefined;
  if (direct) {
    return direct;
  }

  return normalizeProjectMcpServerIds(bindings)
    .map((pluginId) => state.mcpPlugins.find((plugin) =>
      plugin.id === pluginId &&
      plugin.kind === kind &&
      plugin.enabled &&
      (!projectId || canProjectUsePlugin(plugin, projectId))
    ))
    .find(Boolean);
}
