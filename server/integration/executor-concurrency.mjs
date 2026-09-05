// This test always creates its own local cluster and never reads DATABASE_URL/.env.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('isolated PostgreSQL: capacity, races, replay, rollback and node ownership', { timeout: 90000 }, async t => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to a local PostgreSQL bin directory');
  const root = await mkdtemp(join(tmpdir(), 'xhs-executor-pg-'));
  const data = join(root, 'data');
  const log = join(root, 'commands.log');
  async function command(name, args) {
    const fd = openSync(log, 'a');
    try {
      const executable = join(process.env.TEST_POSTGRES_BIN, name + (process.platform === 'win32' ? '.exe' : ''));
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
      const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
      assert.equal(code, 0, await readFile(log, 'utf8'));
    } finally { closeSync(fd); }
  }
  let started = false, pool;
  t.after(async () => {
    await pool?.end();
    if (started) await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    const rel = relative(resolve(tmpdir()), root);
    assert.ok(rel && !rel.startsWith('..') && !rel.includes(':'));
    await rm(root, { recursive: true, force: true });
  });
  const listener = createServer();
  await new Promise(ready => listener.listen(0, '127.0.0.1', ready));
  const port = listener.address().port;
  await new Promise(closed => listener.close(closed));
  await command('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C']);
  await command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  t.diagnostic('disposable local PostgreSQL started');
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 12,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 3000 });
  await migrateDatabase(pool);
  assert.deepEqual(await migrateDatabase(pool), []);
  const repo = new PostgresControlPlaneRepository({ pool });
  await repo.registerNode({ nodeId: 'a', imageWorkerEnabled: true, copyConcurrency: 3, imageConcurrency: 2 });
  await repo.registerNode({ nodeId: 'b', imageWorkerEnabled: true, copyConcurrency: 2, imageConcurrency: 2 });
  await repo.registerNode({ nodeId: 'a', imageWorkerEnabled: true });
  assert.equal((await repo.listNodes()).find(n => n.id === 'a').copyConcurrency, 3);
  for (const value of [null, '3', 33]) await assert.rejects(repo.registerNode({ nodeId: 'a', copyConcurrency: value }));
  async function enqueue(nodeId, state = 'COPY_QUEUED', snapshot = {}) {
    const task = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, copy_executor_node_id, state, pending_snapshot)
      VALUES ('isolated fake task', $1, $1, $2, $3) RETURNING *`, [nodeId, state, snapshot])).rows[0];
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
  for (let i = 0; i < 8; i++) await enqueue(i === 7 ? 'b' : 'a');
  const attempts = await Promise.all(Array.from({ length: 5 }, () => repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: randomUUID() })));
  const copies = attempts.flatMap(r => r.claims);
  assert.equal(copies.length, 3);
  assert.equal(new Set(copies.map(c => c.task.id)).size, 3);
  assert.ok(copies.every(c => c.task.copyExecutorNodeId === 'a'));
  const accepted = attempts.find(r => r.claims.length);
  const replay = await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: accepted.requestId });
  assert.deepEqual(replay.claims.map(c => c.execution.id), copies.map(c => c.execution.id));
  await repo.completeCopy(copies[0].execution.id, { fake: true });
  assert.equal((await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: accepted.requestId })).claims[0].execution.status, 'SUCCEEDED');
  assert.equal((await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: randomUUID() })).claims.length, 1);
  await repo.registerNode({ nodeId: 'a', copyConcurrency: 1, imageWorkerEnabled: true });
  assert.equal(await repo.claimCopy('a'), null);
  for (let i = 0; i < 5; i++) await enqueue('a', 'IMAGE_QUEUED');
  const images = (await Promise.all(['a', 'b'].map(nodeId => repo.claimImageBatch({ nodeId, limit: 3, requestId: randomUUID() })))).flatMap(r => r.claims);
  assert.equal(images.length, 4);
  assert.equal(new Set(images.map(c => c.task.id)).size, 4);
  const sameId = randomUUID();
  const repeated = await Promise.all(Array.from({ length: 4 }, () => repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: sameId })));
  assert.ok(repeated.every(r => r.claims.length === 1 && r.claims[0].execution.id === repeated[0].claims[0].execution.id));
  await enqueue('b');
  const brokenId = randomUUID();
  await pool.query(`ALTER TABLE execution_claim_requests ADD CONSTRAINT test_reject_receipt CHECK (request_id <> '${brokenId}'::uuid)`);
  await assert.rejects(repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: brokenId }));
  assert.equal((await repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: randomUUID() })).claims.length, 1);
});
