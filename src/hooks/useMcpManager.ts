import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  McpConnectionSnapshot,
  McpPlugin,
  McpPluginInput,
  McpRawAuditEntry,
  McpToolSnapshot,
  Project,
  UnityMcpPrompt,
  UnityMcpResource,
  UnityMcpResourceTemplate,
  UnityMcpServerInfo,
  UnityMcpTool
} from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { canProjectUseMcpPlugin, getProjectMcpServerIds } from '../lib/mcp-project-helpers';
import type { ProjectMcpBindingDraft } from '../lib/app-types';

export interface UseMcpManagerInput {
  selectedProject: Project | null;
  selectedProjectView: Project | null;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  retryRefreshProjectRuntimeState: (projectId: string, attempts?: number, delayMs?: number) => Promise<void>;
  language: UiLanguage;
}

// Owns the MCP/Unity plugin domain extracted from App.tsx: plugin list, the
// project<->plugin bindings, per-plugin connection/diagnostic metadata, the
// plugin editor modal, and all create/update/delete/connect handlers. App.tsx
// destructures the returned object so existing call sites keep their names.
export function useMcpManager(input: UseMcpManagerInput) {
  const { selectedProject, selectedProjectView, setProjects, retryRefreshProjectRuntimeState, language } = input;

  const [mcpPlugins, setMcpPlugins] = useState<McpPlugin[]>([]);
  const [unityServerInfo, setUnityServerInfo] = useState<UnityMcpServerInfo | null>(null);
  const [unityTools, setUnityTools] = useState<UnityMcpTool[]>([]);
  const [unityResources, setUnityResources] = useState<UnityMcpResource[]>([]);
  const [unityPrompts, setUnityPrompts] = useState<UnityMcpPrompt[]>([]);
  const [unityResourceTemplates, setUnityResourceTemplates] = useState<UnityMcpResourceTemplate[]>([]);
  const [mcpToolSnapshots, setMcpToolSnapshots] = useState<McpToolSnapshot[]>([]);
  const [mcpRawAudits, setMcpRawAudits] = useState<McpRawAuditEntry[]>([]);
  const [pluginError, setPluginError] = useState('');
  const [mcpConnectionStatuses, setMcpConnectionStatuses] = useState<Record<string, McpConnectionSnapshot>>({});
  const [projectBindings, setProjectBindings] = useState<ProjectMcpBindingDraft>([]);
  const [isRefreshingPlugin, setIsRefreshingPlugin] = useState(false);
  const [selectedMcpPluginId, setSelectedMcpPluginId] = useState('');
  const [editingPlugin, setEditingPlugin] = useState<McpPlugin | null>(null);
  const [showPluginModal, setShowPluginModal] = useState(false);
  const [mcpModalProjectId, setMcpModalProjectId] = useState<string | undefined>(undefined);

  const activeProjectMcpPlugins = mcpPlugins.filter(
    (plugin) =>
      projectBindings.includes(plugin.id) && plugin.enabled && canProjectUseMcpPlugin(selectedProjectView, plugin)
  );
  const activeEnginePlugin = activeProjectMcpPlugins.find((plugin) => plugin.kind === 'engine') ?? null;
  const selectedMcpPlugin = mcpPlugins.find((plugin) => plugin.id === selectedMcpPluginId) ?? null;
  const projectMcpSelectedPlugin = selectedMcpPlugin ?? activeProjectMcpPlugins[0] ?? null;
  const globalMcpPlugins = mcpPlugins.filter((plugin) => !plugin.projectId);
  const selectedGlobalMcpPlugin =
    selectedMcpPlugin && !selectedMcpPlugin.projectId ? selectedMcpPlugin : (globalMcpPlugins[0] ?? null);
  const projectMcpConnectionStatus = projectMcpSelectedPlugin
    ? (mcpConnectionStatuses[projectMcpSelectedPlugin.id] ?? null)
    : null;
  const globalMcpConnectionStatus = selectedGlobalMcpPlugin
    ? (mcpConnectionStatuses[selectedGlobalMcpPlugin.id] ?? null)
    : null;

  async function handleUpdateProjectMcpServers(pluginIds: string[]): Promise<void> {
    if (!selectedProject) {
      return;
    }

    const updated = await window.funplay.updateProjectMcpServers(selectedProject.id, pluginIds);
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
    setProjectBindings(getProjectMcpServerIds(updated));

    if (pluginIds.some((pluginId) => mcpPlugins.find((plugin) => plugin.id === pluginId)?.kind === 'engine')) {
      void retryRefreshProjectRuntimeState(selectedProject.id);
    }
  }

  async function handleToggleProjectMcpPlugin(pluginId: string, enabled: boolean): Promise<void> {
    setSelectedMcpPluginId(pluginId);
    const next = enabled
      ? [...new Set([...projectBindings, pluginId])]
      : projectBindings.filter((id) => id !== pluginId);
    await handleUpdateProjectMcpServers(next);
  }

  async function refreshMcpConnectionStatus(plugin: McpPlugin): Promise<McpConnectionSnapshot | null> {
    try {
      const status = await window.funplay.getMcpConnectionStatus(plugin.id);
      setMcpConnectionStatuses((current) => ({
        ...current,
        [plugin.id]: status
      }));
      return status;
    } catch {
      return null;
    }
  }

  function clearPluginMeta(): void {
    setUnityServerInfo(null);
    setUnityTools([]);
    setUnityResources([]);
    setUnityPrompts([]);
    setUnityResourceTemplates([]);
    setMcpToolSnapshots([]);
    setMcpRawAudits([]);
  }

  async function refreshMcpLocalDiagnostics(pluginId: string): Promise<void> {
    try {
      const [snapshots, rawAudits] = await Promise.all([
        window.funplay.listMcpToolSnapshots(pluginId),
        window.funplay.listMcpRawAudits(pluginId)
      ]);
      setMcpToolSnapshots(snapshots);
      setMcpRawAudits(rawAudits);
    } catch {
      setMcpToolSnapshots([]);
      setMcpRawAudits([]);
    }
  }

  async function loadMcpPluginMetadata(pluginId: string): Promise<void> {
    const serverInfo = await window.funplay.getMcpServerInfo(pluginId);
    const [tools, resources, prompts, resourceTemplates] = await Promise.all([
      window.funplay.listMcpTools(pluginId),
      window.funplay.listMcpResources(pluginId),
      window.funplay.listMcpPrompts(pluginId),
      window.funplay.listMcpResourceTemplates(pluginId)
    ]);
    setUnityServerInfo(serverInfo);
    setUnityTools(tools);
    setUnityResources(resources);
    setUnityPrompts(prompts);
    setUnityResourceTemplates(resourceTemplates);
  }

  async function handleRefreshPluginMeta(pluginOverride?: McpPlugin | null): Promise<void> {
    const targetPlugin = pluginOverride ?? selectedMcpPlugin ?? activeProjectMcpPlugins[0] ?? activeEnginePlugin;
    if (!targetPlugin) {
      return;
    }

    setIsRefreshingPlugin(true);
    setPluginError('');
    clearPluginMeta();
    try {
      await refreshMcpLocalDiagnostics(targetPlugin.id);
      const health = await window.funplay.checkMcpHealth(targetPlugin.id);
      await refreshMcpConnectionStatus(targetPlugin);
      if (health.status !== 'online') {
        setPluginError(health.message);
        return;
      }
      await loadMcpPluginMetadata(targetPlugin.id);
      await refreshMcpConnectionStatus(targetPlugin);
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : localize(language, '刷新失败', 'Refresh failed'));
      await refreshMcpConnectionStatus(targetPlugin);
    } finally {
      setIsRefreshingPlugin(false);
    }
  }

  async function handleReconnectMcpPlugin(pluginOverride?: McpPlugin | null): Promise<void> {
    const targetPlugin = pluginOverride ?? selectedMcpPlugin ?? activeProjectMcpPlugins[0] ?? activeEnginePlugin;
    if (!targetPlugin) {
      return;
    }

    setIsRefreshingPlugin(true);
    setPluginError('');
    clearPluginMeta();
    try {
      await refreshMcpLocalDiagnostics(targetPlugin.id);
      const health = await window.funplay.reconnectMcp(targetPlugin.id);
      await refreshMcpConnectionStatus(targetPlugin);
      if (health.status !== 'online') {
        setPluginError(health.message);
        return;
      }
      await loadMcpPluginMetadata(targetPlugin.id);
      await refreshMcpConnectionStatus(targetPlugin);
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : localize(language, '重启失败', 'Restart failed'));
      await refreshMcpConnectionStatus(targetPlugin);
    } finally {
      setIsRefreshingPlugin(false);
    }
  }

  async function handleStopMcpPlugin(pluginOverride?: McpPlugin | null): Promise<void> {
    const targetPlugin = pluginOverride ?? selectedMcpPlugin ?? activeProjectMcpPlugins[0] ?? activeEnginePlugin;
    if (!targetPlugin) {
      return;
    }

    setPluginError('');
    try {
      const status = await window.funplay.stopMcp(targetPlugin.id);
      setMcpConnectionStatuses((current) => ({
        ...current,
        [targetPlugin.id]: status
      }));
      clearPluginMeta();
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : localize(language, '停止失败', 'Stop failed'));
      await refreshMcpConnectionStatus(targetPlugin);
    }
  }

  async function handleSendRawMcpRequest(pluginId: string, method: string, params: Record<string, unknown>) {
    try {
      return await window.funplay.sendRawMcpRequest(pluginId, method, params);
    } finally {
      try {
        const audits = await window.funplay.listMcpRawAudits(pluginId);
        setMcpRawAudits(audits);
      } catch {
        setMcpRawAudits([]);
      }
    }
  }

  async function handleCreatePlugin(pluginInput: McpPluginInput): Promise<void> {
    const plugin = await window.funplay.createMcpPlugin(pluginInput);
    setMcpPlugins((current) => [plugin, ...current]);
    setSelectedMcpPluginId(plugin.id);
    if (pluginInput.projectId && selectedProject?.id === pluginInput.projectId) {
      const updated = await window.funplay.updateProjectMcpServers(pluginInput.projectId, [
        ...new Set([...projectBindings, plugin.id])
      ]);
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
      setProjectBindings(getProjectMcpServerIds(updated));
    }
    setShowPluginModal(false);
    setEditingPlugin(null);
    setMcpModalProjectId(undefined);
  }

  async function handleUpdatePlugin(pluginId: string, pluginInput: McpPluginInput): Promise<void> {
    const updated = await window.funplay.updateMcpPlugin(pluginId, pluginInput);
    setMcpPlugins((current) => current.map((plugin) => (plugin.id === updated.id ? updated : plugin)));
    setShowPluginModal(false);
    setEditingPlugin(null);
    setMcpModalProjectId(undefined);
  }

  async function handleToggleMcpPluginEnabled(plugin: McpPlugin, enabled: boolean): Promise<void> {
    const updated = await window.funplay.updateMcpPlugin(plugin.id, {
      projectId: plugin.projectId,
      name: plugin.name,
      kind: plugin.kind,
      transport: plugin.transport,
      baseUrl: plugin.baseUrl,
      command: plugin.command,
      args: plugin.args,
      cwd: plugin.cwd,
      env: plugin.env,
      defaultToolPermission: plugin.defaultToolPermission,
      defaultToolRisk: plugin.defaultToolRisk,
      toolPolicies: plugin.toolPolicies,
      enabled,
      notes: plugin.notes
    });
    setMcpPlugins((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    if (!enabled) {
      await handleStopMcpPlugin(updated);
    }
  }

  async function handleDeletePlugin(pluginId: string): Promise<void> {
    await window.funplay.deleteMcpPlugin(pluginId);
    setMcpPlugins((current) => current.filter((plugin) => plugin.id !== pluginId));
    setMcpConnectionStatuses((current) => {
      const next = { ...current };
      delete next[pluginId];
      return next;
    });
    setProjects((current) =>
      current.map((project) => ({
        ...project,
        mcpBindings: {
          ...project.mcpBindings,
          servers: project.mcpBindings.servers?.filter((id) => id !== pluginId),
          engine: project.mcpBindings.engine === pluginId ? undefined : project.mcpBindings.engine,
          asset: project.mcpBindings.asset === pluginId ? undefined : project.mcpBindings.asset,
          qa: project.mcpBindings.qa === pluginId ? undefined : project.mcpBindings.qa,
          custom: project.mcpBindings.custom === pluginId ? undefined : project.mcpBindings.custom
        }
      }))
    );
    setProjectBindings((current) => current.filter((id) => id !== pluginId));
  }

  // The project<->plugin binding sync was split out of App.tsx's combined
  // `[selectedProject]` effect (which also reset the skill draft). Same deps,
  // so the split is behavior-preserving; the skill half stays in App.tsx.
  useEffect(() => {
    if (!selectedProject) {
      setProjectBindings([]);
      return;
    }
    setProjectBindings(getProjectMcpServerIds(selectedProject));
  }, [selectedProject]);

  useEffect(() => {
    if (mcpPlugins.length === 0) {
      setSelectedMcpPluginId('');
      return;
    }

    if (selectedMcpPluginId && mcpPlugins.some((plugin) => plugin.id === selectedMcpPluginId)) {
      return;
    }

    const preferredPluginId =
      projectBindings[0] ||
      mcpPlugins.find((plugin) => canProjectUseMcpPlugin(selectedProject, plugin) && plugin.enabled)?.id ||
      mcpPlugins.find((plugin) => canProjectUseMcpPlugin(selectedProject, plugin))?.id ||
      '';

    setSelectedMcpPluginId(preferredPluginId);
  }, [mcpPlugins, selectedMcpPluginId, projectBindings, selectedProject]);

  useEffect(() => {
    setPluginError('');
    setUnityServerInfo(null);
    setUnityTools([]);
    setUnityResources([]);
    setUnityPrompts([]);
    setUnityResourceTemplates([]);
    setMcpToolSnapshots([]);
    setMcpRawAudits([]);
    if (!selectedMcpPluginId) {
      return;
    }

    let cancelled = false;
    window.funplay
      .listMcpRawAudits(selectedMcpPluginId)
      .then((audits) => {
        if (!cancelled) {
          setMcpRawAudits(audits);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMcpRawAudits([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMcpPluginId]);

  useEffect(() => {
    if (!projectMcpSelectedPlugin) {
      return;
    }
    void refreshMcpConnectionStatus(projectMcpSelectedPlugin);
  }, [projectMcpSelectedPlugin?.id]);

  useEffect(() => {
    if (!selectedGlobalMcpPlugin || selectedGlobalMcpPlugin.id === projectMcpSelectedPlugin?.id) {
      return;
    }
    void refreshMcpConnectionStatus(selectedGlobalMcpPlugin);
  }, [selectedGlobalMcpPlugin?.id, projectMcpSelectedPlugin?.id]);

  return {
    mcpPlugins,
    setMcpPlugins,
    unityServerInfo,
    unityTools,
    unityResources,
    unityPrompts,
    unityResourceTemplates,
    mcpToolSnapshots,
    mcpRawAudits,
    pluginError,
    mcpConnectionStatuses,
    projectBindings,
    isRefreshingPlugin,
    selectedMcpPluginId,
    setSelectedMcpPluginId,
    editingPlugin,
    setEditingPlugin,
    showPluginModal,
    setShowPluginModal,
    mcpModalProjectId,
    setMcpModalProjectId,
    activeProjectMcpPlugins,
    activeEnginePlugin,
    selectedMcpPlugin,
    projectMcpSelectedPlugin,
    globalMcpPlugins,
    selectedGlobalMcpPlugin,
    projectMcpConnectionStatus,
    globalMcpConnectionStatus,
    handleUpdateProjectMcpServers,
    handleToggleProjectMcpPlugin,
    refreshMcpConnectionStatus,
    refreshMcpLocalDiagnostics,
    loadMcpPluginMetadata,
    handleRefreshPluginMeta,
    handleReconnectMcpPlugin,
    handleStopMcpPlugin,
    handleSendRawMcpRequest,
    handleCreatePlugin,
    handleUpdatePlugin,
    handleToggleMcpPluginEnabled,
    handleDeletePlugin
  };
}
