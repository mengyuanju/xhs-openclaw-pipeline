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
