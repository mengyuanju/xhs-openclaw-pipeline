import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  XIAOHONGSHU_SEARCH_DEFAULT_LIMIT,
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
} from '../../src/xhs-query-search.mjs';
import {
  applyMigrations,
  loadMigrations,
  normalizeMigrationSql,
  sha256,
} from '../src/database-migrations.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  createQueryPackage,
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

const USER_TASK_SENSITIVE_FIELDS = Object.freeze([
  'sourceQueryPackageId',
  'sourceQueryPackageName',
  'sourceQueryPackageExternalId',
  'productionBatchId',
  'deliveryStatus',
]);

const USER_TASK_XHS_FIELDS = Object.freeze([
  'xiaohongshuSearchStatus',
  'xiaohongshuSearchBlockedReason',
  'xiaohongshuLinks',
]);

function assertUserTaskHidesSensitiveFields(task, source, { includeXhsSearch = false } = {}) {
  const hiddenFields = includeXhsSearch
    ? USER_TASK_SENSITIVE_FIELDS
    : [...USER_TASK_SENSITIVE_FIELDS, ...USER_TASK_XHS_FIELDS];
  for (const field of hiddenFields) {
    assert.equal(Object.hasOwn(task, field), false, `${source} exposed ${field}`);
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

test('legacy delivery migrations retain their checksums and upgrade through the compatibility repair', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const throughSampling = migrations.filter(({ id }) => id <= '0025_copy_sampling');
    const legacyMigrations = await Promise.all([
      '0026_final_delivery',
      '0027_delivery_archive_integrity',
    ].map(async (id) => {
      const sql = normalizeMigrationSql(await readFile(
        new URL(`./fixtures/${id}.legacy.sql`, import.meta.url),
        'utf8',
      ));
      return { id, sql, sha256: sha256(sql) };
    }));

    for (const legacy of legacyMigrations) {
      assert.notEqual(
        legacy.sha256,
        migrations.find(({ id }) => id === legacy.id)?.sha256,
        `${legacy.id} fixture must exercise a genuinely different historical checksum`,
      );
    }

    async function applyInTransaction(selectedMigrations) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO public');
        const applied = await applyMigrations(client, selectedMigrations);
        await client.query('COMMIT');
        return applied;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    async function applyLegacyInTransaction(legacy) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO public');
        await client.query(legacy.sql);
        await client.query(
          'INSERT INTO control_plane_migrations(id, sha256) VALUES ($1, $2)',
          [legacy.id, legacy.sha256],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    await applyInTransaction(throughSampling);
    await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('legacy-upgrade-node', 'Legacy Upgrade Node')");
    const taskId = Number((await pool.query(`
      INSERT INTO tasks(query, input, state, created_by_node_id, copy_executor_node_id)
      VALUES ('legacy delivery compatibility fixture', '{}'::jsonb, 'COPY_REVIEW_PENDING',
        'legacy-upgrade-node', 'legacy-upgrade-node')
      RETURNING id
    `)).rows[0].id);
    const firstCopyExecutionId = randomUUID();
    const secondCopyExecutionId = randomUUID();
    const imageExecutionId = randomUUID();
    await pool.query(`
      INSERT INTO task_executions(
        id, task_id, kind, node_id, status, stage, progress_percent, progress_message,
        progress_details, snapshot, finished_at
      ) VALUES
        ($1, $4, 'COPY', 'legacy-upgrade-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now()),
        ($2, $4, 'COPY', 'legacy-upgrade-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now()),
        ($3, $4, 'IMAGE', 'legacy-upgrade-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now())
    `, [firstCopyExecutionId, secondCopyExecutionId, imageExecutionId, taskId]);

    const firstMachineCopy = { title: '第一代机器稿', body: '第一代内容' };
    const secondMachineCopy = { title: '第二代机器稿', body: '第二代内容' };
    const firstMachineRevisionId = Number((await pool.query(`
      INSERT INTO copy_revisions(task_id, execution_id, revision, content)
      VALUES ($1, $2, 1, $3::jsonb)
      RETURNING id
    `, [taskId, firstCopyExecutionId, JSON.stringify({ copy: firstMachineCopy })])).rows[0].id);
    const secondMachineRevisionId = Number((await pool.query(`
      INSERT INTO copy_revisions(task_id, execution_id, revision, content)
      VALUES ($1, $2, 2, $3::jsonb)
      RETURNING id
    `, [taskId, secondCopyExecutionId, JSON.stringify({ copy: secondMachineCopy })])).rows[0].id);
    const unchangedHumanRevisionId = Number((await pool.query(`
      INSERT INTO copy_revisions(task_id, revision, content, approved_at)
      VALUES ($1, 3, $2::jsonb, now())
      RETURNING id
    `, [
      taskId,
      JSON.stringify({
        copy: secondMachineCopy,
        manualReview: { baseRevisionId: secondMachineRevisionId },
      }),
    ])).rows[0].id);
    const oversizedReferenceRevisionId = Number((await pool.query(`
      INSERT INTO copy_revisions(task_id, revision, content)
      VALUES ($1, 4, $2::jsonb)
      RETURNING id
    `, [taskId, JSON.stringify({ copy: secondMachineCopy })])).rows[0].id);

    const imageRunId = randomUUID();
    await pool.query(`
      INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id, status, result, finished_at)
      VALUES ($1, $2, $3, $4, 'COMPLETED', '{"images":[]}'::jsonb, now())
    `, [imageRunId, taskId, imageExecutionId, unchangedHumanRevisionId]);
    const assetId = Number((await pool.query(`
      INSERT INTO assets(task_id, image_run_id, media_type, byte_size, sha256, storage_path)
      VALUES ($1, $2, 'image/png', 1, $3, $4)
      RETURNING id
    `, [taskId, imageRunId, 'a'.repeat(64), `legacy-upgrade/${randomUUID()}.png`])).rows[0].id);
    await pool.query('UPDATE image_runs SET result = $2::jsonb WHERE id = $1', [
      imageRunId,
      JSON.stringify({ images: [{ deliveryAssetId: assetId }] }),
    ]);
    await pool.query(`
      UPDATE tasks
      SET state = 'REVIEWED', current_copy_revision_id = $2, current_image_run_id = $3,
        image_reviewed_by_user_id = 'legacy-reviewer', image_reviewed_at = now()
      WHERE id = $1
    `, [taskId, unchangedHumanRevisionId, imageRunId]);

    await applyLegacyInTransaction(legacyMigrations[0]);
    const legacyRevisionState = (await pool.query(`
      SELECT id, parent_revision_id, revision_origin, copy_content_changed_from_machine
      FROM copy_revisions
      WHERE task_id = $1
      ORDER BY revision
    `, [taskId])).rows;
    assert.deepEqual(legacyRevisionState.map((row) => ({
      id: Number(row.id),
      parentId: row.parent_revision_id === null ? null : Number(row.parent_revision_id),
      origin: row.revision_origin,
      changed: row.copy_content_changed_from_machine,
    })), [
      { id: firstMachineRevisionId, parentId: null, origin: 'GENERATION', changed: false },
      { id: secondMachineRevisionId, parentId: null, origin: 'GENERATION', changed: true },
      { id: unchangedHumanRevisionId, parentId: secondMachineRevisionId, origin: 'COPY_EDIT', changed: true },
      { id: oversizedReferenceRevisionId, parentId: null, origin: null, changed: true },
    ], 'legacy 0026 compares every later revision with the first machine generation');

    await pool.query('UPDATE copy_revisions SET content = $2::jsonb WHERE id = $1', [
      oversizedReferenceRevisionId,
      JSON.stringify({
        copy: secondMachineCopy,
        manualReview: { baseRevisionId: '9223372036854775808' },
      }),
    ]);
    await pool.query("UPDATE tasks SET state = 'MANUAL_ARCHIVE' WHERE id = $1", [taskId]);
    await applyLegacyInTransaction(legacyMigrations[1]);

    const legacyChecksums = (await pool.query(`
      SELECT id, sha256 FROM control_plane_migrations
      WHERE id = ANY($1::text[])
      ORDER BY id
    `, [legacyMigrations.map(({ id }) => id)])).rows;
    assert.deepEqual(legacyChecksums, legacyMigrations.map(({ id, sha256: checksum }) => ({
      id,
      sha256: checksum,
    })));
    assert.deepEqual((await pool.query(`
      SELECT status, withdrawn_at FROM delivery_entries WHERE task_id = $1
    `, [taskId])).rows, [{ status: 'READY', withdrawn_at: null }],
    'legacy 0027 leaves a valid-looking READY entry when its task is no longer REVIEWED');

    const appliedUpgrade = await applyInTransaction(migrations);
    assert.deepEqual(appliedUpgrade, [
      '0028_mutation_receipt_actor_identity',
      '0029_final_delivery_compatibility_repair',
      '0030_delivery_asset_runtime_integrity',
      '0031_xhs_query_search',
      '0032_duplicate_query_discard',
      '0033_query_package_preassignment_repair',
    ]);

    const repairedRevisionState = (await pool.query(`
      SELECT id, parent_revision_id, revision_origin, copy_content_changed_from_machine
      FROM copy_revisions
      WHERE task_id = $1
      ORDER BY revision
    `, [taskId])).rows;
    assert.deepEqual(repairedRevisionState.map((row) => ({
      id: Number(row.id),
      parentId: row.parent_revision_id === null ? null : Number(row.parent_revision_id),
      origin: row.revision_origin,
      changed: row.copy_content_changed_from_machine,
    })), [
      { id: firstMachineRevisionId, parentId: null, origin: 'GENERATION', changed: false },
      { id: secondMachineRevisionId, parentId: null, origin: 'GENERATION', changed: false },
      { id: unchangedHumanRevisionId, parentId: secondMachineRevisionId, origin: 'PLAN_EDIT', changed: false },
      { id: oversizedReferenceRevisionId, parentId: null, origin: 'PLAN_EDIT', changed: false },
    ]);

    const repairedDelivery = (await pool.query(`
      SELECT status, withdrawn_at FROM delivery_entries WHERE task_id = $1
    `, [taskId])).rows[0];
    assert.equal(repairedDelivery.status, 'WITHDRAWN');
    assert.ok(repairedDelivery.withdrawn_at instanceof Date);
    assert.deepEqual((await pool.query(`
      SELECT id, sha256 FROM control_plane_migrations
      WHERE id = ANY($1::text[])
      ORDER BY id
    `, [legacyMigrations.map(({ id }) => id)])).rows, legacyChecksums,
    'forward repair must preserve the historical migration checksums');
    assert.deepEqual(await applyInTransaction(migrations), [], 'a second upgrade has no pending migrations');
  } finally {
    await pool.end().catch(() => {});
    await database.stop().catch(() => {});
  }
});

test('delivery runtime integrity migration withdraws JavaScript-unsafe asset ids without resetting anomaly time', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const throughCompatibilityRepair = migrations.filter(
      ({ id }) => id <= '0029_final_delivery_compatibility_repair',
    );

    async function applyInTransaction(selectedMigrations) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL search_path TO public');
        const applied = await applyMigrations(client, selectedMigrations);
        await client.query('COMMIT');
        return applied;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    await applyInTransaction(throughCompatibilityRepair);
    await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('runtime-integrity-node', 'Runtime Integrity Node')");
    const taskId = Number((await pool.query(`
      INSERT INTO tasks(query, input, state, created_by_node_id, copy_executor_node_id)
      VALUES ('unsafe runtime asset id fixture', '{}'::jsonb, 'COPY_REVIEW_PENDING',
        'runtime-integrity-node', 'runtime-integrity-node')
      RETURNING id
    `)).rows[0].id);
    const copyExecutionId = randomUUID();
    const imageExecutionId = randomUUID();
    const imageRunId = randomUUID();
    await pool.query(`
      INSERT INTO task_executions(
        id, task_id, kind, node_id, status, stage, progress_percent, progress_message,
        progress_details, snapshot, finished_at
      ) VALUES
        ($1, $3, 'COPY', 'runtime-integrity-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now()),
        ($2, $3, 'IMAGE', 'runtime-integrity-node', 'SUCCEEDED', 'done', 100, 'done', '{}'::jsonb, '{}'::jsonb, now())
    `, [copyExecutionId, imageExecutionId, taskId]);
    const copyRevisionId = Number((await pool.query(`
      INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at)
      VALUES ($1, $2, 1, $3::jsonb, now())
      RETURNING id
    `, [
      taskId,
      copyExecutionId,
      JSON.stringify({ copy: { title: '运行时完整性稿', body: '隔离测试中的有效冻结文案。' } }),
    ])).rows[0].id);
    const unsafeAssetId = '9007199254740992';
    await pool.query(`
      INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id, status, result, finished_at)
      VALUES ($1, $2, $3, $4, 'COMPLETED', $5::jsonb, now())
    `, [
      imageRunId,
      taskId,
      imageExecutionId,
      copyRevisionId,
      JSON.stringify({ images: [{ deliveryAssetId: unsafeAssetId }] }),
    ]);
    const insertedAssetId = (await pool.query(`
      INSERT INTO assets(id, task_id, image_run_id, media_type, byte_size, sha256, storage_path)
      VALUES ($1::bigint, $2, $3, 'image/png', 1, $4, $5)
      RETURNING id::text AS id
    `, [
      unsafeAssetId,
      taskId,
      imageRunId,
      'b'.repeat(64),
      `migration-0030/${randomUUID()}.png`,
    ])).rows[0].id;
    assert.equal(insertedAssetId, unsafeAssetId);
    await pool.query(`
      UPDATE tasks
      SET state = 'REVIEWED', current_copy_revision_id = $2, current_image_run_id = $3,
        image_reviewed_by_user_id = 'runtime-integrity-reviewer', image_reviewed_at = now()
      WHERE id = $1
    `, [taskId, copyRevisionId, imageRunId]);
    await pool.query(`
      INSERT INTO delivery_entries(
        task_id, copy_revision_id, image_run_id, status, approved_by_username, approved_at
      ) VALUES ($1, $2, $3, 'READY', 'runtime-integrity-reviewer', now())
    `, [taskId, copyRevisionId, imageRunId]);
    const firstDetectedAt = '2024-01-02T03:04:05.000Z';
    await pool.query(`
      INSERT INTO delivery_migration_anomalies(task_id, reason, detected_at)
      VALUES ($1, 'LEGACY_REVIEWED_TASK_MISSING_FROZEN_DELIVERY_SOURCE', $2::timestamptz)
    `, [taskId, firstDetectedAt]);

    const beforeUpgrade = (await pool.query(`
      SELECT delivery.status, task.state,
        delivery.copy_revision_id = task.current_copy_revision_id AS copy_frozen,
        delivery.image_run_id = task.current_image_run_id AS image_frozen,
        revision.task_id = task.id AND revision.approved_at IS NOT NULL AS copy_source_valid,
        image_run.task_id = task.id
          AND image_run.copy_revision_id = revision.id
          AND image_run.status = 'COMPLETED' AS image_source_valid,
        asset.id::text AS asset_id,
        image_run.result #>> '{images,0,deliveryAssetId}' AS result_asset_id
      FROM delivery_entries AS delivery
      JOIN tasks AS task ON task.id = delivery.task_id
      JOIN copy_revisions AS revision ON revision.id = delivery.copy_revision_id
      JOIN image_runs AS image_run ON image_run.id = delivery.image_run_id
      JOIN assets AS asset
        ON asset.task_id = task.id
        AND asset.image_run_id = image_run.id
        AND asset.media_type LIKE 'image/%'
      WHERE delivery.task_id = $1
    `, [taskId])).rows[0];
    assert.deepEqual(beforeUpgrade, {
      status: 'READY',
      state: 'REVIEWED',
      copy_frozen: true,
      image_frozen: true,
      copy_source_valid: true,
      image_source_valid: true,
      asset_id: unsafeAssetId,
      result_asset_id: unsafeAssetId,
    });

    assert.deepEqual(await applyInTransaction(migrations), [
      '0030_delivery_asset_runtime_integrity',
      '0031_xhs_query_search',
      '0032_duplicate_query_discard',
      '0033_query_package_preassignment_repair',
    ]);
    const repairedDelivery = (await pool.query(`
      SELECT status, withdrawn_at FROM delivery_entries WHERE task_id = $1
    `, [taskId])).rows[0];
    assert.equal(repairedDelivery.status, 'WITHDRAWN');
    assert.ok(repairedDelivery.withdrawn_at instanceof Date);
    const anomaly = (await pool.query(`
      SELECT reason, detected_at FROM delivery_migration_anomalies WHERE task_id = $1
    `, [taskId])).rows[0];
    assert.equal(anomaly.reason, 'READY_DELIVERY_SOURCE_NOT_ARCHIVABLE');
    assert.equal(anomaly.detected_at.toISOString(), firstDetectedAt,
      'the first anomaly detection timestamp must remain stable during reason repair');
    assert.deepEqual(await applyInTransaction(migrations), [], 'a second upgrade has no pending migrations');
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

test('Query-package preassignment repair clears only the proven legacy signature', {
  skip: RUN_POSTGRES_E2E ? false : 'set RUN_POSTGRES_E2E=1 to run the isolated PostgreSQL 18 migration test',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  try {
    const migrations = await loadMigrations();
    const beforeRepair = migrations.filter(({ id }) => id < '0033_query_package_preassignment_repair');
    const repair = migrations.find(({ id }) => id === '0033_query_package_preassignment_repair');
    assert.ok(repair);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO public');
      await applyMigrations(client, beforeRepair);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const worker = (await pool.query(`
      INSERT INTO app_users(
        username, display_name, role, password_hash, status,
        must_change_password, credential_version, created_at, updated_at
      ) VALUES (
        'legacy-query-owner', '旧版词包负责人', 'USER', 'unused-migration-password-hash', 'ACTIVE',
        false, 1, '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z'
      ) RETURNING id, username
    `)).rows[0];
    await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('legacy-query-node', 'Legacy Query Node')");
    const queryPackage = (await pool.query(`
      INSERT INTO query_packages(
        name, status, created_by_account_id, created_by_username,
        assigned_to_account_id, assigned_to_username
      ) SELECT '旧版预分配迁移验证', 'PARTIALLY_USED', admin.id, admin.username, $1, $2
        FROM app_users AS admin WHERE admin.username = 'admin'
      RETURNING id
    `, [worker.id, worker.username])).rows[0];
    const productionBatch = (await pool.query(`
      INSERT INTO production_batches(
        public_id, query_package_id, query_package_name, created_by_account_id,
        created_by_username, request_id, request_fingerprint
      ) SELECT $1, $2, '旧版预分配迁移验证', admin.id, admin.username, $3, $4
        FROM app_users AS admin WHERE admin.username = 'admin'
      RETURNING id
    `, [randomUUID(), queryPackage.id, randomUUID(), 'a'.repeat(64)])).rows[0];
    const items = (await pool.query(`
      INSERT INTO query_package_items(
        query_package_id, row_number, raw_query, query, status, screening_decision
      )
      SELECT $1, ordinal, '迁移测试 Query ' || ordinal, '迁移测试 Query ' || ordinal,
        'TASK_CREATED', 'SELECTED'
      FROM generate_series(1, 9) AS ordinal
      ORDER BY ordinal
      RETURNING id, row_number
    `, [queryPackage.id])).rows.toSorted((left, right) => Number(left.row_number) - Number(right.row_number));
    const taskCases = [
      { key: 'queued', state: 'COPY_QUEUED', stage: 'COPY_QUEUED', expectedCleared: true },
      { key: 'running', state: 'COPY_RUNNING', stage: 'COPY_GENERATION', expectedCleared: true },
      { key: 'failed', state: 'COPY_FAILED', stage: 'COPY_FAILED', expectedCleared: true },
      { key: 'review', state: 'COPY_REVIEW_PENDING', stage: 'COPY_REVIEW_PENDING', expectedCleared: true },
      { key: 'audited', state: 'COPY_QUEUED', stage: 'COPY_QUEUED', addEvent: true, expectedCleared: false },
      { key: 'later-assignment', state: 'COPY_QUEUED', stage: 'COPY_QUEUED', assignedLater: true, expectedCleared: false },
      { key: 'image', state: 'IMAGE_QUEUED', stage: 'IMAGE_QUEUED', expectedCleared: false },
      { key: 'skip-review', state: 'COPY_QUEUED', stage: 'COPY_QUEUED', skipCopyReview: true, expectedCleared: false },
      { key: 'image-recovery', state: 'COPY_REVIEW_PENDING', stage: 'IMAGE_RETRY_EXHAUSTED', expectedCleared: false },
    ];
    const taskIds = new Map();
    for (const [index, taskCase] of taskCases.entries()) {
      const item = items[index];
      const createdAt = '2026-01-01T00:00:00Z';
      const task = (await pool.query(`
        INSERT INTO tasks(
          query, input, created_by_node_id, created_by_user_id,
          assigned_to_user_id, assignment_source, assigned_at,
          state, current_stage, progress_message, skip_copy_review,
          source_query_package_id, source_query_package_item_id,
          source_query_package_name, production_batch_id, created_at, updated_at
        ) VALUES (
          $1, '{}'::jsonb, 'legacy-query-node', 'admin',
          $2, 'MANUAL', $3::timestamptz,
          $4, $5, $6, $7,
          $8, $9, '旧版预分配迁移验证', $10, $11::timestamptz, $11::timestamptz
        ) RETURNING id
      `, [
        `迁移测试 Query ${index + 1}`,
        worker.username,
        taskCase.assignedLater ? '2026-01-01T00:00:01Z' : createdAt,
        taskCase.state,
        taskCase.stage,
        taskCase.key === 'review' ? '旧版等待审核' : '迁移前提示',
        taskCase.skipCopyReview === true,
        queryPackage.id,
        item.id,
        productionBatch.id,
        createdAt,
      ])).rows[0];
      taskIds.set(taskCase.key, Number(task.id));
      await pool.query(`
        INSERT INTO production_batch_items(
          production_batch_id, source_query_package_item_id, query_snapshot, task_id
        ) VALUES ($1, $2, $3, $4)
      `, [productionBatch.id, item.id, `迁移测试 Query ${index + 1}`, task.id]);
      if (taskCase.addEvent) {
        await pool.query(`
          INSERT INTO task_assignment_events(
            task_id, actor_username, previous_assignee_user_id,
            assignee_user_id, source, reason
          ) VALUES ($1, 'admin', NULL, $2, 'MANUAL', '后续人工分配')
        `, [task.id, worker.username]);
      }
    }

    const migrationClient = await pool.connect();
    try {
      await migrationClient.query('BEGIN');
      await migrationClient.query('SET LOCAL search_path TO public');
      assert.deepEqual(await applyMigrations(migrationClient, migrations), [repair.id]);
      await migrationClient.query('COMMIT');
    } catch (error) {
      await migrationClient.query('ROLLBACK');
      throw error;
    } finally {
      migrationClient.release();
    }

    const assignments = new Map((await pool.query(`
      SELECT id, assigned_to_user_id, assignment_source, assigned_at, progress_message
      FROM tasks WHERE id = ANY($1::bigint[])
    `, [[...taskIds.values()]])).rows.map((row) => [Number(row.id), row]));
    for (const taskCase of taskCases) {
      const row = assignments.get(taskIds.get(taskCase.key));
      if (taskCase.expectedCleared) {
        assert.equal(row.assigned_to_user_id, null, taskCase.key);
        assert.equal(row.assignment_source, null, taskCase.key);
        assert.equal(row.assigned_at, null, taskCase.key);
      } else {
        assert.equal(row.assigned_to_user_id, worker.username, taskCase.key);
        assert.equal(row.assignment_source, 'MANUAL', taskCase.key);
        assert.ok(row.assigned_at instanceof Date, taskCase.key);
      }
    }
    assert.equal(
      assignments.get(taskIds.get('review')).progress_message,
      '文案生成完成，等待分配负责人后审核',
    );
    const repairEvents = (await pool.query(`
      SELECT task_id, previous_assignee_user_id, assignee_user_id
      FROM task_assignment_events
      WHERE actor_username = 'migration-0033-query-preassignment'
      ORDER BY task_id
    `)).rows;
    assert.deepEqual(
      repairEvents.map((row) => Number(row.task_id)),
      ['queued', 'running', 'failed', 'review'].map((key) => taskIds.get(key)).toSorted((a, b) => a - b),
    );
    assert.ok(repairEvents.every((row) => row.previous_assignee_user_id === worker.username
      && row.assignee_user_id === null));
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
    assert.equal(imported.assignedToUserId, null,
      'legacy create input must not assign newly imported Query packages');
    assert.equal(imported.assignedToAccountId, null);
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
    assert.equal(screened.status, 'USED_UP');
    assert.equal(screened.counts.selected, QUERY_PACKAGE_SCALE_ROWS);
    assert.equal(screened.counts.produced, QUERY_PACKAGE_SCALE_ROWS);
    assert.ok(screeningElapsedMs < QUERY_PACKAGE_SCALE_OPERATION_LIMIT_MS,
      `5000-row Query screening and production took ${screeningElapsedMs.toFixed(0)}ms`);
    const producedTaskIds = (await repository.pool.query(`
      SELECT id FROM tasks WHERE source_query_package_id = $1 ORDER BY id
    `, [imported.id])).rows.map((row) => Number(row.id));
    assert.equal(producedTaskIds.length, QUERY_PACKAGE_SCALE_ROWS);
    assert.equal(new Set(producedTaskIds).size, QUERY_PACKAGE_SCALE_ROWS);

    const persisted = (await repository.pool.query(`
      SELECT package.status,
        (SELECT COUNT(*) FROM query_package_items
          WHERE query_package_id = package.id) AS item_count,
        (SELECT COUNT(*) FROM query_package_items
          WHERE query_package_id = package.id AND status = 'TASK_CREATED') AS produced_item_count,
        (SELECT COUNT(*) FROM tasks
          WHERE source_query_package_id = package.id) AS task_count,
        (SELECT COUNT(*) FROM tasks
          WHERE source_query_package_id = package.id
            AND state = 'COPY_QUEUED'
            AND assigned_to_user_id IS NULL
            AND assignment_source IS NULL
            AND assigned_at IS NULL) AS unassigned_copy_task_count,
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
      unassignedCopyTaskCount: Number(persisted.unassigned_copy_task_count),
      batchItemCount: Number(persisted.batch_item_count),
    }, {
      status: 'USED_UP',
      itemCount: QUERY_PACKAGE_SCALE_ROWS,
      producedItemCount: QUERY_PACKAGE_SCALE_ROWS,
      taskCount: QUERY_PACKAGE_SCALE_ROWS,
      unassignedCopyTaskCount: QUERY_PACKAGE_SCALE_ROWS,
      batchItemCount: QUERY_PACKAGE_SCALE_ROWS,
    });
    context.diagnostic(
      `5000-row Query import ${importElapsedMs.toFixed(0)}ms; screening and production ${screeningElapsedMs.toFixed(0)}ms`,
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
    assert.equal(health.data.capabilities.queryPackageVersion, 3);
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
    const deniedWorkerSettings = await requestJson(
      controlPlane.root, '/v1/workflow-quality-settings', {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerSettings.error.code, 'FORBIDDEN');

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
    const deniedWorkerDisposableDetail = await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDisposableDetail.error.code, 'FORBIDDEN');
    const disposableDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}`, { actor: admin },
    )).data;
    const disposableScreeningBody = {
      expectedVersion: disposableDetail.version,
      requestId: randomUUID(),
      decisions: [{
        itemId: disposableDetail.items[0].id,
        decision: 'REJECT',
        reason: '隔离测试：该 Query 不适合生产',
      }],
    };
    const deniedWorkerDisposableScreening = await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/screening`, {
        actor: worker,
        method: 'PUT',
        body: disposableScreeningBody,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDisposableScreening.error.code, 'FORBIDDEN');
    const abandonedDisposable = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/screening`, {
        actor: admin,
        method: 'PUT',
        body: disposableScreeningBody,
      },
    )).data;
    assert.equal(abandonedDisposable.status, 'ABANDONED');
    const deniedWorkerDeletePreview = await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/permanent-delete-preview`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDeletePreview.error.code, 'FORBIDDEN');
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
    const permanentDeletionBody = {
      expectedVersion: deletePreview.version,
      reason: '隔离测试验证废弃词包真删除',
      deletionPassword,
      confirmationName: deletePreview.name,
      requestId: randomUUID(),
    };
    const deniedWorkerPermanentDeletion = await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/permanent`, {
        actor: worker,
        method: 'DELETE',
        body: permanentDeletionBody,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerPermanentDeletion.error.code, 'FORBIDDEN');
    const deletion = (await requestJson(
      controlPlane.root, `/v1/query-packages/${disposablePackage.id}/permanent`, {
        actor: admin,
        method: 'DELETE',
        body: permanentDeletionBody,
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
    assert.equal(createdPackage.assignedToUserId, null,
      'imports start unassigned even when a legacy assignee field is present');
    assert.equal(createdPackage.assignedToAccountId, null);

    const unassignedWorkerPackageList = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: worker },
    )).data;
    assert.deepEqual(unassignedWorkerPackageList, [],
      'workers can open the list but only see packages assigned to their stable account identity');
    const adminPackages = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: admin },
    )).data;
    assert.ok(adminPackages.some((item) => item.id === createdPackage.id));
    assert.ok(normalizePackageList(adminPackages).some((item) => item.id === createdPackage.id));
    const deniedWorkerPackageDetail = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerPackageDetail.error.code, 'FORBIDDEN');

    const assignedToWorker = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/assignee`, {
        actor: admin,
        method: 'PATCH',
        body: {
          expectedVersion: createdPackage.version,
          assignedToUserId: worker.username,
          assignedToAccountId: worker.userId,
        },
      },
    )).data;
    assert.deepEqual({
      assignedToUserId: assignedToWorker.assignedToUserId,
      assignedToAccountId: assignedToWorker.assignedToAccountId,
      assignedToDisplayName: assignedToWorker.assignedToDisplayName,
      assignedToRole: assignedToWorker.assignedToRole,
      assigneeStatus: assignedToWorker.assigneeStatus,
    }, {
      assignedToUserId: worker.username,
      assignedToAccountId: worker.userId,
      assignedToDisplayName: '隔离测试作业员',
      assignedToRole: 'USER',
      assigneeStatus: 'ACTIVE',
    });
    assert.equal(assignedToWorker.version, createdPackage.version + 1);

    const workerPackages = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: worker },
    )).data;
    assert.deepEqual(workerPackages.map((item) => item.id), [createdPackage.id]);
    assert.ok(normalizePackageList(workerPackages).some((item) => item.id === createdPackage.id));
    const workerPackageDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, { actor: worker },
    )).data;
    assert.ok(workerPackageDetail.items.every((item) => item.status === 'READY'));
    const unassignedReviewerPackageList = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: reviewer },
    )).data;
    assert.deepEqual(unassignedReviewerPackageList, []);
    const deniedReviewerPackageDetail = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, {
        actor: reviewer,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedReviewerPackageDetail.error.code, 'FORBIDDEN');

    const unassignedPackage = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/assignee`, {
        actor: admin,
        method: 'PATCH',
        body: {
          expectedVersion: assignedToWorker.version,
          assignedToUserId: null,
          assignedToAccountId: null,
        },
      },
    )).data;
    assert.equal(unassignedPackage.assignedToUserId, null);
    assert.equal(unassignedPackage.assignedToAccountId, null);
    assert.equal(unassignedPackage.version, assignedToWorker.version + 1);
    const workerPackagesAfterUnassign = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: worker },
    )).data;
    assert.deepEqual(workerPackagesAfterUnassign, []);
    const deniedFormerAssigneeDetail = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedFormerAssigneeDetail.error.code, 'FORBIDDEN');

    const assignedToReviewer = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/assignee`, {
        actor: admin,
        method: 'PATCH',
        body: {
          expectedVersion: unassignedPackage.version,
          assignedToUserId: reviewer.username,
          assignedToAccountId: reviewer.userId,
        },
      },
    )).data;
    assert.deepEqual({
      assignedToUserId: assignedToReviewer.assignedToUserId,
      assignedToAccountId: assignedToReviewer.assignedToAccountId,
      assignedToDisplayName: assignedToReviewer.assignedToDisplayName,
      assignedToRole: assignedToReviewer.assignedToRole,
      assigneeStatus: assignedToReviewer.assigneeStatus,
    }, {
      assignedToUserId: reviewer.username,
      assignedToAccountId: reviewer.userId,
      assignedToDisplayName: '隔离测试质检员',
      assignedToRole: 'REVIEWER',
      assigneeStatus: 'ACTIVE',
    });
    const workerPackagesAfterReassignment = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: worker },
    )).data;
    assert.deepEqual(workerPackagesAfterReassignment, []);
    const deniedPriorAssigneeDetail = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedPriorAssigneeDetail.error.code, 'FORBIDDEN');

    const reviewerPackages = (await requestJson(
      controlPlane.root, '/v1/query-packages', { actor: reviewer },
    )).data;
    assert.deepEqual(reviewerPackages.map((item) => item.id), [createdPackage.id]);
    const packageDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, { actor: reviewer },
    )).data;
    assert.ok(packageDetail.items.every((item) => item.status === 'READY'));
    const normalizedPackageDetail = normalizePackageDetail(packageDetail);
    assert.equal(normalizedPackageDetail.items.length, 2);
    assert.ok(normalizedPackageDetail.items.every((item) => item.validationStatus === 'READY'));
    const screeningBody = {
      expectedVersion: packageDetail.version,
      requestId: randomUUID(),
      decisions: packageDetail.items.map((item) => ({ itemId: item.id, decision: 'SELECT' })),
    };
    const deniedWorkerScreening = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/screening`, {
        actor: worker,
        method: 'PUT',
        body: screeningBody,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerScreening.error.code, 'FORBIDDEN');
    const screenedPackage = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/screening`, {
        actor: reviewer,
        method: 'PUT',
        body: screeningBody,
      },
    )).data;
    assert.equal(screenedPackage.status, 'USED_UP');
    assert.equal(screenedPackage.counts.selected, 2);
    assert.equal(screenedPackage.counts.produced, 2);

    const productionBody = {
      expectedVersion: screenedPackage.version,
      requestId: randomUUID(),
      itemIds: packageDetail.items.map((item) => item.id),
      nodeId: 'pg18-e2e-node',
    };
    const deniedWorkerProduction = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/production-batches`, {
        actor: worker,
        method: 'POST',
        body: productionBody,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerProduction.error.code, 'FORBIDDEN');
    const deniedAssignedReviewerProduction = await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}/production-batches`, {
        actor: reviewer,
        method: 'POST',
        body: productionBody,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedAssignedReviewerProduction.error.code, 'FORBIDDEN');
    const producedPackageDetail = (await requestJson(
      controlPlane.root, `/v1/query-packages/${createdPackage.id}`, { actor: admin },
    )).data;
    assert.equal(producedPackageDetail.productionBatches.length, 1);
    const productionBatch = {
      ...producedPackageDetail.productionBatches[0],
      taskIds: (await repository.pool.query(`
        SELECT task_id FROM production_batch_items
        WHERE production_batch_id = $1 ORDER BY id
      `, [producedPackageDetail.productionBatches[0].id])).rows.map((row) => Number(row.task_id)),
    };
    assert.equal(productionBatch.taskIds.length, 2);

    const deniedWorkerReadiness = await requestJson(
      controlPlane.root, `/v1/production-batches/${productionBatch.id}/copy-sampling-readiness`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerReadiness.error.code, 'FORBIDDEN');
    const reviewerReadiness = (await requestJson(
      controlPlane.root, `/v1/production-batches/${productionBatch.id}/copy-sampling-readiness`, {
        actor: reviewer,
      },
    )).data;
    assert.deepEqual({
      totalCount: reviewerReadiness.totalCount,
      approvedCount: reviewerReadiness.approvedCount,
      cancelledCount: reviewerReadiness.cancelledCount,
      blockerCount: reviewerReadiness.blockerCount,
      ready: reviewerReadiness.ready,
    }, {
      totalCount: 2,
      approvedCount: 0,
      cancelledCount: 0,
      blockerCount: 2,
      ready: false,
    });
    assert.equal(Object.hasOwn(reviewerReadiness, 'blockerTaskIds'), false);
    const adminReadiness = (await requestJson(
      controlPlane.root, `/v1/production-batches/${productionBatch.id}/copy-sampling-readiness`, {
        actor: admin,
      },
    )).data;
    assert.deepEqual(adminReadiness.blockerTaskIds, productionBatch.taskIds);

    const queuedTasks = (await repository.pool.query(`
      SELECT id, state, current_stage, created_by_user_id,
        assigned_to_user_id, assignment_source, assigned_at
      FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [productionBatch.taskIds])).rows;
    assert.equal(queuedTasks.length, productionBatch.taskIds.length);
    assert.ok(queuedTasks.every((task) => task.state === 'COPY_QUEUED'
      && task.current_stage === 'COPY_QUEUED'
      && task.created_by_user_id === admin.username
      && task.assigned_to_user_id === null
      && task.assignment_source === null
      && task.assigned_at === null));
    const workerTaskListBeforeAssignment = (await requestJson(
      controlPlane.root, '/v1/tasks?limit=100', { actor: worker },
    )).data;
    assert.ok(productionBatch.taskIds.every(
      (taskId) => !workerTaskListBeforeAssignment.some((task) => task.id === taskId),
    ));

    const searchedTaskIds = [];
    for (let index = 0; index < productionBatch.taskIds.length; index += 1) {
      const searchClaim = await repository.claimXhsQuerySearch({
        nodeId: 'pg18-e2e-xhs-search',
        nodeName: 'PostgreSQL 18 E2E Xiaohongshu search',
        protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
      });
      assert.ok(searchClaim);
      assert.equal(searchClaim.resultLimit, XIAOHONGSHU_SEARCH_DEFAULT_LIMIT);
      assert.ok(productionBatch.taskIds.includes(searchClaim.taskId));
      searchedTaskIds.push(searchClaim.taskId);
      const noteId = `${index + 1}`.padStart(24, '0');
      const completedSearch = await repository.completeXhsQuerySearch(searchClaim.id, {
        leaseToken: searchClaim.leaseToken,
        links: [{
          noteId,
          url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=e2e_${index}%3D&xsec_source=pc_search`,
          title: `E2E 搜索结果 ${index + 1}`,
          rank: 1,
        }],
      });
      assert.equal(completedSearch.status, 'SUCCEEDED');
      assert.equal(completedSearch.resultCount, 1);
    }
    assert.deepEqual(
      searchedTaskIds.toSorted((left, right) => left - right),
      productionBatch.taskIds,
    );
    assert.equal(await repository.claimXhsQuerySearch({
      nodeId: 'pg18-e2e-xhs-search',
      nodeName: 'PostgreSQL 18 E2E Xiaohongshu search',
      protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
    }), null);

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
      assert.equal(completed.task.assignedToUserId, null);
    }

    const assignedCopies = await repository.assignTasks(productionBatch.taskIds, {
      assignedToUserId: worker.username,
      assignedToAccountId: worker.userId,
      actor: admin,
      reason: 'PostgreSQL 18 E2E 文案生成后派单',
    });
    assert.ok(assignedCopies.every((task) => task.assignedToUserId === worker.username));
    const workerTaskList = (await requestJson(
      controlPlane.root, '/v1/tasks?limit=100', { actor: worker },
    )).data;
    const producedWorkerTasks = workerTaskList.filter(
      (task) => productionBatch.taskIds.includes(task.id),
    );
    assert.deepEqual(
      producedWorkerTasks.map((task) => task.id).toSorted((left, right) => left - right),
      productionBatch.taskIds,
    );
    producedWorkerTasks.forEach((task) => assertUserTaskHidesSensitiveFields(task, 'USER task list'));
    const workerTaskDetail = (await requestJson(
      controlPlane.root, `/v1/tasks/${productionBatch.taskIds[0]}`, { actor: worker },
    )).data;
    assert.equal(workerTaskDetail.id, productionBatch.taskIds[0]);
    assertUserTaskHidesSensitiveFields(workerTaskDetail, 'USER task detail', {
      includeXhsSearch: true,
    });
    assert.equal(workerTaskDetail.xiaohongshuSearchStatus, 'SUCCEEDED');
    assert.equal(workerTaskDetail.xiaohongshuSearchBlockedReason, null);
    assert.equal(workerTaskDetail.xiaohongshuLinks.length, 1);

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
    assertUserTaskHidesSensitiveFields(firstApproved, 'USER approve-copy response');
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
    assertUserTaskHidesSensitiveFields(secondApproved, 'USER approve-copy response');

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
    assertUserTaskHidesSensitiveFields(resubmitted, 'USER approve-copy response');

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
    const deniedWorkerPrematureArchive = await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/archive`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerPrematureArchive.error.code, 'FORBIDDEN');
    const prematureArchive = await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/archive`, {
        actor: admin,
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
    assertUserTaskHidesSensitiveFields(finalReworkApproval, 'USER approve-copy response');

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
    const deniedWorkerDeliveryPool = await requestJson(
      controlPlane.root, '/v1/delivery-pool', {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDeliveryPool.error.code, 'FORBIDDEN');
    const adminDeliveryPage = (await requestJson(
      controlPlane.root, '/v1/delivery-pool?limit=200&offset=0&includeTotal=true', { actor: admin },
    )).data;
    assert.equal(adminDeliveryPage.total, 1);
    assert.equal(adminDeliveryPage.items[0].taskId, imageClaim.task.id);
    const deniedWorkerDeliveryPreparation = await requestJson(
      controlPlane.root, '/v1/delivery-pool/archive', {
        actor: worker,
        method: 'POST',
        body: { scope: 'ALL_READY' },
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDeliveryPreparation.error.code, 'FORBIDDEN');
    const preparedDelivery = (await requestJson(
      controlPlane.root, '/v1/delivery-pool/archive', {
        actor: admin,
        method: 'POST',
        body: { scope: 'ALL_READY' },
        expectedStatus: 201,
      },
    )).data;
    assert.equal(preparedDelivery.taskCount, 1);
    const deniedWorkerDeliveryDownload = await requestJson(
      controlPlane.root, `/v1/delivery-pool/archive/${preparedDelivery.downloadId}`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerDeliveryDownload.error.code, 'FORBIDDEN');
    const allDeliveryResponse = await fetch(
      `${controlPlane.root}/v1/delivery-pool/archive/${preparedDelivery.downloadId}`,
      { headers: actorHeaders(admin) },
    );
    assert.equal(allDeliveryResponse.status, 200);
    const allDeliveryArchive = await JSZip.loadAsync(await allDeliveryResponse.arrayBuffer());
    const deliveredTaskArchive = allDeliveryArchive.file(
      `PostgreSQL 18 隔离端到端词包/任务-${imageClaim.task.id}-资源包.zip`,
    );
    assert.ok(deliveredTaskArchive);
    const deliveredTaskFiles = await JSZip.loadAsync(await deliveredTaskArchive.async('nodebuffer'));
    assert.match(
      await deliveredTaskFiles.file('小红书链接.txt').async('string'),
      /https:\/\/www\.xiaohongshu\.com\/explore\//u,
    );
    const deniedWorkerTaskArchive = await requestJson(
      controlPlane.root, `/v1/tasks/${imageClaim.task.id}/archive`, {
        actor: worker,
        expectedStatus: 403,
      },
    );
    assert.equal(deniedWorkerTaskArchive.error.code, 'FORBIDDEN');
    const archiveResponse = await fetch(
      `${controlPlane.root}/v1/tasks/${imageClaim.task.id}/archive`,
      { headers: actorHeaders(admin) },
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

test('real PostgreSQL 18 discards only previewed pristine duplicate Query tasks and restores paired search safely', {
  skip: !RUN_POSTGRES_E2E,
  timeout: 120_000,
}, async () => {
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  try {
    await repository.initialize();
    const admin = actorFrom(await repository.getUserByUsername('admin'));
    const [plainTask, runningSearchTask, successfulSearchTask, differentContextTask] = await repository.createTasks({
      nodeId: 'duplicate-query-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [
        { query: 'Camping Guide', input: { audience: 'newcomer' } },
        { query: '  camping   guide  ', input: { audience: 'newcomer' } },
        { query: 'CAMPING GUIDE', input: { audience: 'newcomer' } },
        { query: 'camping guide', input: { audience: 'expert' } },
      ],
    });

    const runningJobId = Number((await repository.pool.query(`
      INSERT INTO xhs_query_search_jobs(task_id, query_snapshot)
      VALUES ($1, $2)
      RETURNING id
    `, [runningSearchTask.id, runningSearchTask.query])).rows[0].id);
    const successfulJobId = Number((await repository.pool.query(`
      INSERT INTO xhs_query_search_jobs(
        task_id, query_snapshot, status, result_count, searched_at
      ) VALUES ($1, $2, 'SUCCEEDED', 1, now())
      RETURNING id
    `, [successfulSearchTask.id, successfulSearchTask.query])).rows[0].id);
    await repository.pool.query(`
      INSERT INTO xhs_query_links(search_job_id, note_id, url, title, rank)
      VALUES ($1, 'duplicate-e2e-note',
        'https://www.xiaohongshu.com/explore/duplicate-e2e-note',
        '隔离测试搜索成果', 1)
    `, [successfulJobId]);
    const claimedSearch = await repository.claimXhsQuerySearch({
      nodeId: 'duplicate-query-xhs-e2e-node',
      nodeName: 'Duplicate Query XHS E2E Node',
      protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
    });
    assert.equal(claimedSearch.id, runningJobId);
    assert.equal(claimedSearch.taskId, runningSearchTask.id);

    const preview = await repository.previewDuplicateQueryDiscard({
      representativeTaskIds: [runningSearchTask.id],
    }, { actor: admin });
    assert.equal(preview.version, 1);
    assert.equal(preview.groups.length, 1);
    assert.equal(preview.groups[0].keeper.id, successfulSearchTask.id,
      'a completed search is retained as existing work');
    assert.deepEqual(
      preview.groups[0].discardable.map(({ id }) => id),
      [plainTask.id, runningSearchTask.id],
    );
    assert.deepEqual(
      preview.groups[0].skipped.map(({ id, reasonCode }) => [id, reasonCode]),
      [[differentContextTask.id, 'DIFFERENT_BUSINESS_CONTEXT']],
    );

    const requestId = randomUUID();
    const request = {
      requestId,
      representativeTaskIds: preview.representativeTaskIds,
      previewFingerprint: preview.previewFingerprint,
      confirmedDiscardCount: preview.summary.discardableCount,
    };
    const [firstResult, concurrentRetry] = await Promise.all([
      repository.discardDuplicateQueries(request, { actor: admin }),
      repository.discardDuplicateQueries(request, { actor: admin }),
    ]);
    const expectedResult = {
      requestId,
      discardedTaskIds: [plainTask.id, runningSearchTask.id],
      keeperTaskIds: [successfulSearchTask.id],
      discardedCount: 2,
      skippedCount: 1,
    };
    assert.deepEqual(firstResult, expectedResult);
    assert.deepEqual(concurrentRetry, expectedResult, 'the same concurrent request replays one receipt');

    const taskStates = (await repository.pool.query(`
      SELECT id, state, cancelled_from_state
      FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [[plainTask.id, runningSearchTask.id, successfulSearchTask.id, differentContextTask.id]])).rows;
    assert.deepEqual(taskStates.map((row) => [Number(row.id), row.state, row.cancelled_from_state]), [
      [plainTask.id, 'CANCELLED', 'COPY_QUEUED'],
      [runningSearchTask.id, 'CANCELLED', 'COPY_QUEUED'],
      [successfulSearchTask.id, 'COPY_QUEUED', null],
      [differentContextTask.id, 'COPY_QUEUED', null],
    ]);
    const searchStates = (await repository.pool.query(`
      SELECT id, status, lease_token, claimed_by_node_id
      FROM xhs_query_search_jobs WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [[runningJobId, successfulJobId]])).rows;
    assert.deepEqual(searchStates.map((row) => [
      Number(row.id), row.status, row.lease_token, row.claimed_by_node_id,
    ]), [
      [runningJobId, 'CANCELLED', null, null],
      [successfulJobId, 'SUCCEEDED', null, null],
    ]);
    assert.equal(Number((await repository.pool.query(`
      SELECT COUNT(*) AS count FROM task_duplicate_query_discard_requests
      WHERE actor_account_id = $1 AND request_id = $2
    `, [admin.userId, requestId])).rows[0].count), 1);
    const audits = (await repository.pool.query(`
      SELECT discarded_task_id, keeper_task_id
      FROM task_duplicate_query_discard_audits
      WHERE actor_account_id = $1 AND request_id = $2
      ORDER BY discarded_task_id
    `, [admin.userId, requestId])).rows;
    assert.deepEqual(audits.map((row) => [Number(row.discarded_task_id), Number(row.keeper_task_id)]), [
      [plainTask.id, successfulSearchTask.id],
      [runningSearchTask.id, successfulSearchTask.id],
    ]);

    await repository.requeueCancelledTask(runningSearchTask.id, { actor: admin });
    const restoredSearch = (await repository.pool.query(`
      SELECT status, attempt_count, lease_token, claimed_by_node_id, error
      FROM xhs_query_search_jobs WHERE id = $1
    `, [runningJobId])).rows[0];
    assert.deepEqual(restoredSearch, {
      status: 'PENDING', attempt_count: 0, lease_token: null, claimed_by_node_id: null, error: null,
    });
    await assert.rejects(
      repository.completeXhsQuerySearch(runningJobId, {
        leaseToken: claimedSearch.leaseToken,
        links: [],
      }),
      { code: 'STALE_XHS_SEARCH_LEASE' },
      'the lease cancelled by duplicate cleanup cannot write after recovery',
    );

    const historicalTasks = await repository.createTasks({
      nodeId: 'duplicate-query-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [
        { query: 'historical owner identity', input: {} },
        { query: 'HISTORICAL   OWNER IDENTITY', input: {} },
      ],
    });
    await repository.pool.query(`
      UPDATE tasks SET created_by_user_id = 'reused-deleted-owner', updated_at = clock_timestamp()
      WHERE id = ANY($1::bigint[])
    `, [historicalTasks.map(({ id }) => id)]);
    const unverifiableOwnerPreview = await repository.previewDuplicateQueryDiscard({
      representativeTaskIds: [historicalTasks[1].id],
    }, { actor: admin });
    assert.equal(unverifiableOwnerPreview.summary.discardableCount, 0,
      'tasks without a provable stable creator identity fail closed');

    const unsafeNumberTasks = await repository.createTasks({
      nodeId: 'duplicate-query-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [
        { query: 'unsafe json number identity', input: {} },
        { query: 'UNSAFE   JSON NUMBER IDENTITY', input: {} },
      ],
    });
    await repository.pool.query(`
      UPDATE tasks SET input = CASE id
        WHEN $1::bigint THEN '{"sequence": 9007199254740992}'::jsonb
        WHEN $2::bigint THEN '{"sequence": 9007199254740993}'::jsonb
      END,
      updated_at = clock_timestamp()
      WHERE id = ANY($3::bigint[])
    `, [unsafeNumberTasks[0].id, unsafeNumberTasks[1].id, unsafeNumberTasks.map(({ id }) => id)]);
    const unsafeNumberPreview = await repository.previewDuplicateQueryDiscard({
      representativeTaskIds: [unsafeNumberTasks[1].id],
    }, { actor: admin });
    assert.equal(unsafeNumberPreview.summary.discardableCount, 0,
      'distinct jsonb integers above JavaScript safe precision remain different contexts');

    const batchTasks = await repository.createTasks({
      nodeId: 'duplicate-query-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [
        { query: 'batch recovery boundary', input: {} },
        { query: 'BATCH   RECOVERY BOUNDARY', input: {} },
      ],
    });
    const productionBatchId = Number((await repository.pool.query(`
      INSERT INTO production_batches(
        public_id, query_package_name, created_by_account_id, created_by_username,
        request_id, request_fingerprint
      ) VALUES ($1, '隔离去重恢复边界', $2, $3, $4, $5)
      RETURNING id
    `, [randomUUID(), admin.userId, admin.username, randomUUID(), 'b'.repeat(64)])).rows[0].id);
    await repository.pool.query(`
      UPDATE tasks SET production_batch_id = $1, updated_at = clock_timestamp()
      WHERE id = ANY($2::bigint[])
    `, [productionBatchId, batchTasks.map(({ id }) => id)]);
    const batchPreview = await repository.previewDuplicateQueryDiscard({
      representativeTaskIds: [batchTasks[1].id],
    }, { actor: admin });
    assert.equal(batchPreview.summary.discardableCount, 0,
      'production-batch decisions are outside recoverable duplicate cleanup');
    const batchNoop = await repository.discardDuplicateQueries({
      requestId: randomUUID(),
      representativeTaskIds: batchPreview.representativeTaskIds,
      previewFingerprint: batchPreview.previewFingerprint,
      confirmedDiscardCount: 0,
    }, { actor: admin });
    assert.equal(batchNoop.discardedCount, 0);
    const unchangedBatch = (await repository.pool.query(`
      SELECT status, sampling_status FROM production_batches WHERE id = $1
    `, [productionBatchId])).rows[0];
    assert.deepEqual(unchangedBatch, { status: 'OPEN', sampling_status: 'OPEN' });
    const unchangedBatchTasks = (await repository.pool.query(`
      SELECT state FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [batchTasks.map(({ id }) => id)])).rows;
    assert.deepEqual(unchangedBatchTasks.map(({ state }) => state), ['COPY_QUEUED', 'COPY_QUEUED']);

    const staleTasks = await repository.createTasks({
      nodeId: 'duplicate-query-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [
        { query: 'stale preview guard', input: {} },
        { query: 'STALE   PREVIEW GUARD', input: {} },
      ],
    });
    const stalePreview = await repository.previewDuplicateQueryDiscard({
      representativeTaskIds: [staleTasks[1].id],
    }, { actor: admin });
    assert.equal(stalePreview.summary.discardableCount, 1);
    await repository.pool.query(`
      UPDATE tasks SET ai_disclosure_enabled = false,
        updated_at = clock_timestamp() + interval '1 second'
      WHERE id = $1
    `, [staleTasks[1].id]);
    const staleRequestId = randomUUID();
    await assert.rejects(repository.discardDuplicateQueries({
      requestId: staleRequestId,
      representativeTaskIds: stalePreview.representativeTaskIds,
      previewFingerprint: stalePreview.previewFingerprint,
      confirmedDiscardCount: stalePreview.summary.discardableCount,
    }, { actor: admin }), { code: 'DUPLICATE_QUERY_PREVIEW_STALE' });
    const unchangedStaleTasks = (await repository.pool.query(`
      SELECT state FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
    `, [staleTasks.map(({ id }) => id)])).rows;
    assert.deepEqual(unchangedStaleTasks.map(({ state }) => state), ['COPY_QUEUED', 'COPY_QUEUED']);
    assert.equal(Number((await repository.pool.query(`
      SELECT COUNT(*) AS count FROM task_duplicate_query_discard_requests
      WHERE actor_account_id = $1 AND request_id = $2
    `, [admin.userId, staleRequestId])).rows[0].count), 0);
  } finally {
    await repository.close().catch(() => {});
    await cluster.stop();
  }
});

