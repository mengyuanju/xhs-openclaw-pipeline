import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createReadyDeliveryEntry } from '../src/final-delivery.mjs';
import {
  deleteDeliveredCopyReviewDrafts,
  drainDeliveredCopyReviewDrafts,
} from '../src/delivery-draft-cleanup.mjs';

function draftContent(title = 'Synthetic review draft') {
  return {
    version: 1,
    draft: {
      copy: { title, body: 'Synthetic body', tags: [] },
      imagePlan: ['hero', 'steps', 'summary'].map(kind => ({
        kind, headline: 'Synthetic page', subtitle: '', bullets: [], prompt: 'Synthetic prompt',
      })),
    },
    aiDisclosureEnabled: false,
    copyOriginalScore: null,
    copyOriginalReasons: [],
    copyOriginalNote: '',
  };
}

test('real PostgreSQL delivered draft cleanup is atomic, bounded and preserves recovery data', {
  skip: process.env.RUN_SCALING_POSTGRES !== '1',
  timeout: 120_000,
}, async (t) => {
  // This test always creates its own cluster. No supplied application DB URL is accepted.
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  const pool = repository.pool;
  try {
    await repository.initialize();
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('draft-cleanup-test','Synthetic draft executor')");
    const reviewer = (await pool.query(`
      INSERT INTO app_users(username,display_name,role,password_hash,copy_review_enabled,must_change_password)
      VALUES ('draft-cleanup-reviewer','Synthetic reviewer','USER','test-only-not-a-credential',true,false)
      RETURNING *
    `)).rows[0];
    const secondReviewer = (await pool.query(`
      INSERT INTO app_users(username,display_name,role,password_hash,copy_review_enabled,must_change_password)
      VALUES ('draft-cleanup-reviewer-two','Synthetic second reviewer','USER','test-only-not-a-credential',true,false)
      RETURNING *
    `)).rows[0];
    const actor = {
      userId: Number(reviewer.id), username: reviewer.username,
      role: reviewer.role, credentialVersion: Number(reviewer.credential_version),
    };

    async function fixture({ state = 'REVIEWED', input = {}, legacyAccepted = true, drafts = 2 } = {}) {
      const taskId = Number((await pool.query(`
        INSERT INTO tasks(query,state,input,created_by_node_id,copy_executor_node_id,
          assigned_to_user_id,assignment_source,assigned_at,image_qc_legacy_accepted)
        VALUES ($1,$2,$3,'draft-cleanup-test','draft-cleanup-test',$4,'MANUAL',now(),$5) RETURNING id
      `, [`Synthetic draft cleanup ${randomUUID()}`, state, input, reviewer.username, legacyAccepted])).rows[0].id);
      const executionId = randomUUID();
      await pool.query(`
        INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot,finished_at)
        VALUES ($1,$2,'COPY','draft-cleanup-test','SUCCEEDED','TEXT_GENERATION',$3,now())
      `, [executionId, taskId, { prompt: 'Synthetic retry prompt', knowledge: ['Synthetic recovery knowledge'] }]);
      const revisionId = Number((await pool.query(`
        INSERT INTO copy_revisions(task_id,execution_id,revision,content,approved_at)
        VALUES ($1,$2,1,$3,now()) RETURNING id
      `, [taskId, executionId, {
        copy: { title: 'Approved delivery title', body: 'Approved delivery body', tags: [] },
        imagePlan: draftContent().draft.imagePlan,
      }])).rows[0].id);
      const oldRevisionId = Number((await pool.query(`
        INSERT INTO copy_revisions(task_id,revision,content,approved_at,parent_revision_id,revision_origin)
        VALUES ($1,2,'{"copy":{"title":"Historical approved title","body":"Historical body","tags":[]}}',now(),$2,'COPY_EDIT')
        RETURNING id
      `, [taskId, revisionId])).rows[0].id);
      const runId = randomUUID();
      await pool.query(`
        INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,finished_at,image_production_chain_id)
        VALUES ($1,$2,$3,'COMPLETED','{}',now(),$1)
      `, [runId, taskId, revisionId]);
      const assetId = Number((await pool.query(`
        INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,
          original_name,image_production_chain_id,artifact_key,origin_image_run_id,asset_role)
        VALUES ($1,$2,'image/png',4,$3,$4,'synthetic.png',$2,'synthetic-delivery',$2,'DELIVERY')
        RETURNING id
      `, [taskId, runId, 'a'.repeat(64), `synthetic-only-${taskId}-${randomUUID()}.png`])).rows[0].id);
      await pool.query('UPDATE image_runs SET result=$2 WHERE id=$1', [runId, {
        images: [{ assetId, deliveryAssetId: assetId, pageIndex: 1 }],
      }]);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1', [taskId, revisionId, runId]);
      // Updating either current version intentionally invalidates the old quality release.
      await pool.query('UPDATE tasks SET image_qc_legacy_accepted=$2 WHERE id=$1', [taskId, legacyAccepted]);
      const entry = { taskId, revisionId, oldRevisionId, runId, executionId, assetId };
      await addDrafts(entry, drafts);
      return entry;
    }

    async function addDrafts(entry, count, { revisionId = entry.revisionId, account = reviewer } = {}) {
      if (!count) return;
      await pool.query(`
        INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,
          reviewer_username,draft_version,content)
        SELECT $1,$2,$3,$4,series,$5 FROM generate_series(1,$6::integer) series
      `, [entry.taskId, revisionId, account.id, account.username, draftContent(), count]);
    }

    async function countDrafts(entry) {
      return Number((await pool.query('SELECT count(*) FROM copy_review_drafts WHERE task_id=$1', [entry.taskId])).rows[0].count);
    }

    async function deliver(entry, { rollback = false } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [entry.taskId]);
        await client.query("UPDATE tasks SET state='REVIEWED' WHERE id=$1", [entry.taskId]);
        const result = await createReadyDeliveryEntry(client, {
          taskId: entry.taskId, copyRevisionId: entry.revisionId, imageRunId: entry.runId, actor,
        });
        await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    async function historicalDelivery(entry, { status = 'READY', revisionId = entry.revisionId, imageRunId = entry.runId } = {}) {
      return (await pool.query(`
        INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,status,approved_by_username)
        VALUES ($1,$2,$3,$4,'synthetic-history') RETURNING *
      `, [entry.taskId, revisionId, imageRunId, status])).rows[0];
    }

    async function recoveryData(entry) {
      const result = await pool.query(`
        SELECT
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM copy_revisions r WHERE task_id=$1) AS revisions,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM task_executions e WHERE task_id=$1) AS executions,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM image_runs r WHERE task_id=$1) AS image_runs,
          (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM assets a WHERE task_id=$1) AS assets,
          (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM image_approval_events a WHERE task_id=$1) AS approvals,
          (SELECT jsonb_agg(to_jsonb(b) ORDER BY task_id) FROM task_initial_baselines b WHERE task_id=$1) AS baselines
      `, [entry.taskId]);
      return result.rows[0];
    }

    await t.test('READY creation deletes all reviewers and versions while approved/recovery data stays unchanged', async () => {
      const entry = await fixture({ drafts: 3 });
      await addDrafts(entry, 2, { revisionId: entry.oldRevisionId });
      await addDrafts(entry, 2, { account: secondReviewer });
      const before = await recoveryData(entry);
      assert.equal(await countDrafts(entry), 7);
      const ready = await deliver(entry);
      assert.equal(ready.status, 'READY');
      assert.equal(await countDrafts(entry), 0);
      assert.deepEqual(await recoveryData(entry), before);
      assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_entries WHERE task_id=$1 AND status=\'READY\'', [entry.taskId])).rows[0].count), 1);
      assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_model_call_cleanup WHERE delivery_entry_id=$1', [ready.id])).rows[0].count), 1);
    });

    await t.test('a current approval release enables delivery and historical cleanup without removing quality history', async () => {
      async function release(entry, revisionId = entry.revisionId) {
        const approvalId = Number((await pool.query(`
          INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,submitted_by_account_id,
            submitted_by_username,review_session_id,image_set_sha256,manual_modification_note)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'Synthetic immutable QA note') RETURNING id
        `, [entry.taskId, revisionId, entry.runId, actor.userId, actor.username, randomUUID(), 'c'.repeat(64)])).rows[0].id);
        await pool.query('UPDATE tasks SET image_qc_released_approval_event_id=$2 WHERE id=$1', [entry.taskId, approvalId]);
      }
      const current = await fixture({ legacyAccepted: false });
      await release(current);
      const currentBefore = await recoveryData(current);
      assert.equal((await deliver(current)).status, 'READY');
      assert.equal(await countDrafts(current), 0);
      assert.deepEqual(await recoveryData(current), currentBefore);
      const historical = await fixture({ legacyAccepted: false });
      await release(historical);
      await historicalDelivery(historical);
      const stale = await fixture({ legacyAccepted: false });
      await release(stale, stale.oldRevisionId);
      await historicalDelivery(stale);
      const historicalBefore = await recoveryData(historical);
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool), { processed: 1, deleted: 2 });
      assert.deepEqual(await recoveryData(historical), historicalBefore);
      assert.equal(await countDrafts(stale), 2, 'release from a different copy version cannot authorize cleanup');
    });

    await t.test('rolled-back, unreleased, unarchivable, pending-edit and test deliveries keep drafts', async () => {
      const rollback = await fixture();
      await deliver(rollback, { rollback: true });
      assert.equal(await countDrafts(rollback), 2);
      assert.equal(Number((await pool.query('SELECT count(*) FROM delivery_entries WHERE task_id=$1', [rollback.taskId])).rows[0].count), 0);
      const blocked = await fixture({ legacyAccepted: false });
      await assert.rejects(deliver(blocked), { code: 'IMAGE_QA_NOT_RELEASED' });
      assert.equal(await countDrafts(blocked), 2);
      const missing = await fixture();
      await pool.query("UPDATE image_runs SET result='{}' WHERE id=$1", [missing.runId]);
      await assert.rejects(deliver(missing), { code: 'DELIVERY_SOURCE_NOT_ARCHIVABLE' });
      assert.equal(await countDrafts(missing), 2);
      const editing = await fixture();
      await pool.query(`
        INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,
          copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','DRAFT',$8)
      `, [randomUUID(), editing.taskId, randomUUID(), editing.runId, editing.assetId, editing.revisionId, 'a'.repeat(64), actor.username]);
      await assert.rejects(deliver(editing), { code: 'IMAGE_EDITS_PENDING' });
      assert.equal(await countDrafts(editing), 2);
      const testTask = await fixture({ input: { testRun: true } });
      assert.equal(await deliver(testTask), null);
      assert.equal(await countDrafts(testTask), 2);
    });

    await t.test('historical cleanup respects exact current READY version and protects later rework', async () => {
      const eligible = await fixture({ drafts: 5 });
      await historicalDelivery(eligible);
      const rework = await fixture({ state: 'COPY_REVIEW_PENDING' });
      await historicalDelivery(rework);
      const withdrawn = await fixture();
      await historicalDelivery(withdrawn, { status: 'WITHDRAWN' });
      const oldRevision = await fixture();
      await historicalDelivery(oldRevision, { revisionId: oldRevision.oldRevisionId });
      const oldImage = await fixture();
      const previousRunId = randomUUID();
      await pool.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
        VALUES ($1,$2,$3,'COMPLETED',$1)`, [previousRunId, oldImage.taskId, oldImage.revisionId]);
      await historicalDelivery(oldImage, { imageRunId: previousRunId });
      const testTask = await fixture({ input: { testRun: true } });
      await historicalDelivery(testTask);
      const unreleased = await fixture({ legacyAccepted: false });
      await historicalDelivery(unreleased);
      const noDelivery = await fixture();
      const standalone = await fixture({ state: 'MANUAL_ARCHIVE' });
      await pool.query("UPDATE tasks SET task_kind='STANDALONE_IMAGE_EDIT' WHERE id=$1", [standalone.taskId]);
      await historicalDelivery(standalone);
      const before = await recoveryData(eligible);
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool, { limit: 1, batchSize: 2 }), { processed: 1, deleted: 2 });
      assert.equal(await countDrafts(eligible), 3);
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool, { limit: 1, batchSize: 2 }), { processed: 1, deleted: 2 });
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool, { limit: 1, batchSize: 2 }), { processed: 1, deleted: 1 });
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool), { processed: 0, deleted: 0 });
      assert.deepEqual(await recoveryData(eligible), before);
      for (const protectedEntry of [rework, withdrawn, oldRevision, oldImage, testTask, unreleased, noDelivery, standalone]) {
        assert.equal(await countDrafts(protectedEntry), 2, `protected task ${protectedEntry.taskId}`);
      }
      await pool.query("UPDATE tasks SET state='COPY_REVIEW_PENDING',current_copy_revision_id=$2 WHERE id=$1", [eligible.taskId, eligible.oldRevisionId]);
      const saved = await repository.saveCopyReviewDraft(eligible.taskId, {
        baseCopyRevisionId: eligible.oldRevisionId, content: draftContent('New rework draft'),
      }, { actor });
      assert.equal(saved.created, true);
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool), { processed: 0, deleted: 0 });
      assert.equal(await countDrafts(eligible), 1, 'an old READY record cannot delete future rework drafts');
    });

    await t.test('locked tasks are skipped and partial historical deletion failures roll back', async () => {
      const locked = await fixture({ drafts: 4 });
      const unlocked = await fixture({ drafts: 4 });
      await historicalDelivery(locked);
      await historicalDelivery(unlocked);
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [locked.taskId]);
        const started = Date.now();
        assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool, { limit: 1, batchSize: 2 }), { processed: 1, deleted: 2 });
        assert.ok(Date.now() - started < 1500, 'the sweep skips a task held by a user transaction');
        assert.equal(await countDrafts(locked), 4);
        assert.equal(await countDrafts(unlocked), 2);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
      await pool.query(`CREATE FUNCTION synthetic_draft_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.draft_version=2 THEN RAISE EXCEPTION 'synthetic draft delete failure'; END IF; RETURN OLD; END $$;
        CREATE TRIGGER synthetic_draft_delete_failure BEFORE DELETE ON copy_review_drafts
        FOR EACH ROW EXECUTE FUNCTION synthetic_draft_delete_failure()`);
      try {
        await assert.rejects(drainDeliveredCopyReviewDrafts(pool, { limit: 1, batchSize: 3 }), /synthetic draft delete failure/);
        assert.equal(await countDrafts(locked), 4, 'all rows in the failing task transaction survive');
        assert.equal((await pool.query('SELECT 1 AS reusable')).rows[0].reusable, 1);
      } finally {
        await pool.query('DROP TRIGGER synthetic_draft_delete_failure ON copy_review_drafts; DROP FUNCTION synthetic_draft_delete_failure()');
      }
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool, { limit: 2, batchSize: 2 }), { processed: 2, deleted: 4 });
      assert.equal(await countDrafts(locked), 2);
      assert.equal(await countDrafts(unlocked), 0);
      assert.deepEqual(await drainDeliveredCopyReviewDrafts(pool), { processed: 1, deleted: 2 });
    });

    await t.test('the task lock serializes delivery with a live reviewer save', async () => {
      const entry = await fixture({ state: 'COPY_REVIEW_PENDING', drafts: 0 });
      await repository.saveCopyReviewDraft(entry.taskId, { baseCopyRevisionId: entry.revisionId, content: draftContent('Saved before delivery') }, { actor });
      const client = await pool.connect();
      const savePool = new pg.Pool({ connectionString: cluster.connectionString, max: 1 });
      const saveRepository = new PostgresControlPlaneRepository({ pool: savePool });
      let notifyTaskQuery;
      const taskQueryStarted = new Promise(resolve => { notifyTaskQuery = resolve; });
      const connect = savePool.connect.bind(savePool);
      savePool.connect = async () => {
        const connection = await connect();
        const query = connection.query.bind(connection);
        connection.query = async (sql, ...args) => {
          if (String(sql).includes('SELECT * FROM tasks WHERE id = $1 FOR UPDATE')) notifyTaskQuery();
          return query(sql, ...args);
        };
        return connection;
      };
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [entry.taskId]);
        const saving = saveRepository.saveCopyReviewDraft(entry.taskId, {
          baseCopyRevisionId: entry.revisionId,
          expectedLatestDraftId: Number((await client.query('SELECT id FROM copy_review_drafts WHERE task_id=$1', [entry.taskId])).rows[0].id),
          content: draftContent('Stale save waiting on delivery'),
        }, { actor });
        const rejectedSave = assert.rejects(saving, { code: 'INVALID_TASK_STATE' });
        await taskQueryStarted;
        await client.query("UPDATE tasks SET state='REVIEWED' WHERE id=$1", [entry.taskId]);
        await createReadyDeliveryEntry(client, { taskId: entry.taskId, copyRevisionId: entry.revisionId, imageRunId: entry.runId, actor });
        await client.query('COMMIT');
        await rejectedSave;
        assert.equal(await countDrafts(entry), 0);
        assert.deepEqual(await repository.listCopyReviewDrafts(entry.taskId, { actor }), { baseCopyRevisionId: entry.revisionId, drafts: [] });
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await savePool.end();
      }
    });

    await t.test('direct cleanup participates in its caller transaction and is idempotent', async () => {
      const entry = await fixture();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        assert.equal(await deleteDeliveredCopyReviewDrafts(client, entry.taskId), 2);
        assert.equal(await deleteDeliveredCopyReviewDrafts(client, entry.taskId), 0);
        await client.query('ROLLBACK');
        assert.equal(await countDrafts(entry), 2);
      } finally { client.release(); }
    });

    await t.test('removing the duplicate batch index preserves the ordinal unique constraint and manifest ordering', async () => {
      assert.equal((await pool.query("SELECT to_regclass('public.delivery_batch_items_batch_idx') AS index")).rows[0].index, null);
      assert.ok((await pool.query("SELECT to_regclass('public.delivery_batch_items_delivery_batch_id_ordinal_key') AS index")).rows[0].index);
      const entry = await fixture({ drafts: 0 });
      const batchId = Number((await pool.query(`
        INSERT INTO delivery_batches(public_id,code,scope,archive_file_name,archive_byte_size,archive_sha256,
          task_count,created_by_account_id,created_by_username)
        VALUES ($1,'JF-0123ABCD','ALL_READY','synthetic.zip',4,$2,1,$3,$4) RETURNING id
      `, [randomUUID(), 'b'.repeat(64), actor.userId, actor.username])).rows[0].id);
      await pool.query(`
        INSERT INTO delivery_batch_items(delivery_batch_id,ordinal,task_id,copy_revision_id,image_run_id,query_snapshot)
        VALUES ($1,1,$2,$3,$4,'Synthetic first manifest item')
      `, [batchId, entry.taskId, entry.revisionId, entry.runId]);
      await assert.rejects(pool.query(`
        INSERT INTO delivery_batch_items(delivery_batch_id,ordinal,task_id,copy_revision_id,image_run_id,query_snapshot)
        VALUES ($1,1,$2,$3,$4,'Synthetic duplicate ordinal')
      `, [batchId, entry.taskId + 1, entry.oldRevisionId, randomUUID()]), { code: '23505', constraint: 'delivery_batch_items_delivery_batch_id_ordinal_key' });
      assert.deepEqual((await pool.query('SELECT ordinal,query_snapshot FROM delivery_batch_items WHERE delivery_batch_id=$1 ORDER BY ordinal', [batchId])).rows,
        [{ ordinal: 1, query_snapshot: 'Synthetic first manifest item' }]);
    });

    await t.test('the index migration refuses a changed local index and is safe when already applied', async () => {
      const sql = await readFile(new URL('../migrations/0113_remove_redundant_delivery_batch_index.sql', import.meta.url), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('CREATE INDEX delivery_batch_items_batch_idx ON delivery_batch_items(ordinal,delivery_batch_id)');
        await client.query('BEGIN');
        await assert.rejects(client.query(sql), /no equivalent unique constraint index/);
        await client.query('ROLLBACK');
        assert.ok((await client.query("SELECT to_regclass('public.delivery_batch_items_batch_idx') AS index")).rows[0].index);
        await client.query('DROP INDEX delivery_batch_items_batch_idx');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        await client.query('CREATE INDEX delivery_batch_items_batch_idx ON delivery_batch_items(delivery_batch_id,ordinal)');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        assert.equal((await client.query("SELECT to_regclass('public.delivery_batch_items_batch_idx') AS index")).rows[0].index, null);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    await t.test('a bounded protected page yields without scanning more tasks and the next pass continues', async () => {
      const existingProtectedTasks = Number((await pool.query('SELECT count(DISTINCT task_id) FROM copy_review_drafts')).rows[0].count);
      assert.ok(existingProtectedTasks < 100, 'the fixture leaves fewer than one old protected page');
      await pool.query(`
        WITH protected_tasks AS (
          INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id)
          SELECT 'Synthetic protected page ' || series,'COPY_REVIEW_PENDING','draft-cleanup-test','draft-cleanup-test'
          FROM generate_series(1,100) series RETURNING id
        ), protected_revisions AS (
          INSERT INTO copy_revisions(task_id,revision,content)
          SELECT id,1,'{"copy":{"title":"Synthetic protected copy","body":"Protected body","tags":[]}}'::jsonb
          FROM protected_tasks RETURNING id,task_id
        )
        INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,
          reviewer_username,draft_version,content)
        SELECT task_id,id,$1,$2,1,$3 FROM protected_revisions
      `, [actor.userId, actor.username, draftContent('Keep this current review draft')]);
      const eligible = await fixture({ drafts: 1 });
      await historicalDelivery(eligible);
      const beforeTotal = Number((await pool.query('SELECT count(*) FROM copy_review_drafts')).rows[0].count);
      const boundedPool = new pg.Pool({ connectionString: cluster.connectionString, max: 1 });
      const connect = boundedPool.connect.bind(boundedPool);
      const wrappedClients = new WeakSet();
      const observed = { pages: [], checkedTaskCounts: [] };
      boundedPool.connect = async () => {
        const connection = await connect();
        if (!wrappedClients.has(connection)) {
          wrappedClients.add(connection);
          const query = connection.query.bind(connection);
          connection.query = async (sql, ...args) => {
            const result = await query(sql, ...args);
            if (String(sql).includes('SELECT DISTINCT task_id FROM copy_review_drafts')) {
              observed.pages.push(result.rows.length);
            }
            if (String(sql).includes('SELECT task.id FROM tasks task')) {
              observed.checkedTaskCounts.push(args[0][0].length);
            }
            return result;
          };
        }
        return connection;
      };
      try {
        assert.deepEqual(await drainDeliveredCopyReviewDrafts(boundedPool, { limit: 1 }), { processed: 0, deleted: 0 });
        assert.deepEqual(observed.pages, [100], 'one pass examines only a single bounded draft page');
        assert.deepEqual(observed.checkedTaskCounts, [100], 'eligibility checks never expand to all tasks');
        assert.equal(await countDrafts(eligible), 1);
        assert.equal(Number((await pool.query('SELECT count(*) FROM copy_review_drafts')).rows[0].count), beforeTotal);
        observed.pages.length = 0;
        observed.checkedTaskCounts.length = 0;
        assert.deepEqual(await drainDeliveredCopyReviewDrafts(boundedPool, { limit: 1 }), { processed: 1, deleted: 1 });
        assert.deepEqual(observed.pages, [existingProtectedTasks + 1], 'the next pass resumes beyond the protected page');
        assert.deepEqual(observed.checkedTaskCounts, [existingProtectedTasks + 1]);
        assert.equal(await countDrafts(eligible), 0);
        assert.equal(Number((await pool.query('SELECT count(*) FROM copy_review_drafts')).rows[0].count), beforeTotal - 1);
        assert.deepEqual(await drainDeliveredCopyReviewDrafts(boundedPool, { limit: 1 }), { processed: 0, deleted: 0 });
      } finally {
        await boundedPool.end();
      }
    });
  } finally {
    await pool.end();
    await cluster.stop();
  }
});
