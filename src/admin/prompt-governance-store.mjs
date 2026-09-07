import { PROMPT_CATALOG } from '../prompt-catalog.mjs';
import { createPromptRuntime, defaultBusinessPrompt, normalizePromptPolicy } from '../prompt-runtime.mjs';
import { hashPrompt } from './prompt-service.mjs';

export function initializePromptGovernance(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='prompt_templates'").get()?.sql;
  if (schema?.includes('CHECK')) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(`CREATE TABLE prompt_templates_expanded (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        kind TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
        INSERT INTO prompt_templates_expanded SELECT id,slug,name,kind,created_at FROM prompt_templates;
        DROP TABLE prompt_templates;
        ALTER TABLE prompt_templates_expanded RENAME TO prompt_templates;`);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('提示词迁移外键校验失败');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.exec('PRAGMA foreign_keys=ON'); }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_runtime_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_prompt_runtimes (
    task_id INTEGER PRIMARY KEY, value_json TEXT NOT NULL, captured_at TEXT NOT NULL) STRICT;`);
  db.exec('CREATE TABLE IF NOT EXISTS prompt_governance_migrations (id INTEGER PRIMARY KEY) STRICT;');
  const insert = db.prepare('INSERT OR IGNORE INTO prompt_templates (slug,name,kind,created_at) VALUES (?,?,?,?)');
  const lookup = db.prepare('SELECT id FROM prompt_templates WHERE kind=?');
  const count = db.prepare('SELECT COUNT(*) AS count FROM prompt_versions WHERE template_id=?');
  const draft = db.prepare("INSERT INTO prompt_versions(template_id,version,content,status,content_sha256,created_at) VALUES (?,1,?,'DRAFT',?,?)");
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT id FROM prompt_governance_migrations WHERE id=1').get()) {
      db.prepare(`INSERT OR IGNORE INTO task_prompt_runtimes SELECT id,'null',? FROM tasks WHERE attempts>0`)
        .run(new Date().toISOString());
      db.exec('INSERT INTO prompt_governance_migrations VALUES (1)');
    }
    for (const item of PROMPT_CATALOG.filter(({ kind }) => !['TEXT_SYSTEM','IMAGE_SYSTEM','IMAGE_EDIT_SYSTEM'].includes(kind))) {
      const now = new Date().toISOString();
      if (!lookup.get(item.kind)) insert.run(`business-${item.kind.toLowerCase()}`, item.label, item.kind, now);
      const template = lookup.get(item.kind);
      if (count.get(template.id).count === 0) {
        const content = defaultBusinessPrompt(item.kind);
        draft.run(template.id, content, hashPrompt(content), now);
      }
    }
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function createPromptGovernanceStore(db) {
  return {
    pinTaskPromptRuntime(taskId, originalPrompts = {}) {
      const saved = db.prepare('SELECT value_json FROM task_prompt_runtimes WHERE task_id=?').get(taskId);
      if (saved) return JSON.parse(saved.value_json);
      const settings = db.prepare('SELECT value_json FROM prompt_runtime_settings WHERE id=1').get();
      const versions = db.prepare(`SELECT pt.kind,pv.* FROM prompt_versions pv JOIN prompt_templates pt
        ON pt.id=pv.template_id WHERE pv.status='PUBLISHED'`).all();
      const prompts = Object.fromEntries(versions.map((row) => [row.kind, { versionId: row.id, version: row.version, content: row.content }]));
      for (const [kind, content] of Object.entries(originalPrompts)) {
        const original = db.prepare(`SELECT pv.* FROM prompt_versions pv JOIN prompt_templates pt ON pt.id=pv.template_id
          WHERE pt.kind=? AND pv.content=? ORDER BY pv.id DESC LIMIT 1`).get(kind, content);
        prompts[kind] = { content, versionId: original?.id ?? null, version: original?.version ?? null };
      }
      const value = settings ? createPromptRuntime({ prompts, settings: JSON.parse(settings.value_json), source: 'LOCAL_TASK_SNAPSHOT' }) : null;
      db.prepare('INSERT OR IGNORE INTO task_prompt_runtimes VALUES (?,?,?)').run(taskId, JSON.stringify(value), new Date().toISOString());
      return JSON.parse(db.prepare('SELECT value_json FROM task_prompt_runtimes WHERE task_id=?').get(taskId).value_json);
    },
    getPromptRuntimeSettings() {
      const row = db.prepare('SELECT value_json FROM prompt_runtime_settings WHERE id=1').get();
      return row ? normalizePromptPolicy(JSON.parse(row.value_json)) : null;
    },
    setPromptRuntimeSettings(input) {
      const value = normalizePromptPolicy(input);
      db.prepare(`INSERT INTO prompt_runtime_settings VALUES (1,?,?) ON CONFLICT(id)
        DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).run(JSON.stringify(value), new Date().toISOString());
      return value;
    },
  };
}
