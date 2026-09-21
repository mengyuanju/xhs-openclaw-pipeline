import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { preserveTextPrimaryKeyNullability } from '../preview-service/scripts/generate-migration.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = resolve(projectRoot, 'preview-service');
const drizzleRoot = resolve(previewRoot, 'drizzle');
const d1Root = resolve(previewRoot, 'd1-migrations');

const historicalMigrations = [
  ['20260910044753_orange_mattie_franklin', '0000_orange_mattie_franklin.sql'],
  ['20260910045701_rich_doomsday', '0001_rich_doomsday.sql'],
  ['20260910082127_massive_pete_wisdom', '0002_massive_pete_wisdom.sql'],
  ['20260911054300_vengeful_kinsey_walden', '0003_vengeful_kinsey_walden.sql'],
];

function normalizeSql(sql) {
  return sql.replace(/\r\n/gu, '\n').trimEnd();
}

async function applyMigration(database, path) {
  const sql = await readFile(path, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
}

test('preview migration wrapper preserves NOT NULL on text primary keys', () => {
  assert.equal(
    preserveTextPrimaryKeyNullability('CREATE TABLE `sample` (`id` text PRIMARY KEY, `value` text);'),
    'CREATE TABLE `sample` (`id` text PRIMARY KEY NOT NULL, `value` text);',
  );
  assert.equal(
    preserveTextPrimaryKeyNullability('CREATE TABLE `sample` (`id` text PRIMARY KEY NOT NULL);'),
    'CREATE TABLE `sample` (`id` text PRIMARY KEY NOT NULL);',
  );
});

test('Drizzle snapshots and immutable D1 migration SQL stay synchronized', async () => {
  const wrangler = await readFile(resolve(previewRoot, 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /"migrations_dir"\s*:\s*"d1-migrations"/u);

  for (const [directory, d1File] of historicalMigrations) {
    const drizzleSql = await readFile(resolve(drizzleRoot, directory, 'migration.sql'), 'utf8');
    const d1Sql = await readFile(resolve(d1Root, d1File), 'utf8');
    assert.equal(normalizeSql(d1Sql), normalizeSql(drizzleSql), d1File);
  }

  const directories = (await readdir(drizzleRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !historicalMigrations.some(([historical]) => historical === name));
  assert.ok(directories.length > 0, 'expected at least one post-conversion migration');
  for (const directory of directories) {
    const drizzleSql = await readFile(resolve(drizzleRoot, directory, 'migration.sql'), 'utf8');
    const d1Sql = await readFile(resolve(d1Root, `${directory}.sql`), 'utf8');
    assert.equal(normalizeSql(d1Sql), normalizeSql(drizzleSql), directory);
  }
});

test('preview compatibility migration preserves existing rows, constraints and foreign keys', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    for (const [, d1File] of historicalMigrations) {
      await applyMigration(database, resolve(d1Root, d1File));
    }
    database.prepare(`
      INSERT INTO previews (
        id, public_id, title, body, tags_json, status, image_count,
        content_hash, source_ref, created_at, published_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('preview-1', 'public-1', '升级样本', '正文', '["标签"]', 'PUBLISHED', 1,
      'content-hash', 'xhs:delivery:1', 100, 100, null);
    database.prepare(`
      INSERT INTO preview_assets (
        id, preview_id, position, object_key, original_name,
        media_type, byte_size, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('asset-1', 'preview-1', 1, 'previews/preview-1/original.png', '原图.png',
      'image/png', 128, 'asset-hash', 100);

    const directories = (await readdir(drizzleRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !historicalMigrations.some(([historical]) => historical === name))
      .sort();
    for (const directory of directories) {
      await applyMigration(database, resolve(d1Root, `${directory}.sql`));
    }

    assert.deepEqual({ ...database.prepare('SELECT id, title, source_ref FROM previews').get() }, {
      id: 'preview-1', title: '升级样本', source_ref: 'xhs:delivery:1',
    });
    assert.deepEqual({ ...database.prepare('SELECT id, preview_id, byte_size FROM preview_assets').get() }, {
      id: 'asset-1', preview_id: 'preview-1', byte_size: 128,
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const primaryKeyColumns = database.prepare(`
      SELECT name, "notnull" AS not_null
      FROM pragma_table_info(?)
      WHERE pk > 0
    `).all('previews');
    assert.deepEqual(primaryKeyColumns.map((row) => ({ ...row })), [{ name: 'id', not_null: 1 }]);
    assert.throws(() => database.prepare(`
      INSERT INTO previews (
        id, public_id, title, body, tags_json, status, image_count,
        content_hash, created_at, published_at
      ) VALUES (NULL, 'public-null', '标题', '', '[]', 'PUBLISHED', 1, 'hash-null', 1, 1)
    `).run(), /NOT NULL constraint failed/u);
  } finally {
    database.close();
  }
});
