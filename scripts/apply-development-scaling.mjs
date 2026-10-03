import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadServerEnvironment } from '../server/src/server-environment.mjs';
import { loadMigrations, pendingMigrations } from '../server/src/database-migrations.mjs';
import { configuration, connectDatabase, isMain, safeError } from '../server/scripts/database-common.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';
import { upgradeDatabase } from '../server/scripts/manage-database.mjs';
import { databaseIdentity } from './start-development.mjs';

const reportPath = resolve('reports/scaling-development-migration.json');

export function developmentConfigurations() {
  // Ignore inherited database overrides. This tool is deliberately restricted to this project's development database.
  const dev = configuration(loadServerEnvironment({ profile: 'development', environment: {} }).environment);
  const prod = configuration(loadServerEnvironment({ profile: 'production', environment: {} }).environment);
  assert.equal(databaseIdentity(dev.connectionString).database, 'xhs_control');
  assert.equal(databaseIdentity(prod.connectionString).database, 'xhs_control_prod');
  assert.equal(dev.database, 'xhs_control', 'Refusing an unexpected development database');
  assert.notEqual(dev.display, prod.display, 'Development and production must be separate databases');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(dev.connectionString).hostname));
  return { dev, prod };
}

async function productionFingerprint(config) {
  const client = connectDatabase(config);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control_prod');
    await client.query("SET LOCAL statement_timeout='60s'");
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const migrations = (await client.query('SELECT id,sha256 FROM control_plane_migrations ORDER BY id')).rows;
    const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    const fingerprint = [];
    for (const { tablename } of tables) {
      const name = '"' + tablename.replaceAll('"', '""') + '"';
      const row = (await client.query(`SELECT count(*)::text AS count,
        coalesce(sum(hashtextextended(row_to_json(t)::text,0)::numeric),0)::text AS checksum
        FROM public.${name} t`)).rows[0];
      fingerprint.push({ table: tablename, ...row });
    }
    await client.query('COMMIT');
    return { migrations, tables: fingerprint };
  } finally { await client.end(); }
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 1 && ['--backup-only', '--apply', '--verify-production'].includes(args[0]), 'Use --backup-only, --apply or --verify-production');
  const { dev, prod } = developmentConfigurations();
  try {
    if (args[0] === '--backup-only') {
      const before = await productionFingerprint(prod);
      const client = connectDatabase(dev);
      let applied;
      try { await client.connect(); applied = (await client.query('SELECT id FROM control_plane_migrations')).rows.map(row => row.id); }
      finally { await client.end(); }
      const migrations = (await loadMigrations()).filter(migration => applied.includes(migration.id));
      const backup = await exportDatabase(dev, undefined, migrations);
      await mkdir(resolve('reports'), { recursive: true });
      await writeFile(reportPath, JSON.stringify({ createdAt: new Date().toISOString(), target: dev.display, backup, productionBefore: before }, null, 2));
      console.log(JSON.stringify({ target: dev.display, backup, productionReadOnly: true }));
      return;
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.target, dev.display);
    if (args[0] === '--apply') {
      const client = connectDatabase(dev);
      try {
        await client.connect();
        assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control');
        const migrations = await loadMigrations();
        const pending = await pendingMigrations(client, migrations);
        assert.ok(pending.every(migration => /^010[0-9]_/.test(migration.id)), 'Refusing unrelated pending migrations');
        report.applied = await upgradeDatabase(client, null, migrations);
        report.developmentMigrations = (await client.query("SELECT id,sha256 FROM control_plane_migrations WHERE id LIKE '010%' ORDER BY id")).rows;
      } finally { await client.end(); }
    }
    report.productionAfter = await productionFingerprint(prod);
    report.productionUnchanged = JSON.stringify(report.productionBefore) === JSON.stringify(report.productionAfter);
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    assert.ok(report.productionUnchanged, 'Production changed during the work; inspect legitimate concurrent activity before claiming unchanged');
    console.log(JSON.stringify({ target: dev.display, applied: report.applied, productionUnchanged: true }));
  } catch (error) { throw new Error(safeError(safeError(error, prod), dev)); }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
