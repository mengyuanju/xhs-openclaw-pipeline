// Always use a disposable local cluster. Never load DATABASE_URL or .env.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { createControlPlaneClient } from '../../src/control-plane/client.mjs';
import { verifyExecutionRecovery } from './fixtures/execution-recovery.mjs';

test('isolated PostgreSQL: execution recovery over HTTP', { timeout: 60000 }, async t => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to the installed PostgreSQL bin directory');
  const root = await mkdtemp(join(tmpdir(), 'xhs-recovery-pg-'));
  const data = join(root, 'data'), log = join(root, 'commands.log');
  let started = false, pool, http;
  async function command(name, args) {
    const fd = openSync(log, 'a');
    try {
      const child = spawn(join(process.env.TEST_POSTGRES_BIN, name + (process.platform === 'win32' ? '.exe' : '')),
        args, { windowsHide: true, shell: false, stdio: ['ignore', fd, fd] });
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
      assert.equal(code, 0, await readFile(log, 'utf8'));
    } finally { closeSync(fd); }
  }
  t.after(async () => {
    if (http) await new Promise(done => http.close(done));
    await pool?.end();
    if (started) await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    const rel = relative(resolve(tmpdir()), root);
    assert.ok(rel && !rel.startsWith('..') && !rel.includes(':'));
    await rm(root, { recursive: true, force: true });
  });
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  await command('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C']);
  await command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 10,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 3000 });
  await migrateDatabase(pool);
  assert.deepEqual(await migrateDatabase(pool), []);
  await pool.query(`INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES ('integration-worker', 'Integration Worker', 'USER', 'unused-in-test', 'ACTIVE', false)`);
  const repo = new PostgresControlPlaneRepository({ pool });
  await repo.registerNode({ nodeId: 'a' });
  http = createControlPlaneApp({ repository: repo, storageRoot: join(root, 'assets') }).listen(0, '127.0.0.1');
  await new Promise(done => http.once('listening', done));
  const controlPlane = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${http.address().port}` });
  async function enqueue(nodeId, state = 'COPY_QUEUED', snapshot = {}) {
    const task = (await pool.query(`INSERT INTO tasks(
        query, created_by_node_id, created_by_user_id, assigned_to_user_id,
        assignment_source, assigned_at, state, pending_snapshot
      ) VALUES ('isolated fake task', $1, 'integration-worker', 'integration-worker', 'SELF', now(), $2, $3)
      RETURNING *`, [nodeId, state, snapshot])).rows[0];
    if (state === 'IMAGE_QUEUED') {
      const id = randomUUID();
      await pool.query(`INSERT INTO task_executions(id, task_id, kind, node_id, status, stage, snapshot)
        VALUES ($1, $2, 'COPY', $3, 'SUCCEEDED', 'DONE', '{}')`, [id, task.id, nodeId]);
      const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, execution_id, revision, content)
        VALUES ($1, $2, 1, '{}') RETURNING id`, [task.id, id])).rows[0];
      await pool.query('UPDATE tasks SET current_copy_revision_id = $1 WHERE id = $2', [revision.id, task.id]);
    }
    return task;
  }
  await verifyExecutionRecovery({ repo, pool, enqueue, controlPlane });
});
