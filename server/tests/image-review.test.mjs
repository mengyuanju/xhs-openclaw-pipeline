import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';

const runId = '44444444-4444-4444-8444-444444444444';
const otherRunId = '55555555-5555-4555-8555-555555555555';
const reviewSessionId = '66666666-6666-4666-8666-666666666666';

function imagePlan(label = '原规划') {
  return ['hero', 'steps', 'summary'].map((kind, index) => ({
    kind,
    headline: `${label}${index + 1}`,
    subtitle: '保持页面信息准确清晰',
    bullets: ['第一条核对信息', '第二条核对信息'],
    prompt: '使用清晰构图呈现页面主题和全部文字信息。',
    layout: { mode: 'AUTO' },
  }));
}

function fixture(overrides = {}, {
  completedRun = true,
  archiveImageResult = { images: [101, 102, 103].map((assetId) => ({ assetId })) },
  archiveAssetIds = [101, 102, 103],
} = {}) {
  const task = { id: 7, state: 'MANUAL_ARCHIVE', current_image_run_id: runId,
    current_copy_revision_id: 3, created_by_user_id: 'alice', current_execution_id: null,
    requested_image_count: '3', progress_percent: 100, finished_at: '2026-09-06T00:00:00Z',
    mandatory_copy_qc: false, mandatory_copy_qc_origin: null, ...overrides };
  const queries = [];
  const assessments = [];
  const submissions = [];
  const sourceContent = { copy: { title: '原文', body: '正文', tags: ['#标签'] }, imagePlan: imagePlan() };
  const revisions = [];
  const deliveries = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
      if (sql.includes('SELECT * FROM app_users')) return { rows: [{ id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credential_version: 1 }] };
      if (sql.includes('SELECT * FROM tasks')) return { rows: [{ ...task }] };
      if (sql.includes('INSERT INTO human_quality_review_submissions')) {
        if (submissions.some((row) => row.review_session_id === values[0])) return { rows: [] };
        const row = { review_session_id: values[0], task_id: values[1], stage: values[2],
          reviewer_username: values[3], request_fingerprint: values[4] };
        submissions.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM human_quality_review_submissions')) {
        return { rows: submissions.filter((row) => row.review_session_id === values[0]) };
      }
      if (sql.includes('SELECT id FROM image_runs')) return { rows: completedRun ? [{ id: runId }] : [] };
      if (sql.includes('AS available_asset_ids')) return completedRun ? { rows: [{
        copy_content: sourceContent,
        image_result: archiveImageResult,
        available_asset_ids: archiveAssetIds,
      }] } : { rows: [] };
      if (sql.includes('SELECT * FROM copy_revisions')) return { rows: [{ id: 3, content: sourceContent, approved_at: 'now' }] };
      if (sql.includes('MAX(revision)')) return { rows: [{ revision: 2 }] };
      if (sql.includes('INSERT INTO copy_revisions')) {
        const finalRework = sql.includes("'FINAL_REWORK'");
        const row = {
          id: 4,
          task_id: values[0],
          revision: values[1],
          content: values[2],
          approved_at: finalRework ? null : 'now',
          approved_by_node_id: finalRework ? null : values[3],
          approval_mode: finalRework ? null : 'MANUAL',
          parent_revision_id: finalRework ? values[3] : values[4],
          revision_origin: finalRework ? 'FINAL_REWORK' : 'PLAN_EDIT',
          copy_content_changed_from_machine: values[finalRework ? 4 : 5] === true,
          copy_rework_satisfied: false,
        };
        revisions.push(row);
        return { rows: [row] };
      }
      if (sql.includes('SELECT id FROM assets')) {
        return { rows: values[2].filter((id) => [101, 102].includes(id)).map((id) => ({ id })) };
      }
      if (sql.includes('INSERT INTO human_quality_assessments')) {
        const row = {
          id: assessments.length + 1,
          task_id: values[0], stage: values[1], copy_revision_id: values[2], image_run_id: values[3],
          score_x10: values[4], rating_context: values[5], action: values[6], reason_codes: values[7],
          problem_asset_ids: values[8], note: values[9], rework_target: values[10], reviewer_username: values[11],
          review_session_id: values[12], request_fingerprint: values[13], created_at: new Date(),
        };
        assessments.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE delivery_entries')) {
        for (const delivery of deliveries) {
          if (delivery.task_id === Number(values[0]) && delivery.status === 'READY') delivery.status = 'WITHDRAWN';
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO delivery_entries')) {
        const row = {
          id: deliveries.length + 1,
          task_id: Number(values[0]),
          copy_revision_id: Number(values[1]),
          image_run_id: values[2],
          approved_by_account_id: values[3],
          approved_by_username: values[4],
          status: 'READY',
        };
        deliveries.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE tasks SET')) {
        const retry = ['IMAGE_QUEUED', 'COPY_REVIEW_PENDING'].includes(values[1]);
        const copyRework = values[1] === 'COPY_REVIEW_PENDING';
        Object.assign(task, { state: values[1], current_stage: values[1], progress_message: values[2],
          current_copy_revision_id: values[4],
          current_image_run_id: retry ? null : runId, pending_snapshot: null,
          mandatory_copy_qc: copyRework || task.mandatory_copy_qc,
          mandatory_copy_qc_origin: copyRework ? 'FINAL_REWORK' : task.mandatory_copy_qc_origin,
          image_reviewed_by_user_id: values[1] === 'REVIEWED' ? values[3] : null,
          image_reviewed_at: values[1] === 'REVIEWED' ? '2026-09-06T01:00:00Z' : null });
        return { rows: [{ ...task }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { task, queries, assessments, revisions, deliveries, sourceContent,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

for (const [label, archiveImageResult, archiveAssetIds] of [
  ['empty image list', { images: [] }, [101, 102, 103]],
  ['invalid selected asset id', { images: [{ assetId: 'not-an-id' }] }, [101]],
  ['asset outside the pinned task and run', { images: [{ assetId: 999 }] }, [101, 102, 103]],
]) {
  test(`final image approval refuses ${label} before READY is committed`, async () => {
    const { repository, queries, deliveries } = fixture({}, {
      archiveImageResult,
      archiveAssetIds,
    });
    await assert.rejects(repository.reviewImages(7, {
      imageRunId: runId,
      decision: 'APPROVE',
      score: 2.5,
      note: '终审确认图片质量符合要求',
      reviewerUserId: 'reviewer',
      reviewSessionId,
    }), { code: 'DELIVERY_SOURCE_NOT_ARCHIVABLE' });
    assert.equal(deliveries.length, 0);
    assert.ok(queries.some(({ sql }) => sql.includes('AS available_asset_ids')));
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  });
}

for (const [decision, expected] of [['APPROVE', 'REVIEWED'], ['RETRY', 'IMAGE_QUEUED'], ['DISCARD', 'CANCELLED']]) {
  test(`image review ${decision} leaves manual archive as ${expected}`, async () => {
    const { repository, task, queries, assessments, deliveries } = fixture();
    const input = { imageRunId: runId, decision, score: decision === 'APPROVE' ? 2.5 : 2,
      reviewerUserId: 'reviewer', reviewSessionId };
    const result = await repository.reviewImages(7, input);
    assert.equal(result.state, expected);
    assert.equal(result.currentCopyRevisionId, 3);
    assert.equal(result.createdByUserId, 'alice');
    assert.equal(result.currentImageRunId, decision === 'RETRY' ? null : runId);
    assert.equal(result.imageReviewedByUserId, decision === 'APPROVE' ? 'reviewer' : null);
    assert.equal(Boolean(result.imageReviewedAt), decision === 'APPROVE');
    if (decision === 'RETRY') assert.equal(task.pending_snapshot, null);
    assert.ok(queries.some(({ sql }) => sql.includes('FOR UPDATE')));
    assert.equal(queries.at(-1).sql, 'COMMIT');
    assert.ok(queries.every(({ sql }) => !/DELETE|UPDATE image_runs|UPDATE copy_revisions/u.test(sql)));
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0].score_x10, decision === 'APPROVE' ? 25 : 20);
    assert.deepEqual(assessments[0].reason_codes, []);
    assert.equal(assessments[0].note, null);
    assert.equal(deliveries.filter((entry) => entry.status === 'READY').length, decision === 'APPROVE' ? 1 : 0);
    if (decision === 'APPROVE') {
      const deliverySourceQuery = queries.find(({ sql }) => sql.includes('AS available_asset_ids'));
      assert.match(deliverySourceQuery.sql, /asset\.media_type = ANY\(\$4::varchar\[\]\)/u);
      assert.deepEqual([...deliverySourceQuery.values[3]].sort(), [
        'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
      ]);
    }
    assert.equal((await repository.reviewImages(7, input)).state, expected, 'same session is idempotent');
    assert.equal(assessments.length, 1);
  });
}

for (const reworkTarget of ['COPY', 'BOTH']) {
  test(`final image review ${reworkTarget} return creates a FINAL_REWORK copy gate`, async () => {
    const { repository, revisions, assessments } = fixture();
    const result = await repository.reviewImages(7, {
      imageRunId: runId,
      decision: 'REWORK',
      reworkTarget,
      score: 2,
      reasons: ['CONTENT_MISMATCH'],
      note: '图文终审要求修改文案后重新质检',
      reviewSessionId: reworkTarget === 'COPY'
        ? '96969696-9696-4696-8696-969696969696'
        : '97979797-9797-4797-8797-979797979797',
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    });

    assert.equal(result.state, 'COPY_REVIEW_PENDING');
    assert.equal(result.currentImageRunId, null);
    assert.equal(result.mandatoryCopyQc, true);
    assert.equal(result.mandatoryCopyQcOrigin, 'FINAL_REWORK');
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revision_origin, 'FINAL_REWORK');
    assert.equal(revisions[0].content.finalRework.target, reworkTarget);
    assert.equal(assessments[0].action, 'RETRY');
    assert.equal(assessments[0].rework_target, reworkTarget);
  });
}

test('admin image retry saves edited plan as a new approved revision and keeps the reviewed revision immutable', async () => {
  const { repository, task, queries, assessments, revisions, sourceContent } = fixture();
  sourceContent.imageReprocess = {
    version: 1,
    sourceRunId: otherRunId,
    sources: [{ assetId: 101, file: '01-hero.png' }],
  };
  const original = structuredClone(sourceContent);
  const edited = imagePlan('修正规划');
  edited[0].bullets = ['先核对标题文字', '再按新规划重新生成'];
  const input = {
    imageRunId: runId,
    revisionId: 3,
    nodeId: 'web-admin',
    imagePlan: edited,
    decision: 'RETRY',
    score: 2,
    reasons: ['TEXT_ERROR'],
    note: '自动验收发现可见文字问题，修正规划后重试。',
    reviewSessionId,
    actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
  };

  const result = await repository.reviewImages(7, input);
  assert.equal(result.state, 'IMAGE_QUEUED');
  assert.equal(result.currentCopyRevisionId, 4);
  assert.equal(result.currentImageRunId, null);
  assert.equal(task.progress_message, '管理员已修正图片文案规划，等待图片执行机重新生成');
  assert.deepEqual(sourceContent, original, 'the approved source revision remains immutable');
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].content.imagePlan, edited);
  assert.equal(revisions[0].content.copy.title, original.copy.title);
  assert.equal(revisions[0].content.imageReprocess, undefined,
    'a corrected plan must trigger fresh generation instead of converting prior assets');
  assert.deepEqual(revisions[0].content.imageRevision, {
    version: 1,
    operation: 'REGENERATE',
    planEdited: true,
    baseRevisionId: 3,
    baseImageRunId: runId,
    actorUsername: 'admin',
    createdAt: revisions[0].content.imageRevision.createdAt,
  });
  assert.match(revisions[0].content.imageRevision.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(queries.find(({ sql }) => sql.includes('INSERT INTO copy_revisions') && sql.includes("'MANUAL'")));
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0].action, 'RETRY');

  assert.equal((await repository.reviewImages(7, input)).currentCopyRevisionId, 4, 'same session is idempotent');
  assert.equal(revisions.length, 1);
  assert.equal(assessments.length, 1);
});

