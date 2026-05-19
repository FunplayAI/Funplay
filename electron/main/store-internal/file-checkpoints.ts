import Database from 'better-sqlite3';

export interface FileCheckpointEntry {
  path: string;
  existed: boolean;
  content?: string;
}

export function upsertFileCheckpointEntryRecord(database: Database.Database, record: {
  snapshotId: string;
  filePath: string;
  existed: boolean;
  content?: string;
}): void {
  database
    .prepare(`
      INSERT INTO file_checkpoints (
        snapshot_id,
        file_path,
        existed,
        content
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(snapshot_id, file_path) DO UPDATE SET
        existed = excluded.existed,
        content = excluded.content
    `)
    .run(
      record.snapshotId,
      record.filePath,
      record.existed ? 1 : 0,
      record.content ?? null
    );
}

export function listFileCheckpointEntryRecords(database: Database.Database, snapshotId: string): FileCheckpointEntry[] {
  return (database
    .prepare('SELECT file_path, existed, content FROM file_checkpoints WHERE snapshot_id = ? ORDER BY file_path ASC')
    .all(snapshotId) as Array<{ file_path: string; existed: number; content: string | null }>)
    .map((row) => ({
      path: row.file_path,
      existed: row.existed === 1,
      content: row.content ?? undefined
    }));
}

export function clearFileCheckpointEntryRecords(database: Database.Database, snapshotId: string): void {
  database.prepare('DELETE FROM file_checkpoints WHERE snapshot_id = ?').run(snapshotId);
}
