import assert from 'node:assert/strict';
import test from 'node:test';

import { listCopyQaItems } from '../src/copy-quality-control.mjs';
import { listDeliveryPool } from '../src/final-delivery.mjs';
import { normalizeListPagination } from '../src/list-pagination.mjs';
import { listQueryPackages } from '../src/query-packages.mjs';

const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });

test('shared list pagination accepts only bounded safe decimal integers', () => {
  assert.deepEqual(normalizeListPagination(), { limit: 50, offset: 0 });
  assert.deepEqual(normalizeListPagination('200', '0010'), { limit: 200, offset: 10 });
  assert.deepEqual(normalizeListPagination(1, Number.MAX_SAFE_INTEGER), {
    limit: 1,
    offset: Number.MAX_SAFE_INTEGER,
  });

  for (const [limit, offset] of [
    ['1.5', '0'],
    ['NaN', '0'],
    ['Infinity', '0'],
    ['', '0'],
    ['0', '0'],
    ['201', '0'],
    ['50', '-1'],
    ['50', '1.5'],
    ['50', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
  ]) {
    assert.throws(() => normalizeListPagination(limit, offset), { name: /^(TypeError|RangeError)$/u });
  }
});

test('Query, QA, and delivery lists reject invalid pagination before PostgreSQL', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; } };
  const operations = [
    (options) => listQueryPackages(pool, options, admin),
    (options) => listCopyQaItems(pool, { status: 'PENDING', ...options }, admin),
    (options) => listDeliveryPool(pool, options, admin),
  ];
  const invalidOptions = [
    { limit: '1.5', offset: '0' },
    { limit: '-1', offset: '0' },
    { limit: 'NaN', offset: '0' },
    { limit: '201', offset: '0' },
    { limit: '50', offset: '-1' },
    { limit: '50', offset: '1.5' },
  ];
  for (const operation of operations) {
    for (const options of invalidOptions) {
      await assert.rejects(operation(options), { name: /^(TypeError|RangeError)$/u });
    }
  }
  assert.equal(queryCount, 0);
});

test('Query, QA, and delivery lists pass normalized integer pagination to PostgreSQL', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values = []) => {
      calls.push({ sql: String(sql), values });
      return { rows: [] };
    },
  };

  await listQueryPackages(pool, { limit: '200', offset: '0010' }, admin);
  await listCopyQaItems(pool, { status: 'PENDING', limit: '200', offset: '0010' }, admin);
  await listDeliveryPool(pool, { limit: '200', offset: '0010' }, admin);

  assert.deepEqual(calls[0].values, [200, 10]);
  assert.deepEqual(calls[1].values, ['PENDING', null, 200, 10]);
  assert.deepEqual(calls[2].values, [200, 10]);
  assert.ok(calls.every(({ values }) => values.every((value) => value !== '200' && value !== '0010')));
});
