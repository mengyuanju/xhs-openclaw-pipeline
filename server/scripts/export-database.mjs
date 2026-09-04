#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadMigrations, pendingMigrations } from '../src/database-migrations.mjs';
import { SERVER_ROOT, connectDatabase, hashFile, isMain, listTables, loadConfiguration, parseOptions, runPg, safeError, tableName } from './database-common.mjs';

export async function exportDatabase(config, outputRoot = join(SERVER_ROOT, 'backups'), migrationList = null) {
  const packagedMigrations = migrationList ?? await loadMigrations();
  await mkdir(outputRoot, { recursive: true });
  const folder = await mkdtemp(join(resolve(outputRoot), 'backup-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-'));
  await mkdir(join(folder, 'tables'));
  await mkdir(join(folder, 'migrations'));
  const client = connectDatabase(config);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await pendingMigrations(client, packagedMigrations);
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const tables = await listTables(client);
    const sequences = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,
      tn.nspname AS "tableSchema", t.relname AS "tableName", a.attname AS "columnName"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.objid=c.oid AND d.deptype IN ('a','i') AND d.classid='pg_class'::regclass
      LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname,c.relname`)).rows;
    for (const sequence of sequences) Object.assign(sequence,
      (await client.query(`SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM ${tableName(sequence)}`)).rows[0]);
    await runPg('pg_dump', ['--no-password', '--format=custom', '--no-owner', '--no-privileges', '--no-tablespaces',
      `--snapshot=${snapshot}`, `--file=${join(folder, 'database.dump')}`], config);
    for (const [index, table] of tables.entries()) {
      table.file = `tables/${String(index + 1).padStart(4, '0')}.jsonl`;
      const file = await open(join(folder, table.file), 'wx');
      const hash = createHash('sha256');
      table.rows = 0;
      try {
        await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${tableName(table)} t`);
        while (true) {
          const rows = (await client.query('FETCH 500 FROM backup_rows')).rows;
          if (!rows.length) break;
          const content = rows.map((row) => row.row + '\n').join('');
          await file.writeFile(content);
          hash.update(content);
          table.rows += rows.length;
        }
        await client.query('CLOSE backup_rows');
      } finally { await file.close(); }
      table.sha256 = hash.digest('hex');
    }
    const pgVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    await client.query('COMMIT');
    await runPg('pg_restore', ['--no-owner', '--no-privileges', '--no-tablespaces', `--file=${join(folder, 'database.sql')}`, join(folder, 'database.dump')], config);
    const migrations = [];
    for (const migration of packagedMigrations) {
      const file = `migrations/${migration.id}.sql`;
      await writeFile(join(folder, file), migration.sql, { flag: 'wx' });
      migrations.push({ id: migration.id, sha256: migration.sha256, file });
    }
    const manifest = { format: 'xhs-control-plane-backup', version: 1, createdAt: new Date().toISOString(),
      databaseName: config.database, pgVersion, tables, sequences, migrations,
      archive: { file: 'database.dump', sha256: await hashFile(join(folder, 'database.dump')) },
      sql: { file: 'database.sql', sha256: await hashFile(join(folder, 'database.sql')) },
      warning: 'Database only. Copy server-storage separately; stored absolute file paths must match the destination.' };
    // Written last: an interrupted export cannot be mistaken for a complete package.
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { folder, tables: tables.length, rows: tables.reduce((sum, table) => sum + table.rows, 0) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

export async function main() {
  const options = parseOptions(process.argv.slice(2), ['out', 'help']);
  if (options.help) { console.log('npm run db:export -- [--out=FOLDER]'); return; }
  const config = loadConfiguration();
  try {
    console.log(`Exporting ${config.display} (read-only snapshot)…`);
    console.log(JSON.stringify(await exportDatabase(config, options.out), null, 2));
    console.log('Database exported. Images/files are separate: also back up CONTROL_PLANE_STORAGE_ROOT.');
  } catch (error) { throw new Error(safeError(error, config)); }
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
