import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const actor = {
  userId: 7,
  username: 'reviewer',
  role: 'REVIEWER',
  credentialVersion: 1,
};

const content = (title = '尚未完成的草稿') => ({
  version: 1,
  draft: {
    copy: { title, body: '正在修改', tags: ['#草稿'] },
    imagePlan: [
      { kind: 'hero', headline: '封面', subtitle: '', bullets: ['一', '二'], prompt: '封面画面描述' },
      { kind: 'steps', headline: '步骤', subtitle: '', bullets: ['一', '二'], prompt: '步骤画面描述' },
      { kind: 'summary', headline: '总结', subtitle: '', bullets: ['一', '二'], prompt: '总结画面描述' },
    ],
    imageSettings: {
      version: 1,
      format: 'PNG',
      quality: 90,
      background: 'SOLID',
      backgroundColor: '#f2eee7',
    },
  },
  aiDisclosureEnabled: false,
  copyOriginalScore: 2,
  copyOriginalReasons: ['STRUCTURE'],
  copyOriginalNote: '继续修改中',
});

function fixture({ state = 'COPY_REVIEW_PENDING', revisionId = 12 } = {}) {
  const drafts = [];
  let nextId = 1;
  const task = {
    id: 41,
    state,
    assigned_to_user_id: actor.username,
    current_copy_revision_id: revisionId,
  };
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(source)) return { rows: [] };
      if (source.includes('FROM app_users')) return { rows: [{
        id: actor.userId,
        username: actor.username,
        role: actor.role,
        status: 'ACTIVE',
        credential_version: actor.credentialVersion,
        copy_review_enabled: true,
      }] };
      if (source.includes('SELECT * FROM tasks WHERE id')) return { rows: [{ ...task }] };
      if (source.includes('FROM copy_review_drafts')) {
        const selected = drafts
          .filter(row => row.task_id === Number(values[0])
            && row.base_copy_revision_id === Number(values[1])
            && row.reviewer_account_id === Number(values[2]))
          .toSorted((left, right) => right.id - left.id);
        return { rows: source.includes('LIMIT 1') ? selected.slice(0, 1) : selected.slice(0, 20) };
      }
      if (source.includes('INSERT INTO copy_review_drafts')) {
        const row = {
          id: nextId++,
          task_id: Number(values[0]),
          base_copy_revision_id: Number(values[1]),
          reviewer_account_id: Number(values[2]),
          reviewer_username: values[3],
          draft_version: Number(values[4]),
          content: structuredClone(values[5]),
          created_at: new Date(`2026-09-16T00:00:0${drafts.length}.000Z`).toISOString(),
        };
        drafts.push(row);
        return { rows: [row] };
      }
      throw new Error(`Unexpected SQL: ${source}`);
    },
  };
  return {
    drafts,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
  };
}

test('copy review drafts keep immutable account-scoped history and reject stale tabs', async () => {
  const { repository, drafts } = fixture();
  assert.deepEqual(await repository.listCopyReviewDrafts(41, { actor }), {
    baseCopyRevisionId: 12,
    drafts: [],
  });

  const first = await repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    expectedLatestDraftId: null,
    content: content(),
  }, { actor });
  assert.equal(first.created, true);
  assert.equal(first.draft.version, 1);
  assert.equal(first.draft.reviewerAccountId, actor.userId);

  const replay = await repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    expectedLatestDraftId: null,
    content: content(),
  }, { actor });
  assert.equal(replay.created, false, 'an identical network retry must not append history');
  assert.equal(drafts.length, 1);

  const second = await repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    expectedLatestDraftId: first.draft.id,
    content: content('第二版草稿'),
  }, { actor });
  assert.equal(second.draft.version, 2);

  await assert.rejects(repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    expectedLatestDraftId: first.draft.id,
    content: content('过期窗口的修改'),
  }, { actor }), { code: 'COPY_REVIEW_DRAFT_CONFLICT' });

  const history = await repository.listCopyReviewDrafts(41, { actor });
  assert.deepEqual(history.drafts.map(item => item.version), [2, 1]);
  assert.equal(history.drafts[0].content.draft.copy.title, '第二版草稿');
});

test('copy review draft writes are revision- and workflow-bound', async () => {
  const stale = fixture({ revisionId: 13 });
  await assert.rejects(stale.repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    content: content(),
  }, { actor }), { code: 'STALE_COPY_REVISION' });

  const completed = fixture({ state: 'IMAGE_QUEUED' });
  await assert.rejects(completed.repository.saveCopyReviewDraft(41, {
    baseCopyRevisionId: 12,
    content: content(),
  }, { actor }), { code: 'INVALID_TASK_STATE' });
});

test('copy review draft migration keeps account and revision ownership explicit', async () => {
  const sql = await readFile(new URL('../migrations/0060_copy_review_drafts.sql', import.meta.url), 'utf8');
  assert.match(sql, /reviewer_account_id bigint NOT NULL REFERENCES app_users\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /base_copy_revision_id bigint NOT NULL REFERENCES copy_revisions\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /UNIQUE\(task_id, base_copy_revision_id, reviewer_account_id, draft_version\)/u);
  assert.doesNotMatch(sql, /UPDATE tasks|UPDATE copy_revisions|DELETE FROM|TRUNCATE|DROP TABLE/u);
});
