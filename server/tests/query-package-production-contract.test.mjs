import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignQueryPackage,
  createQueryPackageProductionBatch,
  getQueryPackage,
  permanentlyDeleteQueryPackage,
  previewPermanentQueryPackageDeletion,
  updateQueryPackageScreening,
} from '../src/query-packages.mjs';
import { hashUserPassword } from '../src/user-auth.mjs';

const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });
const worker = Object.freeze({ userId: 22, username: 'worker-22', role: 'USER' });
const reviewer = Object.freeze({ userId: 91, username: 'reviewer-91', role: 'REVIEWER' });

function packageRow(patch = {}) {
  return {
    id: 9,
    name: '九月选题',
    source_file_name: 'queries.txt',
    status: 'SCREENING',
    created_by_account_id: 1,
    created_by_username: 'admin',
    assigned_to_account_id: 22,
    assigned_to_username: 'worker-22',
    version: 1,
    created_at: new Date('2026-09-09T00:00:00.000Z'),
    updated_at: new Date('2026-09-09T00:00:00.000Z'),
    ...patch,
  };
}

function itemRow(id, patch = {}) {
  return {
    id,
    query_package_id: 9,
    row_number: id,
    external_id: `external-${id}`,
    raw_query: `Query ${id}`,
    query: `Query ${id}`,
    input: {},
    requested_image_count: 'auto',
    status: 'READY',
    validation_errors: [],
    screening_decision: 'PENDING',
    version: 1,
    ...patch,
  };
}

