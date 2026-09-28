import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  decideCopyQaItemV2, listCopyQaBatchesV2, listCopyQaBatchItemsV2, listCopyQaWorkItemsV2,
} from '../src/copy-qa-v2.mjs';
import { qaMetricRows, summarizeQa, validQaReview } from '../../src/quality-review-statistics.mjs';

const empty = { rows: [], rowCount: 0 };
const compact = sql => String(sql).replace(/\s+/gu, ' ').trim();
const actorFor = role => ({ userId: 91, username: `self-qa-${role.toLowerCase()}`, role, credentialVersion: 2 });

function accountFor(actor, patch = {}) {
  return { id: actor.userId, username: actor.username, role: actor.role,
    credential_version: actor.credentialVersion, status: 'ACTIVE', copy_qc_enabled: true, ...patch };
}

function activeAccount(q, values, account) {
  assert.match(q, /status='ACTIVE'/u);
  assert.match(q, /credential_version=\$4/u);
  const matches = account.status === 'ACTIVE' && values[0] === account.id
    && values[1] === account.username && values[2] === account.role
    && values[3] === account.credential_version;
  return { rows: matches ? [{ ...account }] : [] };
}

function batchRow(id, patch = {}) {
  return { id, public_id: randomUUID(), display_name: `文案质检测试批次 ${id}`,
    mode: 'MIXED_MANUAL', status: 'INSPECTING', full_inspection: true,
    blind_review_enabled: true, return_trigger_count: 2, created_at: new Date('2026-09-28T01:00:00Z'),
    ...patch };
}

function memberRow(id, batch, actor, patch = {}) {
  return { id, public_id: randomUUID(), batch_id: batch.id,
    batch_public_id: batch.public_id, batch_display_name: batch.display_name,
    blind_review_enabled: batch.blind_review_enabled, task_id: 1000 + id,
    copy_revision_id: 2000 + id, approval_event_id: 3000 + id,
    approver_account_id: actor.userId, approver_username: actor.username,
    content_sha256: 'a'.repeat(64), quality_cycle: 1, selected: true, status: 'PENDING',
    query: 'PRIVATE-QUERY', source_query_package_name: 'PRIVATE-PACKAGE',
    content: { copy: { title: `待检文案 ${id}`, body: '待检正文', tags: ['测试'] }, imagePlan: [],
      qualityReturn: { returnedByUsername: 'PRIVATE-RETURNER' } },
    mandatory_copy_qc: false, task_state: 'COPY_QC_PENDING', priority_paused: false,
    current_copy_revision_id: 2000 + id, created_at: new Date('2026-09-28T01:01:00Z'),
    ...patch };
}

