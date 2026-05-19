import Database from 'better-sqlite3';
import type {
  AgentCoreStateMachineSnapshot,
  AgentRunKind,
  AgentRunResumeStrategy,
  AgentRuntimeEvent,
  AgentRuntimeResumeCursor,
  AgentRuntimeTimelineEntry,
  AgentRuntimeToolBoundary,
  AgentTaskGraph,
  AgentVerificationReport,
  RuntimeUsageTotals
} from '../../../shared/types';
import { parseJson } from './json';
import type {
  PersistedRuntimeRunRecord,
  PersistedRuntimeRunRequest,
  RuntimeRunRow
} from './row-types';

export interface UpsertRuntimeRunInput {
  id: string;
  kind: AgentRunKind;
  projectId: string;
  sessionId?: string;
  streamId?: string;
  status: 'running' | 'interrupted' | 'failed' | 'completed';
  startedAt: string;
  updatedAt: string;
  statusMessage?: string;
  checkpointSnapshotId?: string;
  inputPreview?: string;
  request: PersistedRuntimeRunRequest;
  lastError?: string;
  resumedFromRunId?: string;
  timeline?: AgentRuntimeTimelineEntry[];
  lastToolBoundary?: AgentRuntimeToolBoundary;
  resumeStrategy?: AgentRunResumeStrategy;
  taskGraph?: AgentTaskGraph;
  verification?: AgentVerificationReport;
  usage?: RuntimeUsageTotals;
  events?: AgentRuntimeEvent[];
}

function resolveResumeCursor(input: {
  events?: AgentRuntimeEvent[];
  lastToolBoundary?: AgentRuntimeToolBoundary;
  resumeStrategy?: AgentRunResumeStrategy;
  checkpointSnapshotId?: string;
}): AgentRuntimeResumeCursor | undefined {
  const events = input.events ?? [];
  const boundaryEvent = [...events]
    .reverse()
    .find((event) => event.type === 'tool_boundary' && event.toolBoundary?.status === 'completed');
  if (boundaryEvent?.toolBoundary) {
    return {
      eventId: boundaryEvent.id,
      eventType: boundaryEvent.type,
      strategy: input.resumeStrategy ?? 'resume_after_last_completed_tool',
      createdAt: boundaryEvent.createdAt,
      checkpointSnapshotId: boundaryEvent.toolBoundary.checkpointSnapshotId ?? input.checkpointSnapshotId,
      toolUseId: boundaryEvent.toolBoundary.toolUseId,
      toolName: boundaryEvent.toolBoundary.toolName,
      summary: boundaryEvent.toolBoundary.summary,
      transaction: boundaryEvent.toolBoundary.transaction
    };
  }

  const latest = events.at(-1);
  if (!latest) {
    return undefined;
  }
  return {
    eventId: latest.id,
    eventType: latest.type,
    strategy: input.resumeStrategy ?? 'restart_prompt',
    createdAt: latest.createdAt,
    checkpointSnapshotId: input.checkpointSnapshotId,
    summary: latest.statusMessage ?? latest.error
  };
}

function resolveLatestCoreState(events?: AgentRuntimeEvent[]): AgentCoreStateMachineSnapshot | undefined {
  return [...(events ?? [])]
    .reverse()
    .find((event) => event.type === 'agent_core_state' && event.coreState)
    ?.coreState;
}

function mapRuntimeRunRow(row: RuntimeRunRow): PersistedRuntimeRunRecord {
  const request = parseJson<PersistedRuntimeRunRequest>(row.request_json, {
    kind: 'conversation',
    projectId: row.project_id
  });

  const events = row.events_json ? parseJson<AgentRuntimeEvent[]>(row.events_json, []) : undefined;
  const lastToolBoundary = row.last_tool_boundary_json ? parseJson<AgentRuntimeToolBoundary | undefined>(row.last_tool_boundary_json, undefined) : undefined;
  const resumeStrategy = row.resume_strategy as AgentRunResumeStrategy | undefined;
  const coreState = resolveLatestCoreState(events);

  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
    runtimeId: request.runtimeId ?? (request.kind === 'execute-plan' ? 'execute-plan' : undefined),
    providerId: request.providerId,
    model: request.model,
    permissionMode: request.permissionMode,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    status: row.status,
    statusMessage: row.status_message ?? undefined,
    streamId: row.stream_id ?? undefined,
    checkpointSnapshotId: row.checkpoint_snapshot_id ?? undefined,
    canResume: row.status === 'interrupted' || row.status === 'failed',
    inputPreview: row.input_preview ?? undefined,
    lastError: row.last_error ?? undefined,
    resumedFromRunId: row.resumed_from_run_id ?? undefined,
    timeline: row.timeline_json ? parseJson<AgentRuntimeTimelineEntry[]>(row.timeline_json, []) : undefined,
    lastToolBoundary,
    resumeStrategy,
    resumeCursor: resolveResumeCursor({
      events,
      lastToolBoundary,
      resumeStrategy,
      checkpointSnapshotId: row.checkpoint_snapshot_id ?? undefined
    }),
    coreState,
    taskGraph: row.task_graph_json ? parseJson<AgentTaskGraph | undefined>(row.task_graph_json, undefined) : request.taskGraph,
    verification: row.verification_json ? parseJson<AgentVerificationReport | undefined>(row.verification_json, undefined) : request.verification,
    usage: row.usage_json ? parseJson<RuntimeUsageTotals | undefined>(row.usage_json, undefined) : undefined,
    events,
    request
  };
}

