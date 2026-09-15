import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  batchReturnImageQa,
  getImageQaBatchReturnPreview,
  listImageQaItems,
  passImageQaItem,
  returnImageQaItem,
  submitImageSelfReview,
} from '../src/image-quality-control.mjs';

const maintenanceUrl = process.env.IMAGE_QUALITY_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('real PostgreSQL image self-review, sampling hold, QA return, edit version and mandatory recheck', {
  skip: !maintenanceUrl,
  timeout: 120_000,
}, async (t) => {
  const url = new URL(maintenanceUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'image QA test database must be local');
  const adminPool = new pg.Pool({ connectionString: url.href });
  const databaseName = `image_qa_test_${randomUUID().replaceAll('-', '')}`;
  const storageRoot = await mkdtemp(join(tmpdir(), 'image-qa-http-e2e-'));
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ\/l5y6WQAAAABJRU5ErkJggg==', 'base64');
  const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: url.href });
  t.after(async () => {
    await pool.end();
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
    await adminPool.query(`DROP DATABASE ${databaseName}`);
    await adminPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  });
  await migrateDatabase(pool);
  assert.deepEqual(await migrateDatabase(pool), []);
  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('image-qa-test', 'image qa test')");
  const adminRow = (await pool.query("SELECT * FROM app_users WHERE role = 'ADMIN' ORDER BY id LIMIT 1")).rows[0];
  const workerRow = (await pool.query(`
    INSERT INTO app_users(username, display_name, role, password_hash, copy_review_enabled, must_change_password)
    VALUES ('image-worker', 'image worker', 'USER', 'not-a-credential', true, false) RETURNING *
  `)).rows[0];
  const reviewerRow = (await pool.query(`
    INSERT INTO app_users(username, display_name, role, password_hash, copy_review_enabled, image_qc_enabled, must_change_password)
    VALUES ('image-reviewer', 'image reviewer', 'REVIEWER', 'not-a-credential', true, true, false) RETURNING *
  `)).rows[0];
  const actor = (row) => ({
    userId: Number(row.id), username: row.username, role: row.role,
    credentialVersion: Number(row.credential_version),
  });
  const admin = actor(adminRow);
  const worker = actor(workerRow);
  const reviewer = actor(reviewerRow);
  const batch = (await pool.query(`
    INSERT INTO production_batches(public_id, query_package_name, created_by_account_id,
      created_by_username, request_id, request_fingerprint)
    VALUES ($1, 'image qa fixture', $2, $3, $4, $5) RETURNING *
  `, [randomUUID(), admin.userId, admin.username, randomUUID(), '0'.repeat(64)])).rows[0];

  async function addImageRun(taskId, copyRevisionId, label) {
    const imageRunId = randomUUID();
    await pool.query(`
      INSERT INTO image_runs(id, task_id, copy_revision_id, status, image_production_chain_id)
      VALUES ($1,$2,$3,'COMPLETED',$1)
    `, [imageRunId, taskId, copyRevisionId]);
    const images = [];
    for (let page = 1; page <= 3; page++) {
      const storagePath = join(storageRoot, `${taskId}-${label}-${page}.png`);
      await writeFile(storagePath, imageBytes);
      const saved = (await pool.query(`
        INSERT INTO assets(task_id, image_run_id, media_type, byte_size, sha256,
          storage_path, original_name, image_production_chain_id, artifact_key,
          origin_image_run_id, asset_role)
        VALUES ($1,$2,'image/png',$3,$4,$5,$6,$2,$7,$2,'DELIVERY') RETURNING id
      `, [taskId, imageRunId, imageBytes.length, imageSha256,
        storagePath, `${label}-${page}.png`, `${label}-${page}`])).rows[0];
      images.push({ assetId: Number(saved.id), deliveryAssetId: Number(saved.id), pageIndex: page });
    }
    await pool.query('UPDATE image_runs SET result = $2, finished_at = now() WHERE id = $1', [imageRunId, { images }]);
    return { imageRunId, images };
  }

  async function createTask(sequence) {
    const task = (await pool.query(`
      INSERT INTO tasks(query, state, created_by_node_id, copy_executor_node_id,
        assigned_to_user_id, assignment_source, assigned_at, production_batch_id)
      VALUES ($1,'COPY_RUNNING','image-qa-test','image-qa-test',$2,'MANUAL',now(),$3) RETURNING *
    `, [`image qa task ${sequence}`, worker.username, batch.id])).rows[0];
    const revision = (await pool.query(`
      INSERT INTO copy_revisions(task_id, revision, content, approved_at)
      VALUES ($1,1,$2,now()) RETURNING *
    `, [task.id, { copy: { title: `title ${sequence}`, body: 'body', tags: [] },
      imagePlan: [1, 2, 3].map((page) => ({ kind: page === 1 ? 'hero' : 'detail', headline: `page ${page}` })) }])).rows[0];
    const run = await addImageRun(Number(task.id), Number(revision.id), 'initial');
    await pool.query(`
      UPDATE tasks SET state = 'MANUAL_ARCHIVE', current_stage = 'MANUAL_ARCHIVE',
        current_copy_revision_id = $2, current_image_run_id = $3 WHERE id = $1
    `, [task.id, revision.id, run.imageRunId]);
    await pool.query(`
      INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot)
      VALUES ($1,$2,$3)
    `, [batch.id, task.id, task.query]);
    return { taskId: Number(task.id), copyRevisionId: Number(revision.id), ...run };
  }

  await pool.query(`UPDATE workflow_quality_settings SET image_sampling_enabled = true,
    image_sampling_rate_bps = 2000, image_blind_review_enabled = true`);
  const firstBatch = [];
  for (let index = 0; index < 5; index++) {
    const entry = await createTask(index + 1);
    firstBatch.push(entry);
    const submitted = await submitImageSelfReview(pool, entry.taskId, {
      imageRunId: entry.imageRunId, reviewSessionId: randomUUID(),
    }, worker);
    assert.equal(submitted.state, 'IMAGE_QC_PENDING');
  }
  const freeze = (await pool.query('SELECT * FROM image_sampling_freezes ORDER BY id LIMIT 1')).rows[0];
  assert.equal(freeze.population_count, 5);
  assert.equal(freeze.sample_count, 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state='IMAGE_QC_PENDING'")).rows[0].count), 5);
  await assert.rejects(listImageQaItems(pool, {}, worker), { code: 'FORBIDDEN' });
  const blindQueue = await listImageQaItems(pool, {}, reviewer);
  assert.equal(blindQueue.items.length, 1);
  assert.equal(blindQueue.items[0].blindReview, true);
  assert.equal(Object.hasOwn(blindQueue.items[0], 'taskId'), false);
  await passImageQaItem(pool, blindQueue.items[0].id, { requestId: randomUUID(), score: 3 }, admin);
  assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state='REVIEWED'")).rows[0].count), 5);
  assert.equal(Number((await pool.query("SELECT count(*) FROM delivery_entries WHERE status='READY'")).rows[0].count), 5);

  await pool.query(`UPDATE workflow_quality_settings SET image_sampling_rate_bps = 10000,
    image_blind_review_enabled = false`);
  const returnedTask = await createTask(6);
  await submitImageSelfReview(pool, returnedTask.taskId, {
    imageRunId: returnedTask.imageRunId, reviewSessionId: randomUUID(),
  }, worker);
  const returnItem = (await listImageQaItems(pool, {}, reviewer)).items.find((item) => item.taskId === returnedTask.taskId);
  assert.ok(returnItem);
  await returnImageQaItem(pool, returnItem.id, {
    requestId: randomUUID(), score: 2, reworkTarget: 'IMAGE', note: '修正第 1 张图片',
    problemAssetIds: [returnedTask.images[0].assetId], reasonCodes: ['IMAGE_QUALITY_ISSUE'],
  }, reviewer);
  let returnedRow = (await pool.query('SELECT * FROM tasks WHERE id = $1', [returnedTask.taskId])).rows[0];
  assert.equal(returnedRow.state, 'IMAGE_REWORK_PENDING');
  assert.equal(returnedRow.mandatory_image_qc, true);
  assert.equal(returnedRow.current_image_run_id, returnedTask.imageRunId);

  const editedRun = await addImageRun(returnedTask.taskId, returnedTask.copyRevisionId, 'edited');
  await pool.query(`UPDATE tasks SET state='MANUAL_ARCHIVE', current_stage='MANUAL_ARCHIVE',
    current_image_run_id=$2 WHERE id=$1`, [returnedTask.taskId, editedRun.imageRunId]);
  await submitImageSelfReview(pool, returnedTask.taskId, {
    imageRunId: editedRun.imageRunId, reviewSessionId: randomUUID(),
  }, worker);
  const mandatory = (await listImageQaItems(pool, {}, reviewer)).items.find((item) => item.sampleKind === 'MANDATORY_RECHECK');
  assert.ok(mandatory);
  await passImageQaItem(pool, mandatory.id, { requestId: randomUUID(), score: 3 }, reviewer);
  returnedRow = (await pool.query('SELECT * FROM tasks WHERE id = $1', [returnedTask.taskId])).rows[0];
  assert.equal(returnedRow.state, 'REVIEWED');
  assert.equal(returnedRow.mandatory_image_qc, false);
  const ready = (await pool.query(`SELECT * FROM delivery_entries
    WHERE task_id=$1 AND status='READY'`, [returnedTask.taskId])).rows[0];
  assert.equal(ready.image_run_id, editedRun.imageRunId);
  assert.equal((await pool.query(`SELECT status FROM image_sampling_items
    WHERE public_id=$1`, [returnItem.id])).rows[0].status, 'SUPERSEDED');

  await pool.query(`UPDATE workflow_quality_settings SET image_sampling_rate_bps = 5000,
    image_reviewer_batch_return_enabled = true`);
  const batchReturnMembers = [await createTask(7), await createTask(8)];
  for (const member of batchReturnMembers) {
    await submitImageSelfReview(pool, member.taskId, {
      imageRunId: member.imageRunId, reviewSessionId: randomUUID(),
    }, worker);
  }
  const selectedForBatch = (await listImageQaItems(pool, {}, reviewer)).items
    .find((item) => batchReturnMembers.some((member) => member.taskId === item.taskId));
  assert.ok(selectedForBatch);
  const preview = await getImageQaBatchReturnPreview(pool, selectedForBatch.freezePublicId, reviewer);
  assert.equal(preview.confirmedCount, 2);
  const batchReturn = await batchReturnImageQa(pool, {
    requestId: randomUUID(), freezePublicId: preview.freezePublicId,
    itemIds: preview.itemIds, confirmedCount: preview.confirmedCount,
    reasonCodes: ['IMAGE_QUALITY_ISSUE'], note: '同批图片风格错误，需要逐项返修',
  }, reviewer);
  assert.equal(batchReturn.affectedCount, 2);
  const returnedMembers = await pool.query(`SELECT state, mandatory_image_qc,
    mandatory_image_qc_origin FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id`,
  [batchReturnMembers.map((member) => member.taskId)]);
  assert.deepEqual(returnedMembers.rows, [
    { state: 'IMAGE_REWORK_PENDING', mandatory_image_qc: true, mandatory_image_qc_origin: 'BATCH_RETURN' },
    { state: 'IMAGE_REWORK_PENDING', mandatory_image_qc: true, mandatory_image_qc_origin: 'BATCH_RETURN' },
  ]);
  for (const [index, member] of batchReturnMembers.entries()) {
    const repaired = await addImageRun(member.taskId, member.copyRevisionId, `batch-repaired-${index}`);
    await pool.query(`UPDATE tasks SET state='MANUAL_ARCHIVE', current_stage='MANUAL_ARCHIVE',
      current_image_run_id=$2 WHERE id=$1`, [member.taskId, repaired.imageRunId]);
    await submitImageSelfReview(pool, member.taskId, {
      imageRunId: repaired.imageRunId, reviewSessionId: randomUUID(),
    }, worker);
    const recheck = (await listImageQaItems(pool, {}, reviewer)).items
      .find((item) => item.sampleKind === 'MANDATORY_RECHECK' && item.taskId === member.taskId);
    assert.ok(recheck);
    await passImageQaItem(pool, recheck.id, { requestId: randomUUID(), score: 3 }, reviewer);
    const other = batchReturnMembers[1 - index];
    if (index === 0) {
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [other.taskId])).rows[0].state,
        'IMAGE_REWORK_PENDING', 'one repaired member must not release an unrepaired batch sibling');
      assert.equal((await pool.query('SELECT status FROM image_sampling_freezes WHERE public_id=$1',
      [preview.freezePublicId])).rows[0].status, 'BATCH_RETURNED');
    }
  }
  assert.equal((await pool.query('SELECT status FROM image_sampling_freezes WHERE public_id=$1',
  [preview.freezePublicId])).rows[0].status, 'RELEASED');

  await pool.query('UPDATE workflow_quality_settings SET image_sampling_enabled = false');
  const direct = await createTask(9);
  const directResult = await submitImageSelfReview(pool, direct.taskId, {
    imageRunId: direct.imageRunId, reviewSessionId: randomUUID(),
  }, worker);
  assert.equal(directResult.state, 'REVIEWED');
  assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [direct.taskId])).rows[0].state, 'REVIEWED');

  await pool.query(`UPDATE workflow_quality_settings SET image_sampling_enabled = true,
    image_sampling_rate_bps = 10000, image_blind_review_enabled = true`);
  const httpTask = await createTask(10);
  const repository = new PostgresControlPlaneRepository({ pool });
  const app = createControlPlaneApp({ repository, storageRoot, logger: { info() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const actorHeaders = (identity) => ({
    'content-type': 'application/json',
    'x-actor-user-id': String(identity.userId),
    'x-actor-username': identity.username,
    'x-actor-role': identity.role,
    'x-actor-credential-version': String(identity.credentialVersion),
  });
  try {
    const submitResponse = await fetch(`${root}/v1/tasks/${httpTask.taskId}/submit-image-self-review`, {
      method: 'POST', headers: actorHeaders(worker),
      body: JSON.stringify({ imageRunId: httpTask.imageRunId, reviewSessionId: randomUUID() }),
    });
    assert.equal(submitResponse.status, 200);
    assert.equal((await submitResponse.json()).data.state, 'IMAGE_QC_PENDING');

    const userPoolResponse = await fetch(`${root}/v1/image-qa/items`, { headers: actorHeaders(worker) });
    assert.equal(userPoolResponse.status, 403);
    const qaResponse = await fetch(`${root}/v1/image-qa/items`, { headers: actorHeaders(reviewer) });
    assert.equal(qaResponse.status, 200);
    const httpQaItems = (await qaResponse.json()).data.items;
    assert.equal(httpQaItems.length, 1);
    const qaItem = httpQaItems[0];
    assert.ok(qaItem);
    assert.equal(Object.hasOwn(qaItem, 'taskId'), false);
    const hiddenTaskResponse = await fetch(`${root}/v1/tasks/${httpTask.taskId}`, { headers: actorHeaders(reviewer) });
    assert.equal(hiddenTaskResponse.status, 404);
    assert.match(qaItem.assets[0].url, new RegExp(`/v1/image-qa/items/${qaItem.id}/assets/`, 'u'));
    const qaAssetResponse = await fetch(`${root}${qaItem.assets[0].url}`, { headers: actorHeaders(reviewer) });
    assert.equal(qaAssetResponse.status, 200);
    assert.deepEqual(Buffer.from(await qaAssetResponse.arrayBuffer()), imageBytes);
    const invalidScoreResponse = await fetch(`${root}/v1/image-qa/items/${qaItem.id}/pass`, {
      method: 'POST', headers: actorHeaders(reviewer),
      body: JSON.stringify({ requestId: randomUUID(), score: 2.1 }),
    });
    assert.equal(invalidScoreResponse.status, 400);
    const lowPassResponse = await fetch(`${root}/v1/image-qa/items/${qaItem.id}/pass`, {
      method: 'POST', headers: actorHeaders(reviewer),
      body: JSON.stringify({ requestId: randomUUID(), score: 2 }),
    });
    assert.equal(lowPassResponse.status, 409);
    const passResponse = await fetch(`${root}/v1/image-qa/items/${qaItem.id}/pass`, {
      method: 'POST', headers: actorHeaders(reviewer),
      body: JSON.stringify({ requestId: randomUUID(), score: 3 }),
    });
    assert.equal(passResponse.status, 200);
    assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [httpTask.taskId])).rows[0].state, 'REVIEWED');
    assert.equal(Number((await pool.query(`SELECT count(*) FROM delivery_entries
      WHERE task_id=$1 AND status='READY'`, [httpTask.taskId])).rows[0].count), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.context.disposeControlPlaneResources();
  }
});

function hashFor(value) {
  return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
}
