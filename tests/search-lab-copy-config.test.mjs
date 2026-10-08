import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectLocalCenterProfile, loadCopyConfiguration } from '../search-lab/copy-config.mjs';
import { defaultBusinessPrompt } from '../src/prompt-runtime.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');

function temporaryProject(t, { sqlite = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'search-lab-copy-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (sqlite) { mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data', 'queue.db'), 'fake database'); }
  return root;
}

function fakePostgres({ knowledgeEnabled = true, queryReviewEnabled = false, failure = null, sha256 = null } = {}) {
  const content = '当前已发布文案规则，原文保留。\n第二段与空格  保持原样。';
  const calls = [];
  const state = { calls, options: null, ended: false, content };
  const client = {
    async connect() { calls.push('CONNECT'); if (failure === 'connect') throw new Error('password=unsafe-database-key'); },
    async query(sql, values) {
      calls.push({ sql, values });
      if (failure === 'query' && sql.includes('global_settings')) throw new Error('postgres://user:unsafe-database-key@local/db');
      if (sql.includes('global_settings')) return { rows: [
        { key: 'production', value: { knowledgeEnabled, modelApi: { agentProvider: 'CODEX' } } },
        { key: 'prompt_runtime', value: queryReviewEnabled ? { queryReviewEnabled: true } : null },
      ] };
      if (sql.includes('prompt_templates')) return { rows: [{ template_id: 1, kind: 'TEXT_SYSTEM', name: '文案生成',
        version_id: 88, version: 6, content, content_sha256: sha256 ?? hash(content) }] };
      if (sql.includes('knowledge_items')) return { rows: [{ item_id: 25, kind: 'COPY', name: '已发布案例',
        version_id: 91, version: 3, content: { title: '结构案例', sourceCopy: '案例原文', labels: ['生鲜'] },
        storage_path: null, content_sha256: 'a'.repeat(64) }] };
      return { rows: [] };
    },
    async end() { state.ended = true; calls.push('END'); },
  };
  state.factory = (options) => { state.options = options; return client; };
  return state;
}

function fakeSqlite({ copies = 0, knowledgeEnabled = true } = {}) {
  const statements = [];
  const content = 'SQLite 当前已发布规则\n完全复用';
  const rows = Array.from({ length: copies }, (_, index) => ({ id: index + 1, title: `案例 ${index + 1}`,
    source_copy: `原文 ${index + 1}`, analysis: '方法分析', source_copy_sha256: 'b'.repeat(64),
    analysis_prompt: '人工分析模板', summary: '方法摘要', analysis_model: 'fake', created_at: '2026-09-01' }));
  const state = { closed: false, options: null, path: null, statements, content };
  const db = {
    prepare(sql) {
      statements.push(sql);
      return { all(...values) {
        if (sql.includes('sqlite_master')) return ['prompt_templates', 'prompt_versions', 'prompt_runtime_settings',
          'production_settings', 'copy_knowledge_items', 'copy_knowledge_item_labels', 'copy_knowledge_labels'].map((name) => ({ name }));
        if (sql.startsWith('SELECT * FROM prompt_templates')) return [{ id: 1, kind: 'TEXT_SYSTEM', name: '文案生成' }];
        if (sql.startsWith('SELECT * FROM prompt_versions')) return [
          { id: 5, template_id: 1, version: 5, content: '尚未发布的草稿', status: 'DRAFT', content_sha256: hash('尚未发布的草稿') },
          { id: 4, template_id: 1, version: 4, content, status: 'PUBLISHED', content_sha256: hash(content) },
        ];
        if (sql.includes('prompt_runtime_settings')) return [];
        if (sql.includes('production_settings')) return [{ settings_json: JSON.stringify({ knowledgeEnabled }) }];
        if (sql.startsWith('SELECT COUNT(*)')) return [{ count: rows.length }];
        if (sql.startsWith('SELECT * FROM copy_knowledge_items')) return rows.slice().reverse().slice(values[1], values[1] + values[0]);
        if (sql.includes('copy_knowledge_item_labels')) return rows.map(({ id }) => ({ item_id: id, name: '例子' }));
        throw new Error(`Unexpected fake SQL: ${sql}`);
      } };
    },
    close() { state.closed = true; },
  };
  state.open = (path, options) => { state.path = path; state.options = options; return db; };
  return state;
}

