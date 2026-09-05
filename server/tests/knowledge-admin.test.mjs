import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
import {
  importCopyKnowledgeLabels, listCopyAnalysisPrompts, retireKnowledge, saveCopyAnalysisPrompt,
} from '../src/knowledge-admin.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const CREATED_AT = '2024-01-02T03:04:05.000Z';
const UPDATED_AT = '2024-02-03T04:05:06.000Z';

function savedPrompt(id, content = `分析提示词 ${id}`) {
  return { id, content, createdAt: CREATED_AT, updatedAt: UPDATED_AT };
}

function settingsPool(initialPrompts = []) {
  const settings = new Map([['copy_analysis_prompts', structuredClone(initialPrompts)]]);
  const locks = new Map();
  const statements = [];
  let released = 0;
  const pool = {
    settings, statements,
    get released() { return released; },
    async query(sql, values = []) {
      assert.match(sql, /SELECT value FROM global_settings/u);
      return { rows: settings.has(values[0]) ? [{ value: structuredClone(settings.get(values[0])) }] : [] };
    },
    async connect() {
      const changes = new Map();
      let unlock;
      return {
        async query(rawSql, values = []) {
          const sql = rawSql.replace(/\s+/gu, ' ').trim();
          statements.push(sql);
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'COMMIT') {
              for (const [key, value] of changes) settings.set(key, structuredClone(value));
            }
            unlock?.();
            unlock = null;
            return { rows: [] };
          }
          const [key] = values;
          if (sql.startsWith('INSERT INTO global_settings')) {
            if (!settings.has(key)) changes.set(key, []);
            return { rows: [] };
          }
          if (sql.startsWith('SELECT value FROM global_settings')) {
            if (sql.includes('FOR UPDATE')) {
              const previous = locks.get(key) ?? Promise.resolve();
              locks.set(key, new Promise((resolve) => { unlock = resolve; }));
              await previous;
            }
            return { rows: [{ value: structuredClone(settings.get(key) ?? changes.get(key) ?? []) }] };
          }
          if (sql.startsWith('UPDATE global_settings')) {
            changes.set(key, JSON.parse(values[1]));
            return { rows: [] };
          }
          throw new Error(`Unmodeled settings query: ${sql}`);
        },
        release() { released += 1; unlock?.(); },
      };
    },
  };
  return pool;
}

function knowledgePool({ kind = 'COPY' } = {}) {
  let state = {
    items: [{ id: 7, kind, name: '原来的分析', status: 'ACTIVE' }],
    versions: [{ id: 20, item_id: 7, version: 1, content: { summary: '原来的摘要' }, status: 'PUBLISHED' }],
  };
  const transactions = [];
  let released = 0;
  const pool = {
    transactions,
    failPublication: false,
    get state() { return structuredClone(state); },
    get released() { return released; },
    async query(rawSql, values = []) {
      const sql = rawSql.replace(/\s+/gu, ' ').trim();
      if (sql.startsWith("UPDATE knowledge_items SET status = 'ARCHIVED'")) {
        const item = state.items.find((entry) => entry.id === values[0]);
        if (item) item.status = 'ARCHIVED';
        return { rows: item ? [{ id: item.id }] : [] };
      }
      throw new Error(`Unmodeled direct knowledge query: ${sql}`);
    },
    async connect() {
      let working;
      const statements = [];
      transactions.push(statements);
      return {
        async query(rawSql, values = []) {
          const sql = rawSql.replace(/\s+/gu, ' ').trim();
          statements.push(sql);
          if (sql === 'BEGIN') { working = structuredClone(state); return { rows: [] }; }
          if (sql === 'COMMIT') { state = working; return { rows: [] }; }
          if (sql === 'ROLLBACK') return { rows: [] };
          if (sql.startsWith('INSERT INTO knowledge_items')) {
            const item = { id: Math.max(0, ...working.items.map((entry) => entry.id)) + 1,
              kind: values[0], name: values[1], status: 'ACTIVE' };
            working.items.push(item);
            return { rows: [structuredClone(item)] };
          }
          if (sql.startsWith('SELECT * FROM knowledge_items')) {
            return { rows: working.items.filter((item) => item.id === values[0]).map((item) => structuredClone(item)) };
          }
          if (sql.startsWith('UPDATE knowledge_items SET name')) {
            const item = working.items.find((entry) => entry.id === values[0]);
            item.name = values[1];
            return { rows: [structuredClone(item)] };
          }
          if (sql.includes('COALESCE(MAX(version)')) {
            return { rows: [{ version: Math.max(0, ...working.versions
              .filter((entry) => entry.item_id === values[0]).map((entry) => entry.version)) + 1 }] };
          }
          if (sql.startsWith('SELECT id FROM knowledge_versions')) {
            return { rows: working.versions.filter((entry) => entry.item_id === values[0])
              .sort((a, b) => b.version - a.version).slice(0, 1).map((entry) => ({ id: entry.id })) };
          }
          if (sql.startsWith("UPDATE knowledge_versions SET status = 'ARCHIVED'")) {
            for (const entry of working.versions) {
              if (entry.item_id === values[0] && entry.status === 'PUBLISHED') entry.status = 'ARCHIVED';
            }
            return { rows: [] };
          }
          if (sql.startsWith('INSERT INTO knowledge_versions')) {
            const entry = { id: Math.max(0, ...working.versions.map((item) => item.id)) + 1,
              item_id: values[0], version: values[1], content: structuredClone(values[2]),
              storage_path: values[3], content_sha256: values[4], status: 'DRAFT' };
            working.versions.push(entry);
            return { rows: [structuredClone(entry)] };
          }
          if (sql.startsWith("UPDATE knowledge_versions SET status = 'PUBLISHED'")) {
            if (pool.failPublication) throw new Error('Simulated publication write failure');
            const entry = working.versions.find((item) => item.id === values[0]);
            entry.status = 'PUBLISHED';
            entry.published_at = new Date().toISOString();
            return { rows: [structuredClone(entry)] };
          }
          throw new Error(`Unmodeled transactional knowledge query: ${sql}`);
        },
        release() { released += 1; },
      };
    },
  };
  return pool;
}