test('approved image-plan edits are admin-only, retry-only and cannot change page structure', async () => {
  const base = {
    imageRunId: runId,
    revisionId: 3,
    nodeId: 'web-admin',
    imagePlan: imagePlan('修正规划'),
    score: 2,
    reasons: ['TEXT_ERROR'],
    reviewSessionId,
  };

  const reviewer = fixture();
  await assert.rejects(reviewer.repository.reviewImages(7, {
    ...base,
    decision: 'RETRY',
    actor: { userId: 2, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
  }), { code: 'FORBIDDEN' });
  assert.equal(reviewer.queries.length, 0);

  const approve = fixture();
  await assert.rejects(approve.repository.reviewImages(7, {
    ...base,
    decision: 'APPROVE',
    score: 2.5,
    actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
  }), /only accepted for image-only rework/u);
  assert.equal(approve.queries.length, 0);

  for (const mutate of [
    plan => plan.slice(0, 2),
    plan => plan.map((page, index) => index === 1 ? { ...page, kind: 'checklist' } : page),
  ]) {
    const changed = fixture();
    await assert.rejects(changed.repository.reviewImages(7, {
      ...base,
      imagePlan: mutate(imagePlan('修正规划')),
      decision: 'RETRY',
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }));
    assert.equal(changed.revisions.length, 0);
    assert.equal(changed.assessments.length, 0);
  }
});

test('stale image review cannot approve, retry or discard a newer image run', async () => {
  for (const decision of ['APPROVE', 'RETRY', 'DISCARD']) {
    const { repository, queries } = fixture({ current_image_run_id: otherRunId });
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision, score: 2.5,
      note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId }), { code: 'STALE_IMAGE_RUN' });
    assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  }
});

