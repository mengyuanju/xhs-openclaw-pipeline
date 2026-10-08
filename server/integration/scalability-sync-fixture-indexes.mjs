import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runningTemporaryFixture, waitForFixture } from './scalability-report-check.mjs';
import { migrateDatabase, normalizeMigrationSql, sha256 } from '../src/database-migrations.mjs';

let pool;
try {
  await waitForFixture();
  pool = await runningTemporaryFixture();
  const sql = normalizeMigrationSql(await readFile(new URL('../migrations/0105_scalable_dedup_covering_index.sql', import.meta.url), 'utf8'));
  const checksum = sha256(sql);
  const old = (await pool.query("SELECT sha256 FROM control_plane_migrations WHERE id='0105_scalable_dedup_covering_index'")).rows[0];
  if (old.sha256 !== checksum) {
    await pool.query('BEGIN');
    try {
      await pool.query('DROP INDEX IF EXISTS tasks_content_query_identity_cover_idx');
      await pool.query('DROP INDEX IF EXISTS tasks_content_query_identity_long_idx');
      await pool.query(sql);
      // This disposable fixture was created during implementation. Record the
      // final migration after replacing its draft indexes; never use on a real DB.
      await pool.query("UPDATE control_plane_migrations SET sha256=$1 WHERE id='0105_scalable_dedup_covering_index'", [checksum]);
      await pool.query('COMMIT');
    } catch (error) { await pool.query('ROLLBACK'); throw error; }
  }
  const applied = await migrateDatabase(pool);
  const record = JSON.parse(await readFile(resolve('reports/scalability-fixture-2026-10-01.json'), 'utf8'));
  await writeFile(resolve('reports/scalability-fixture-schema-ready.json'), `${JSON.stringify({
    startedAt: record.startedAt, isolatedTemporaryPostgres: true, migration0105: checksum, applied,
    measuredAt: new Date().toISOString() }, null, 2)}\n`);
  console.log('Temporary fixture indexes and pending migrations match final source.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await pool?.end(); }
