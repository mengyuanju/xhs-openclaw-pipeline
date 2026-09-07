import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminStore } from '../src/admin/admin-store.mjs';
import { hashPrompt } from '../src/admin/prompt-service.mjs';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';
import { createPromptGovernanceStore, initializePromptGovernance } from '../src/admin/prompt-governance-store.mjs';

test('local legacy prompt migration preserves published content and seeds new kinds as drafts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'xhs-prompts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'queue.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE prompt_templates (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('TEXT_SYSTEM','IMAGE_SYSTEM','IMAGE_EDIT_SYSTEM')), created_at TEXT NOT NULL) STRICT;
    CREATE TABLE prompt_versions (id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES prompt_templates(id),
    version INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, content_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL, published_at TEXT, UNIQUE(template_id,version)) STRICT;`);
  db.prepare('INSERT INTO prompt_templates VALUES (1,?,?,?,?)').run('xiaohongshu-text', '人工文案', 'TEXT_SYSTEM', '2026-01-01');
  db.prepare('INSERT INTO prompt_versions VALUES (1,1,7,?,?,?,?,?)').run('保留人工原文', 'PUBLISHED', hashPrompt('保留人工原文'), '2026-01-01', '2026-01-01');
  db.close();
  const store = createAdminStore(path);
  const templates = store.listPromptTemplates();
  assert.equal(templates.length, PROMPT_CATALOG.length);
  assert.equal(templates.find((item) => item.kind === 'TEXT_SYSTEM').versions[0].content, '保留人工原文');
  assert.equal(templates.find((item) => item.kind === 'VISUAL_PLAN_SYSTEM').versions[0].status, 'DRAFT');
  store.setPromptRuntimeSettings({ visualPlanningEnabled: true, copyKnowledgeThreshold: 80 });
  store.close();
  const reopened = createAdminStore(path);
  assert.equal(reopened.getPromptRuntimeSettings().copyKnowledgeThreshold, 80);
  assert.equal(reopened.listPromptTemplates().find((item) => item.kind === 'TEXT_SYSTEM').versions.length, 1);
  reopened.close();
  const check = new DatabaseSync(path);
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  check.close();
});

test('the one-time task migration keeps attempted legacy runs ungoverned and freezes new task rules', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL) STRICT;
    CREATE TABLE prompt_templates (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('TEXT_SYSTEM','IMAGE_SYSTEM','IMAGE_EDIT_SYSTEM')), created_at TEXT NOT NULL) STRICT;
    CREATE TABLE prompt_versions (id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES prompt_templates(id),
      version INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, published_at TEXT, UNIQUE(template_id,version)) STRICT;
    INSERT INTO tasks VALUES (1,2),(2,0);`);
  db.prepare('INSERT INTO prompt_templates VALUES (1,?,?,?,?)').run('text', '文案', 'TEXT_SYSTEM', '2026-01-01');
  db.prepare('INSERT INTO prompt_versions VALUES (1,1,7,?,?,?,?,?)').run('迁移时已发布规则七', 'PUBLISHED', hashPrompt('迁移时已发布规则七'), '2026-01-01', '2026-01-01');
  initializePromptGovernance(db);
  const store = createPromptGovernanceStore(db);
  store.setPromptRuntimeSettings({ visualPlanningEnabled: false, copyKnowledgeThreshold: 80 });

  assert.equal(store.pinTaskPromptRuntime(1), null, 'already-attempted work must not receive new rules retrospectively');
  const pending = store.pinTaskPromptRuntime(2);
  assert.equal(pending.prompts.TEXT_SYSTEM.content, '迁移时已发布规则七');
  assert.equal(pending.prompts.TEXT_SYSTEM.version, 7);
  assert.equal(pending.settings.copyKnowledgeThreshold, 80);

  db.exec("UPDATE prompt_versions SET status='ARCHIVED' WHERE id=1; INSERT INTO tasks VALUES (3,1);");
  db.prepare('INSERT INTO prompt_versions(template_id,version,content,status,content_sha256,created_at,published_at) VALUES (1,8,?,?,?,?,?)')
    .run('后来发布规则八', 'PUBLISHED', hashPrompt('后来发布规则八'), '2026-09-07', '2026-09-07');
  store.setPromptRuntimeSettings({ visualPlanningEnabled: true, copyKnowledgeThreshold: 90 });
  initializePromptGovernance(db);

  assert.equal(store.pinTaskPromptRuntime(1), null);
  assert.deepEqual(store.pinTaskPromptRuntime(2), pending, 'a published update must not change a previously pinned execution');
  const newerAttemptedTask = store.pinTaskPromptRuntime(3);
  assert.ok(newerAttemptedTask, 'reopening the store must not rerun the legacy null migration for new attempted tasks');
  assert.equal(newerAttemptedTask.prompts.TEXT_SYSTEM.content, '后来发布规则八');
  assert.equal(newerAttemptedTask.prompts.TEXT_SYSTEM.version, 8);
  assert.equal(newerAttemptedTask.settings.copyKnowledgeThreshold, 90);
  assert.equal(newerAttemptedTask.settings.visualPlanningEnabled, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prompt_governance_migrations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_prompt_runtimes').get().count, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
