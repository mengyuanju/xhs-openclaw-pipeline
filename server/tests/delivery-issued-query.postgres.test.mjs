import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import JSZip from 'jszip';

import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { buildBatchTaskArchive, buildTaskArchive } from '../src/task-archive.mjs';
import { createDeliveryArchiveService } from '../src/delivery-archives.mjs';

test('PostgreSQL delivery archives read each issued Query by source item and preserve legacy fallback', {
  skip: process.env.RUN_POSTGRES_E2E !== '1',
  timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-delivery-query-pg-'));
  let service;
  try {
    await repository.initialize();
    const pool = repository.pool;
    const batch = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('archive-query-test', 'Archive Query Test')");
    const packageId = (await pool.query(
      "INSERT INTO query_packages(name, client_batch_code, created_by_username, created_by_account_id) SELECT $1, $2, username, id FROM app_users WHERE username = 'admin' RETURNING id",
      ['TXT Query source test', batch],
    )).rows[0].id;
    const cases = [
      { issued: '甲方问题 A\r\n第二行', expected: '甲方问题 A 第二行' },
      { issued: '甲方问题 B', expected: '甲方问题 B' },
      { issued: null, expected: '同一个生产 Query' },
      { issued: ' \t ', expected: '同一个生产 Query' },
      { noSource: true, expected: '同一个生产 Query' },
    ];
    const snapshots = [];
    for (const [index, scenario] of cases.entries()) {
      const sourceId = scenario.noSource ? null : (await pool.query(
        'INSERT INTO query_package_items(query_package_id, row_number, raw_query, query, issued_query) VALUES ($1, $2, $3::text, $3::varchar, $4) RETURNING id',
        [packageId, index + 1, '同一个生产 Query', scenario.issued],
      )).rows[0].id;
      const taskId = Number((await pool.query(
        "INSERT INTO tasks(query, input, state, created_by_node_id, copy_executor_node_id, source_query_package_id, source_query_package_item_id, source_client_batch_code) VALUES ($1, '{}', 'IMAGE_RUNNING', 'archive-query-test', 'archive-query-test', $2, $3, $4) RETURNING id",
        ['同一个生产 Query', scenario.noSource ? null : packageId, sourceId, batch],
      )).rows[0].id);
      const revisionId = (await pool.query(
        'INSERT INTO copy_revisions(task_id, revision, content) VALUES ($1, 1, $2) RETURNING id',
        [taskId, { copy: { title: '交付文案', body: '批准后的正文' } }],
      )).rows[0].id;
      const execution = randomUUID(), run = randomUUID();
      await pool.query(
        "INSERT INTO task_executions(id, task_id, kind, node_id, status, stage, snapshot) VALUES ($1, $2, 'IMAGE', 'archive-query-test', 'SUCCEEDED', 'DONE', '{}')", [execution, taskId],
      );
      await pool.query(
        "INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id, status, result, image_production_chain_id) VALUES ($1, $2, $3, $4, 'COMPLETED', '{}', $1)", [run, taskId, execution, revisionId],
      );
      const assetId = Number((await pool.query(
        "INSERT INTO assets(task_id, image_run_id, image_production_chain_id, origin_image_run_id, artifact_key, media_type, byte_size, sha256, storage_path) VALUES ($1, $2, $2, $2, 'test-image', 'image/png', 1, $3, $4) RETURNING id",
        [taskId, run, 'a'.repeat(64), 'synthetic-' + taskId + '.png'],
      )).rows[0].id);
      await pool.query('UPDATE image_runs SET result = $2 WHERE id = $1', [run, { images: [{ assetId }] }]);
      await pool.query(
        "UPDATE tasks SET current_copy_revision_id = $2, current_image_run_id = $3, state = 'REVIEWED', image_qc_legacy_accepted = true WHERE id = $1",
        [taskId, revisionId, run],
      );
      await pool.query(
        "INSERT INTO delivery_entries(task_id, copy_revision_id, image_run_id, status, approved_by_username) VALUES ($1, $2, $3, 'READY', 'reviewer')", [taskId, revisionId, run],
      );
      const snapshot = await repository.getTaskForDelivery(taskId);
      assert.ok(snapshot);
      assert.equal(snapshot.task.query, '同一个生产 Query');
      assert.equal(snapshot.task.issuedQuery, scenario.issued ?? null);
      assert.equal(snapshot.task.sourceClientBatchCode, batch);
      snapshots.push(snapshot.task);
      const detail = await repository.getTask(taskId);
      const zip = await JSZip.loadAsync(await buildTaskArchive(detail, async () => ({
        mediaType: 'image/png', originalName: '01.png', content: Buffer.from([1]),
      })));
      assert.equal((await zip.file('交付文案.txt').async('string')).split('\r\n')[0],
        '\uFEFF原始 Query：' + scenario.expected);
    }
    const batchZip = await JSZip.loadAsync(await buildBatchTaskArchive(snapshots, async () => ({
      mediaType: 'image/png', originalName: '01.png', content: Buffer.from([1]),
    })));
    for (const [index, task] of snapshots.entries()) {
      const text = await batchZip.file(batch + '/任务-' + task.id + '-资源包/交付文案.txt').async('string');
      assert.equal(text.split('\r\n')[0], '\uFEFF原始 Query：' + cases[index].expected);
      assert.ok(text.includes('文案内容：\r\n批准后的正文'));
    }

    // Re-download a batch generated by the old code, whose TXT still contains
    // the production Query. Resolve each issued Query via its stable source ID.
    const oldBytes=await buildBatchTaskArchive(snapshots.map(task=>({...task,issuedQuery:null})),async()=>({
      mediaType:'image/png',originalName:'01.png',content:Buffer.from([1]),
    }));
    const publicId=randomUUID(),sourcePath=join(storageRoot,'.delivery-batches',publicId+'.zip');
    await mkdir(join(storageRoot,'.delivery-batches'));
    await writeFile(sourcePath,oldBytes);
    const admin=(await pool.query("SELECT id,username FROM app_users WHERE username='admin'")).rows[0];
    const actor={userId:Number(admin.id),username:admin.username,role:'ADMIN'};
    const frozen=await repository.createDeliveryBatch({
      publicId,scope:'SELECTED',fileName:'old-batch.zip',byteSize:oldBytes.length,
      sha256:createHash('sha256').update(oldBytes).digest('hex'),
      bindings:snapshots.map(task=>({taskId:task.id,copyRevisionId:task.currentCopyRevisionId,imageRunId:task.currentImageRunId})),
    },{actor});
    const itemIds=(await pool.query('SELECT id FROM delivery_batch_items WHERE delivery_batch_id=$1 ORDER BY ordinal',[frozen.id])).rows.map(row=>Number(row.id));
    service=createDeliveryArchiveService({pool,storageRoot});
    async function terminal(id) {
      for(let attempt=0;attempt<200;attempt++) {
        const job=await service.get(id,actor);
        if(['FAILED','SUCCEEDED'].includes(job.status))return job;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      throw new Error('file generation did not finish');
    }
    async function verifyDownload(id) {
      const done=await terminal(id);assert.equal(done.status,'SUCCEEDED',done.error);
      const artifact=await service.download(id,1,actor);
      const result=await JSZip.loadAsync(await readFile(artifact.path));
      const original=await JSZip.loadAsync(oldBytes);
      const names=Object.values(result.files).filter(file=>!file.dir).map(file=>file.name).sort();
      assert.deepEqual(names,Object.values(original.files).filter(file=>!file.dir).map(file=>file.name).sort());
      assert.equal(result.file('manifest.json'),null);assert.equal(result.file('清单.xlsx'),null);
      for(const [index,task] of snapshots.entries()) {
        const path=batch+'/任务-'+task.id+'-资源包/交付文案.txt';
        const text=await result.file(path).async('string');
        const oldText=await original.file(path).async('string');
        assert.equal(text.split('\r\n')[0],'\uFEFF原始 Query：'+cases[index].expected);
        assert.equal(text.slice(text.indexOf('\r\n')),oldText.slice(oldText.indexOf('\r\n')));
      }
      await artifact.record();
      assert.deepEqual(await readFile(sourcePath),oldBytes);
    }
    const preview=await service.preview({kind:'DOWNLOAD',itemIds},actor);
    const created=await service.create({token:preview.token,requestId:randomUUID()},actor);
    await verifyDownload(created.id);
    const stored=(await pool.query('SELECT snapshot FROM delivery_archive_items WHERE job_id=$1 ORDER BY item_id',[created.id])).rows;
    assert.deepEqual(stored.map(row=>row.snapshot.issued_query),cases.map(scenario=>scenario.issued??null));

    // Jobs created before the fix may not have an issued_query snapshot. A retry
    // must also resolve the original source, while retaining frozen copy bytes.
    const retryPreview=await service.preview({kind:'DOWNLOAD',itemIds},actor);
    await writeFile(sourcePath,'corrupted');
    const interrupted=await service.create({token:retryPreview.token,requestId:randomUUID()},actor);
    assert.equal((await terminal(interrupted.id)).status,'FAILED');
    const legacyJob=Number((await pool.query(`INSERT INTO delivery_archive_jobs
      (request_id,actor_account_id,actor_username,kind,selection,item_count,actor_role,status,error)
      SELECT $2,actor_account_id,actor_username,kind,selection,item_count,actor_role,'FAILED','legacy interrupted job'
      FROM delivery_archive_jobs WHERE id=$1 RETURNING id`,[interrupted.id,randomUUID()])).rows[0].id);
    await pool.query(`INSERT INTO delivery_archive_items(job_id,item_id,snapshot)
      SELECT $2,item_id,snapshot-'issued_query' FROM delivery_archive_items WHERE job_id=$1`,[interrupted.id,legacyJob]);
    await writeFile(sourcePath,oldBytes);
    await service.retry(legacyJob,actor);
    await verifyDownload(legacyJob);
  } finally {
    await service?.dispose();
    await repository.close().catch(() => {});
    await database.stop();
    assert.ok(storageRoot.startsWith(join(tmpdir(), 'xhs-delivery-query-pg-')));
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
