import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration, parseOptions, packagePath, quoteId, rowBatches, safeError } from '../scripts/database-common.mjs';
import { assertCompatibleTable, assertEmptyDatabase, identityCheckSql, mergeSql, upgradeDatabase } from '../scripts/manage-database.mjs';
import { loadMigrations, normalizeMigrationSql, pendingMigrations } from '../src/database-migrations.mjs';

test('database options require explicit apply and reject unknown or malformed arguments', () => {
  assert.deepEqual(parseOptions(['--from=backup'], ['from','apply']), { from: 'backup' });
  assert.deepEqual(parseOptions(['--apply'], ['apply']), { apply: true });
  for (const args of [['--apply=false'],['--apply','--apply'],['--drop'],['--from']]) {
    assert.throws(() => parseOptions(args, ['from','apply']));
  }
});

test('database credentials stay in child environment and are removed from diagnostics', () => {
  const config = configuration({ DATABASE_URL: 'postgresql://user:test%40secret@localhost:5433/test_db' });
  assert.equal(config.environment.PGPASSWORD, 'test@secret');
  assert.equal(config.environment.PGPORT, '5433');
  assert.equal(config.display, 'localhost:5433/test_db');
  assert.doesNotMatch(safeError(new Error(config.connectionString + ' test@secret'), config), /secret|postgresql/u);
  assert.throws(() => configuration({ DATABASE_URL: 'postgresql://localhost/test?unexpected=1' }), /Unsupported/u);
});

test('backup paths and SQL identifiers cannot escape their boundaries', () => {
  for (const path of ['../outside', '..\\outside', '', 'C:\\elsewhere']) assert.throws(() => packagePath(join(tmpdir(), 'backup'), path));
  assert.equal(quoteId('a"b'), '"a""b"');
});

test('incremental SQL uses typed parameterized JSON, upserts and skips generated fields', () => {
  const table = { schema: 'public', name: 'tasks', primaryKey: ['id'], columns: [
    { name: 'id', type: 'bigint', generated: '', identity: 'a' },
    { name: 'created_at', type: 'timestamp', generated: '', identity: '' },
    { name: 'calculated', type: 'text', generated: 's', identity: '' },
  ] };
  assert.match(mergeSql(table), /OVERRIDING SYSTEM VALUE/u);
  assert.match(mergeSql(table), /\$1::json/u);
  assert.match(mergeSql(table), /ON CONFLICT \("id"\) DO UPDATE/u);
  assert.match(mergeSql(table), /IS DISTINCT FROM/u);
  assert.doesNotMatch(mergeSql(table), /calculated|DELETE|TRUNCATE/u);
  assert.match(identityCheckSql(table), /created_at/u);
  assertCompatibleTable(table, structuredClone(table));
  assert.throws(() => assertCompatibleTable(table, { ...table, columns: [] }), /Schema mismatch/u);
  assert.throws(() => assertCompatibleTable({ ...table, primaryKey: [] }, { ...table, primaryKey: [] }), /no primary key/u);
});

test('full import refuses an existing table even if that table contains no rows', async () => {
  await assert.rejects(assertEmptyDatabase({ query: async () => ({ rows: [{ relname: 'tasks' }] }) }), /not empty/u);
});

test('migration baseline has no nested transactions and detects checksum drift', async () => {
  assert.equal(normalizeMigrationSql('SELECT 1;\r\nSELECT 2;\r\n'), 'SELECT 1;\nSELECT 2;\n');
  const migrations = await loadMigrations();
  assert.equal(migrations[0].id, '0001_baseline');
  assert.doesNotMatch(migrations[0].sql, /^BEGIN;|COMMIT;\s*$/u);
  const fake = { query: async (sql) => ({ rows: sql.includes('to_regclass') ? [{ name: 'present' }] : [{ id: migrations[0].id, sha256: 'changed' }] }) };
  await assert.rejects(pendingMigrations(fake, migrations), /missing or changed/u);
});

test('failed-image migration only requeues tasks and preserves approved copy and failure history', async () => {
  const migrations = await loadMigrations();
  const migration = migrations.find((item) => item.id === '0002_requeue_failed_images');
  assert.ok(migration);
  assert.match(migration.sql, /state = 'IMAGE_QUEUED'/u);
  assert.match(migration.sql, /WHERE t.state = 'IMAGE_FAILED'/u);
  assert.match(migration.sql, /SELECT e.snapshot FROM public.task_executions/u);
  assert.match(migration.sql, /current_execution_id = NULL/u);
  assert.match(migration.sql, /finished_at = NULL/u);
  assert.doesNotMatch(migration.sql, /DELETE|TRUNCATE|DROP|UPDATE public.copy_revisions|current_copy_revision_id\s*=|error\s*=/u);
});