function fakeQueryPackageDatabase() {
  const state = {
    package: packageRow(),
    items: new Map([[101, itemRow(101)], [102, itemRow(102)]]),
    mutations: new Map(),
    batches: [],
    tasks: [],
    batchItems: [],
    screeningEvents: [],
    screeningResultOverride: null,
    deletionAudits: [],
    deletionPasswordHash: null,
    activeActors: new Map([
      [1, { id: 1, username: 'admin', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 }],
      [22, { id: 22, username: 'worker-22', displayName: '普通用户', role: 'USER', status: 'ACTIVE', credentialVersion: 1 }],
      [91, { id: 91, username: 'reviewer-91', displayName: '审核员', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 }],
    ]),
    sql: [],
  };

  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.sql.push(source);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT id FROM app_users') && source.includes('FOR SHARE')) {
      const actor = state.activeActors.get(Number(values[0]));
      return { rows: actor && actor.username === values[1] && actor.role === values[2]
          && actor.status === 'ACTIVE'
          && (values[3] === null || actor.credentialVersion === Number(values[3]))
        ? [{ id: actor.id }] : [] };
    }
    if (source.startsWith('SELECT id, username FROM app_users') && source.includes('FOR SHARE')) {
      const assignee = state.activeActors.get(Number(values[0]));
      return { rows: assignee && assignee.username === values[1]
          && assignee.status === 'ACTIVE'
          && ['REVIEWER', 'USER'].includes(assignee.role)
        ? [{ id: assignee.id, username: assignee.username }] : [] };
    }
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] };
    if (source.startsWith('SELECT package.*') && source.includes('GROUP BY package.id')) {
      if (!state.package || Number(values[0]) !== state.package.id) return { rows: [] };
      const items = [...state.items.values()].filter((item) => item.query_package_id === state.package.id);
      const assignee = state.activeActors.get(Number(state.package.assigned_to_account_id));
      const stableAssignee = assignee?.username === state.package.assigned_to_username ? assignee : null;
      return { rows: [{
        ...state.package,
        assigned_to_display_name: stableAssignee?.displayName ?? null,
        assigned_to_role: stableAssignee?.role ?? null,
        assignee_status: stableAssignee?.status ?? null,
        total_count: String(items.length),
        pending_count: String(items.filter((item) => item.status === 'READY'
          && item.screening_decision === 'PENDING').length),
        selected_count: String(items.filter((item) => item.screening_decision === 'SELECTED').length),
        rejected_count: String(items.filter((item) => item.screening_decision === 'REJECTED').length),
        produced_count: String(items.filter((item) => item.status === 'TASK_CREATED').length),
        invalid_count: String(items.filter((item) => item.status === 'INVALID').length),
        duplicate_count: String(items.filter((item) => item.status === 'DUPLICATE').length),
      }] };
    }
    if (source.startsWith('SELECT id, assigned_to_account_id, assigned_to_username')) {
      return { rows: state.package && Number(values[0]) === state.package.id
        ? [{
            id: state.package.id,
            assigned_to_account_id: state.package.assigned_to_account_id,
            assigned_to_username: state.package.assigned_to_username,
          }]
        : [] };
    }
    if (source.startsWith('SELECT item.*, production_item.task_id')) {
      return { rows: [...state.items.values()]
        .filter((item) => item.query_package_id === Number(values[0]))
        .map((item) => ({
          ...item,
          task_id: state.batchItems.find((batchItem) => batchItem.sourceItemId === item.id)?.taskId ?? null,
        })) };
    }
    if (source.startsWith('SELECT batch.*, COUNT(item.id) AS task_count')) {
      return { rows: state.batches
        .filter((batch) => batch.query_package_id === Number(values[0]))
        .map((batch) => ({
          ...batch,
          task_count: String(state.batchItems.filter((item) => item.productionBatchId === batch.id).length),
        })) };
    }
    if (source === 'SELECT * FROM query_packages WHERE id = $1') {
      return { rows: state.package && Number(values[0]) === state.package.id ? [{ ...state.package }] : [] };
    }
    if (source.startsWith('SELECT * FROM query_packages WHERE id = $1 FOR UPDATE')) {
      return { rows: state.package && Number(values[0]) === state.package.id ? [{ ...state.package }] : [] };
    }
    if (source.includes('FROM query_package_mutation_requests') && source.startsWith('SELECT')) {
      const row = state.mutations.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (source.startsWith('INSERT INTO query_package_mutation_requests')) {
      state.mutations.set(`${values[0]}:${values[2]}`, {
        actor_account_id: values[0], actor_username: values[1], request_id: values[2], operation: values[3],
        query_package_id: values[4], request_fingerprint: values[5], response: structuredClone(values[6]),
      });
      return { rows: [] };
    }
    if (source.startsWith('WITH requested AS MATERIALIZED')
        && source.includes('SELECT item.id, item.status, item.screening_decision')) {
      const packageId = Number(values[0]);
      const requested = JSON.parse(values[1]);
      return { rows: requested
        .map(({ itemId }) => state.items.get(Number(itemId)))
        .filter((item) => item?.query_package_id === packageId)
        .toSorted((left, right) => left.id - right.id)
        .map((item) => ({
          id: item.id,
          status: item.status,
          screening_decision: item.screening_decision,
        })) };
    }
    if (source.startsWith('WITH requested AS MATERIALIZED')
        && source.includes('updated_items AS') && source.includes('inserted_events AS')) {
      const packageId = Number(values[0]);
      const requested = JSON.parse(values[1]);
      let updatedCount = 0;
      for (const decision of requested) {
        const item = state.items.get(Number(decision.itemId));
        if (!item || item.query_package_id !== packageId || item.status !== 'READY'
            || item.screening_decision !== decision.previousDecision) continue;
        item.screening_decision = decision.decision;
        item.screening_reason = decision.reason;
        item.screened_by_account_id = Number(values[2]);
        item.screened_by_username = values[3];
        item.version += 1;
        state.screeningEvents.push({
          itemId: item.id,
          previousDecision: decision.previousDecision,
          decision: decision.decision,
          reason: decision.reason,
          requestId: values[4],
        });
        updatedCount += 1;
      }
      const result = state.screeningResultOverride ?? {
        updatedCount,
        eventCount: updatedCount,
      };
      return { rows: [{
        updated_count: String(result.updatedCount),
        event_count: String(result.eventCount),
      }] };
    }
    if (source.startsWith('SELECT COUNT(*) FILTER')
        && source.includes('AS pending_count') && source.includes('AS selected_count')) {
      const items = [...state.items.values()].filter((item) => item.query_package_id === Number(values[0]));
      return { rows: [{
        pending_count: String(items.filter((item) => item.status === 'READY'
          && item.screening_decision === 'PENDING').length),
        selected_count: String(items.filter((item) => item.status === 'READY'
          && item.screening_decision === 'SELECTED').length),
        produced_count: String(items.filter((item) => item.status === 'TASK_CREATED').length),
      }] };
    }
    if (source.startsWith('SELECT * FROM query_package_items')
        && source.includes('WHERE id = $1 AND query_package_id = $2')) {
      const row = state.items.get(Number(values[0]));
      return { rows: row && row.query_package_id === Number(values[1]) ? [{ ...row }] : [] };
    }
    if (source.startsWith('UPDATE query_package_items SET screening_decision')) {
      const row = state.items.get(Number(values[0]));
      Object.assign(row, {
        screening_decision: values[1], screening_reason: values[2],
        screened_by_account_id: values[3], screened_by_username: values[4],
        version: row.version + 1,
      });
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO query_package_screening_events')) return { rows: [] };
    if (source.startsWith('SELECT COUNT(*) AS count FROM query_package_items')
        && source.includes("screening_decision = 'PENDING'")) {
      const count = [...state.items.values()].filter((item) => item.query_package_id === Number(values[0])
        && item.status === 'READY' && item.screening_decision === 'PENDING').length;
      return { rows: [{ count: String(count) }] };
    }
    if (source.startsWith('UPDATE query_packages SET status = $2') && source.includes('RETURNING *')) {
      state.package.status = values[1];
      state.package.version += 1;
      return { rows: [{ ...state.package }] };
    }
    if (source.startsWith('UPDATE query_packages SET assigned_to_account_id')) {
      if (Number(values[3]) !== Number(state.package.version)) return { rows: [] };
      state.package.assigned_to_account_id = values[1] === null ? null : Number(values[1]);
      state.package.assigned_to_username = values[2];
      state.package.version += 1;
      return { rows: [{ ...state.package }] };
    }
    if (source.startsWith('SELECT id FROM query_package_items') && source.includes("screening_decision = 'SELECTED'")) {
      const requested = values[1] === null ? null : new Set(values[1].map(Number));
      return { rows: [...state.items.values()].filter((item) => item.query_package_id === Number(values[0])
        && item.status === 'READY' && item.screening_decision === 'SELECTED'
        && (requested === null || requested.has(item.id))).map((item) => ({ ...item })) };
    }
    if (source.startsWith('INSERT INTO executor_nodes')) return { rows: [] };
    if (source.startsWith('INSERT INTO production_batches')) {
      const row = {
        id: state.batches.length + 301,
        public_id: values[0],
        query_package_id: Number(values[1]),
        query_package_name: values[2],
        status: 'OPEN',
        sampling_status: 'OPEN',
        created_by_account_id: Number(values[3]),
        created_by_username: values[4],
        request_id: values[5],
        request_fingerprint: values[6],
        version: 1,
        created_at: new Date('2026-09-09T01:00:00.000Z'),
        updated_at: new Date('2026-09-09T01:00:00.000Z'),
      };
      state.batches.push(row);
      return { rows: [{ ...row }] };
    }
    if (source.startsWith('WITH source_items AS MATERIALIZED')) {
      const packageId = Number(values[0]);
      const requestedIds = values[1].map(Number);
      const batchId = Number(values[5]);
      const created = [];
      for (const sourceItemId of requestedIds) {
        const item = state.items.get(sourceItemId);
        if (!item || item.query_package_id !== packageId || item.status !== 'READY'
            || item.screening_decision !== 'SELECTED') continue;
        const taskId = state.tasks.length + 501;
        state.tasks.push({
          id: taskId,
          query: item.query,
          created_by_user_id: values[3],
          state: 'COPY_QUEUED',
          current_stage: 'COPY_QUEUED',
          assigned_to_user_id: null,
          assignment_source: null,
          assigned_at: null,
          source_query_package_id: packageId,
          source_query_package_item_id: sourceItemId,
          source_query_package_name: values[4],
          source_query_package_external_id: item.external_id ?? null,
          production_batch_id: batchId,
        });
        state.batchItems.push({ productionBatchId: batchId, sourceItemId, taskId });
        item.status = 'TASK_CREATED';
        item.version += 1;
        created.push({ task_id: taskId, source_query_package_item_id: sourceItemId });
      }
      return { rows: created };
    }
    if (source.startsWith('WITH created AS MATERIALIZED')
        && source.includes('UPDATE xhs_query_search_jobs AS job')) {
      return { rows: JSON.parse(values[0]).map((_, index) => ({ id: index + 1 })) };
    }
    if (source.startsWith('INSERT INTO tasks')) {
      const row = { id: state.tasks.length + 501, query: values[0], source_query_package_item_id: Number(values[7]) };
      state.tasks.push(row);
      return { rows: [{ ...row }] };
    }
    if (source.startsWith('INSERT INTO production_batch_items')) {
      state.batchItems.push({ productionBatchId: Number(values[0]), sourceItemId: Number(values[1]), taskId: Number(values[4]) });
      return { rows: [] };
    }
    if (source.startsWith("UPDATE query_package_items SET status = 'TASK_CREATED'")) {
      const row = state.items.get(Number(values[0]));
      row.status = 'TASK_CREATED';
      row.version += 1;
      return { rows: [] };
    }
    if (source.startsWith('SELECT COUNT(*) AS count FROM query_package_items')
        && source.includes("screening_decision = 'SELECTED'")) {
      const count = [...state.items.values()].filter((item) => item.query_package_id === Number(values[0])
        && item.status === 'READY' && item.screening_decision === 'SELECTED').length;
      return { rows: [{ count: String(count) }] };
    }
    if (source.startsWith('UPDATE query_packages SET status = $2')) {
      state.package.status = values[1];
      state.package.version += 1;
      return { rows: [] };
    }
    if (source.startsWith('SELECT deletion_password_hash FROM app_users')) {
      return { rows: state.deletionPasswordHash ? [{ deletion_password_hash: state.deletionPasswordHash }] : [] };
    }
    if (source.startsWith('SELECT COUNT(*) AS item_count')) {
      return { rows: [{
        item_count: String(state.items.size),
        task_count: String(new Set(state.batchItems.map((item) => item.taskId)).size),
      }] };
    }
    if (source.startsWith('DELETE FROM query_package_mutation_requests WHERE query_package_id = $1')) {
      for (const [key, mutation] of state.mutations) {
        if (Number(mutation.query_package_id) === Number(values[0])) state.mutations.delete(key);
      }
      return { rows: [] };
    }
    if (source.startsWith('DELETE FROM xhs_query_search_jobs AS job')) return { rows: [] };
    if (source.startsWith('DELETE FROM query_packages WHERE id = $1')) {
      state.package = null;
      state.items.clear();
      for (const item of state.batchItems) item.sourceItemId = null;
      for (const task of state.tasks) {
        task.source_query_package_id = null;
        task.source_query_package_item_id = null;
      }
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO query_package_deletion_audits')) {
      state.deletionAudits.push({
        packageId: Number(values[0]), itemCount: Number(values[1]), detachedTaskCount: Number(values[2]),
        actorAccountId: Number(values[3]), actorUsername: values[4], reason: values[5], requestId: values[6],
      });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${source}`);
  };

  const client = { query, release() {} };
  return { state, pool: { connect: async () => client, query } };
}

test('historical production and package assignment remain administrator-only before database access', async () => {
  let databaseAccessCount = 0;
  const pool = {
    connect: async () => {
      databaseAccessCount += 1;
      throw new Error('database access is forbidden for users');
    },
    query: async () => {
      databaseAccessCount += 1;
      throw new Error('database access is forbidden for users');
    },
  };

  await assert.rejects(assignQueryPackage(pool, 9, {
    expectedVersion: 1,
    assignedToUserId: reviewer.username,
    assignedToAccountId: reviewer.userId,
  }, worker), { code: 'FORBIDDEN' });
  for (const actor of [worker, reviewer]) {
    await assert.rejects(createQueryPackageProductionBatch(pool, 9, {
      expectedVersion: 1,
      requestId: '20202020-2020-4020-8020-202020202020',
      itemIds: [101],
      nodeId: 'query-package-test',
    }, actor), { code: 'FORBIDDEN' });
  }

  assert.equal(databaseAccessCount, 0);
});

test('administrator can assign or unassign active USER and REVIEWER accounts with stable identities', async () => {
  const fixture = fakeQueryPackageDatabase();

  const assignedReviewer = await assignQueryPackage(fixture.pool, 9, {
    expectedVersion: 1,
    assignedToUserId: reviewer.username,
    assignedToAccountId: reviewer.userId,
  }, admin);
  assert.equal(assignedReviewer.assignedToAccountId, reviewer.userId);
  assert.equal(assignedReviewer.assignedToUserId, reviewer.username);
  assert.equal(assignedReviewer.assignedToDisplayName, '审核员');
  assert.equal(assignedReviewer.assignedToRole, 'REVIEWER');
  assert.equal(assignedReviewer.assigneeStatus, 'ACTIVE');
  assert.equal(assignedReviewer.version, 2);

  const assignedWorker = await assignQueryPackage(fixture.pool, 9, {
    expectedVersion: 2,
    assignedToUserId: worker.username,
    assignedToAccountId: worker.userId,
  }, admin);
  assert.equal(assignedWorker.assignedToAccountId, worker.userId);
  assert.equal(assignedWorker.assignedToUserId, worker.username);
  assert.equal(assignedWorker.version, 3);
  const unassigned = await assignQueryPackage(fixture.pool, 9, {
    expectedVersion: 3,
    assignedToUserId: null,
    assignedToAccountId: null,
  }, admin);
  assert.equal(unassigned.assignedToAccountId, null);
  assert.equal(unassigned.assignedToUserId, null);
  assert.equal(unassigned.assignedToDisplayName, null);
  assert.equal(unassigned.assignedToRole, null);
  assert.equal(unassigned.assigneeStatus, null);
  assert.equal(unassigned.version, 4);
  assert.ok(fixture.state.sql.some((sql) => (
    sql.startsWith('SELECT id, username FROM app_users')
      && sql.includes("role IN ('REVIEWER', 'USER')")
      && sql.includes('FOR SHARE')
  )));

  const sqlCount = fixture.state.sql.length;
  for (const partialIdentity of [
    { assignedToUserId: worker.username, assignedToAccountId: null },
    { assignedToUserId: null, assignedToAccountId: worker.userId },
  ]) {
    await assert.rejects(assignQueryPackage(fixture.pool, 9, {
      expectedVersion: 4,
      ...partialIdentity,
    }, admin), /must both be null or both identify an account/u);
  }
  assert.equal(fixture.state.sql.length, sqlCount, 'partial identities fail before database access');
});

test('only the stable assigned account can read or screen a package', async () => {
  const fixture = fakeQueryPackageDatabase();
  const detail = await getQueryPackage(fixture.pool, 9, worker);
  assert.equal(detail.assignedToAccountId, worker.userId);
  const readLock = fixture.state.sql.findIndex((sql) => (
    sql.startsWith('SELECT id, assigned_to_account_id, assigned_to_username')
      && sql.includes('FOR SHARE')
  ));
  const itemRead = fixture.state.sql.findIndex((sql) => sql.startsWith('SELECT item.*, production_item.task_id'));
  assert.ok(readLock >= 0 && readLock < itemRead,
    'the assignment must remain share-locked until the complete detail response is assembled');

  await assert.rejects(getQueryPackage(fixture.pool, 9, reviewer), { code: 'FORBIDDEN' });
  await assert.rejects(updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '10101010-1010-4010-8010-101010101010',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, reviewer), { code: 'FORBIDDEN' });
  assert.equal(fixture.state.screeningEvents.length, 0);
});

test('delegated screening records the screener but creates unassigned tasks for the package creator', async () => {
  const fixture = fakeQueryPackageDatabase();
  const screened = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '30303030-3030-4030-8030-303030303030',
    decisions: [
      { itemId: 101, decision: 'SELECT' },
      { itemId: 102, decision: 'REJECT', reason: '不进入生产' },
    ],
  }, worker);

  assert.equal(screened.status, 'USED_UP');
  assert.equal(fixture.state.items.get(101).screened_by_account_id, worker.userId);
  assert.equal(fixture.state.items.get(101).screened_by_username, worker.username);
  assert.equal(fixture.state.batches[0].created_by_account_id, worker.userId);
  assert.equal(fixture.state.batches[0].created_by_username, worker.username);
  assert.equal(fixture.state.tasks[0].created_by_user_id, admin.username);
  assert.equal(fixture.state.tasks[0].assigned_to_user_id, null);
  assert.equal(fixture.state.tasks[0].assignment_source, null);

  const reviewerFixture = fakeQueryPackageDatabase();
  reviewerFixture.state.package = packageRow({
    assigned_to_account_id: reviewer.userId,
    assigned_to_username: reviewer.username,
  });
  await updateQueryPackageScreening(reviewerFixture.pool, 9, {
    expectedVersion: 1,
    requestId: '31313131-3131-4131-8131-313131313131',
    decisions: [
      { itemId: 101, decision: 'REJECT', reason: '复核驳回' },
      { itemId: 102, decision: 'REJECT', reason: '复核驳回' },
    ],
  }, reviewer);
  assert.equal(reviewerFixture.state.items.get(101).screened_by_account_id, reviewer.userId);
  assert.equal(reviewerFixture.state.items.get(101).screened_by_username, reviewer.username);
});

test('automatic tasks do not attribute a deleted package creator username to a replacement account', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ created_by_account_id: null });

  await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '32323232-3232-4232-8232-323232323232',
    decisions: [
      { itemId: 101, decision: 'SELECT' },
      { itemId: 102, decision: 'REJECT', reason: '不进入生产' },
    ],
  }, worker);

  assert.equal(fixture.state.tasks[0].created_by_user_id, null);
  assert.equal(fixture.state.tasks[0].assigned_to_user_id, null);
});

test('production creates unassigned copy work and never propagates a legacy package assignee', async () => {
  const fixture = fakeQueryPackageDatabase();
  const input = {
    expectedVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    decisions: [
      { itemId: 101, decision: 'SELECT' },
      { itemId: 102, decision: 'SELECT' },
    ],
  };
  const screened = await updateQueryPackageScreening(fixture.pool, 9, input, admin);
  const replay = await updateQueryPackageScreening(fixture.pool, 9, input, admin);

  assert.deepEqual(replay, screened);
  assert.equal(screened.status, 'USED_UP');
  assert.equal(screened.version, 2);
  assert.equal(screened.counts.selected, 2, 'mutation responses retain current package counts');
  assert.equal(screened.counts.produced, 2);
  assert.ok([...fixture.state.items.values()].every((item) => item.screening_decision === 'SELECTED'));
  assert.equal(fixture.state.package.status, 'USED_UP');

  assert.equal(fixture.state.batches.length, 1,
    'one screening request creates one production batch for all selected rows');
  assert.deepEqual(fixture.state.batches.map((batch) => batch.query_package_name), [
    '九月选题',
  ], 'every production batch snapshots the package name');
  assert.deepEqual(fixture.state.tasks.map((task) => ({
    state: task.state,
    currentStage: task.current_stage,
    assignedToUserId: task.assigned_to_user_id,
    assignmentSource: task.assignment_source,
    assignedAt: task.assigned_at,
    packageId: task.source_query_package_id,
    packageName: task.source_query_package_name,
    productionBatchId: task.production_batch_id,
  })), [
    { state: 'COPY_QUEUED', currentStage: 'COPY_QUEUED', assignedToUserId: null,
      assignmentSource: null, assignedAt: null, packageId: 9, packageName: '九月选题', productionBatchId: 301 },
    { state: 'COPY_QUEUED', currentStage: 'COPY_QUEUED', assignedToUserId: null,
      assignmentSource: null, assignedAt: null, packageId: 9, packageName: '九月选题', productionBatchId: 301 },
  ], 'formal tasks retain package provenance but do not inherit its legacy owner');
  assert.deepEqual(fixture.state.batchItems.map((item) => item.sourceItemId), [101, 102]);
  assert.equal(new Set(fixture.state.batchItems.map((item) => item.sourceItemId)).size, 2,
    'one source item can create at most one task');
  assert.equal(fixture.state.sql.filter((sql) => (
    sql.startsWith('WITH created AS MATERIALIZED')
      && sql.includes('UPDATE xhs_query_search_jobs AS job')
  )).length, 1, 'the same transaction binds every generated task to its search job once');
  const requestLock = fixture.state.sql.findIndex((sql) => sql.startsWith('SELECT pg_advisory_xact_lock'));
  const receiptRead = fixture.state.sql.findIndex((sql) => sql.includes('FROM query_package_mutation_requests'));
  assert.ok(requestLock >= 0 && requestLock < receiptRead,
    'the request lock must serialize simultaneous first attempts before reading the receipt');
});

test('reject-only screening creates no production batch or task', async () => {
  const fixture = fakeQueryPackageDatabase();
  const screened = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '21212121-2121-4121-8121-212121212121',
    decisions: [
      { itemId: 101, decision: 'REJECT', reason: '不进入生产' },
      { itemId: 102, decision: 'REJECT', reason: '不进入生产' },
    ],
  }, admin);

  assert.equal(screened.status, 'ABANDONED');
  assert.equal(screened.counts.selected, 0);
  assert.equal(screened.counts.produced, 0);
  assert.equal(fixture.state.batches.length, 0);
  assert.equal(fixture.state.tasks.length, 0);
});

test('reconfirming a historical READY and SELECTED row auto-produces it only once', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ status: 'READY' });
  fixture.state.items.get(101).screening_decision = 'SELECTED';
  fixture.state.items.get(102).screening_decision = 'REJECTED';

  const screened = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '23232323-2323-4323-8323-232323232323',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, admin);

  assert.equal(screened.status, 'USED_UP');
  assert.equal(screened.counts.selected, 1);
  assert.equal(screened.counts.produced, 1);
  assert.equal(fixture.state.tasks.length, 1);
  await assert.rejects(updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 2,
    requestId: '24242424-2424-4424-8424-242424242424',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, admin), { code: 'PACKAGE_NOT_SCREENABLE' });
  assert.equal(fixture.state.tasks.length, 1);
});

test('screening all 5000 rows auto-produces selected rows with bounded set SQL', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.items = new Map(Array.from({ length: 5_000 }, (_, index) => {
    const id = index + 1;
    return [id, itemRow(id)];
  }));
  const decisions = [...fixture.state.items.keys()].toReversed().map((itemId, index) => ({
    itemId,
    decision: index % 2 === 0 ? 'SELECT' : 'REJECT',
    reason: `第 ${index + 1} 条人工筛选`,
  }));

  const screened = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '12121212-1212-4212-8212-121212121212',
    decisions,
  }, admin);

  assert.equal(screened.status, 'USED_UP');
  assert.equal(screened.counts.pending, 0);
  assert.equal(screened.counts.selected, 2_500);
  assert.equal(screened.counts.produced, 2_500);
  assert.equal(fixture.state.tasks.length, 2_500);
  assert.equal(fixture.state.batches.length, 1);
  assert.equal(fixture.state.screeningEvents.length, 5_000);
  assert.deepEqual(
    fixture.state.screeningEvents.map((event) => event.itemId),
    decisions.map((decision) => decision.itemId),
    'screening events retain the submitted decision order',
  );
  assert.ok(fixture.state.screeningEvents.every((event) => event.previousDecision === 'PENDING'));

  const setStatements = fixture.state.sql.filter((sql) => (
    sql.startsWith('WITH requested AS MATERIALIZED')
  ));
  assert.equal(setStatements.length, 2, 'one lock/read plus one update/event statement handles the full set');
  assert.ok(setStatements[0].includes('FOR UPDATE OF item'));
  assert.ok(setStatements[1].includes('updated_items AS') && setStatements[1].includes('inserted_events AS'));
  assert.equal(fixture.state.sql.some((sql) => (
    sql.startsWith('SELECT * FROM query_package_items')
      || sql.startsWith('UPDATE query_package_items SET screening_decision')
      || sql.startsWith('INSERT INTO query_package_screening_events')
  )), false, 'screening SQL round trips do not grow with the decision count');
});

test('bulk screening keeps duplicate, ownership, status, version, and affected-count guards', async () => {
  const duplicate = fakeQueryPackageDatabase();
  await assert.rejects(updateQueryPackageScreening(duplicate.pool, 9, {
    expectedVersion: 1,
    requestId: '13131313-1313-4313-8313-131313131313',
    decisions: [
      { itemId: 101, decision: 'SELECT' },
      { itemId: 101, decision: 'REJECT' },
    ],
  }, admin), /item ids must be unique/u);
  assert.equal(duplicate.state.sql.length, 0, 'duplicate IDs fail before starting a transaction');

  for (const [name, configure, expectedCode] of [
    ['wrong package', (fixture) => { fixture.state.items.get(101).query_package_id = 10; }, 'ITEM_NOT_SCREENABLE'],
    ['non-ready item', (fixture) => { fixture.state.items.get(101).status = 'TASK_CREATED'; }, 'ITEM_NOT_SCREENABLE'],
    ['stale package version', (fixture) => { fixture.state.package.version = 2; }, 'VERSION_CONFLICT'],
  ]) {
    const fixture = fakeQueryPackageDatabase();
    configure(fixture);
    await assert.rejects(updateQueryPackageScreening(fixture.pool, 9, {
      expectedVersion: 1,
      requestId: name === 'wrong package'
        ? '14141414-1414-4414-8414-141414141414'
        : name === 'non-ready item'
          ? '15151515-1515-4515-8515-151515151515'
          : '16161616-1616-4616-8616-161616161616',
      decisions: [{ itemId: 101, decision: 'SELECT' }],
    }, admin), { code: expectedCode }, name);
    assert.equal(fixture.state.screeningEvents.length, 0, `${name} must not append an audit event`);
  }

  const incomplete = fakeQueryPackageDatabase();
  incomplete.state.screeningResultOverride = { updatedCount: 1, eventCount: 0 };
  await assert.rejects(updateQueryPackageScreening(incomplete.pool, 9, {
    expectedVersion: 1,
    requestId: '17171717-1717-4717-8717-171717171717',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, admin), { code: 'ITEM_NOT_SCREENABLE' });
});

test('permanent-delete preview aggregates items and batches on independent branches', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql: String(sql).replace(/\s+/gu, ' ').trim(), values });
      return { rows: [{
        id: 9,
        name: '大批量词包',
        status: 'USED_UP',
        version: 4,
        item_count: '5000',
        detached_task_count: '5000',
        production_batch_count: '5000',
      }] };
    },
  };

  const preview = await previewPermanentQueryPackageDeletion(pool, 9, {
    userId: 1,
    username: 'admin',
    role: 'ADMIN',
  });

  assert.deepEqual(preview, {
    id: 9,
    name: '大批量词包',
    status: 'USED_UP',
    version: 4,
    eligible: true,
    itemCount: 5_000,
    detachedTaskCount: 5_000,
    productionBatchCount: 5_000,
    tasksWillBeDeleted: false,
  });
  assert.deepEqual(calls[0].values, [9]);
  assert.equal((calls[0].sql.match(/LEFT JOIN LATERAL/gu) ?? []).length, 2);
  assert.match(calls[0].sql, /item_summary ON true LEFT JOIN LATERAL \( SELECT COUNT\(\*\) AS production_batch_count/u);
});

test('explicit production selections support the full 5000-row package contract', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ status: 'READY' });
  fixture.state.items = new Map(Array.from({ length: 5_000 }, (_, index) => {
    const id = index + 1;
    return [id, itemRow(id, { screening_decision: 'SELECTED' })];
  }));
  const itemIds = [...fixture.state.items.keys()];

  const created = await createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '34343434-3434-4434-8434-343434343434',
    itemIds,
    nodeId: 'large-query-package-test',
  }, admin);

  assert.equal(created.taskIds.length, 5_000);
  assert.equal(fixture.state.tasks.length, 5_000);
  assert.equal(fixture.state.batchItems.length, 5_000);
  assert.equal(fixture.state.package.status, 'USED_UP');
  assert.equal(fixture.state.sql.filter((sql) => sql.startsWith('WITH source_items AS MATERIALIZED')).length, 1,
    'task, batch-item, and source-item writes use one parameterized set operation');
  assert.equal(fixture.state.sql.filter((sql) => sql.startsWith('INSERT INTO tasks')).length, 0,
    'production SQL round trips must not grow with the item count');
  await assert.rejects(createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 2,
    requestId: '35353535-3535-4535-8535-353535353535',
    itemIds: Array.from({ length: 5_001 }, (_, index) => index + 1),
  }, admin), /between 1 and 5000/u);
});

test('an unassigned package can be produced without reading an assignee account', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({
    status: 'READY',
    assigned_to_account_id: null,
    assigned_to_username: null,
  });
  fixture.state.items.get(101).screening_decision = 'SELECTED';
  const created = await createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '36363636-3636-4636-8636-363636363636',
    itemIds: [101],
    nodeId: 'query-package-test',
  }, admin);
  assert.deepEqual(created.taskIds, [501]);
  assert.equal(fixture.state.tasks[0].state, 'COPY_QUEUED');
  assert.equal(fixture.state.tasks[0].assigned_to_user_id, null);
  assert.equal(fixture.state.tasks[0].assignment_source, null);
  assert.equal(fixture.state.tasks[0].assigned_at, null);
  assert.equal(fixture.state.sql.some((sql) => (
    sql.startsWith('SELECT id, username FROM app_users') && sql.includes('FOR KEY SHARE')
  )), false);
});

test('query-package mutations revalidate and lock the immutable actor before business locks or writes', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.activeActors.delete(admin.userId);

  await assert.rejects(updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '37373737-3737-4737-8737-373737373737',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, admin), { code: 'SESSION_STALE' });

  const actorLock = fixture.state.sql.findIndex((sql) => sql.startsWith('SELECT id FROM app_users'));
  const requestLock = fixture.state.sql.findIndex((sql) => sql.startsWith('SELECT pg_advisory_xact_lock'));
  const packageLock = fixture.state.sql.findIndex((sql) => sql.includes('query_packages WHERE id = $1 FOR UPDATE'));
  assert.ok(actorLock >= 0);
  assert.equal(requestLock, -1);
  assert.equal(packageLock, -1);
  assert.equal(fixture.state.items.get(101).screening_decision, 'PENDING');
});

test('a same-name replacement account gets an isolated Query mutation receipt', async () => {
  const fixture = fakeQueryPackageDatabase();
  const requestId = '38383838-3838-4838-8838-383838383838';
  fixture.state.mutations.set(`1:${requestId}`, {
    actor_account_id: 1,
    actor_username: 'admin',
    request_id: requestId,
    operation: 'SCREEN',
    query_package_id: 9,
    request_fingerprint: 'former-account-fingerprint',
    response: { sentinel: 'former-account-response' },
  });
  const replacement = { userId: 2, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  fixture.state.activeActors.set(replacement.userId, {
    id: replacement.userId,
    username: replacement.username,
    role: replacement.role,
    status: 'ACTIVE',
    credentialVersion: replacement.credentialVersion,
  });

  const result = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId,
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, replacement);

  assert.equal(result.counts.selected, 1);
  assert.equal(fixture.state.items.get(101).screening_decision, 'SELECTED');
  assert.equal(fixture.state.mutations.get(`1:${requestId}`).response.sentinel, 'former-account-response');
  assert.deepEqual(fixture.state.mutations.get(`${replacement.userId}:${requestId}`).response, result);
});

test('production retry is idempotent even after the package version advances', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ status: 'READY' });
  for (const row of fixture.state.items.values()) row.screening_decision = 'SELECTED';
  const input = {
    expectedVersion: 1,
    requestId: '44444444-4444-4444-8444-444444444444',
    itemIds: [101],
    nodeId: 'query-package-test',
  };

  const created = await createQueryPackageProductionBatch(fixture.pool, 9, input, admin);
  const replay = await createQueryPackageProductionBatch(fixture.pool, 9, input, admin);
  assert.deepEqual(replay, created);
  assert.equal(fixture.state.tasks.length, 1);
  assert.equal(fixture.state.batches.length, 1);

  await assert.rejects(createQueryPackageProductionBatch(fixture.pool, 9, {
    ...input,
    itemIds: [102],
  }, admin), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(fixture.state.tasks.length, 1);
});

test('permanent package deletion is idempotent and detaches, rather than deletes, produced tasks', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ status: 'USED_UP', version: 4 });
  fixture.state.items.get(101).status = 'TASK_CREATED';
  fixture.state.tasks.push({
    id: 700,
    query: 'durable task',
    source_query_package_id: 9,
    source_query_package_item_id: 101,
    source_query_package_name: '九月选题',
  });
  fixture.state.batchItems.push({ productionBatchId: 301, sourceItemId: 101, taskId: 700 });
  fixture.state.deletionPasswordHash = await hashUserPassword('second-factor');
  const input = {
    expectedVersion: 4,
    requestId: '55555555-5555-4555-8555-555555555555',
    reason: '词包包含错误来源，正式作业需要继续保留',
    confirmationName: '九月选题',
    deletionPassword: 'second-factor',
  };

  const removed = await permanentlyDeleteQueryPackage(fixture.pool, 9, input, admin);
  const replay = await permanentlyDeleteQueryPackage(fixture.pool, 9, input, admin);

  assert.deepEqual(replay, removed);
  assert.deepEqual(removed, { id: 9, permanentlyDeleted: true, detachedTaskCount: 1 });
  assert.equal(fixture.state.tasks.length, 1);
  assert.equal(fixture.state.tasks[0].source_query_package_id, null);
  assert.equal(fixture.state.tasks[0].source_query_package_item_id, null);
  assert.equal(fixture.state.tasks[0].source_query_package_name, '九月选题', 'durable source snapshot remains');
  assert.equal(fixture.state.deletionAudits.length, 1);
  assert.equal(fixture.state.deletionAudits[0].reason, input.reason);
  assert.equal(fixture.state.sql.some((sql) => /^DELETE FROM tasks\b/u.test(sql)), false);
});
