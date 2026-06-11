import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up(database: Database.Database): void;
}

function addColumnIfMissing(database: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function dropColumnIfExists(database: Database.Database, tableName: string, columnName: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
  }
}

const initial: Migration = {
  version: 1,
  description: 'Initial schema with providers, projects, sessions, agent runs, runtime runs, file checkpoints',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        api_mode TEXT,
        auth_style TEXT,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        upstream_model TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        env_overrides_json TEXT NOT NULL DEFAULT '{}',
        claude_code_compatible INTEGER NOT NULL DEFAULT 0,
        claude_role_models_json TEXT NOT NULL DEFAULT '{}',
        available_models_json TEXT NOT NULL DEFAULT '[]',
        sdk_proxy_only INTEGER NOT NULL DEFAULT 0,
        provider_meta_json TEXT NOT NULL DEFAULT '{}',
        context_window_tokens INTEGER,
        max_output_tokens INTEGER,
        request_timeout_ms INTEGER,
        request_timeout_disabled INTEGER NOT NULL DEFAULT 0,
        chunk_timeout_ms INTEGER,
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_plugins (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        transport TEXT NOT NULL,
        base_url TEXT NOT NULL,
        command TEXT,
        args_json TEXT,
        cwd TEXT,
        env_json TEXT,
        default_tool_permission TEXT,
        default_tool_risk TEXT,
        tool_policies_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tool_snapshots (
        plugin_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        exposed_name TEXT NOT NULL,
        description TEXT,
        schema_hash TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        policy_summary TEXT,
        change_kind TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, original_name)
      );

      CREATE TABLE IF NOT EXISTS mcp_raw_audits (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        params_size INTEGER NOT NULL,
        response_size INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        art_style TEXT NOT NULL,
        pitch TEXT NOT NULL,
        status TEXT NOT NULL,
        engine_json TEXT,
        runtime_state_json TEXT,
        agent_policy_json TEXT,
        provider_id TEXT,
        model TEXT,
        mcp_plugin_id TEXT,
        mcp_bindings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        blueprint_json TEXT NOT NULL,
        tasks_json TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        asset_generation_jobs_json TEXT NOT NULL DEFAULT '[]',
        asset_generation_presets_json TEXT NOT NULL DEFAULT '[]',
        activity_json TEXT NOT NULL,
        snapshots_json TEXT NOT NULL,
        memory_json TEXT NOT NULL,
        context_summary_json TEXT NOT NULL,
        current_execution_plan_json TEXT,
        last_executed_plan_json TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        auto_title INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        runtime_json TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        sort_order INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        used_provider_id TEXT,
        used_model TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        plugin_reports_json TEXT NOT NULL,
        execution_plan_json TEXT,
        operation_log_json TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS permission_audits (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_json TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT,
        stream_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status_message TEXT,
        checkpoint_snapshot_id TEXT,
        input_preview TEXT,
        request_json TEXT NOT NULL,
        last_error TEXT,
        resumed_from_run_id TEXT,
        timeline_json TEXT,
        last_tool_boundary_json TEXT,
        resume_strategy TEXT,
        task_graph_json TEXT,
        verification_json TEXT,
        events_json TEXT
      );

      CREATE TABLE IF NOT EXISTS file_checkpoints (
        snapshot_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        existed INTEGER NOT NULL,
        content TEXT,
        PRIMARY KEY(snapshot_id, file_path)
      );
    `);

    addColumnIfMissing(database, 'providers', 'api_mode', 'TEXT');
    addColumnIfMissing(database, 'providers', 'auth_style', 'TEXT');
    addColumnIfMissing(database, 'providers', 'upstream_model', 'TEXT');
    addColumnIfMissing(database, 'providers', 'headers_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(database, 'providers', 'env_overrides_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(database, 'providers', 'claude_code_compatible', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'providers', 'claude_role_models_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(database, 'providers', 'available_models_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(database, 'providers', 'sdk_proxy_only', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'providers', 'provider_meta_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(database, 'providers', 'context_window_tokens', 'INTEGER');
    addColumnIfMissing(database, 'providers', 'max_output_tokens', 'INTEGER');
    addColumnIfMissing(database, 'providers', 'request_timeout_ms', 'INTEGER');
    addColumnIfMissing(database, 'providers', 'request_timeout_disabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'providers', 'chunk_timeout_ms', 'INTEGER');
    addColumnIfMissing(database, 'mcp_plugins', 'project_id', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'command', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'args_json', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'cwd', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'env_json', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'default_tool_permission', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'default_tool_risk', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'tool_policies_json', "TEXT NOT NULL DEFAULT '{}'");
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_snapshots (
        plugin_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        exposed_name TEXT NOT NULL,
        description TEXT,
        schema_hash TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        policy_summary TEXT,
        change_kind TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, original_name)
      );
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_raw_audits (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        params_size INTEGER NOT NULL,
        response_size INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );
    `);
    addColumnIfMissing(database, 'projects', 'agent_policy_json', 'TEXT');
    addColumnIfMissing(database, 'projects', 'asset_generation_jobs_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(database, 'projects', 'asset_generation_presets_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(database, 'agent_runs', 'operation_log_json', 'TEXT');
    addColumnIfMissing(database, 'chat_sessions', 'runtime_json', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'timeline_json', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'last_tool_boundary_json', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'resume_strategy', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'task_graph_json', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'verification_json', 'TEXT');
    addColumnIfMissing(database, 'runtime_runs', 'events_json', 'TEXT');
  }
};