test('invalid review input is rejected before mutation', async () => {
  for (const input of [{ decision: 'unknown' }, { imageRunId: 'bad' }, { reviewerUserId: '' },
    { score: 2.25 }, { reviewSessionId: 'bad' }]) {
    const { repository, queries } = fixture();
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', score: 2.5,
      note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId, ...input }), TypeError);
    assert.equal(queries.length, 0);
  }
});

test('approval rejects an unfinished image run or images from an older copy revision', async () => {
  const { repository, queries } = fixture({}, { completedRun: false });
  await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', score: 2.5,
    note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId }), { code: 'STALE_IMAGE_RUN' });
  assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
});

test('image review stores optional low-score feedback and validates current-run problem assets', async () => {
  const { repository, assessments } = fixture();
  await repository.reviewImages(7, {
    imageRunId: runId,
    decision: 'RETRY',
    score: 2,
    reasons: ['TEXT_ERROR'],
    problemAssetIds: [102, 101],
    reviewerUserId: 'reviewer',
    reviewSessionId,
  });
  assert.deepEqual(assessments[0].reason_codes, ['TEXT_ERROR']);
  assert.deepEqual(assessments[0].problem_asset_ids, [101, 102]);

  const invalidApproval = fixture();
  await assert.rejects(invalidApproval.repository.reviewImages(7, {
    imageRunId: runId,
    decision: 'APPROVE',
    score: 2,
    reviewerUserId: 'reviewer',
    reviewSessionId,
  }), { code: 'QUALITY_SCORE_TOO_LOW' });
  assert.equal(invalidApproval.assessments.length, 0);

  const staleAsset = fixture();
  await assert.rejects(staleAsset.repository.reviewImages(7, {
    imageRunId: runId,
    decision: 'DISCARD',
    score: 1,
    reasons: ['CONTENT_MISMATCH'],
    problemAssetIds: [999],
    reviewerUserId: 'reviewer',
    reviewSessionId,
  }), { code: 'INVALID_PROBLEM_ASSETS' });
  assert.equal(staleAsset.assessments.length, 0);
});