test('reads current center published prompts and complete knowledge through a read-only snapshot', async (t) => {
  const pg = fakePostgres();
  const configuration = await loadCopyConfiguration({ environment: {}, projectRoot: temporaryProject(t),
    connectionString: 'postgres://fixture:fixture-key@localhost/current', serverEnvironment: 'production', postgresClientFactory: pg.factory });
  assert.equal(configuration.source, 'CENTER_DATABASE');
  assert.equal(configuration.serverEnvironment, 'production');
  assert.equal(configuration.systemPrompt, pg.content);
  assert.equal(configuration.promptRuntime.prompts.TEXT_SYSTEM.versionId, 88);
  assert.equal(configuration.promptRuntime.prompts.TEXT_SYSTEM.version, 6);
  assert.equal(configuration.promptRuntime.prompts.TEXT_SYSTEM.sha256, hash(pg.content));
  assert.equal(configuration.settings, null);
  assert.deepEqual(configuration.knowledge[0], { kind: 'COPY', name: '已发布案例', itemId: 25, versionId: 91,
    version: 3, content: { title: '结构案例', sourceCopy: '案例原文', labels: ['生鲜'] }, storagePath: null, sha256: 'a'.repeat(64) });
  assert.match(pg.options.options, /default_transaction_read_only=on/u);
  const sql = pg.calls.filter((call) => typeof call === 'object').map((call) => call.sql);
  assert.equal(sql[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(sql.at(-1), 'COMMIT');
  assert.ok(sql.every((query) => /^(?:BEGIN|SELECT|COMMIT)/u.test(query)));
  assert.deepEqual(pg.calls.find((call) => call.sql?.includes('global_settings')).values, [['production', 'prompt_runtime']]);
  assert.deepEqual(pg.calls.find((call) => call.sql?.includes('knowledge_items')).values, ['PUBLISHED', 'ACTIVE']);
  assert.equal(pg.ended, true);
  assert.equal(JSON.stringify(configuration).includes('fixture-key'), false);
});

test('keeps production knowledge disabled and preserves the configured prompt policy', async (t) => {
  const pg = fakePostgres({ knowledgeEnabled: false, queryReviewEnabled: true });
  const configuration = await loadCopyConfiguration({ environment: {}, projectRoot: temporaryProject(t),
    connectionString: 'fake', postgresClientFactory: pg.factory });
  assert.deepEqual(configuration.knowledge, []);
  assert.equal(configuration.productionSettings.knowledgeEnabled, false);
  assert.equal(configuration.settings.queryReviewEnabled, true);
  assert.equal(configuration.promptRuntime.settings.queryReviewEnabled, true);
});

test('SQLite fallback is read-only, chooses published content, paginates all copy cases and closes', async (t) => {
  const sqlite = fakeSqlite({ copies: 205 });
  const configuration = await loadCopyConfiguration({ environment: {}, projectRoot: temporaryProject(t, { sqlite: true }),
    detectProfile: async () => null, sqliteOpen: sqlite.open });
  assert.equal(configuration.source, 'LOCAL_READ_ONLY');
  assert.equal(configuration.systemPrompt, sqlite.content);
  assert.equal(configuration.promptRuntime.prompts.TEXT_SYSTEM.version, 4);
  assert.equal(configuration.knowledge.length, 205);
  assert.equal(configuration.knowledge[0].versionSource, 'LOCAL_ITEM_SNAPSHOT');
  assert.equal(configuration.knowledge[0].content.labels[0], '例子');
  assert.match(configuration.knowledge[0].contentSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(sqlite.options, { readOnly: true });
  assert.equal(sqlite.closed, true);
  assert.ok(sqlite.statements.every((sql) => sql.startsWith('SELECT')));
  assert.equal(sqlite.statements.filter((sql) => sql.startsWith('SELECT * FROM copy_knowledge_items')).length, 3);
});

test('failed center connection or hash verification gives safe warnings and exact bundled fallback', async (t) => {
  for (const options of [{ failure: 'connect' }, { failure: 'query' }, { sha256: '0'.repeat(64) }]) {
    const pg = fakePostgres(options);
    const configuration = await loadCopyConfiguration({ environment: {}, projectRoot: temporaryProject(t),
      connectionString: 'postgres://user:unsafe-database-key@localhost/db', postgresClientFactory: pg.factory });
    assert.equal(configuration.source, 'BUNDLED_DEFAULT');
    assert.equal(configuration.systemPrompt, defaultBusinessPrompt('TEXT_SYSTEM'));
    assert.equal(configuration.promptRuntime.prompts.COPY_IMAGE_PLAN_SYSTEM.content, defaultBusinessPrompt('COPY_IMAGE_PLAN_SYSTEM'));
    assert.ok(configuration.warnings.some((warning) => warning.includes('未能读取当前中心系统')));
    assert.equal(JSON.stringify(configuration).includes('unsafe-database-key'), false);
    assert.equal(pg.ended, true);
  }
});

test('uses detected local center production profile rather than the development default', async (t) => {
  const root = temporaryProject(t);
  mkdirSync(join(root, 'server'));
  writeFileSync(join(root, 'server', '.env'), 'DATABASE_URL=postgres://fixture/dev\nXHS_PRODUCTION_DATABASE_URL=postgres://fixture/production\nCONTROL_PLANE_PORT=4310\n');
  const pg = fakePostgres();
  await loadCopyConfiguration({ environment: { CONTROL_PLANE_URL: 'http://127.0.0.1:4310' }, projectRoot: root,
    detectProfile: async () => 'production', postgresClientFactory: pg.factory });
  assert.equal(pg.options.connectionString, 'postgres://fixture/production');
});

test('does not map a remote or unrecognized center to a possibly different local database', async (t) => {
  const root = temporaryProject(t);
  const configuration = await loadCopyConfiguration({ environment: { CONTROL_PLANE_URL: 'https://center.invalid' }, projectRoot: root,
    detectProfile: async () => null, postgresClientFactory: () => { throw new Error('must not connect'); } });
  assert.equal(configuration.source, 'BUNDLED_DEFAULT');
  assert.ok(configuration.warnings.some((warning) => warning.includes('未确认中心服务')));
});

test('profile discovery inspects only the configured loopback listener using argument arrays', async () => {
  let invoked = false;
  const result = await detectLocalCenterProfile({ environment: { CONTROL_PLANE_URL: 'http://127.0.0.1:4310' }, platform: 'win32',
    execute: async (command, args, options) => {
      invoked = true;
      assert.equal(command, 'powershell.exe');
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.match(args.at(-1), /-LocalPort 4310/u);
      return { stdout: 'production\r\n' };
    } });
  assert.equal(result, 'production');
  assert.equal(invoked, true);
  assert.equal(await detectLocalCenterProfile({ environment: { CONTROL_PLANE_URL: 'https://remote.invalid' }, platform: 'win32',
    execute: () => { throw new Error('must not inspect'); } }), null);
});
