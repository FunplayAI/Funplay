import Database from 'better-sqlite3';
import type {
  AiProvider,
  AiProviderMeta,
  AiProviderModel,
  AiProviderRoleModels,
  ChatMessage,
  GameAgentRun,
  McpPlugin,
  Project,
  ProjectSession
} from '../../../shared/types';
import { getProviderPresetDefaults, normalizeProviderAuthStyle } from '../../../shared/provider-catalog';
import { ensureProjectSessions } from '../../../shared/project-sessions';
import { deriveProjectContextSummary, deriveProjectMemory } from '../game-context-manager';
import {
  normalizeProviderChunkTimeoutMs,
  normalizeProviderContextWindowTokens,
  normalizeProviderMaxOutputTokens,
  normalizeProviderRequestTimeoutMs
} from '../provider-runtime-options';
import { parseJson } from './json';
import type {
  AgentRunRow,
  McpPluginStructuredRow,
  MessageRow,
  ProjectStructuredRow,
  ProviderStructuredRow,
  SessionRow
} from './row-types';

function normalizeProviderRoleModels(input?: AiProviderRoleModels | null): AiProviderRoleModels | undefined {
  if (!input) {
    return undefined;
  }

  const normalized: AiProviderRoleModels = {};
  for (const key of ['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus'] as const) {
    const value = input[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseProviderRoleModels(raw: string | null): AiProviderRoleModels | undefined {
  return normalizeProviderRoleModels(parseJson<AiProviderRoleModels>(raw, {}));
}

function normalizeStringRecord(input?: Record<string, string> | null): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : ''])
      .filter(([key, value]) => key && value)
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderModels(input?: AiProviderModel[] | null): AiProviderModel[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input
    .map((model) => ({
      ...model,
      modelId: model.modelId?.trim(),
      upstreamModelId: model.upstreamModelId?.trim() || undefined,
      displayName: model.displayName?.trim() || undefined
    }))
    .filter((model) => model.modelId);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderMeta(input?: AiProviderMeta | null): AiProviderMeta | undefined {
  if (!input) {
    return undefined;
  }
  const normalized: AiProviderMeta = {
    apiKeyUrl: input.apiKeyUrl?.trim() || undefined,
    docsUrl: input.docsUrl?.trim() || undefined,
    pricingUrl: input.pricingUrl?.trim() || undefined,
    statusPageUrl: input.statusPageUrl?.trim() || undefined,
    billingModel: input.billingModel,
    notes: input.notes?.filter(Boolean)
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

export function serializeProviderRecord(provider: AiProvider): ProviderStructuredRow {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    api_mode: provider.apiMode ?? null,
    auth_style: provider.authStyle ?? null,
    base_url: provider.baseUrl,
    model: provider.model,
    upstream_model: provider.upstreamModel ?? null,
    headers_json: JSON.stringify(normalizeStringRecord(provider.headers) ?? {}),
    env_overrides_json: JSON.stringify(normalizeStringRecord(provider.envOverrides) ?? {}),
    claude_code_compatible: provider.protocol === 'anthropic' ? 1 : 0,
    claude_role_models_json: JSON.stringify(normalizeProviderRoleModels(provider.claudeRoleModels) ?? {}),
    available_models_json: JSON.stringify(normalizeProviderModels(provider.availableModels) ?? []),
    sdk_proxy_only: provider.sdkProxyOnly ? 1 : 0,
    provider_meta_json: JSON.stringify(normalizeProviderMeta(provider.providerMeta) ?? {}),
    context_window_tokens: normalizeProviderContextWindowTokens(provider.contextWindowTokens) ?? null,
    max_output_tokens: normalizeProviderMaxOutputTokens(provider.maxOutputTokens) ?? null,
    request_timeout_ms: provider.requestTimeoutMs === false ? null : provider.requestTimeoutMs ?? null,
    request_timeout_disabled: provider.requestTimeoutMs === false ? 1 : 0,
    chunk_timeout_ms: provider.chunkTimeoutMs ?? null,
    enabled: provider.enabled ? 1 : 0,
    is_default: provider.isDefault ? 1 : 0,
    notes: provider.notes ?? null,
    created_at: provider.createdAt,
    updated_at: provider.updatedAt
  };
}

function hydrateProviderFromStructuredRow(row: ProviderStructuredRow): AiProvider {
  const baseProvider = {
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url
  };
  const defaults = getProviderPresetDefaults(baseProvider);
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    apiMode: row.api_mode ?? undefined,
    authStyle: row.auth_style ?? defaults.authStyle ?? normalizeProviderAuthStyle({ protocol: row.protocol }),
    baseUrl: row.base_url,
    apiKey: '',
    hasStoredApiKey: false,
    model: row.model,
    upstreamModel: row.upstream_model ?? defaults.upstreamModel,
    headers: normalizeStringRecord(parseJson<Record<string, string>>(row.headers_json, {})) ?? defaults.headers,
    envOverrides: normalizeStringRecord(parseJson<Record<string, string>>(row.env_overrides_json, {})) ?? defaults.envOverrides,
    claudeCodeCompatible: row.protocol === 'anthropic',
    claudeRoleModels: parseProviderRoleModels(row.claude_role_models_json) ?? defaults.roleModels,
    availableModels: normalizeProviderModels(parseJson<AiProviderModel[]>(row.available_models_json, [])) ?? defaults.availableModels,
    sdkProxyOnly: row.sdk_proxy_only === 1 || defaults.sdkProxyOnly,
    providerMeta: normalizeProviderMeta(parseJson<AiProviderMeta>(row.provider_meta_json, {})) ?? defaults.providerMeta,
    contextWindowTokens: normalizeProviderContextWindowTokens(row.context_window_tokens ?? undefined),
    maxOutputTokens: normalizeProviderMaxOutputTokens(row.max_output_tokens ?? undefined),
    requestTimeoutMs: row.request_timeout_disabled === 1 ? false : normalizeProviderRequestTimeoutMs(row.request_timeout_ms ?? undefined),
    chunkTimeoutMs: normalizeProviderChunkTimeoutMs(row.chunk_timeout_ms ?? undefined),
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function serializeMcpPluginRecord(plugin: McpPlugin): McpPluginStructuredRow {
  return {
    id: plugin.id,
    project_id: plugin.projectId ?? null,
    name: plugin.name,
    kind: plugin.kind,
    transport: plugin.transport,
    base_url: plugin.baseUrl,
    command: plugin.command?.trim() || null,
    args_json: plugin.args?.length ? JSON.stringify(plugin.args) : null,
    cwd: plugin.cwd?.trim() || null,
    env_json: plugin.env && Object.keys(plugin.env).length > 0 ? JSON.stringify(plugin.env) : null,
    default_tool_permission: plugin.defaultToolPermission ?? null,
    default_tool_risk: plugin.defaultToolRisk ?? null,
    tool_policies_json: JSON.stringify(plugin.toolPolicies ?? {}),
    enabled: plugin.enabled ? 1 : 0,
    is_default: plugin.isDefault ? 1 : 0,
    notes: plugin.notes ?? null,
    created_at: plugin.createdAt,
    updated_at: plugin.updatedAt
  };
}

function hydrateMcpPluginFromStructuredRow(row: McpPluginStructuredRow): McpPlugin {
  const args = row.args_json ? parseJson<string[]>(row.args_json, []) : [];
  const env = row.env_json ? parseJson<Record<string, string>>(row.env_json, {}) : {};
  const toolPolicies = row.tool_policies_json ? parseJson<McpPlugin['toolPolicies']>(row.tool_policies_json, {}) : {};
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    name: row.name,
    kind: row.kind,
    transport: row.transport,
    baseUrl: row.base_url,
    command: row.command ?? undefined,
    args: args.length ? args : undefined,
    cwd: row.cwd ?? undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    defaultToolPermission: row.default_tool_permission ?? undefined,
    defaultToolRisk: row.default_tool_risk ?? undefined,
    toolPolicies: toolPolicies && Object.keys(toolPolicies).length > 0 ? toolPolicies : undefined,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function serializeProjectRecord(project: Project): ProjectStructuredRow {
  return {
    id: project.id,
    name: project.name,
    template_id: project.templateId,
    art_style: project.artStyle,
    pitch: project.pitch,
    status: project.status,
    engine_json: project.engine ? JSON.stringify(project.engine) : null,
    runtime_state_json: project.runtimeState ? JSON.stringify(project.runtimeState) : null,
    agent_policy_json: project.agentPolicy ? JSON.stringify(project.agentPolicy) : null,
    provider_id: project.providerId ?? null,
    model: project.model ?? null,
    mcp_plugin_id: project.mcpPluginId ?? null,
    mcp_bindings_json: JSON.stringify(project.mcpBindings ?? {}),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    blueprint_json: JSON.stringify(project.blueprint),
    tasks_json: JSON.stringify(project.tasks),
    assets_json: JSON.stringify(project.assets),
    asset_generation_jobs_json: JSON.stringify(project.assetGenerationJobs ?? []),
    asset_generation_presets_json: JSON.stringify(project.assetGenerationPresets ?? []),
    activity_json: JSON.stringify(project.activity),
    snapshots_json: JSON.stringify(project.snapshots),
    memory_json: JSON.stringify(project.memory),
    context_summary_json: JSON.stringify(project.contextSummary),
    current_execution_plan_json: project.currentExecutionPlan ? JSON.stringify(project.currentExecutionPlan) : null,
    last_executed_plan_json: project.lastExecutedPlan ? JSON.stringify(project.lastExecutedPlan) : null
  };
}

function hydrateProjectFromStructuredRow(row: ProjectStructuredRow): Project {
  return {
    id: row.id,
    name: row.name,
    templateId: row.template_id as Project['templateId'],
    artStyle: row.art_style,
    pitch: row.pitch,
    status: row.status,
    engine: row.engine_json ? parseJson(row.engine_json, undefined) : undefined,
    runtimeState: row.runtime_state_json ? parseJson(row.runtime_state_json, undefined) : undefined,
    agentPolicy: row.agent_policy_json ? parseJson(row.agent_policy_json, undefined) : undefined,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    mcpPluginId: row.mcp_plugin_id ?? undefined,
    mcpBindings: parseJson(row.mcp_bindings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blueprint: parseJson(row.blueprint_json, {
      premise: '',
      playerFantasy: '',
      targetAudience: '',
      artDirection: '',
      coreLoop: [],
      pillars: [],
      differentiators: []
    }),
    tasks: parseJson(row.tasks_json, []),
    assets: parseJson(row.assets_json, []),
    assetGenerationJobs: parseJson(row.asset_generation_jobs_json, []),
    assetGenerationPresets: parseJson(row.asset_generation_presets_json, []),
    sessions: [],
    activeSessionId: undefined,
    chat: [],
    activity: parseJson(row.activity_json, []),
    snapshots: parseJson(row.snapshots_json, []),
    memory: parseJson(row.memory_json, {
      designDirectives: [],
      artDirectives: [],
      technicalConstraints: [],
      openQuestions: [],
      updatedAt: row.updated_at
    }),
    contextSummary: parseJson(row.context_summary_json, {
      projectBrief: '',
      currentGoal: '',
      recentDecisions: [],
      activeTasks: [],
      recentActivity: [],
      compressedFrom: 0,
      updatedAt: row.updated_at
    }),
    currentExecutionPlan: row.current_execution_plan_json ? parseJson(row.current_execution_plan_json, undefined) : undefined,
    lastExecutedPlan: row.last_executed_plan_json ? parseJson(row.last_executed_plan_json, undefined) : undefined
  };
}

export function hydrateProjectSessionsFromRows(project: Project, sessionRows: SessionRow[], messageRows: MessageRow[]): Project {
  if (sessionRows.length === 0) {
    return project;
  }

  const sortedMessages = [...messageRows].sort((left, right) => {
    if (left.session_id === right.session_id) {
      return left.sort_order - right.sort_order;
    }
    return left.session_id.localeCompare(right.session_id);
  });

  const messagesBySession = new Map<string, ChatMessage[]>();
  for (const row of sortedMessages) {
    const next = messagesBySession.get(row.session_id) ?? [];
    next.push({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ordinal: row.sort_order,
      storageRowId: typeof row.storage_rowid === 'number' && Number.isFinite(row.storage_rowid)
        ? Math.floor(row.storage_rowid)
        : undefined,
      metadata: row.metadata_json ? parseJson(row.metadata_json, undefined) : undefined
    });
    messagesBySession.set(row.session_id, next);
  }

  const sessions: ProjectSession[] = sessionRows.map((row) => ({
    id: row.id,
    title: row.title,
    autoTitle: row.auto_title === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeOverrides: row.runtime_json ? parseJson(row.runtime_json, undefined) : undefined,
    chat: messagesBySession.get(row.id) ?? []
  }));

  const activeSessionId = sessionRows.find((row) => row.is_active === 1)?.id ?? sessions[0]?.id;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  return {
    ...project,
    sessions,
    activeSessionId,
    chat: [...(activeSession?.chat ?? [])]
  };
}

export function hydrateProjectRunFromRows(project: Project, runRows: AgentRunRow[]): Project {
  if (runRows.length === 0) {
    return project;
  }

  const latestRow = [...runRows].sort((left, right) => right.finished_at.localeCompare(left.finished_at))[0];
  const run: GameAgentRun = {
    id: latestRow.id,
    mode: latestRow.mode,
    input: latestRow.input,
    status: latestRow.status,
    usedProviderId: latestRow.used_provider_id ?? undefined,
    usedModel: latestRow.used_model ?? undefined,
    startedAt: latestRow.started_at,
    finishedAt: latestRow.finished_at,
    steps: parseJson(latestRow.steps_json, []),
    pluginReports: parseJson(latestRow.plugin_reports_json, []),
    executionPlan: latestRow.execution_plan_json ? parseJson(latestRow.execution_plan_json, undefined) : undefined,
    operationLog: latestRow.operation_log_json ? parseJson(latestRow.operation_log_json, []) : []
  };

  return {
    ...project,
    lastAgentRun: run
  };
}

export function hydrateProjects(projects: Project[]): Project[] {
  return projects.map((project) => {
    const enrichedProject = ensureProjectSessions({
      ...project,
      providerId: undefined,
      model: undefined,
      mcpBindings: project.mcpBindings ?? (project.mcpPluginId ? { engine: project.mcpPluginId } : {}),
      memory: project.memory ?? {
        designDirectives: [],
        artDirectives: [],
        technicalConstraints: [],
        openQuestions: [],
        updatedAt: project.updatedAt
      },
      contextSummary: project.contextSummary ?? {
        projectBrief: '',
        currentGoal: '',
        recentDecisions: [],
        activeTasks: [],
        recentActivity: [],
        compressedFrom: 0,
        updatedAt: project.updatedAt
      }
    });

    return {
      ...enrichedProject,
      memory:
        enrichedProject.memory.designDirectives.length > 0
          ? enrichedProject.memory
          : deriveProjectMemory(enrichedProject),
      contextSummary:
        enrichedProject.contextSummary.projectBrief
          ? enrichedProject.contextSummary
          : deriveProjectContextSummary(enrichedProject)
    };
  });
}

export function readProjects(database: Database.Database): Project[] {
  return (database.prepare('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC').all() as ProjectStructuredRow[])
    .map((row) => hydrateProjectFromStructuredRow(row));
}

export function readProviders(database: Database.Database): AiProvider[] {
  return (database.prepare('SELECT * FROM providers ORDER BY updated_at DESC, created_at DESC').all() as ProviderStructuredRow[])
    .map((row) => hydrateProviderFromStructuredRow(row));
}

export function readMcpPlugins(database: Database.Database): McpPlugin[] {
  return (database.prepare('SELECT * FROM mcp_plugins ORDER BY updated_at DESC, created_at DESC').all() as McpPluginStructuredRow[])
    .map((row) => hydrateMcpPluginFromStructuredRow(row));
}
