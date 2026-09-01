import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { hashAdminPassword } from '../src/admin/auth.mjs';
import { createAdminStore } from '../src/admin/admin-store.mjs';

const ADMIN = Object.freeze({ subject: 'admin', roles: ['ADMIN'] });

function createBatch(store, name = '质检批次') {
  return store.createImportBatch({
    name,
    sourceFileName: `${name}.xlsx`,
    rows: [
      {
        rowNumber: 2,
        externalId: `${name}-1`,
        query: '租房桌面怎么整理更实用',
        input: { category: '收纳', targetAudience: '租房用户' },
        imageCount: 3,
        referenceImageFiles: [],
        screening: {
          admitted: true,
          demandLevel: 'STRONG',
          reason: '需求明确且可执行。',
          source: 'EXCEL',
        },
        errors: [],
      },
      {
        rowNumber: 3,
        externalId: `${name}-2`,
        query: '小户型衣柜换季收纳步骤',
        input: { category: '收纳', targetAudience: '小户型住户' },
        imageCount: 3,
        referenceImageFiles: [],
        screening: {
          admitted: true,
          demandLevel: 'MEDIUM',
          reason: '有明确步骤型需求。',
          source: 'EXCEL',
        },
        errors: [],
      },
    ],
  });
}

async function createUser(store, input) {
  return store.createReviewUser(ADMIN, {
    username: input.username,
    displayName: input.displayName,
    passwordHash: await hashAdminPassword(input.password || 'correct horse battery staple'),
    roles: input.roles,
  });
}

function userActor(user) {
  return {
    subject: 'user',
    userId: user.id,
    username: user.username,
    roles: user.roles,
    credentialVersion: user.credentialVersion,
  };
}

function subjectSha256(value) {
  const stable = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(stable);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, stable(candidate[key])]));
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

describe('review users', () => {
  it('creates role-scoped users without exposing credential hashes', async () => {
    const store = createAdminStore(':memory:');
    try {
      const reviewer = await createUser(store, {
        username: 'query-qc-01',
        displayName: '选题质检一组',
        roles: ['QUERY_REVIEWER'],
      });

      assert.equal(reviewer.username, 'query-qc-01');
      assert.deepEqual(reviewer.roles, ['QUERY_REVIEWER']);
      assert.equal(reviewer.status, 'ACTIVE');
      assert.equal('passwordHash' in reviewer, false);
      assert.equal('password_hash' in reviewer, false);
      const people = store.listReviewUsers(ADMIN, { page: 1, pageSize: 1 });
      assert.equal(people.data.length, 1);
      assert.deepEqual(people.pagination, { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 });

      const loginRecord = store.findReviewUserForLogin('query-qc-01');
      assert.match(loginRecord.passwordHash, /^scrypt-v1\./);
    } finally {
      store.close();
    }
  });

  it('allows only administrators to create or disable users', async () => {
    const store = createAdminStore(':memory:');
    try {
      const lead = await createUser(store, {
        username: 'qc-lead',
        displayName: '质检组长',
        roles: ['QC_LEAD', 'QUERY_REVIEWER'],
      });
      assert.throws(() => store.createReviewUser(userActor(lead), {
        username: 'forbidden-user',
        displayName: '越权账号',
        passwordHash: 'scrypt-v1.invalid',
        roles: ['QUERY_REVIEWER'],
      }), (error) => error?.status === 403);

      const disabled = store.updateReviewUser(ADMIN, lead.id, {
        status: 'DISABLED',
        displayName: lead.displayName,
        roles: lead.roles,
        expectedVersion: lead.version,
      });
      assert.equal(disabled.status, 'DISABLED');
      assert.equal(disabled.credentialVersion, lead.credentialVersion + 1);
      assert.throws(() => store.resolveReviewActor(userActor(lead)), (error) => error?.status === 401);
    } finally {
      store.close();
    }
  });
});

