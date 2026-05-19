import type Database from 'better-sqlite3';
import type { McpRawAuditEntry } from '../../../shared/types';
import type { McpRawAuditRow } from './row-types';

export type AppendMcpRawAuditInput = Omit<McpRawAuditEntry, 'createdAt'> & {
  createdAt?: string;
};

function hydrate(row: McpRawAuditRow): McpRawAuditEntry {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    pluginName: row.plugin_name,
    method: row.method,
    status: row.status,
    durationMs: row.duration_ms,
    paramsSize: row.params_size,
    responseSize: row.response_size ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at
  };
}

export function appendMcpRawAuditRecord(database: Database.Database, input: AppendMcpRawAuditInput): void {
  database.prepare(`
    INSERT OR REPLACE INTO mcp_raw_audits (
      id,
      plugin_id,
      plugin_name,
      method,
      status,
      duration_ms,
      params_size,
      response_size,
      error,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.pluginId,
    input.pluginName,
    input.method,
    input.status,
    input.durationMs,
    input.paramsSize,
    input.responseSize ?? null,
    input.error ?? null,
    input.createdAt ?? new Date().toISOString()
  );
}

export function listMcpRawAuditRecords(database: Database.Database, pluginId?: string): McpRawAuditEntry[] {
  const rows = pluginId
    ? database.prepare('SELECT * FROM mcp_raw_audits WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 100').all(pluginId)
    : database.prepare('SELECT * FROM mcp_raw_audits ORDER BY created_at DESC LIMIT 100').all();
  return (rows as McpRawAuditRow[]).map(hydrate);
}
