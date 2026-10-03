#!/usr/bin/env node
import assert from 'node:assert/strict';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { databaseIdentity } from './start-development.mjs';
import { connectDatabase, isMain, safeError } from '../server/scripts/database-common.mjs';
import { MAINTENANCE_TABLES, maintainDatabaseTables, readDatabaseMaintenanceMetrics } from '../server/src/database-maintenance.mjs';

export function maintenanceOptions(args) {
  const result = { maintain: false, tuneAutovacuum: false, tables: [] };
  const seen = new Set();
  for (const arg of args) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new Error('Duplicate maintenance option');
    seen.add(key);
    if (arg === '--maintain') result.maintain = true;
    else if (arg === '--autovacuum') result.tuneAutovacuum = true;
    else if (arg.startsWith('--tables=')) result.tables = arg.slice(9).split(',');
    else throw new Error('Use [--maintain --tables=tasks,assets] [--autovacuum]');
  }
  if (result.tables.some(table => !MAINTENANCE_TABLES.includes(table))
    || new Set(result.tables).size !== result.tables.length) throw new Error('Unknown or duplicate maintenance table');
  if (result.maintain && !result.tables.length || result.tuneAutovacuum && !result.maintain) {
    throw new Error('Maintenance needs --maintain and explicit --tables; --autovacuum also needs --maintain');
  }
  return result;
}

export function assertDevelopmentMaintenanceTarget(dev, production) {
  const selected = databaseIdentity(dev.connectionString), other = databaseIdentity(production.connectionString);
  assert.equal(selected.host, 'loopback', 'Maintenance is limited to the local development database');
  assert.equal(selected.database, 'xhs_control', 'Maintenance is limited to xhs_control');
  assert.notDeepEqual(selected, other, 'Development and production targets must differ');
}

export async function main(args = process.argv.slice(2)) {
  const options = maintenanceOptions(args);
  const { dev, prod } = developmentConfigurations(); // Ignore inherited connection overrides.
  assertDevelopmentMaintenanceTarget(dev, prod);
  const client = connectDatabase(dev);
  try {
    await client.connect();
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control');
    const before = await readDatabaseMaintenanceMetrics(client);
    const actions = options.maintain ? await maintainDatabaseTables(client, before, options) : [];
    const after = options.maintain ? await readDatabaseMaintenanceMetrics(client) : undefined;
    console.log(JSON.stringify({ developmentOnly: true, mode: options.maintain ? 'MAINTENANCE' : 'READ_ONLY', before, actions, after }, null, 2));
  } catch (error) { throw new Error(safeError(error, dev)); }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
