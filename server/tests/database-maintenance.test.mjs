import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceOptions, assertDevelopmentMaintenanceTarget } from '../../scripts/maintain-development-database.mjs';
import { maintainDatabaseTables, recommendTableMaintenance } from '../src/database-maintenance.mjs';

test('maintenance defaults to reads and refuses production or inherited alternate targets', () => {
  assert.deepEqual(maintenanceOptions([]), { maintain: false, tuneAutovacuum: false, tables: [] });
  for (const args of [['--maintain'], ['--autovacuum'], ['--tables=tasks;DROP'], ['--environment=production'], ['--tables=tasks,tasks']]) assert.throws(() => maintenanceOptions(args));
  assert.deepEqual(maintenanceOptions(['--maintain', '--tables=tasks', '--autovacuum']), { maintain: true, tuneAutovacuum: true, tables: ['tasks'] });
  const dev = { connectionString: 'postgresql://test@127.0.0.1:5432/xhs_control' }, production = { connectionString: 'postgresql://test@localhost:5432/xhs_control_prod' };
  assert.doesNotThrow(() => assertDevelopmentMaintenanceTarget(dev, production));
  for (const target of [production, { connectionString: 'postgresql://test@remote:5432/xhs_control' }]) assert.throws(() => assertDevelopmentMaintenanceTarget(target, production));
  assert.throws(() => assertDevelopmentMaintenanceTarget(dev, dev));
});

test('table maintenance uses estimated churn and never global or FULL commands', async () => {
  const tables = [
    { name: 'tasks', live_rows: '1000000', dead_rows: '50000', changes_since_analyze: '1', xid_age: '100', last_autoanalyze: 'today' },
    { name: 'assets', live_rows: '1000000', dead_rows: '0', changes_since_analyze: '60000', xid_age: '100', last_autoanalyze: 'today' },
  ];
  const recommendations = recommendTableMaintenance(tables);
  assert.deepEqual(recommendations.map(row => row.action), ['VACUUM_ANALYZE', 'ANALYZE']);
  const queries = [], client = { query: async sql => { queries.push(sql); return { rows: [{ locked: true }] }; } };
  await maintainDatabaseTables(client, { tables, recommendations }, { tables: ['tasks', 'assets'], tuneAutovacuum: true });
  assert.ok(queries.includes('VACUUM (ANALYZE, SKIP_LOCKED, TRUNCATE FALSE, PARALLEL 0) public."tasks"'));
  assert.ok(queries.includes('ANALYZE (SKIP_LOCKED) public."assets"'));
  assert.equal(queries.some(sql => /ALTER SYSTEM|VACUUM FULL|REINDEX|SET GLOBAL/iu.test(sql)), false);
  assert.ok(queries.includes('RESET statement_timeout'));
  await assert.rejects(maintainDatabaseTables(client, { tables, recommendations }, { tables: ['pg_authid'] }), /allowed tables/);
});
