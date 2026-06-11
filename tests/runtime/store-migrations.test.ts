import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { getState, initializeStore, listMcpRawAudits, listMcpToolSnapshots, setState, tryAppendMcpRawAudit, tryRecordMcpToolSnapshots } from '../../electron/main/store.ts';
import { DB_FILE_NAME, SETTINGS_KEYS } from '../../electron/main/store-internal/constants.ts';
import { MIGRATIONS, runMigrations } from '../../electron/main/store-internal/migrations.ts';

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const EXPECTED_TABLES = [
  'app_settings',
  'providers',
  'mcp_plugins',
  'mcp_tool_snapshots',
  'mcp_raw_audits',
  'projects',
  'chat_sessions',
  'messages',
  'agent_runs',
  'permission_audits',
  'runtime_runs',
  'file_checkpoints'
];

function listTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function readVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

test('runMigrations bootstraps an empty database to the latest schema version', () => {
  const db = new Database(':memory:');
  try {
    assert.equal(readVersion(db), 0);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const tables = listTables(db);
    for (const expected of EXPECTED_TABLES) {
      assert.ok(tables.includes(expected), `expected table ${expected} after migration`);
    }
  } finally {
    db.close();
  }
});

test('runMigrations adopts a pre-versioned database without losing data', () => {
  const db = new Database(':memory:');
  try {
    // Simulate a user from before the migration system: schema already exists
    // (created by the legacy createSchema path) but user_version is still 0.
    runMigrations(db);
    db.exec('PRAGMA user_version = 0');
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run('seed', '{"hello":"world"}');
    assert.equal(readVersion(db), 0);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const seeded = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('seed') as { value_json: string } | undefined;
    assert.equal(seeded?.value_json, '{"hello":"world"}');
  } finally {
    db.close();
  }
});

test('runMigrations is idempotent when the database is already at the latest version', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const versionAfterFirstRun = readVersion(db);
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run('persist', '"keep me"');

    runMigrations(db);
    runMigrations(db);

    assert.equal(readVersion(db), versionAfterFirstRun);
    const persisted = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('persist') as { value_json: string } | undefined;
    assert.equal(persisted?.value_json, '"keep me"');
  } finally {
    db.close();
  }
});

test('v2 migration adds runtime_runs.usage_json without rebuilding the table', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    assert.equal(readVersion(db), LATEST_VERSION);

    const columns = db.prepare("PRAGMA table_info('runtime_runs')").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    assert.ok(columnNames.includes('usage_json'), 'expected runtime_runs.usage_json after v2 migration');
    assert.ok(columnNames.includes('id'), 'expected pre-existing runtime_runs.id to remain');
  } finally {
    db.close();
  }
});

test('v2 migration is reachable from a v1-stamped database', () => {
  const db = new Database(':memory:');
  try {
    // Land at v1 the long way (run, then rewind) to simulate a user who upgraded
    // to the migration system before v2 existed.
    runMigrations(db);
    db.exec('PRAGMA user_version = 1');
    db.exec('ALTER TABLE runtime_runs DROP COLUMN usage_json');
    assert.equal(readVersion(db), 1);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('runtime_runs')").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'usage_json'));
  } finally {
    db.close();
  }
});

test('v3 migration adds runtime_runs.events_json without rebuilding the table', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    assert.equal(readVersion(db), LATEST_VERSION);

    const columns = db.prepare("PRAGMA table_info('runtime_runs')").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    assert.ok(columnNames.includes('events_json'), 'expected runtime_runs.events_json after v3 migration');
    assert.ok(columnNames.includes('usage_json'), 'expected runtime_runs.usage_json to remain');
  } finally {
    db.close();
  }
});

test('v3 migration is reachable from a v2-stamped database', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 2');
    db.exec('ALTER TABLE runtime_runs DROP COLUMN events_json');
    assert.equal(readVersion(db), 2);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('runtime_runs')").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'events_json'));
  } finally {
    db.close();
  }
});

test('v5 migration adds provider custom token limit columns', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 4');
    db.exec('ALTER TABLE providers DROP COLUMN context_window_tokens');
    db.exec('ALTER TABLE providers DROP COLUMN max_output_tokens');
    assert.equal(readVersion(db), 4);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('providers')").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    assert.ok(columnNames.includes('context_window_tokens'));
    assert.ok(columnNames.includes('max_output_tokens'));
  } finally {
    db.close();
  }
});

