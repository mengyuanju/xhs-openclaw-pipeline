import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueryPackage, normalizeQueryPackageItems } from '../src/query-packages.mjs';

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
  assert.throws(() => normalizeQueryPackageItems([]), /between 1 and 5000/u);
  assert.throws(() => normalizeQueryPackageItems([null]), /must be a string or object/u);
  const [row] = normalizeQueryPackageItems([{ query: '合法 Query', input: 'bad', imageCount: 8 }]);
  assert.equal(row.status, 'INVALID');
  assert.deepEqual(row.validationErrors, ['INPUT_INVALID', 'IMAGE_COUNT_INVALID']);
  assert.deepEqual(row.input, {});
});

test('query package import writes all 5000 rows in bounded parameterized chunks', async () => {
  const fixture = fakeQueryPackageImportDatabase();
  const result = await createQueryPackage(fixture.pool, {
    name: '5000 条 Query 词包',
    sourceFileName: 'full-boundary.json',
    assignedToUserId: 'legacy-worker',
    requestId: '91919191-9191-4191-8191-919191919191',
    items: Array.from({ length: 5_000 }, (_, index) => ({
      externalId: `query-${index + 1}`,
      query: `边界 Query ${index + 1}`,
      input: { ordinal: index + 1 },
      requestedImageCount: index % 2 === 0 ? 'auto' : 3,
    })),
  }, admin);

  assert.equal(result.counts.total, 5_000);
  assert.equal(result.counts.pending, 5_000);
  assert.equal(result.assignedToUserId, null);
  assert.equal(result.assignedToAccountId, null);
  assert.equal(fixture.state.items.length, 5_000);
  assert.equal(fixture.state.items[0].rowNumber, 1);
  assert.equal(fixture.state.items.at(-1).rowNumber, 5_000);
  const itemWrites = fixture.state.calls.filter(({ sql }) => sql.startsWith('INSERT INTO query_package_items'));
  const packageWrite = fixture.state.calls.find(({ sql }) => sql.startsWith('INSERT INTO query_packages'));
  assert.deepEqual(packageWrite.values.slice(4, 6), [null, null],
    'deprecated assignee input must not establish ownership on new packages');
  assert.equal(itemWrites.length, 10, '5000 rows use ten bounded 500-row SQL round trips');
  assert.ok(itemWrites.every(({ sql, values }) => sql.includes('jsonb_array_elements($2::jsonb)')
    && values.length === 2 && values[0] === 9), 'all imported content stays in value parameters');
});
