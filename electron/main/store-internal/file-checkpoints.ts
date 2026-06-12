import Database from 'better-sqlite3';

export interface FileCheckpointEntry {
  path: string;
  existed: boolean;
  /** UTF-8 text for text rows, base64 for binary rows; undefined when the file was missing or too large. */
  content?: string;
  isBinary: boolean;
  byteLength?: number;
  contentHash?: string;
  tooLarge: boolean;
}

export interface UpsertFileCheckpointEntryInput {
  snapshotId: string;
  filePath: string;
  existed: boolean;
  /** Omitted for dedup references (same content_hash already stored in this snapshot) and too-large entries. */
  content?: string;
  isBinary?: boolean;
  byteLength?: number;
  contentHash?: string;
  tooLarge?: boolean;
}

interface FileCheckpointRow {
  file_path: string;
  existed: number;
  content: string | null;
  is_binary: number;
  byte_length: number | null;
  content_hash: string | null;
  too_large: number;
}

function blobKey(isBinary: boolean, contentHash: string): string {
  return `${isBinary ? 'b' : 't'}:${contentHash}`;
}

export function upsertFileCheckpointEntryRecord(
  database: Database.Database,
  record: UpsertFileCheckpointEntryInput
): void {
  database
    .prepare(`
      INSERT INTO file_checkpoints (
        snapshot_id,
        file_path,
        existed,
        content,
        is_binary,
        byte_length,
        content_hash,
        too_large
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id, file_path) DO UPDATE SET
        existed = excluded.existed,
        content = excluded.content,
        is_binary = excluded.is_binary,
        byte_length = excluded.byte_length,
        content_hash = excluded.content_hash,
        too_large = excluded.too_large
    `)
    .run(
      record.snapshotId,
      record.filePath,
      record.existed ? 1 : 0,
      record.content ?? null,
      record.isBinary ? 1 : 0,
      record.byteLength ?? null,
      record.contentHash ?? null,
      record.tooLarge ? 1 : 0
    );
}

export function listFileCheckpointEntryRecords(database: Database.Database, snapshotId: string): FileCheckpointEntry[] {
  const rows = database
    .prepare(`
      SELECT file_path, existed, content, is_binary, byte_length, content_hash, too_large
      FROM file_checkpoints WHERE snapshot_id = ? ORDER BY file_path ASC
    `)
    .all(snapshotId) as FileCheckpointRow[];

  // Rows captured as per-run dedup references carry only content_hash; resolve them
  // against the row in the same snapshot that holds the shared blob.
  const blobsByKey = new Map<string, string>();
  for (const row of rows) {
    if (row.content !== null && row.content_hash) {
      blobsByKey.set(blobKey(row.is_binary === 1, row.content_hash), row.content);
    }
  }

  return rows.map((row) => {
    const isBinary = row.is_binary === 1;
    const tooLarge = row.too_large === 1;
    const content = row.content
      ?? (!tooLarge && row.content_hash ? blobsByKey.get(blobKey(isBinary, row.content_hash)) : undefined);
    return {
      path: row.file_path,
      existed: row.existed === 1,
      content,
      isBinary,
      byteLength: row.byte_length ?? undefined,
      contentHash: row.content_hash ?? undefined,
      tooLarge
    };
  });
}

export function clearFileCheckpointEntryRecords(database: Database.Database, snapshotId: string): void {
  database.prepare('DELETE FROM file_checkpoints WHERE snapshot_id = ?').run(snapshotId);
}
