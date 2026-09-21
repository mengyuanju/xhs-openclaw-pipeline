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
  Object.freeze({
    id: '0043_xhs_search_node_retirement',
    fromSha256: '5fe8515be0d71cf5e2771659ab9563ed2b2a798d481f01990b416a1ad439ec2b',
    toSha256: '3e77c608d7f945a39564c2a1100882e49ffb12a4dc72477bd56dd828033c5f7e',
    repairedBy: '0044_xhs_search_node_retirement_compatibility_repair',
    repairSha256: 'b1053fff6696176449ef9a20c79ad0d05a680cbc23f5c6f5a9d1026bb3de35ba',
    schemaProbe: 'xhs-search-node-retired-at-v1',
  }),
  Object.freeze({
    id: '0057_executor_image_edit_capability',
    fromSha256: '1b32a068b4082ea161ec2b5524eef185e92721491472de579df071936ff0f7a0',
    toSha256: '8a1843b241b8fb08f6a1cf8260d7193929a1590e6864932883ce3f1b2eba9d00',
    repairedBy: '0059_executor_image_edit_capability_compatibility_repair',
    repairSha256: '56a4e0c4eb6cc869b8b3a7c4e6837b56ee22d33e20781f900f696befb41b68ee',
  }),
  Object.freeze({
    id: '0082_standalone_image_editor',
    fromSha256: '6fc2b847522767a31097699476ac9727580e7552cd00a7b7ea5103febbad87d1',
    toSha256: 'cb4885cc3d69ef3ad7a852798b64393b2a42808f65a00e3b852e2854131e6bff',
    repairedBy: '0083_standalone_image_editor_compatibility_repair',
    repairSha256: '3b01cdac08f0c44ccc05ed4bcda70440fe6c9870f14ffed5c2773347cf08805f',
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

async function legacySchemaMatches(client, upgrade) {
  if (!upgrade.schemaProbe) return true;
  if (upgrade.schemaProbe === 'xhs-search-node-retired-at-v1') {
    const result = await client.query(`SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'xhs_query_search_nodes'
        AND column_name = 'retired_at'`);
    return result.rows.length === 1
      && result.rows[0].data_type === 'timestamp with time zone'
      && result.rows[0].is_nullable === 'YES';
  }
  return false;
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
    const upgrade = source?.sha256 === entry.sha256 ? null : LEGACY_MIGRATION_UPGRADES.find((candidate) => (
      candidate.id === entry.id
      && candidate.fromSha256 === entry.sha256
      && candidate.toSha256 === source?.sha256
    ));
    if (upgrade && !(await legacySchemaMatches(client, upgrade))) {
      throw new Error(`Migration ${entry.id} legacy schema is incompatible; use a compatible code/backup version.`);
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
