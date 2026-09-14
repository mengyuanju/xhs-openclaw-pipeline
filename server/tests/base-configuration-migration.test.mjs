import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_CONFIGURATION_TABLES,
  INITIALIZED_TARGET_TABLES,
  assertBaseConfigurationSchema,
  assertDifferentDatabases,
  assertTargetHasNoOperationalData,
  configurationFingerprint,
  insertConfigurationSql,
} from '../scripts/migrate-base-configuration.mjs';

function table(name, columns = [{ name: 'id', type: 'bigint', generated: '', identity: '' }]) {
  return { schema: 'public', name, primaryKey: [columns[0].name], columns };
}

test('base configuration scope excludes accounts, assignment state, and all job data', () => {
  assert.deepEqual(BASE_CONFIGURATION_TABLES, [
    'prompt_templates', 'prompt_versions', 'knowledge_items', 'knowledge_versions',
    'global_settings', 'workflow_quality_settings',
  ]);
  for (const name of ['tasks', 'task_executions', 'app_users', 'task_auto_assignment_workers', 'executor_nodes']) {
    assert.equal(BASE_CONFIGURATION_TABLES.includes(name), false);
  }
  assert.equal(INITIALIZED_TARGET_TABLES.has('app_users'), true);
  assert.equal(INITIALIZED_TARGET_TABLES.has('tasks'), false);
});

test('source and target cannot resolve to the same PostgreSQL database', () => {
  const identity = { host: '127.0.0.1/32', port: 5432, database: 'xhs_control' };
  assert.throws(() => assertDifferentDatabases(identity, { ...identity }), /same database/u);
  assert.doesNotThrow(() => assertDifferentDatabases(identity, { ...identity, database: 'xhs_control_prod' }));
});

test('configuration tables must exist with identical schemas', () => {
  const source = BASE_CONFIGURATION_TABLES.map((name) => table(name));
  const target = structuredClone(source);
  assert.doesNotThrow(() => assertBaseConfigurationSchema(source, target));
  target.find(({ name }) => name === 'global_settings').columns.push({ name: 'unexpected', type: 'text', generated: '', identity: '' });
  assert.throws(() => assertBaseConfigurationSchema(source, target), /global_settings/u);
});

test('target safety check refuses operational rows and requires disabled auto assignment', async () => {
  const tables = [table('tasks'), table('global_settings')];
  const client = {
    query: async (sql) => {
      if (sql.includes('FROM "public"."tasks"')) return { rows: [{ count: '1' }] };
      if (sql.includes('task_auto_assignment_settings')) return { rows: [{ enabled: false }] };
      if (sql.includes('execution_claim_cursors')) return { rows: [{ count: 2, assigned: 0 }] };
      return { rows: [{ count: '9' }] };
    },
  };
  await assert.rejects(assertTargetHasNoOperationalData(client, tables), /tasks.*=1/u);

  const empty = {
    query: async (sql) => sql.includes('task_auto_assignment_settings')
      ? { rows: [{ enabled: false }] }
      : sql.includes('execution_claim_cursors')
        ? { rows: [{ count: 2, assigned: 0 }] }
        : { rows: [{ count: '0' }] },
  };
  await assert.doesNotReject(assertTargetHasNoOperationalData(empty, tables));

  const enabled = { query: async (sql) => sql.includes('task_auto_assignment_settings')
    ? { rows: [{ enabled: true }] }
    : sql.includes('execution_claim_cursors')
      ? { rows: [{ count: 2, assigned: 0 }] }
      : { rows: [{ count: '0' }] } };
  await assert.rejects(assertTargetHasNoOperationalData(enabled, tables), /must exist and be disabled/u);
});

test('configuration insert is typed and parameterized, and fingerprints include table identity', () => {
  const definition = table('global_settings', [
    { name: 'key', type: 'character varying(100)', generated: '', identity: '' },
    { name: 'value', type: 'jsonb', generated: '', identity: '' },
    { name: 'calculated', type: 'text', generated: 's', identity: '' },
  ]);
  const sql = insertConfigurationSql(definition);
  assert.match(sql, /json_populate_recordset/u);
  assert.match(sql, /\$1::json/u);
  assert.doesNotMatch(sql, /calculated|tasks|DELETE|TRUNCATE/u);

  const first = new Map(BASE_CONFIGURATION_TABLES.map((name) => [name, name === 'global_settings' ? ['{"key":"production"}'] : []]));
  const second = new Map(BASE_CONFIGURATION_TABLES.map((name) => [name, name === 'workflow_quality_settings' ? ['{"key":"production"}'] : []]));
  assert.notEqual(configurationFingerprint(first), configurationFingerprint(second));
});
