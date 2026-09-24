import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import {
  createSavedTaskReportQuery,
  deleteSavedTaskReportQuery,
  listSavedTaskReportQueries,
  normalizeSavedTaskReportQueryConfig,
  updateSavedTaskReportQuery,
} from '../src/saved-task-report-queries.mjs';

const relativeQuery = {
  time: { field: 'FIRST_MANUAL_COPY_ASSIGNMENT', mode: 'RELATIVE', days: 30 },
  match: 'ANY',
  conditions: [
    { field: 'ANNOTATOR', op: 'EQ', value: 12 },
    { field: 'COPY_QA_REVIEWER', op: 'EQ', value: 14 },
    { field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: 15 },
    { field: 'LAST_COPY_REVIEWER', op: 'EQ', value: 16 },
    { field: 'LAST_IMAGE_REVIEWER', op: 'EQ', value: 17 },
    { field: 'REJECTION_COUNT', op: 'GTE', value: 2 },
  ],
  sort: 'TASK_ID', order: 'ASC', pageSize: 50, page: 4,
};

test('saved report config preserves relative date semantics and removes current page', () => {
  const config = normalizeSavedTaskReportQueryConfig(relativeQuery);
  assert.deepEqual(config.time, { field: 'FIRST_MANUAL_COPY_ASSIGNMENT', mode: 'RELATIVE', days: 30 });
  assert.equal(config.page, undefined);
  assert.equal(config.conditions.length, 6);
  assert.deepEqual(normalizeSavedTaskReportQueryConfig({
    time: { field: 'IMAGE_QA_RELEASED_AT', mode: 'ABSOLUTE', from: '2026-09-01', to: '2026-09-24' },
  }).time, { field: 'IMAGE_QA_RELEASED_AT', mode: 'ABSOLUTE', from: '2026-09-01', to: '2026-09-24' });
  assert.deepEqual(normalizeSavedTaskReportQueryConfig({
    time: { field: 'CREATED_AT', mode: 'ABSOLUTE', from: '2024-01-01', to: '2026-09-24' },
  }).time, { field: 'CREATED_AT', mode: 'ABSOLUTE', from: '2024-01-01', to: '2026-09-24' });
});

test('saved report config rejects unsupported conditions and invalid date intervals', () => {
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    conditions: [{ field: 'SECRET_SQL', op: 'EQ', value: 'x' }],
  }), /condition field/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    conditions: [{ field: 'ANNOTATOR', op: 'EQ', value: 'alice' }],
  }), /account ID/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    time: { mode: 'RELATIVE', days: 30, from: '2026-09-01' },
  }), /fixed dates/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    time: { mode: 'ABSOLUTE', from: '2026-02-29', to: '2026-03-01' },
  }), /real calendar date/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    time: { mode: 'ABSOLUTE', from: '2026-09-24', to: '2026-09-01' },
  }), /after/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    conditions: [{ field: 'IMAGE_STATUS', op: 'EQ', value: 'INVENTED_STATUS' }],
  }), /status/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    conditions: [{ field: 'REASSIGNMENT_COUNT', op: 'GTE', value: 100_001 }],
  }), /100000/u);
  assert.throws(() => normalizeSavedTaskReportQueryConfig({
    conditions: Array.from({ length: 21 }, () => ({ field: 'TASK_ID', op: 'EQ', value: 1 })),
  }), /20 entries/u);
});

test('saved task report queries enforce administrator ownership, defaults and uniqueness in PostgreSQL', {
  skip: process.env.RUN_SAVED_TASK_REPORT_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  const database = await startTemporaryPostgres18('xhs-saved-report-');
  const pool = new Pool({ connectionString: database.connectionString });
  try {
    await pool.query(`CREATE TABLE app_users (
      id bigserial PRIMARY KEY, username varchar(50) NOT NULL UNIQUE,
      role varchar(20) NOT NULL, status varchar(20) NOT NULL,
      credential_version integer NOT NULL DEFAULT 1
    )`);
    const migration = await readFile(fileURLToPath(new URL('../migrations/0092_saved_task_report_queries.sql', import.meta.url)), 'utf8');
    await pool.query(migration);
    const users = (await pool.query(`INSERT INTO app_users(username,role,status)
      VALUES ('admin-a','ADMIN','ACTIVE'),('admin-b','ADMIN','ACTIVE'),
        ('reviewer','REVIEWER','ACTIVE') RETURNING *`)).rows;
    const actor = (row) => ({ userId: Number(row.id), username: row.username,
      role: row.role, credentialVersion: Number(row.credential_version) });
    const [a, b, reviewer] = users.map(actor);
    const first = await createSavedTaskReportQuery(pool, a, {
      name: '  近 30 天  ', query: relativeQuery, isDefault: true,
    });
    assert.equal(first.name, '近 30 天');
    assert.equal(first.isDefault, true);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.query.page, undefined);
    await assert.rejects(createSavedTaskReportQuery(pool, a, {
      name: '近 30 天', query: relativeQuery,
    }), (error) => error.code === 'SAVED_REPORT_QUERY_NAME_EXISTS');
    const second = await createSavedTaskReportQuery(pool, a, {
      name: '图片质检', query: { time: { field: 'IMAGE_QA_RELEASED_AT', mode: 'ABSOLUTE',
        from: '2026-09-01', to: '2026-09-24' } },
    });
    assert.equal((await listSavedTaskReportQueries(pool, b)).length, 0);
    await assert.rejects(updateSavedTaskReportQuery(pool, b, first.id, { name: '盗用' }),
      (error) => error.code === 'NOT_FOUND');
    await assert.rejects(deleteSavedTaskReportQuery(pool, b, first.id),
      (error) => error.code === 'NOT_FOUND');
    const updated = await updateSavedTaskReportQuery(pool, a, second.id, { isDefault: true });
    assert.equal(updated.isDefault, true);
    const listed = await listSavedTaskReportQueries(pool, a);
    assert.deepEqual(listed.map((item) => [item.id, item.isDefault]),
      [[second.id, true], [first.id, false]]);
    await assert.rejects(listSavedTaskReportQueries(pool, reviewer),
      (error) => error.code === 'FORBIDDEN');
    await pool.query(`UPDATE app_users SET status = 'DISABLED' WHERE id = $1`, [a.userId]);
    await assert.rejects(listSavedTaskReportQueries(pool, a),
      (error) => error.code === 'SESSION_STALE');
    await pool.query(`UPDATE app_users SET status = 'ACTIVE' WHERE id = $1`, [a.userId]);
    assert.deepEqual(await deleteSavedTaskReportQuery(pool, a, first.id),
      { id: first.id, deleted: true });
  } finally {
    await pool.end();
    await database.stop();
  }
});
