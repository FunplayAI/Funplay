import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../../electron/main/store-internal/migrations.ts';
import {
  getSubagentRunRecord,
  listSubagentRunRecords,
  markRunningSubagentRunRecordsInterrupted,
  upsertSubagentRunRecord
} from '../../electron/main/store-internal/subagent-runs.ts';

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function readVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

function listTables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test('v14 migration creates the subagent_runs table', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    assert.equal(readVersion(db), LATEST_VERSION);
    assert.ok(listTables(db).includes('subagent_runs'));

    const columns = (db.prepare("PRAGMA table_info('subagent_runs')").all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    for (const expected of [
      'id',
      'parent_session_id',
      'status',
      'agent_name',
      'prompt',
      'started_at',
      'finished_at',
      'result_summary'
    ]) {
      assert.ok(columns.includes(expected), `expected subagent_runs.${expected} after v14 migration`);
    }
  } finally {
    db.close();
  }
});

test('v14 migration is reachable from a v13-stamped database', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE subagent_runs');
    db.exec('PRAGMA user_version = 13');
    assert.equal(readVersion(db), 13);

    runMigrations(db);

    assert.equal(readVersion(db), LATEST_VERSION);
    assert.ok(listTables(db).includes('subagent_runs'));
  } finally {
    db.close();
  }
});

test('subagent run records round-trip through upsert, get, and list', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);

    upsertSubagentRunRecord(db, {
      id: 'subagent_round_trip',
      parentSessionId: 'session_a',
      status: 'running',
      agentName: 'code-reviewer',
      prompt: '检查 src 目录的入口文件',
      startedAt: '2026-06-11T01:00:00.000Z'
    });

    const running = getSubagentRunRecord(db, 'subagent_round_trip');
    assert.equal(running?.status, 'running');
    assert.equal(running?.parentSessionId, 'session_a');
    assert.equal(running?.agentName, 'code-reviewer');
    assert.equal(running?.prompt, '检查 src 目录的入口文件');
    assert.equal(running?.finishedAt, undefined);
    assert.equal(running?.resultSummary, undefined);

    upsertSubagentRunRecord(db, {
      id: 'subagent_round_trip',
      parentSessionId: 'session_a',
      status: 'completed',
      agentName: 'code-reviewer',
      prompt: '检查 src 目录的入口文件',
      startedAt: '2026-06-11T01:00:00.000Z',
      finishedAt: '2026-06-11T01:05:00.000Z',
      resultSummary: '入口在 src/index.ts。'
    });

    const completed = getSubagentRunRecord(db, 'subagent_round_trip');
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.finishedAt, '2026-06-11T01:05:00.000Z');
    assert.equal(completed?.resultSummary, '入口在 src/index.ts。');

    upsertSubagentRunRecord(db, {
      id: 'subagent_other_session',
      parentSessionId: 'session_b',
      status: 'running',
      prompt: '其他会话任务',
      startedAt: '2026-06-11T02:00:00.000Z'
    });

    const sessionA = listSubagentRunRecords(db, 'session_a');
    assert.deepEqual(
      sessionA.map((record) => record.id),
      ['subagent_round_trip']
    );
    const all = listSubagentRunRecords(db);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.id, 'subagent_other_session', 'expected newest record first');
    assert.equal(getSubagentRunRecord(db, 'missing'), undefined);
  } finally {
    db.close();
  }
});

test('records still running at startup are marked interrupted', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    upsertSubagentRunRecord(db, {
      id: 'subagent_running',
      parentSessionId: 'session_a',
      status: 'running',
      prompt: '重启时仍在运行',
      startedAt: '2026-06-11T03:00:00.000Z'
    });
    upsertSubagentRunRecord(db, {
      id: 'subagent_done',
      parentSessionId: 'session_a',
      status: 'completed',
      prompt: '已经完成',
      startedAt: '2026-06-11T02:00:00.000Z',
      finishedAt: '2026-06-11T02:10:00.000Z',
      resultSummary: 'done'
    });

    markRunningSubagentRunRecordsInterrupted(db);

    const interrupted = getSubagentRunRecord(db, 'subagent_running');
    assert.equal(interrupted?.status, 'interrupted');
    assert.ok(interrupted?.finishedAt, 'expected interrupted record to get a finished_at timestamp');
    assert.match(interrupted?.resultSummary ?? '', /restarted/i);

    const untouched = getSubagentRunRecord(db, 'subagent_done');
    assert.equal(untouched?.status, 'completed');
    assert.equal(untouched?.finishedAt, '2026-06-11T02:10:00.000Z');
    assert.equal(untouched?.resultSummary, 'done');
  } finally {
    db.close();
  }
});

test('finished subagent run records are pruned beyond the keep limit while running records stay', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    upsertSubagentRunRecord(db, {
      id: 'subagent_keep_running',
      parentSessionId: 'session_a',
      status: 'running',
      prompt: 'long running',
      startedAt: '2020-01-01T00:00:00.000Z'
    });
    for (let index = 0; index < 110; index += 1) {
      upsertSubagentRunRecord(db, {
        id: `subagent_finished_${String(index).padStart(3, '0')}`,
        parentSessionId: 'session_a',
        status: 'completed',
        prompt: `task ${index}`,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(),
        resultSummary: 'ok'
      });
    }

    const total = (db.prepare('SELECT COUNT(*) AS count FROM subagent_runs').get() as { count: number }).count;
    assert.equal(total, 101, 'expected 100 finished records plus the running one');
    assert.equal(getSubagentRunRecord(db, 'subagent_keep_running')?.status, 'running');
    assert.equal(getSubagentRunRecord(db, 'subagent_finished_000'), undefined, 'oldest finished record pruned');
    assert.equal(getSubagentRunRecord(db, 'subagent_finished_109')?.status, 'completed');
  } finally {
    db.close();
  }
});