export function upsertRuntimeRunRecord(database: Database.Database, record: UpsertRuntimeRunInput): void {
  database
    .prepare(`
      INSERT INTO runtime_runs (
        id,
        kind,
        project_id,
        session_id,
        stream_id,
        status,
        started_at,
        updated_at,
        status_message,
        checkpoint_snapshot_id,
        input_preview,
        request_json,
        last_error,
        resumed_from_run_id,
        timeline_json,
        last_tool_boundary_json,
        resume_strategy,
        task_graph_json,
        verification_json,
        usage_json,
        events_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        stream_id = excluded.stream_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        status_message = excluded.status_message,
        checkpoint_snapshot_id = excluded.checkpoint_snapshot_id,
        input_preview = excluded.input_preview,
        request_json = excluded.request_json,
        last_error = excluded.last_error,
        resumed_from_run_id = excluded.resumed_from_run_id,
        timeline_json = excluded.timeline_json,
        last_tool_boundary_json = excluded.last_tool_boundary_json,
        resume_strategy = excluded.resume_strategy,
        task_graph_json = excluded.task_graph_json,
        verification_json = excluded.verification_json,
        usage_json = excluded.usage_json,
        events_json = excluded.events_json
    `)
    .run(
      record.id,
      record.kind,
      record.projectId,
      record.sessionId ?? null,
      record.streamId ?? null,
      record.status,
      record.startedAt,
      record.updatedAt,
      record.statusMessage ?? null,
      record.checkpointSnapshotId ?? null,
      record.inputPreview ?? null,
      JSON.stringify(record.request),
      record.lastError ?? null,
      record.resumedFromRunId ?? null,
      record.timeline ? JSON.stringify(record.timeline) : null,
      record.lastToolBoundary ? JSON.stringify(record.lastToolBoundary) : null,
      record.resumeStrategy ?? null,
      record.taskGraph ? JSON.stringify(record.taskGraph) : null,
      record.verification ? JSON.stringify(record.verification) : null,
      record.usage ? JSON.stringify(record.usage) : null,
      record.events ? JSON.stringify(record.events) : null
    );

  if (record.status === 'completed') {
    database
      .prepare(`
        DELETE FROM runtime_runs
        WHERE status = 'completed'
          AND id NOT IN (
            SELECT id
            FROM runtime_runs
            WHERE status = 'completed'
            ORDER BY updated_at DESC, started_at DESC
            LIMIT 50
          )
      `)
      .run();
  }
}

export function deleteRuntimeRunRecord(database: Database.Database, runId: string): void {
  database.prepare('DELETE FROM runtime_runs WHERE id = ?').run(runId);
}

export function getRuntimeRunRecord(database: Database.Database, runId: string): PersistedRuntimeRunRecord | undefined {
  const row = database.prepare('SELECT * FROM runtime_runs WHERE id = ?').get(runId) as RuntimeRunRow | undefined;
  return row ? mapRuntimeRunRow(row) : undefined;
}

export function listRuntimeRunRecords(database: Database.Database, projectId?: string): PersistedRuntimeRunRecord[] {
  const rows = projectId
    ? (database.prepare('SELECT * FROM runtime_runs WHERE project_id = ? ORDER BY updated_at DESC, started_at DESC').all(projectId) as RuntimeRunRow[])
    : (database.prepare('SELECT * FROM runtime_runs ORDER BY updated_at DESC, started_at DESC').all() as RuntimeRunRow[]);
  return rows.map(mapRuntimeRunRow);
}

export function markPendingRuntimeRunsInterruptedOnStartup(database: Database.Database): void {
  database
    .prepare(`
      UPDATE runtime_runs
      SET
        status = 'interrupted',
        updated_at = ?,
        last_error = COALESCE(last_error, 'Application restarted before the agent run completed.'),
        status_message = COALESCE(status_message, 'Interrupted before completion')
      WHERE status = 'running'
    `)
    .run(new Date().toISOString());
}
