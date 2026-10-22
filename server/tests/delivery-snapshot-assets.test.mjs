import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { registerDeliverySnapshotAssets } from '../src/delivery-snapshot-assets.mjs';
import { drainReferenceCleanup, scheduleReferenceCleanupForAsset } from '../src/image-reference-cleanup.mjs';
import { cleanReassignmentFiles } from '../src/secondary-assignment.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('snapshot asset registration rejects nonabsolute paths before querying', async () => {
  const client = { query() { assert.fail('invalid input must not reach the database'); } };
  await assert.rejects(registerDeliverySnapshotAssets(client, randomUUID(), [{
    storagePath: '../asset.png', sha256: 'a'.repeat(64), byteSize: 4, taskId: 1,
  }]), /绝对存储路径/u);
});

test('snapshot protection and cleanup serialize against real PostgreSQL and files', {
  skip: process.env.RUN_DELIVERY_SNAPSHOT_ASSETS_POSTGRES !== '1', timeout: 120_000,
}, async t => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString });
  const root = await mkdtemp(join(tmpdir(), 'xhs-snapshot-assets-'));
  let nextId = 0;
  try {
    await pool.query(`
      CREATE TABLE tasks(id bigint PRIMARY KEY);
      CREATE TABLE assets(id bigint PRIMARY KEY,task_id bigint,storage_path text UNIQUE,sha256 char(64),
        byte_size bigint,content_cleared_at timestamptz,asset_role text,active boolean DEFAULT true);
      CREATE TABLE image_edit_requests(id uuid PRIMARY KEY,status text);
      CREATE TABLE image_edit_reference_assets(asset_id bigint,request_id uuid);
      CREATE TABLE image_reference_cleanup_jobs(asset_id bigint PRIMARY KEY,task_id bigint,storage_path text,
        sha256 char(64),next_attempt_at timestamptz DEFAULT now(),attempts integer DEFAULT 0,last_error text);
      CREATE TABLE task_reassignment_cases(id bigint PRIMARY KEY,reset_status text,cleanup_status text);
      CREATE TABLE task_reassignment_cleanup(id bigserial PRIMARY KEY,case_id bigint,task_id bigint,
        storage_path text,cleaned_at timestamptz,error text,UNIQUE(case_id,storage_path));
    `);
    await pool.query(await readFile(new URL('../migrations/0120_delivery_snapshot_assets.sql', import.meta.url), 'utf8'));
    async function fixture(role = 'REFERENCE') {
      const id = ++nextId, bytes = Buffer.from(`immutable snapshot image ${id}`);
      const dir = join(root, role === 'REFERENCE' ? 'image-edits' : 'tasks', String(id));
      await mkdir(dir, { recursive: true });
      const storagePath = join(dir, `${randomUUID()}.png`), sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(storagePath, bytes);
      await pool.query('INSERT INTO tasks(id) VALUES($1)', [id]);
      await pool.query(`INSERT INTO assets(id,task_id,storage_path,sha256,byte_size,asset_role)
        VALUES($1,$1,$2,$3,$4,$5)`, [id, storagePath, sha256, bytes.length, role]);
      return { taskId: id, assetId: id, storagePath, sha256, byteSize: bytes.length };
    }
    async function transaction(action) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    async function enqueueReference(asset) {
      await pool.query(`INSERT INTO image_reference_cleanup_jobs(asset_id,task_id,storage_path,sha256)
        VALUES($1,$2,$3,$4)`, [asset.assetId, asset.taskId, asset.storagePath, asset.sha256]);
    }

    await t.test('protected references cannot be queued or tombstoned; corrupt bytes cannot register', async () => {
      const asset = await fixture(), snapshotId = randomUUID();
      await transaction(client => registerDeliverySnapshotAssets(client, snapshotId, [asset]));
      await transaction(client => registerDeliverySnapshotAssets(client, snapshotId, [asset]));
      assert.equal((await pool.query('SELECT count(*) FROM delivery_snapshot_assets WHERE snapshot_public_id=$1', [snapshotId])).rows[0].count, '1');
      await assert.rejects(transaction(client => scheduleReferenceCleanupForAsset(client, asset.taskId, asset.assetId)),
        { code: 'DELIVERY_SNAPSHOT_ASSET_IN_USE' });
      const current = (await pool.query('SELECT active,content_cleared_at FROM assets WHERE id=$1', [asset.assetId])).rows[0];
      assert.deepEqual(current, { active: true, content_cleared_at: null });
      assert.equal((await pool.query('SELECT count(*) FROM image_reference_cleanup_jobs')).rows[0].count, '0');
      await writeFile(asset.storagePath, 'changed');
      await assert.rejects(transaction(client => registerDeliverySnapshotAssets(client, randomUUID(), [asset])),
        { code: 'DELIVERY_SNAPSHOT_ASSET_CHANGED' });
    });

    await t.test('already queued cleanup waits for snapshot registration and preserves the file', async () => {
      const asset = await fixture();
      await enqueueReference(asset);
      const publisher = await pool.connect();
      let unblock, verified;
      const waitForVerification = new Promise(resolve => { verified = resolve; });
      const gate = new Promise(resolve => { unblock = resolve; });
      let cleanup;
      try {
        await publisher.query('BEGIN');
        const pid = (await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const publishing = registerDeliverySnapshotAssets(publisher, randomUUID(), [asset], {
          verify: async value => { assert.equal(value.storagePath, asset.storagePath); verified(); await gate; },
        });
        await waitForVerification;
        cleanup = drainReferenceCleanup(pool, root, { assetId: asset.assetId });
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!blocked && Date.now() < deadline) {
          blocked = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked`, [pid])).rows[0].blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'cleanup must wait on the registration transaction, not race its file check');
        unblock();
        await publishing;
        await publisher.query('COMMIT');
        assert.deepEqual(await cleanup, { processed: 1, failed: 0 });
        await access(asset.storagePath);
      } finally {
        unblock();
        await publisher.query('ROLLBACK');
        publisher.release();
        await cleanup?.catch(() => {});
      }
    });

    await t.test('cleanup winning first cannot leave a new snapshot pointing to removed bytes', async () => {
      const asset = await fixture();
      await transaction(client => scheduleReferenceCleanupForAsset(client, asset.taskId, asset.assetId));
      assert.deepEqual(await drainReferenceCleanup(pool, root, { assetId: asset.assetId }), { processed: 1, failed: 0 });
      await assert.rejects(access(asset.storagePath), { code: 'ENOENT' });
      await assert.rejects(transaction(client => registerDeliverySnapshotAssets(client, randomUUID(), [asset])),
        { code: 'DELIVERY_SNAPSHOT_ASSET_CHANGED' });
      assert.equal((await pool.query('SELECT count(*) FROM delivery_snapshot_assets WHERE storage_path=$1', [asset.storagePath])).rows[0].count, '0');
    });

    await t.test('secondary assignment pending jobs preserve snapshot originals and thumbnails', async () => {
      const asset = await fixture('DELIVERY');
      const thumbnail = join(root, 'thumbnails', String(asset.taskId), `${asset.assetId}-${asset.sha256}-thumb-480-v1.webp`);
      await mkdir(join(root, 'thumbnails', String(asset.taskId)), { recursive: true });
      await writeFile(thumbnail, 'thumbnail');
      await transaction(client => registerDeliverySnapshotAssets(client, randomUUID(), [asset]));
      await pool.query("INSERT INTO task_reassignment_cases VALUES($1,'READY','PENDING')", [asset.taskId]);
      await pool.query('INSERT INTO task_reassignment_cleanup(case_id,task_id,storage_path) VALUES($1,$1,$2)', [asset.taskId, asset.storagePath]);
      await cleanReassignmentFiles(pool, asset.taskId, root);
      await access(asset.storagePath);
      await access(thumbnail);
      assert.equal((await pool.query('SELECT cleanup_status FROM task_reassignment_cases WHERE id=$1', [asset.taskId])).rows[0].cleanup_status, 'COMPLETE');
      assert.equal((await pool.query('SELECT count(*) FROM task_reassignment_cleanup WHERE case_id=$1 AND cleaned_at IS NULL', [asset.taskId])).rows[0].count, '0');
    });
  } finally {
    await pool.end();
    await database.stop();
    assert.ok(root.startsWith(join(tmpdir(), 'xhs-snapshot-assets-')));
    await rm(root, { recursive: true, force: true });
  }
});
