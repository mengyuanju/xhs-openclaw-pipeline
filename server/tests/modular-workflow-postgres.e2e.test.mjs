import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import JSZip from 'jszip';
import pg from 'pg';

import { normalizeCopyQaList } from '../../app/copy-qa/types.ts';
import { normalizePackageDetail, normalizePackageList } from '../../app/query-packages/types.ts';
import { createClaimRequestId } from '../../src/control-plane/claim-request.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  createQueryPackage,
  createQueryPackageProductionBatch,
  updateQueryPackageScreening,
} from '../src/query-packages.mjs';
import { hashUserPassword } from '../src/user-auth.mjs';

const execFile = promisify(execFileCallback);
const RUN_POSTGRES_E2E = process.env.RUN_POSTGRES_E2E === '1';
const QUERY_PACKAGE_SCALE_ROWS = 5_000;
const QUERY_PACKAGE_SCALE_OPERATION_LIMIT_MS = 20_000;

const POSTGRES_BIN_CANDIDATES = Object.freeze([
  process.env.POSTGRES_E2E_BIN,
  process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : null,
  process.platform === 'linux' ? '/usr/lib/postgresql/18/bin' : null,
  process.platform === 'darwin' ? '/opt/homebrew/opt/postgresql@18/bin' : null,
].filter(Boolean));

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function findPostgresBin() {
  for (const candidate of POSTGRES_BIN_CANDIDATES) {
    try {
      await access(join(candidate, executableName('initdb')));
      await access(join(candidate, executableName('pg_ctl')));
      return candidate;
    } catch {
      // Continue to the next explicit PostgreSQL 18 installation location.
    }
  }
  throw new Error(
    'PostgreSQL 18 tools were not found; set POSTGRES_E2E_BIN to the directory containing initdb and pg_ctl.',
  );
}

async function runTool(file, args, options = {}) {
  try {
    return await execFile(file, args, {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
    throw new Error(`PostgreSQL test tool failed: ${detail}`, { cause: error });
  }
}

async function runPgControl(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`PostgreSQL control command timed out: ${args.at(-1)}`));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`PostgreSQL control command failed with code ${code} and signal ${signal ?? 'none'}.`));
    });
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!Number.isSafeInteger(port)) throw new Error('Could not reserve an isolated PostgreSQL port.');
  return port;
}

