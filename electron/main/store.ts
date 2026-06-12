import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_MCP_SETTINGS,
  DEFAULT_WEB_SEARCH_SETTINGS,
  type AiSettings,
  type AgentSettings,
  type AppState,
  type AssetGenerationProviderConfig,
  type McpRawAuditEntry,
  type McpToolSnapshot,
  type UnitySettings
} from '../../shared/types';
import { hydrateProvidersWithSecrets, migrateProviderSecretsFromProviders } from './provider-secret-store';
import { hydrateAssetGenerationProvidersWithSecrets } from './asset-generation-secret-store';
import {
  DB_FILE_NAME,
  SETTINGS_KEYS,
  createDefaultSettings,
  resolveLastCreatedProjectDirectory
} from './store-internal/constants';
import {
  clearFileCheckpointEntryRecords,
  listFileCheckpointEntryRecords,
  upsertFileCheckpointEntryRecord,
  type FileCheckpointEntry,
  type UpsertFileCheckpointEntryInput
} from './store-internal/file-checkpoints';
import { parseJson } from './store-internal/json';
import { appendPermissionAuditRecord, expirePendingPermissionAuditRecords } from './store-internal/permission-audits';
import {
  listMcpToolSnapshotRecords,
  recordMcpToolSnapshotRecords,
  type McpToolSnapshotScope,
  type UpsertMcpToolSnapshotInput
} from './store-internal/mcp-tool-snapshots';
import {
  appendMcpRawAuditRecord,
  listMcpRawAuditRecords,
  type AppendMcpRawAuditInput
} from './store-internal/mcp-raw-audits';
import {
  hydrateProjectRunFromRows,
  hydrateProjectSessionsFromRows,
  hydrateProjects,
  readMcpPlugins,
  readProjects,
  readProviders
} from './store-internal/project-records';
import type {
  AgentRunRow,
  MessageRow,
  PermissionAuditRecord,
  SettingRow,
  SessionRow
} from './store-internal/row-types';
import {
  deleteRuntimeRunRecord,
  getRuntimeRunRecord,
  listRuntimeRunRecords,
  markPendingRuntimeRunsInterruptedOnStartup,
  upsertRuntimeRunRecord,
  type UpsertRuntimeRunInput
} from './store-internal/runtime-runs';
import { runMigrations } from './store-internal/migrations';
import { persistStateSync } from './store-internal/state-persistence';
import { restoreSessionWritePermissionGrant } from './agent-platform/permission-session-store';

export type {
  PersistedRuntimeRunRecord,
  PersistedRuntimeRunRequest
} from './store-internal/row-types';

let db: Database.Database | null = null;
let memoryState: AppState = {
  settings: createDefaultSettings(),
  aiSettings: {
    ...DEFAULT_AI_SETTINGS,
    webSearch: {
      ...DEFAULT_WEB_SEARCH_SETTINGS
    }
  },
  agentSettings: DEFAULT_AGENT_SETTINGS,
  mcpSettings: DEFAULT_MCP_SETTINGS,
  mcpPlugins: [],
  assetGenerationProviders: [],
  providers: [],
  projects: []
};

const LEGACY_DEFAULT_AGENT_SETTINGS: AgentSettings = {
  permissionMode: 'full-access',
  runtimeStrategy: 'auto'
};

function requireDb(): Database.Database {
  if (!db) {
    throw new Error('Store has not been initialized.');
  }
  return db;
}

function getOptionalDb(): Database.Database | null {
  return db;
}

function persistMemoryState(): void {
  persistStateSync(requireDb(), memoryState);
}

