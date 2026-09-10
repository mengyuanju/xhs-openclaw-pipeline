import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueryPackageProductionBatch,
  permanentlyDeleteQueryPackage,
  previewPermanentQueryPackageDeletion,
  updateQueryPackageScreening,
} from '../src/query-packages.mjs';
import { hashUserPassword } from '../src/user-auth.mjs';

const worker = Object.freeze({ userId: 22, username: 'worker-22', role: 'USER' });

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
    assignee: { id: 22, username: 'worker-22', status: 'ACTIVE', role: 'USER' },
    activeActors: new Map([
      [1, { id: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 }],
      [22, { id: 22, username: 'worker-22', role: 'USER', credentialVersion: 1 }],
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
          && (values[3] === null || actor.credentialVersion === Number(values[3]))
        ? [{ id: actor.id }] : [] };
    }
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] };
    if (source.startsWith('SELECT package.*') && source.includes('GROUP BY package.id')) {
      if (!state.package || Number(values[0]) !== state.package.id) return { rows: [] };
      const items = [...state.items.values()].filter((item) => item.query_package_id === state.package.id);
      return { rows: [{
        ...state.package,
        total_count: String(items.length),
        pending_count: String(items.filter((item) => item.status === 'READY'
          && item.screening_decision === 'PENDING').length),
        selected_count: String(items.filter((item) => item.status === 'READY'
          && item.screening_decision === 'SELECTED').length),
        rejected_count: String(items.filter((item) => item.screening_decision === 'REJECTED').length),
        produced_count: String(items.filter((item) => item.status === 'TASK_CREATED').length),
        invalid_count: String(items.filter((item) => item.status === 'INVALID').length),
        duplicate_count: String(items.filter((item) => item.status === 'DUPLICATE').length),
      }] };
    }
    if (source === 'SELECT * FROM query_packages WHERE id = $1') {
      return { rows: state.package && Number(values[0]) === state.package.id ? [{ ...state.package }] : [] };
    }
    if (source.startsWith('SELECT * FROM query_packages WHERE id = $1 FOR UPDATE')) {
      return { rows: state.package && Number(values[0]) === state.package.id ? [{ ...state.package }] : [] };
    }
    if (source.startsWith('SELECT id, username FROM app_users') && source.includes('FOR KEY SHARE')) {
      const user = state.assignee;
      return { rows: user && user.id === Number(values[0]) && user.username === values[1]
          && user.status === 'ACTIVE' && user.role === 'USER'
        ? [{ id: user.id, username: user.username }] : [] };
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
      const items = [...state.items.values()].filter((item) => (
        item.query_package_id === Number(values[0]) && item.status === 'READY'
      ));
      return { rows: [{
        pending_count: String(items.filter((item) => item.screening_decision === 'PENDING').length),
        selected_count: String(items.filter((item) => item.screening_decision === 'SELECTED').length),
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
      const batchId = Number(values[6]);
      const created = [];
      for (const sourceItemId of requestedIds) {
        const item = state.items.get(sourceItemId);
        if (!item || item.query_package_id !== packageId || item.status !== 'READY'
            || item.screening_decision !== 'SELECTED') continue;
        const taskId = state.tasks.length + 501;
        state.tasks.push({ id: taskId, query: item.query, source_query_package_item_id: sourceItemId });
        state.batchItems.push({ productionBatchId: batchId, sourceItemId, taskId });
        item.status = 'TASK_CREATED';
        item.version += 1;
        created.push({ task_id: taskId, source_query_package_item_id: sourceItemId });
      }
      return { rows: created };
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

test('an assigned worker can screen and produce while worker import is disabled', async () => {
  const fixture = fakeQueryPackageDatabase();
  const screened = await updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    decisions: [
      { itemId: 101, decision: 'SELECT' },
      { itemId: 102, decision: 'SELECT' },
    ],
  }, worker);

  assert.equal(screened.status, 'READY');
  assert.equal(screened.version, 2);
  assert.equal(screened.counts.selected, 2, 'mutation responses retain current package counts');
  assert.ok([...fixture.state.items.values()].every((item) => item.screening_decision === 'SELECTED'));

  const first = await createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 2,
    requestId: '22222222-2222-4222-8222-222222222222',
    itemIds: [101],
    nodeId: 'query-package-test',
  }, worker);
  assert.deepEqual(first.taskIds, [501]);
  assert.equal(fixture.state.package.status, 'PARTIALLY_USED');

  const second = await createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 3,
    requestId: '33333333-3333-4333-8333-333333333333',
    itemIds: [102],
    nodeId: 'query-package-test',
  }, worker);
  assert.deepEqual(second.taskIds, [502]);
  assert.equal(fixture.state.package.status, 'USED_UP');

  assert.equal(fixture.state.batches.length, 2, 'the selected rows were split into two production batches');
  assert.deepEqual(fixture.state.batchItems.map((item) => item.sourceItemId), [101, 102]);
  assert.equal(new Set(fixture.state.batchItems.map((item) => item.sourceItemId)).size, 2,
    'one source item can create at most one task');
  const requestLock = fixture.state.sql.findIndex((sql) => sql.startsWith('SELECT pg_advisory_xact_lock'));
  const receiptRead = fixture.state.sql.findIndex((sql) => sql.includes('FROM query_package_mutation_requests'));
  assert.ok(requestLock >= 0 && requestLock < receiptRead,
    'the request lock must serialize simultaneous first attempts before reading the receipt');
});

