import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const testDatabaseUrl = process.env.AUTO_ASSIGNMENT_TEST_DATABASE_URL;

test('fixed allocation for a new worker stays at five across background replenishment runs', {
  skip: process.env.RUN_POSTGRES_E2E !== '1' && !testDatabaseUrl,
  timeout: 120_000,
}, async () => {
  if (testDatabaseUrl) {
    assert.match(new URL(testDatabaseUrl).pathname, /^\/xhs_auto_assignment_test_[a-f0-9]{32}$/u);
  }
  const database = testDatabaseUrl
    ? { connectionString: testDatabaseUrl, async stop() {} }
    : await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const users = (await repository.pool.query(`
      INSERT INTO app_users(username, display_name, role, password_hash, status, copy_review_enabled)
      VALUES ('allocation-admin', 'Admin', 'ADMIN', 'fake', 'ACTIVE', true),
        ('new-worker', 'New Worker', 'USER', 'fake', 'ACTIVE', true)
      RETURNING id, username, role, credential_version
    `)).rows;
    const administrator = users.find(user => user.role === 'ADMIN');
    const worker = users.find(user => user.role === 'USER');
    const actor = {
      userId: Number(administrator.id), username: administrator.username,
      role: administrator.role, credentialVersion: Number(administrator.credential_version),
    };
    await repository.registerNode({ nodeId: 'allocation-fixture' });
    const tasks = await repository.createTasks({
      nodeId: 'allocation-fixture', createdByUserId: administrator.username,
      assignedToUserId: null,
      tasks: Array.from({ length: 10 }, (_, index) => ({ query: `Fake pending copy ${index + 1}` })),
    });
    // Seed completed generation without invoking any model or executor.
    await repository.pool.query(`
      UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING'
      WHERE id = ANY($1::bigint[])
    `, [tasks.map(task => task.id)]);
    const settings = await repository.updateAutoAssignmentSettings({
      enabled: true, mode: 'FIXED_QUANTITY', expectedVersion: 1, actor,
    });
    let member = await repository.putAutoAssignmentWorker(worker.username, {
      status: 'ACTIVE', assignmentLimit: 5, accountId: Number(worker.id), actor,
    });

    const beforeAllocation = await repository.replenishAutoAssignments();
    assert.equal(beforeAllocation.outcome, 'FIXED_QUANTITY_MODE');
    assert.equal(beforeAllocation.assignedCount, 0);
    assert.equal((await repository.getAutoAssignmentWorker(worker.username)).currentTaskCount, 0);

    const allocation = await repository.allocateAutoAssignmentWorker(worker.username, {
      accountId: Number(worker.id), expectedVersion: member.version, actor,
    });
    assert.equal(allocation.assignedCount, 5);
    assert.equal(allocation.currentTaskCountBefore, 0);
    assert.equal(allocation.currentTaskCountAfter, 5);
    for (let tick = 0; tick < 2; tick += 1) {
      assert.equal((await repository.replenishAutoAssignments()).assignedCount, 0);
    }
    member = await repository.getAutoAssignmentWorker(worker.username);
    assert.equal(member.currentTaskCount, 5);
    assert.equal(member.fixedQuantityAssignedTotal, 5);
    assert.equal(member.fixedQuantityAssignedToday, 5);
    assert.equal((await repository.getAutoAssignmentOverview()).autoAssignableTaskCount, 5);
    assert.equal(Number((await repository.pool.query('SELECT count(*) FROM task_assignment_events')).rows[0].count), 5);

    // Increasing the configured quantity must also leave fixed mode idle.
    await repository.putAutoAssignmentWorker(worker.username, {
      status: 'ACTIVE', assignmentLimit: 6, expectedVersion: member.version,
      accountId: Number(worker.id), actor,
    });
    assert.equal((await repository.replenishAutoAssignments()).outcome, 'FIXED_QUANTITY_MODE');
    assert.equal((await repository.getAutoAssignmentWorker(worker.username)).currentTaskCount, 5);

    // The same worker still receives normal replenishment after an explicit mode switch.
    await repository.updateAutoAssignmentSettings({
      enabled: true, mode: 'CONTINUOUS', expectedVersion: settings.version, actor,
    });
    assert.equal((await repository.replenishAutoAssignments()).assignedCount, 1);
    member = await repository.getAutoAssignmentWorker(worker.username);
    assert.equal(member.currentTaskCount, 6);
    assert.equal(member.fixedQuantityAssignedTotal, 5);
  } finally {
    await repository.pool.end();
    await database.stop();
  }
});
