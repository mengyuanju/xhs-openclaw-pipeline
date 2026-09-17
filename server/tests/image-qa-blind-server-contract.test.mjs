import assert from 'node:assert/strict';
import test from 'node:test';

import { imageQaItemFrom, listImageQaItems } from '../src/image-quality-control.mjs';

function databaseRow() {
  return {
    public_id: '71717171-7171-4717-8717-717171717171',
    freeze_public_id: '81818181-8181-4818-8818-818181818181',
    status: 'PENDING',
    sample_kind: 'RANDOM',
    blind_review_enabled: true,
    selected: true,
    task_id: 991,
    query: '玄关收纳',
    production_batch_id: 27,
    query_package_name: '九月选题',
    submitter_account_id: 64,
    submitter_username: 'worker',
    assigned_review_account_id: 91,
    image_run_id: 'image-run-1',
    copy_revision_id: 902,
    priority_paused: false,
    image_reviewer_batch_return_enabled: true,
    pending_image_edit_count: 0,
    assets: [{ id: 12, media_type: 'image/png', sha256: 'a'.repeat(64), original_name: '01.png', page_index: 1 }],
  };
}

test('image QA server ignores blind redaction for administrators only', () => {
  const row = databaseRow();
  const admin = imageQaItemFrom(row, { userId: 1, username: 'admin', role: 'ADMIN' });
  const reviewer = imageQaItemFrom(row, { userId: 91, username: 'reviewer', role: 'REVIEWER' });

  assert.equal(admin.blindReview, false);
  assert.equal(admin.taskId, 991);
  assert.equal(admin.query, '玄关收纳');
  assert.equal(admin.productionBatch.queryPackageName, '九月选题');
  assert.equal(admin.submitter.username, 'worker');

  assert.equal(reviewer.blindReview, true);
  for (const key of ['taskId', 'query', 'productionBatch', 'submitter', 'imageRunId', 'copyRevisionId']) {
    assert.equal(Object.hasOwn(reviewer, key), false, key);
  }
});

test('administrator can act on their own submitted image while reviewers still cannot', () => {
  const row = { ...databaseRow(), submitter_account_id: 1, assigned_review_account_id: 1 };
  const admin = imageQaItemFrom(row, { userId: 1, username: 'admin', role: 'ADMIN' });
  const reviewer = imageQaItemFrom({ ...row, submitter_account_id: 91, assigned_review_account_id: 91 }, {
    userId: 91, username: 'reviewer', role: 'REVIEWER',
  });

  assert.equal(admin.capabilities.canPass, true);
  assert.equal(admin.capabilities.canReturnSingle, true);
  assert.equal(reviewer.capabilities.canPass, false);
  assert.equal(reviewer.capabilities.canReturnSingle, false);
});

function imageListPool(actor) {
  let listCall = null;
  const client = {
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT id, username, role FROM app_users')) {
        return { rows: [{ id: actor.userId, username: actor.username, role: actor.role }] };
      }
      throw new Error(`unexpected client SQL: ${source}`);
    },
    release() {},
  };
  return {
    get listCall() { return listCall; },
    pool: {
      connect: async () => client,
      query: async (sql, values = []) => {
        const source = String(sql).replace(/\s+/gu, ' ').trim();
        if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1') return { rows: [] };
        listCall = { sql: source, values };
        return { rows: [databaseRow()] };
      },
    },
  };
}

test('administrator image QA list filters by submitter display name or account name', async () => {
  const admin = { userId: 1, username: 'admin', role: 'ADMIN' };
  const fixture = imageListPool(admin);

  const result = await listImageQaItems(fixture.pool, { personName: '  图片   作业员  ' }, admin);

  assert.equal(result.items.length, 1);
  assert.deepEqual(fixture.listCall.values.slice(0, 5), [1, 'PENDING', 50, 0, '图片 作业员']);
  assert.match(fixture.listCall.sql,
    /strpos\(lower\(item\.submitter_username\), lower\(\$5\)\)[\s\S]*person_filter\.display_name/u);
  assert.match(fixture.listCall.sql, /edit\.status = ANY\(\$6::text\[\]\)/u);
});

test('reviewers cannot request the administrator personnel filter for image QA', async () => {
  const reviewer = { userId: 91, username: 'reviewer', role: 'REVIEWER' };
  const fixture = imageListPool(reviewer);

  await assert.rejects(
    listImageQaItems(fixture.pool, { personName: '图片作业员' }, reviewer),
    (error) => error?.code === 'FORBIDDEN',
  );
  assert.equal(fixture.listCall, null);
});