test('screening all 5000 rows uses bounded set SQL and preserves audit input order', async () => {
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
  }, worker);

  assert.equal(screened.status, 'READY');
  assert.equal(screened.counts.pending, 0);
  assert.equal(screened.counts.selected, 2_500);
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
  }, worker), /item ids must be unique/u);
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
    }, worker), { code: expectedCode }, name);
    assert.equal(fixture.state.screeningEvents.length, 0, `${name} must not append an audit event`);
  }

  const incomplete = fakeQueryPackageDatabase();
  incomplete.state.screeningResultOverride = { updatedCount: 1, eventCount: 0 };
  await assert.rejects(updateQueryPackageScreening(incomplete.pool, 9, {
    expectedVersion: 1,
    requestId: '17171717-1717-4717-8717-171717171717',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, worker), { code: 'ITEM_NOT_SCREENABLE' });
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
  }, worker);

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
  }, worker), /between 1 and 5000/u);
});

test('production rejects a deleted or same-name replacement assignee before creating tasks', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.package = packageRow({ status: 'READY' });
  fixture.state.items.get(101).screening_decision = 'SELECTED';
  fixture.state.assignee = { id: 99, username: 'worker-22', status: 'ACTIVE', role: 'USER' };
  const admin = { userId: 1, username: 'admin', role: 'ADMIN' };

  await assert.rejects(createQueryPackageProductionBatch(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '36363636-3636-4636-8636-363636363636',
    itemIds: [101],
    nodeId: 'query-package-test',
  }, admin), { code: 'ASSIGNEE_UNAVAILABLE' });
  assert.equal(fixture.state.tasks.length, 0);
  assert.equal(fixture.state.batches.length, 0);
});

test('query-package mutations revalidate and lock the immutable actor before business locks or writes', async () => {
  const fixture = fakeQueryPackageDatabase();
  fixture.state.activeActors.delete(worker.userId);

  await assert.rejects(updateQueryPackageScreening(fixture.pool, 9, {
    expectedVersion: 1,
    requestId: '37373737-3737-4737-8737-373737373737',
    decisions: [{ itemId: 101, decision: 'SELECT' }],
  }, worker), { code: 'SESSION_STALE' });

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

  const created = await createQueryPackageProductionBatch(fixture.pool, 9, input, worker);
  const replay = await createQueryPackageProductionBatch(fixture.pool, 9, input, worker);
  assert.deepEqual(replay, created);
  assert.equal(fixture.state.tasks.length, 1);
  assert.equal(fixture.state.batches.length, 1);

  await assert.rejects(createQueryPackageProductionBatch(fixture.pool, 9, {
    ...input,
    itemIds: [102],
  }, worker), { code: 'REQUEST_ID_CONFLICT' });
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

  const admin = { userId: 1, username: 'admin', role: 'ADMIN' };
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
