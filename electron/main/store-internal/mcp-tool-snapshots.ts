import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { McpToolSnapshot, McpToolSnapshotChangeKind } from '../../../shared/types';
import type { McpToolSnapshotRow } from './row-types';

export interface UpsertMcpToolSnapshotInput {
  pluginId: string;
  pluginName: string;
  originalName: string;
  exposedName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  policySummary?: string;
  discoveredAt: string;
}

export interface McpToolSnapshotScope {
  pluginId: string;
  pluginName: string;
  discoveredAt: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashSchema(schemaJson: string): string {
  return createHash('sha256').update(schemaJson).digest('hex');
}

function hydrate(row: McpToolSnapshotRow): McpToolSnapshot {
  return {
    pluginId: row.plugin_id,
    pluginName: row.plugin_name,
    originalName: row.original_name,
    exposedName: row.exposed_name,
    description: row.description ?? undefined,
    schemaHash: row.schema_hash,
    schemaJson: row.schema_json,
    policySummary: row.policy_summary ?? undefined,
    changeKind: row.change_kind,
    discoveredAt: row.discovered_at
  };
}

function classifyChange(previous: McpToolSnapshotRow | undefined, input: {
  exposedName: string;
  description?: string;
  schemaHash: string;
  policySummary?: string;
}): McpToolSnapshotChangeKind {
  if (!previous || previous.change_kind === 'removed') {
    return 'added';
  }
  if (
    previous.exposed_name !== input.exposedName ||
    previous.schema_hash !== input.schemaHash ||
    (previous.description ?? '') !== (input.description ?? '') ||
    (previous.policy_summary ?? '') !== (input.policySummary ?? '')
  ) {
    return 'changed';
  }
  return 'unchanged';
}

export function recordMcpToolSnapshotRecords(database: Database.Database, inputs: UpsertMcpToolSnapshotInput[], scope?: McpToolSnapshotScope): McpToolSnapshot[] {
  const pluginId = scope?.pluginId ?? inputs[0]?.pluginId;
  const discoveredAt = scope?.discoveredAt ?? inputs[0]?.discoveredAt;
  if (!pluginId || !discoveredAt) {
    return [];
  }

  const previousRows = database.prepare('SELECT * FROM mcp_tool_snapshots WHERE plugin_id = ?').all(pluginId) as McpToolSnapshotRow[];
  const previousByName = new Map(previousRows.map((row) => [row.original_name, row]));
  const seen = new Set(inputs.map((input) => input.originalName));
  const upsert = database.prepare(`
    INSERT INTO mcp_tool_snapshots (
      plugin_id,
      original_name,
      plugin_name,
      exposed_name,
      description,
      schema_hash,
      schema_json,
      policy_summary,
      change_kind,
      discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id, original_name) DO UPDATE SET
      plugin_name = excluded.plugin_name,
      exposed_name = excluded.exposed_name,
      description = excluded.description,
      schema_hash = excluded.schema_hash,
      schema_json = excluded.schema_json,
      policy_summary = excluded.policy_summary,
      change_kind = excluded.change_kind,
      discovered_at = excluded.discovered_at
  `);
  const markRemoved = database.prepare(`
    UPDATE mcp_tool_snapshots
    SET change_kind = 'removed',
        discovered_at = ?
    WHERE plugin_id = ?
      AND original_name = ?
      AND change_kind != 'removed'
  `);

  const transaction = database.transaction(() => {
    for (const input of inputs) {
      const schemaJson = stableStringify(input.inputSchema ?? {});
      const schemaHash = hashSchema(schemaJson);
      const changeKind = classifyChange(previousByName.get(input.originalName), {
        exposedName: input.exposedName,
        description: input.description,
        schemaHash,
        policySummary: input.policySummary
      });
      upsert.run(
        input.pluginId,
        input.originalName,
        input.pluginName,
        input.exposedName,
        input.description ?? null,
        schemaHash,
        schemaJson,
        input.policySummary ?? null,
        changeKind,
        input.discoveredAt
      );
    }

    for (const previous of previousRows) {
      if (!seen.has(previous.original_name)) {
        markRemoved.run(discoveredAt, pluginId, previous.original_name);
      }
    }
  });
  transaction();

  return listMcpToolSnapshotRecords(database, pluginId);
}

export function listMcpToolSnapshotRecords(database: Database.Database, pluginId?: string): McpToolSnapshot[] {
  const rows = pluginId
    ? database.prepare('SELECT * FROM mcp_tool_snapshots WHERE plugin_id = ? ORDER BY original_name ASC').all(pluginId)
    : database.prepare('SELECT * FROM mcp_tool_snapshots ORDER BY plugin_name ASC, original_name ASC').all();
  return (rows as McpToolSnapshotRow[]).map(hydrate);
}