function listingFixture(actor) {
  const batches = [batchRow(18, { mode: 'PERSONAL_AUTO', account_id: actor.userId }),
    batchRow(19), batchRow(20, { status: 'COMPLETED' })];
  const members = [
    memberRow(1, batches[0], actor),
    memberRow(2, batches[0], actor, { mandatory_copy_qc: true }),
    memberRow(3, batches[1], actor),
    memberRow(4, batches[1], actor, { approver_account_id: 64, approver_username: 'other-annotator' }),
    memberRow(5, batches[1], actor, { selected: false, status: 'NOT_SELECTED' }),
    memberRow(6, batches[2], actor, { status: 'PASSED' }),
    memberRow(7, batches[2], actor, { status: 'RETURNED' }),
    memberRow(8, batches[2], actor, { status: 'DISCARDED', reason_codes: ['OFF_TOPIC'], note: '内容跑题' }),
    memberRow(9, batches[2], actor, { status: 'BATCH_AFFECTED', approver_account_id: 64 }),
  ];
  for (const batch of batches) {
    batch.member_count = members.filter(row => row.batch_id === batch.id).length;
    batch.sample_count = members.filter(row => row.batch_id === batch.id && row.selected).length;
  }
  const state = { account: accountFor(actor) };
  const calls = [];
  const pool = { async query(sql, values = []) {
    const q = compact(sql); calls.push({ q, values });
    if (q.startsWith('SELECT * FROM app_users')) return activeAccount(q, values, state.account);
    if (q.startsWith('SELECT batch.*')) {
      assert.doesNotMatch(q, /member\.approver_account_id\s*(?:<>|!=)/u,
        'batch totals must include the current reviewer\'s members');
      assert.equal(values.length, 1);
      const view = values[0];
      assert.match(q, /\$1='PENDING'/u);
      return { rows: batches.filter(batch => view === 'PENDING'
        ? batch.status === 'INSPECTING' : ['COMPLETED', 'AUTO_RETURNED'].includes(batch.status)).map(batch => {
        const rows = members.filter(row => row.batch_id === batch.id);
        return { ...batch, pending_count: rows.filter(row => row.status === 'PENDING' && row.selected).length,
          passed_count: rows.filter(row => row.status === 'PASSED').length,
          returned_count: rows.filter(row => row.status === 'RETURNED').length,
          discarded_count: rows.filter(row => row.status === 'DISCARDED').length,
          affected_count: rows.filter(row => row.status === 'BATCH_AFFECTED').length };
      }) };
    }
    if (q.startsWith('SELECT * FROM copy_qa_batches_v2 WHERE public_id=$1')) {
      return { rows: batches.filter(batch => batch.public_id === values[0]).map(batch => ({ ...batch })) };
    }
    if (q.startsWith('SELECT member.*')) {
      assert.doesNotMatch(q, /member\.approver_account_id\s*(?:<>|!=)/u,
        'self-approved members must remain visible');
      if (q.includes('WHERE member.batch_id=$1')) {
        assert.equal(values.length, 1);
        return { rows: members.filter(row => row.batch_id === values[0] && row.selected).map(row => ({ ...row })) };
      }
      assert.equal(values.length, 4);
      const [sampleKind, itemId, limit, offset] = values;
      assert.match(q, /\$1::text='ALL'/u);
      assert.match(q, /member\.public_id=\$2/u);
      assert.match(q, /LIMIT \$3 OFFSET \$4/u);
      const rows = members.filter(row => batches.find(batch => batch.id === row.batch_id).status === 'INSPECTING'
        && row.selected && row.status === 'PENDING' && row.task_state === 'COPY_QC_PENDING'
        && !row.priority_paused && row.current_copy_revision_id === row.copy_revision_id
        && (sampleKind === 'ALL' || (row.mandatory_copy_qc ? 'MANDATORY_RECHECK' : 'RANDOM') === sampleKind)
        && (itemId === null || row.public_id === itemId));
      return { rows: rows.slice(offset, offset + limit).map(row => ({ ...row })) };
    }
    throw new Error(`Unexpected listing SQL: ${q}`);
  } };
  return { pool, state, batches, members, calls };
}

for (const role of ['REVIEWER', 'USER']) {
  for (const sampleKind of ['RANDOM', 'MANDATORY_RECHECK']) {
    test(`${role} sees and can decide their own V2 ${sampleKind} in the work queue`, async () => {
      const actor = actorFor(role), f = listingFixture(actor);
      const own = f.members.find(row => row.batch_id === 18 && row.mandatory_copy_qc === (sampleKind === 'MANDATORY_RECHECK'));
      const page = await listCopyQaWorkItemsV2(f.pool, { sampleKind, itemPublicId: own.public_id, limit: 1 }, actor);
      assert.equal(page.total, 1); assert.equal(page.hasMore, false);
      const [item] = page.items;
      assert.equal(item.id, own.public_id); assert.equal(item.qaVersion, 2);
      assert.equal(item.sampleKind, sampleKind); assert.equal(item.blindReview, true);
      assert.deepEqual(item.capabilities, { canPass: true, canReturnSingle: true, canReturnBatch: false, canEscalate: false });
      assert.equal(item.approvedRevision.revisionToken, own.content_sha256);
      assert.equal(JSON.stringify(item).includes(actor.username), false);
      for (const secret of ['PRIVATE-QUERY', 'PRIVATE-PACKAGE', 'PRIVATE-RETURNER']) {
        assert.equal(JSON.stringify(item).includes(secret), false, secret);
      }
      const detail = await listCopyQaBatchItemsV2(f.pool, own.batch_public_id, actor);
      assert.ok(detail.items.some(row => row.id === own.public_id));
      assert.equal(detail.items.length, 2);
      assert.equal(detail.items.find(row => row.id === own.public_id).sampleKind, sampleKind);
      assert.ok(detail.items.every(row => row.taskId === null && row.approverUsername === null));
    });
  }

  test(`${role} receives complete pending, finished and mixed V2 batch member counts`, async () => {
    const actor = actorFor(role), f = listingFixture(actor);
    const pending = await listCopyQaBatchesV2(f.pool, actor, 'PENDING');
    assert.equal(pending.length, 2, 'a batch containing only the reviewer\'s own work stays visible');
    assert.deepEqual(pending.map(batch => [batch.memberCount, batch.sampleCount, batch.pendingCount]), [[2, 2, 2], [3, 2, 2]]);
    const mixed = await listCopyQaBatchItemsV2(f.pool, f.batches[1].public_id, actor);
    assert.equal(mixed.batch.memberCount, 3); assert.equal(mixed.items.length, 2);
    assert.deepEqual(mixed.items.map(item => item.id), [f.members[2].public_id, f.members[3].public_id]);
    const [finished] = await listCopyQaBatchesV2(f.pool, actor, 'FINISHED');
    assert.deepEqual([finished.memberCount, finished.sampleCount, finished.pendingCount,
      finished.passedCount, finished.returnedCount, finished.discardedCount, finished.affectedCount], [4, 4, 0, 1, 1, 1, 1]);
    const completed = await listCopyQaBatchItemsV2(f.pool, finished.id, actor);
    assert.deepEqual(completed.items.map(item => item.status), ['PASSED', 'RETURNED', 'DISCARDED', 'BATCH_AFFECTED']);
    assert.equal(completed.items[2].discardReasonCode, 'OFF_TOPIC');
  });
}

