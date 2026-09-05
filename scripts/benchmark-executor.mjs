// Explicit live benchmark. Never included in npm test; it consumes model quota.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createServer } from 'node:net';
import pg from '../server/node_modules/pg/lib/index.js';
import { createControlPlaneApp } from '../server/src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../server/src/postgres-repository.mjs';
import { createControlPlaneClient } from '../src/control-plane/client.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';
import { createExecutorScheduler } from '../src/executor/scheduler.mjs';
import { executorConcurrency } from '../src/executor/config.mjs';
import { codexRuntimePath, createCodexRuntime } from '../src/codex-runtime.mjs';
import { safeTraceText } from '../src/model-call-trace.mjs';

const args = process.argv.slice(2);
if (!args.includes('--live')) throw new Error('This benchmark consumes model quota; pass --live only with explicit authorization.');
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(process.env.TEST_POSTGRES_BIN, 'TEST_POSTGRES_BIN must name a local PostgreSQL bin directory');
const output = resolve(option('output') ?? `.codex_artifacts/executor-benchmark/${new Date().toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(output, { recursive: true });
assert.equal((await readdir(output)).length, 0, 'use a new empty evidence directory for every live run');
const copyConcurrency = executorConcurrency(option('copy-concurrency') ?? '3', 'copy-concurrency');
const imageConcurrency = executorConcurrency(option('image-concurrency') ?? '2', 'image-concurrency');
const imageTasks = Number(option('image-tasks') ?? 2);
assert.ok(Number.isInteger(imageTasks) && imageTasks >= 0 && imageTasks <= 32, 'image-tasks must be an integer from 0 to 32');
assert.ok(copyConcurrency + imageConcurrency <= 32, 'combined model concurrency must not exceed 32');
const environment = { ...process.env, XHS_CODEX_CONCURRENCY: String(copyConcurrency + imageConcurrency),
  XHS_CODEX_IMAGE_CONCURRENCY: String(imageConcurrency) };
const runtime = createCodexRuntime({ databasePath: codexRuntimePath(environment) });
assert.equal(runtime.status().active, 0, 'wait for existing model calls before changing the shared runtime policy');
runtime.assertAvailable();
const imported = option('copy-results') ? JSON.parse(await readFile(resolve(option('copy-results')), 'utf8')) : null;
const queries = option('queries') ? JSON.parse(await readFile(resolve(option('queries')), 'utf8')) : imported
  ? imported.tasks.filter(task => imported.revisions.some(revision => revision.task_id === task.id)).map(task => task.query) : [
  '小户型租房书桌怎么收纳，写一份容易照着做的整理清单',
  '日常上班通勤包里带什么，写一份轻便实用的物品清单',
  '周末去公园野餐要准备什么，写一份新手准备清单',
];
assert.ok(Array.isArray(queries) && queries.length > 0 && queries.every(query => typeof query === 'string'));
const root = await mkdtemp(join(tmpdir(), 'xhs-live-executor-pg-'));
const data = join(root, 'data');
async function command(name, parameters) {
  const logPath = join(output, 'postgres-commands.log');
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(join(process.env.TEST_POSTGRES_BIN, name + (process.platform === 'win32' ? '.exe' : '')),
      parameters, { windowsHide: true, stdio: ['ignore', fd, fd] });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (code !== 0) throw new Error(`${name} failed; see ${logPath}`);
  } finally { closeSync(fd); }
}
let started = false, pool, http, scheduler, schedule;
const outcomes = [], progress = [], errors = [];
const nodeId = 'isolated-live-benchmark';
const startedAt = new Date();
let writeQueue = Promise.resolve();
function event(type, value) {
  const record = { at: new Date().toISOString(), type, ...value };
  console.log(JSON.stringify(record));
  writeQueue = writeQueue.then(() => appendFile(join(output, 'events.jsonl'), JSON.stringify(record) + '\n'))
    .catch(error => { console.error(`Benchmark event write failed: ${error.message}`); process.exitCode = 1; });
}
let interrupted = false, heartbeat;
const signalStop = () => { interrupted = true; scheduler?.stop(); };
process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
function checkInterrupted() { if (interrupted) throw new Error('benchmark interrupted; cleaning up local resources'); }
try {
  // The existing center is a read-only source of published configuration.
  const remote = createControlPlaneClient({ baseUrl: process.env.CONTROL_PLANE_URL });
  const [settings, prompts, knowledge] = await Promise.all([remote.listSettings(), remote.listPrompts(), remote.listKnowledge()]);
  checkInterrupted();
  await writeFile(join(output, 'source-configuration.json'), JSON.stringify({ settings, prompts, knowledge }, null, 2));
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  await command('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C']);
  checkInterrupted();
  await command('pg_ctl', ['-D', data, '-l', join(output, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  started = true;
  checkInterrupted();
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 12, connectionTimeoutMillis: 5000 });
  const repo = new PostgresControlPlaneRepository({ pool });
  await repo.initialize();
  // Generation reads only production; administrative label arrays are not runtime inputs.
  for (const setting of settings.filter(setting => setting.key === 'production')) await repo.upsertSetting(setting.key, setting.value);
  for (const prompt of prompts) {
    checkInterrupted();
    const published = prompt.versions.find(version => version.status === 'PUBLISHED');
    if (published) await repo.publishPromptVersion((await repo.createPromptVersion({ kind: prompt.kind, name: prompt.name, content: published.content })).id);
  }
  for (const item of knowledge.filter(item => item.status === 'ACTIVE')) {
    checkInterrupted();
    const published = item.versions.find(version => version.status === 'PUBLISHED');
    if (published) await repo.createKnowledgeVersion({ kind: item.kind, name: item.name, content: published.content, publish: true });
  }
  http = createControlPlaneApp({ repository: repo, storageRoot: join(output, 'assets'), enforceUserAuth: false }).listen(0, '127.0.0.1');
  await new Promise(done => http.once('listening', done));
  const client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${http.address().port}` });
  const controlPlane = { ...client, async updateProgress(executionId, value) {
    const record = { executionId, ...value, elapsedMs: Date.now() - startedAt.getTime() };
    progress.push(record);
    event('progress', { executionId, stage: value.stage, percent: value.progressPercent, details: value.details });
    return client.updateProgress(executionId, value);
  } };
  const agent = createExecutorAgent({ controlPlane, nodeId, environment, copyConcurrency, imageConcurrency,
    imageWorkerEnabled: imageTasks > 0, concurrencyEnabled: true, workRoot: join(output, 'work') });
  await agent.prepare(); await agent.register();
  for (const query of queries) {
    const state = imported ? 'COPY_REVIEW_PENDING' : 'COPY_QUEUED';
    const task = (await pool.query(`INSERT INTO tasks(query, requested_image_count, created_by_node_id, copy_executor_node_id, state)
      VALUES ($1, '3', $2, $2, $3) RETURNING id`, [query, nodeId, state])).rows[0];
    if (imported) {
      const sourceTask = imported.tasks.find(task => task.query === query);
      const sourceRevision = imported.revisions.filter(revision => revision.task_id === sourceTask?.id).at(-1);
      assert.ok(sourceRevision, 'copy import requires a previous real result');
      const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, execution_id, revision, content)
        VALUES ($1, NULL, 1, $2) RETURNING id`, [task.id, sourceRevision.content])).rows[0];
      await pool.query('UPDATE tasks SET current_copy_revision_id = $1 WHERE id = $2', [revision.id, task.id]);
    }
  }
  event('ready', { output, queries, copyConcurrency, imageConcurrency, modelTotal: copyConcurrency + imageConcurrency,
    modelImages: imageConcurrency, publishedKnowledge: knowledge.filter(item => item.status === 'ACTIVE').length });
  scheduler = createExecutorScheduler({ agent, copyConcurrency, imageConcurrency, imageWorkerEnabled: imageTasks > 0, pollMs: 1000,
    onOutcome: outcome => { outcomes.push(outcome); event('outcome', { ...outcome, error: outcome.error?.message }); },
    onError: (kind, error, context) => { errors.push({ kind, message: error.message, code: error.code, ...context }); event('retry', errors.at(-1)); } });
  checkInterrupted();
  heartbeat = setInterval(() => { void agent.heartbeat().catch(error => event('heartbeat-error', { message: error.message })); }, 15000);
  schedule = scheduler.start();
  let approved = false;
  const deadline = Date.now() + 40 * 60_000;
  while (true) {
    if (interrupted) break;
    if (['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED'].includes(runtime.status().code)) {
      event('model-paused', { code: runtime.status().code }); scheduler.stop(); break;
    }
    if (Date.now() > deadline) { scheduler.stop(); throw new Error('benchmark exceeded 40 minutes; draining in-flight work'); }
    const tasks = (await pool.query('SELECT id, state, current_copy_revision_id FROM tasks ORDER BY id')).rows;
    if (!approved && tasks.every(task => !['COPY_QUEUED', 'COPY_RUNNING'].includes(task.state))) {
      const selected = tasks.filter(task => task.state === 'COPY_REVIEW_PENDING').slice(0, imageTasks);
      for (const task of selected) await repo.approveCopy(task.id, { revisionId: task.current_copy_revision_id, nodeId });
      approved = true;
      event('image-phase', { count: selected.length });
    } else if (approved && tasks.every(task => !['COPY_QUEUED', 'COPY_RUNNING', 'IMAGE_QUEUED', 'IMAGE_RUNNING'].includes(task.state))
      && Object.values(scheduler.status()).every(pool => pool.active === 0 && pool.reserved === 0)) break;
    await new Promise(done => setTimeout(done, 1000));
  }
  scheduler.stop(); await schedule;
  const failed = outcomes.filter(outcome => outcome.status !== 'SUCCEEDED').length;
  event('complete', { elapsedMs: Date.now() - startedAt.getTime(), outcomes: outcomes.length, failed });
  if (failed) process.exitCode = 1;
} catch (error) {
  event('benchmark-error', { message: safeTraceText(error.message).text });
  process.exitCode = 1;
} finally {
  scheduler?.stop();
  try { await schedule; } catch (error) { console.error(`Benchmark drain failed: ${error.message}`); process.exitCode = 1; }
  clearInterval(heartbeat);
  process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
  try { if (pool) {
    const tasks = (await pool.query('SELECT * FROM tasks ORDER BY id')).rows;
    const executions = (await pool.query('SELECT * FROM task_executions ORDER BY started_at')).rows;
    const revisions = (await pool.query('SELECT * FROM copy_revisions ORDER BY task_id, revision')).rows;
    const imageRuns = (await pool.query('SELECT * FROM image_runs ORDER BY created_at')).rows;
    const calls = (await pool.query('SELECT * FROM model_call_traces ORDER BY started_at')).rows;
    const summary = { startedAt, finishedAt: new Date(), elapsedMs: Date.now() - startedAt.getTime(),
      copyConcurrency, imageConcurrency, importedCopyResults: option('copy-results') ?? null, queries,
      outcomes: outcomes.map(outcome => ({ ...outcome, error: outcome.error?.message })), errors,
      executions: executions.map(e => ({ id: e.id, taskId: e.task_id, kind: e.kind, status: e.status, error: e.error,
        durationMs: e.finished_at ? e.finished_at.getTime() - e.started_at.getTime() : null })),
      calls: calls.map(c => ({ taskId: c.task_id, executionId: c.execution_id, stage: c.stage, operation: c.operation,
        model: c.model, status: c.status, durationMs: Number(c.duration_ms), error: c.error, request: c.request })) };
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ tasks, executions, revisions, imageRuns, calls, progress }, null, 2));
  }
  await writeQueue;
  } catch (error) { console.error(`Benchmark evidence save failed: ${error.message}`); process.exitCode = 1; }
  const cleanupErrors = [];
  async function cleanup(action) { try { await action(); } catch (error) { cleanupErrors.push(error.message); } }
  await cleanup(async () => { if (http) await new Promise((done, reject) => http.close(error => error ? reject(error) : done())); });
  await cleanup(async () => { await pool?.end(); });
  let stopped = !started;
  await cleanup(async () => { if (started) { await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); stopped = true; } });
  if (stopped) await cleanup(async () => {
    const path = relative(resolve(tmpdir()), root);
    assert.ok(path && !path.startsWith('..') && !path.includes(':'));
    await rm(root, { recursive: true, force: true });
  });
  if (cleanupErrors.length) { console.error(JSON.stringify({ cleanupErrors, temporaryCluster: root })); process.exitCode = 1; }
}