const usageTracking: Migration = {
  version: 2,
  description: 'Track per-run token usage in runtime_runs',
  up(database) {
    addColumnIfMissing(database, 'runtime_runs', 'usage_json', 'TEXT');
  }
};

const runtimeEventLog: Migration = {
  version: 3,
  description: 'Persist structured runtime event logs',
  up(database) {
    addColumnIfMissing(database, 'runtime_runs', 'events_json', 'TEXT');
  }
};

const providerRuntimeOptions: Migration = {
  version: 4,
  description: 'Persist provider request and stream timeout options',
  up(database) {
    addColumnIfMissing(database, 'providers', 'request_timeout_ms', 'INTEGER');
    addColumnIfMissing(database, 'providers', 'request_timeout_disabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'providers', 'chunk_timeout_ms', 'INTEGER');
  }
};

const providerTokenLimits: Migration = {
  version: 5,
  description: 'Persist provider custom context and max output token limits',
  up(database) {
    addColumnIfMissing(database, 'providers', 'context_window_tokens', 'INTEGER');
    addColumnIfMissing(database, 'providers', 'max_output_tokens', 'INTEGER');
  }
};

const projectScopedMcpPlugins: Migration = {
  version: 6,
  description: 'Allow MCP plugins to be scoped to a project',
  up(database) {
    addColumnIfMissing(database, 'mcp_plugins', 'project_id', 'TEXT');
  }
};

const stdioMcpPlugins: Migration = {
  version: 7,
  description: 'Persist stdio MCP plugin launch configuration',
  up(database) {
    addColumnIfMissing(database, 'mcp_plugins', 'command', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'args_json', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'cwd', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'env_json', 'TEXT');
  }
};

const mcpToolPolicyConfig: Migration = {
  version: 8,
  description: 'Persist MCP tool permission policy configuration',
  up(database) {
    addColumnIfMissing(database, 'mcp_plugins', 'default_tool_permission', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'default_tool_risk', 'TEXT');
    addColumnIfMissing(database, 'mcp_plugins', 'tool_policies_json', "TEXT NOT NULL DEFAULT '{}'");
  }
};

const mcpToolSnapshots: Migration = {
  version: 9,
  description: 'Persist MCP tool snapshots and exposed-name mappings',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_snapshots (
        plugin_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        exposed_name TEXT NOT NULL,
        description TEXT,
        schema_hash TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        policy_summary TEXT,
        change_kind TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, original_name)
      );
    `);
  }
};

const mcpRawAudits: Migration = {
  version: 10,
  description: 'Persist raw MCP diagnostic operation audits',
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_raw_audits (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        params_size INTEGER NOT NULL,
        response_size INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }
};

const assetGenerationProjectLedger: Migration = {
  version: 11,
  description: 'Persist project asset generation jobs and presets',
  up(database) {
    addColumnIfMissing(database, 'projects', 'asset_generation_jobs_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(database, 'projects', 'asset_generation_presets_json', "TEXT NOT NULL DEFAULT '[]'");
  }
};

const LEGACY_CLAUDE_RUNTIME_ID = 'claude-code-sdk';
const LEGACY_CLAUDE_OVERRIDE_KEYS = [
  'claudeCodeSessionId',
  'claudeCodeSessionCwd',
  'claudeContextSummary',
  'claudeContextSummaryUpdatedAt',
  'claudeContextSummaryTurnCount',
  'claudeContextSummaryCoverage',
  'claudeWriteMode'
] as const;

const removeClaudeRuntime: Migration = {
  version: 12,
  description: 'Remove Claude Code SDK runtime: drop claude provider columns, migrate persisted runtime ids to native',
  up(database) {
    dropColumnIfExists(database, 'providers', 'claude_code_compatible');
    dropColumnIfExists(database, 'providers', 'claude_role_models_json');
    dropColumnIfExists(database, 'providers', 'sdk_proxy_only');

    const sessionRows = database
      .prepare('SELECT id, runtime_json FROM chat_sessions WHERE runtime_json IS NOT NULL')
      .all() as Array<{ id: string; runtime_json: string }>;
    const updateSession = database.prepare('UPDATE chat_sessions SET runtime_json = ? WHERE id = ?');
    for (const row of sessionRows) {
      let overrides: Record<string, unknown>;
      try {
        overrides = JSON.parse(row.runtime_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        continue;
      }
      let changed = false;
      if (overrides.runtimeId === LEGACY_CLAUDE_RUNTIME_ID) {
        overrides.runtimeId = 'native';
        changed = true;
      }
      for (const key of LEGACY_CLAUDE_OVERRIDE_KEYS) {
        if (key in overrides) {
          delete overrides[key];
          changed = true;
        }
      }
      if (changed) {
        updateSession.run(Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null, row.id);
      }
    }

    const agentSettingsRow = database
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get('agent_settings') as { value_json: string } | undefined;
    if (agentSettingsRow) {
      try {
        const settings = JSON.parse(agentSettingsRow.value_json) as Record<string, unknown>;
        if (settings && typeof settings === 'object' && settings.runtimeStrategy === LEGACY_CLAUDE_RUNTIME_ID) {
          settings.runtimeStrategy = 'native';
          database.prepare('UPDATE app_settings SET value_json = ? WHERE key = ?').run(JSON.stringify(settings), 'agent_settings');
        }
      } catch {
        // Malformed settings JSON: leave as-is; runtime defaults take over at load time.
      }
    }

    const runRows = database
      .prepare("SELECT id, request_json FROM runtime_runs WHERE request_json LIKE '%claude-code-sdk%'")
      .all() as Array<{ id: string; request_json: string }>;
    const updateRun = database.prepare('UPDATE runtime_runs SET request_json = ? WHERE id = ?');
    for (const row of runRows) {
      try {
        const request = JSON.parse(row.request_json) as Record<string, unknown>;
        if (request && typeof request === 'object' && request.runtimeId === LEGACY_CLAUDE_RUNTIME_ID) {
          request.runtimeId = 'native';
          updateRun.run(JSON.stringify(request), row.id);
        }
      } catch {
        // Malformed request JSON: leave as-is.
      }
    }
  }
};

export const MIGRATIONS: readonly Migration[] = [
  initial,
  usageTracking,
  runtimeEventLog,
  providerRuntimeOptions,
  providerTokenLimits,
  projectScopedMcpPlugins,
  stdioMcpPlugins,
  mcpToolPolicyConfig,
  mcpToolSnapshots,
  mcpRawAudits,
  assetGenerationProjectLedger,
  removeClaudeRuntime
];

function readUserVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function runMigrations(database: Database.Database): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  const current = readUserVersion(database);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    const apply = database.transaction(() => {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    });
    apply();
  }
}
