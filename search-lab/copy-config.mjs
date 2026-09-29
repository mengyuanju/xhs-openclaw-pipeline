import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

import { readPromptConfiguration } from '../src/admin/prompt-runtime-service.mjs';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';
import { createPromptRuntime, defaultBusinessPrompt } from '../src/prompt-runtime.mjs';
import { DEFAULT_PRODUCTION_SETTINGS, normalizeProductionSettings } from '../src/production-settings.mjs';
import { loadServerEnvironment } from '../server/src/server-environment.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const profiles = new Set(['development', 'production']);
const readEnvironmentFile = (path) => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};

// Inspect only the local server owning the configured port. Never guess an
// administrator identity or send fabricated authentication headers.
export async function detectLocalCenterProfile({ environment, platform = process.platform, execute = runFile } = {}) {
  if (platform !== 'win32' || !environment?.CONTROL_PLANE_URL) return null;
  let url;
  try { url = new URL(environment.CONTROL_PLANE_URL); } catch { return null; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const script = `$connection = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($connection) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $connection.OwningProcess); if ($process.CommandLine -match 'src[\\/]cli\\.mjs\\s+serve(?:\\s|$)') { if ($process.CommandLine -match '--environment=(production|development)') { $Matches[1] } else { 'development' } } }`;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 2048, shell: false });
    const value = stdout.trim();
    return profiles.has(value) ? value : null;
  } catch { return null; }
}

function sourceConfiguration(configuration, source, label, warnings = []) {
  return { ...configuration, source, sourceLabel: label, warnings,
    promptRuntime: configuration.promptRuntime ? createPromptRuntime({ ...configuration.promptRuntime, source }) : null };
}

