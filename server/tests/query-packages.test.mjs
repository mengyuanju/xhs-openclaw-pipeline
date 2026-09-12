import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueryPackage,
  getQueryPackage,
  normalizeQueryPackageItemAssignmentInput,
  normalizeQueryPackageItemPageOptions,
  normalizeQueryPackageItems,
} from '../src/query-packages.mjs';

const admin = Object.freeze({
  userId: 1,
  username: 'admin',
  role: 'ADMIN',
  credentialVersion: 1,
});

function fakeQueryPackageImportDatabase() {
  const state = { calls: [], items: [] };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.calls.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT id FROM app_users') && source.includes('FOR SHARE')) {
      return { rows: [{ id: admin.userId }] };
    }
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT * FROM query_package_mutation_requests')) return { rows: [] };
    if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1') return { rows: [] };
    if (source.startsWith('INSERT INTO query_packages')) {
      return { rows: [{
        id: 9,
        name: values[0],
        source_file_name: values[1],
        status: 'IMPORTED',
        created_by_account_id: values[2],
        created_by_username: values[3],
        assigned_to_account_id: values[4],
        assigned_to_username: values[5],
        version: 1,
        created_at: new Date('2026-09-10T00:00:00.000Z'),
        updated_at: new Date('2026-09-10T00:00:00.000Z'),
      }] };
    }
    if (source.startsWith('INSERT INTO query_package_items')) {
      const packageId = Number(values[0]);
      const chunk = JSON.parse(values[1]);
      state.items.push(...chunk.map((item) => ({ ...item, packageId })));
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO query_package_mutation_requests')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, pool: { connect: async () => client, query } };
}

test('query package import retains invalid and duplicate rows without making them producible', () => {
  const rows = normalizeQueryPackageItems([
    { externalId: 'a', query: '桌面整理', input: { category: 'home' }, requestedImageCount: 3 },
    { externalId: 'b', query: '  桌面   整理  ' },
    { externalId: 'c', query: '' },
    { externalId: 'd', query: 'x'.repeat(501) },
  ]);
  assert.deepEqual(rows.map(({ status, screeningDecision }) => ({ status, screeningDecision })), [
    { status: 'READY', screeningDecision: 'PENDING' },
    { status: 'DUPLICATE', screeningDecision: 'REJECTED' },
    { status: 'INVALID', screeningDecision: 'REJECTED' },
    { status: 'INVALID', screeningDecision: 'REJECTED' },
  ]);
  assert.deepEqual(rows[1].validationErrors, ['DUPLICATE_QUERY']);
  assert.deepEqual(rows[2].validationErrors, ['QUERY_EMPTY']);
  assert.equal(rows[3].query, null);
});

test('query package import validates its bounded rows and untrusted input', () => {
  assert.throws(() => normalizeQueryPackageItems([]), /between 1 and 10000/u);
  assert.throws(() => normalizeQueryPackageItems(Array.from({ length: 10_001 }, () => 'Query')), /10000/u);
  assert.throws(() => normalizeQueryPackageItems([null]), /must be a string or object/u);
  const [row] = normalizeQueryPackageItems([{ query: '合法 Query', input: 'bad', imageCount: 8 }]);
  assert.equal(row.status, 'INVALID');
  assert.deepEqual(row.validationErrors, ['INPUT_INVALID', 'IMAGE_COUNT_INVALID']);
  assert.deepEqual(row.input, {});
});

test('query package import writes all 10000 rows in bounded parameterized chunks', async () => {
  const fixture = fakeQueryPackageImportDatabase();
  const result = await createQueryPackage(fixture.pool, {
    name: '10000 条 Query 词包',
    sourceFileName: 'full-boundary.json',
    assignedToUserId: 'legacy-worker',
    requestId: '91919191-9191-4191-8191-919191919191',
    items: Array.from({ length: 10_000 }, (_, index) => ({
      externalId: `query-${index + 1}`,
      query: `边界 Query ${index + 1}`,
      input: { ordinal: index + 1 },
      requestedImageCount: index % 2 === 0 ? 'auto' : 3,
    })),
  }, admin);

  assert.equal(result.counts.total, 10_000);
  assert.equal(result.counts.pending, 10_000);
  assert.equal(result.assignedToUserId, null);
  assert.equal(result.assignedToAccountId, null);
  assert.equal(fixture.state.items.length, 10_000);
  assert.equal(fixture.state.items[0].rowNumber, 1);
  assert.equal(fixture.state.items.at(-1).rowNumber, 10_000);
  const itemWrites = fixture.state.calls.filter(({ sql }) => sql.startsWith('INSERT INTO query_package_items'));
  const packageWrite = fixture.state.calls.find(({ sql }) => sql.startsWith('INSERT INTO query_packages'));
  assert.deepEqual(packageWrite.values.slice(4, 6), [null, null],
    'deprecated assignee input must not establish ownership on new packages');
  assert.equal(itemWrites.length, 20, '10000 rows use twenty bounded 500-row SQL round trips');
  assert.ok(itemWrites.every(({ sql, values }) => sql.includes('jsonb_array_elements($2::jsonb)')
    && values.length === 2 && values[0] === 9), 'all imported content stays in value parameters');
});

