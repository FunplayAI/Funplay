import Database from 'better-sqlite3';

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface SubagentRunRecord {
  id: string;
  parentSessionId?: string;
  status: SubagentRunStatus;
  agentName?: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  resultSummary?: string;
}

export type UpsertSubagentRunInput = SubagentRunRecord;

interface SubagentRunRow {
  id: string;
  parent_session_id: string | null;
  status: string;
  agent_name: string | null;
  prompt: string;
  started_at: string;
  finished_at: string | null;
  result_summary: string | null;
}

const SUBAGENT_RUN_FINISHED_KEEP_LIMIT = 100;

function mapSubagentRunRow(row: SubagentRunRow): SubagentRunRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status as SubagentRunStatus,
    agentName: row.agent_name ?? undefined,
    prompt: row.prompt,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    resultSummary: row.result_summary ?? undefined
  };
}

export function upsertSubagentRunRecord(database: Database.Database, record: UpsertSubagentRunInput): void {
  database
    .prepare(`
      INSERT INTO subagent_runs (
        id,
        parent_session_id,
        status,
        agent_name,
        prompt,
        started_at,
        finished_at,
        result_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_session_id = excluded.parent_session_id,
        status = excluded.status,
        agent_name = excluded.agent_name,
        prompt = excluded.prompt,
        finished_at = excluded.finished_at,
        result_summary = excluded.result_summary
    `)
    .run(
      record.id,
      record.parentSessionId ?? null,
      record.status,
      record.agentName ?? null,
      record.prompt,
      record.startedAt,
      record.finishedAt ?? null,
      record.resultSummary ?? null
    );

  if (record.status !== 'running') {
    database
      .prepare(`
        DELETE FROM subagent_runs
        WHERE status != 'running'
          AND id NOT IN (
            SELECT id
            FROM subagent_runs
            WHERE status != 'running'
            ORDER BY started_at DESC
            LIMIT ${SUBAGENT_RUN_FINISHED_KEEP_LIMIT}
          )
      `)
      .run();
  }
}

export function getSubagentRunRecord(database: Database.Database, id: string): SubagentRunRecord | undefined {
  const row = database.prepare('SELECT * FROM subagent_runs WHERE id = ?').get(id) as SubagentRunRow | undefined;
  return row ? mapSubagentRunRow(row) : undefined;
}

export function listSubagentRunRecords(
  database: Database.Database,
  parentSessionId?: string,
  limit = 50
): SubagentRunRecord[] {
  const rows = parentSessionId
    ? (database
        .prepare('SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(parentSessionId, limit) as SubagentRunRow[])
    : (database.prepare('SELECT * FROM subagent_runs ORDER BY started_at DESC LIMIT ?').all(limit) as SubagentRunRow[]);
  return rows.map(mapSubagentRunRow);
}

/**
 * Records found 'running' at startup belong to a previous process and have no
 * live executor anymore; mark them interrupted (mirrors runtime_runs startup handling).
 */
export function markRunningSubagentRunRecordsInterrupted(database: Database.Database): void {
  database
    .prepare(`
      UPDATE subagent_runs
      SET
        status = 'interrupted',
        finished_at = COALESCE(finished_at, ?),
        result_summary = COALESCE(result_summary, 'Application restarted before the background subagent completed.')
      WHERE status = 'running'
    `)
    .run(new Date().toISOString());
}