function normalizeAgentSettingsForCurrentDefaults(settings: AgentSettings | undefined): AgentSettings {
  if (
    settings?.permissionMode === LEGACY_DEFAULT_AGENT_SETTINGS.permissionMode &&
    settings.runtimeStrategy === LEGACY_DEFAULT_AGENT_SETTINGS.runtimeStrategy
  ) {
    return {
      ...DEFAULT_AGENT_SETTINGS
    };
  }

  return {
    ...DEFAULT_AGENT_SETTINGS,
    ...(settings ?? {}),
    permissionMode: settings?.permissionMode === 'ask'
      ? 'full-access'
      : settings?.permissionMode ?? DEFAULT_AGENT_SETTINGS.permissionMode
  };
}

export async function initializeStore(userDataPath: string, defaultProjectDirectory = '~/Downloads'): Promise<void> {
  await mkdir(userDataPath, { recursive: true });
  const databasePath = join(userDataPath, DB_FILE_NAME);
  const defaultSettings = createDefaultSettings(defaultProjectDirectory);

  db?.close();
  db = new Database(databasePath);
  runMigrations(db);
  markPendingRuntimeRunsInterruptedOnStartup(db);
  expirePendingPermissionAuditRecords(db, new Date().toISOString());

  const unitySettingsRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.unity) as SettingRow | undefined;
  const aiSettingsRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.ai) as SettingRow | undefined;
  const agentSettingsRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.agent) as SettingRow | undefined;
  const mcpSettingsRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.mcp) as SettingRow | undefined;
  const assetGenerationProvidersRow = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SETTINGS_KEYS.assetGenerationProviders) as SettingRow | undefined;

  const unitySettings = parseJson<UnitySettings>(
    unitySettingsRow?.value_json,
    defaultSettings
  );
  const aiSettings = parseJson(
    aiSettingsRow?.value_json,
    DEFAULT_AI_SETTINGS
  );
  const agentSettings = parseJson<AgentSettings>(
    agentSettingsRow?.value_json,
    DEFAULT_AGENT_SETTINGS
  );
  const mcpSettings = parseJson(
    mcpSettingsRow?.value_json,
    DEFAULT_MCP_SETTINGS
  );
  const rawAssetGenerationProviders = parseJson<AssetGenerationProviderConfig[]>(
    assetGenerationProvidersRow?.value_json,
    []
  );
  const rawProviders = readProviders(db);
  const storedPlugins = readMcpPlugins(db);
  const rawProjects = readProjects(db);
  const sessionRows = db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, created_at DESC').all() as SessionRow[];
  const messageRows = db.prepare('SELECT rowid AS storage_rowid, * FROM messages ORDER BY session_id, sort_order ASC').all() as MessageRow[];
  const agentRunRows = db.prepare('SELECT * FROM agent_runs ORDER BY finished_at DESC').all() as AgentRunRow[];

  await migrateProviderSecretsFromProviders(rawProviders);
  const hydratedProviders = await hydrateProvidersWithSecrets(rawProviders);
  const hydratedAssetGenerationProviders = await hydrateAssetGenerationProvidersWithSecrets(rawAssetGenerationProviders);
  const normalizedProjects = hydrateProjects(rawProjects).map((project) => {
    const projectSessionRows = sessionRows.filter((row) => row.project_id === project.id);
    const projectMessageRows = messageRows.filter((row) => row.project_id === project.id);
    const projectRunRows = agentRunRows.filter((row) => row.project_id === project.id);
    return hydrateProjectRunFromRows(
      hydrateProjectSessionsFromRows(project, projectSessionRows, projectMessageRows),
      projectRunRows
    );
  });

  memoryState = {
    settings: {
      ...defaultSettings,
      ...unitySettings,
      lastCreatedProjectDirectory: resolveLastCreatedProjectDirectory(
        unitySettings.lastCreatedProjectDirectory,
        defaultProjectDirectory
      )
    },
    aiSettings: {
      ...DEFAULT_AI_SETTINGS,
      ...aiSettings,
      webSearch: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        ...(aiSettings?.webSearch ?? {})
      }
    },
    agentSettings: normalizeAgentSettingsForCurrentDefaults(agentSettings),
    mcpSettings: {
      ...DEFAULT_MCP_SETTINGS,
      ...mcpSettings
    },
    mcpPlugins: storedPlugins,
    assetGenerationProviders: hydratedAssetGenerationProviders,
    providers: hydratedProviders,
    projects: normalizedProjects
  };

  for (const project of memoryState.projects) {
    for (const session of project.sessions ?? []) {
      const grant = session.runtimeOverrides?.sessionWritePermissionGrant;
      if (grant) {
        restoreSessionWritePermissionGrant(session.id, grant);
      }
    }
  }

  persistMemoryState();
}