describe('review work item operations', () => {
  it('idempotently seeds immutable Query and copy work items from one batch', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store);
      store.commitImportBatch(batch.id);
      for (const row of store.getImportBatch(batch.id).rows) {
        store.addTextRevision(row.taskId, {
          title: `${row.query}｜三步完成`,
          body: '先清空，再分类，最后只保留高频物品。',
          tags: ['#收纳'],
          source: 'GENERATED',
        });
      }

      const firstQuerySeed = store.seedReviewWorkItems(ADMIN, {
        reviewType: 'QUERY',
        importBatchId: batch.id,
      });
      const secondQuerySeed = store.seedReviewWorkItems(ADMIN, {
        reviewType: 'QUERY',
        importBatchId: batch.id,
      });
      const copySeed = store.seedReviewWorkItems(ADMIN, {
        reviewType: 'COPY',
        importBatchId: batch.id,
      });

      assert.deepEqual(firstQuerySeed, { createdItems: 2, existingItems: 0 });
      assert.deepEqual(secondQuerySeed, { createdItems: 0, existingItems: 2 });
      assert.deepEqual(copySeed, { createdItems: 2, existingItems: 0 });

      const result = store.listReviewWorkItems(ADMIN, { page: 1, pageSize: 10 });
      assert.equal(result.pagination.totalItems, 4);
      const queryItem = result.data.find((item) => item.reviewType === 'QUERY');
      const copyItem = result.data.find((item) => item.reviewType === 'COPY');
      assert.match(queryItem.subjectSha256, /^[a-f0-9]{64}$/);
      assert.equal(queryItem.subject.query.length > 0, true);
      assert.equal(copyItem.subject.title.length > 0, true);
    } finally {
      store.close();
    }
  });

  it('assigns, claims and decides work without allowing role or version conflicts', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store, '并发质检批次');
      const queryReviewer = await createUser(store, {
        username: 'query-reviewer',
        displayName: 'Query质检员',
        roles: ['QUERY_REVIEWER'],
      });
      const copyReviewer = await createUser(store, {
        username: 'copy-reviewer',
        displayName: '文案质检员',
        roles: ['COPY_REVIEWER'],
      });
      store.seedReviewWorkItems(ADMIN, { reviewType: 'QUERY', importBatchId: batch.id });
      const items = store.listReviewWorkItems(ADMIN, { page: 1, pageSize: 10 }).data;
      const assignedCandidate = items[0];
      const claimCandidate = items[1];

      const assigned = store.assignReviewWorkItem(ADMIN, assignedCandidate.id, {
        assigneeUserId: queryReviewer.id,
        expectedVersion: assignedCandidate.version,
      });
      assert.equal(assigned.status, 'IN_REVIEW');
      assert.equal(assigned.assignee.id, queryReviewer.id);
      assert.throws(() => store.decideReviewWorkItem(userActor(copyReviewer), assigned.id, {
        decision: 'APPROVED',
        reasonCodes: [],
        note: '越权提交',
        expectedVersion: assigned.version,
      }), (error) => error?.status === 403);

      const decided = store.decideReviewWorkItem(userActor(queryReviewer), assigned.id, {
        decision: 'APPROVED',
        reasonCodes: [],
        note: '选题目标清晰，可以生产。',
        expectedVersion: assigned.version,
      });
      assert.equal(decided.status, 'APPROVED');
      assert.equal(decided.decision.reviewer.id, queryReviewer.id);
      assert.equal(decided.decision.subjectSha256, assigned.subjectSha256);
      assert.throws(() => store.decideReviewWorkItem(userActor(queryReviewer), assigned.id, {
        decision: 'REJECTED',
        reasonCodes: ['UNCLEAR_GOAL'],
        note: '重复提交',
        expectedVersion: assigned.version,
      }), (error) => error?.status === 409);

      assert.throws(() => store.claimReviewWorkItem(userActor(copyReviewer), claimCandidate.id, {
        expectedVersion: claimCandidate.version,
      }), (error) => error?.status === 403);
      const claimed = store.claimReviewWorkItem(userActor(queryReviewer), claimCandidate.id, {
        expectedVersion: claimCandidate.version,
      });
      assert.equal(claimed.assignee.id, queryReviewer.id);
      assert.throws(() => store.claimReviewWorkItem(userActor(queryReviewer), claimCandidate.id, {
        expectedVersion: claimCandidate.version,
      }), (error) => error?.status === 409);

      const visible = store.listReviewWorkItems(userActor(queryReviewer), {
        page: 1,
        pageSize: 10,
      });
      assert.equal(visible.data.every((item) => item.reviewType === 'QUERY'), true);
      assert.equal(visible.data.every((item) => item.assignee === null || item.assignee.id === queryReviewer.id), true);
      assert.equal(store.listReviewEvents(ADMIN, assigned.id).some((event) => event.action === 'DECISION_SUBMIT'), true);
    } finally {
      store.close();
    }
  });

  it('requires a reason when rejecting a work item', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store, '驳回原因批次');
      const reviewer = await createUser(store, {
        username: 'reason-reviewer',
        displayName: '原因审核员',
        roles: ['QUERY_REVIEWER'],
      });
      store.seedReviewWorkItems(ADMIN, { reviewType: 'QUERY', importBatchId: batch.id });
      const item = store.listReviewWorkItems(ADMIN, { page: 1, pageSize: 10 }).data[0];
      const claimed = store.claimReviewWorkItem(userActor(reviewer), item.id, {
        expectedVersion: item.version,
      });

      assert.throws(() => store.decideReviewWorkItem(userActor(reviewer), claimed.id, {
        decision: 'REJECTED',
        reasonCodes: [],
        note: '',
        expectedVersion: claimed.version,
      }), /reason/i);
    } finally {
      store.close();
    }
  });
});

