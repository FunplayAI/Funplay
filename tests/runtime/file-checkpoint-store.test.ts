import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  previewFileCheckpointChanges,
  recordFileCheckpoint,
  restoreFileCheckpoint
} from '../../electron/main/agent-platform/file-checkpoint-store.ts';
import { initializeStore } from '../../electron/main/store.ts';
import { DB_FILE_NAME } from '../../electron/main/store-internal/constants.ts';
import {
  listFileCheckpointEntryRecords,
  upsertFileCheckpointEntryRecord
} from '../../electron/main/store-internal/file-checkpoints.ts';
import { runMigrations } from '../../electron/main/store-internal/migrations.ts';
import { buildProject } from './test-helpers.ts';

// PNG-like bytes: NULs plus sequences that are invalid UTF-8, so any utf8 round-trip corrupts them.
const PNG_LIKE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0x00,
  0x80, 0xc3, 0x28, 0x00, 0xff
]);

test('binary checkpoint round-trip restores byte-identical content', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-binary-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'sprite.png'), PNG_LIKE_BYTES);
    await recordFileCheckpoint({
      snapshotId: 'snapshot_binary_roundtrip',
      project,
      filePath: 'sprite.png'
    });

    await writeFile(join(projectPath, 'sprite.png'), Buffer.from([0x00, 0x01, 0x02]));
    const restored = await restoreFileCheckpoint(project, 'snapshot_binary_roundtrip');

    assert.deepEqual(restored.restoredFiles, ['sprite.png']);
    assert.deepEqual(restored.skippedFiles, []);
    assert.deepEqual(restored.tooLargeFiles, []);
    const bytes = await readFile(join(projectPath, 'sprite.png'));
    assert.ok(bytes.equals(PNG_LIKE_BYTES), 'expected byte-identical restore for binary content');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('NUL byte scan detects binary content without an extension hint and previews byte sizes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-nul-scan-'));
  try {
    const project = buildProject(projectPath);
    // .asset is not on the binary extension hint list; detection must come from the NUL scan.
    await writeFile(join(projectPath, 'data.asset'), PNG_LIKE_BYTES);
    await recordFileCheckpoint({
      snapshotId: 'snapshot_nul_scan',
      project,
      filePath: 'data.asset'
    });

    await writeFile(join(projectPath, 'data.asset'), Buffer.concat([PNG_LIKE_BYTES, Buffer.from([0x00, 0x42])]));
    const preview = await previewFileCheckpointChanges(project, 'snapshot_nul_scan');

    assert.equal(preview.changedFiles.length, 1);
    assert.equal(preview.changedFiles[0].path, 'data.asset');
    assert.equal(preview.changedFiles[0].status, 'modified');
    assert.match(preview.changedFiles[0].diffPreview, /^\(二进制文件，\d+ bytes → \d+ bytes\)$/);

    const restored = await restoreFileCheckpoint(project, 'snapshot_nul_scan');
    assert.deepEqual(restored.restoredFiles, ['data.asset']);
    assert.ok((await readFile(join(projectPath, 'data.asset'))).equals(PNG_LIKE_BYTES));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('text checkpoints keep utf8 storage and unified text diffs', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-text-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'notes.md'), '# Hello\nline two\n', 'utf8');
    await recordFileCheckpoint({
      snapshotId: 'snapshot_text_behavior',
      project,
      filePath: 'notes.md'
    });

    await writeFile(join(projectPath, 'notes.md'), '# Hello\nline TWO\n', 'utf8');
    const preview = await previewFileCheckpointChanges(project, 'snapshot_text_behavior');

    assert.equal(preview.changedFiles.length, 1);
    assert.equal(preview.changedFiles[0].status, 'modified');
    assert.match(preview.changedFiles[0].diffPreview, /^--- a\/notes\.md/);
    assert.match(preview.changedFiles[0].diffPreview, /\+line TWO/);
    assert.doesNotMatch(preview.changedFiles[0].diffPreview, /二进制文件/);

    const restored = await restoreFileCheckpoint(project, 'snapshot_text_behavior');
    assert.deepEqual(restored.restoredFiles, ['notes.md']);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), '# Hello\nline two\n');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('oversized files degrade to too-large markers with no-op rollback', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-too-large-'));
  process.env.FUNPLAY_CHECKPOINT_MAX_FILE_BYTES = '16';
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'big.bin'), Buffer.alloc(64, 7));
    await writeFile(join(projectPath, 'small.txt'), 'keep me', 'utf8');
    await recordFileCheckpoint({
      snapshotId: 'snapshot_too_large',
      project,
      filePath: 'big.bin'
    });
    await recordFileCheckpoint({
      snapshotId: 'snapshot_too_large',
      project,
      filePath: 'small.txt'
    });

    const replacement = Buffer.alloc(8, 9);
    await writeFile(join(projectPath, 'big.bin'), replacement);
    await writeFile(join(projectPath, 'small.txt'), 'changed', 'utf8');

    const preview = await previewFileCheckpointChanges(project, 'snapshot_too_large');
    assert.deepEqual(preview.tooLargeFiles, ['big.bin']);
    assert.deepEqual(
      preview.changedFiles.map((file) => file.path),
      ['small.txt']
    );

    const restored = await restoreFileCheckpoint(project, 'snapshot_too_large');
    assert.deepEqual(restored.tooLargeFiles, ['big.bin']);
    assert.deepEqual(restored.restoredFiles, ['small.txt']);
    // No content was captured for the over-cap file, so rollback must not touch it.
    assert.ok((await readFile(join(projectPath, 'big.bin'))).equals(replacement));
    assert.equal(await readFile(join(projectPath, 'small.txt'), 'utf8'), 'keep me');
  } finally {
    delete process.env.FUNPLAY_CHECKPOINT_MAX_FILE_BYTES;
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('identical content captured twice in a run persists one shared blob', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-dedup-store-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-dedup-project-'));
  try {
    await initializeStore(userDataPath);
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'a.png'), PNG_LIKE_BYTES);
    await writeFile(join(projectPath, 'b.png'), PNG_LIKE_BYTES);
    await recordFileCheckpoint({
      snapshotId: 'snapshot_dedup',
      project,
      filePath: 'a.png'
    });
    await recordFileCheckpoint({
      snapshotId: 'snapshot_dedup',
      project,
      filePath: 'b.png'
    });

    const db = new Database(join(userDataPath, DB_FILE_NAME));
    try {
      const rows = db
        .prepare(
          'SELECT file_path, content, content_hash, is_binary FROM file_checkpoints WHERE snapshot_id = ? ORDER BY file_path ASC'
        )
        .all('snapshot_dedup') as Array<{
        file_path: string;
        content: string | null;
        content_hash: string | null;
        is_binary: number;
      }>;
      assert.equal(rows.length, 2);
      assert.ok(rows[0].content_hash, 'expected a persisted content hash');
      assert.equal(rows[0].content_hash, rows[1].content_hash);
      assert.deepEqual(
        rows.map((row) => row.is_binary),
        [1, 1]
      );
      assert.equal(rows.filter((row) => row.content !== null).length, 1, 'expected exactly one stored blob');

      // Loading resolves the dedup reference back to the shared blob.
      const entries = listFileCheckpointEntryRecords(db, 'snapshot_dedup');
      assert.equal(entries.length, 2);
      assert.equal(entries[0].content, entries[1].content);
      assert.ok(entries.every((entry) => entry.isBinary && entry.content !== undefined));
      assert.ok(Buffer.from(entries[0].content ?? '', 'base64').equals(PNG_LIKE_BYTES));
    } finally {
      db.close();
    }

    // Both files restore byte-identically even though one row is only a reference.
    await writeFile(join(projectPath, 'b.png'), Buffer.from([1, 2, 3]));
    const restored = await restoreFileCheckpoint(project, 'snapshot_dedup');
    assert.deepEqual(restored.restoredFiles, ['a.png', 'b.png']);
    assert.ok((await readFile(join(projectPath, 'b.png'))).equals(PNG_LIKE_BYTES));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('legacy text-only checkpoint rows still load after the v13 migration', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    // Old-format rows only carried snapshot_id/file_path/existed/content.
    db.prepare('INSERT INTO file_checkpoints (snapshot_id, file_path, existed, content) VALUES (?, ?, ?, ?)').run(
      'snapshot_legacy',
      'docs/readme.md',
      1,
      '# Legacy'
    );
    db.prepare('INSERT INTO file_checkpoints (snapshot_id, file_path, existed, content) VALUES (?, ?, ?, ?)').run(
      'snapshot_legacy',
      'docs/missing.md',
      0,
      null
    );

    const entries = listFileCheckpointEntryRecords(db, 'snapshot_legacy');
    assert.equal(entries.length, 2);

    const missing = entries[0];
    assert.equal(missing.path, 'docs/missing.md');
    assert.equal(missing.existed, false);
    assert.equal(missing.content, undefined);
    assert.equal(missing.isBinary, false);
    assert.equal(missing.tooLarge, false);

    const readme = entries[1];
    assert.equal(readme.path, 'docs/readme.md');
    assert.equal(readme.existed, true);
    assert.equal(readme.content, '# Legacy');
    assert.equal(readme.isBinary, false);
    assert.equal(readme.byteLength, undefined);
    assert.equal(readme.contentHash, undefined);
    assert.equal(readme.tooLarge, false);
  } finally {
    db.close();
  }
});

test('binary rows persist base64 content with byte length and hash metadata', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    upsertFileCheckpointEntryRecord(db, {
      snapshotId: 'snapshot_binary_row',
      filePath: 'textures/icon.png',
      existed: true,
      content: PNG_LIKE_BYTES.toString('base64'),
      isBinary: true,
      byteLength: PNG_LIKE_BYTES.byteLength,
      contentHash: 'a'.repeat(64)
    });

    const [entry] = listFileCheckpointEntryRecords(db, 'snapshot_binary_row');
    assert.equal(entry.path, 'textures/icon.png');
    assert.equal(entry.isBinary, true);
    assert.equal(entry.byteLength, PNG_LIKE_BYTES.byteLength);
    assert.equal(entry.contentHash, 'a'.repeat(64));
    assert.equal(entry.tooLarge, false);
    assert.ok(Buffer.from(entry.content ?? '', 'base64').equals(PNG_LIKE_BYTES));
  } finally {
    db.close();
  }
});
