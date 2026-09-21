import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

test('PostgreSQL: copy QA reason tags create private requests and directly published admin tags', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120_000,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-reason-tags-');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: postgres.connectionString });
  t.after(async () => { await pool.end(); await postgres.stop(); });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMigrations(client, await loadMigrations());
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const repository = new PostgresControlPlaneRepository({ pool });
  const actors = [];
  for (const [username, role] of [['reason-admin', 'ADMIN'], ['reason-reviewer', 'REVIEWER']]) {
    const row = (await pool.query(`INSERT INTO app_users(
      username, display_name, role, password_hash, copy_qc_enabled
    ) VALUES ($1, $1, $2, 'test-only', true) RETURNING *`, [username, role])).rows[0];
    actors.push({
      userId: Number(row.id),
      username,
      role,
      credentialVersion: Number(row.credential_version),
    });
  }
  const [admin, reviewer] = actors;

  const published = await repository.createCopyQaReasonTag({
    group: 'BODY', label: '管理员直接公开', requestPublic: true,
  }, { actor: admin });
  assert.equal(published.visibility, 'PUBLIC');
  assert.equal(published.status, 'ACTIVE');
  assert.equal(published.ownedByActor, true);

  const pending = await repository.createCopyQaReasonTag({
    group: 'PLAN', label: '质检员申请公开', requestPublic: true,
  }, { actor: reviewer });
  assert.equal(pending.visibility, 'PRIVATE');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.ownedByActor, true);

  const rows = (await pool.query(`SELECT label, public_requested_at, public_reviewed_at,
    public_reviewed_by_account_id, public_reviewed_by_username
    FROM copy_qa_reason_tags ORDER BY id`)).rows;
  assert.equal(rows[0].public_requested_at instanceof Date, true);
  assert.equal(rows[0].public_reviewed_at instanceof Date, true);
  assert.equal(Number(rows[0].public_reviewed_by_account_id), admin.userId);
  assert.equal(rows[0].public_reviewed_by_username, admin.username);
  assert.equal(rows[1].public_requested_at instanceof Date, true);
  assert.equal(rows[1].public_reviewed_at, null);
  assert.equal(rows[1].public_reviewed_by_account_id, null);
  assert.equal(rows[1].public_reviewed_by_username, null);
});
