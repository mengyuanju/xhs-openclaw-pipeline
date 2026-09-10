import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const MIGRATION_TABLE = 'control_plane_migrations';
export const sha256 = (content) => createHash('sha256').update(content).digest('hex');
export const normalizeMigrationSql = (sql) => sql.replace(/\r\n?/gu, '\n');

// These are directional upgrades from migration drafts that were applied to
// local databases before their hardened canonical forms were published. Keep
// the recorded database checksum intact for auditability and only accept a
// known source when the exact forward repair is present in the same package.
export const LEGACY_MIGRATION_UPGRADES = Object.freeze([
  Object.freeze({
    id: '0026_final_delivery',
    fromSha256: '99a236324d33b10f1b66c0822795b83954fa2a8edf2c322ae2017c6316df8437',
    toSha256: '496437c949b78d6e73bdbdac281be56cdb645088494f08ebeaf2637f33750998',
    repairedBy: '0029_final_delivery_compatibility_repair',
    repairSha256: 'c0fb5534891b2c5d842ed48d9f2922bdd17443c368cc1c2ce393dc7c33b0fee6',
  }),
  Object.freeze({
    id: '0027_delivery_archive_integrity',
    fromSha256: 'bfeba2869813a17adf1119e688c965faa920a1206874ae95671b289ca296a2e3',
    toSha256: '09164b5253709ee635acdeb8ea2caad8942325e7b87f735b1ce0b8a0937aff1b',
    repairedBy: '0029_final_delivery_compatibility_repair',
    repairSha256: 'c0fb5534891b2c5d842ed48d9f2922bdd17443c368cc1c2ce393dc7c33b0fee6',
  }),
]);

export function isAppliedMigrationCompatible(entry, source, migrations) {
  if (!source) return false;
  if (source.sha256 === entry.sha256) return true;
  const upgrade = LEGACY_MIGRATION_UPGRADES.find((candidate) => (
    candidate.id === entry.id
    && candidate.fromSha256 === entry.sha256
    && candidate.toSha256 === source.sha256
  ));
  if (!upgrade) return false;
  const repair = migrations.find((migration) => migration.id === upgrade.repairedBy);
  return repair?.sha256 === upgrade.repairSha256;
}

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
    if (!isAppliedMigrationCompatible(entry, source, migrations)) {
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
