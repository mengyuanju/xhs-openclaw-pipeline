#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import pg from 'pg';

import { pendingMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { loadServerEnvironment } from '../src/server-environment.mjs';
import { configuration, isMain, listTables, parseOptions, quoteId, safeError, tableName } from './database-common.mjs';

export const BASE_CONFIGURATION_TABLES = Object.freeze([
  'prompt_templates',
  'prompt_versions',
  'knowledge_items',
  'knowledge_versions',
  'global_settings',
  'workflow_quality_settings',
]);

const DELETE_ORDER = Object.freeze([
  'prompt_versions',
  'prompt_templates',
  'knowledge_versions',
  'knowledge_items',
  'global_settings',
  'workflow_quality_settings',
]);

// A freshly initialized target contains schema history, default prompts/settings,
// the bootstrap administrator, and disabled assignment/quality singleton rows.
// Every other table must still be empty before a configuration-only import.
export const INITIALIZED_TARGET_TABLES = new Set([
  'control_plane_migrations',
  'app_users',
  'execution_claim_cursors',
  'task_auto_assignment_settings',
  ...BASE_CONFIGURATION_TABLES,
]);

function safeDatabaseError(error, ...configs) {
  return configs.reduce((sanitized, config) => safeError(new Error(sanitized), config), String(error?.message ?? error));
}

export async function configurationFromEnvFile(path) {
  const absolutePath = resolve(path);
  const environment = parseEnv(await readFile(absolutePath, 'utf8'));
  return { ...configuration(environment), envPath: absolutePath };
}

export function configurationFromServerEnvironment(profile) {
  const selected = loadServerEnvironment({ profile });
  return { ...configuration(selected.environment), profile };
}

async function databaseIdentity(client) {
  const result = await client.query(`SELECT current_database() AS database,
    COALESCE(inet_server_addr()::text, 'local-socket') AS host,
    COALESCE(inet_server_port(), 5432) AS port`);
  return result.rows[0];
}

export function assertDifferentDatabases(source, target) {
  if (source.database === target.database && source.host === target.host && Number(source.port) === Number(target.port)) {
    throw new Error(`Source and target resolve to the same database: ${target.host}:${target.port}/${target.database}`);
  }
}

function compatibleTable(source, target) {
  return Boolean(target)
    && JSON.stringify(source.columns) === JSON.stringify(target.columns)
    && JSON.stringify(source.primaryKey) === JSON.stringify(target.primaryKey);
}

export function assertBaseConfigurationSchema(sourceTables, targetTables) {
  for (const name of BASE_CONFIGURATION_TABLES) {
    const source = sourceTables.find((table) => table.schema === 'public' && table.name === name);
    const target = targetTables.find((table) => table.schema === 'public' && table.name === name);
    if (!source || !compatibleTable(source, target)) {
      throw new Error(`Source and target schema differ for public.${name}; initialize both with this release before migrating.`);
    }
  }
}

async function tableRowCount(client, table) {
  const result = await client.query(`SELECT count(*)::text AS count FROM ${tableName(table)}`);
  return BigInt(result.rows[0].count);
}

export async function assertTargetHasNoOperationalData(client, targetTables) {
  const populated = [];
  for (const table of targetTables) {
    if (table.schema !== 'public' || INITIALIZED_TARGET_TABLES.has(table.name)) continue;
    const count = await tableRowCount(client, table);
    if (count > 0n) populated.push(`${tableName(table)}=${count}`);
  }
  if (populated.length) {
    throw new Error(`Target contains operational/user data; configuration-only migration refused: ${populated.join(', ')}`);
  }
  const assignment = await client.query(`SELECT enabled FROM public.task_auto_assignment_settings WHERE singleton = 1`);
  if (assignment.rows[0]?.enabled !== false) {
    throw new Error('Target automatic assignment must exist and be disabled before migration.');
  }
  const executionCursors = await client.query(`SELECT count(*)::int AS count,
    count(last_assignee_user_id)::int AS assigned FROM public.execution_claim_cursors`);
  if (executionCursors.rows[0]?.count !== 2 || executionCursors.rows[0]?.assigned !== 0) {
    throw new Error('Target execution claim cursors must be in their freshly initialized state.');
  }
}

function orderByPrimaryKey(table) {
  if (!table.primaryKey.length) throw new Error(`${tableName(table)} must have a primary key.`);
  return table.primaryKey.map(quoteId).join(',');
}

export async function readConfigurationRows(client, table) {
  const result = await client.query(`SELECT row_to_json(source_row)::text AS row
    FROM ${tableName(table)} AS source_row
    ORDER BY ${orderByPrimaryKey(table)}`);
  return result.rows.map(({ row }) => row);
}

export function insertConfigurationSql(table) {
  const writable = table.columns.filter((column) => !column.generated).map((column) => column.name);
  const columns = writable.map(quoteId).join(',');
  return `INSERT INTO ${tableName(table)} (${columns}) OVERRIDING SYSTEM VALUE
    SELECT ${columns} FROM json_populate_recordset(NULL::${tableName(table)}, $1::json)`;
}

async function insertConfigurationRows(client, table, rows, batchSize = 100) {
  const sql = insertConfigurationSql(table);
  for (let index = 0; index < rows.length; index += batchSize) {
    await client.query(sql, [`[${rows.slice(index, index + batchSize).join(',')}]`]);
  }
}

async function advanceOwnedSequences(client, table) {
  for (const column of table.columns) {
    const sequence = (await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [
      `${table.schema}.${table.name}`, column.name,
    ])).rows[0]?.name;
    if (!sequence) continue;
    await client.query(`SELECT setval($1::regclass,
      COALESCE(MAX(${quoteId(column.name)}), 1), count(*) > 0) FROM ${tableName(table)}`, [sequence]);
  }
}