test('task creator migration preserves unattributed history and adds an ownership index', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0003_task_creator');
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS created_by_user_id varchar\(100\)/u);
  assert.match(migration.sql, /ON tasks\(created_by_user_id, id DESC\)/u);
  assert.doesNotMatch(migration.sql, /DEFAULT|NOT NULL|UPDATE tasks|DELETE|DROP/u);
});

test('manual archive migration merges both former delivery states without deleting task history', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0006_manual_archive');
  assert.ok(migration);
  assert.match(migration.sql, /WHERE state IN \('DELIVERY_REVIEW_PENDING', 'COMPLETED'\)/u);
  assert.match(migration.sql, /state = 'MANUAL_ARCHIVE'/u);
  assert.match(migration.sql, /ADD CONSTRAINT tasks_state_check/u);
  assert.doesNotMatch(migration.sql, /DELETE|TRUNCATE|DROP TABLE/u);
});

test('task AI disclosure migration adds a default-on boolean without rewriting task history', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0009_task_ai_disclosure');
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS ai_disclosure_enabled boolean NOT NULL DEFAULT true/u);
  assert.doesNotMatch(migration.sql, /UPDATE|DELETE|TRUNCATE|DROP/u);
});

test('shared copy queue migration unassigns only waiting copy tasks and replaces the queue index', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0010_shared_copy_queue');
  assert.ok(migration);
  assert.match(migration.sql, /ALTER COLUMN copy_executor_node_id DROP NOT NULL/u);
  assert.match(migration.sql, /copy_executor_node_id = NULL/u);
  assert.match(migration.sql, /WHERE state = 'COPY_QUEUED'/u);
  assert.match(migration.sql, /ON public\.tasks\(id\) WHERE state = 'COPY_QUEUED'/u);
  assert.doesNotMatch(migration.sql, /DELETE|TRUNCATE|DROP TABLE/u);
});

test('admin task deletion migration adds bounded nullable security fields without rewriting data', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0014_admin_task_deletion');
  assert.ok(migration);
  assert.match(migration.sql, /deletion_password_hash varchar\(500\)/u);
  assert.match(migration.sql, /cancelled_from_state varchar\(40\)/u);
  assert.match(migration.sql, /cancelled_from_state IS NULL OR cancelled_from_state IN/u);
  assert.match(migration.sql, /'COPY_RUNNING'/u);
  assert.match(migration.sql, /'IMAGE_RUNNING'/u);
  assert.doesNotMatch(migration.sql, /UPDATE|DELETE|TRUNCATE|DROP/u);
});

test('saved task view migration keeps views owner-scoped without rewriting tasks', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0015_saved_task_views');
  assert.ok(migration);
  assert.match(migration.sql, /owner_username varchar\(50\) NOT NULL REFERENCES app_users\(username\) ON DELETE CASCADE/u);
  assert.match(migration.sql, /filters jsonb NOT NULL/u);
  assert.match(migration.sql, /UNIQUE\(owner_username, name\)/u);
  assert.doesNotMatch(migration.sql, /UPDATE tasks|DELETE FROM tasks|TRUNCATE|DROP TABLE/u);
});

test('human quality migration stores immutable version-bound ratings and idempotency keys', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0016_human_quality_assessments');
  assert.ok(migration);
  assert.match(migration.sql, /score_x10 smallint NOT NULL CHECK \(score_x10 IN \(10, 20, 25, 30\)\)/u);
  assert.match(migration.sql, /copy_revision_id bigint REFERENCES copy_revisions\(id\)/u);
  assert.match(migration.sql, /image_run_id uuid REFERENCES image_runs\(id\)/u);
  assert.match(migration.sql, /review_session_id uuid NOT NULL/u);
  assert.match(migration.sql, /UNIQUE INDEX[\s\S]*review_session_id, copy_revision_id/u);
  assert.match(migration.sql, /UNIQUE INDEX[\s\S]*review_session_id, image_run_id/u);
  assert.doesNotMatch(migration.sql, /UPDATE tasks|UPDATE copy_revisions|UPDATE image_runs|DELETE FROM|TRUNCATE|DROP TABLE/u);
});

test('failed upgrades roll back the enclosing schema-and-data transaction', async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql === 'BROKEN MIGRATION') throw new Error('simulated migration failure');
    return { rows: [] };
  } };
  await assert.rejects(upgradeDatabase(client, null, [{ id: '0001_baseline', sha256: 'fake', sql: 'BROKEN MIGRATION' }]), /simulated/u);
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(!queries.includes('COMMIT'));
});

test('streaming data batches preserve bigint and JSON text without numeric coercion', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-db-unit-'));
  try {
    const file = join(folder, 'rows.jsonl');
    await writeFile(file, '{"id":9007199254740993}\n{"id":9007199254740994}\n');
    const batches = [];
    for await (const batch of rowBatches(file, 1)) batches.push(batch);
    assert.deepEqual(batches, [['{"id":9007199254740993}'], ['{"id":9007199254740994}']]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
