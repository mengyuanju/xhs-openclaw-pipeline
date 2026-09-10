import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
} from './domain.mjs';

export const DEFAULT_WORKFLOW_QUALITY_SETTINGS = Object.freeze({
  version: 1,
  queryPackage: Object.freeze({ workerImportEnabled: false }),
  copySampling: Object.freeze({
    enabled: false,
    rateBps: 0,
    blindReviewEnabled: false,
    reviewerBatchReturnEnabled: false,
    samplingSeed: 'copy-sampling-v1',
  }),
});

function booleanValue(value, fallback, name) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return resolved;
}

function versionValue(value, name = 'expectedVersion') {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError(`${name} must be a positive integer`);
  return version;
}

export function workflowQualitySettingsFromRow(row) {
  if (!row) return structuredClone(DEFAULT_WORKFLOW_QUALITY_SETTINGS);
  return {
    version: Number(row.version),
    queryPackage: {
      workerImportEnabled: row.query_package_worker_import_enabled === true,
    },
    copySampling: {
      enabled: row.copy_sampling_enabled === true,
      rateBps: Number(row.copy_sampling_rate_bps),
      blindReviewEnabled: row.blind_review_enabled === true,
      reviewerBatchReturnEnabled: row.reviewer_batch_return_enabled === true,
      samplingSeed: row.sampling_seed ?? 'copy-sampling-v1',
    },
    updatedByUsername: row.updated_by_username ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function normalizeWorkflowQualitySettings(input, current = DEFAULT_WORKFLOW_QUALITY_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('workflow quality settings must be an object');
  }
  const queryPackage = input.queryPackage ?? {};
  const copySampling = input.copySampling ?? {};
  if (!queryPackage || typeof queryPackage !== 'object' || Array.isArray(queryPackage)) {
    throw new TypeError('queryPackage settings must be an object');
  }
  if (!copySampling || typeof copySampling !== 'object' || Array.isArray(copySampling)) {
    throw new TypeError('copySampling settings must be an object');
  }
  const rateBps = copySampling.rateBps ?? current.copySampling.rateBps;
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError('copySampling.rateBps must be an integer between 0 and 10000');
  }
  return {
    queryPackage: {
      workerImportEnabled: booleanValue(
        queryPackage.workerImportEnabled,
        current.queryPackage.workerImportEnabled,
        'queryPackage.workerImportEnabled',
      ),
    },
    copySampling: {
      enabled: booleanValue(copySampling.enabled, current.copySampling.enabled, 'copySampling.enabled'),
      rateBps,
      blindReviewEnabled: booleanValue(
        copySampling.blindReviewEnabled,
        current.copySampling.blindReviewEnabled,
        'copySampling.blindReviewEnabled',
      ),
      reviewerBatchReturnEnabled: booleanValue(
        copySampling.reviewerBatchReturnEnabled,
        current.copySampling.reviewerBatchReturnEnabled,
        'copySampling.reviewerBatchReturnEnabled',
      ),
    },
  };
}

export function assertQueryPackageImportAllowed(actor, settings) {
  if (actor?.role === 'ADMIN') return;
  throw new ControlPlaneAuthorizationError('当前账号没有创建 Query 词包的权限');
}

export function assertReviewerBatchReturnAllowed(actor, settings) {
  if (actor?.role === 'ADMIN') return;
  if (actor?.role === 'REVIEWER' && settings.copySampling.reviewerBatchReturnEnabled) return;
  throw new ControlPlaneAuthorizationError('当前质检员没有整批打回权限');
}

export async function readWorkflowQualitySettings(queryable) {
  const result = await queryable.query('SELECT * FROM workflow_quality_settings WHERE singleton = 1');
  return workflowQualitySettingsFromRow(result.rows[0]);
}

export async function lockWorkflowQualitySettings(queryable) {
  const result = await queryable.query(
    'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR SHARE',
  );
  return workflowQualitySettingsFromRow(result.rows[0]);
}

async function lockActiveWorkflowSettingsAdmin(client, actor) {
  const userId = Number(actor?.userId);
  const username = String(actor?.username ?? '').trim().toLowerCase();
  const credentialVersion = Number(actor?.credentialVersion);
  if (!Number.isSafeInteger(userId) || userId < 1 || !username
      || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new ControlPlaneAuthenticationError();
  }
  const result = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = 'ADMIN'
      AND status = 'ACTIVE' AND credential_version = $3
    FOR SHARE
  `, [userId, username, credentialVersion]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
  return { userId, username, credentialVersion };
}

export async function updateWorkflowQualitySettings(pool, input, actor) {
  if (actor?.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can update workflow quality settings');
  }
  const expectedVersion = versionValue(input?.expectedVersion);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activeActor = await lockActiveWorkflowSettingsAdmin(client, actor);
    const currentResult = await client.query(
      'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR UPDATE',
    );
    const current = workflowQualitySettingsFromRow(currentResult.rows[0]);
    if (current.version !== expectedVersion) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '质量流程设置已被其他管理员修改');
    }
    const settings = normalizeWorkflowQualitySettings(input, current);
    const result = await client.query(`
      UPDATE workflow_quality_settings SET
        query_package_worker_import_enabled = $1,
        copy_sampling_enabled = $2,
        copy_sampling_rate_bps = $3,
        blind_review_enabled = $4,
        reviewer_batch_return_enabled = $5,
        version = version + 1,
        updated_by_username = $6,
        updated_at = now()
      WHERE singleton = 1 AND version = $7
      RETURNING *
    `, [
      settings.queryPackage.workerImportEnabled,
      settings.copySampling.enabled,
      settings.copySampling.rateBps,
      settings.copySampling.blindReviewEnabled,
      settings.copySampling.reviewerBatchReturnEnabled,
      activeActor.username,
      expectedVersion,
    ]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError('VERSION_CONFLICT', '质量流程设置已被其他管理员修改');
    }
    await client.query('COMMIT');
    return workflowQualitySettingsFromRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