test('real PostgreSQL 18 records retryable Xiaohongshu search failures without parameter type ambiguity', {
  skip: !RUN_POSTGRES_E2E,
  timeout: 120_000,
}, async () => {
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  try {
    await repository.initialize();
    const admin = actorFrom(await repository.getUserByUsername('admin'));
    const [task] = await repository.createTasks({
      nodeId: 'xhs-failure-e2e-node',
      createdByUserId: admin.username,
      actor: admin,
      tasks: [{ query: 'PostgreSQL parameter inference regression', input: {} }],
    });
    const jobId = Number((await repository.pool.query(`
      INSERT INTO xhs_query_search_jobs(task_id, query_snapshot)
      VALUES ($1, $2)
      RETURNING id
    `, [task.id, task.query])).rows[0].id);
    await repository.upsertSetting(XIAOHONGSHU_SEARCH_SETTINGS_KEY, { resultLimit: 10 });
    const claim = await repository.claimXhsQuerySearch({
      nodeId: 'xhs-failure-e2e-node',
      nodeName: 'Xiaohongshu failure PostgreSQL E2E node',
      protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
    });
    assert.equal(claim.id, jobId);
    assert.equal(claim.resultLimit, 10);

    const failed = await repository.failXhsQuerySearch(jobId, {
      leaseToken: claim.leaseToken,
      retryable: true,
      error: 'isolated PostgreSQL failure-path test',
    });
    assert.equal(failed.status, 'PENDING');
    assert.equal(failed.leaseToken, null);
    const persisted = (await repository.pool.query(`
      SELECT status, error, retry_after, lease_token, claimed_by_node_id, result_limit
      FROM xhs_query_search_jobs WHERE id = $1
    `, [jobId])).rows[0];
    assert.equal(persisted.status, 'PENDING');
    assert.equal(persisted.error, 'isolated PostgreSQL failure-path test');
    assert.ok(persisted.retry_after instanceof Date);
    assert.equal(persisted.lease_token, null);
    assert.equal(persisted.claimed_by_node_id, null);
    assert.equal(persisted.result_limit, 10);
  } finally {
    await repository.close().catch(() => {});
    await cluster.stop();
  }
});