test('image review allows reviewers across owners, rejects ordinary users and derives reviewer identity from session', async () => {
  const calls = [];
  const repository = {
    getUserByUsername: async (username) => ({ id: 1, username, role: username === 'alice' ? 'USER' : username === 'admin' ? 'ADMIN' : 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 }),
    getTask: async () => ({ id: 7, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice' }),
    reviewImages: async (...args) => { calls.push(args); return { state: 'REVIEWED' }; },
  };
  const server = createControlPlaneApp({ repository, storageRoot: 'test-storage' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const capability = await fetch(`http://127.0.0.1:${server.address().port}/v1/tasks/7/image-capabilities`, {
      headers: { 'X-Actor-User-Id': '1', 'X-Actor-Username': 'admin', 'X-Actor-Role': 'ADMIN', 'X-Actor-Credential-Version': '1' },
    });
    assert.equal(capability.status, 200);
    assert.equal((await capability.json()).data.reviewImagePlanEdits, true);
    for (const [username, role, status] of [['reviewer', 'REVIEWER', 200], ['admin', 'ADMIN', 200], ['alice', 'USER', 403]]) {
      const planEdit = username === 'admin' ? {
        revisionId: 3,
        nodeId: 'web-admin',
        imagePlan: imagePlan('HTTP修正规划'),
      } : {};
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/tasks/7/review-images`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-User-Id': '1', 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1' },
        body: JSON.stringify({ imageRunId: runId, decision: username === 'admin' ? 'RETRY' : 'APPROVE', score: username === 'admin' ? 2 : 2.5,
          note: '轻微问题', reviewSessionId, reviewerUserId: 'spoofed', ...planEdit }),
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(calls.map(([, input]) => input.actor.username), ['reviewer', 'admin']);
    assert.deepEqual(calls[0][1], {
      imageRunId: runId,
      decision: 'APPROVE',
      reworkTarget: undefined,
      score: 2.5,
      reasons: undefined,
      note: '轻微问题',
      problemAssetIds: undefined,
      reviewSessionId,
      actor: { userId: 1, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
    });
    assert.deepEqual(calls[1][1].imagePlan, imagePlan('HTTP修正规划'));
    assert.equal(calls[1][1].revisionId, 3);
    assert.equal(calls[1][1].nodeId, 'web-admin');
    assert.equal(calls[1][1].actor.role, 'ADMIN');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
