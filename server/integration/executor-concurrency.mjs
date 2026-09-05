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
import { requestIdAt } from '../tests/fixtures/claim-request-id.mjs';
import pg from 'pg';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { createControlPlaneClient } from '../../src/control-plane/client.mjs';
import { createExecutorAgent } from '../../src/executor/agent.mjs';
import { createExecutorScheduler } from '../../src/executor/scheduler.mjs';

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
    const task = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, state, pending_snapshot)
      VALUES ('isolated fake task', $1, $2, $3) RETURNING *`, [nodeId, state, snapshot])).rows[0];
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
  const attempts = await Promise.all(Array.from({ length: 5 }, () => repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: requestIdAt() })));
  const copies = attempts.flatMap(r => r.claims);
  assert.equal(copies.length, 3);
  assert.equal(new Set(copies.map(c => c.task.id)).size, 3);
  assert.ok(copies.every(c => c.task.copyExecutorNodeId === 'a'));
  const accepted = attempts.find(r => r.claims.length);
  const replay = await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: accepted.requestId });
  assert.deepEqual(replay.claims.map(c => c.execution.id), copies.map(c => c.execution.id));
  await repo.completeCopy(copies[0].execution.id, { fake: true });
  assert.equal((await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: accepted.requestId })).claims[0].execution.status, 'SUCCEEDED');
  assert.equal((await repo.claimCopyBatch({ nodeId: 'a', limit: 3, requestId: requestIdAt() })).claims.length, 1);
  await repo.registerNode({ nodeId: 'a', copyConcurrency: 1, imageWorkerEnabled: true });
  assert.equal(await repo.claimCopy('a'), null);
  for (let i = 0; i < 5; i++) await enqueue('a', 'IMAGE_QUEUED');
  const images = (await Promise.all(['a', 'b'].map(nodeId => repo.claimImageBatch({ nodeId, limit: 3, requestId: requestIdAt() })))).flatMap(r => r.claims);
  assert.equal(images.length, 4);
  assert.equal(new Set(images.map(c => c.task.id)).size, 4);
  const sameId = requestIdAt();
  const repeated = await Promise.all(Array.from({ length: 4 }, () => repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: sameId })));
  assert.ok(repeated.every(r => r.claims.length === 1 && r.claims[0].execution.id === repeated[0].claims[0].execution.id));
  await enqueue('b');
  const brokenId = requestIdAt();
  await pool.query(`ALTER TABLE execution_claim_requests ADD CONSTRAINT test_reject_receipt CHECK (request_id <> '${brokenId}'::uuid)`);
  await assert.rejects(repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: brokenId }));
  assert.equal((await repo.claimCopyBatch({ nodeId: 'b', limit: 2, requestId: requestIdAt() })).claims.length, 1);

  const oldIds = Array.from({ length: 205 }, () => requestIdAt(Date.now() - 172_800_000));
  const oldRunningId = requestIdAt(Date.now() - 172_800_000);
  await pool.query(`INSERT INTO execution_claim_requests(node_id, kind, request_id, requested_limit, execution_ids, expires_at)
    SELECT 'a', 'COPY', id, 1, '{}'::uuid[], now() - interval '1 day' FROM unnest($1::uuid[]) id`, [oldIds]);
  await pool.query(`INSERT INTO execution_claim_requests(node_id, kind, request_id, requested_limit, execution_ids, expires_at)
    VALUES ('a', 'COPY', $1, 1, $2, now() - interval '1 day')`, [oldRunningId, [copies[1].execution.id]]);
  await repo.claimCopyBatch({ nodeId: 'a', limit: 1, requestId: requestIdAt() });
  const expiredCount = async () => Number((await pool.query('SELECT COUNT(*) FROM execution_claim_requests WHERE expires_at < now()')).rows[0].count);
  assert.equal(await expiredCount(), 106, 'each GC pass deletes at most 100 receipts');
  for (let i = 0; i < 2; i++) await repo.claimCopyBatch({ nodeId: 'a', limit: 1, requestId: requestIdAt() });
  assert.equal(await expiredCount(), 1, 'running receipts survive expiry');
  assert.equal((await repo.claimCopyBatch({ nodeId: 'a', limit: 1, requestId: oldRunningId })).claims[0].execution.status, 'RUNNING');
  await repo.completeCopy(copies[1].execution.id, { fake: true });
  await repo.claimCopyBatch({ nodeId: 'a', limit: 1, requestId: requestIdAt() });
  assert.equal(await expiredCount(), 0);
  for (const requestId of [oldIds[0], oldRunningId]) {
    await assert.rejects(repo.claimCopyBatch({ nodeId: 'a', limit: 1, requestId }), { code: 'CLAIM_REQUEST_EXPIRED' });
  }

  // Real local HTTP + client + executor pools, with fake work behind a controlled gate.
  const http = createControlPlaneApp({ repository: repo, storageRoot: join(root, 'assets'), enforceUserAuth: false }).listen(0, '127.0.0.1');
  await new Promise(ready => http.once('listening', ready));
  const controlPlane = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${http.address().port}` });
  const jobs = new Map(), errors = [];
  const execute = kind => async ({ claim, controlPlane: traced }) => {
    const gate = Promise.withResolvers();
    jobs.set(claim.execution.id, { kind, gate });
    await gate.promise;
    return kind === 'COPY' ? traced.completeCopy(claim.execution.id, { fake: true }) : traced.completeImage(claim.execution.id, { fake: true });
  };
  const agent = createExecutorAgent({ controlPlane, nodeId: 'c', copyConcurrency: 3, imageConcurrency: 2,
    imageWorkerEnabled: true, concurrencyEnabled: true, availabilityCheck: async () => {},
    readinessCheck: async () => ({ health: await controlPlane.health() }), executeCopy: execute('COPY'), executeImage: execute('IMAGE') });
  let scheduler, scheduled;
  try {
    await agent.prepare(); await agent.register();
    for (let i = 0; i < 5; i++) await enqueue('c');
    for (let i = 0; i < 3; i++) await enqueue('c', 'IMAGE_QUEUED');
    scheduler = createExecutorScheduler({ agent, copyConcurrency: 3, imageConcurrency: 2,
      imageWorkerEnabled: true, pollMs: 20, onError: (_kind, error) => errors.push(error) });
    scheduled = scheduler.start();
    async function until(check) {
      for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail(`local executor did not fill capacity: ${errors.map(e => e.message).join('; ')}`);
    }
    await until(() => jobs.size === 5);
    assert.deepEqual(scheduler.status(), { COPY: { active: 3, reserved: 0 }, IMAGE: { active: 2, reserved: 0 } });
    [...jobs.values()].find(job => job.kind === 'COPY').gate.resolve();
    await until(() => jobs.size === 6);
    assert.equal(scheduler.status().COPY.active, 3);
    assert.deepEqual(errors, []);
  } finally {
    scheduler?.stop();
    for (const job of jobs.values()) job.gate.resolve();
    await scheduled;
    await new Promise((done, reject) => http.close(error => error ? reject(error) : done()));
  }
});
