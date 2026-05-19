import Database from 'better-sqlite3';
import type { PermissionAuditRecord } from './row-types';

export function appendPermissionAuditRecord(database: Database.Database, record: PermissionAuditRecord): void {
  database
    .prepare(`
      INSERT INTO permission_audits (
        request_id,
        project_id,
        session_id,
        title,
        detail,
        risk,
        status,
        created_at,
        resolved_at,
        resolution_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        status = excluded.status,
        resolved_at = excluded.resolved_at,
        resolution_json = excluded.resolution_json
    `)
    .run(
      record.requestId,
      record.projectId,
      record.sessionId,
      record.title,
      record.detail,
      record.risk,
      record.status,
      record.createdAt,
      record.resolvedAt ?? null,
      record.resolutionJson ?? null
    );
}

export function expirePendingPermissionAuditRecords(database: Database.Database, resolvedAt: string): void {
  database
    .prepare(`
      UPDATE permission_audits
      SET status = 'aborted',
          resolved_at = ?,
          resolution_json = json_object('decision', 'aborted', 'reason', 'app_startup')
      WHERE status = 'pending'
    `)
    .run(resolvedAt);
}
