#!/usr/bin/env node
import { applyMigrations, loadMigrations, MIGRATION_TABLE, pendingMigrations } from '../src/database-migrations.mjs';
import { connectDatabase, isMain, listTables, loadConfiguration, packagePath, parseOptions, quoteId, readBackup, rowBatches, runPg, safeError, tableName } from './database-common.mjs';

export async function assertEmptyDatabase(client) {
  const result = await client.query(`SELECT n.nspname,c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f')
    AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' LIMIT 1`);
  if (result.rows.length) throw new Error('Target database is not empty. Full import refused; use db:upgrade or a new empty database.');
  const routines = await client.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' LIMIT 1`);
  if (routines.rows.length) throw new Error('Target database contains routines. Full import requires an empty database.');
}

export function assertCompatibleTable(source, target) {
  if (!target || JSON.stringify(source.columns) !== JSON.stringify(target.columns)
    || JSON.stringify(source.primaryKey) !== JSON.stringify(target.primaryKey)) {
    throw new Error(`Schema mismatch for ${tableName(source)}. Add a versioned SQL migration before exporting; manual schema changes cannot be inferred safely.`);
  }
  if (!source.primaryKey.length) throw new Error(`${tableName(source)} has no primary key; safe incremental merge is not supported.`);
}

export function mergeSql(table) {
  const fields = table.columns.filter((column) => !column.generated).map((column) => column.name);
  const writable = fields.filter((field) => !table.primaryKey.includes(field));
  const names = fields.map(quoteId).join(',');
  const update = writable.length ? `DO UPDATE SET ${writable.map((name) => `${quoteId(name)}=EXCLUDED.${quoteId(name)}`).join(',')}
    WHERE ROW(${writable.map((name) => `target.${quoteId(name)}`).join(',')}) IS DISTINCT FROM
          ROW(${writable.map((name) => `EXCLUDED.${quoteId(name)}`).join(',')})` : 'DO NOTHING';
  return `INSERT INTO ${tableName(table)} AS target (${names}) OVERRIDING SYSTEM VALUE
    SELECT ${names} FROM json_populate_recordset(NULL::${tableName(table)}, $1::json)
    ON CONFLICT (${table.primaryKey.map(quoteId).join(',')}) ${update}`;
}

// Reject obvious cross-database ID collisions instead of replacing unrelated tasks/versions.
export function identityCheckSql(table) {
  const naturalKeys = { prompt_templates: ['kind'], prompt_versions: ['template_id', 'version'],
    knowledge_versions: ['item_id', 'version'], copy_revisions: ['task_id', 'revision'],
    image_runs: ['task_id', 'execution_id'], task_executions: ['task_id', 'kind', 'node_id'] };
  const columns = new Set(table.columns.map((column) => column.name));
  const identity = ['created_at', 'started_at', ...(naturalKeys[table.name] ?? [])].filter((name) => columns.has(name));
  if (!identity.length) return null;
  return `SELECT 1 FROM ${tableName(table)} t JOIN json_populate_recordset(NULL::${tableName(table)}, $1::json) s
    ON ${table.primaryKey.map((name) => `t.${quoteId(name)}=s.${quoteId(name)}`).join(' AND ')}
    WHERE ${identity.map((name) => `t.${quoteId(name)} IS DISTINCT FROM s.${quoteId(name)}`).join(' OR ')} LIMIT 1`;
}

async function mergeTable(client, table, backup) {
  let changed = 0;
  let read = 0;
  const identitySql = identityCheckSql(table);
  for await (const batch of rowBatches(packagePath(backup.root, table.file))) {
    // Keep JSON numeric tokens intact (bigint IDs must not pass through JavaScript Number).
    const data = '[' + batch.join(',') + ']';
    if (identitySql && (await client.query(identitySql, [data])).rows.length) {
      throw new Error(`ID collision in ${tableName(table)}: immutable identity differs. Only merge databases derived from the same source.`);
    }
    changed += (await client.query(mergeSql(table), [data])).rowCount;
    read += batch.length;
  }
  if (read !== table.rows) throw new Error(`Row count mismatch in ${tableName(table)}`);
  return { table: tableName(table), sourceRows: read, insertedOrUpdated: changed };
}

async function advanceSequences(client, sequences) {
  for (const sequence of sequences) {
    const name = tableName(sequence);
    const current = (await client.query(`SELECT last_value::text AS value,is_called AS called FROM ${name}`)).rows[0];
    let value = BigInt(current.value) > BigInt(sequence.lastValue) ? BigInt(current.value) : BigInt(sequence.lastValue);
    let called = current.called || sequence.isCalled;
    if (sequence.tableName && sequence.columnName) {
      const maximum = (await client.query(`SELECT max(${quoteId(sequence.columnName)})::text AS value
        FROM ${tableName({ schema: sequence.tableSchema, name: sequence.tableName })}`)).rows[0].value;
      if (maximum !== null) { if (BigInt(maximum) > value) value = BigInt(maximum); called = true; }
    }
    // Never rewind an existing sequence. On a later commit failure, harmless gaps may remain.
    await client.query('SELECT setval($1::regclass,$2::bigint,$3)', [name, value.toString(), called]);
  }
}