async function postgresConfiguration({ connectionString, profile, postgresClientFactory }) {
  const factory = postgresClientFactory ?? ((options) => new (serverRequire('pg').Client)(options));
  const client = factory({ connectionString, connectionTimeoutMillis: 3000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000' });
  try {
    await client.connect();
    // A repeatable, read-only snapshot keeps published rules, policies and
    // knowledge consistent even if an administrator publishes while loading.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settings = await client.query('SELECT key, value, version, updated_at FROM global_settings WHERE key = ANY($1::text[]) ORDER BY key',
      [['production', 'prompt_runtime']]);
    const promptRows = await client.query(`SELECT t.id AS template_id, t.kind, t.name,
      v.id AS version_id, v.version, v.content, v.content_sha256, v.created_at, v.published_at
      FROM prompt_templates t LEFT JOIN prompt_versions v ON v.template_id = t.id AND v.status = $1
      ORDER BY t.kind`, ['PUBLISHED']);
    const knowledgeRows = await client.query(`SELECT i.id AS item_id, i.kind, i.name,
      v.id AS version_id, v.version, v.content, v.storage_path, v.content_sha256
      FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.status = $1
      WHERE i.status = $2 ORDER BY i.kind, i.id`, ['PUBLISHED', 'ACTIVE']);
    await client.query('COMMIT');
    const templates = promptRows.rows.map((row) => ({ id: Number(row.template_id), kind: row.kind, name: row.name,
      versions: row.version_id === null ? [] : [{ id: Number(row.version_id), version: Number(row.version),
        content: row.content, sha256: row.content_sha256, status: 'PUBLISHED',
        createdAt: row.created_at, publishedAt: row.published_at }] }));
    const knowledge = knowledgeRows.rows.map((row) => ({ kind: row.kind, name: row.name, itemId: Number(row.item_id),
      versionId: Number(row.version_id), version: Number(row.version), content: row.content,
      storagePath: row.storage_path, sha256: row.content_sha256 }));
    const configuration = await readPromptConfiguration({ controlPlane: {
      listPrompts: async () => templates,
      listSettings: async () => settings.rows,
      listKnowledge: async () => knowledge,
    } });
    if (!configuration.systemPrompt.trim()) throw new Error('中心尚未发布文案生成提示词');
    return sourceConfiguration(configuration, 'CENTER_DATABASE',
      `当前中心系统（${profile === 'production' ? '生产' : profile === 'development' ? '开发' : '指定'}库，只读）`);
  } catch (error) {
    await Promise.resolve().then(() => client.query('ROLLBACK')).catch(() => {});
    throw error;
  } finally { await client.end(); }
}

function sqliteStore(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  if (!tables.has('prompt_templates') || !tables.has('prompt_versions')) throw new Error('本机数据库缺少提示词配置');
  const rows = (table, query, ...params) => tables.has(table) ? db.prepare(query).all(...params) : [];
  return {
    listPromptTemplates() {
      const templates = db.prepare('SELECT * FROM prompt_templates ORDER BY id').all().map((row) => ({
        id: Number(row.id), kind: row.kind, name: row.name, slug: row.slug, createdAt: row.created_at, versions: [] }));
      const byId = new Map(templates.map((item) => [item.id, item]));
      for (const row of db.prepare('SELECT * FROM prompt_versions ORDER BY template_id, version DESC').all()) {
        byId.get(Number(row.template_id))?.versions.push({ id: Number(row.id), templateId: Number(row.template_id),
          version: Number(row.version), content: row.content, contentSha256: row.content_sha256,
          status: row.status, createdAt: row.created_at, publishedAt: row.published_at });
      }
      return templates;
    },
    getPromptRuntimeSettings() {
      const row = rows('prompt_runtime_settings', 'SELECT value_json FROM prompt_runtime_settings WHERE id = ?', 1)[0];
      return row ? JSON.parse(row.value_json) : null;
    },
    getProductionSettings() {
      const row = rows('production_settings', 'SELECT settings_json FROM production_settings WHERE id = ?', 1)[0];
      return { settings: row ? normalizeProductionSettings(JSON.parse(row.settings_json)) : DEFAULT_PRODUCTION_SETTINGS };
    },
    listCopyKnowledge({ page = 1, pageSize = 100 } = {}) {
      const count = rows('copy_knowledge_items', 'SELECT COUNT(*) AS count FROM copy_knowledge_items')[0]?.count ?? 0;
      const items = rows('copy_knowledge_items', 'SELECT * FROM copy_knowledge_items ORDER BY id DESC LIMIT ? OFFSET ?',
        pageSize, (page - 1) * pageSize);
      const labels = tables.has('copy_knowledge_item_labels') && tables.has('copy_knowledge_labels')
        ? db.prepare(`SELECT links.item_id, labels.name FROM copy_knowledge_item_labels links
          JOIN copy_knowledge_labels labels ON labels.id = links.label_id ORDER BY links.item_id, links.position`).all() : [];
      const byItem = new Map();
      for (const row of labels) { const list = byItem.get(Number(row.item_id)) ?? []; list.push(row.name); byItem.set(Number(row.item_id), list); }
      return { data: items.map((row) => ({ id: Number(row.id), title: row.title, sourceCopy: row.source_copy,
        sourceCopySha256: row.source_copy_sha256, analysisPrompt: row.analysis_prompt, summary: row.summary,
        analysis: row.analysis, analysisModel: row.analysis_model, labels: byItem.get(Number(row.id)) ?? [], createdAt: row.created_at })),
      pagination: { page, pageSize, totalItems: Number(count), totalPages: Math.max(1, Math.ceil(Number(count) / pageSize)) } };
    },
    listVisualKnowledge() {
      if (!tables.has('visual_knowledge_items') || !tables.has('visual_knowledge_versions')) return { data: [] };
      const versions = db.prepare(`SELECT v.*, i.generation_target FROM visual_knowledge_versions v
        JOIN visual_knowledge_items i ON i.id = v.item_id WHERE v.status = ? ORDER BY v.item_id`).all('PUBLISHED');
      return { data: versions.map((row) => ({ id: Number(row.item_id), publishedVersion: {
        id: Number(row.id), itemId: Number(row.item_id), version: Number(row.version), generationTarget: row.generation_target,
        promptTemplate: row.prompt_template, negativePrompt: row.negative_prompt,
        styleTags: JSON.parse(row.style_tags_json), categories: JSON.parse(row.categories_json),
        layoutRules: JSON.parse(row.layout_rules_json), qualityScore: Number(row.quality_score),
        analysisModel: row.analysis_model, contentSha256: row.content_sha256, status: row.status,
        createdAt: row.created_at, publishedAt: row.published_at } })) };
    },
  };
}

function bundledConfiguration(warnings) {
  const prompts = Object.fromEntries(PROMPT_CATALOG.filter(({ layer, editable }) => layer === 'BUSINESS' && editable !== false)
    .map(({ kind }) => [kind, { content: defaultBusinessPrompt(kind), source: 'BUNDLED_DEFAULT' }]));
  const runtime = createPromptRuntime({ prompts, settings: null, source: 'BUNDLED_DEFAULT' });
  return { templates: [], settings: null, productionSettings: DEFAULT_PRODUCTION_SETTINGS, knowledge: [],
    source: 'BUNDLED_DEFAULT', sourceLabel: '仓库内置提示词原文', warnings,
    promptRuntime: runtime, systemPrompt: runtime.prompts.TEXT_SYSTEM.content,
    imageSystemPrompt: runtime.prompts.IMAGE_SYSTEM.content, visualReference: null };
}

/** Read-only configuration. Secrets remain in the server-side environment. */
export async function loadCopyConfiguration({ environment = process.env, projectRoot = projectDirectory,
  controlPlane = null, store = null, connectionString = null, serverEnvironment = null,
  postgresClientFactory, sqliteOpen = (path, options) => new DatabaseSync(path, options),
  detectProfile = detectLocalCenterProfile } = {}) {
  if (controlPlane) return readPromptConfiguration({ controlPlane });
  if (store) return readPromptConfiguration({ store });
  const warnings = [];
  const serverRoot = join(projectRoot, 'server');
  const base = readEnvironmentFile(join(serverRoot, '.env'));
  const explicitProfile = serverEnvironment ?? environment.SEARCH_LAB_SERVER_ENV ?? environment.XHS_SERVER_ENV;
  if (explicitProfile && !profiles.has(explicitProfile)) throw new TypeError('SEARCH_LAB_SERVER_ENV 必须为 development 或 production');
  const profile = explicitProfile ?? await detectProfile({ environment });
  let localCenter = false;
  if (environment.CONTROL_PLANE_URL) {
    try {
      const url = new URL(environment.CONTROL_PLANE_URL);
      localCenter = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === Number(environment.CONTROL_PLANE_PORT ?? base.CONTROL_PLANE_PORT ?? 4310);
    } catch { warnings.push('当前中心服务地址无效，已尝试本机配置。'); }
  }
  const explicitConnection = connectionString ?? environment.SEARCH_LAB_DATABASE_URL;
  if (explicitConnection || (localCenter && profile)) {
    try {
      const centerEnvironment = explicitConnection ? null : loadServerEnvironment({ profile, serverRoot, environment }).environment;
      const configuration = await postgresConfiguration({ connectionString: explicitConnection ?? centerEnvironment.DATABASE_URL,
        profile, postgresClientFactory });
      return { ...configuration, serverEnvironment: profile };
    } catch {
      warnings.push('未能读取当前中心系统已发布配置，当前结果使用下方标明的本机或内置规则。');
    }
  } else if (environment.CONTROL_PLANE_URL) {
    warnings.push('未确认中心服务的本机环境，当前结果使用下方标明的本机或内置规则；可用 SEARCH_LAB_SERVER_ENV 指定生产或开发环境。');
  }
  const databasePath = resolve(projectRoot, environment.XHS_DB_PATH || 'data/queue.db');
  if (existsSync(databasePath)) {
    let db;
    try {
      db = sqliteOpen(databasePath, { readOnly: true });
      const configuration = await readPromptConfiguration({ store: sqliteStore(db) });
      if (!configuration.systemPrompt.trim()) throw new Error('本机尚未发布文案生成提示词');
      return sourceConfiguration(configuration, 'LOCAL_READ_ONLY', '本机已发布配置（SQLite，只读）', warnings);
    } catch { warnings.push('本机已发布文案配置不可用，使用仓库内置提示词原文。'); }
    finally { db?.close(); }
  } else warnings.push('未找到本机发布配置，使用仓库内置提示词原文。');
  return bundledConfiguration(warnings);
}