export function getState(): AppState {
  return memoryState;
}

export async function setState(nextState: AppState): Promise<void> {
  memoryState = nextState;
  persistMemoryState();
}

export async function patchSettings(partial: Partial<UnitySettings>): Promise<UnitySettings> {
  memoryState = {
    ...memoryState,
    settings: {
      ...memoryState.settings,
      ...partial
    }
  };
  persistMemoryState();
  return memoryState.settings;
}

export function getAgentSettings(): AgentSettings {
  return memoryState.agentSettings;
}

export function tryRecordMcpToolSnapshots(inputs: UpsertMcpToolSnapshotInput[], scope?: McpToolSnapshotScope): McpToolSnapshot[] {
  const database = getOptionalDb();
  return database ? recordMcpToolSnapshotRecords(database, inputs, scope) : [];
}

export function listMcpToolSnapshots(pluginId?: string): McpToolSnapshot[] {
  return listMcpToolSnapshotRecords(requireDb(), pluginId);
}

export function tryAppendMcpRawAudit(input: AppendMcpRawAuditInput): void {
  const database = getOptionalDb();
  if (database) {
    appendMcpRawAuditRecord(database, input);
  }
}

export function listMcpRawAudits(pluginId?: string): McpRawAuditEntry[] {
  return listMcpRawAuditRecords(requireDb(), pluginId);
}

export async function patchAiSettings(partial: Partial<Omit<AiSettings, 'webSearch'>> & { webSearch?: Partial<AiSettings['webSearch']> }): Promise<AiSettings> {
  memoryState = {
    ...memoryState,
    aiSettings: {
      ...memoryState.aiSettings,
      ...partial,
      webSearch: {
        ...memoryState.aiSettings.webSearch,
        ...(partial.webSearch ?? {})
      }
    }
  };
  persistMemoryState();
  return memoryState.aiSettings;
}

export async function patchAgentSettings(partial: Partial<AgentSettings>): Promise<AgentSettings> {
  memoryState = {
    ...memoryState,
    agentSettings: {
      ...memoryState.agentSettings,
      ...partial
    }
  };
  persistMemoryState();
  return memoryState.agentSettings;
}

export function appendPermissionAudit(record: PermissionAuditRecord): void {
  appendPermissionAuditRecord(requireDb(), record);
}

export function upsertRuntimeRun(record: UpsertRuntimeRunInput): void {
  upsertRuntimeRunRecord(requireDb(), record);
}

export function deleteRuntimeRun(runId: string): void {
  deleteRuntimeRunRecord(requireDb(), runId);
}

export function getRuntimeRun(runId: string): ReturnType<typeof getRuntimeRunRecord> {
  return getRuntimeRunRecord(requireDb(), runId);
}

export function listRuntimeRuns(projectId?: string): ReturnType<typeof listRuntimeRunRecords> {
  return listRuntimeRunRecords(requireDb(), projectId);
}

export function upsertFileCheckpointEntry(record: UpsertFileCheckpointEntryInput): void {
  upsertFileCheckpointEntryRecord(requireDb(), record);
}

export function listFileCheckpointEntries(snapshotId: string): FileCheckpointEntry[] {
  return listFileCheckpointEntryRecords(requireDb(), snapshotId);
}

export function clearFileCheckpointEntries(snapshotId: string): void {
  clearFileCheckpointEntryRecords(requireDb(), snapshotId);
}
