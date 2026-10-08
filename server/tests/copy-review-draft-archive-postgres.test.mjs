import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  drainCopyReviewDraftArchive, hydrateCopyReviewDrafts, readCopyReviewDraftArchiveStats,
} from '../src/copy-review-draft-archive.mjs';
import { deleteDeliveredCopyReviewDrafts } from '../src/delivery-draft-cleanup.mjs';

function draftContent(title = 'Synthetic archive draft') {
  return {
    version: 1,
    draft: {
      copy: { title, body: 'Synthetic unchanged body'.repeat(15), tags: [] },
      imagePlan: ['hero', 'steps', 'summary'].map(kind => ({
        kind, headline: 'Synthetic page', subtitle: '', bullets: [], prompt: 'Synthetic prompt'.repeat(15),
      })),
      imageSettings: { version: 1, format: 'PNG', quality: 90, background: 'SOLID', backgroundColor: '#f2eee7' },
    },
    aiDisclosureEnabled: false, copyOriginalScore: null, copyOriginalReasons: [], copyOriginalNote: '',
  };
}

test('real PostgreSQL draft archives preserve current review, replay and recovery with bounded locking', {
  skip: process.env.RUN_SCALING_POSTGRES !== '1', timeout: 180_000,
}, async t => {
  // Always create a disposable PostgreSQL 18 cluster; never accept an app URL.
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  const pool = repository.pool;
  try {
    await repository.initialize();
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('archive-test','Synthetic archive node')");
    const reviewer = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,
      copy_review_enabled,must_change_password) VALUES ('archive-reviewer','Synthetic reviewer','USER',
      'synthetic-only-not-a-credential',true,false) RETURNING *`)).rows[0];
    const otherReviewer = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,
      copy_review_enabled,must_change_password) VALUES ('archive-reviewer-two','Synthetic second reviewer','ADMIN',
      'synthetic-only-not-a-credential',true,false) RETURNING *`)).rows[0];
    const actor = { userId: Number(reviewer.id), username: reviewer.username, role: reviewer.role,
      credentialVersion: Number(reviewer.credential_version) };
    const otherActor = { userId: Number(otherReviewer.id), username: otherReviewer.username, role: otherReviewer.role,
      credentialVersion: Number(otherReviewer.credential_version) };

    async function fixture({ state = 'COPY_REVIEW_PENDING', drafts = 1 } = {}) {
      const taskId = Number((await pool.query(`INSERT INTO tasks(query,state,input,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at) VALUES ($1,$2,'{}','archive-test',$3,'MANUAL',now())
        RETURNING id`, [`Synthetic archive task ${randomUUID()}`, state, reviewer.username])).rows[0].id);
      const revisions = [];
      for (let version = 1; version <= 2; version += 1) {
        revisions.push(Number((await pool.query(`INSERT INTO copy_revisions(task_id,revision,content)
          VALUES ($1,$2,$3) RETURNING id`, [taskId, version, draftContent().draft])).rows[0].id));
      }
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [taskId, revisions[1]]);
      const oldIds = (await pool.query(`INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,
        reviewer_account_id,reviewer_username,draft_version,content) SELECT $1,$2,$3,$4,series,$5
        FROM generate_series(1,$6::integer) series RETURNING id`,
      [taskId, revisions[0], reviewer.id, reviewer.username, draftContent(), drafts])).rows.map(row => row.id);
      const currentId = (await pool.query(`INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,
        reviewer_account_id,reviewer_username,draft_version,content) VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
      [taskId, revisions[1], reviewer.id, reviewer.username, draftContent('Current protected draft')])).rows[0].id;
      return { taskId, oldRevisionId: revisions[0], currentRevisionId: revisions[1], oldIds, currentId };
    }

    async function countArchived(entry) {
      return Number((await pool.query(`SELECT count(*) FROM copy_review_drafts WHERE task_id=$1
        AND content_archived_at IS NOT NULL`, [entry.taskId])).rows[0].count);
    }

    await t.test('archives old revisions and inactive bodies while protecting active current drafts', async () => {
      const active = await fixture({ drafts: 3 });
      const inactive = await fixture({ state: 'IMAGE_QUEUED', drafts: 2 });
      const result = await drainCopyReviewDraftArchive(pool, { batchSize: 2, maxBatches: 1 });
      assert.equal(result.processed, 2);
      assert.ok(result.logicalBytesSaved > 0);
      assert.equal(await countArchived(active), 2);
      for (let attempt = 0; attempt < 10; attempt += 1) await drainCopyReviewDraftArchive(pool);
      assert.equal(await countArchived(active), 3);
      assert.equal(await countArchived(inactive), 3);
      const protectedRow = (await pool.query('SELECT * FROM copy_review_drafts WHERE id=$1', [active.currentId])).rows[0];
      assert.equal(protectedRow.content_archived_at, null);
      assert.deepEqual(protectedRow.content, draftContent('Current protected draft'));
      const archiveRows = (await pool.query('SELECT * FROM copy_review_drafts WHERE task_id=$1 ORDER BY id', [inactive.taskId])).rows;
      assert.ok(archiveRows.every(row => Object.keys(row.content).length === 0));
      const hydrated = await hydrateCopyReviewDrafts(pool, archiveRows);
      assert.deepEqual(hydrated[0].content, draftContent());
      assert.equal((await drainCopyReviewDraftArchive(pool)).processed, 0);
      const stats = await readCopyReviewDraftArchiveStats(pool);
      assert.equal(stats.eligibleDrafts, 0);
      assert.equal(stats.archivedDrafts, 6);
      assert.equal(stats.protectedDrafts, 1);
      assert.ok(stats.archivedOriginalBytes > stats.archiveBytes);
    });

    await t.test('restoring archived revision keeps account scope, IDs and identical-save replay', async () => {
      const entry = await fixture();
      await drainCopyReviewDraftArchive(pool);
      assert.equal(await countArchived(entry), 1);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [entry.taskId, entry.oldRevisionId]);
      const listed = await repository.listCopyReviewDrafts(entry.taskId, { actor });
      assert.equal(listed.baseCopyRevisionId, entry.oldRevisionId);
      assert.equal(listed.drafts[0].id, Number(entry.oldIds[0]));
      assert.deepEqual(listed.drafts[0].content, draftContent());
      assert.deepEqual((await repository.listCopyReviewDrafts(entry.taskId, { actor: otherActor })).drafts, []);
      const replay = await repository.saveCopyReviewDraft(entry.taskId, {
        baseCopyRevisionId: entry.oldRevisionId, expectedLatestDraftId: null, content: draftContent(),
      }, { actor });
      assert.equal(replay.created, false);
      assert.equal(replay.draft.id, Number(entry.oldIds[0]));
      const saved = await repository.saveCopyReviewDraft(entry.taskId, {
        baseCopyRevisionId: entry.oldRevisionId, expectedLatestDraftId: Number(entry.oldIds[0]),
        content: draftContent('New recovered draft'),
      }, { actor });
      assert.equal(saved.draft.version, 2);
      await assert.rejects(repository.saveCopyReviewDraft(entry.taskId, {
        baseCopyRevisionId: entry.oldRevisionId, expectedLatestDraftId: Number(entry.oldIds[0]),
        content: draftContent('Stale tab modification'),
      }, { actor }), { code: 'COPY_REVIEW_DRAFT_CONFLICT' });
      await drainCopyReviewDraftArchive(pool);
      const fresh = (await pool.query('SELECT content_archived_at FROM copy_review_drafts WHERE id=$1', [saved.draft.id])).rows[0];
      assert.equal(fresh.content_archived_at, null, 'new drafts in the restored review remain hot');
    });

    await t.test('locked rework task is skipped and a concurrent restore protects its new current revision', async () => {
      const entry = await fixture({ state: 'IMAGE_QUEUED', drafts: 3 });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [entry.taskId]);
        const startedAt = Date.now();
        await drainCopyReviewDraftArchive(pool);
        assert.ok(Date.now() - startedAt < 1800, 'cleanup never waits behind a task edit lock');
        assert.equal(await countArchived(entry), 0);
        await client.query("UPDATE tasks SET state='COPY_REVIEW_PENDING',current_copy_revision_id=$2 WHERE id=$1",
          [entry.taskId, entry.oldRevisionId]);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
      await Promise.all(Array.from({ length: 30 }, () => drainCopyReviewDraftArchive(pool, { maxBatches: 1 })));
      const oldRows = (await pool.query('SELECT content_archived_at FROM copy_review_drafts WHERE id=ANY($1::bigint[])', [entry.oldIds])).rows;
      assert.ok(oldRows.every(row => row.content_archived_at == null), 'restored active drafts survive concurrent cleaners');
      assert.equal(await countArchived(entry), 1, 'only the now old current revision is archived');
    });

    await t.test('archive insertion failure rolls back hot content and delivery deletion cascades cold bodies', async () => {
      const entry = await fixture({ state: 'IMAGE_QUEUED' });
      await pool.query(`CREATE FUNCTION synthetic_archive_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic archive failure'; END $$`);
      await pool.query(`CREATE TRIGGER synthetic_archive_failure BEFORE INSERT ON copy_review_draft_payload_archives
        FOR EACH ROW EXECUTE FUNCTION synthetic_archive_failure()`);
      await assert.rejects(drainCopyReviewDraftArchive(pool), /synthetic archive failure/u);
      const intact = (await pool.query('SELECT content,content_archived_at FROM copy_review_drafts WHERE id=$1', [entry.oldIds[0]])).rows[0];
      assert.deepEqual(intact.content, draftContent());
      assert.equal(intact.content_archived_at, null);
      await pool.query('DROP TRIGGER synthetic_archive_failure ON copy_review_draft_payload_archives');
      await pool.query('DROP FUNCTION synthetic_archive_failure()');
      for (let attempt = 0; attempt < 5; attempt += 1) await drainCopyReviewDraftArchive(pool);
      assert.equal(await countArchived(entry), 2);
      const before = Number((await pool.query('SELECT count(*) FROM copy_review_draft_payload_archives')).rows[0].count);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [entry.taskId]);
        assert.equal(await deleteDeliveredCopyReviewDrafts(client, entry.taskId), 2);
        await client.query('ROLLBACK');
        assert.equal(await countArchived(entry), 2, 'delivery rollback also restores cold payloads');
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [entry.taskId]);
        await deleteDeliveredCopyReviewDrafts(client, entry.taskId);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
      assert.equal(Number((await pool.query('SELECT count(*) FROM copy_review_draft_payload_archives')).rows[0].count), before - 2);
    });

    await t.test('deleting draft owners cascades archives without touching approved revision content', async () => {
      const entry = await fixture({ state: 'IMAGE_QUEUED' });
      for (let attempt = 0; attempt < 5; attempt += 1) await drainCopyReviewDraftArchive(pool);
      const revisionBefore = (await pool.query('SELECT content FROM copy_revisions WHERE id=$1', [entry.oldRevisionId])).rows[0].content;
      await pool.query('DELETE FROM copy_review_drafts WHERE task_id=$1', [entry.taskId]);
      assert.equal(Number((await pool.query('SELECT count(*) FROM copy_review_draft_payload_archives WHERE draft_id=ANY($1::bigint[])', [entry.oldIds])).rows[0].count), 0);
      assert.deepEqual((await pool.query('SELECT content FROM copy_revisions WHERE id=$1', [entry.oldRevisionId])).rows[0].content, revisionBefore);
    });

    await t.test('a million active draft rows retain bounded candidate scans', async () => {
      const entry = await fixture();
      await pool.query('DELETE FROM copy_review_drafts WHERE task_id=$1', [entry.taskId]);
      const fixtureClient = await pool.connect();
      try {
        await fixtureClient.query('BEGIN');
        // Building a million-row fixture includes three million FK checks.
        // This setup budget does not change the cleanup worker's 2s timeout.
        await fixtureClient.query("SET LOCAL statement_timeout='90s'");
        await fixtureClient.query(`INSERT INTO copy_review_drafts(task_id,base_copy_revision_id,reviewer_account_id,
          reviewer_username,draft_version,content) SELECT $1,$2,$3,$4,series,'{}'::jsonb
          FROM generate_series(1,1000000) series`,
        [entry.taskId, entry.currentRevisionId, reviewer.id, reviewer.username]);
        await fixtureClient.query('COMMIT');
      } finally { await fixtureClient.query('ROLLBACK').catch(() => {}); fixtureClient.release(); }
      await pool.query('ANALYZE copy_review_drafts');
      let candidateRows = 0;
      const pagePlans = [];
      const boundedPool = { async connect() {
        const client = await pool.connect();
        return { release: () => client.release(), async query(sql, values) {
          if (String(sql).startsWith('SELECT id,task_id FROM copy_review_drafts')) {
            const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
            pagePlans.push(plan);
            const result = await client.query(sql, values);
            candidateRows += result.rows.length;
            return result;
          }
          return client.query(sql, values);
        } };
      } };
      const startedAt = Date.now();
      assert.equal((await drainCopyReviewDraftArchive(boundedPool, { timeBudgetMs: 5000 })).processed, 0);
      assert.ok(candidateRows > 0 && candidateRows <= 1000);
      const relations = [];
      function inspect(node) {
        if (node['Relation Name']) relations.push({ type: node['Node Type'], relation: node['Relation Name'],
          index: node['Index Name'], rows: node['Actual Rows'], removed: node['Rows Removed by Filter'] ?? 0 });
        for (const child of node.Plans ?? []) inspect(child);
      }
      for (const plan of pagePlans) inspect(plan.Plan);
      assert.ok(relations.every(node => node.type === 'Index Scan'
        && node.index === 'copy_review_drafts_pending_archive_idx' && node.rows <= 100));
      t.diagnostic(JSON.stringify({ syntheticActiveDrafts: 1000000, elapsedMs: Date.now() - startedAt,
        candidateRows, pageCount: pagePlans.length,
        candidateSqlMs: pagePlans.reduce((sum, plan) => sum + plan['Execution Time'], 0), relations }));
      assert.equal(Number((await pool.query('SELECT count(*) FROM copy_review_drafts WHERE task_id=$1', [entry.taskId])).rows[0].count), 1000000);
      await pool.query('DELETE FROM copy_review_drafts WHERE task_id=$1', [entry.taskId]);
    });
  } finally {
    await repository.close();
    await cluster.stop();
  }
});
