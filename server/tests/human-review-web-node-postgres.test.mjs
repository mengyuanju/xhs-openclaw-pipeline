import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const workerNode = 'human-review-existing-executor';
const content = {
  copy: {
    title: '整理桌面的实用方法',
    body: '先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20),
    tags: ['#桌面整理', '#收纳方法', '#效率提升'],
  },
  imagePlan: ['hero', 'steps', 'summary'].map((kind, index) => ({
    kind, headline: `桌面整理步骤${index + 1}`, subtitle: '按照使用频率整理',
    bullets: ['清理不用的物品', '为常用物品固定位置'],
    prompt: '明亮自然光下展示分类清晰、物品固定位置的整洁桌面。',
    layout: { mode: 'AUTO' },
  })),
};

function actorHeaders(actor) {
  return actor ? {
    'X-Actor-User-Id': String(actor.userId), 'X-Actor-Username': actor.username,
    'X-Actor-Role': actor.role, 'X-Actor-Credential-Version': String(actor.credentialVersion),
  } : {};
}

test('PostgreSQL: authenticated human review can use an unregistered web source without executor capabilities', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120_000,
}, async t => {
  // Synthetic content, a disposable PostgreSQL 18 cluster and loopback HTTP only.
  // Never use the application's database URL or invoke a model.
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  const pool = repository.pool;
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-human-review-web-node-'));
  let app;
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (app) await app.context.disposeControlPlaneResources();
    await repository.close();
    await cluster.stop();
    assert.ok(storageRoot.startsWith(join(tmpdir(), 'xhs-human-review-web-node-')));
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await repository.initialize();
  // Use an explicit production QA policy so successful approvals have a
  // deterministic route instead of inheriting the disabled fresh-DB default.
  await pool.query(`UPDATE workflow_quality_settings
    SET copy_sampling_enabled = true, copy_sampling_rate_bps = 10000`);
  await pool.query(`INSERT INTO codex_concurrency_pools(id, total_concurrency, image_concurrency)
    VALUES ($1, 2, 1)`, [workerNode]);
  await pool.query(`INSERT INTO executor_nodes(id, name, image_worker_enabled, codex_pool_id)
    VALUES ($1, 'Real registered test executor', true, $1)`, [workerNode]);
  const actors = {};
  for (const [name, role, enabled] of [
    ['owner', 'USER', true], ['other', 'USER', true], ['revoked', 'USER', false], ['admin', 'ADMIN', true],
  ]) {
    const username = `human-web-${name}`;
    const row = (await pool.query(`INSERT INTO app_users(username, display_name, role, password_hash,
      copy_review_enabled, must_change_password) VALUES ($1, $1, $2, 'test-only-synthetic', $3, false)
      RETURNING *`, [username, role, enabled])).rows[0];
    actors[name] = { userId: Number(row.id), username, role,
      credentialVersion: Number(row.credential_version) };
  }
  app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth: true,
    logger: { info() {}, error() {} }, reportProjectionEnabled: false,
    disposableCleanupEnabled: false, storageOptimizationEnabled: false });
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const root = `http://127.0.0.1:${server.address().port}`;

  async function fixture(actor = actors.owner) {
    const taskId = Number((await pool.query(`INSERT INTO tasks(query, created_by_node_id, state,
      assigned_to_user_id, assignment_source, assigned_at)
      VALUES ('Synthetic human review web source', $1, 'COPY_REVIEW_PENDING', $2, 'MANUAL', now())
      RETURNING id`, [workerNode, actor.username])).rows[0].id);
    const executionId = randomUUID();
    await pool.query(`INSERT INTO task_executions(id, task_id, kind, node_id, status, stage, snapshot)
      VALUES ($1, $2, 'COPY', $3, 'SUCCEEDED', 'COPY_COMPLETED', '{}')`, [executionId, taskId, workerNode]);
    const revisionId = Number((await pool.query(`INSERT INTO copy_revisions(task_id, execution_id,
      revision, content) VALUES ($1, $2, 1, $3) RETURNING id`, [taskId, executionId, content])).rows[0].id);
    await pool.query('UPDATE tasks SET current_copy_revision_id = $2 WHERE id = $1', [taskId, revisionId]);
    return { taskId, revisionId };
  }

  async function review(entry, input, actor = actors.owner) {
    const response = await fetch(`${root}/v1/tasks/${entry.taskId}/approve-copy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...actorHeaders(actor) },
      body: JSON.stringify({ revisionId: entry.revisionId, reviewSessionId: randomUUID(), ...input }),
    });
    return { status: response.status, body: await response.json() };
  }

  async function success(entry, input, actor = actors.owner) {
    const result = await review(entry, input, actor);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.data;
  }

  async function assertWebSource(nodeId) {
    const row = (await pool.query('SELECT * FROM executor_nodes WHERE id = $1', [nodeId])).rows[0];
    assert.ok(row, 'a successful web review has an auditable source row');
    assert.equal(row.image_worker_enabled, false);
    assert.equal(row.codex_pool_id, null, 'web source cannot claim executor work');
    assert.equal(new Date(row.last_seen_at).getTime(), 0, 'web source is never marked online');
    assert.equal(Number((await pool.query('SELECT count(*) FROM codex_concurrency_pools WHERE id = $1', [nodeId])).rows[0].count), 0);
  }

  async function assertNoNode(nodeId) {
    assert.equal(Number((await pool.query('SELECT count(*) FROM executor_nodes WHERE id = $1', [nodeId])).rows[0].count), 0);
  }

  await t.test('SAVE persists the rating from an unregistered web source', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-save';
    const saved = await success(entry, { nodeId, decision: 'SAVE', score: 3 });
    assert.equal(saved.state, 'COPY_REVIEW_PENDING');
    assert.equal(saved.currentCopyRevisionId, entry.revisionId);
    const assessment = (await pool.query('SELECT * FROM human_quality_assessments WHERE task_id = $1', [entry.taskId])).rows[0];
    assert.equal(assessment.reviewer_username, actors.owner.username);
    assert.equal(assessment.score_x10, 30);
    assert.equal(assessment.action, 'SAVE');
    await assertWebSource(nodeId);
  });

  await t.test('APPROVE submits through a new manual revision with FK and actor audit', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-approve';
    const approved = await success(entry, { nodeId, decision: 'APPROVE', score: 3 });
    assert.equal(approved.state, 'COPY_QC_PENDING');
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [approved.currentCopyRevisionId])).rows[0];
    assert.equal(revision.execution_id, null, 'manual review never claims model provenance');
    assert.equal(revision.approved_by_node_id, nodeId);
    assert.ok(revision.approved_at);
    const approval = (await pool.query('SELECT * FROM copy_approval_events WHERE task_id = $1', [entry.taskId])).rows[0];
    assert.equal(approval.approved_by_username, actors.owner.username);
    assert.equal(Number(approval.approved_by_account_id), actors.owner.userId);
    await assertWebSource(nodeId);
  });

  await t.test('editing, saving and submitting preserves machine ancestry and human versions', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-edited';
    const edits = structuredClone(content);
    edits.copy.title = '按频率整理桌面的实用方法';
    const saved = await success(entry, { nodeId, decision: 'SAVE', edits,
      originalScore: 2.5, originalNote: '原始标题需要补充整理依据', score: 3 });
    assert.equal(saved.state, 'COPY_REVIEW_PENDING');
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [saved.currentCopyRevisionId])).rows[0];
    assert.equal(revision.revision_origin, 'COPY_EDIT');
    assert.equal(Number(revision.parent_revision_id), entry.revisionId);
    assert.equal(revision.execution_id, null);
    assert.equal(revision.content.copy.title, edits.copy.title);
    const approved = await success({ ...entry, revisionId: saved.currentCopyRevisionId },
      { nodeId, decision: 'APPROVE', score: 3 });
    assert.equal(approved.state, 'COPY_QC_PENDING');
    const current = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [approved.currentCopyRevisionId])).rows[0];
    assert.equal(current.approved_by_node_id, nodeId);
    const assessments = (await pool.query('SELECT * FROM human_quality_assessments WHERE task_id = $1 ORDER BY id', [entry.taskId])).rows;
    assert.equal(assessments[0].score_x10, 25);
    assert.equal(assessments.at(-1).score_x10, 30);
    assert.equal(assessments.at(-1).action, 'APPROVE');
    assert.ok(assessments.every(row => row.reviewer_username === actors.owner.username));
    await assertWebSource(nodeId);
  });

  await t.test('SAVE_PLAN works before scoring and its first approval stays ORIGINAL', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-plan';
    const edits = structuredClone(content);
    edits.imagePlan[0].headline = '调整后的桌面整理封面';
    const saved = await success(entry, { nodeId, decision: 'SAVE_PLAN', edits });
    assert.equal(saved.state, 'COPY_REVIEW_PENDING');
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [saved.currentCopyRevisionId])).rows[0];
    assert.equal(revision.revision_origin, 'PLAN_EDIT');
    assert.equal(revision.copy_content_changed_from_machine, false);
    assert.deepEqual(revision.content.copy, content.copy);
    assert.equal(Number((await pool.query('SELECT count(*) FROM human_quality_assessments WHERE task_id = $1', [entry.taskId])).rows[0].count), 0);
    await success({ ...entry, revisionId: saved.currentCopyRevisionId }, { nodeId, decision: 'APPROVE', score: 3 });
    const assessment = (await pool.query('SELECT * FROM human_quality_assessments WHERE task_id = $1 ORDER BY id DESC', [entry.taskId])).rows[0];
    assert.equal(assessment.rating_context, 'ORIGINAL');
    await assertWebSource(nodeId);
  });

  await t.test('ADMIN approval updates the existing revision with an unregistered source FK', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-admin';
    const approved = await success(entry, { nodeId, decision: 'APPROVE', score: 3 }, actors.admin);
    assert.equal(approved.currentCopyRevisionId, entry.revisionId);
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [entry.revisionId])).rows[0];
    assert.equal(revision.approved_by_node_id, nodeId);
    await assertWebSource(nodeId);
  });

  await t.test('DISCARD also works without an executor registration', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-discard';
    const discarded = await success(entry, { nodeId, decision: 'DISCARD', score: 1, note: '文案内容不达标，直接废弃' });
    assert.equal(discarded.state, 'CANCELLED');
    await assertWebSource(nodeId);
  });

  await t.test('registered executors keep their name, capabilities, pool and heartbeat unchanged', async () => {
    const entry = await fixture();
    const before = (await pool.query('SELECT * FROM executor_nodes WHERE id = $1', [workerNode])).rows[0];
    await success(entry, { nodeId: workerNode, decision: 'SAVE', score: 3 });
    const after = (await pool.query('SELECT * FROM executor_nodes WHERE id = $1', [workerNode])).rows[0];
    assert.deepEqual(after, before);
  });

  for (const [name, actor, status, fixtureActor] of [
    ['another-owner', actors.other, 403, actors.owner],
    ['revoked-review', actors.revoked, 403, actors.revoked],
    ['stale-session', { ...actors.owner, credentialVersion: actors.owner.credentialVersion + 1 }, 401, actors.owner],
    ['unauthenticated', null, 401, actors.owner],
  ]) {
    await t.test(`${name} is rejected before registering a web source or changing data`, async () => {
      const entry = await fixture(fixtureActor);
      const nodeId = `unregistered-web-${name}`;
      const result = await review(entry, { nodeId, decision: 'SAVE', score: 3 }, actor);
      assert.equal(result.status, status, JSON.stringify(result.body));
      await assertNoNode(nodeId);
      assert.equal(Number((await pool.query('SELECT count(*) FROM human_quality_assessments WHERE task_id = $1', [entry.taskId])).rows[0].count), 0);
    });
  }

  await t.test('stale revision and invalid scores do not leave source rows after rejection', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-stale';
    const result = await review(entry, { nodeId, revisionId: entry.revisionId + 10000, decision: 'SAVE', score: 3 });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'STALE_COPY_REVISION');
    await assertNoNode(nodeId);
    const lowScoreNode = 'unregistered-web-low-score';
    const lowScore = await review(entry, { nodeId: lowScoreNode, decision: 'APPROVE', score: 2.5, note: '标题需调整' });
    assert.equal(lowScore.status, 409);
    assert.equal(lowScore.body.error.code, 'QUALITY_SCORE_TOO_LOW');
    await assertNoNode(lowScoreNode);
  });

  await t.test('actor-less compatibility calls still require a registered executor node', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-legacy';
    await assert.rejects(repository.approveCopy(entry.taskId, {
      revisionId: entry.revisionId, nodeId, decision: 'SAVE', score: 3, reviewSessionId: randomUUID(),
    }, { actorRole: 'USER', reviewerUserId: actors.owner.username }), { code: 'NOT_FOUND' });
    await assertNoNode(nodeId);
  });

  await t.test('a later validation failure rolls back the newly registered review source', async () => {
    const entry = await fixture();
    const nodeId = 'unregistered-web-rollback';
    const edits = structuredClone(content);
    edits.copy.title = '补充整理依据后的标题';
    const rejected = await review(entry, { nodeId, decision: 'SAVE', edits, score: 3 });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error.message, /originalScore is required/u);
    await assertNoNode(nodeId);
    assert.equal(Number((await pool.query('SELECT count(*) FROM copy_revisions WHERE task_id = $1', [entry.taskId])).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM human_quality_assessments WHERE task_id = $1', [entry.taskId])).rows[0].count), 0);
  });

  await t.test('successful human web sources still cannot claim copy or image execution', async () => {
    for (const method of ['claimCopy', 'claimImage']) {
      await assert.rejects(repository[method]('unregistered-web-save'), { code: 'NOT_FOUND' });
    }
    await assertWebSource('unregistered-web-save');
  });

  await t.test('ADMIN image-only rework saves an approved plan under its new web source', async () => {
    const entry = await fixture();
    const imageRunId = randomUUID();
    const executionId = randomUUID();
    const chainId = randomUUID();
    await pool.query(`UPDATE copy_revisions SET approved_at = now(), approved_by_node_id = $2,
      approval_mode = 'MANUAL' WHERE id = $1`, [entry.revisionId, workerNode]);
    await pool.query(`INSERT INTO task_executions(id, task_id, kind, node_id, status, stage, snapshot,
      image_production_chain_id) VALUES ($1, $2, 'IMAGE', $3, 'SUCCEEDED', 'IMAGE_COMPLETED', '{}', $4)`,
    [executionId, entry.taskId, workerNode, chainId]);
    await pool.query(`INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id, status,
      image_production_chain_id) VALUES ($1, $2, $3, $4, 'COMPLETED', $5)`,
    [imageRunId, entry.taskId, executionId, entry.revisionId, chainId]);
    const assetId = Number((await pool.query(`INSERT INTO assets(task_id, image_run_id, media_type,
      byte_size, sha256, storage_path, image_production_chain_id, artifact_key, origin_image_run_id)
      VALUES ($1, $2, 'image/png', 0, $3, $4, $5, 'hero', $2) RETURNING id`,
    [entry.taskId, imageRunId, 'a'.repeat(64), `${entry.taskId}/synthetic-image.png`, chainId])).rows[0].id);
    await pool.query(`UPDATE tasks SET state = 'MANUAL_ARCHIVE', current_image_run_id = $2,
      review_assigned_to_account_id = $3, image_production_chain_id = $4,
      copy_qc_released_revision_id = current_copy_revision_id WHERE id = $1`,
    [entry.taskId, imageRunId, actors.admin.userId, chainId]);
    const nodeId = 'unregistered-web-image-plan';
    const imagePlan = structuredClone(content.imagePlan);
    imagePlan[0].headline = '管理员修正后的封面标题';
    // This repository operation backs the admin plan edit; its old review-images
    // HTTP route is deliberately retired with HTTP 410.
    const reviewed = await repository.reviewImages(entry.taskId, {
      imageRunId, revisionId: entry.revisionId, nodeId, imagePlan, decision: 'REWORK',
      reworkTarget: 'IMAGE', score: 2.5, reasons: ['TEXT'], note: '修正封面标题后重新生成图片',
      problemAssetIds: [assetId], reviewSessionId: randomUUID(), actor: actors.admin,
    });
    assert.equal(reviewed.state, 'IMAGE_QUEUED');
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [reviewed.currentCopyRevisionId])).rows[0];
    assert.equal(revision.approved_by_node_id, nodeId);
    assert.equal(revision.revision_origin, 'PLAN_EDIT');
    assert.equal(revision.execution_id, null);
    assert.equal(revision.content.imagePlan[0].headline, imagePlan[0].headline);
    const inheritance = (await pool.query('SELECT * FROM copy_qc_revision_inheritances WHERE target_revision_id = $1', [revision.id])).rows[0];
    assert.equal(Number(inheritance.inherited_by_account_id), actors.admin.userId);
    await assertWebSource(nodeId);
  });
});