test('query package item pagination validates filters, search and keyset cursors', () => {
  assert.deepEqual(normalizeQueryPackageItemPageOptions({
    limit: '200', filter: 'pending', search: '  桌面   收纳  ', cursor: '400:9001',
  }), {
    limit: 200,
    filter: 'PENDING',
    search: '桌面 收纳',
    cursor: { rowNumber: 400, itemId: 9001 },
  });
  assert.equal(normalizeQueryPackageItemPageOptions({}), null);
  assert.throws(() => normalizeQueryPackageItemPageOptions({ limit: '201' }), /between 1 and 200/u);
  assert.throws(() => normalizeQueryPackageItemPageOptions({ limit: '20', filter: 'unknown' }), /itemFilter/u);
  assert.throws(() => normalizeQueryPackageItemPageOptions({ limit: '20', cursor: 'bad' }), /itemCursor/u);
});

test('Query item assignment accepts even and explicit-count strategies with bounded unique users', () => {
  assert.deepEqual(normalizeQueryPackageItemAssignmentInput({
    expectedVersion: 3,
    requestId: '92929292-9292-4292-8292-929292929292',
    strategy: 'even',
    assignees: [{ accountId: 7 }, { accountId: 8 }],
  }), {
    expectedVersion: 3,
    requestId: '92929292-9292-4292-8292-929292929292',
    strategy: 'EVEN',
    assignees: [{ accountId: 7 }, { accountId: 8 }],
  });
  assert.deepEqual(normalizeQueryPackageItemAssignmentInput({
    expectedVersion: 3,
    requestId: '93939393-9393-4393-8393-939393939393',
    strategy: 'COUNTS',
    assignees: [{ accountId: 7, count: 20 }, { accountId: 8, count: 10 }],
  }).assignees, [{ accountId: 7, count: 20 }, { accountId: 8, count: 10 }]);
  assert.throws(() => normalizeQueryPackageItemAssignmentInput({
    expectedVersion: 1,
    requestId: '94949494-9494-4494-8494-949494949494',
    strategy: 'COUNTS',
    assignees: [{ accountId: 7, count: 1 }, { accountId: 7, count: 2 }],
  }), /must be unique/u);
});

test('query package detail returns a bounded keyset page without loading the full package', async () => {
  const calls = [];
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    calls.push({ source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT id, assigned_to_account_id')) {
      return { rows: [{ id: 9, assigned_to_account_id: null, assigned_to_username: null }] };
    }
    if (source.startsWith('SELECT package.*')) {
      return { rows: [{
        id: 9,
        name: '分页词包',
        status: 'SCREENING',
        version: 4,
        total_count: '10',
        pending_count: '8',
        selected_count: '1',
        rejected_count: '1',
        produced_count: '1',
        created_by_username: 'admin',
        created_at: new Date('2026-09-12T00:00:00.000Z'),
      }] };
    }
    if (source.startsWith('SELECT COUNT(*) AS total')) return { rows: [{ total: '3' }] };
    if (source.startsWith('SELECT item.*, production_item.task_id')) {
      return { rows: [11, 12, 13].map((rowNumber) => ({
        id: 90 + rowNumber,
        row_number: rowNumber,
        raw_query: `桌面 Query ${rowNumber}`,
        query: `桌面 Query ${rowNumber}`,
        input: {},
        requested_image_count: 'auto',
        status: 'READY',
        validation_errors: [],
        screening_decision: 'PENDING',
        screening_reason: null,
        task_id: null,
        version: 1,
      })) };
    }
    if (source.startsWith('SELECT batch.*')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  const detail = await getQueryPackage({ connect: async () => client }, 9, admin, {
    limit: '2', filter: 'PENDING', search: '桌面', cursor: '10:100',
  });

  assert.deepEqual(detail.items.map((item) => item.rowNumber), [11, 12]);
  assert.deepEqual(detail.itemPage, { total: 3, returnedCount: 2, hasMore: true, nextCursor: '12:102' });
  const pageCall = calls.find(({ source }) => source.startsWith('SELECT item.*, production_item.task_id'));
  assert.deepEqual(pageCall.values, [9, 'PENDING', '桌面', 10, 100, 3]);
  assert.match(pageCall.source, /ORDER BY item\.row_number, item\.id LIMIT \$6/u);
});
