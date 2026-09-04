import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const MIGRATION_TABLE = 'control_plane_migrations';
export const sha256 = (content) => createHash('sha256').update(content).digest('hex');
export const normalizeMigrationSql = (sql) => sql.replace(/\r\n?/gu, '\n');

export async function loadMigrations() {
  const baseline = normalizeMigrationSql(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const migrations = [{ id: '0001_baseline', sql: baseline.replace(/^BEGIN;\s*/u, '').replace(/COMMIT;\s*$/u, '') }];
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.sql')) continue;
    if (!/^\d{4}_[a-z0-9_-]+\.sql$/u.test(name) || name <= '0001_baseline.sql') {
      throw new Error(`Invalid migration filename: ${name}`);
    }
    migrations.push({ id: name.slice(0, -4), sql: normalizeMigrationSql(await readFile(new URL(name, directory), 'utf8')) });
  }
  return migrations.map((migration) => ({ ...migration, sha256: sha256(migration.sql) }));
}

export async function pendingMigrations(client, migrations) {
  const exists = await client.query("SELECT to_regclass('public.control_plane_migrations') AS name");
  const applied = exists.rows[0]?.name
    ? (await client.query('SELECT id, sha256 FROM public.control_plane_migrations ORDER BY id')).rows : [];
  for (const entry of applied) {
    const source = migrations.find((migration) => migration.id === entry.id);
    if (!source || source.sha256 !== entry.sha256) {
      throw new Error(`Migration ${entry.id} is missing or changed; use a compatible code/backup version.`);
    }
  }
  return migrations.filter((migration) => !applied.some((entry) => entry.id === migration.id));
}

// Caller owns the transaction, so migrations and an incremental data merge can commit together.
export async function applyMigrations(client, migrations) {
  await client.query('SELECT pg_advisory_xact_lock(4310, 8202)');
  const pending = await pendingMigrations(client, migrations);
  await client.query(`CREATE TABLE IF NOT EXISTS public.control_plane_migrations (
    id text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const migration of pending) {
    await client.query(migration.sql);
    await client.query('INSERT INTO public.control_plane_migrations(id, sha256) VALUES ($1, $2)', [migration.id, migration.sha256]);
  }
  return pending.map((migration) => migration.id);
}

export async function migrateDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO public');
    const applied = await applyMigrations(client, await loadMigrations());
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
