import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  applyMigrations, loadMigrations, normalizeMigrationSql, pendingMigrations, sha256,
} from '../src/database-migrations.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const editorId = '0082_standalone_image_editor';
const repairId = '0083_standalone_image_editor_compatibility_repair';
async function legacyMigration() {
  const sql = normalizeMigrationSql(await readFile(new URL('./fixtures/0082_standalone_image_editor.legacy.sql', import.meta.url), 'utf8'));
  return { id: editorId, sql, sha256: sha256(sql) };
}

test('0082 accepts only its known draft with the exact 0083 repair and rejects downgrade', async () => {
  const migrations = await loadMigrations();
  const legacy = await legacyMigration();
  const canonical = migrations.find(({ id }) => id === editorId);
  const clientWith = entry => ({ query: async sql => ({
    rows: sql.includes('to_regclass') ? [{ name: 'present' }] : [entry],
  }) });
  const pending = await pendingMigrations(clientWith(legacy), migrations);
  assert.ok(pending.some(({ id }) => id === repairId));
  assert.ok(!pending.some(({ id }) => id === editorId));
  for (const sources of [
    migrations.filter(({ id }) => id !== repairId),
    migrations.map(m => m.id === repairId ? { ...m, sha256: '0'.repeat(64) } : m),
    migrations.map(m => m.id === editorId ? { ...m, sha256: '0'.repeat(64) } : m),
  ]) {
    await assert.rejects(pendingMigrations(clientWith(legacy), sources), /0082.*missing or changed/u);
  }
  await assert.rejects(pendingMigrations(clientWith({ ...legacy, sha256: '1'.repeat(64) }), migrations), /0082.*missing or changed/u);
  await assert.rejects(pendingMigrations(clientWith(canonical), migrations.map(m => m.id === editorId ? legacy : m)), /0082.*missing or changed/u);
});

test('0083 repairs draft and finalized databases, preserves rows and ledger, and validates old data',
  { skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 150000 }, async t => {
    const database = await startTemporaryPostgres18('image-editor-migration-pg-');
    const client = new pg.Client({ connectionString: database.connectionString });
    try {
      await client.connect();
      const migrations = await loadMigrations();
      const legacy = await legacyMigration();
      const canonical = migrations.find(({ id }) => id === editorId);
      for (const [label, source, invalid] of [
        ['early draft', legacy, false], ['finalized 0082', canonical, false], ['invalid legacy data', legacy, true],
      ]) {
        await t.test(label, async () => {
          await client.query('BEGIN');
          try {
            await applyMigrations(client, migrations.filter(m => m.id <= editorId).map(m => m.id === editorId ? source : m));
            await client.query("INSERT INTO executor_nodes(id,name) VALUES ('migration-test','migration-test')");
            const user = (await client.query("INSERT INTO app_users(username,display_name,role,password_hash) VALUES ('migration-test','migration-test','USER','test-only') RETURNING id")).rows[0];
            const task = (await client.query(`INSERT INTO tasks(query,created_by_node_id,state,task_kind,mandatory_copy_qc,mandatory_image_qc)
              VALUES ('uploaded image','migration-test',$1,'STANDALONE_IMAGE_EDIT',false,false) RETURNING id`,
            [invalid ? 'COPY_QUEUED' : 'MANUAL_ARCHIVE'])).rows[0];
            await client.query(`INSERT INTO standalone_image_workspaces(task_id,owner_id,request_id,upload_hash,title,limits)
              VALUES ($1,$2,'00000000-0000-4000-8000-000000000001',$3,'original upload','{}')`, [task.id,user.id,'a'.repeat(64)]);
            await client.query("INSERT INTO tasks(query,created_by_node_id,state) VALUES ('ordinary task','migration-test','COPY_QUEUED')");
            const snapshot = async () => ({
              tasks: (await client.query('SELECT * FROM tasks ORDER BY id')).rows,
              workspaces: (await client.query('SELECT * FROM standalone_image_workspaces ORDER BY task_id')).rows,
            });
            const before = await snapshot();
            if (invalid) {
              await client.query('SAVEPOINT repair_attempt');
              await assert.rejects(applyMigrations(client, migrations), error => error.code === '23514');
              await client.query('ROLLBACK TO SAVEPOINT repair_attempt');
              assert.equal((await client.query('SELECT id FROM control_plane_migrations WHERE id=$1',[repairId])).rowCount, 0);
            } else {
              assert.deepEqual(await applyMigrations(client, migrations), [repairId]);
              assert.deepEqual(await applyMigrations(client, migrations), []);
              assert.equal((await client.query("SELECT convalidated FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='standalone_image_workspace_state'")).rows[0].convalidated, true);
              for (const assignment of ["state='COPY_QUEUED'", 'mandatory_copy_qc=true', 'mandatory_image_qc=true']) {
                await client.query('SAVEPOINT invalid_workspace');
                await assert.rejects(client.query(`UPDATE tasks SET ${assignment} WHERE id=$1`,[task.id]), error => error.constraint === 'standalone_image_workspace_state');
                await client.query('ROLLBACK TO SAVEPOINT invalid_workspace');
              }
            }
            assert.deepEqual(await snapshot(), before);
            assert.equal((await client.query('SELECT sha256 FROM control_plane_migrations WHERE id=$1',[editorId])).rows[0].sha256, source.sha256);
          } finally { await client.query('ROLLBACK'); }
        });
      }
    } finally { await client.end(); await database.stop(); }
  });
