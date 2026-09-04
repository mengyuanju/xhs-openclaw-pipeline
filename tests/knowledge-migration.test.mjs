import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { migrateLegacyKnowledge, readLegacyKnowledge } from '../src/admin/knowledge-migration.mjs';

const CREATED_AT = '2024-02-03T04:05:06.000Z';
const PROMPT_UPDATED_AT = '2024-03-04T05:06:07.000Z';
const SOURCE_KEY = 'legacy-knowledge-test';

function legacyItem(index) {
  const sourceCopy = `优秀原文 ${index}：先描述具体问题，再说明可执行步骤。`;
  return {
    id: index,
    title: `历史文案 ${index}`,
    sourceCopy,
    sourceCopySha256: createHash('sha256').update(sourceCopy).digest('hex'),
    analysisPrompt: '分析开头、结构及行动引导。',
    summary: `历史摘要 ${index}`,
    analysis: `完整分析 ${index}\n保留段落和原始内容。`,
    analysisModel: 'legacy-analysis-model',
    labels: ['方法型', '强开头'],
    createdAt: CREATED_AT,
  };
}

async function createLegacyFixture(t, { itemCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-knowledge-migration-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  const databasePath = join(directory, 'legacy.db');
  const db = new DatabaseSync(databasePath);
  try {
    // Deliberately use the old schema: copy knowledge has no version or import tables.
    db.exec(`
      CREATE TABLE copy_knowledge_items (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, source_copy TEXT NOT NULL,
        source_copy_sha256 TEXT NOT NULL, analysis_prompt TEXT NOT NULL,
        summary TEXT NOT NULL, analysis TEXT NOT NULL,
        analysis_model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE copy_knowledge_labels (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE copy_knowledge_item_labels (
        item_id INTEGER NOT NULL, label_id INTEGER NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (item_id, label_id)
      ) STRICT;
      CREATE TABLE copy_analysis_prompts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE visual_knowledge_items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        generation_target TEXT NOT NULL, retention_mode TEXT NOT NULL,
        rights_status TEXT NOT NULL, source_image_sha256 TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE visual_knowledge_versions (
        id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, version INTEGER NOT NULL,
        prompt_template TEXT NOT NULL, negative_prompt TEXT NOT NULL,
        style_tags_json TEXT NOT NULL, categories_json TEXT NOT NULL,
        layout_rules_json TEXT NOT NULL, quality_score REAL NOT NULL,
        analysis_model TEXT NOT NULL, status TEXT NOT NULL,
        content_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT
      ) STRICT;
      CREATE TABLE visual_knowledge_assets (
        id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, file_name TEXT NOT NULL,
        relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL,
        height INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
    `);
    const insertItem = db.prepare('INSERT INTO copy_knowledge_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertLabel = db.prepare('INSERT INTO copy_knowledge_labels VALUES (?, ?, ?, ?)');
    const linkLabel = db.prepare('INSERT INTO copy_knowledge_item_labels VALUES (?, ?, ?)');
    for (const [id, name] of [[1, '方法型'], [2, '强开头'], [3, '暂未使用的分类']]) {
      insertLabel.run(id, name, name, CREATED_AT);
    }
    for (let index = 1; index <= itemCount; index += 1) {
      const item = legacyItem(index);
      insertItem.run(item.id, item.title, item.sourceCopy, item.sourceCopySha256,
        item.analysisPrompt, item.summary, item.analysis, item.analysisModel, item.createdAt);
      // Insert out of order to prove label position, rather than row order, is honored.
      linkLabel.run(item.id, 2, 1);
      linkLabel.run(item.id, 1, 0);
    }
    db.prepare('INSERT INTO copy_analysis_prompts VALUES (?, ?, ?, ?)')
      .run(17, '常用分析：分解开头、结构和结尾。', CREATED_AT, PROMPT_UPDATED_AT);
  } finally {
    db.close();
  }
  return { directory, databasePath, closeAfter: (cleanup) => cleanups.push(cleanup) };
}

function assertItemPreserved(actual, expected) {
  for (const field of ['title', 'sourceCopy', 'sourceCopySha256', 'analysisPrompt',
    'summary', 'analysis', 'analysisModel', 'labels', 'createdAt']) {
    assert.deepEqual(actual[field], expected[field], `${expected.title}: ${field} must be preserved`);
  }
}

async function allCopyItems(store) {
  const first = await store.listCopyKnowledge({ page: 1, pageSize: 100 });
  const items = [...first.data];
  for (let page = 2; page <= first.pagination.totalPages; page += 1) {
    items.push(...(await store.listCopyKnowledge({ page, pageSize: 100 })).data);
  }
  return items;
}

function asynchronousStore(store) {
  return new Proxy(store, {
    get(target, property) {
      const value = target[property];
      return typeof value === 'function'
        ? async (...args) => value.apply(target, args)
        : value;
    },
  });
}

describe('legacy knowledge migration', () => {
  it('reads every old copy without versions and preserves labels and prompt metadata without changing the source', async (t) => {
    const { directory, databasePath } = await createLegacyFixture(t, { itemCount: 121 });
    const before = await readFile(databasePath);
    const filesBefore = await readdir(directory);

    const source = await readLegacyKnowledge(databasePath);

    assert.equal(source.copyItems.length, 121);
    for (const expected of [legacyItem(1), legacyItem(100), legacyItem(121)]) {
      assertItemPreserved(source.copyItems.find((item) => item.id === expected.id), expected);
    }
    assert.deepEqual(source.labels.map((label) => label.name).sort(),
      ['方法型', '强开头', '暂未使用的分类'].sort());
    assert.equal(source.analysisPrompts.length, 1);
    assert.equal(source.analysisPrompts[0].content, '常用分析：分解开头、结构和结尾。');
    assert.equal(source.analysisPrompts[0].createdAt, CREATED_AT);
    assert.equal(source.analysisPrompts[0].updatedAt, PROMPT_UPDATED_AT);
    assert.deepEqual(source.visualItems, []);
    assert.deepEqual(source.assets, []);
    assert.deepEqual(await readFile(databasePath), before);
    assert.deepEqual(await readdir(directory), filesBefore);
  });

  it('imports more than one page into SQLite with original content, dates, model and unused categories', async (t) => {
    const { directory, databasePath, closeAfter } = await createLegacyFixture(t, { itemCount: 121 });
    const before = await readFile(databasePath);
    const targetPath = join(directory, 'target.db');
    const store = createAdminStore(targetPath);
    closeAfter(() => store.close());

    const result = await migrateLegacyKnowledge({
      source: await readLegacyKnowledge(databasePath), store, sourceKey: SOURCE_KEY,
    });

    assert.equal(result.copyItems, 121);
    assert.equal(result.analysisPrompts, 1);
    assert.equal(result.visualItems, 0);
    assert.equal(result.skipped, 0);
    const imported = await allCopyItems(store);
    assert.equal(imported.length, 121);
    for (const expected of [legacyItem(1), legacyItem(100), legacyItem(121)]) {
      assertItemPreserved(imported.find((item) => item.title === expected.title), expected);
    }
    const [prompt] = await store.listCopyAnalysisPrompts();
    assert.equal(prompt.content, '常用分析：分解开头、结构和结尾。');
    assert.equal(prompt.createdAt, CREATED_AT);
    assert.equal(prompt.updatedAt, PROMPT_UPDATED_AT);
    const targetReader = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.deepEqual(targetReader.prepare('SELECT name FROM copy_knowledge_labels').all()
        .map((label) => label.name).sort(), ['方法型', '强开头', '暂未使用的分类'].sort());
    } finally {
      targetReader.close();
    }
    assert.deepEqual(await readFile(databasePath), before);
  });

  it('does not duplicate or overwrite edited imported items after reopening the target database', async (t) => {
    const { directory, databasePath, closeAfter } = await createLegacyFixture(t, { itemCount: 121 });
    const targetPath = join(directory, 'target.db');
    let store = createAdminStore(targetPath);
    closeAfter(() => store.close());
    await migrateLegacyKnowledge({ source: await readLegacyKnowledge(databasePath), store, sourceKey: SOURCE_KEY });
    const original = (await allCopyItems(store)).find((item) => item.title === '历史文案 1');
    const edited = store.updateCopyKnowledge(original.id, {
      ...original, title: '迁移后的人工编辑', sourceCopy: '用户重新整理后的原文。',
      summary: '用户修改摘要。', analysis: '用户修改完整分析。', labels: ['人工补充分类'],
    });
    const [prompt] = store.listCopyAnalysisPrompts();
    store.replaceCopyAnalysisPrompt(prompt.id, { content: '用户修改后的常用分析提示词。' });
    store.close();
    store = createAdminStore(targetPath);

    const result = await migrateLegacyKnowledge({
      source: await readLegacyKnowledge(databasePath), store, sourceKey: SOURCE_KEY,
    });

    assert.equal(result.copyItems, 0);
    assert.equal(result.analysisPrompts, 0);
    assert.equal(result.skipped, 122);
    const items = await allCopyItems(store);
    assert.equal(items.length, 121);
    assertItemPreserved(items.find((item) => item.id === original.id), edited);
    assert.deepEqual(store.listCopyAnalysisPrompts().map((item) => item.content),
      ['用户修改后的常用分析提示词。']);
  });

  it('reports the planned migration in dry run without importing data or recording completed imports', async (t) => {
    const { databasePath, closeAfter } = await createLegacyFixture(t, { itemCount: 3 });
    const store = createAdminStore(':memory:');
    closeAfter(() => store.close());
    const source = await readLegacyKnowledge(databasePath);

    const preview = await migrateLegacyKnowledge({ source, store, sourceKey: SOURCE_KEY, dryRun: true });

    assert.equal(preview.copyItems, 3);
    assert.equal(preview.analysisPrompts, 1);
    assert.equal(store.listCopyKnowledge().pagination.totalItems, 0);
    assert.deepEqual(store.listCopyAnalysisPrompts(), []);
    const imported = await migrateLegacyKnowledge({ source, store, sourceKey: SOURCE_KEY });
    assert.equal(imported.copyItems, 3);
    assert.equal(imported.analysisPrompts, 1);
    assert.equal(imported.skipped, 0);
  });

  it('awaits asynchronous storage adapters and leaves unrelated destination data intact', async (t) => {
    const { databasePath, closeAfter } = await createLegacyFixture(t, { itemCount: 2 });
    const store = createAdminStore(':memory:');
    closeAfter(() => store.close());
    const existing = store.createCopyKnowledge({ ...legacyItem(1), title: '目标库原有文案' });
    const adapter = asynchronousStore(store);

    const result = await migrateLegacyKnowledge({
      source: await readLegacyKnowledge(databasePath), store: adapter, sourceKey: SOURCE_KEY,
    });

    assert.equal(result.copyItems, 2);
    assert.equal(result.analysisPrompts, 1);
    const items = await allCopyItems(adapter);
    assert.equal(items.length, 3);
    assertItemPreserved(items.find((item) => item.id === existing.id), existing);
    assertItemPreserved(items.find((item) => item.title === '历史文案 2'), legacyItem(2));
    const repeated = await migrateLegacyKnowledge({
      source: await readLegacyKnowledge(databasePath), store: adapter, sourceKey: SOURCE_KEY,
    });
    assert.equal(repeated.copyItems, 0);
    assert.equal(repeated.analysisPrompts, 0);
    assert.equal(repeated.skipped, 3);
  });

  it('rejects an absent source without creating a new database', async (t) => {
    const { directory } = await createLegacyFixture(t);
    const missingPath = join(directory, 'missing-source.db');

    await assert.rejects(async () => readLegacyKnowledge(missingPath));

    assert.equal(existsSync(missingPath), false);
  });
});
