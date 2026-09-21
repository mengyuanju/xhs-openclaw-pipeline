import { randomUUID } from 'node:crypto';

import {
  COPY_QA_REASON_GROUPS,
  COPY_QA_SYSTEM_REASONS,
  copyQaReasonDefinition,
} from '../../src/copy-qa-reasons.mjs';
import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeUuid,
} from './domain.mjs';

const GROUPS = new Set(COPY_QA_REASON_GROUPS.map((group) => group.code));
const CUSTOM_REASON_PATTERN = /^CUSTOM:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

function normalizeActor(rawActor) {
  if (!rawActor || !['ADMIN', 'REVIEWER', 'USER'].includes(rawActor.role)
      || !Number.isSafeInteger(Number(rawActor.userId))) {
    throw new ControlPlaneAuthorizationError('current role cannot manage copy QA reason tags');
  }
  return {
    ...rawActor,
    userId: Number(rawActor.userId),
    username: String(rawActor.username ?? '').trim().toLowerCase(),
  };
}

async function assertActiveQualityActor(client, actor) {
  const credentialVersion = Number(actor.credentialVersion);
  const result = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3 AND status = 'ACTIVE'
      AND ($4::integer IS NULL OR credential_version = $4)
      AND (role = 'ADMIN' OR copy_qc_enabled = true)
  `, [actor.userId, actor.username, actor.role,
    Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : null]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
}

function normalizeGroup(value) {
  const group = String(value ?? '').trim().toUpperCase();
  if (!GROUPS.has(group)) throw new TypeError('reason tag group must be TITLE, BODY or PLAN');
  return group;
}

function normalizeLabel(value) {
  const label = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if ([...label].length < 2 || [...label].length > 20) {
    throw new RangeError('问题标签需要包含 2–20 个字');
  }
  return label;
}

function normalizedLabel(label) {
  return label.toLocaleLowerCase('zh-CN');
}

function tagFrom(row, actor) {
  const ownedByActor = Number(row.owner_account_id) === actor.userId;
  return {
    code: `CUSTOM:${row.public_id}`,
    publicId: row.public_id,
    group: row.group_code,
    label: row.label,
    visibility: row.visibility,
    status: row.status,
    ownedByActor,
    ownerUsername: actor.role === 'ADMIN' ? row.owner_username : undefined,
    canRequestPublic: ownedByActor && row.visibility === 'PRIVATE' && row.status === 'ACTIVE',
    canPublish: actor.role === 'ADMIN' && row.visibility === 'PRIVATE',
    canDisable: actor.role === 'ADMIN' || (ownedByActor && row.visibility === 'PRIVATE'),
  };
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listCopyQaReasonTags(pool, rawActor) {
  const actor = normalizeActor(rawActor);
  return transaction(pool, async (client) => {
    await assertActiveQualityActor(client, actor);
    const result = await client.query(`
      SELECT * FROM copy_qa_reason_tags
      WHERE status <> 'DISABLED'
        AND (visibility = 'PUBLIC' OR owner_account_id = $1 OR $2::varchar = 'ADMIN')
      ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,
        CASE visibility WHEN 'PUBLIC' THEN 0 ELSE 1 END,
        group_code, label, id
    `, [actor.userId, actor.role]);
    const visible = result.rows.map((row) => tagFrom(row, actor));
    return {
      version: 1,
      canPublish: actor.role === 'ADMIN',
      selectable: visible.filter((tag) => tag.visibility === 'PUBLIC' || tag.ownedByActor),
      managed: actor.role === 'ADMIN' ? visible : visible.filter((tag) => tag.ownedByActor),
    };
  });
}

export async function createCopyQaReasonTag(pool, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const group = normalizeGroup(input?.group);
  const label = normalizeLabel(input?.label);
  const canonicalLabel = normalizedLabel(label);
  const requestPublic = input?.requestPublic === true;
  if (COPY_QA_SYSTEM_REASONS.some((reason) => reason.group === group
      && normalizedLabel(reason.label) === canonicalLabel)) {
    throw new ControlPlaneConflictError('REASON_TAG_DUPLICATE', '同一分类下已有这个系统标签');
  }
  return transaction(pool, async (client) => {
    await assertActiveQualityActor(client, actor);
    const duplicate = await client.query(`
      SELECT * FROM copy_qa_reason_tags
      WHERE group_code = $1 AND normalized_label = $2 AND status <> 'DISABLED'
        AND (visibility = 'PUBLIC' OR owner_account_id = $3)
      ORDER BY visibility = 'PUBLIC' DESC, id LIMIT 1
    `, [group, canonicalLabel, actor.userId]);
    if (duplicate.rows[0]) {
      if (Number(duplicate.rows[0].owner_account_id) === actor.userId) {
        return tagFrom(duplicate.rows[0], actor);
      }
      throw new ControlPlaneConflictError('REASON_TAG_DUPLICATE', '同一分类下已有同名标签');
    }
    const publishImmediately = actor.role === 'ADMIN' && requestPublic;
    const inserted = await client.query(`
      INSERT INTO copy_qa_reason_tags(
        public_id, group_code, label, normalized_label,
        owner_account_id, owner_username, visibility, status,
        public_requested_at, public_reviewed_at,
        public_reviewed_by_account_id, public_reviewed_by_username
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $9::boolean THEN now() ELSE NULL END,
        CASE WHEN $10::boolean THEN now() ELSE NULL END,
        CASE WHEN $10::boolean THEN $5::bigint ELSE NULL END,
        CASE WHEN $10::boolean THEN $6::varchar ELSE NULL END)
      RETURNING *
    `, [randomUUID(), group, label, canonicalLabel, actor.userId, actor.username,
      publishImmediately ? 'PUBLIC' : 'PRIVATE',
      requestPublic && !publishImmediately ? 'PENDING' : 'ACTIVE',
      requestPublic, publishImmediately]);
    return tagFrom(inserted.rows[0], actor);
  });
}

export async function updateCopyQaReasonTag(pool, rawPublicId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'reasonTagId');
  const action = String(input?.action ?? '').trim().toUpperCase();
  if (!['REQUEST_PUBLIC', 'PUBLISH', 'REJECT', 'DISABLE'].includes(action)) {
    throw new TypeError('reason tag action is invalid');
  }
  return transaction(pool, async (client) => {
    await assertActiveQualityActor(client, actor);
    const existing = await client.query(
      'SELECT * FROM copy_qa_reason_tags WHERE public_id = $1 FOR UPDATE',
      [publicId],
    );
    const tag = existing.rows[0];
    if (!tag) throw new ControlPlaneNotFoundError('问题标签不存在');
    const ownedByActor = Number(tag.owner_account_id) === actor.userId;
    if (action === 'REQUEST_PUBLIC') {
      if (!ownedByActor || tag.visibility !== 'PRIVATE' || tag.status !== 'ACTIVE') {
        throw new ControlPlaneAuthorizationError('只能申请公开自己的个人标签');
      }
      await client.query(`UPDATE copy_qa_reason_tags
        SET status = 'PENDING', public_requested_at = now(), updated_at = now()
        WHERE id = $1`, [tag.id]);
    } else if (action === 'PUBLISH') {
      if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('只有管理员可以发布公共标签');
      const duplicate = await client.query(`SELECT id FROM copy_qa_reason_tags
        WHERE id <> $1 AND group_code = $2 AND normalized_label = $3
          AND visibility = 'PUBLIC' AND status = 'ACTIVE' LIMIT 1`,
      [tag.id, tag.group_code, tag.normalized_label]);
      if (duplicate.rows[0]) {
        throw new ControlPlaneConflictError('REASON_TAG_DUPLICATE', '公共标签库已有同名标签');
      }
      await client.query(`UPDATE copy_qa_reason_tags
        SET visibility = 'PUBLIC', status = 'ACTIVE', public_reviewed_at = now(),
          public_reviewed_by_account_id = $2, public_reviewed_by_username = $3, updated_at = now()
        WHERE id = $1`, [tag.id, actor.userId, actor.username]);
    } else if (action === 'REJECT') {
      if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('只有管理员可以处理公共标签申请');
      await client.query(`UPDATE copy_qa_reason_tags
        SET visibility = 'PRIVATE', status = 'ACTIVE', public_reviewed_at = now(),
          public_reviewed_by_account_id = $2, public_reviewed_by_username = $3, updated_at = now()
        WHERE id = $1`, [tag.id, actor.userId, actor.username]);
    } else {
      if (actor.role !== 'ADMIN' && (!ownedByActor || tag.visibility !== 'PRIVATE')) {
        throw new ControlPlaneAuthorizationError('只能停用自己的个人标签');
      }
      await client.query(`UPDATE copy_qa_reason_tags
        SET status = 'DISABLED', updated_at = now() WHERE id = $1`, [tag.id]);
    }
    const updated = await client.query('SELECT * FROM copy_qa_reason_tags WHERE id = $1', [tag.id]);
    return tagFrom(updated.rows[0], actor);
  });
}

export async function resolveCopyQaReasonSnapshots(client, reasonCodes, rawActor) {
  const actor = normalizeActor(rawActor);
  const customIds = [];
  for (const code of reasonCodes) {
    if (copyQaReasonDefinition(code)) continue;
    const match = CUSTOM_REASON_PATTERN.exec(code);
    if (match) customIds.push(match[1].toLowerCase());
  }
  const customById = new Map();
  if (customIds.length) {
    const result = await client.query(`
      SELECT * FROM copy_qa_reason_tags
      WHERE public_id = ANY($1::uuid[])
        AND status IN ('ACTIVE', 'PENDING')
        AND (visibility = 'PUBLIC' OR owner_account_id = $2)
    `, [customIds, actor.userId]);
    for (const row of result.rows) customById.set(String(row.public_id), row);
  }
  return reasonCodes.map((code) => {
    const system = copyQaReasonDefinition(code);
    if (system) return { code, group: system.group, label: system.label, source: 'SYSTEM' };
    const customMatch = CUSTOM_REASON_PATTERN.exec(code);
    if (!customMatch) {
      // Historical API clients could submit bounded free-form codes. Preserve
      // those verdicts and their readable code instead of invalidating retries.
      return { code, group: 'BODY', label: code, source: 'LEGACY' };
    }
    const publicId = customMatch[1].toLowerCase();
    const custom = customById.get(publicId);
    if (!custom) throw new ControlPlaneConflictError('REASON_TAG_UNAVAILABLE', '自定义问题标签已停用或对当前账号不可见');
    return {
      code,
      group: custom.group_code,
      label: custom.label,
      source: 'CUSTOM',
      visibility: custom.visibility,
    };
  });
}