async function startTemporaryPostgres18() {
  const postgresBin = await findPostgresBin();
  const initdb = join(postgresBin, executableName('initdb'));
  const pgCtl = join(postgresBin, executableName('pg_ctl'));
  const version = await runTool(initdb, ['--version']);
  assert.match(`${version.stdout}${version.stderr}`, /\b18\.\d+\b/u, 'the E2E test must use PostgreSQL 18');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-modular-workflow-pg18-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const logFile = join(temporaryRoot, 'postgres.log');
  const port = await reserveLoopbackPort();
  let started = false;
  try {
    await runTool(initdb, [
      '-D', dataDirectory,
      '-A', 'trust',
      '-U', 'postgres',
      '--encoding=UTF8',
      '--locale=C',
      '--no-sync',
    ]);
    await runPgControl(pgCtl, [
      '-D', dataDirectory,
      '-l', logFile,
      '-o', `-h 127.0.0.1 -p ${port}`,
      '-w',
      'start',
    ]);
    started = true;
    return {
      connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      async stop() {
        if (started) {
          await runPgControl(pgCtl, ['-D', dataDirectory, '-m', 'fast', '-w', 'stop']);
          started = false;
        }
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    if (started) {
      await runPgControl(pgCtl, ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']).catch(() => {});
    }
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {});
    throw error;
  }
}

function actorFrom(user) {
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    credentialVersion: user.credentialVersion,
  };
}

function actorHeaders(actor, { json = false } = {}) {
  return {
    ...(actor ? {
      'X-Actor-User-Id': String(actor.userId),
      'X-Actor-Username': actor.username,
      'X-Actor-Role': actor.role,
      'X-Actor-Credential-Version': String(actor.credentialVersion),
    } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function startRealControlPlane(repository) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-modular-workflow-http-'));
  const failIfAnalysisRuns = async () => {
    throw new Error('model-backed analysis must not run in the PostgreSQL HTTP E2E test');
  };
  const app = createControlPlaneApp({
    repository,
    storageRoot,
    enforceUserAuth: true,
    analyzeCopy: failIfAnalysisRuns,
    analyzeVisual: failIfAnalysisRuns,
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  return {
    root: `http://127.0.0.1:${server.address().port}`,
    storageRoot,
    async stop() {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function requestJson(root, path, {
  actor = null,
  method = 'GET',
  body,
  expectedStatus = 200,
} = {}) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: actorHeaders(actor, { json: body !== undefined }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(
    response.status,
    expectedStatus,
    `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`,
  );
  return { response, payload, data: payload?.data, error: payload?.error };
}

function validCopyContent(index, { edited = false } = {}) {
  const marker = edited ? '返修后' : '机器初稿';
  const paragraph = `${marker}第${index}份内容用于隔离数据库流程验证，包含明确事实边界、操作步骤、风险提示和结果检查。`;
  const bodySource = Array.from({ length: 12 }, (_, paragraphIndex) => (
    `${paragraph}这是第${paragraphIndex + 1}段，所有文字均为合成测试数据，不对应真实业务内容。`
  )).join('\n');
  const body = [...bodySource].slice(0, 500).join('');
  assert.ok([...body].length >= 400 && [...body].length <= 600);
  return {
    copy: {
      title: `${marker}流程验证${index}`,
      body,
      tags: edited ? ['#返修验证', '#质量流程', '#隔离测试'] : ['#流程验证', '#质量抽检', '#隔离测试'],
    },
    imagePlan: [
      {
        kind: 'hero',
        headline: '流程验证封面',
        subtitle: '隔离数据库合成数据',
        bullets: ['不调用任何模型', '不连接业务数据库'],
        prompt: '使用简洁信息卡片展示隔离测试流程，不包含真实用户或业务数据',
      },
      {
        kind: 'steps',
        headline: '执行步骤',
        subtitle: '从筛选到质量抽检',
        bullets: ['创建并筛选词包', '初审后冻结范围', '盲评处理抽检项'],
        prompt: '使用清晰步骤图展示测试链路，各步骤层级明确且文字区域留白充足',
      },
      {
        kind: 'summary',
        headline: '验证结论',
        subtitle: '事务与状态均已检查',
        bullets: ['返修必须再次抽检', '全部收口后才放行'],
        prompt: '使用总结卡片呈现测试结论，强调隔离运行和状态一致性检查',
      },
    ],
  };
}

function assertBlindQaAllowlist(item) {
  assert.equal(item.blindReview, true);
  assert.match(item.id, /^[0-9a-f-]{36}$/u);
  assert.match(item.freezePublicId, /^[0-9a-f-]{36}$/u);
  assert.match(item.anonymousCode, /^QC-[A-F0-9]{12}$/u);
  assert.deepEqual(Object.keys(item.productionBatch).toSorted(), ['anonymousCode']);
  for (const hiddenKey of [
    'taskId', 'query', 'source', 'createdByUserId', 'assignedToUserId',
    'finalApproverAccountId', 'finalApproverUsername', 'copyRevisionId',
  ]) {
    assert.equal(Object.hasOwn(item, hiddenKey), false, `blind QA response exposed ${hiddenKey}`);
  }
  const serialized = JSON.stringify(item);
  for (const identity of ['worker-pg-e2e', 'reviewer-pg-e2e']) {
    assert.equal(serialized.includes(identity), false, `blind QA response exposed ${identity}`);
  }
}

test('delivery migration backfills only human copy edits against their nearest machine ancestor', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const throughSampling = migrations.filter(({ id }) => id <= '0025_copy_sampling');
    const throughDelivery = migrations.filter(({ id }) => id <= '0026_final_delivery');

    for (const selectedMigrations of [throughSampling, throughDelivery]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO public');
        await applyMigrations(client, selectedMigrations);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      if (selectedMigrations === throughSampling) {
        await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('migration-node', 'Migration Node')");
        const taskId = Number((await pool.query(`
          INSERT INTO tasks(query, input, state, created_by_node_id, copy_executor_node_id)
          VALUES ('migration lineage fixture', '{}'::jsonb, 'COPY_REVIEW_PENDING', 'migration-node', 'migration-node')
          RETURNING id
        `)).rows[0].id);
        const firstExecutionId = randomUUID();
        const secondExecutionId = randomUUID();
        await pool.query(`
          INSERT INTO task_executions(
            id, task_id, kind, node_id, status, stage, progress_percent, progress_message,
            progress_details, snapshot, finished_at
          ) VALUES
            ($1, $3, 'COPY', 'migration-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now()),
            ($2, $3, 'COPY', 'migration-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now())
        `, [firstExecutionId, secondExecutionId, taskId]);

        const firstMachineCopy = { title: '机器稿一', body: '第一份机器稿' };
        const secondMachineCopy = { title: '机器稿二', body: '第二份机器稿' };
        const firstMachineId = Number((await pool.query(`
          INSERT INTO copy_revisions(task_id, execution_id, revision, content)
          VALUES ($1, $2, 1, $3::jsonb)
          RETURNING id
        `, [taskId, firstExecutionId, JSON.stringify({ copy: firstMachineCopy })])).rows[0].id);
        const secondMachineId = Number((await pool.query(`
          INSERT INTO copy_revisions(task_id, execution_id, revision, content)
          VALUES ($1, $2, 2, $3::jsonb)
          RETURNING id
        `, [taskId, secondExecutionId, JSON.stringify({ copy: secondMachineCopy })])).rows[0].id);

        await pool.query(`
          INSERT INTO copy_revisions(task_id, revision, content)
          VALUES
            ($1, 3, $2::jsonb),
            ($1, 4, $3::jsonb),
            ($1, 5, $4::jsonb),
            ($1, 6, $5::jsonb)
        `, [
          taskId,
          JSON.stringify({ copy: secondMachineCopy, manualReview: { baseRevisionId: secondMachineId } }),
          JSON.stringify({ copy: firstMachineCopy, manualReview: { baseRevisionId: firstMachineId } }),
          JSON.stringify({ copy: { ...secondMachineCopy, title: '人工改稿' }, manualReview: { baseRevisionId: secondMachineId } }),
          JSON.stringify({
            copy: secondMachineCopy,
            manualReview: { baseRevisionId: '9223372036854775808' },
          }),
        ]);
      }
    }

    const revisions = (await pool.query(`
      SELECT revision, execution_id, revision_origin, copy_content_changed_from_machine
      FROM copy_revisions
      ORDER BY revision
    `)).rows;
    assert.deepEqual(revisions.map((row) => ({
      revision: row.revision,
      machine: row.execution_id !== null,
      origin: row.revision_origin,
      changed: row.copy_content_changed_from_machine,
    })), [
      { revision: 1, machine: true, origin: 'GENERATION', changed: false },
      { revision: 2, machine: true, origin: 'GENERATION', changed: false },
      { revision: 3, machine: false, origin: 'PLAN_EDIT', changed: false },
      { revision: 4, machine: false, origin: 'PLAN_EDIT', changed: false },
      { revision: 5, machine: false, origin: 'COPY_EDIT', changed: true },
      { revision: 6, machine: false, origin: 'PLAN_EDIT', changed: false },
    ]);
  } finally {
    await pool.end().catch(() => {});
    await database.stop().catch(() => {});
  }
});

test('delivery archive integrity migration withdraws stale, unbound, or unarchivable READY entries', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const throughDelivery = migrations.filter(({ id }) => id <= '0026_final_delivery');
    const throughArchiveIntegrity = migrations.filter(({ id }) => id <= '0027_delivery_archive_integrity');
    const baseline = await pool.connect();
    try {
      await baseline.query('BEGIN');
      await baseline.query('SET LOCAL search_path TO public');
      await applyMigrations(baseline, throughDelivery);
      await baseline.query('COMMIT');
    } catch (error) {
      await baseline.query('ROLLBACK');
      throw error;
    } finally {
      baseline.release();
    }

    await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('archive-migration-node', 'Archive Migration Node')");

    async function createTask(query) {
      return Number((await pool.query(`
        INSERT INTO tasks(query, input, state, created_by_node_id, copy_executor_node_id)
        VALUES ($1, '{}'::jsonb, 'MANUAL_ARCHIVE',
          'archive-migration-node', 'archive-migration-node')
        RETURNING id
      `, [query])).rows[0].id);
    }

    async function createSource(taskId, revision, { archivable = true } = {}) {
      const copyExecutionId = randomUUID();
      const imageExecutionId = randomUUID();
      const imageRunId = randomUUID();
      await pool.query(`
        INSERT INTO task_executions(
          id, task_id, kind, node_id, status, stage, progress_percent, progress_message,
          progress_details, snapshot, finished_at
        ) VALUES
          ($1, $3, 'COPY', 'archive-migration-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now()),
          ($2, $3, 'IMAGE', 'archive-migration-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now())
      `, [copyExecutionId, imageExecutionId, taskId]);
      const copyRevisionId = Number((await pool.query(`
        INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at)
        VALUES ($1, $2, $3, $4::jsonb, now())
        RETURNING id
      `, [
        taskId,
        copyExecutionId,
        revision,
        JSON.stringify({ copy: { title: `归档迁移稿 ${revision}`, body: '仅用于隔离迁移测试。' } }),
      ])).rows[0].id);
      await pool.query(`
        INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id, status, result, finished_at)
        VALUES ($1, $2, $3, $4, 'COMPLETED', $5::jsonb, now())
      `, [
        imageRunId,
        taskId,
        imageExecutionId,
        copyRevisionId,
        JSON.stringify(archivable
          ? { images: [] }
          : { images: [{ deliveryAssetId: '9223372036854775808' }] }),
      ]);
      if (archivable) {
        const assetId = Number((await pool.query(`
          INSERT INTO assets(task_id, image_run_id, media_type, byte_size, sha256, storage_path)
          VALUES ($1, $2, 'image/png', 1, $3, $4)
          RETURNING id
        `, [taskId, imageRunId, 'a'.repeat(64), `migration-0027/${randomUUID()}.png`])).rows[0].id);
        await pool.query(`
          UPDATE image_runs SET result = $2::jsonb WHERE id = $1
        `, [imageRunId, JSON.stringify({ images: [{ deliveryAssetId: assetId }] })]);
      }
      return { copyRevisionId, imageRunId };
    }

    async function markReviewed(taskId, source = null) {
      await pool.query(`
        UPDATE tasks
        SET state = 'REVIEWED', current_copy_revision_id = $2, current_image_run_id = $3,
          image_reviewed_by_user_id = 'legacy-reviewer', image_reviewed_at = now()
        WHERE id = $1
      `, [taskId, source?.copyRevisionId ?? null, source?.imageRunId ?? null]);
    }

    async function addReadyDelivery(taskId, source) {
      await pool.query(`
        INSERT INTO delivery_entries(
          task_id, copy_revision_id, image_run_id, status, approved_by_username, approved_at
        ) VALUES ($1, $2, $3, 'READY', 'legacy-reviewer', now())
      `, [taskId, source.copyRevisionId, source.imageRunId]);
    }

    const unarchivableTaskId = await createTask('legacy dirty READY fixture');
    const unarchivableSource = await createSource(unarchivableTaskId, 1, { archivable: false });
    await markReviewed(unarchivableTaskId, unarchivableSource);
    await addReadyDelivery(unarchivableTaskId, unarchivableSource);

    const staleTaskId = await createTask('READY A with legal current B');
    const staleSourceA = await createSource(staleTaskId, 1);
    const currentSourceB = await createSource(staleTaskId, 2);
    await markReviewed(staleTaskId, currentSourceB);
    await addReadyDelivery(staleTaskId, staleSourceA);

    const nullCurrentTaskId = await createTask('READY with null current pointers');
    const nullCurrentSource = await createSource(nullCurrentTaskId, 1);
    await markReviewed(nullCurrentTaskId);
    await addReadyDelivery(nullCurrentTaskId, nullCurrentSource);

    const invalidCurrentTaskId = await createTask('READY with cross-task current pointers');
    await markReviewed(invalidCurrentTaskId, currentSourceB);
    await addReadyDelivery(invalidCurrentTaskId, currentSourceB);

    const nonReviewedTaskId = await createTask('bound and archivable READY outside REVIEWED');
    const nonReviewedSource = await createSource(nonReviewedTaskId, 1);
    await markReviewed(nonReviewedTaskId, nonReviewedSource);
    await pool.query("UPDATE tasks SET state = 'MANUAL_ARCHIVE' WHERE id = $1", [nonReviewedTaskId]);
    await addReadyDelivery(nonReviewedTaskId, nonReviewedSource);

    const validTaskId = await createTask('valid current READY control');
    const validSource = await createSource(validTaskId, 1);
    await markReviewed(validTaskId, validSource);
    await addReadyDelivery(validTaskId, validSource);

    const upgrade = await pool.connect();
    try {
      await upgrade.query('BEGIN');
      await upgrade.query('SET LOCAL search_path TO public');
      await applyMigrations(upgrade, throughArchiveIntegrity);
      await upgrade.query('COMMIT');
    } catch (error) {
      await upgrade.query('ROLLBACK');
      throw error;
    } finally {
      upgrade.release();
    }

    const anomalousTaskIds = [
      unarchivableTaskId,
      staleTaskId,
      nullCurrentTaskId,
      invalidCurrentTaskId,
    ];
    const withdrawnTaskIds = [
      ...anomalousTaskIds,
      nonReviewedTaskId,
    ];
    const deliveries = new Map((await pool.query(`
      SELECT task_id, status, withdrawn_at
      FROM delivery_entries
      WHERE task_id = ANY($1::bigint[])
    `, [[...withdrawnTaskIds, validTaskId]])).rows.map((row) => [Number(row.task_id), row]));
    for (const taskId of withdrawnTaskIds) {
      assert.equal(deliveries.get(taskId)?.status, 'WITHDRAWN');
      assert.ok(deliveries.get(taskId)?.withdrawn_at instanceof Date);
    }
    assert.equal(deliveries.get(validTaskId)?.status, 'READY');
    assert.equal(deliveries.get(validTaskId)?.withdrawn_at, null);

    const anomalies = new Map((await pool.query(`
      SELECT task_id, reason
      FROM delivery_migration_anomalies
      WHERE task_id = ANY($1::bigint[])
    `, [[...withdrawnTaskIds, validTaskId]])).rows.map((row) => [Number(row.task_id), row.reason]));
    for (const taskId of anomalousTaskIds) {
      assert.equal(anomalies.get(taskId), 'READY_DELIVERY_SOURCE_NOT_ARCHIVABLE');
    }
    assert.equal(anomalies.has(nonReviewedTaskId), false, 'only reviewed tasks participate in migration anomaly reporting');
    assert.equal(anomalies.has(validTaskId), false, 'a current, task-owned and archivable READY source is not anomalous');
  } finally {
    await pool.end().catch(() => {});
    await database.stop().catch(() => {});
  }
});

test('mutation receipt migration isolates a same-name replacement and retains deleted account ids', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const beforeReceiptIdentity = migrations.filter(({ id }) => id < '0028_mutation_receipt_actor_identity');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO public');
      await applyMigrations(client, beforeReceiptIdentity);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const former = (await pool.query(`
      INSERT INTO app_users(
        username, display_name, role, password_hash, status,
        must_change_password, credential_version, created_at, updated_at
      ) VALUES (
        'receipt-reused-name', '旧账号', 'REVIEWER', 'unused-test-hash', 'ACTIVE',
        false, 1, clock_timestamp() - interval '2 seconds', clock_timestamp() - interval '2 seconds'
      ) RETURNING id
    `)).rows[0];
    const queryRequestId = '28282828-2828-4828-8828-282828282828';
    const copyRequestId = '29292929-2929-4929-8929-292929292929';
    const batchRequestId = '30303030-3030-4030-8030-303030303030';
    const freezeRequestId = '31313131-3131-4131-8131-313131313131';
    const deletionAuditRequestId = '32323232-3232-4232-8232-323232323232';
    const lifecycleAuditRequestId = '33333333-3333-4333-8333-333333333333';
    await pool.query(`
      INSERT INTO query_package_mutation_requests(
        actor_username, request_id, operation, query_package_id, request_fingerprint, response
      ) VALUES ('receipt-reused-name', $1, 'CREATE', NULL, $2, '{"owner":"former"}'::jsonb)
    `, [queryRequestId, 'a'.repeat(64)]);
    await pool.query(`
      INSERT INTO copy_sampling_mutation_requests(
        actor_username, request_id, operation, request_fingerprint, response
      ) VALUES ('receipt-reused-name', $1, 'PASS', $2, '{"owner":"former"}'::jsonb)
    `, [copyRequestId, 'a'.repeat(64)]);
    const formerBatch = (await pool.query(`
      INSERT INTO production_batches(
        public_id, query_package_name, created_by_account_id, created_by_username,
        request_id, request_fingerprint
      ) VALUES (
        '34343434-3434-4434-8434-343434343434', '旧账号批次', $1,
        'receipt-reused-name', $2, $3
      ) RETURNING id
    `, [former.id, batchRequestId, 'a'.repeat(64)])).rows[0];
    await pool.query(`
      INSERT INTO copy_sampling_freezes(
        public_id, production_batch_id, policy_version, rate_bps, seed,
        algorithm_version, blind_review_enabled, population_count, sample_count,
        snapshot_sha256, frozen_by_account_id, frozen_by_username,
        request_id, request_fingerprint
      ) VALUES (
        '35353535-3535-4535-8535-353535353535', $1, 1, 1000, 'former-seed',
        'test-v1', true, 1, 1, $2, $3, 'receipt-reused-name', $4, $2
      )
    `, [formerBatch.id, 'a'.repeat(64), former.id, freezeRequestId]);
    await pool.query(`
      INSERT INTO query_package_deletion_audits(
        deleted_query_package_id, deleted_item_count, detached_task_count,
        actor_account_id, actor_username, reason, request_id
      ) VALUES (1, 0, 0, $1, 'receipt-reused-name', 'former', $2)
    `, [former.id, deletionAuditRequestId]);
    await pool.query(`
      INSERT INTO query_package_lifecycle_audits(
        query_package_id, action, actor_account_id, actor_username, reason, request_id
      ) VALUES (1, 'ABANDON', $1, 'receipt-reused-name', 'former', $2)
    `, [former.id, lifecycleAuditRequestId]);
    await pool.query('DELETE FROM app_users WHERE id = $1', [former.id]);
    const replacement = (await pool.query(`
      INSERT INTO app_users(
        username, display_name, role, password_hash, status,
        must_change_password, credential_version, created_at, updated_at
      ) VALUES (
        'receipt-reused-name', '同名新账号', 'REVIEWER', 'unused-test-hash', 'ACTIVE',
        false, 1, clock_timestamp() + interval '2 seconds', clock_timestamp() + interval '2 seconds'
      ) RETURNING id
    `)).rows[0];

    const upgrade = await pool.connect();
    try {
      await upgrade.query('BEGIN');
      await upgrade.query('SET LOCAL search_path TO public');
      await applyMigrations(upgrade, migrations);
      await upgrade.query('COMMIT');
    } catch (error) {
      await upgrade.query('ROLLBACK');
      throw error;
    } finally {
      upgrade.release();
    }

    const legacy = await pool.query(`
      SELECT actor_account_id FROM query_package_mutation_requests WHERE request_id = $1
      UNION ALL
      SELECT actor_account_id FROM copy_sampling_mutation_requests WHERE request_id = $2
    `, [queryRequestId, copyRequestId]);
    assert.equal(legacy.rows.length, 2);
    assert.ok(legacy.rows.every((row) => Number(row.actor_account_id) < 0));
    assert.equal(new Set(legacy.rows.map((row) => String(row.actor_account_id))).size, 1,
      'an unmatched legacy username keeps one audit identity across both receipt tables');
    assert.ok(legacy.rows.every((row) => Number(row.actor_account_id) !== Number(replacement.id)));

    await pool.query(`
      INSERT INTO query_package_mutation_requests(
        actor_account_id, actor_username, request_id, operation,
        query_package_id, request_fingerprint, response
      ) VALUES ($1, 'receipt-reused-name', $2, 'CREATE', NULL, $3, '{"owner":"replacement"}'::jsonb)
    `, [replacement.id, queryRequestId, 'b'.repeat(64)]);
    await pool.query(`
      INSERT INTO copy_sampling_mutation_requests(
        actor_account_id, actor_username, request_id, operation,
        request_fingerprint, response
      ) VALUES ($1, 'receipt-reused-name', $2, 'PASS', $3, '{"owner":"replacement"}'::jsonb)
    `, [replacement.id, copyRequestId, 'b'.repeat(64)]);
    const replacementBatch = (await pool.query(`
      INSERT INTO production_batches(
        public_id, query_package_name, created_by_account_id, created_by_username,
        request_id, request_fingerprint
      ) VALUES (
        '36363636-3636-4636-8636-363636363636', '同名新账号批次', $1,
        'receipt-reused-name', $2, $3
      ) RETURNING id
    `, [replacement.id, batchRequestId, 'b'.repeat(64)])).rows[0];
    await pool.query(`
      INSERT INTO copy_sampling_freezes(
        public_id, production_batch_id, policy_version, rate_bps, seed,
        algorithm_version, blind_review_enabled, population_count, sample_count,
        snapshot_sha256, frozen_by_account_id, frozen_by_username,
        request_id, request_fingerprint
      ) VALUES (
        '37373737-3737-4737-8737-373737373737', $1, 1, 1000, 'replacement-seed',
        'test-v1', true, 1, 1, $2, $3, 'receipt-reused-name', $4, $2
      )
    `, [replacementBatch.id, 'b'.repeat(64), replacement.id, freezeRequestId]);
    await pool.query(`
      INSERT INTO query_package_deletion_audits(
        deleted_query_package_id, deleted_item_count, detached_task_count,
        actor_account_id, actor_username, reason, request_id
      ) VALUES (2, 0, 0, $1, 'receipt-reused-name', 'replacement', $2)
    `, [replacement.id, deletionAuditRequestId]);
    await pool.query(`
      INSERT INTO query_package_lifecycle_audits(
        query_package_id, action, actor_account_id, actor_username, reason, request_id
      ) VALUES (2, 'ABANDON', $1, 'receipt-reused-name', 'replacement', $2)
    `, [replacement.id, lifecycleAuditRequestId]);

    const artifactIsolation = (await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM production_batches
          WHERE created_by_username = 'receipt-reused-name' AND request_id = $1) AS batches,
        (SELECT COUNT(*) FROM copy_sampling_freezes
          WHERE frozen_by_username = 'receipt-reused-name' AND request_id = $2) AS freezes,
        (SELECT COUNT(*) FROM query_package_deletion_audits
          WHERE actor_username = 'receipt-reused-name' AND request_id = $3) AS deletion_audits,
        (SELECT COUNT(*) FROM query_package_lifecycle_audits
          WHERE actor_username = 'receipt-reused-name' AND request_id = $4) AS lifecycle_audits
    `, [batchRequestId, freezeRequestId, deletionAuditRequestId, lifecycleAuditRequestId])).rows[0];
    assert.deepEqual(Object.fromEntries(Object.entries(artifactIsolation)
      .map(([key, value]) => [key, Number(value)])), {
      batches: 2,
      freezes: 2,
      deletion_audits: 2,
      lifecycle_audits: 2,
    });
    await pool.query('DELETE FROM app_users WHERE id = $1', [replacement.id]);

    const retained = await pool.query(`
      SELECT actor_account_id, response->>'owner' AS owner
      FROM query_package_mutation_requests WHERE request_id = $1
      UNION ALL
      SELECT actor_account_id, response->>'owner' AS owner
      FROM copy_sampling_mutation_requests WHERE request_id = $2
      ORDER BY owner, actor_account_id
    `, [queryRequestId, copyRequestId]);
    assert.equal(retained.rows.filter((row) => row.owner === 'former').length, 2);
    assert.equal(retained.rows.filter((row) => row.owner === 'replacement').length, 2);
    assert.ok(retained.rows.filter((row) => row.owner === 'replacement')
      .every((row) => Number(row.actor_account_id) === Number(replacement.id)));
  } finally {
    await pool.end().catch(() => {});
    await database.stop().catch(() => {});
  }
});

test('real PostgreSQL 18 screens and produces a full 5000-row Query package within bounded time', {
  skip: !RUN_POSTGRES_E2E,
  timeout: 180_000,
}, async (context) => {
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  try {
    await repository.initialize();
    await repository.pool.query(`
      INSERT INTO app_users(
        username, display_name, role, password_hash, status,
        must_change_password, credential_version, created_at, updated_at
      ) VALUES (
        'query-scale-worker', '词包性能测试作业员', 'USER', 'unused-scale-password-hash', 'ACTIVE',
        false, 1, clock_timestamp(), clock_timestamp()
      )
    `);
    const admin = actorFrom(await repository.getUserByUsername('admin'));
    const importStartedAt = performance.now();
    const imported = await createQueryPackage(repository.pool, {
      name: 'PostgreSQL 18 5000 条 Query 词包时限验证',
      sourceFileName: 'query-scale-5000.json',
      assignedToUserId: 'query-scale-worker',
      requestId: randomUUID(),
      items: Array.from({ length: QUERY_PACKAGE_SCALE_ROWS }, (_, index) => ({
        externalId: `scale-query-${index + 1}`,
        query: `可投产边界 Query ${index + 1}`,
        input: { ordinal: index + 1 },
        requestedImageCount: index % 2 === 0 ? 'auto' : 3,
      })),
    }, admin);
    const importElapsedMs = performance.now() - importStartedAt;
    assert.equal(imported.counts.total, QUERY_PACKAGE_SCALE_ROWS);
    assert.equal(imported.counts.pending, QUERY_PACKAGE_SCALE_ROWS);
    assert.ok(importElapsedMs < QUERY_PACKAGE_SCALE_OPERATION_LIMIT_MS,
      `5000-row Query import took ${importElapsedMs.toFixed(0)}ms`);

    const itemIds = (await repository.pool.query(`
      SELECT id FROM query_package_items WHERE query_package_id = $1 ORDER BY id
    `, [imported.id])).rows.map((row) => Number(row.id));
    assert.equal(itemIds.length, QUERY_PACKAGE_SCALE_ROWS);
    const screeningStartedAt = performance.now();
    const screened = await updateQueryPackageScreening(repository.pool, imported.id, {
      expectedVersion: imported.version,
      requestId: randomUUID(),
      decisions: itemIds.map((itemId) => ({ itemId, decision: 'SELECT' })),
    }, admin);
    const screeningElapsedMs = performance.now() - screeningStartedAt;
    assert.equal(screened.status, 'READY');
    assert.equal(screened.counts.selected, QUERY_PACKAGE_SCALE_ROWS);
    assert.ok(screeningElapsedMs < QUERY_PACKAGE_SCALE_OPERATION_LIMIT_MS,
      `5000-row Query screening took ${screeningElapsedMs.toFixed(0)}ms`);

    const productionStartedAt = performance.now();
    const production = await createQueryPackageProductionBatch(repository.pool, imported.id, {
      expectedVersion: screened.version,
      requestId: randomUUID(),
      itemIds,
      nodeId: 'query-scale-node',
    }, admin);
    const productionElapsedMs = performance.now() - productionStartedAt;
    assert.equal(production.taskIds.length, QUERY_PACKAGE_SCALE_ROWS);
    assert.equal(new Set(production.taskIds).size, QUERY_PACKAGE_SCALE_ROWS);
    assert.ok(productionElapsedMs < QUERY_PACKAGE_SCALE_OPERATION_LIMIT_MS,
      `5000-row Query production took ${productionElapsedMs.toFixed(0)}ms`);

    const persisted = (await repository.pool.query(`
      SELECT package.status,
        (SELECT COUNT(*) FROM query_package_items
          WHERE query_package_id = package.id) AS item_count,
        (SELECT COUNT(*) FROM query_package_items
          WHERE query_package_id = package.id AND status = 'TASK_CREATED') AS produced_item_count,
        (SELECT COUNT(*) FROM tasks
          WHERE source_query_package_id = package.id) AS task_count,
        (SELECT COUNT(*) FROM production_batch_items AS batch_item
          JOIN production_batches AS batch ON batch.id = batch_item.production_batch_id
          WHERE batch.query_package_id = package.id) AS batch_item_count
      FROM query_packages AS package
      WHERE package.id = $1
    `, [imported.id])).rows[0];
    assert.deepEqual({
      status: persisted.status,
      itemCount: Number(persisted.item_count),
      producedItemCount: Number(persisted.produced_item_count),
      taskCount: Number(persisted.task_count),
      batchItemCount: Number(persisted.batch_item_count),
    }, {
      status: 'USED_UP',
      itemCount: QUERY_PACKAGE_SCALE_ROWS,
      producedItemCount: QUERY_PACKAGE_SCALE_ROWS,
      taskCount: QUERY_PACKAGE_SCALE_ROWS,
      batchItemCount: QUERY_PACKAGE_SCALE_ROWS,
    });
    context.diagnostic(
      `5000-row Query import ${importElapsedMs.toFixed(0)}ms; screening ${screeningElapsedMs.toFixed(0)}ms; production ${productionElapsedMs.toFixed(0)}ms`,
    );
  } finally {
    await repository.close().catch(() => {});
    await cluster.stop();
  }
});

test('real PostgreSQL 18 modular workflow reaches the delivery pool after blind QA and mandatory recheck', {
  skip: !RUN_POSTGRES_E2E,
  timeout: 180_000,
}, async () => {
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  let controlPlane = null;
  try {
    await repository.initialize();

    // These accounts and all later content exist only inside the disposable cluster.
    const insertedUsers = await repository.pool.query(`
      INSERT INTO app_users(
        username, display_name, role, password_hash, status,
        must_change_password, credential_version, created_at, updated_at
      ) VALUES
        ('worker-pg-e2e', '隔离测试作业员', 'USER', 'unused-e2e-password-hash', 'ACTIVE', false, 1,
          clock_timestamp() - interval '1 second', clock_timestamp() - interval '1 second'),
        ('reviewer-pg-e2e', '隔离测试质检员', 'REVIEWER', 'unused-e2e-password-hash', 'ACTIVE', false, 1,
          clock_timestamp() - interval '1 second', clock_timestamp() - interval '1 second')
      RETURNING id, username, role, credential_version
    `);
    const deletionPassword = `delete-${randomUUID()}`;
    await repository.pool.query(`
      UPDATE app_users SET must_change_password = false, deletion_password_hash = $1
      WHERE username = 'admin'
    `, [await hashUserPassword(deletionPassword)]);
    const admin = actorFrom(await repository.getUserByUsername('admin'));
    const workerRow = insertedUsers.rows.find((row) => row.username === 'worker-pg-e2e');
    const reviewerRow = insertedUsers.rows.find((row) => row.username === 'reviewer-pg-e2e');
    const worker = {
      userId: Number(workerRow.id), username: workerRow.username, role: workerRow.role,
      credentialVersion: Number(workerRow.credential_version),
    };
    const reviewer = {
      userId: Number(reviewerRow.id), username: reviewerRow.username, role: reviewerRow.role,
      credentialVersion: Number(reviewerRow.credential_version),
    };

    controlPlane = await startRealControlPlane(repository);
    const health = await requestJson(controlPlane.root, '/health');
    assert.equal(health.data.ok, true);
    assert.equal(health.data.capabilities.queryPackageVersion, 1);
    assert.equal(health.data.capabilities.copySamplingVersion, 1);
    assert.equal(health.data.capabilities.finalDeliveryVersion, 2);

    const currentSettings = (await requestJson(
      controlPlane.root, '/v1/workflow-quality-settings', { actor: admin },
    )).data;
    const settings = (await requestJson(controlPlane.root, '/v1/workflow-quality-settings', {
      actor: admin,
      method: 'PUT',
      body: {
      expectedVersion: currentSettings.version,
      queryPackage: { workerImportEnabled: false },
      copySampling: {
        enabled: true,
        rateBps: 10_000,
        blindReviewEnabled: true,
        reviewerBatchReturnEnabled: true,
      },
      },
    })).data;
    assert.equal(settings.copySampling.rateBps, 10_000);
    assert.equal(settings.copySampling.blindReviewEnabled, true);
    assert.equal((await requestJson(
      controlPlane.root, '/v1/workflow-quality-settings', { actor: worker },
    )).data.queryPackage.workerImportEnabled, false);

    const deniedWorkerImport = await requestJson(controlPlane.root, '/v1/query-packages', {
      actor: worker,
      method: 'POST',
      body: {
        name: '作业员无权导入',
        requestId: randomUUID(),
        items: [{ query: '这条数据必须回滚' }],
      },
      expectedStatus: 403,
    });
    assert.equal(deniedWorkerImport.error.code, 'FORBIDDEN');
    const deniedDirectTask = await requestJson(controlPlane.root, '/v1/tasks', {
      actor: worker,
      method: 'POST',
      body: { nodeId: 'pg18-e2e-node', tasks: [{ query: '不得绕过词包筛选' }] },
      expectedStatus: 403,
    });
    assert.equal(deniedDirectTask.error.code, 'FORBIDDEN');

    const concurrentImportRequestId = randomUUID();
    const concurrentImportBody = {
      name: 'PostgreSQL 18 并发幂等导入',
      requestId: concurrentImportRequestId,
      items: [{ query: '隔离测试并发导入 Query' }],
    };
    const concurrentImports = await Promise.all(Array.from({ length: 2 }, () => requestJson(
      controlPlane.root, '/v1/query-packages', {
        actor: admin,
        method: 'POST',
        expectedStatus: 201,
        body: concurrentImportBody,
      },
    )));
    assert.deepEqual(concurrentImports[1].data, concurrentImports[0].data,
      'simultaneous retries must replay the first committed receipt');
    const concurrentImportRows = await repository.pool.query(`
      SELECT COUNT(*) AS package_count,
        (SELECT COUNT(*) FROM query_package_mutation_requests
          WHERE actor_account_id = $1 AND request_id = $2) AS receipt_count
      FROM query_packages WHERE name = $3
    `, [admin.userId, concurrentImportRequestId, concurrentImportBody.name]);
    assert.deepEqual({
      packageCount: Number(concurrentImportRows.rows[0].package_count),
      receiptCount: Number(concurrentImportRows.rows[0].receipt_count),
    }, { packageCount: 1, receiptCount: 1 });

    const disposableQuery = '隔离测试永久删除后不可残留的 Query';
    const disposablePackage = (await requestJson(controlPlane.root, '/v1/query-packages', {
      actor: admin,
      method: 'POST',
      expectedStatus: 201,
      body: {
        name: 'PostgreSQL 18 待永久删除词包',
        requestId: randomUUID(),
        items: [{ query: disposableQuery }],
      },
    })).data;
    assert.equal(disposablePackage.assignedToUserId, null);
    const assignedDisposable = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/assignee`, {
        actor: admin,
        method: 'PATCH',
        body: {
          expectedVersion: disposablePackage.version,
          assignedToUserId: worker.username,
          assignedToAccountId: worker.userId,
        },
      },
    )).data;
    assert.equal(assignedDisposable.assignedToUserId, worker.username);
    const disposableDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}`, { actor: worker },
    )).data;
    const abandonedDisposable = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/screening`, {
        actor: worker,
        method: 'PUT',
        body: {
          expectedVersion: disposableDetail.version,
          requestId: randomUUID(),
          decisions: [{
            itemId: disposableDetail.items[0].id,
            decision: 'REJECT',
            reason: '隔离测试：该 Query 不适合生产',
          }],
        },
      },
    )).data;
    assert.equal(abandonedDisposable.status, 'ABANDONED');
    const deletePreview = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/permanent-delete-preview`,
      { actor: admin },
    )).data;
    assert.deepEqual({
      eligible: deletePreview.eligible,
      itemCount: deletePreview.itemCount,
      productionBatchCount: deletePreview.productionBatchCount,
      detachedTaskCount: deletePreview.detachedTaskCount,
      tasksWillBeDeleted: deletePreview.tasksWillBeDeleted,
    }, {
      eligible: true,
      itemCount: 1,
      productionBatchCount: 0,
      detachedTaskCount: 0,
      tasksWillBeDeleted: false,
    });
    const deletion = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/permanent`, {
        actor: admin,
        method: 'DELETE',
        body: {
          expectedVersion: deletePreview.version,
          reason: '隔离测试验证废弃词包真删除',
          deletionPassword,
          confirmationName: deletePreview.name,
          requestId: randomUUID(),
        },
      },
    )).data;
    assert.deepEqual(deletion, {
      id: disposablePackage.id,
      permanentlyDeleted: true,
      detachedTaskCount: 0,
    });
    const deletionResidue = await repository.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM query_packages WHERE id = $1) AS package_count,
        (SELECT COUNT(*) FROM query_package_items WHERE query_package_id = $1) AS item_count,
        (SELECT COUNT(*) FROM query_package_deletion_audits
          WHERE deleted_query_package_id = $1) AS audit_count,
        (SELECT COALESCE(string_agg(response::text, ''), '')
          FROM query_package_mutation_requests WHERE query_package_id = $1) AS receipts
    `, [disposablePackage.id]);
    assert.deepEqual({
      packageCount: Number(deletionResidue.rows[0].package_count),
      itemCount: Number(deletionResidue.rows[0].item_count),
      auditCount: Number(deletionResidue.rows[0].audit_count),
    }, { packageCount: 0, itemCount: 0, auditCount: 1 });
    assert.equal(deletionResidue.rows[0].receipts.includes(disposableQuery), false);

    const createdPackage = (await requestJson(controlPlane.root, '/v1/query-packages', {
      actor: admin,
      method: 'POST',
      expectedStatus: 201,
      body: {
        name: 'PostgreSQL 18 隔离端到端词包',
        sourceFileName: 'synthetic-e2e.txt',
        assignedToUserId: worker.username,
        requestId: randomUUID(),
        items: [
          { externalId: 'pg-e2e-1', query: '隔离测试 Query 一' },
          { externalId: 'pg-e2e-2', query: '隔离测试 Query 二' },
        ],
      },
    })).data;
    assert.equal(createdPackage.status, 'IMPORTED');
    assert.equal(createdPackage.counts.pending, 2);
    assert.equal(createdPackage.assignedToUserId, worker.username);

    const visiblePackages = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: worker },
    )).data;
    assert.deepEqual(visiblePackages.map((item) => item.id), [createdPackage.id]);
    assert.deepEqual(normalizePackageList(visiblePackages).map((item) => item.id), [createdPackage.id]);
    const packageDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, { actor: worker },
    )).data;
    assert.ok(packageDetail.items.every((item) => item.status === 'READY'));
    const normalizedPackageDetail = normalizePackageDetail(packageDetail);
    assert.equal(normalizedPackageDetail.items.length, 2);
    assert.ok(normalizedPackageDetail.items.every((item) => item.validationStatus === 'READY'));
    const screenedPackage = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/screening`, {
        actor: worker,
        method: 'PUT',
        body: {
          expectedVersion: packageDetail.version,
          requestId: randomUUID(),
          decisions: packageDetail.items.map((item) => ({ itemId: item.id, decision: 'SELECT' })),
        },
      },
    )).data;
    assert.equal(screenedPackage.status, 'READY');

    const productionBatch = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/production-batches`, {
        actor: worker,
        method: 'POST',
        expectedStatus: 201,
        body: {
          expectedVersion: screenedPackage.version,
          requestId: randomUUID(),
          itemIds: packageDetail.items.map((item) => item.id),
          nodeId: 'pg18-e2e-node',
        },
      },
    )).data;
    assert.equal(productionBatch.taskIds.length, 2);
    assert.equal((await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, { actor: worker },
    )).data.status, 'USED_UP');

    await repository.registerNode({
      nodeId: 'pg18-e2e-node',
      name: 'PostgreSQL 18 E2E node',
      imageWorkerEnabled: true,
      copyConcurrency: 2,
      imageConcurrency: 1,
    });
    const copyClaims = await repository.claimCopyBatch({
      nodeId: 'pg18-e2e-node',
      limit: 2,
      requestId: createClaimRequestId(),
    });
    assert.equal(copyClaims.claims.length, 2);

    const completedCopies = [];
    for (const [index, claim] of copyClaims.claims.entries()) {
      const completed = await repository.completeCopy(claim.execution.id, validCopyContent(index + 1));
      completedCopies.push(completed);
      assert.equal(completed.task.state, 'COPY_REVIEW_PENDING');
    }

    const firstApproved = (await requestJson(
      controlPlane.root, `/v1/tasks/${completedCopies[0].task.id}/approve-copy`, {
        actor: worker,
        method: 'POST',
        body: {
          revisionId: completedCopies[0].revision.id,
          nodeId: 'pg18-e2e-node',
          decision: 'APPROVE',
          score: 3,
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(firstApproved.state, 'COPY_QC_PENDING');
    assert.equal(Number((await repository.pool.query(
      'SELECT COUNT(*) AS count FROM copy_sampling_freezes WHERE production_batch_id = $1',
      [productionBatch.id],
    )).rows[0].count), 0, 'sampling must wait until the whole production batch finishes initial review');

    const secondApproved = (await requestJson(
      controlPlane.root, `/v1/tasks/${completedCopies[1].task.id}/approve-copy`, {
        actor: worker,
        method: 'POST',
        body: {
          revisionId: completedCopies[1].revision.id,
          nodeId: 'pg18-e2e-node',
          decision: 'APPROVE',
          score: 3,
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(secondApproved.state, 'COPY_QC_PENDING');

    const frozen = (await repository.pool.query(`
      SELECT * FROM copy_sampling_freezes WHERE production_batch_id = $1
    `, [productionBatch.id])).rows[0];
    assert.equal(frozen.population_count, 2);
    assert.equal(frozen.sample_count, 2);
    assert.equal(frozen.rate_bps, 10_000);
    assert.equal(frozen.blind_review_enabled, true);
    assert.equal(frozen.status, 'INSPECTING');

    const blindItems = (await requestJson(
      controlPlane.root, '/v1/copy-qa/items?status=PENDING', { actor: reviewer },
    )).data;
    assert.equal(blindItems.length, 2);
    blindItems.forEach(assertBlindQaAllowlist);
    assert.equal(normalizeCopyQaList(blindItems).length, 2);
    const blindDetail = (await requestJson(
      controlPlane.root, `/v1/copy-qa/items/${encodeURIComponent(blindItems[0].id)}`, { actor: reviewer },
    )).data;
    assertBlindQaAllowlist(blindDetail);

    const adminQaItems = (await requestJson(
      controlPlane.root, '/v1/copy-qa/items?status=PENDING', { actor: admin },
    )).data;
    const normalizedAdminQaItems = normalizeCopyQaList(adminQaItems);
    assert.equal(normalizedAdminQaItems.length, 2);
    assert.ok(normalizedAdminQaItems.every((item) => item.taskId !== null));
    assert.ok(normalizedAdminQaItems.every((item) => item.productionBatchId === productionBatch.id));
    assert.ok(normalizedAdminQaItems.every((item) => item.finalApproverAccountId === worker.userId));

    const reviewerTaskList = (await requestJson(
      controlPlane.root, '/v1/tasks?limit=100', { actor: reviewer },
    )).data;
    assert.ok(productionBatch.taskIds.every(
      (taskId) => !reviewerTaskList.some((task) => task.id === taskId),
    ), 'active blind-QA tasks must be absent from the generic reviewer task list');
    const guessedBlindTask = await requestJson(
      controlPlane.root, `/v1/tasks/${productionBatch.taskIds[0]}`, {
        actor: reviewer,
        expectedStatus: 404,
      },
    );
    assert.equal(guessedBlindTask.error.code, 'TASK_NOT_FOUND');

    const returnedItemRow = (await repository.pool.query(`
      SELECT task_id FROM copy_sampling_items WHERE public_id = $1
    `, [blindItems[0].id])).rows[0];
    const returnedTaskId = Number(returnedItemRow.task_id);
    const singleReturn = (await requestJson(
      controlPlane.root, `/v1/copy-qa/items/${encodeURIComponent(blindItems[0].id)}/return`, {
        actor: reviewer,
        method: 'POST',
        body: {
          expectedRevisionToken: blindItems[0].approvedRevision.revisionToken,
          reasonCodes: ['FACT_ERROR'],
          note: '隔离测试：单条抽检退回并要求修改正文',
          requestId: randomUUID(),
        },
      },
    )).data;
    assert.deepEqual(singleReturn, { id: blindItems[0].id, status: 'RETURNED' });

    const settingsAfterReturn = (await requestJson(
      controlPlane.root, '/v1/workflow-quality-settings', { actor: admin },
    )).data;
    const changedGlobalPolicy = (await requestJson(
      controlPlane.root, '/v1/workflow-quality-settings', {
        actor: admin,
        method: 'PUT',
        body: {
          expectedVersion: settingsAfterReturn.version,
          copySampling: { blindReviewEnabled: false },
        },
      },
    )).data;
    assert.equal(changedGlobalPolicy.copySampling.blindReviewEnabled, false,
      'the live policy is deliberately changed before the mandatory round');

    const returnedTask = await repository.getTask(returnedTaskId);
    assert.equal(returnedTask.state, 'COPY_REVIEW_PENDING');
    assert.equal(returnedTask.mandatoryCopyQc, true);
    assert.equal(returnedTask.mandatoryCopyQcOrigin, 'QA_RETURN');
    assert.equal((await repository.getTaskAccess(returnedTaskId)).activeBlindQa, true);
    const returnedRevision = returnedTask.copyRevisions.find(
      (revision) => revision.id === returnedTask.currentCopyRevisionId,
    );
    assert.equal(returnedRevision.revisionOrigin, 'QA_RETURN');
    const guessedReturnedTask = await requestJson(
      controlPlane.root, `/v1/tasks/${returnedTaskId}`, { actor: reviewer, expectedStatus: 404 },
    );
    assert.equal(guessedReturnedTask.error.code, 'TASK_NOT_FOUND');

    const editedContent = validCopyContent(1, { edited: true });
    const resubmitted = (await requestJson(
      controlPlane.root, `/v1/tasks/${returnedTaskId}/approve-copy`, {
        actor: worker,
        method: 'POST',
        body: {
          revisionId: returnedRevision.id,
          nodeId: 'pg18-e2e-node',
          edits: editedContent,
          decision: 'APPROVE',
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(resubmitted.state, 'COPY_QC_PENDING');
    assert.equal(resubmitted.mandatoryCopyQc, true);

    const pendingAfterResubmit = (await requestJson(
      controlPlane.root, '/v1/copy-qa/items?status=PENDING', { actor: reviewer },
    )).data;
    const mandatoryItem = pendingAfterResubmit.find((item) => item.sampleKind === 'MANDATORY_RECHECK');
    const remainingRandomItem = pendingAfterResubmit.find((item) => item.sampleKind === 'RANDOM');
    assert.ok(mandatoryItem, 'returned copy must create a mandatory QA item');
    assert.ok(remainingRandomItem, 'the other random sample must remain held');
    assertBlindQaAllowlist(mandatoryItem);
    const mandatoryFreezePolicy = await repository.pool.query(`
      SELECT sampling_freeze.blind_review_enabled
      FROM copy_sampling_items AS item
      JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
      WHERE item.public_id = $1
    `, [mandatoryItem.id]);
    assert.equal(mandatoryFreezePolicy.rows[0].blind_review_enabled, true,
      'mandatory recheck inherits the parent freeze even after the global blind switch changes');

    const mandatoryPass = (await requestJson(
      controlPlane.root, `/v1/copy-qa/items/${encodeURIComponent(mandatoryItem.id)}/pass`, {
        actor: reviewer,
        method: 'POST',
        body: {
          expectedRevisionToken: mandatoryItem.approvedRevision.revisionToken,
          requestId: randomUUID(),
        },
      },
    )).data;
    assert.equal(mandatoryPass.status, 'PASSED');
    assert.equal((await repository.getTask(returnedTaskId)).state, 'IMAGE_QUEUED');

    const finalRandomPass = (await requestJson(
      controlPlane.root, `/v1/copy-qa/items/${encodeURIComponent(remainingRandomItem.id)}/pass`, {
        actor: reviewer,
        method: 'POST',
        body: {
          expectedRevisionToken: remainingRandomItem.approvedRevision.revisionToken,
          requestId: randomUUID(),
        },
      },
    )).data;
    assert.equal(finalRandomPass.status, 'PASSED');
    const releasedTasks = await repository.pool.query(`
      SELECT id, state, mandatory_copy_qc FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [productionBatch.taskIds]);
    assert.deepEqual(releasedTasks.rows.map((row) => row.state), ['IMAGE_QUEUED', 'IMAGE_QUEUED']);
    assert.ok(releasedTasks.rows.every((row) => row.mandatory_copy_qc === false));
    const originalBatchClosure = (await repository.pool.query(`
      SELECT sampling_freeze.status AS freeze_status, batch.status AS batch_status,
        batch.sampling_status
      FROM copy_sampling_freezes AS sampling_freeze
      JOIN production_batches AS batch ON batch.id = sampling_freeze.production_batch_id
      WHERE sampling_freeze.id = $1
    `, [frozen.id])).rows[0];
    assert.equal(originalBatchClosure.freeze_status, 'RELEASED');
    assert.equal(originalBatchClosure.batch_status, 'RELEASED');
    assert.equal(originalBatchClosure.sampling_status, 'COMPLETED');
    const reviewerDetailAfterClosure = await requestJson(
      controlPlane.root, `/v1/tasks/${returnedTaskId}`, { actor: reviewer },
    );
    assert.equal(reviewerDetailAfterClosure.data.id, returnedTaskId);
    assert.equal(Object.hasOwn(reviewerDetailAfterClosure.data, 'executions'), false);

    // Keep this final phase deterministic and model-free: the temporary worker returns
    // three synthetic image descriptors. Removing the catalog only affects this disposable DB.
    await repository.pool.query(`
      UPDATE global_settings SET value = value - 'layoutCatalog' WHERE key = 'production'
    `);
    const imageClaims = await repository.claimImageBatch({
      nodeId: 'pg18-e2e-node',
      limit: 1,
      requestId: createClaimRequestId(),
      imageControlsVersion: 1,
      layoutCatalogVersion: 0,
    });
    assert.equal(imageClaims.claims.length, 1);
    const imageClaim = imageClaims.claims[0];
    async function completeSyntheticImage(claim, marker) {
      const imageCount = claim.execution.snapshot.copyRevision.content.imagePlan.length;
      const recordedImages = [];
      const taskAssetDirectory = join(controlPlane.storageRoot, 'tasks', String(claim.task.id));
      await mkdir(taskAssetDirectory, { recursive: true });
      for (let index = 0; index < imageCount; index += 1) {
        const bytes = Buffer.from(`isolated-postgres-e2e-${marker}-${index + 1}`, 'utf8');
        const originalName = `${marker}-page-${index + 1}.png`;
        const storagePath = join(taskAssetDirectory, originalName);
        await writeFile(storagePath, bytes);
        const asset = await repository.recordAsset({
          executionId: claim.execution.id,
          mediaType: 'image/png',
          byteSize: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storagePath,
          originalName,
        });
        recordedImages.push({ page: index + 1, assetId: asset.id });
      }
      await repository.completeImage(claim.execution.id, {
        imageControlsVersion: 1,
        images: recordedImages,
      });
      return recordedImages;
    }

    await completeSyntheticImage(imageClaim, 'initial');
    assert.equal((await repository.getTask(imageClaim.task.id)).state, 'MANUAL_ARCHIVE');
    const prematureArchive = await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/archive`, {
        actor: worker,
        expectedStatus: 409,
      },
    );
    assert.equal(prematureArchive.error.code, 'INVALID_TASK_STATE');

    const finalRework = (await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/review-images`, {
        actor: reviewer,
        method: 'POST',
        body: {
          imageRunId: imageClaim.execution.id,
          decision: 'REWORK',
          reworkTarget: 'COPY',
          score: 2,
          reasons: ['CONTENT_MISMATCH'],
          note: '隔离测试：图片终审要求修改文案并重新经过强制质检',
          problemAssetIds: [],
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(finalRework.state, 'COPY_REVIEW_PENDING');
    assert.equal(finalRework.mandatoryCopyQc, true);
    assert.equal(finalRework.mandatoryCopyQcOrigin, 'FINAL_REWORK');
    assert.equal(finalRework.currentImageRunId, null);
    const finalReworkTask = await repository.getTask(imageClaim.task.id);
    const finalReworkPlaceholder = finalReworkTask.copyRevisions.find(
      (revision) => revision.id === finalReworkTask.currentCopyRevisionId,
    );
    assert.equal(finalReworkPlaceholder.revisionOrigin, 'FINAL_REWORK');
    assert.equal(finalReworkPlaceholder.copyReworkSatisfied, false);

    const finalReworkApproval = (await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/approve-copy`, {
        actor: worker,
        method: 'POST',
        body: {
          revisionId: finalReworkPlaceholder.id,
          nodeId: 'pg18-e2e-node',
          edits: validCopyContent(9, { edited: true }),
          decision: 'APPROVE',
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(finalReworkApproval.state, 'COPY_QC_PENDING');
    assert.equal(finalReworkApproval.mandatoryCopyQc, true);

    const finalReworkQaItems = (await requestJson(
      controlPlane.root, '/v1/copy-qa/items?status=PENDING', { actor: reviewer },
    )).data;
    const finalReworkQaItem = finalReworkQaItems.find(
      (item) => item.sampleKind === 'MANDATORY_RECHECK' && item.taskId === imageClaim.task.id,
    );
    assert.ok(finalReworkQaItem, 'final image-review copy return must create an independent mandatory QA round');
    assert.equal(finalReworkQaItem.blindReview, false,
      'FINAL_REWORK mandatory QA uses the live policy because it has no original random-sample parent');
    const finalReworkQaRow = (await repository.pool.query(`
      SELECT parent_item_id FROM copy_sampling_items WHERE public_id = $1
    `, [finalReworkQaItem.id])).rows[0];
    assert.equal(finalReworkQaRow.parent_item_id, null);
    const finalReworkPass = (await requestJson(
      controlPlane.root, `/v1/copy-qa/items/${encodeURIComponent(finalReworkQaItem.id)}/pass`, {
        actor: reviewer,
        method: 'POST',
        body: {
          expectedRevisionToken: finalReworkQaItem.approvedRevision.revisionToken,
          requestId: randomUUID(),
        },
      },
    )).data;
    assert.equal(finalReworkPass.status, 'PASSED');
    const taskAfterFinalRecheck = await repository.getTask(imageClaim.task.id);
    assert.equal(taskAfterFinalRecheck.state, 'IMAGE_QUEUED');
    assert.equal(taskAfterFinalRecheck.mandatoryCopyQc, false);

    let finalImageClaim = null;
    for (let attempt = 0; attempt < 2 && !finalImageClaim; attempt += 1) {
      const nextClaims = await repository.claimImageBatch({
        nodeId: 'pg18-e2e-node',
        limit: 1,
        requestId: createClaimRequestId(),
        imageControlsVersion: 1,
        layoutCatalogVersion: 0,
      });
      assert.equal(nextClaims.claims.length, 1);
      const candidate = nextClaims.claims[0];
      if (candidate.task.id === imageClaim.task.id) finalImageClaim = candidate;
      else await completeSyntheticImage(candidate, `other-${attempt + 1}`);
    }
    assert.ok(finalImageClaim, 'the final-rework task must return to the real image queue');
    await completeSyntheticImage(finalImageClaim, 'after-final-rework');
    assert.equal((await repository.getTask(imageClaim.task.id)).state, 'MANUAL_ARCHIVE');

    const reviewed = (await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/review-images`, {
        actor: reviewer,
        method: 'POST',
        body: {
          imageRunId: finalImageClaim.execution.id,
          decision: 'APPROVE',
          score: 3,
          reasons: [],
          problemAssetIds: [],
          reviewSessionId: randomUUID(),
        },
      },
    )).data;
    assert.equal(reviewed.state, 'REVIEWED');
    const delivery = await repository.assertTaskReadyForDelivery(imageClaim.task.id);
    assert.equal(delivery.taskId, imageClaim.task.id);
    assert.equal(delivery.status, 'READY');
    assert.equal(delivery.imageRunId, finalImageClaim.execution.id);
    const workerDeliveryPool = (await requestJson(
      controlPlane.root, '/v1/delivery-pool', { actor: worker },
    )).data;
    assert.ok(workerDeliveryPool.some((entry) => entry.taskId === imageClaim.task.id));
    const adminDeliveryPage = (await requestJson(
      controlPlane.root, '/v1/delivery-pool?limit=200&offset=0&includeTotal=true', { actor: admin },
    )).data;
    assert.equal(adminDeliveryPage.total, 1);
    assert.equal(adminDeliveryPage.items[0].taskId, imageClaim.task.id);
    const preparedDelivery = (await requestJson(
      controlPlane.root, '/v1/delivery-pool/archive', {
        actor: admin,
        method: 'POST',
        body: { scope: 'ALL_READY' },
        expectedStatus: 201,
      },
    )).data;
    assert.equal(preparedDelivery.taskCount, 1);
    const allDeliveryResponse = await fetch(
      `${controlPlane.root}/v1/delivery-pool/archive/${preparedDelivery.downloadId}`,
      { headers: actorHeaders(admin) },
    );
    assert.equal(allDeliveryResponse.status, 200);
    const allDeliveryArchive = await JSZip.loadAsync(await allDeliveryResponse.arrayBuffer());
    assert.ok(allDeliveryArchive.file(`任务-${imageClaim.task.id}-资源包.zip`));
    const archiveResponse = await fetch(
      `${controlPlane.root}/v1/tasks/${imageClaim.task.id}/archive`,
      { headers: actorHeaders(worker) },
    );
    assert.equal(archiveResponse.status, 200);
    assert.match(archiveResponse.headers.get('content-type') ?? '', /application\/zip/u);
    assert.ok((await archiveResponse.arrayBuffer()).byteLength > 0);
  } finally {
    await controlPlane?.stop().catch(() => {});
    await repository.close().catch(() => {});
    await cluster.stop();
  }
});