function decisionFixture(actor, { mandatory = false } = {}) {
  const batch = batchRow(18), member = memberRow(1, batch, actor, { mandatory_copy_qc: mandatory });
  let state = { account: accountFor(actor), batch, member,
    task: { id: member.task_id, state: 'COPY_QC_PENDING', current_copy_revision_id: member.copy_revision_id,
      mandatory_copy_qc: mandatory, mandatory_copy_qc_origin: mandatory ? 'QA_RETURN' : null },
    activity: [], outcomes: [], dispositions: [], returns: [], deliveryWithdrawals: [], replay: new Map() };
  let snapshot;
  const calls = [];
  const client = { release() {}, async query(sql, values = []) {
    const q = compact(sql); calls.push({ q, values });
    if (q === 'BEGIN') { snapshot = structuredClone(state); return empty; }
    if (q === 'ROLLBACK') { state = snapshot; return empty; }
    if (q === 'COMMIT' || q.includes('set_config') || q.includes('pg_advisory')) return empty;
    if (q.startsWith('SELECT * FROM app_users')) return activeAccount(q, values, state.account);
    if (q.startsWith('SELECT * FROM copy_qa_decision_requests_v2')) {
      const replay = state.replay.get(values[1]); return { rows: replay ? [replay] : [] };
    }
    if (q.startsWith('SELECT batch_id FROM copy_qa_batch_members_v2')) return { rows: [{ batch_id: state.batch.id }] };
    if (q.startsWith('SELECT * FROM copy_qa_batches_v2')) return { rows: [{ ...state.batch }] };
    if (q.startsWith('SELECT * FROM copy_qa_batch_members_v2 WHERE public_id')) return { rows: [{ ...state.member }] };
    if (q.startsWith('SELECT * FROM copy_qa_batch_members_v2 WHERE batch_id')) return { rows: [] };
    if (q.startsWith('SELECT approval.approved_by_username')) {
      return { rows: [{ approved_by_username: actor.username, production_batch_id: 4,
        mandatory_copy_qc: state.task.mandatory_copy_qc, prior_return: false, query: '待检测试文案' }] };
    }
    if (q.startsWith('SELECT * FROM tasks')) return { rows: [{ ...state.task }] };
    if (q.startsWith('SELECT count(*) AS count FROM copy_qa_return_events_v2')) return { rows: [{ count: 0 }] };
    if (q.startsWith('INSERT INTO copy_qa_return_events_v2')) { state.returns.push(values); return empty; }
    if (q.startsWith("UPDATE copy_qa_batch_members_v2 SET status='PASSED'")) {
      state.member.status = 'PASSED'; state.member.reviewed_by_account_id = values[1]; return empty;
    }
    if (q.startsWith('UPDATE copy_qa_batch_members_v2 SET status=$2')) {
      state.member.status = values[1]; state.member.reviewed_by_account_id = values[2];
      state.member.reason_codes = values[3]; state.member.note = values[5]; return empty;
    }
    if (q.startsWith("UPDATE copy_qa_batch_members_v2 SET status='DISCARDED'")) {
      state.member.status = 'DISCARDED'; state.member.reviewed_by_account_id = values[1]; return empty;
    }
    if (q.startsWith("UPDATE copy_qa_batch_members_v2 SET status='RELEASED'")) return empty;
    if (q.startsWith('INSERT INTO account_quality_events')) {
      state.outcomes.push({ action: q.includes("'DISCARD'") ? 'DISCARD' : values[3],
        establishesSample: q.includes("'DISCARD'") ? values[3] : true, data: values[4] }); return empty;
    }
    if (q.startsWith('INSERT INTO quality_review_activity_events')) {
      const kind = q.includes("'QA_DISCARD'") ? 'QA_DISCARD' : 'QA_REVIEW';
      state.activity.push({ id: values[0], accountId: values[1], taskId: values[2], stage: 'COPY', kind, ...values[3] });
      return empty;
    }
    if (q.startsWith('INSERT INTO copy_qa_dispositions_v2')) { state.dispositions.push(values); return empty; }
    if (q.startsWith('UPDATE delivery_entries')) { state.deliveryWithdrawals.push(values[0]); return empty; }
    if (q.startsWith('SELECT * FROM copy_revisions')) return { rows: [{ content: member.content }] };
    if (q.startsWith('INSERT INTO copy_revisions')) return { rows: [{ id: 5000 }] };
    if (q.startsWith('SELECT count(*) FILTER')) return { rows: [{
      pending: state.member.status === 'PENDING' ? 1 : 0, returned: state.member.status === 'RETURNED' ? 1 : 0 }] };
    if (q.startsWith('UPDATE copy_qa_batches_v2')) { state.batch.status = values[1]; return empty; }
    if (q.startsWith("UPDATE tasks SET state='IMAGE_QUEUED'")) {
      if (state.task.state !== 'COPY_QC_PENDING' || state.task.current_copy_revision_id !== values[1]) return empty;
      state.task.state = 'IMAGE_QUEUED'; return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE tasks SET state='COPY_REVIEW_PENDING'")) {
      state.task.state = 'COPY_REVIEW_PENDING'; state.task.current_copy_revision_id = values[1];
      state.task.copy_qa_rework_pending = true; return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE tasks SET state='CANCELLED'")) { state.task.state = 'CANCELLED'; return { rows: [], rowCount: 1 }; }
    if (q.startsWith('INSERT INTO copy_qa_decision_requests_v2')) {
      state.replay.set(values[1], { fingerprint: values[2], response: values[3] }); return empty;
    }
    throw new Error(`Unexpected decision SQL: ${q}`);
  } };
  const inputFor = decision => ({ requestId: randomUUID(), decision, revisionToken: member.content_sha256,
    ...(decision === 'RETURN' ? { reasonCodes: ['TITLE_AI_TONE'], note: '标题需要修改' } : {}),
    ...(decision === 'DISCARD' ? { discardReasonCode: 'OFF_TOPIC', note: '文案内容跑题' } : {}) });
  return { pool: { connect: async () => client }, inputFor, calls, get state() { return state; } };
}

for (const role of ['REVIEWER', 'USER']) {
  for (const mandatory of [false, true]) {
    for (const decision of ['PASS', 'RETURN', 'DISCARD']) {
      test(`${role} can ${decision} their own V2 ${mandatory ? 'mandatory recheck' : 'random sample'} with excluded self-review audit`, async () => {
        const actor = actorFor(role), f = decisionFixture(actor, { mandatory });
        const input = f.inputFor(decision), itemId = f.state.member.public_id;
        const response = await decideCopyQaItemV2(f.pool, itemId, input, actor);
        const status = { PASS: 'PASSED', RETURN: 'RETURNED', DISCARD: 'DISCARDED' }[decision];
        assert.deepEqual(response, { id: itemId, status, caseIds: [] });
        assert.equal(f.state.member.status, status);
        assert.equal(f.state.member.reviewed_by_account_id, actor.userId);
        assert.equal(f.state.batch.status, 'COMPLETED');
        assert.equal(f.state.task.state, { PASS: 'IMAGE_QUEUED', RETURN: 'COPY_REVIEW_PENDING', DISCARD: 'CANCELLED' }[decision]);
        const [audit] = f.state.activity;
        assert.equal(f.state.activity.length, 1); assert.equal(audit.accountId, actor.userId);
        assert.equal(audit.exclusion, 'SELF_REVIEW'); assert.equal(audit.outcome, decision);
        assert.equal(audit.qaBatchId, f.state.batch.id);
        if (decision === 'DISCARD') {
          assert.equal(f.state.dispositions.length, 1);
          assert.equal(f.state.dispositions[0][5], actor.userId);
          assert.equal(f.state.dispositions[0][6], actor.username);
          assert.deepEqual(f.state.deliveryWithdrawals, [f.state.task.id]);
          assert.equal(f.state.outcomes.length, 1);
          assert.equal(f.state.outcomes[0].establishesSample, false);
        } else {
          assert.equal(f.state.outcomes.length, 0, 'self-review does not establish an independent quality sample');
          assert.equal(audit.sampleKind, mandatory ? 'MANDATORY_RECHECK' : 'RANDOM');
          assert.equal(f.state.returns.length, decision === 'RETURN' ? 1 : 0);
        }
        assert.equal(validQaReview(audit), false);
        assert.equal(qaMetricRows(f.state.activity, 'qaAll').length, 1, 'self-review remains traceable in the full audit');
        const summary = summarizeQa(f.state.activity);
        assert.equal(summary.reviews, 0); assert.equal(summary.specialActions, 0); assert.equal(summary.participants, 0);
        const committed = structuredClone(f.state);
        assert.deepEqual(await decideCopyQaItemV2(f.pool, itemId, input, actor), response);
        assert.deepEqual(f.state, committed, 'repeating the same request does not repeat the decision or audit');
        await assert.rejects(decideCopyQaItemV2(f.pool, itemId, { ...input, note: 'changed payload' }, actor), { code: 'REQUEST_ID_REUSED' });
        assert.deepEqual(f.state, committed);
      });
    }
  }

  test(`${role} self-review still requires an enabled quality permission and active account`, async () => {
    const actor = actorFor(role);
    for (const patch of [{ copy_qc_enabled: false }, { status: 'DISABLED' }]) {
      const code = patch.status ? 'SESSION_STALE' : 'FORBIDDEN';
      const listing = listingFixture(actor); Object.assign(listing.state.account, patch);
      await assert.rejects(listCopyQaBatchesV2(listing.pool, actor), { code });
      await assert.rejects(listCopyQaWorkItemsV2(listing.pool, {}, actor), { code });
      await assert.rejects(listCopyQaBatchItemsV2(listing.pool, listing.batches[0].public_id, actor), { code });
      const f = decisionFixture(actor); Object.assign(f.state.account, patch);
      const before = structuredClone(f.state);
      await assert.rejects(decideCopyQaItemV2(f.pool, f.state.member.public_id, f.inputFor('PASS'), actor), { code });
      assert.deepEqual(f.state, before, 'rejected identities do not mutate task or audit state');
    }
  });
}

test('self-review preserves stale token, processed member, closed batch and current task version conflicts', async () => {
  const actor = actorFor('REVIEWER');
  for (const boundary of ['TOKEN', 'PROCESSED', 'UNSELECTED', 'BATCH_CLOSED', 'TASK_VERSION']) {
    const f = decisionFixture(actor), input = f.inputFor('PASS');
    if (boundary === 'TOKEN') input.revisionToken = 'b'.repeat(64);
    if (boundary === 'PROCESSED') f.state.member.status = 'PASSED';
    if (boundary === 'UNSELECTED') f.state.member.selected = false;
    if (boundary === 'BATCH_CLOSED') f.state.batch.status = 'COMPLETED';
    if (boundary === 'TASK_VERSION') f.state.task.current_copy_revision_id++;
    const before = structuredClone(f.state);
    await assert.rejects(decideCopyQaItemV2(f.pool, f.state.member.public_id, input, actor),
      { code: boundary === 'BATCH_CLOSED' ? 'BATCH_CLOSED' : 'STALE_QA_ITEM' });
    assert.deepEqual(f.state, before, boundary);
  }
});
