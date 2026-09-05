import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { screenImportRowsWithOpenClaw } from '../src/admin/demand-screening-service.mjs';
import { runQueryReview, isReusableStageReview, queryReviewSubject } from '../src/content-stage-review.mjs';

test('the previous OpenClaw-only SQLite constraint migrates without losing model provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'queue.db');
  let store = createAdminStore(path);
  const batch = store.createImportBatch({ name: 'legacy', sourceFileName: 'test.xlsx', rows: [{
    rowNumber: 2, query: '桌面如何整理', input: {}, imageCount: 3, referenceImageFiles: [], errors: [],
    screening: { source: 'OPENCLAW', model: 'openai/gpt-5.4', demandLevel: 'STRONG', reason: '需要具体方法', admitted: true },
  }] });
  store.close();
  const db = new DatabaseSync(path);
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'import_rows'").get().sql;
  db.exec('BEGIN; ALTER TABLE import_rows RENAME TO legacy_rows;');
  db.exec(schema.replace(", 'CODEX'", ''));
  db.exec('INSERT INTO import_rows SELECT * FROM legacy_rows; DROP TABLE legacy_rows; COMMIT;');
  db.close();
  store = createAdminStore(path);
  try {
    const row = store.getImportBatch(batch.id).rows[0];
    assert.equal(row.screeningSource, 'OPENCLAW');
    assert.equal(row.screeningModel, 'openai/gpt-5.4');
    assert.equal(store.commitImportBatch(batch.id).createdTasks, 1);
  } finally { store.close(); }
});

test('Codex demand screening is persisted with its real provider and model', async () => {
  const store = createAdminStore(':memory:');
  try {
    const rows = await screenImportRowsWithOpenClaw({ rows: [{ rowNumber: 2, query: '桌面如何整理', input: {}, imageCount: 3, errors: [], referenceImageFiles: [] }],
      openclaw: { provider: 'codex', async runText() { return { provider: 'codex', model: 'openai/gpt-5.6-sol',
        rawText: JSON.stringify({ decisions: [{ rowNumber: 2, demandLevel: 'STRONG', reason: '需要具体整理步骤' }] }) }; } } });
    assert.equal(rows[0].screening.source, 'CODEX');
    const batch = store.createImportBatch({ name: 'Codex import', sourceFileName: 'test.xlsx', rows });
    const row = store.getImportBatch(batch.id).rows[0];
    assert.equal(row.screeningSource, 'CODEX');
    assert.equal(row.screeningModel, 'openai/gpt-5.6-sol');
    assert.equal(store.commitImportBatch(batch.id).createdTasks, 1);
  } finally { store.close(); }
});

test('Codex review checkpoints retain provider identity and remain reusable', async () => {
  const task = { query: '桌面如何整理', input: {} };
  const review = await runQueryReview({ task, client: { provider: 'codex', async runReview() {
    return { provider: 'codex', model: 'openai/gpt-5.6-sol', rawText: JSON.stringify({ schemaVersion: 1, decision: 'PASS', summary: '需求清楚', issues: [] }) };
  } } });
  assert.equal(review.source, 'CODEX');
  assert.equal(isReusableStageReview(review, { stage: 'QUERY', subject: queryReviewSubject(task) }), true);
});