test('v6 migration adds project scope to MCP plugins', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 5');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN project_id');
    assert.equal(readVersion(db), 5);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('mcp_plugins')").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'project_id'));
  } finally {
    db.close();
  }
});

test('v7 migration adds stdio launch config to MCP plugins', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 6');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN command');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN args_json');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN cwd');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN env_json');
    assert.equal(readVersion(db), 6);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('mcp_plugins')").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    assert.ok(columnNames.includes('command'));
    assert.ok(columnNames.includes('args_json'));
    assert.ok(columnNames.includes('cwd'));
    assert.ok(columnNames.includes('env_json'));
  } finally {
    db.close();
  }
});

test('v8 migration adds MCP tool policy config', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 7');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN default_tool_permission');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN default_tool_risk');
    db.exec('ALTER TABLE mcp_plugins DROP COLUMN tool_policies_json');
    assert.equal(readVersion(db), 7);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const columns = db.prepare("PRAGMA table_info('mcp_plugins')").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    assert.ok(columnNames.includes('default_tool_permission'));
    assert.ok(columnNames.includes('default_tool_risk'));
    assert.ok(columnNames.includes('tool_policies_json'));
  } finally {
    db.close();
  }
});

test('v9 migration adds MCP tool snapshot table', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE mcp_tool_snapshots');
    db.exec('PRAGMA user_version = 8');
    assert.equal(readVersion(db), 8);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const tables = listTables(db);
    assert.ok(tables.includes('mcp_tool_snapshots'));
  } finally {
    db.close();
  }
});

test('v10 migration adds raw MCP audit table', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE mcp_raw_audits');
    db.exec('PRAGMA user_version = 9');
    assert.equal(readVersion(db), 9);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const tables = listTables(db);
    assert.ok(tables.includes('mcp_raw_audits'));
  } finally {
    db.close();
  }
});

