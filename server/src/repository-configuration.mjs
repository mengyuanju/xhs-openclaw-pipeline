import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
  changeLayoutCatalog,
  createHash,
  layoutCatalogRecord,
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
  normalizeImageEditRepairMaxAttempts,
  normalizeJson,
  normalizeLayoutCatalog,
  normalizeLayoutPresets,
  normalizeTaskId,
  normalizeXiaohongshuSearchSettings,
  transaction
} from './repository-context.mjs';
import { AccountRepository } from './repository-accounts.mjs';
import { listCopyKnowledgeOverview } from './knowledge-read.mjs';

export class ConfigurationRepository extends AccountRepository {
  async upsertSetting(rawKey, rawValue, { expectedVersion } = {}) {
    const key = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9._-]{0,99}$/u.test(key)) throw new TypeError('setting key is invalid');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
      throw new TypeError('setting expectedVersion is invalid');
    }
    const jsonValue = normalizeJson(rawValue, 'setting value', 1_000_000);
    const value = key === XIAOHONGSHU_SEARCH_SETTINGS_KEY
      ? normalizeXiaohongshuSearchSettings(jsonValue)
      : jsonValue;
    if (key === 'production' && value?.imageEditRepairMaxAttempts !== undefined) {
      value.imageEditRepairMaxAttempts = normalizeImageEditRepairMaxAttempts(
        value.imageEditRepairMaxAttempts,
      );
    }
    if (key === 'production' && value?.layoutPresets !== undefined) value.layoutPresets = normalizeLayoutPresets(value.layoutPresets);
    if (key === 'production' && value?.humanQualityReasons !== undefined) {
      value.humanQualityReasons = normalizeHumanQualitySettingsUpdate(value.humanQualityReasons);
    }
    if (key === 'production' && value?.layoutCatalog !== undefined) {
      value.layoutCatalog = normalizeLayoutCatalog(value.layoutCatalog);
      const current = await this.getLayoutCatalog();
      if (current.revision !== layoutCatalogRecord(value).revision) throw new TypeError('请在布局模板库中更新目录，避免覆盖其他编辑');
    }
    if (expectedVersion > 0) {
      const existing = await this.pool.query('SELECT version FROM global_settings WHERE key = $1', [key]);
      if (!existing.rows.length) {
        throw new ControlPlaneConflictError('VERSION_CONFLICT', '设置已被其他管理员修改，请刷新后重试');
      }
    }
    const result = await this.factPool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET
        value = CASE WHEN excluded.key = 'production' THEN
          excluded.value
          || CASE WHEN global_settings.value ? 'layoutCatalog'
            THEN jsonb_build_object('layoutCatalog', global_settings.value->'layoutCatalog') ELSE '{}'::jsonb END
          || CASE WHEN global_settings.value ? 'humanQualityReasons'
            THEN jsonb_build_object('humanQualityReasons', global_settings.value->'humanQualityReasons') ELSE '{}'::jsonb END
          ELSE excluded.value END,
        version = global_settings.version + 1, updated_at = now()
      WHERE ${expectedVersion === undefined ? 'true' : 'global_settings.version = $3'}
      RETURNING *
    `, expectedVersion === undefined ? [key, value] : [key, value, expectedVersion]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '设置已被其他管理员修改，请刷新后重试');
    }
    return {
      key: result.rows[0].key,
      value: result.rows[0].value,
      version: Number(result.rows[0].version),
      updatedAt: result.rows[0].updated_at,
    };
  }

  async listSettings() {
    const result = await this.pool.query('SELECT * FROM global_settings ORDER BY key');
    return result.rows.map((row) => ({
      key: row.key,
      value: row.value,
      version: Number(row.version),
      updatedAt: row.updated_at,
    }));
  }

  async getHumanQualitySettings() {
    const result = await this.pool.query("SELECT value FROM global_settings WHERE key = 'production'");
    return normalizeHumanQualitySettings(result.rows[0]?.value?.humanQualityReasons);
  }

  async updateHumanQualitySettings(input) {
    return transaction(this.pool, async client => {
      await client.query("INSERT INTO global_settings(key, value) VALUES ('production', '{}'::jsonb) ON CONFLICT(key) DO NOTHING");
      const current = await client.query("SELECT value FROM global_settings WHERE key = 'production' FOR UPDATE");
      const settings = normalizeHumanQualitySettingsUpdate(
        input,
        current.rows[0]?.value?.humanQualityReasons,
      );
      const result = await client.query(`
        UPDATE global_settings SET
          value = jsonb_set(value, '{humanQualityReasons}', $1::jsonb, true),
          version = version + 1,
          updated_at = now()
        WHERE key = 'production'
        RETURNING value
      `, [JSON.stringify(settings)]);
      return normalizeHumanQualitySettings(result.rows[0].value.humanQualityReasons);
    });
  }

  async getLayoutCatalog() {
    const result = await this.pool.query("SELECT value FROM global_settings WHERE key = 'production'");
    return layoutCatalogRecord(result.rows[0]?.value ?? {});
  }

  async updateLayoutCatalog(input, options = {}) {
    return transaction(this.pool, async client => {
      await client.query("INSERT INTO global_settings(key, value) VALUES ('production', '{}'::jsonb) ON CONFLICT(key) DO NOTHING");
      const current = await client.query("SELECT value FROM global_settings WHERE key = 'production' FOR UPDATE");
      const changed = changeLayoutCatalog(current.rows[0].value, input, options);
      if (JSON.stringify(changed.settings) !== JSON.stringify(current.rows[0].value)) {
        await client.query("UPDATE global_settings SET value = $1, version = version + 1, updated_at = now() WHERE key = 'production'", [changed.settings]);
      }
      return changed.record;
    });
  }

  async seedSetting(rawKey, rawValue) {
    const key = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9._-]{0,99}$/u.test(key)) throw new TypeError('setting key is invalid');
    const value = normalizeJson(rawValue, 'setting value', 1_000_000);
    const result = await this.factPool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO NOTHING
      RETURNING *
    `, [key, value]);
    return result.rows[0] !== undefined;
  }

  async createPromptVersion({ kind: rawKind, name: rawName, content: rawContent }) {
    const kind = String(rawKind ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,79}$/u.test(kind)) throw new TypeError('prompt kind is invalid');
    const name = String(rawName ?? kind).trim();
    const content = String(rawContent ?? '');
    if (!name || [...name].length > 160) throw new TypeError('prompt name is invalid');
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 500_000) {
      throw new TypeError('prompt content is invalid');
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    return transaction(this.pool, async (client) => {
      const template = await client.query(`
        INSERT INTO prompt_templates(kind, name) VALUES ($1, $2)
        ON CONFLICT(kind) DO UPDATE SET name = excluded.name, updated_at = now()
        RETURNING *
      `, [kind, name]);
      const version = Number((await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM prompt_versions WHERE template_id = $1
      `, [template.rows[0].id])).rows[0].version);
      const inserted = await client.query(`
        INSERT INTO prompt_versions(template_id, version, content, content_sha256)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [template.rows[0].id, version, content, sha256]);
      return {
        id: Number(inserted.rows[0].id),
        templateId: Number(template.rows[0].id),
        kind,
        name,
        version,
        content,
        sha256,
        status: 'DRAFT',
      };
    });
  }

  async publishPromptVersion(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    return transaction(this.pool, async (client) => {
      const version = await client.query(`
        SELECT * FROM prompt_versions WHERE id = $1 FOR UPDATE
      `, [versionId]);
      if (!version.rows[0]) throw new ControlPlaneNotFoundError('prompt version not found');
      await client.query(`
        UPDATE prompt_versions SET status = 'ARCHIVED'
        WHERE template_id = $1 AND status = 'PUBLISHED'
      `, [version.rows[0].template_id]);
      const published = await client.query(`
        UPDATE prompt_versions SET status = 'PUBLISHED', published_at = now()
        WHERE id = $1 RETURNING *
      `, [versionId]);
      return {
        id: Number(published.rows[0].id),
        templateId: Number(published.rows[0].template_id),
        version: Number(published.rows[0].version),
        status: published.rows[0].status,
        publishedAt: published.rows[0].published_at,
      };
    });
  }

  async listPrompts() {
    const result = await this.pool.query(`
      SELECT t.id AS template_id, t.kind, t.name,
             v.id AS version_id, v.version, v.content, v.content_sha256,
             v.status AS version_status, v.created_at AS version_created_at,
             v.published_at
      FROM prompt_templates t
      LEFT JOIN prompt_versions v ON v.template_id = t.id
      ORDER BY t.kind, v.version DESC
    `);
    const templates = new Map();
    for (const row of result.rows) {
      const template = templates.get(row.kind) ?? {
        id: Number(row.template_id), kind: row.kind, name: row.name, versions: [],
      };
      if (row.version_id !== null) template.versions.push({
        id: Number(row.version_id),
        version: Number(row.version),
        content: row.content,
        sha256: row.content_sha256,
        status: row.version_status,
        createdAt: row.version_created_at,
        publishedAt: row.published_at,
      });
      templates.set(row.kind, template);
    }
    return [...templates.values()];
  }

  async createKnowledgeVersion({
    itemId: rawItemId = null,
    kind: rawKind,
    name: rawName,
    content: rawContent = {},
    storagePath = null,
    sha256 = null,
    publish = false,
    expectedVersionId = null,
  }) {
    if (typeof publish !== 'boolean') throw new TypeError('publish must be boolean');
    const itemId = rawItemId === null ? null : normalizeTaskId(rawItemId);
    const kind = String(rawKind ?? '').trim().toUpperCase();
    if (!['COPY', 'VISUAL'].includes(kind)) throw new TypeError('knowledge kind is invalid');
    const name = String(rawName ?? '').trim();
    if (!name || [...name].length > 200) throw new TypeError('knowledge name is invalid');
    const content = normalizeJson(rawContent, 'knowledge content', 2_000_000);
    if (storagePath !== null && typeof storagePath !== 'string') {
      throw new TypeError('knowledge storagePath is invalid');
    }
    if (sha256 !== null && !/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new TypeError('knowledge sha256 is invalid');
    }
    return transaction(this.pool, async (client) => {
      let item;
      if (itemId === null && content.legacySource) {
        const { sourceKey, sourceId } = content.legacySource;
        if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 500) throw new TypeError('legacy source key is invalid');
        normalizeTaskId(sourceId);
        await client.query('SELECT pg_advisory_xact_lock(4310, hashtext($1))', [`${kind}:${sourceKey}:${sourceId}`]);
        const existing = await client.query(`
          SELECT v.*, i.name FROM knowledge_versions v JOIN knowledge_items i ON i.id = v.item_id
          WHERE i.kind = $1 AND v.content @> $2::jsonb ORDER BY v.version DESC LIMIT 1
        `, [kind, JSON.stringify({ legacySource: content.legacySource })]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          return { itemId: Number(row.item_id), versionId: Number(row.id), kind, name: row.name,
            content: row.content, status: row.status, skipped: true };
        }
      }
      if (itemId === null) {
        item = (await client.query(`
          INSERT INTO knowledge_items(kind, name) VALUES ($1, $2) RETURNING *
        `, [kind, name])).rows[0];
      } else {
        const selected = await client.query(`
          SELECT * FROM knowledge_items WHERE id = $1 FOR UPDATE
        `, [itemId]);
        if (!selected.rows[0]) throw new ControlPlaneNotFoundError('knowledge item not found');
        if (selected.rows[0].kind !== kind) throw new TypeError('knowledge kind cannot be changed');
        item = (await client.query(`
          UPDATE knowledge_items SET name = $2, updated_at = now() WHERE id = $1 RETURNING *
        `, [itemId, name])).rows[0];
      }
      const version = Number((await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM knowledge_versions WHERE item_id = $1
      `, [item.id])).rows[0].version);
      if (expectedVersionId !== null) {
        const latest = await client.query('SELECT id FROM knowledge_versions WHERE item_id = $1 ORDER BY version DESC LIMIT 1', [item.id]);
        if (Number(latest.rows[0]?.id) !== normalizeTaskId(expectedVersionId)) {
          throw new ControlPlaneConflictError('KNOWLEDGE_CHANGED', '知识已被其他页面修改，请刷新后重试');
        }
      }
      if (publish) {
        if (kind !== 'COPY') throw new TypeError('visual knowledge requires a separate publication review');
        await client.query("UPDATE knowledge_versions SET status = 'ARCHIVED' WHERE item_id = $1 AND status = 'PUBLISHED'", [item.id]);
      }
      const created = await client.query(`
        INSERT INTO knowledge_versions(
          item_id, version, content, storage_path, content_sha256
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [item.id, version, content, storagePath, sha256]);
      if (publish) await client.query("UPDATE knowledge_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [created.rows[0].id]);
      return {
        itemId: Number(item.id),
        kind,
        name,
        versionId: Number(created.rows[0].id),
        version,
        content,
        storagePath,
        sha256,
        status: publish ? 'PUBLISHED' : 'DRAFT',
      };
    });
  }

  async publishKnowledgeVersion(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    return transaction(this.pool, async (client) => {
      const version = await client.query(`
        SELECT * FROM knowledge_versions WHERE id = $1 FOR UPDATE
      `, [versionId]);
      if (!version.rows[0]) throw new ControlPlaneNotFoundError('knowledge version not found');
      const content = version.rows[0].content;
      if (content?.retentionMode === 'IMAGE_AND_PROMPT'
        && (!['SELF_OWNED', 'LICENSED'].includes(content.rightsStatus) || !version.rows[0].storage_path)) {
        throw new TypeError('retained visual knowledge requires an authorized uploaded image before publication');
      }
      await client.query(`
        UPDATE knowledge_versions SET status = 'ARCHIVED'
        WHERE item_id = $1 AND status = 'PUBLISHED'
      `, [version.rows[0].item_id]);
      const published = await client.query(`
        UPDATE knowledge_versions SET status = 'PUBLISHED', published_at = now()
        WHERE id = $1 RETURNING *
      `, [versionId]);
      return {
        versionId: Number(published.rows[0].id),
        itemId: Number(published.rows[0].item_id),
        version: Number(published.rows[0].version),
        status: published.rows[0].status,
        publishedAt: published.rows[0].published_at,
      };
    });
  }

  async listKnowledge() {
    const result = await this.pool.query(`
      SELECT i.id AS item_id, i.kind, i.name, i.status AS item_status,
             v.id AS version_id, v.version, v.content, v.storage_path,
             v.content_sha256, v.status AS version_status,
             v.created_at AS version_created_at, v.published_at
      FROM knowledge_items i
      LEFT JOIN knowledge_versions v ON v.item_id = i.id
      ORDER BY i.kind, i.id, v.version DESC
    `);
    const items = new Map();
    for (const row of result.rows) {
      const item = items.get(row.item_id) ?? {
        id: Number(row.item_id),
        kind: row.kind,
        name: row.name,
        status: row.item_status,
        versions: [],
      };
      if (row.version_id !== null) item.versions.push({
        id: Number(row.version_id),
        version: Number(row.version),
        content: row.content,
        storagePath: row.storage_path,
        sha256: row.content_sha256,
        status: row.version_status,
        createdAt: row.version_created_at,
        publishedAt: row.published_at,
      });
      items.set(row.item_id, item);
    }
    return [...items.values()];
  }

  listCopyKnowledgeOverview(options) {
    return listCopyKnowledgeOverview(this.pool, options);
  }

  async knowledgeUploadContext(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    const result = await this.pool.query(`
      SELECT v.id AS version_id, v.status, v.content, i.id AS item_id, i.kind
      FROM knowledge_versions v
      JOIN knowledge_items i ON i.id = v.item_id
      WHERE v.id = $1
    `, [versionId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('knowledge version not found');
    if (result.rows[0].status !== 'DRAFT') {
      throw new ControlPlaneConflictError(
        'KNOWLEDGE_VERSION_IMMUTABLE',
        'only a draft knowledge version can receive an asset',
      );
    }
    const content = result.rows[0].content;
    if (result.rows[0].kind !== 'VISUAL' || content?.retentionMode !== 'IMAGE_AND_PROMPT'
      || !['SELF_OWNED', 'LICENSED'].includes(content.rightsStatus)) {
      throw new TypeError('only self-owned or licensed retained visual images may be uploaded');
    }
    return {
      versionId,
      itemId: Number(result.rows[0].item_id),
      kind: result.rows[0].kind,
    };
  }

  async attachKnowledgeAsset({ versionId: rawVersionId, storagePath, sha256 }) {
    const versionId = normalizeTaskId(rawVersionId);
    if (typeof storagePath !== 'string' || !storagePath) throw new TypeError('storagePath is invalid');
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('knowledge sha256 is invalid');
    const result = await this.pool.query(`
      UPDATE knowledge_versions SET storage_path = $2, content_sha256 = $3
      WHERE id = $1 AND status = 'DRAFT'
      RETURNING id, item_id, storage_path, content_sha256
    `, [versionId, storagePath, sha256]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'KNOWLEDGE_VERSION_IMMUTABLE',
        'only a draft knowledge version can receive an asset',
      );
    }
    return {
      versionId: Number(result.rows[0].id),
      itemId: Number(result.rows[0].item_id),
      sha256: result.rows[0].content_sha256,
      url: `/v1/knowledge-versions/${versionId}/asset`,
    };
  }

  async getKnowledgeAsset(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    const result = await this.pool.query(`
      SELECT id, storage_path, content_sha256 FROM knowledge_versions WHERE id = $1
    `, [versionId]);
    if (!result.rows[0]?.storage_path) return null;
    return {
      versionId,
      storagePath: result.rows[0].storage_path,
      sha256: result.rows[0].content_sha256,
    };
  }
}
