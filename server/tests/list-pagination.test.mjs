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
      if (sql.includes('SELECT id FROM app_users')) return { rows: [{ id: 1 }] };
      if (sql.includes('SELECT DISTINCT task.production_batch_id')) return { rows: [] };
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
  assert.match(calls[1].sql,
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY item\.final_approver_account_id[\s\S]*?\) AS approver_queue_round/u,
    'copy QA rows receive a stable round within each final approver queue');
  assert.match(calls[1].sql,
    /ORDER BY task\.priority_paused ASC, approver_queue_round ASC,\s*task\.priority_sort_at ASC, task\.id ASC, item\.id ASC/u,
    'copy QA list interleaves approvers before showing the next item from one approver');
});

test('delegated Query-package lists are scoped to the stable assigned account', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values = []) => {
      calls.push({ sql: String(sql), values });
      return { rows: [] };
    },
  };

  await listQueryPackages(pool, { limit: '25', offset: '5' }, {
    userId: 91,
    username: 'reviewer',
    role: 'REVIEWER',
  });

  assert.deepEqual(calls[0].values, [91, 'reviewer', 25, 5]);
  assert.match(calls[0].sql,
    /package\.assigned_to_account_id = \$1 AND package\.assigned_to_username = \$2/u);
  assert.match(calls[0].sql, /visible_item\.screening_assigned_to_account_id = \$1/u,
    'delegated lists include packages with Query items assigned to the stable account');
  assert.match(calls[0].sql, /LIMIT \$3 OFFSET \$4/u);
});
