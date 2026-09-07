import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createProductionSettingsStore, initializeProductionSettingsSchema } from '../src/admin/production-settings-store.mjs';

test('catalog bootstraps once, updates atomically, and protects concurrent edits and other settings', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeProductionSettingsSchema(db);
    const store = createProductionSettingsStore(db);
    const initial = store.getLayoutCatalog();
    assert.equal(initial.catalog.templates.length, 27);
    store.updateProductionSettings({ aiDisclosureEnabled: false });
    const catalog = structuredClone(initial.catalog); catalog.templates[0].enabled = false;
    const saved = store.updateLayoutCatalog({ operation: 'REPLACE', expectedRevision: initial.revision, catalog });
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(store.getProductionSettings().settings.aiDisclosureEnabled, false);
    assert.throws(() => store.updateLayoutCatalog({ operation: 'BUILTIN', expectedRevision: initial.revision }), /刷新/);
    initializeProductionSettingsSchema(db);
    assert.equal(store.getLayoutCatalog().catalog.templates[0].enabled, false);
    const bad = structuredClone(saved.catalog); bad.templates[1].subjectRegion = '悄悄改变同一版本';
    assert.throws(() => store.updateLayoutCatalog({ operation: 'REPLACE', expectedRevision: saved.revision, catalog: bad }), /版本冲突/);
    assert.deepEqual(store.getLayoutCatalog().catalog, saved.catalog);
    for (const templates of [[], saved.catalog.templates.slice(1)]) {
      assert.throws(() => store.updateLayoutCatalog({ operation: 'REPLACE', expectedRevision: saved.revision, catalog: { ...saved.catalog, templates } }), /历史模板版本不可删除/);
      assert.deepEqual(store.getLayoutCatalog().catalog, saved.catalog);
      assert.equal(store.getLayoutCatalog().revision, saved.revision);
    }
  } finally { db.close(); }
});