describe('task-level content review ownership', () => {
  it('allocates an exact number of tasks to one content reviewer without splitting ownership', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store, '任务级派单批次');
      store.commitImportBatch(batch.id);
      const reviewer = await createUser(store, {
        username: 'content-owner',
        displayName: '内容质检员一组',
        roles: ['COPY_REVIEWER'],
      });
      const otherReviewer = await createUser(store, {
        username: 'content-owner-2',
        displayName: '内容质检员二组',
        roles: ['COPY_REVIEWER'],
      });

      const allocation = store.allocateReviewTasks(ADMIN, {
        importBatchId: batch.id,
        assigneeUserId: reviewer.id,
        count: 2,
      });

      assert.equal(allocation.assignedCount, 2);
      assert.equal(allocation.remainingCount, 0);
      assert.deepEqual(allocation.assignments.map((item) => item.assignee.id), [reviewer.id, reviewer.id]);
      const result = store.listReviewTaskAssignments(ADMIN, { page: 1, pageSize: 10 });
      assert.equal(result.pagination.totalItems, 2);
      assert.equal(new Set(result.data.map((item) => item.taskId)).size, 2);

      assert.throws(() => store.allocateReviewTasks(ADMIN, {
        importBatchId: batch.id,
        assigneeUserId: otherReviewer.id,
        count: 1,
      }), (error) => error?.status === 409 && error?.code === 'INSUFFICIENT_UNASSIGNED_TASKS');
      assert.equal(store.listReviewTaskAssignments(ADMIN, { page: 1, pageSize: 10 }).pagination.totalItems, 2);
    } finally {
      store.close();
    }
  });

  it('keeps one owner from current copy approval through image approval and invalidates stale decisions', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store, '文图贯穿批次');
      store.commitImportBatch(batch.id);
      const taskId = store.getImportBatch(batch.id).rows[0].taskId;
      const revision = store.addTextRevision(taskId, {
        title: '租房桌面整理先做减法',
        body: '先清空桌面，再按使用频率分区，最后只留下每天使用的物品。',
        tags: ['#收纳', '#租房生活'],
        source: 'GENERATED',
      });
      const reviewer = await createUser(store, {
        username: 'full-flow-owner',
        displayName: '全流程质检员',
        roles: ['COPY_REVIEWER'],
      });
      const stranger = await createUser(store, {
        username: 'full-flow-stranger',
        displayName: '其他质检员',
        roles: ['COPY_REVIEWER'],
      });
      const assignment = store.allocateReviewTasks(ADMIN, {
        importBatchId: batch.id,
        assigneeUserId: reviewer.id,
        count: 1,
      }).assignments[0];

      assert.throws(() => store.decideReviewTaskStage(userActor(reviewer), assignment.id, {
        stage: 'IMAGE',
        decision: 'APPROVED',
        reasonCodes: [],
        note: '越过文案审核',
        expectedVersion: assignment.version,
      }), (error) => error?.status === 409 && error?.code === 'COPY_APPROVAL_REQUIRED');

      const copyApproved = store.decideReviewTaskStage(userActor(reviewer), assignment.id, {
        stage: 'COPY',
        decision: 'APPROVED',
        reasonCodes: [],
        note: '文案信息完整。',
        expectedVersion: assignment.version,
      });
      assert.equal(copyApproved.progress.copy.status, 'APPROVED');
      assert.equal(copyApproved.assignee.id, reviewer.id);

      const asset = store.addAsset({
        taskId,
        kind: 'GENERATED',
        parentAssetId: null,
        fileName: '01-page.png',
        relativePath: `${taskId}/01-page.png`,
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'a'.repeat(64),
        source: 'openclaw',
        sourceTextRevisionId: revision.id,
        pageIndex: 1,
        visualPlanSha256: 'b'.repeat(64),
        alignmentStatus: 'PASSED',
        alignmentResult: { passed: true },
      });
      const beforeImages = store.getReviewTaskAssignment(userActor(reviewer), assignment.id);
      assert.equal(beforeImages.progress.copy.status, 'APPROVED');
      assert.equal(beforeImages.progress.image.status, 'PENDING');
      assert.throws(() => store.getReviewTaskAssignment(userActor(stranger), assignment.id), (error) => error?.status === 403);
      assert.throws(() => store.authorizeReviewTaskAsset(userActor(stranger), assignment.id, asset.id), (error) => error?.status === 403);
      assert.equal(store.authorizeReviewTaskAsset(userActor(reviewer), assignment.id, asset.id).id, asset.id);

      assert.throws(() => store.decideReviewTaskStage(userActor(reviewer), assignment.id, {
        stage: 'IMAGE',
        decision: 'APPROVED',
        reasonCodes: [],
        note: '只有一张图时不能完成整套图片审核。',
        expectedVersion: beforeImages.version,
      }), (error) => error?.status === 409 && error?.code === 'IMAGES_NOT_READY');
      for (let pageIndex = 2; pageIndex <= 3; pageIndex += 1) {
        store.addAsset({
          taskId,
          kind: 'GENERATED',
          parentAssetId: null,
          fileName: `0${pageIndex}-page.png`,
          relativePath: `${taskId}/0${pageIndex}-page.png`,
          mimeType: 'image/png',
          width: 1080,
          height: 1440,
          sha256: String(pageIndex).repeat(64),
          source: 'openclaw',
          sourceTextRevisionId: revision.id,
          pageIndex,
          visualPlanSha256: 'b'.repeat(64),
          alignmentStatus: 'PASSED',
          alignmentResult: { passed: true },
        });
      }
      const completeImages = store.getReviewTaskAssignment(userActor(reviewer), assignment.id);
      assert.equal(completeImages.task.currentAssets.length, 3);
      assert.equal(completeImages.task.imageSetReady, true);

      const completed = store.decideReviewTaskStage(userActor(reviewer), assignment.id, {
        stage: 'IMAGE',
        decision: 'APPROVED',
        reasonCodes: [],
        note: '图片与文案匹配。',
        expectedVersion: completeImages.version,
      });
      assert.equal(completed.progress.status, 'COMPLETED');
      assert.equal(completed.progress.image.status, 'APPROVED');

      store.addTextRevision(taskId, {
        title: '租房桌面整理更新版',
        body: '正文已经调整，旧的文案和图片结论都不能继续生效。',
        tags: ['#收纳'],
        source: 'MANUAL',
      });
      const stale = store.getReviewTaskAssignment(userActor(reviewer), assignment.id);
      assert.equal(stale.assignee.id, reviewer.id);
      assert.equal(stale.progress.copy.status, 'STALE');
      assert.equal(stale.progress.image.status, 'STALE');
      assert.equal(stale.progress.status, 'IN_REVIEW');
    } finally {
      store.close();
    }
  });

  it('does not treat a historical approval for an incomplete image set as completed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-review-task-incomplete-'));
    const databasePath = join(directory, 'queue.db');
    let store = createAdminStore(databasePath);
    try {
      const batch = createBatch(store, '旧图片结论兼容批次');
      store.commitImportBatch(batch.id);
      const taskId = store.getImportBatch(batch.id).rows[0].taskId;
      const revision = store.addTextRevision(taskId, {
        title: '历史图片结论',
        body: '任务要求三张图，但旧逻辑只审核了一张图。',
        tags: ['#兼容'],
        source: 'GENERATED',
      });
      const reviewer = await createUser(store, {
        username: 'historical-image-owner',
        displayName: '历史图片负责人',
        roles: ['COPY_REVIEWER'],
      });
      const assignment = store.allocateReviewTasks(ADMIN, {
        importBatchId: batch.id,
        assigneeUserId: reviewer.id,
        count: 1,
      }).assignments[0];
      const copyApproved = store.decideReviewTaskStage(userActor(reviewer), assignment.id, {
        stage: 'COPY',
        decision: 'APPROVED',
        reasonCodes: [],
        note: '',
        expectedVersion: assignment.version,
      });
      const asset = store.addAsset({
        taskId,
        kind: 'GENERATED',
        parentAssetId: null,
        fileName: '01-page.png',
        relativePath: `${taskId}/01-page.png`,
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'a'.repeat(64),
        source: 'openclaw',
        sourceTextRevisionId: revision.id,
        pageIndex: 1,
        visualPlanSha256: 'b'.repeat(64),
        alignmentStatus: 'PASSED',
        alignmentResult: { passed: true },
      });
      store.close();

      const db = new DatabaseSync(databasePath);
      const copyDecision = db.prepare(`
        SELECT subject_sha256 FROM review_task_stage_decisions
        WHERE assignment_id = ? AND stage = 'COPY' ORDER BY id DESC LIMIT 1
      `).get(assignment.id);
      const imageSubject = {
        kind: 'IMAGE',
        taskId,
        textRevisionId: revision.id,
        copySha256: copyDecision.subject_sha256,
        assets: [{
          id: asset.id,
          sha256: asset.sha256,
          kind: asset.kind,
          revision: asset.revision,
          pageIndex: asset.pageIndex,
          alignmentStatus: asset.alignmentStatus,
        }],
      };
      db.prepare(`
        INSERT INTO review_task_stage_decisions
          (assignment_id, reviewer_user_id, stage, decision, reason_codes_json,
           note, subject_sha256, subject_json, legacy_work_item_id, created_at)
        VALUES (?, ?, 'IMAGE', 'APPROVED', '[]', '', ?, ?, NULL, ?)
      `).run(
        assignment.id,
        reviewer.id,
        subjectSha256(imageSubject),
        JSON.stringify(imageSubject),
        new Date().toISOString(),
      );
      db.close();

      store = createAdminStore(databasePath);
      const reopened = store.getReviewTaskAssignment(userActor(reviewer), assignment.id);
      assert.equal(reopened.version, copyApproved.version);
      assert.equal(reopened.task.imageSetReady, false);
      assert.equal(reopened.progress.image.status, 'STALE');
      assert.equal(reopened.progress.status, 'IN_REVIEW');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows a manager to reassign the whole task while preserving stage history', async () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = createBatch(store, '整体转派批次');
      store.commitImportBatch(batch.id);
      const first = await createUser(store, {
        username: 'first-owner',
        displayName: '原负责人',
        roles: ['COPY_REVIEWER'],
      });
      const second = await createUser(store, {
        username: 'second-owner',
        displayName: '新负责人',
        roles: ['COPY_REVIEWER'],
      });
      const assignment = store.allocateReviewTasks(ADMIN, {
        importBatchId: batch.id,
        assigneeUserId: first.id,
        count: 1,
      }).assignments[0];
      const reassigned = store.reassignReviewTask(ADMIN, assignment.id, {
        assigneeUserId: second.id,
        expectedVersion: assignment.version,
      });

      assert.equal(reassigned.assignee.id, second.id);
      assert.equal(reassigned.taskId, assignment.taskId);
      assert.throws(() => store.reassignReviewTask(ADMIN, assignment.id, {
        assigneeUserId: first.id,
        expectedVersion: assignment.version,
      }), (error) => error?.status === 409);
      assert.throws(() => store.getReviewTaskAssignment(userActor(first), assignment.id), (error) => error?.status === 403);
      assert.equal(store.getReviewTaskAssignment(userActor(second), assignment.id).taskId, assignment.taskId);
    } finally {
      store.close();
    }
  });

  it('migrates an assigned legacy copy work item into task ownership idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-review-task-migration-'));
    const databasePath = join(directory, 'queue.db');
    let store = createAdminStore(databasePath);
    try {
      const batch = createBatch(store, '旧文案工单迁移批次');
      store.commitImportBatch(batch.id);
      const taskId = store.getImportBatch(batch.id).rows[0].taskId;
      store.addTextRevision(taskId, {
        title: '旧文案结论应保留',
        body: '旧工单升级后仍需保留原审核人、原结论和内容指纹。',
        tags: ['#迁移'],
        source: 'GENERATED',
      });
      const reviewer = await createUser(store, {
        username: 'legacy-copy-owner',
        displayName: '旧工单负责人',
        roles: ['COPY_REVIEWER'],
      });
      store.seedReviewWorkItems(ADMIN, { reviewType: 'COPY', importBatchId: batch.id });
      const legacy = store.listReviewWorkItems(ADMIN, { reviewType: 'COPY', page: 1, pageSize: 10 }).data
        .find((item) => item.taskId === taskId);
      const assigned = store.assignReviewWorkItem(ADMIN, legacy.id, {
        assigneeUserId: reviewer.id,
        expectedVersion: legacy.version,
      });
      store.decideReviewWorkItem(userActor(reviewer), assigned.id, {
        decision: 'APPROVED',
        reasonCodes: [],
        note: '旧文案审核通过。',
        expectedVersion: assigned.version,
      });
      store.close();

      store = createAdminStore(databasePath);
      const migrated = store.listReviewTaskAssignments(ADMIN, { page: 1, pageSize: 10 });
      assert.equal(migrated.pagination.totalItems, 1);
      assert.equal(migrated.data[0].taskId, taskId);
      assert.equal(migrated.data[0].assignee.id, reviewer.id);
      assert.equal(migrated.data[0].progress.copy.status, 'APPROVED');
      assert.equal(migrated.data[0].progress.copy.decision.note, '旧文案审核通过。');
      const migratedDecisionId = migrated.data[0].progress.copy.decision.id;
      store.close();

      store = createAdminStore(databasePath);
      const reopened = store.listReviewTaskAssignments(ADMIN, { page: 1, pageSize: 10 });
      assert.equal(reopened.pagination.totalItems, 1);
      assert.equal(reopened.data[0].progress.copy.decision.id, migratedDecisionId);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