test('stdio MCP plugin launch config persists across store restart', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-stdio-mcp-plugin-'));
  const timestamp = new Date().toISOString();

  try {
    await initializeStore(userDataPath);
    await setState({
      ...getState(),
      mcpPlugins: [{
        id: 'plugin_stdio',
        name: 'Stdio MCP',
        kind: 'custom',
        transport: 'stdio',
        baseUrl: '',
        command: '/usr/local/bin/example-mcp',
        args: ['--project', '/tmp/demo'],
        cwd: '/tmp',
        env: {
          MCP_TOKEN: 'redacted'
        },
        enabled: true,
        isDefault: false,
        notes: '',
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    });

    await initializeStore(userDataPath);

    const plugin = getState().mcpPlugins.find((item) => item.id === 'plugin_stdio');
    assert.equal(plugin?.transport, 'stdio');
    assert.equal(plugin?.command, '/usr/local/bin/example-mcp');
    assert.deepEqual(plugin?.args, ['--project', '/tmp/demo']);
    assert.equal(plugin?.cwd, '/tmp');
    assert.deepEqual(plugin?.env, {
      MCP_TOKEN: 'redacted'
    });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('MCP tool policy config persists across store restart', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-mcp-tool-policy-'));
  const timestamp = new Date().toISOString();

  try {
    await initializeStore(userDataPath);
    await setState({
      ...getState(),
      mcpPlugins: [{
        id: 'plugin_policy',
        name: 'Policy MCP',
        kind: 'custom',
        transport: 'http',
        baseUrl: 'http://127.0.0.1:9000/mcp',
        defaultToolPermission: 'ask',
        defaultToolRisk: 'write',
        toolPolicies: {
          'safe.read': {
            permission: 'allow',
            risk: 'read',
            notes: 'safe read tool'
          },
          'danger.write': {
            permission: 'deny'
          }
        },
        enabled: true,
        isDefault: false,
        notes: '',
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    });

    await initializeStore(userDataPath);

    const plugin = getState().mcpPlugins.find((item) => item.id === 'plugin_policy');
    assert.equal(plugin?.defaultToolPermission, 'ask');
    assert.equal(plugin?.defaultToolRisk, 'write');
    assert.equal(plugin?.toolPolicies?.['safe.read']?.permission, 'allow');
    assert.equal(plugin?.toolPolicies?.['safe.read']?.risk, 'read');
    assert.equal(plugin?.toolPolicies?.['danger.write']?.permission, 'deny');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('MCP tool snapshots persist schema hash, exposed mapping, and change state', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-mcp-tool-snapshot-'));
  const discoveredAt = new Date().toISOString();

  try {
    await initializeStore(userDataPath);
    const first = tryRecordMcpToolSnapshots([{
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      originalName: 'unity.echo',
      exposedName: 'mcp__snapshot_mcp__unity_echo',
      description: 'Echo tool',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        }
      },
      policySummary: 'MCP policy inferred: permission=ask, risk=write',
      discoveredAt
    }], {
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      discoveredAt
    });

    assert.equal(first[0]?.changeKind, 'added');
    assert.equal(first[0]?.exposedName, 'mcp__snapshot_mcp__unity_echo');
    assert.equal(first[0]?.schemaHash.length, 64);

    const second = tryRecordMcpToolSnapshots([{
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      originalName: 'unity.echo',
      exposedName: 'mcp__snapshot_mcp__unity_echo',
      description: 'Echo tool',
      inputSchema: {
        properties: {
          value: { type: 'string' }
        },
        type: 'object'
      },
      policySummary: 'MCP policy inferred: permission=ask, risk=write',
      discoveredAt
    }], {
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      discoveredAt
    });

    assert.equal(second[0]?.changeKind, 'unchanged');

    const third = tryRecordMcpToolSnapshots([{
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      originalName: 'unity.echo',
      exposedName: 'mcp__snapshot_mcp__unity_echo',
      description: 'Echo tool',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'number' }
        }
      },
      policySummary: 'MCP policy inferred: permission=ask, risk=write',
      discoveredAt
    }], {
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      discoveredAt
    });

    assert.equal(third[0]?.changeKind, 'changed');

    const removed = tryRecordMcpToolSnapshots([], {
      pluginId: 'plugin_snapshot',
      pluginName: 'Snapshot MCP',
      discoveredAt
    });

    assert.equal(removed[0]?.changeKind, 'removed');
    assert.equal(listMcpToolSnapshots('plugin_snapshot')[0]?.originalName, 'unity.echo');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('MCP raw audit records persist diagnostic operation metadata', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-mcp-raw-audit-'));

  try {
    await initializeStore(userDataPath);
    tryAppendMcpRawAudit({
      id: 'raw_audit_1',
      pluginId: 'plugin_raw',
      pluginName: 'Raw MCP',
      method: 'tools/list',
      status: 'success',
      durationMs: 12,
      paramsSize: 2,
      responseSize: 128
    });

    const audits = listMcpRawAudits('plugin_raw');
    assert.equal(audits[0]?.id, 'raw_audit_1');
    assert.equal(audits[0]?.method, 'tools/list');
    assert.equal(audits[0]?.status, 'success');
    assert.equal(audits[0]?.responseSize, 128);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('provider custom token limits persist across store restart', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-provider-token-limits-'));
  const timestamp = new Date().toISOString();

  try {
    await initializeStore(userDataPath);
    await setState({
      ...getState(),
      aiSettings: {
        ...getState().aiSettings,
        defaultProviderId: 'provider_custom_limits'
      },
      providers: [{
        id: 'provider_custom_limits',
        name: 'Custom Limits',
        protocol: 'openai-compatible',
        apiMode: 'chat',
        authStyle: 'api_key',
        baseUrl: 'https://example.com/v1',
        apiKey: '',
        hasStoredApiKey: false,
        model: 'custom-model',
        contextWindowTokens: 500_000,
        maxOutputTokens: 131_072,
        enabled: true,
        isDefault: true,
        notes: '',
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    });

    await initializeStore(userDataPath);

    const provider = getState().providers.find((item) => item.id === 'provider_custom_limits');
    assert.equal(provider?.contextWindowTokens, 500_000);
    assert.equal(provider?.maxOutputTokens, 131_072);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('initializeStore migrates legacy agent defaults to native build defaults', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-agent-defaults-'));
  const db = new Database(join(userDataPath, DB_FILE_NAME));
  try {
    runMigrations(db);
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run(
      SETTINGS_KEYS.agent,
      JSON.stringify({
        permissionMode: 'full-access',
        runtimeStrategy: 'auto'
      })
    );
  } finally {
    db.close();
  }

  try {
    await initializeStore(userDataPath);
    assert.equal(getState().agentSettings.permissionMode, 'full-access');
    assert.equal(getState().agentSettings.runtimeStrategy, 'native');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('initializeStore migrates ask-first agent defaults to build', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-agent-ask-defaults-'));
  const db = new Database(join(userDataPath, DB_FILE_NAME));
  try {
    runMigrations(db);
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run(
      SETTINGS_KEYS.agent,
      JSON.stringify({
        permissionMode: 'ask',
        runtimeStrategy: 'native'
      })
    );
  } finally {
    db.close();
  }

  try {
    await initializeStore(userDataPath);
    assert.equal(getState().agentSettings.permissionMode, 'full-access');
    assert.equal(getState().agentSettings.runtimeStrategy, 'native');
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('v12 migration drops claude provider columns and migrates persisted runtime ids to native', () => {
  const db = new Database(':memory:');
  const timestamp = new Date().toISOString();
  try {
    runMigrations(db);
    db.exec('PRAGMA user_version = 11');
    db.exec('ALTER TABLE providers ADD COLUMN claude_code_compatible INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE providers ADD COLUMN claude_role_models_json TEXT NOT NULL DEFAULT '{}'");
    db.exec('ALTER TABLE providers ADD COLUMN sdk_proxy_only INTEGER NOT NULL DEFAULT 0');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`
      INSERT INTO chat_sessions (id, project_id, title, auto_title, created_at, updated_at, runtime_json, is_active)
      VALUES (?, ?, ?, 0, ?, ?, ?, 0)
    `).run(
      'session_legacy_claude',
      'project_legacy',
      'Legacy session',
      timestamp,
      timestamp,
      JSON.stringify({
        runtimeId: 'claude-code-sdk',
        model: 'claude-sonnet-4-6',
        claudeCodeSessionId: 'cli_session',
        claudeCodeSessionCwd: '/tmp/project',
        claudeContextSummary: 'summary',
        claudeContextSummaryUpdatedAt: timestamp,
        claudeContextSummaryTurnCount: 3,
        claudeContextSummaryCoverage: { mode: 'boundary' },
        claudeWriteMode: 'external'
      })
    );
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run(
      SETTINGS_KEYS.agent,
      JSON.stringify({
        permissionMode: 'full-access',
        runtimeStrategy: 'claude-code-sdk'
      })
    );
    db.prepare(`
      INSERT INTO runtime_runs (id, kind, project_id, status, started_at, updated_at, request_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'run_legacy_claude',
      'conversation',
      'project_legacy',
      'completed',
      timestamp,
      timestamp,
      JSON.stringify({
        kind: 'conversation',
        projectId: 'project_legacy',
        runtimeId: 'claude-code-sdk'
      })
    );
    assert.equal(readVersion(db), 11);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    const providerColumns = (db.prepare("PRAGMA table_info('providers')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.equal(providerColumns.includes('claude_code_compatible'), false);
    assert.equal(providerColumns.includes('claude_role_models_json'), false);
    assert.equal(providerColumns.includes('sdk_proxy_only'), false);

    const sessionRow = db.prepare('SELECT runtime_json FROM chat_sessions WHERE id = ?').get('session_legacy_claude') as
      | { runtime_json: string | null }
      | undefined;
    const overrides = JSON.parse(sessionRow?.runtime_json ?? '{}') as Record<string, unknown>;
    assert.equal(overrides.runtimeId, 'native');
    assert.equal(overrides.model, 'claude-sonnet-4-6');
    for (const key of Object.keys(overrides)) {
      assert.equal(key.startsWith('claude'), false, `expected legacy override ${key} to be stripped`);
    }

    const settingsRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.agent) as
      | { value_json: string }
      | undefined;
    assert.equal((JSON.parse(settingsRow?.value_json ?? '{}') as { runtimeStrategy?: string }).runtimeStrategy, 'native');

    const runRow = db.prepare('SELECT request_json FROM runtime_runs WHERE id = ?').get('run_legacy_claude') as
      | { request_json: string }
      | undefined;
    assert.equal((JSON.parse(runRow?.request_json ?? '{}') as { runtimeId?: string }).runtimeId, 'native');
  } finally {
    db.close();
  }
});

test('initial migration declares all expected tables', () => {
  // Documents the expected baseline so future migrations have a clear contract.
  const initial = MIGRATIONS.find((migration) => migration.version === 1);
  assert.ok(initial, 'expected a v1 initial migration');

  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const tables = new Set(listTables(db));
    for (const expected of EXPECTED_TABLES) {
      assert.ok(tables.has(expected), `v1 migration is expected to create ${expected}`);
    }
  } finally {
    db.close();
  }
});
