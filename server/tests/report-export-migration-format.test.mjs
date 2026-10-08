import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigrations,
  isAppliedMigrationCompatible,
  loadMigrations,
  pendingMigrations,
  sha256,
} from '../src/database-migrations.mjs';

const exportId = '0104_persistent_report_exports';
const legacyHash = '19ec5722b874ac43433abcbcc4032b9611fe0f8977c6a14d67bd5f9ea9bc1dff';
const canonicalHash = '9473e9be624e3519cf01ea7d4b35e27718dbe2532a8c70aadb0df0bd22e92e5c';

async function exportMigration() {
  return (await loadMigrations()).find(({ id }) => id === exportId);
}

function fakeClient(applied) {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('to_regclass')) return { rows: [{ name: 'present' }] };
      if (sql === 'SELECT id, sha256 FROM public.control_plane_migrations ORDER BY id') {
        return { rows: applied };
      }
      if (sql.startsWith('INSERT INTO public.control_plane_migrations')) {
        applied.push({ id: values[0], sha256: values[1] });
      }
      return { rows: [] };
    },
  };
}

test('0104 accepts the exact historical trailing-LF version and the canonical version', async () => {
  const source = await exportMigration();
  assert.equal(source.sha256, canonicalHash);
  assert.equal(sha256(`${source.sql}\n`), legacyHash);
  assert.equal(isAppliedMigrationCompatible({ id: exportId, sha256: legacyHash }, source, [source]), true);
  assert.equal(isAppliedMigrationCompatible({ id: exportId, sha256: canonicalHash }, source, [source]), true);
});

test('0104 rejects unknown hashes, other formatting variants, other IDs and downgrade', async () => {
  const source = await exportMigration();
  for (const checksum of ['0'.repeat(64), sha256(`${source.sql}\n\n`), sha256(source.sql.trimEnd())]) {
    assert.equal(isAppliedMigrationCompatible({ id: exportId, sha256: checksum }, source, [source]), false);
  }
  assert.equal(isAppliedMigrationCompatible({ id: '0105_other', sha256: legacyHash }, source, [source]), false);
  const legacySource = { ...source, sql: `${source.sql}\n`, sha256: legacyHash };
  assert.equal(isAppliedMigrationCompatible({ id: exportId, sha256: canonicalHash }, legacySource, [legacySource]), false);
});

test('0104 rejects real SQL changes even if metadata claims the canonical checksum', async () => {
  const source = await exportMigration();
  const sql = source.sql.replace("DEFAULT 'QUEUED'", "DEFAULT 'RUNNING'");
  assert.notEqual(sql, source.sql);
  for (const checksum of [sha256(sql), canonicalHash]) {
    const changed = { ...source, sql, sha256: checksum };
    assert.equal(isAppliedMigrationCompatible({ id: exportId, sha256: legacyHash }, changed, [changed]), false);
    await assert.rejects(
      pendingMigrations(fakeClient([{ id: exportId, sha256: legacyHash }]), [changed]),
      /0104_persistent_report_exports is missing or changed/u,
    );
  }
});

test('pending migrations skip historical 0104 and preserve its recorded checksum', async () => {
  const migrations = (await loadMigrations()).filter(({ id }) => [
    '0099_default_copy_qa_pass', exportId, '0117_copy_qa_inspection_records',
  ].includes(id));
  const original = Object.freeze({ id: exportId, sha256: legacyHash });
  const applied = [original];
  const client = fakeClient(applied);
  assert.deepEqual((await pendingMigrations(client, migrations)).map(({ id }) => id), [
    '0099_default_copy_qa_pass', '0117_copy_qa_inspection_records',
  ]);
  assert.deepEqual(applied, [original]);
  assert.ok(client.queries.every(({ sql }) => sql.startsWith('SELECT ')));
});

test('applying new migrations never reruns 0104 or rewrites its historical checksum', async () => {
  const migrations = (await loadMigrations()).filter(({ id }) => [
    '0099_default_copy_qa_pass', exportId, '0117_copy_qa_inspection_records',
  ].includes(id));
  const original = Object.freeze({ id: exportId, sha256: legacyHash });
  const applied = [original];
  const client = fakeClient(applied);
  assert.deepEqual(await applyMigrations(client, migrations), [
    '0099_default_copy_qa_pass', '0117_copy_qa_inspection_records',
  ]);
  assert.equal(applied[0], original);
  assert.equal(applied[0].sha256, legacyHash);
  assert.ok(!client.queries.some(({ sql }) => sql === migrations.find(({ id }) => id === exportId).sql));
  assert.deepEqual(client.queries.filter(({ sql }) => sql.startsWith('INSERT INTO public.control_plane_migrations'))
    .map(({ values }) => values[0]), ['0099_default_copy_qa_pass', '0117_copy_qa_inspection_records']);
  assert.ok(!client.queries.some(({ sql }) => /^(?:UPDATE|DELETE)\b/iu.test(sql)));
});
