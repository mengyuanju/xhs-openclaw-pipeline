import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { maintainDatabaseTables, readDatabaseMaintenanceMetrics } from '../src/database-maintenance.mjs';

test('maintenance metrics and table-only vacuum/options work in isolated PostgreSQL 18', {
  skip: process.env.RUN_SCALING_POSTGRES !== '1', timeout: 60_000,
}, async () => {
  const cluster = await startTemporaryPostgres18();
  const client = new pg.Client({ connectionString: cluster.connectionString });
  try {
    await client.connect();
    await client.query('CREATE TABLE tasks(id bigint PRIMARY KEY, value text); INSERT INTO tasks SELECT n,\'test\' FROM generate_series(1,10) n');
    const globals = (await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('autovacuum_max_workers','autovacuum_vacuum_scale_factor') ORDER BY name")).rows;
    const metrics = await readDatabaseMaintenanceMetrics(client);
    assert.equal(metrics.estimates, true); assert.equal(metrics.tables[0].name, 'tasks');
    assert.ok(Number(metrics.tables[0].total_bytes) > 0); assert.equal(metrics.database.name, 'postgres');
    metrics.recommendations = [{ table: 'tasks', action: 'VACUUM_ANALYZE' }];
    const actions = await maintainDatabaseTables(client, metrics, { tables: ['tasks'], tuneAutovacuum: true });
    assert.equal(actions.length, 2);
    metrics.recommendations = [{ table: 'tasks', action: 'ANALYZE' }];
    assert.equal((await maintainDatabaseTables(client, metrics, { tables: ['tasks'] }))[0].action, 'ANALYZE');
    const options = (await client.query("SELECT reloptions FROM pg_class WHERE oid='tasks'::regclass")).rows[0].reloptions;
    assert.ok(options.includes('autovacuum_vacuum_scale_factor=0.02'));
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM tasks')).rows[0].n, 10);
    assert.deepEqual((await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('autovacuum_max_workers','autovacuum_vacuum_scale_factor') ORDER BY name")).rows, globals);
    assert.equal((await client.query("SELECT setting FROM pg_settings WHERE name='lock_timeout'")).rows[0].setting, '0');
    assert.equal((await readDatabaseMaintenanceMetrics(client)).tables[0].name, 'tasks');
  } finally { await client.end(); await cluster.stop(); }
});
