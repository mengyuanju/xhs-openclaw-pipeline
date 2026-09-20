import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { passCopyQaItem } from '../src/copy-quality-control.mjs';
import {
  batchReturnImageQa,
  discardTaskImages,
  discardImageQaItem,
  getImageQaBatchReturnPreview,
  listImageQaItems,
  passImageQaItem,
  returnImageQaItem,
  submitImageSelfReview,
} from '../src/image-quality-control.mjs';

const configuredMaintenanceUrl = process.env.IMAGE_QUALITY_TEST_DATABASE_URL?.trim();

async function startDisposablePostgres() {
  const root = await mkdtemp(join(tmpdir(), 'xhs-image-quality-pg-'));
  const data = join(root, 'data');
  const bin = process.env.POSTGRES_E2E_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin');
  const executable = (name) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const control = (args) => new Promise((accept, reject) => {
    const child = spawn(executable('pg_ctl'), args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? accept() : reject(new Error(`pg_ctl ${code}`)));
  });
  const probe = createServer();
  await new Promise((accept) => probe.listen(0, '127.0.0.1', accept));
  const port = probe.address().port;
  await new Promise((accept, reject) => probe.close((error) => error ? reject(error) : accept()));
  let started = false;
  try {
    await promisify(execFile)(executable('initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--no-sync'], { windowsHide: true, timeout: 60_000 });
    await control(['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    return { url: `postgresql://postgres@127.0.0.1:${port}/postgres`, async stop() {
      if (started) { started = false; await control(['-D', data, '-m', 'fast', '-w', 'stop']); }
      assert.ok(resolve(root).startsWith(resolve(tmpdir())));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
  } catch (error) {
    if (started) await control(['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => {});
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}

test('real PostgreSQL image self-review, sampling hold, QA return, edit version and mandatory recheck', {
  skip: process.env.RUN_POSTGRES_E2E !== '1' && !configuredMaintenanceUrl,
  timeout: 120_000,
}, async (t) => {
  const isolatedPostgres = configuredMaintenanceUrl ? null : await startDisposablePostgres();
  const maintenanceUrl = configuredMaintenanceUrl ?? isolatedPostgres.url;
  const url = new URL(maintenanceUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'image QA test database must be local');
  const adminPool = new pg.Pool({ connectionString: url.href });
  const databaseName = `image_qa_test_${randomUUID().replaceAll('-', '')}`;
  const storageRoot = await mkdtemp(join(tmpdir(), 'image-qa-http-e2e-'));
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ\/l5y6WQAAAABJRU5ErkJggg==', 'base64');
  const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
  let databaseCreated = false;
  let pool;
  t.after(async () => {
    await pool?.end();
    if (databaseCreated) {
      await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
      await adminPool.query(`DROP DATABASE ${databaseName}`);
    }
    await adminPool.end();
    await rm(storageRoot, { recursive: true, force: true });
    await isolatedPostgres?.stop();
  });
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  databaseCreated = true;
  url.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: url.href });
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
    INSERT INTO production_batches(public_id, query_package_name, client_batch_code, created_by_account_id,
      created_by_username, request_id, request_fingerprint)
    VALUES ($1, 'image qa fixture', $2, $3, $4, $5, $6) RETURNING *
  `, [randomUUID(), randomUUID().replaceAll('-', ''), admin.userId, admin.username,
    randomUUID(), '0'.repeat(64)])).rows[0];

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
      const sourceStoragePath = join(storageRoot, `${taskId}-source-${label}-${page}.png`);
      await writeFile(sourceStoragePath, imageBytes);
      const source = (await pool.query(`
        INSERT INTO assets(task_id, image_run_id, media_type, byte_size, sha256,
          storage_path, original_name, image_production_chain_id, artifact_key,
          origin_image_run_id, asset_role)
        VALUES ($1,$2,'image/png',$3,$4,$5,$6,$2,$7,$2,'DELIVERY') RETURNING id
      `, [taskId, imageRunId, imageBytes.length, imageSha256,
        sourceStoragePath, `source-${label}-${page}.png`, `source-${label}-${page}`])).rows[0];
      images.push({ assetId: Number(saved.id), sourceAssetId: Number(source.id),
        deliveryAssetId: Number(saved.id), pageIndex: page });
    }
    await pool.query('UPDATE image_runs SET result = $2, finished_at = now() WHERE id = $1', [imageRunId, { images }]);
    return { imageRunId, images };
  }

  async function createTask(sequence, assignee = worker) {
    const task = (await pool.query(`
      INSERT INTO tasks(query, state, created_by_node_id, copy_executor_node_id,
        assigned_to_user_id, assignment_source, assigned_at, production_batch_id)
      VALUES ($1,'COPY_RUNNING','image-qa-test','image-qa-test',$2,'MANUAL',now(),$3) RETURNING *
    `, [`image qa task ${sequence}`, assignee.username, batch.id])).rows[0];
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
    if (index === 0) {
      const pendingEditId = randomUUID();
      await pool.query(`
        INSERT INTO image_edit_requests(
          id, task_id, request_id, source_image_run_id, source_asset_id,
          copy_revision_id, source_sha256, target_page, operation, config,
          status, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','DRAFT',$8)
      `, [pendingEditId, entry.taskId, randomUUID(), entry.imageRunId,
        entry.images[0].assetId, entry.copyRevisionId, imageSha256, worker.username]);
      await assert.rejects(submitImageSelfReview(pool, entry.taskId, {
        imageRunId: entry.imageRunId, reviewSessionId: randomUUID(),
      }, worker), { code: 'IMAGE_EDITS_PENDING' });
      assert.equal(Number((await pool.query(`
        SELECT count(*) FROM image_approval_events WHERE task_id = $1
      `, [entry.taskId])).rows[0].count), 0);
      await pool.query("UPDATE image_edit_requests SET status='CANCELLED' WHERE id=$1", [pendingEditId]);
    }
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
  assert.equal(blindQueue.items[0].assets.length, 3, 'QA must expose one final delivery asset per logical page');
  assert.deepEqual(blindQueue.items[0].assets.map((asset) => asset.pageIndex), [1, 2, 3]);
  assert.ok(blindQueue.items[0].assets.every((asset) => !asset.originalName.startsWith('source-')));
  assert.equal(blindQueue.items[0].blindReview, true);
  assert.equal(Object.hasOwn(blindQueue.items[0], 'taskId'), false);
  const legacyApproval = (await pool.query(`
    SELECT approval.id, approval.task_id, approval.image_run_id, approval.copy_revision_id
    FROM image_approval_events AS approval
    JOIN image_sampling_items AS item ON item.approval_event_id = approval.id
    WHERE item.public_id = $1
  `, [blindQueue.items[0].id])).rows[0];
  const legacyPendingEditId = randomUUID();
  await pool.query(`
    INSERT INTO image_edit_requests(
      id, task_id, request_id, source_image_run_id, source_asset_id,
      copy_revision_id, source_sha256, target_page, operation, config,
      status, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','PREVIEW_READY',$8)
  `, [legacyPendingEditId, legacyApproval.task_id, randomUUID(), legacyApproval.image_run_id,
    blindQueue.items[0].assets[0].id, legacyApproval.copy_revision_id,
    blindQueue.items[0].assets[0].sha256, worker.username]);
  const blockedQueue = await listImageQaItems(pool, {}, reviewer);
  const blockedItem = blockedQueue.items.find((item) => item.id === blindQueue.items[0].id);
  assert.equal(blockedItem.blockers.pendingImageEdits, 1);
  assert.equal(blockedItem.capabilities.canPass, false);
  assert.equal(blockedItem.capabilities.canReturnSingle, true);
  await assert.rejects(passImageQaItem(pool, blockedItem.id, {
    requestId: randomUUID(), score: 3,
  }, reviewer), { code: 'IMAGE_EDITS_PENDING' });
  await pool.query("UPDATE image_edit_requests SET status='CANCELLED' WHERE id=$1", [legacyPendingEditId]);
  const legacyAssets = (await pool.query(`
    SELECT id, media_type, byte_size, sha256, original_name
    FROM image_run_asset_view
    WHERE task_id = $1 AND image_run_id = $2
    ORDER BY id
  `, [legacyApproval.task_id, legacyApproval.image_run_id])).rows.map((row) => ({
    id: Number(row.id), mediaType: row.media_type, byteSize: Number(row.byte_size),
    sha256: row.sha256, originalName: row.original_name,
  }));
  const legacySha256 = createHash('sha256').update(JSON.stringify(legacyAssets)).digest('hex');
  await pool.query('UPDATE image_approval_events SET image_set_sha256 = $2 WHERE id = $1', [
    legacyApproval.id, legacySha256,
  ]);
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

  const adminDirect = await createTask(10, admin);
  const adminDirectResult = await submitImageSelfReview(pool, adminDirect.taskId, {
    imageRunId: adminDirect.imageRunId, reviewSessionId: randomUUID(),
  }, admin);
  assert.equal(adminDirectResult.state, 'REVIEWED');

  await pool.query(`UPDATE workflow_quality_settings SET image_sampling_enabled = true,
    image_sampling_rate_bps = 10000, image_blind_review_enabled = true`);
  const httpTask = await createTask(11);
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
    const sourceAssetResponse = await fetch(`${root}/v1/image-qa/items/${qaItem.id}/assets/${httpTask.images[0].sourceAssetId}`, {
      headers: actorHeaders(reviewer),
    });
    assert.equal(sourceAssetResponse.status, 404, 'source and historical members are not QA review targets');
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

    await t.test('owner discard requires a reason, assignment and the current version; retries are idempotent', async () => {
      const member = await createTask(20);
      const input = { imageRunId: member.imageRunId, expectedCopyRevisionId: member.copyRevisionId,
        requestId: randomUUID(), note: '  图片内容无法使用，重新创建任务  ' };
      for (const note of [undefined, '', '   ']) {
        await assert.rejects(discardTaskImages(pool, member.taskId, { ...input, note }, worker), TypeError);
      }
      await assert.rejects(discardTaskImages(pool, member.taskId, { ...input, note: 'a'.repeat(1001) }, worker), RangeError);
      await assert.rejects(discardTaskImages(pool, member.taskId, input, admin), { code: 'FORBIDDEN' });
      await assert.rejects(discardTaskImages(pool, member.taskId, input, reviewer), { code: 'FORBIDDEN' });
      await assert.rejects(discardTaskImages(pool, member.taskId, { ...input, imageRunId: randomUUID() }, worker), { code: 'IMAGE_VERSION_CHANGED' });
      const post = (suffix, body, identity = worker) => fetch(`${root}/v1/tasks/${member.taskId}/${suffix}`, {
        method: 'POST', headers: actorHeaders(identity), body: JSON.stringify(body),
      });
      assert.equal((await post('cancel', {})).status, 409, 'legacy cancel cannot bypass the required reason');
      assert.equal((await post('discard-images', { ...input, note: ' ' })).status, 400);
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [member.taskId])).rows[0].state, 'MANUAL_ARCHIVE');
      const pendingId = randomUUID();
      await pool.query(`INSERT INTO image_edit_requests(id, task_id, request_id, source_image_run_id,
        source_asset_id, copy_revision_id, source_sha256, target_page, operation, config, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','DRAFT',$8)`,
      [pendingId, member.taskId, randomUUID(), member.imageRunId, member.images[0].assetId, member.copyRevisionId, imageSha256, worker.username]);
      await assert.rejects(discardTaskImages(pool, member.taskId, input, worker), { code: 'IMAGE_EDITS_PENDING' });
      await pool.query("UPDATE image_edit_requests SET status='CANCELLED' WHERE id=$1", [pendingId]);
      const response = await post('discard-images', input);
      assert.equal(response.status, 200);
      const result = (await response.json()).data;
      assert.deepEqual(result, { taskId: member.taskId, state: 'CANCELLED' });
      assert.deepEqual(await discardTaskImages(pool, member.taskId, input, worker), result);
      await assert.rejects(discardTaskImages(pool, member.taskId, { ...input, note: 'another reason' }, worker), { code: 'REQUEST_ID_CONFLICT' });
      const records = (await pool.query('SELECT * FROM image_task_dispositions WHERE task_id=$1', [member.taskId])).rows;
      assert.equal(records.length, 1); assert.equal(records[0].note, input.note.trim());
      assert.equal(records[0].actor_username, worker.username); assert.equal(records[0].from_state, 'MANUAL_ARCHIVE');
      const detail = await repository.getTask(member.taskId);
      assert.equal(detail.imageDiscardEvents[0].note, input.note.trim());
      assert.equal(detail.currentImageRunId, member.imageRunId);
      assert.ok(detail.assets.length > 0, 'discard preserves original assets');
      const ownAdmin = await createTask(21, admin);
      await discardTaskImages(pool, ownAdmin.taskId, { ...input, requestId: randomUUID(), imageRunId: ownAdmin.imageRunId,
        expectedCopyRevisionId: ownAdmin.copyRevisionId }, admin);
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [ownAdmin.taskId])).rows[0].state, 'CANCELLED');
    });

    await t.test('blind reviewer discard releases other sampled batch members and never revives the discarded task', async () => {
      await pool.query(`UPDATE workflow_quality_settings SET image_sampling_rate_bps=2000, image_blind_review_enabled=true`);
      const members = [];
      for (let index = 0; index < 5; index++) {
        const member = await createTask(30 + index); members.push(member);
        await submitImageSelfReview(pool, member.taskId, { imageRunId: member.imageRunId, reviewSessionId: randomUUID() }, worker);
      }
      const item = (await listImageQaItems(pool, {}, reviewer)).items[0];
      assert.ok(item.capabilities.canDiscard); assert.equal(item.taskId, undefined);
      const taskId = Number((await pool.query('SELECT task_id FROM image_sampling_items WHERE public_id=$1', [item.id])).rows[0].task_id);
      const input = { requestId: randomUUID(), note: '图片主题错误，整组废弃' };
      const post = (identity, body) => fetch(`${root}/v1/image-qa/items/${item.id}/discard`, {
        method: 'POST', headers: actorHeaders(identity), body: JSON.stringify(body),
      });
      assert.equal((await post(worker, input)).status, 403);
      assert.equal((await post(reviewer, { ...input, note: '' })).status, 400);
      await pool.query('UPDATE image_sampling_items SET assigned_review_account_id=$2 WHERE public_id=$1', [item.id, admin.userId]);
      assert.equal((await post(reviewer, input)).status, 403);
      await pool.query('UPDATE image_sampling_items SET assigned_review_account_id=$2 WHERE public_id=$1', [item.id, reviewer.userId]);
      const response = await post(reviewer, input);
      assert.equal(response.status, 200);
      const result = (await response.json()).data;
      assert.deepEqual(result, { id: item.id, status: 'DISCARDED', taskState: 'CANCELLED' });
      assert.deepEqual(await discardImageQaItem(pool, item.id, input, reviewer), result);
      assert.equal((await pool.query('SELECT status FROM image_sampling_freezes WHERE public_id=$1', [item.freezePublicId])).rows[0].status, 'RELEASED_WITH_EXCEPTIONS');
      const states = (await pool.query('SELECT id, state FROM tasks WHERE id=ANY($1::bigint[])', [members.map(member => member.taskId)])).rows;
      for (const row of states) assert.equal(row.state, Number(row.id) === taskId ? 'CANCELLED' : 'REVIEWED');
      assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_entries WHERE task_id=$1', [taskId])).rows[0].count), 0);
      const discarded = (await listImageQaItems(pool, { status: 'DISCARDED' }, reviewer)).items.find(row => row.id === item.id);
      assert.equal(discarded.discardReason, input.note); assert.equal(discarded.capabilities.canDiscard, false);
      assert.equal(discarded.taskId, undefined); assert.equal(discarded.submitter, undefined);
      const preview = await getImageQaBatchReturnPreview(pool, item.freezePublicId, admin);
      assert.equal(preview.confirmedCount, 4);
      await batchReturnImageQa(pool, { requestId: randomUUID(), freezePublicId: item.freezePublicId,
        itemIds: preview.itemIds, confirmedCount: preview.confirmedCount, note: '其他图片需要返修', reasonCodes: ['IMAGE_QUALITY_ISSUE'] }, admin);
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0].state, 'CANCELLED');
      assert.equal((await pool.query('SELECT status FROM image_sampling_items WHERE public_id=$1', [item.id])).rows[0].status, 'DISCARDED');
    });

    await t.test('owner may discard image rework while preserving the original QA return and releasing its sibling', async () => {
      await pool.query(`UPDATE workflow_quality_settings SET image_sampling_rate_bps=5000, image_blind_review_enabled=false`);
      const members = [await createTask(40), await createTask(41)];
      for (const member of members) await submitImageSelfReview(pool, member.taskId, {
        imageRunId: member.imageRunId, reviewSessionId: randomUUID(),
      }, worker);
      const item = (await listImageQaItems(pool, {}, reviewer)).items.find(row => members.some(member => member.taskId === row.taskId));
      await returnImageQaItem(pool, item.id, { requestId: randomUUID(), score: 2, reworkTarget: 'IMAGE',
        note: '图片无法修复', reasonCodes: ['IMAGE_QUALITY_ISSUE'], problemAssetIds: [item.assets[0].id] }, reviewer);
      const member = members.find(row => row.taskId === item.taskId);
      await discardTaskImages(pool, member.taskId, { requestId: randomUUID(), imageRunId: member.imageRunId,
        expectedCopyRevisionId: member.copyRevisionId, note: '确认无法修复，废弃' }, worker);
      assert.equal((await pool.query('SELECT status FROM image_sampling_items WHERE public_id=$1', [item.id])).rows[0].status, 'RETURNED');
      const sibling = members.find(row => row !== member);
      assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1', [sibling.taskId])).rows[0].state, 'REVIEWED');
      assert.equal((await pool.query('SELECT status FROM image_sampling_freezes WHERE public_id=$1', [item.freezePublicId])).rows[0].status, 'RELEASED_WITH_EXCEPTIONS');
    });
    await t.test('administrators restore discarded content into usable review flows without reviving old approvals', async () => {
      const restore = async (member) => {
        const task = await repository.getTask(member.taskId);
        return repository.restoreCancelledTask(member.taskId, { expectedUpdatedAt: new Date(task.updatedAt).toISOString() }, { actor: admin });
      };
      const initial = await createTask(60);
      await pool.query('UPDATE tasks SET copy_qc_released_revision_id=current_copy_revision_id WHERE id=$1', [initial.taskId]);
      await discardTaskImages(pool, initial.taskId, { imageRunId: initial.imageRunId,
        expectedCopyRevisionId: initial.copyRevisionId, requestId: randomUUID(), note: '误废弃' }, worker);
      const restored = await restore(initial);
      assert.equal(restored.state, 'MANUAL_ARCHIVE');
      assert.equal(restored.currentImageRunId, initial.imageRunId);
      assert.equal(restored.mandatoryImageQc, true);
      await submitImageSelfReview(pool, initial.taskId, { imageRunId: initial.imageRunId, reviewSessionId: randomUUID() }, worker);
      const initialItem = (await listImageQaItems(pool, {}, admin)).items.find(item => item.taskId === initial.taskId);
      assert.ok(initialItem, 'restored images must enter a new mandatory QA round');
      await passImageQaItem(pool, initialItem.id, { requestId: randomUUID(), score: 3 }, admin);
      assert.equal((await repository.getTask(initial.taskId)).state, 'REVIEWED');

      await repository.cancelTask(initial.taskId, { actor: admin });
      const snapshot = await repository.getTask(initial.taskId);
      const restoreInput = { expectedUpdatedAt: new Date(snapshot.updatedAt).toISOString() };
      const outcomes = await Promise.allSettled([1, 2].map(() => repository.restoreCancelledTask(initial.taskId, restoreInput, { actor: admin })));
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await repository.getTask(initial.taskId)).state, 'IMAGE_REWORK_PENDING');
      assert.equal((await pool.query('SELECT status FROM image_sampling_items WHERE public_id=$1', [initialItem.id])).rows[0].status, 'PASSED');
      assert.equal(Number((await pool.query("SELECT count(*) FROM delivery_entries WHERE task_id=$1 AND status='READY'", [initial.taskId])).rows[0].count), 0);
      const edited = await addImageRun(initial.taskId, initial.copyRevisionId, 'restored-edit');
      await pool.query("UPDATE tasks SET current_image_run_id=$2, state='MANUAL_ARCHIVE', current_stage='MANUAL_ARCHIVE' WHERE id=$1", [initial.taskId, edited.imageRunId]);
      await submitImageSelfReview(pool, initial.taskId, { imageRunId: edited.imageRunId, reviewSessionId: randomUUID() }, worker);
      const recheck = (await listImageQaItems(pool, {}, admin)).items.find(item => item.taskId === initial.taskId);
      await passImageQaItem(pool, recheck.id, { requestId: randomUUID(), score: 3 }, admin);
      assert.equal((await repository.getTask(initial.taskId)).state, 'REVIEWED');

      const copy = await createTask(61);
      await pool.query("UPDATE tasks SET state='COPY_REVIEW_PENDING', current_stage='COPY_REVIEW_PENDING', current_image_run_id=NULL WHERE id=$1", [copy.taskId]);
      await repository.cancelTask(copy.taskId, { actor: admin });
      const restoredCopy = await restore(copy);
      assert.equal(restoredCopy.state, 'COPY_REVIEW_PENDING');
      assert.notEqual(restoredCopy.currentCopyRevisionId, copy.copyRevisionId);
      assert.equal(restoredCopy.mandatoryCopyQcOrigin, 'DISCARD_RESTORE');
      assert.ok((await pool.query('SELECT approved_at FROM copy_revisions WHERE id=$1', [copy.copyRevisionId])).rows[0].approved_at);
      const approved = await repository.approveCopy(copy.taskId, { revisionId: restoredCopy.currentCopyRevisionId,
        nodeId: 'image-qa-test', decision: 'APPROVE', score: 3, reviewSessionId: randomUUID() }, { actor: admin });
      assert.equal(approved.state, 'COPY_QC_PENDING');
      const copyItem = (await pool.query("SELECT public_id FROM copy_sampling_items WHERE task_id=$1 AND status='PENDING'", [copy.taskId])).rows[0];
      await passCopyQaItem(pool, copyItem.public_id, { requestId: randomUUID(), expectedCopyRevisionId: approved.currentCopyRevisionId }, admin);
      assert.equal((await repository.getTask(copy.taskId)).state, 'IMAGE_QUEUED');
      assert.equal((await pool.query('SELECT copy_quality_image_eligible(id,current_copy_revision_id,mandatory_copy_qc) AS eligible FROM tasks WHERE id=$1', [copy.taskId])).rows[0].eligible, true);
      assert.equal(Number((await pool.query('SELECT count(*) FROM task_restore_events WHERE task_id=$1', [initial.taskId])).rows[0].count), 2);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.context.disposeControlPlaneResources();
  }
});

function hashFor(value) {
  return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
}
