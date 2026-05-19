import Database from 'better-sqlite3';
import type { AiProvider, AppState, Project } from '../../../shared/types';
import { ensureProjectSessions } from '../../../shared/project-sessions';
import { SETTINGS_KEYS } from './constants';
import { serializeMcpPluginRecord, serializeProjectRecord, serializeProviderRecord } from './project-records';

function writeSetting(database: Database.Database, key: string, value: unknown): void {
  database
    .prepare(`
      INSERT INTO app_settings (key, value_json)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `)
    .run(key, JSON.stringify(value));
}

function deleteMissingRows(database: Database.Database, table: 'providers' | 'mcp_plugins' | 'projects', ids: string[]): void {
  if (ids.length === 0) {
    database.prepare(`DELETE FROM ${table}`).run();
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  database.prepare(`DELETE FROM ${table} WHERE id NOT IN (${placeholders})`).run(...ids);
}

function syncNormalizedProjectData(database: Database.Database, projects: Project[]): void {
  database.prepare('DELETE FROM messages').run();
  database.prepare('DELETE FROM chat_sessions').run();
  database.prepare('DELETE FROM agent_runs').run();

  const insertSession = database.prepare(`
    INSERT INTO chat_sessions (
      id,
      project_id,
      title,
      auto_title,
      created_at,
      updated_at,
      runtime_json,
      is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id,
      project_id,
      session_id,
      role,
      content,
      content_blocks_json,
      created_at,
      metadata_json,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRun = database.prepare(`
    INSERT INTO agent_runs (
      id,
      project_id,
      mode,
      input,
      status,
      used_provider_id,
      used_model,
      started_at,
      finished_at,
      steps_json,
      plugin_reports_json,
      execution_plan_json,
      operation_log_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const project of projects) {
    const ensuredProject = ensureProjectSessions(project);
    ensuredProject.sessions.forEach((session) => {
      insertSession.run(
        session.id,
        ensuredProject.id,
        session.title,
        session.autoTitle ? 1 : 0,
        session.createdAt,
        session.updatedAt,
        session.runtimeOverrides ? JSON.stringify(session.runtimeOverrides) : null,
        session.id === ensuredProject.activeSessionId ? 1 : 0
      );

      session.chat.forEach((message, index) => {
        insertMessage.run(
          message.id,
          ensuredProject.id,
          session.id,
          message.role,
          message.content,
          message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
          message.createdAt,
          message.metadata ? JSON.stringify(message.metadata) : null,
          typeof message.ordinal === 'number' && Number.isFinite(message.ordinal) ? Math.floor(message.ordinal) : index
        );
      });
    });

    if (ensuredProject.lastAgentRun) {
      insertRun.run(
        ensuredProject.lastAgentRun.id,
        ensuredProject.id,
        ensuredProject.lastAgentRun.mode,
        ensuredProject.lastAgentRun.input,
        ensuredProject.lastAgentRun.status,
        ensuredProject.lastAgentRun.usedProviderId ?? null,
        ensuredProject.lastAgentRun.usedModel ?? null,
        ensuredProject.lastAgentRun.startedAt,
        ensuredProject.lastAgentRun.finishedAt,
        JSON.stringify(ensuredProject.lastAgentRun.steps),
        JSON.stringify(ensuredProject.lastAgentRun.pluginReports),
        ensuredProject.lastAgentRun.executionPlan ? JSON.stringify(ensuredProject.lastAgentRun.executionPlan) : null,
        ensuredProject.lastAgentRun.operationLog ? JSON.stringify(ensuredProject.lastAgentRun.operationLog) : null
      );
    }
  }
}

export function persistStateSync(database: Database.Database, state: AppState): void {
  const persistedProviders: AiProvider[] = state.providers.map((provider) => ({
    ...provider,
    apiKey: '',
    hasStoredApiKey: provider.hasStoredApiKey ?? Boolean(provider.apiKey.trim())
  }));

  const transaction = database.transaction((snapshot: AppState) => {
    writeSetting(database, SETTINGS_KEYS.unity, snapshot.settings);
    writeSetting(database, SETTINGS_KEYS.ai, snapshot.aiSettings);
    writeSetting(database, SETTINGS_KEYS.agent, snapshot.agentSettings);
    writeSetting(database, SETTINGS_KEYS.mcp, snapshot.mcpSettings);

    deleteMissingRows(database, 'providers', persistedProviders.map((provider) => provider.id));
    for (const provider of persistedProviders) {
      const serializedProvider = serializeProviderRecord(provider);
      database
        .prepare(`
          INSERT INTO providers (
            id,
            name,
            protocol,
            api_mode,
            auth_style,
            base_url,
            model,
            upstream_model,
            headers_json,
            env_overrides_json,
            claude_code_compatible,
            claude_role_models_json,
            available_models_json,
            sdk_proxy_only,
            provider_meta_json,
            context_window_tokens,
            max_output_tokens,
            request_timeout_ms,
            request_timeout_disabled,
            chunk_timeout_ms,
            enabled,
            is_default,
            notes,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            protocol = excluded.protocol,
            api_mode = excluded.api_mode,
            auth_style = excluded.auth_style,
            base_url = excluded.base_url,
            model = excluded.model,
            upstream_model = excluded.upstream_model,
            headers_json = excluded.headers_json,
            env_overrides_json = excluded.env_overrides_json,
            claude_code_compatible = excluded.claude_code_compatible,
            claude_role_models_json = excluded.claude_role_models_json,
            available_models_json = excluded.available_models_json,
            sdk_proxy_only = excluded.sdk_proxy_only,
            provider_meta_json = excluded.provider_meta_json,
            context_window_tokens = excluded.context_window_tokens,
            max_output_tokens = excluded.max_output_tokens,
            request_timeout_ms = excluded.request_timeout_ms,
            request_timeout_disabled = excluded.request_timeout_disabled,
            chunk_timeout_ms = excluded.chunk_timeout_ms,
            enabled = excluded.enabled,
            is_default = excluded.is_default,
            notes = excluded.notes,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `)
        .run(
          serializedProvider.id,
          serializedProvider.name,
          serializedProvider.protocol,
          serializedProvider.api_mode,
          serializedProvider.auth_style,
          serializedProvider.base_url,
          serializedProvider.model,
          serializedProvider.upstream_model,
          serializedProvider.headers_json,
          serializedProvider.env_overrides_json,
          serializedProvider.claude_code_compatible,
          serializedProvider.claude_role_models_json,
          serializedProvider.available_models_json,
          serializedProvider.sdk_proxy_only,
          serializedProvider.provider_meta_json,
          serializedProvider.context_window_tokens,
          serializedProvider.max_output_tokens,
          serializedProvider.request_timeout_ms,
          serializedProvider.request_timeout_disabled,
          serializedProvider.chunk_timeout_ms,
          serializedProvider.enabled,
          serializedProvider.is_default,
          serializedProvider.notes,
          serializedProvider.created_at,
          serializedProvider.updated_at
        );
    }

    deleteMissingRows(database, 'mcp_plugins', snapshot.mcpPlugins.map((plugin) => plugin.id));
    for (const plugin of snapshot.mcpPlugins) {
      const serializedPlugin = serializeMcpPluginRecord(plugin);
      database
        .prepare(`
          INSERT INTO mcp_plugins (
            id,
            project_id,
            name,
            kind,
            transport,
            base_url,
            command,
            args_json,
            cwd,
            env_json,
            default_tool_permission,
            default_tool_risk,
            tool_policies_json,
            enabled,
            is_default,
            notes,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            name = excluded.name,
            kind = excluded.kind,
            transport = excluded.transport,
            base_url = excluded.base_url,
            command = excluded.command,
            args_json = excluded.args_json,
            cwd = excluded.cwd,
            env_json = excluded.env_json,
            default_tool_permission = excluded.default_tool_permission,
            default_tool_risk = excluded.default_tool_risk,
            tool_policies_json = excluded.tool_policies_json,
            enabled = excluded.enabled,
            is_default = excluded.is_default,
            notes = excluded.notes,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `)
        .run(
          serializedPlugin.id,
          serializedPlugin.project_id,
          serializedPlugin.name,
          serializedPlugin.kind,
          serializedPlugin.transport,
          serializedPlugin.base_url,
          serializedPlugin.command,
          serializedPlugin.args_json,
          serializedPlugin.cwd,
          serializedPlugin.env_json,
          serializedPlugin.default_tool_permission,
          serializedPlugin.default_tool_risk,
          serializedPlugin.tool_policies_json,
          serializedPlugin.enabled,
          serializedPlugin.is_default,
          serializedPlugin.notes,
          serializedPlugin.created_at,
          serializedPlugin.updated_at
        );
    }

    deleteMissingRows(database, 'projects', snapshot.projects.map((project) => project.id));
    for (const project of snapshot.projects) {
      const serializedProject = serializeProjectRecord(project);
      database
        .prepare(`
          INSERT INTO projects (
            id,
            name,
            template_id,
            art_style,
            pitch,
            status,
            engine_json,
            runtime_state_json,
            agent_policy_json,
            provider_id,
            model,
            mcp_plugin_id,
            mcp_bindings_json,
            created_at,
            updated_at,
            blueprint_json,
            tasks_json,
            assets_json,
            activity_json,
            snapshots_json,
            memory_json,
            context_summary_json,
            current_execution_plan_json,
            last_executed_plan_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            template_id = excluded.template_id,
            art_style = excluded.art_style,
            pitch = excluded.pitch,
            status = excluded.status,
            engine_json = excluded.engine_json,
            runtime_state_json = excluded.runtime_state_json,
            agent_policy_json = excluded.agent_policy_json,
            provider_id = excluded.provider_id,
            model = excluded.model,
            mcp_plugin_id = excluded.mcp_plugin_id,
            mcp_bindings_json = excluded.mcp_bindings_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            blueprint_json = excluded.blueprint_json,
            tasks_json = excluded.tasks_json,
            assets_json = excluded.assets_json,
            activity_json = excluded.activity_json,
            snapshots_json = excluded.snapshots_json,
            memory_json = excluded.memory_json,
            context_summary_json = excluded.context_summary_json,
            current_execution_plan_json = excluded.current_execution_plan_json,
            last_executed_plan_json = excluded.last_executed_plan_json
        `)
        .run(
          serializedProject.id,
          serializedProject.name,
          serializedProject.template_id,
          serializedProject.art_style,
          serializedProject.pitch,
          serializedProject.status,
          serializedProject.engine_json,
          serializedProject.runtime_state_json,
          serializedProject.agent_policy_json,
          serializedProject.provider_id,
          serializedProject.model,
          serializedProject.mcp_plugin_id,
          serializedProject.mcp_bindings_json,
          serializedProject.created_at,
          serializedProject.updated_at,
          serializedProject.blueprint_json,
          serializedProject.tasks_json,
          serializedProject.assets_json,
          serializedProject.activity_json,
          serializedProject.snapshots_json,
          serializedProject.memory_json,
          serializedProject.context_summary_json,
          serializedProject.current_execution_plan_json,
          serializedProject.last_executed_plan_json
        );
    }

    syncNormalizedProjectData(database, snapshot.projects);
  });

  transaction(state);
}