export async function upgradeDatabase(client, backup, migrations) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query('SET LOCAL search_path TO public');
    const applied = await applyMigrations(client, migrations);
    const changed = [];
    if (backup) {
      const sourceTables = backup.manifest.tables.filter((table) => !(table.schema === 'public' && table.name === MIGRATION_TABLE));
      const targetTables = await listTables(client);
      for (const table of sourceTables) {
        assertCompatibleTable(table, targetTables.find((target) => target.schema === table.schema && target.name === table.name));
      }
      if (sourceTables.length) await client.query(`LOCK TABLE ${sourceTables.map(tableName).join(',')} IN ACCESS EXCLUSIVE MODE`);
      // Cyclic task/current-execution/current-revision foreign keys must be checked after all rows are merged.
      const constraints = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,
        con.conname,con.condeferrable,con.condeferred FROM pg_constraint con
        JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE con.contype='f' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'`)).rows;
      for (const constraint of constraints) {
        await client.query(`ALTER TABLE ${tableName(constraint)} ALTER CONSTRAINT ${quoteId(constraint.conname)} DEFERRABLE INITIALLY DEFERRED`);
      }
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of sourceTables) {
        // A newly published version must not collide with the target's previous published version.
        // Status changes and this preparation are in the same transaction and roll back together.
        if (table.schema === 'public' && ['prompt_versions', 'knowledge_versions'].includes(table.name)) {
          const parent = table.name === 'prompt_versions' ? 'template_id' : 'item_id';
          for await (const batch of rowBatches(packagePath(backup.root, table.file))) {
            await client.query(`UPDATE ${tableName(table)} t SET status='ARCHIVED'
              FROM json_populate_recordset(NULL::${tableName(table)},$1::json) s
              WHERE s.status='PUBLISHED' AND t.status='PUBLISHED' AND t.${quoteId(parent)}=s.${quoteId(parent)} AND t.id<>s.id`, ['[' + batch.join(',') + ']']);
          }
        }
        changed.push(await mergeTable(client, table, backup));
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const constraint of constraints) {
        await client.query(`ALTER TABLE ${tableName(constraint)} ALTER CONSTRAINT ${quoteId(constraint.conname)} ${constraint.condeferrable
          ? `DEFERRABLE INITIALLY ${constraint.condeferred ? 'DEFERRED' : 'IMMEDIATE'}` : 'NOT DEFERRABLE'}`);
      }
      await advanceSequences(client, backup.manifest.sequences);
    }
    await client.query('COMMIT');
    return { appliedMigrations: applied, changed };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function main() {
  const command = process.argv[2];
  if (!['init', 'upgrade'].includes(command)) throw new Error('Use manage-database.mjs init|upgrade');
  const options = parseOptions(process.argv.slice(3), ['from', 'apply', 'help']);
  if (options.help) { console.log(`npm run db:${command} -- ${command === 'init' ? '--from=BACKUP_FOLDER' : '[--from=BACKUP_FOLDER]'} [--apply]`); return; }
  if (command === 'init' && !options.from) throw new Error('Full import requires --from=BACKUP_FOLDER');
  const config = loadConfiguration();
  const client = connectDatabase(config);
  try {
    const backup = options.from ? await readBackup(options.from) : null;
    await client.connect();
    if (command === 'init') await assertEmptyDatabase(client);
    const migrations = backup?.migrations ?? await loadMigrations();
    console.log(JSON.stringify({ mode: options.apply ? 'APPLY' : 'PREVIEW', command, target: config.display,
      backup: backup?.root ?? null, tables: backup?.manifest.tables.map((table) => ({ name: tableName(table), rows: table.rows })) ?? [],
      pendingMigrations: command === 'upgrade' ? (await pendingMigrations(client, migrations)).map((migration) => migration.id) : [],
      policy: command === 'init' ? 'Empty database only. No dropping existing tables.' : 'Source wins matching IDs; no row deletion. Stop services/workers and back up target first.' }, null, 2));
    if (!options.apply) { console.log('Preview only. Re-run with --apply to execute. Only use trusted backup packages.'); return; }
    if (command === 'init') {
      await assertEmptyDatabase(client);
      await runPg('pg_restore', ['--no-password', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--no-tablespaces',
        `--dbname=${config.database}`, packagePath(backup.root, backup.manifest.archive.file)], config);
      console.log('Full import completed. Table data, constraints and sequences restored.');
    } else console.log(JSON.stringify(await upgradeDatabase(client, backup, migrations), null, 2));
    if (backup) console.log('Images are not included. Copy server-storage separately and check stored absolute paths before starting services.');
  } catch (error) { throw new Error(safeError(error, config)); }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
