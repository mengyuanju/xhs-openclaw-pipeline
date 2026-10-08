import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { createPostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { createStandaloneImageEditor } from '../src/standalone-image-editor.mjs';

test('binary HTTP uploads remain atomic, idempotent and isolated with 30 concurrent users',
  { skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 150_000 }, async () => {
    const database = await startTemporaryPostgres18('binary-upload-pg-');
    const pool = new pg.Pool({ connectionString: database.connectionString, max: 4 });
    const storageRoot = await mkdtemp(join(tmpdir(), 'binary-upload-pg-assets-'));
    let app, server;
    try {
      await migrateDatabase(pool);
      const users = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,must_change_password)
        SELECT 'binary-user-'||i,'binary-user-'||i,'USER','fake-only',false FROM generate_series(1,30) i RETURNING *`)).rows;
      const repository = createPostgresControlPlaneRepository({ pool });
      app = createControlPlaneApp({ repository, storageRoot, reportProjectionEnabled: false, logger: { info() {}, error() {} } });
      server = await new Promise(done => { const value = app.listen(0, '127.0.0.1', () => done(value)); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = user => ({ 'x-actor-user-id': String(user.id), 'x-actor-username': user.username,
        'x-actor-role': user.role, 'x-actor-credential-version': String(user.credential_version) });
      const request = (path, user, { method = 'GET', body, binary = false } = {}) => fetch(base + path, { method,
        headers: { ...headers(user), 'content-type': binary ? 'image/png' : 'application/json' },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
      const png = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: 'white' } }).png().toBuffer();
      const wrong = await sharp({ create: { width: 10, height: 10, channels: 4, background: 'white' } }).png().toBuffer();
      const stage = async (requestId, index, user, bytes = png) => {
        const response = await request(`/v1/image-editor/uploads/${requestId}/${index}`, user, { method: 'POST', body: bytes, binary: true });
        assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).data;
      };
      assert.equal((await (await request('/v1/image-editor/limits', users[0])).json()).data.binaryUploadVersion, 1);
      const started = Date.now();
      const results = await Promise.all(users.map(async user => {
        const requestId = randomUUID();
        const uploads = await Promise.all([1, 2].map(index => stage(requestId, index, user)));
        const input = { requestId, title: 'parallel binary upload', uploads };
        const response = await request('/v1/image-editor/workspaces', user, { method: 'POST', body: input });
        assert.equal(response.status, 201, await response.clone().text());
        const workspace = (await response.json()).data;
        assert.equal(workspace.assets.length, 2);
        assert.equal((await (await request('/v1/image-editor/workspaces', user, { method: 'POST', body: input })).json()).data.id, workspace.id);
        assert.equal((await request(`/v1/image-editor/workspaces/${workspace.id}`, users.find(other => other.id !== user.id))).status, 403);
        const state = await request(`/v1/image-editor/workspaces/${workspace.id}/image-edits/state`, user);
        assert.equal(state.status, 200); assert.deepEqual((await state.json()).data.items, []);
        const asset = await request(`/v1/image-editor/assets/${workspace.assets[0].id}`, user);
        assert.equal(asset.status, 200); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
        return { requestId, workspaceId: workspace.id, input, user };
      }));
      assert.equal(new Set(results.map(item => item.workspaceId)).size, 30);
      assert.equal(Number((await pool.query('SELECT count(*) FROM standalone_image_workspaces')).rows[0].count), 30);
      const one = results[0];
      assert.equal((await request('/v1/image-editor/workspaces', one.user, { method: 'POST', body: { ...one.input, title: 'conflicting title' } })).status, 409);
      assert.equal((await request('/v1/image-editor/workspaces', users[1], { method: 'POST', body: one.input })).status, 400);
      const partial = randomUUID(), first = await stage(partial, 1, users[0]);
      assert.equal((await request(`/v1/image-editor/uploads/${partial}/2`, users[0], { method: 'POST', body: wrong, binary: true })).status, 400);
      assert.equal((await request('/v1/image-editor/workspaces', users[0], { method: 'POST', body: { requestId: partial, uploads: [first, { index: 2, token: randomUUID() }] } })).status, 400);
      assert.equal(Number((await pool.query('SELECT count(*) FROM standalone_image_workspaces')).rows[0].count), 30, 'failed multi-image commit creates no task');
      assert.equal((await request(`/v1/image-editor/uploads/${partial}`, users[0], { method: 'DELETE' })).status, 200);
      assert.equal((await request(`/v1/image-editor/uploads/${randomUUID()}/1`, users[0], { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024 + 1), binary: true })).status, 413);
      assert.equal((await readdir(join(storageRoot, 'image-editor-upload-staging'))).filter(name => name.endsWith('.png')).length, 0);
      let lostDetail = true;
      const recovering = createStandaloneImageEditor({ storageRoot, pool: { connect: () => pool.connect(),
        query(sql, values) {
          if (lostDetail && String(sql).startsWith('SELECT w.*,t.current_image_run_id')) { lostDetail = false; throw new Error('response detail lost after COMMIT'); }
          return pool.query(sql, values);
        },
      } });
      const actor = { userId: Number(users[0].id), username: users[0].username, role: 'USER', credentialVersion: users[0].credential_version };
      const recoveryId = randomUUID(), receipt = await recovering.uploads.stage(recoveryId, 1, png, 'image/png', actor);
      const recoveryInput = { requestId: recoveryId, uploads: [receipt] };
      await assert.rejects(recovering.create(recoveryInput, actor), /lost after COMMIT/u);
      assert.equal((await readdir(join(storageRoot, 'image-editor-upload-staging'))).filter(name => name.endsWith('.png')).length, 1);
      const recovered = await recovering.create(recoveryInput, actor);
      assert.ok(recovered.id);
      assert.equal((await readdir(join(storageRoot, 'image-editor-upload-staging'))).filter(name => name.endsWith('.png')).length, 0);
      assert.equal((await recovering.create(recoveryInput, actor)).id, recovered.id);
      assert.equal(Number((await pool.query('SELECT count(*) FROM standalone_image_workspaces WHERE request_id=$1', [recoveryId])).rows[0].count), 1);
      await recovering.uploads.dispose();
      assert.equal(Number((await pool.query('SELECT count(*) FROM model_call_traces')).rows[0].count), 0);
      await writeFile('reports/performance-round2-binary-concurrency.json', JSON.stringify({ users: 30, images: 60,
        durationMs: Date.now() - started, database: 'isolated PostgreSQL 18 temporary database', modelCalls: 0,
        atomicValidation: true, ownership: true, retries: true, lostCommittedDetailRecovered: true, stagingFilesRemaining: 0 }, null, 2));
    } finally {
      if (server) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); }
      await app?.context.disposeControlPlaneResources?.(); await pool.end(); await database.stop(); await rm(storageRoot, { recursive: true, force: true });
    }
  });