async function withServer(repository, action) {
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage', enforceUserAuth: false });
  let server;
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonRequest(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('central copy analysis prompts', () => {
  it('allows only one of two concurrent additions when nine prompts already exist', async () => {
    const pool = settingsPool(Array.from({ length: 9 }, (_, index) => savedPrompt(index + 1)));

    const results = await Promise.allSettled([
      saveCopyAnalysisPrompt(pool, { content: '第十条候选 A' }),
      saveCopyAnalysisPrompt(pool, { content: '第十条候选 B' }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'PROMPT_LIMIT_REACHED');
    assert.equal((await listCopyAnalysisPrompts(pool)).length, 10);
    assert.equal(pool.released, 2);
    assert.equal(pool.statements.filter((sql) => sql === 'COMMIT').length, 1);
    assert.equal(pool.statements.filter((sql) => sql === 'ROLLBACK').length, 1);
  });

  it('returns the existing prompt for a duplicate even when capacity is full', async () => {
    const existing = Array.from({ length: 10 }, (_, index) => savedPrompt(index + 1));
    const pool = settingsPool(existing);

    const duplicate = await saveCopyAnalysisPrompt(pool, { content: '  分析提示词 3  ' });

    assert.deepEqual(duplicate, existing[2]);
    assert.deepEqual(await listCopyAnalysisPrompts(pool), existing);
  });

  it('replaces at full capacity while preserving ID and creation time, and rolls back duplicate replacement', async () => {
    const pool = settingsPool(Array.from({ length: 10 }, (_, index) => savedPrompt(index + 1)));

    const replaced = await saveCopyAnalysisPrompt(pool, { content: '替换后的分析方式' }, '3');

    assert.equal(replaced.id, 3);
    assert.equal(replaced.createdAt, CREATED_AT);
    assert.equal(replaced.content, '替换后的分析方式');
    assert.notEqual(replaced.updatedAt, UPDATED_AT);
    const beforeConflict = await listCopyAnalysisPrompts(pool);
    await assert.rejects(saveCopyAnalysisPrompt(pool, { content: '分析提示词 4' }, '3'), /already exists/u);
    assert.deepEqual(await listCopyAnalysisPrompts(pool), beforeConflict);
    assert.equal(pool.statements.at(-1), 'ROLLBACK');
  });

  it('preserves imported metadata and skips repeated imports after the user edits the prompt', async () => {
    const pool = settingsPool();
    const input = { ...savedPrompt(51), legacySource: { sourceKey: 'old-db', sourceId: 51 } };
    const imported = await saveCopyAnalysisPrompt(pool, input);
    assert.equal(imported.skipped, false);
    assert.equal(imported.item.createdAt, CREATED_AT);
    assert.equal(imported.item.updatedAt, UPDATED_AT);
    await saveCopyAnalysisPrompt(pool, { content: '迁移后手工编辑' }, imported.item.id);

    const repeated = await saveCopyAnalysisPrompt(pool, input);

    assert.equal(repeated.skipped, true);
    assert.equal(repeated.item.content, '迁移后手工编辑');
    assert.equal((await listCopyAnalysisPrompts(pool)).length, 1);
  });

  it('keeps unused classification labels and merges equivalent names', async () => {
    const pool = settingsPool();
    await importCopyKnowledgeLabels(pool, [{ name: '方法型' }, { name: ' 未使用分类 ' }, { name: 'ABC' }]);
    await importCopyKnowledgeLabels(pool, [{ name: '方法型' }, { name: 'abc' }]);

    assert.deepEqual(pool.settings.get('copy_knowledge_labels'),
      [{ name: '方法型' }, { name: '未使用分类' }, { name: 'ABC' }]);
  });

  it('exposes prompt create, list, replacement and missing-ID errors through HTTP', async () => {
    const pool = settingsPool();
    await withServer({ pool }, async (root) => {
      const createdResponse = await fetch(`${root}/v1/copy-analysis-prompts`, jsonRequest('POST', { content: '分析结构' }));
      assert.equal(createdResponse.status, 201);
      const created = (await createdResponse.json()).data;
      const replacedResponse = await fetch(`${root}/v1/copy-analysis-prompts/${created.id}`,
        jsonRequest('PATCH', { content: '分析修改后的结构' }));
      assert.equal(replacedResponse.status, 200);
      const replaced = (await replacedResponse.json()).data;
      assert.equal(replaced.id, created.id);
      assert.equal(replaced.createdAt, created.createdAt);
      const listed = await fetch(`${root}/v1/copy-analysis-prompts`);
      assert.deepEqual((await listed.json()).data, [replaced]);
      const missing = await fetch(`${root}/v1/copy-analysis-prompts/999`, jsonRequest('PATCH', { content: '不存在' }));
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'NOT_FOUND');
    });
  });
});

describe('reviewed central knowledge saves', () => {
  it('publishes reviewed copy and archives its previous version in one committed transaction', async () => {
    const pool = knowledgePool();
    const repository = new PostgresControlPlaneRepository({ pool });
    const content = { sourceCopy: '经检查的原文', summary: '人工修改摘要', analysis: '完整分析', labels: ['方法型'] };

    const saved = await repository.createKnowledgeVersion({
      itemId: 7, kind: 'COPY', name: '检查后的分析', content, publish: true, expectedVersionId: 20,
    });

    assert.equal(saved.itemId, 7);
    assert.equal(saved.version, 2);
    assert.equal(saved.status, 'PUBLISHED');
    assert.deepEqual(saved.content, content);
    assert.equal(pool.state.items[0].name, '检查后的分析');
    assert.deepEqual(pool.state.versions.map((version) => version.status), ['ARCHIVED', 'PUBLISHED']);
    assert.equal(pool.state.versions[1].id, saved.versionId);
    assert.equal(pool.transactions.length, 1);
    assert.equal(pool.transactions[0][0], 'BEGIN');
    assert.equal(pool.transactions[0].at(-1), 'COMMIT');
    assert.ok(pool.transactions[0].some((sql) => /SELECT \* FROM knowledge_items.*FOR UPDATE/u.test(sql)));
    assert.equal(pool.released, 1);
  });

  it('rolls back renamed copy and preserves its published version when the expected version is stale', async () => {
    const pool = knowledgePool();
    const repository = new PostgresControlPlaneRepository({ pool });
    const before = pool.state;

    await assert.rejects(repository.createKnowledgeVersion({
      itemId: 7, kind: 'COPY', name: '过期页面的编辑', content: { summary: '旧页面修改' },
      publish: true, expectedVersionId: 19,
    }), { code: 'KNOWLEDGE_CHANGED' });

    assert.deepEqual(pool.state, before);
    assert.equal(pool.transactions[0].at(-1), 'ROLLBACK');
    assert.equal(pool.released, 1);
  });

  it('rolls back both archive and inserted version when the publication write fails', async () => {
    const pool = knowledgePool();
    pool.failPublication = true;
    const repository = new PostgresControlPlaneRepository({ pool });
    const before = pool.state;

    await assert.rejects(repository.createKnowledgeVersion({
      itemId: 7, kind: 'COPY', name: '准备发布的分析', content: { summary: '新摘要' },
      publish: true, expectedVersionId: 20,
    }), /Simulated publication write failure/u);

    assert.deepEqual(pool.state, before);
    assert.equal(pool.transactions[0].at(-1), 'ROLLBACK');
    assert.equal(pool.released, 1);
  });

  it('leaves visual saves as drafts and rejects automatic visual publication without altering history', async () => {
    const pool = knowledgePool({ kind: 'VISUAL' });
    const repository = new PostgresControlPlaneRepository({ pool });
    const before = pool.state;
    await assert.rejects(repository.createKnowledgeVersion({
      itemId: 7, kind: 'VISUAL', name: '视觉配方', content: { promptTemplate: '暖色摄影' }, publish: true,
    }), /separate publication review/u);
    assert.deepEqual(pool.state, before);

    const draft = await repository.createKnowledgeVersion({
      itemId: 7, kind: 'VISUAL', name: '视觉配方', content: { promptTemplate: '暖色摄影' }, expectedVersionId: 20,
    });

    assert.equal(draft.status, 'DRAFT');
    assert.deepEqual(pool.state.versions.map((version) => version.status), ['PUBLISHED', 'DRAFT']);
  });

  it('forwards reviewed publication and stale-version conflicts through the knowledge HTTP route', async () => {
    const pool = knowledgePool();
    const repository = new PostgresControlPlaneRepository({ pool });
    await withServer(repository, async (root) => {
      const input = { itemId: 7, kind: 'COPY', name: '页面保存', content: { summary: '页面确认的分析' },
        publish: true, expectedVersionId: 20 };
      const response = await fetch(`${root}/v1/knowledge/versions`, jsonRequest('POST', input));
      assert.equal(response.status, 201);
      const saved = (await response.json()).data;
      assert.equal(saved.status, 'PUBLISHED');
      assert.deepEqual(pool.state.versions.at(-1).content, input.content);
      const stale = await fetch(`${root}/v1/knowledge/versions`, jsonRequest('POST', input));
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, 'KNOWLEDGE_CHANGED');
      assert.equal(pool.state.versions.length, 2);
    });
  });
});

describe('knowledge retirement', () => {
  it('archives the item and excludes it from a subsequently claimed task configuration', async () => {
    const pool = knowledgePool();
    const retired = await retireKnowledge(pool, '7');
    assert.deepEqual(retired, { id: 7, status: 'RETIRED' });
    assert.equal(pool.state.items[0].status, 'ARCHIVED');
    assert.equal(pool.state.versions[0].status, 'PUBLISHED');

    const task = { id: 91, query: '新的生成任务', input: {}, requested_image_count: 'auto',
      state: 'COPY_QUEUED', copy_executor_node_id: 'node-a', pending_snapshot: null };
    let execution;
    const client = {
      async query(rawSql, values = []) {
        const sql = rawSql.replace(/\s+/gu, ' ').trim();
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('SELECT * FROM executor_nodes')) return { rows: [{ id: 'node-a' }] };
        if (sql.startsWith('UPDATE executor_nodes')) return { rows: [] };
        if (sql.startsWith('SELECT COUNT(*) AS count FROM task_executions')) return { rows: [{ count: 0 }] };
        if (sql.startsWith('SELECT * FROM tasks')) return { rows: [task] };
        if (sql.includes('FROM global_settings') || sql.includes('FROM prompt_templates')) return { rows: [] };
        if (sql.includes('FROM knowledge_items i')) {
          assert.match(sql, /WHERE i\.status = 'ACTIVE'/u);
          assert.match(sql, /v\.status = 'PUBLISHED'/u);
          return { rows: pool.state.items.filter((item) => item.status === 'ACTIVE') };
        }
        if (sql.startsWith('INSERT INTO task_executions')) {
          execution = { id: values[0], task_id: values[1], kind: values[2], node_id: values[3],
            stage: values[4], snapshot: values[6], status: 'RUNNING' };
          return { rows: [] };
        }
        if (sql.startsWith('UPDATE tasks SET')) return { rows: [{ ...task, state: values[0] }] };
        if (sql.startsWith('SELECT * FROM task_executions')) return { rows: [execution] };
        throw new Error(`Unmodeled claim query: ${sql}`);
      },
      release() {},
    };
    const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

    const claimed = await repository.claimCopy('node-a');

    assert.deepEqual(claimed.execution.snapshot.knowledge, []);
    await assert.rejects(retireKnowledge(pool, '999'), { code: 'NOT_FOUND' });
  });
});