export function configurationFingerprint(data) {
  const hash = createHash('sha256');
  for (const name of BASE_CONFIGURATION_TABLES) {
    hash.update(name).update('\0');
    for (const row of data.get(name) ?? []) hash.update(row).update('\n');
  }
  return hash.digest('hex');
}

async function readConfiguration(client, tables) {
  const data = new Map();
  for (const name of BASE_CONFIGURATION_TABLES) {
    const table = tables.find((candidate) => candidate.schema === 'public' && candidate.name === name);
    data.set(name, await readConfigurationRows(client, table));
  }
  return data;
}

async function assertNoFileBackedKnowledge(client) {
  const result = await client.query(`SELECT count(*)::text AS count
    FROM public.knowledge_versions WHERE storage_path IS NOT NULL`);
  if (BigInt(result.rows[0].count) > 0n) {
    throw new Error('Source contains file-backed knowledge. Copying database configuration alone would create broken storage paths.');
  }
}

async function assertCurrentSchema(client, migrations, label) {
  const pending = await pendingMigrations(client, migrations);
  if (pending.length) throw new Error(`${label} database has pending migrations: ${pending.map(({ id }) => id).join(', ')}`);
}

export async function migrateBaseConfiguration({ source, target, apply = false }) {
  const sourceClient = new pg.Client({ connectionString: source.connectionString, connectionTimeoutMillis: 10_000 });
  const targetClient = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await sourceClient.connect();
    await targetClient.connect();
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await sourceClient.query("SET LOCAL TIME ZONE 'UTC'");
    await targetClient.query("SET TIME ZONE 'UTC'");

    const [sourceIdentity, targetIdentity] = await Promise.all([
      databaseIdentity(sourceClient), databaseIdentity(targetClient),
    ]);
    assertDifferentDatabases(sourceIdentity, targetIdentity);

    const migrations = await loadMigrations();
    await assertCurrentSchema(sourceClient, migrations, 'Source');
    await assertCurrentSchema(targetClient, migrations, 'Target');
    await assertNoFileBackedKnowledge(sourceClient);

    const [sourceTables, targetTables] = await Promise.all([
      listTables(sourceClient), listTables(targetClient),
    ]);
    assertBaseConfigurationSchema(sourceTables, targetTables);
    await assertTargetHasNoOperationalData(targetClient, targetTables);

    const sourceData = await readConfiguration(sourceClient, sourceTables);
    const before = await readConfiguration(targetClient, targetTables);
    const summary = BASE_CONFIGURATION_TABLES.map((name) => ({
      table: `public.${name}`,
      sourceRows: sourceData.get(name).length,
      targetRowsBefore: before.get(name).length,
    }));

    if (!apply) {
      await sourceClient.query('COMMIT');
      return { mode: 'PREVIEW', source: source.display, target: target.display, tables: summary };
    }

    await targetClient.query('BEGIN');
    try {
      await targetClient.query("SET LOCAL lock_timeout = '10s'");
      await targetClient.query('SELECT pg_advisory_xact_lock(4310, 8203)');
      await assertTargetHasNoOperationalData(targetClient, targetTables);
      for (const name of DELETE_ORDER) await targetClient.query(`DELETE FROM public.${quoteId(name)}`);
      for (const name of BASE_CONFIGURATION_TABLES) {
        const table = targetTables.find((candidate) => candidate.schema === 'public' && candidate.name === name);
        await insertConfigurationRows(targetClient, table, sourceData.get(name));
        await advanceOwnedSequences(targetClient, table);
      }
      const after = await readConfiguration(targetClient, targetTables);
      if (configurationFingerprint(after) !== configurationFingerprint(sourceData)) {
        throw new Error('Target verification failed: copied configuration differs from the source snapshot.');
      }
      await assertTargetHasNoOperationalData(targetClient, targetTables);
      await targetClient.query('COMMIT');
      await sourceClient.query('COMMIT');
      return {
        mode: 'APPLY', source: source.display, target: target.display,
        tables: summary.map((entry) => ({ ...entry, targetRowsAfter: entry.sourceRows })),
      };
    } catch (error) {
      await targetClient.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    await sourceClient.query('ROLLBACK').catch(() => {});
    throw new Error(safeDatabaseError(error, source, target));
  } finally {
    await Promise.all([sourceClient.end().catch(() => {}), targetClient.end().catch(() => {})]);
  }
}

export async function main() {
  const options = parseOptions(process.argv.slice(2), [
    'source-env', 'target-env', 'source-environment', 'target-environment', 'apply', 'help',
  ]);
  if (options.help) {
    console.log('npm run db:migrate:base-config -- --source-environment=development --target-environment=production [--apply]');
    return;
  }
  const sourceSelectors = [options['source-env'], options['source-environment']].filter(Boolean);
  const targetSelectors = [options['target-env'], options['target-environment']].filter(Boolean);
  if (sourceSelectors.length !== 1 || targetSelectors.length !== 1) {
    throw new Error('Select each database exactly once with --source-environment/--target-environment or --source-env/--target-env.');
  }
  const source = options['source-environment']
    ? configurationFromServerEnvironment(options['source-environment'])
    : await configurationFromEnvFile(options['source-env']);
  const target = options['target-environment']
    ? configurationFromServerEnvironment(options['target-environment'])
    : await configurationFromEnvFile(options['target-env']);
  const result = await migrateBaseConfiguration({ source, target, apply: Boolean(options.apply) });
  console.log(JSON.stringify(result, null, 2));
  if (!options.apply) console.log('Preview only. Re-run with --apply after verifying the source, target, and table counts.');
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
