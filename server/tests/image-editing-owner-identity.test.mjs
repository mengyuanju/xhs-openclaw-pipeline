import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createImageEditingService, normalizeEdit } from '../src/image-editing.mjs';

const actor = { userId: 99, username: 'admin-reader', role: 'ADMIN', credentialVersion: 1 };
const createdAt = '2026-09-01T00:00:00.000Z';
const request = () => ({ requestId: randomUUID(), sourceImageRunId: randomUUID(),
  sourceAssetId: 8, copyRevisionId: 5, sha256: 'a'.repeat(64), targetPage: 1,
  operation: 'SVG_DISCLOSURE', overlay: { text: 'AI生成' }, draft: true });

function fixture(input = request(), initial = []) {
  const edits = initial.map(row => ({ ...row }));
  const users = [
    { id: 17, username: 'alice', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 22, username: 'bob', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 31, username: 'reused-name', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: actor.userId, username: actor.username, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const events = [];
  const calls = [];
  const task = { id: 429, state: 'MANUAL_ARCHIVE', current_copy_revision_id: input.copyRevisionId,
    current_image_run_id: input.sourceImageRunId };
  const run = { id: input.sourceImageRunId, status: 'COMPLETED', copy_revision_id: input.copyRevisionId,
    result: { images: [{ assetId: input.sourceAssetId }] } };
  const source = { id: input.sourceAssetId, sha256: input.sha256 };
  function withCreator(row, sql) {
    assert.match(sql, /creator\.username\s*=\s*e\.created_by/u);
    assert.match(sql, /creator\.created_at\s*<\s*e\.created_at/u);
    assert.match(sql, /AS created_by_account_id/u);
    const creator = users.find(user => user.username === row.created_by
      && Date.parse(user.createdAt) < Date.parse(row.created_at));
    return { ...row, created_by_account_id: creator ? String(creator.id) : null };
  }
  async function query(sql, values = []) {
    calls.push({ sql, values });
    const text = sql.replace(/\s+/gu, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
    if (text.startsWith('SELECT u.id FROM app_users u JOIN tasks')) return { rows: [{ id: actor.userId }] };
    if (text.startsWith('SELECT id FROM tasks')) return { rows: [{ id: task.id }] };
    if (text.startsWith('SELECT e.*')) {
      let selected = edits;
      if (text.includes('WHERE e.id=$1')) selected = edits.filter(row => row.id === values[0]);
      else if (text.includes('e.request_id=$2')) selected = edits.filter(row => row.request_id === values[1]);
      else if (values.length > 1) selected = edits.filter(row => values[1].includes(row.status));
      return { rows: selected.map(row => withCreator(row, sql)) };
    }
    if (text.startsWith('SELECT value FROM global_settings')) return { rows: [{ value: {} }] };
    if (text.startsWith('SELECT * FROM tasks')) return { rows: [task] };
    if (text.startsWith('SELECT * FROM copy_revisions')) return { rows: [{ id: input.copyRevisionId, approved_at: createdAt }] };
    if (text.startsWith('SELECT * FROM image_runs')) return { rows: [run] };
    if (text.startsWith('SELECT * FROM assets')) return { rows: [source] };
    if (text.startsWith('SELECT * FROM image_edit_events')) {
      return { rows: events.filter(row => row.request_id === values[1]) };
    }
    if (text.startsWith('INSERT INTO image_edit_requests')) {
      const row = { id: values[0], task_id: values[1], request_id: values[2], source_image_run_id: values[3],
        source_asset_id: values[4], copy_revision_id: values[5], source_sha256: values[6], target_page: values[7],
        operation: values[8], config: JSON.parse(JSON.stringify(values[9])), status: values[10],
        created_by: values[11], created_at: createdAt, version: 1 };
      edits.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('UPDATE image_edit_requests SET status=$2')) {
      const row = edits.find(edit => edit.id === values[0]);
      Object.assign(row, { status: values[1], config: values[2], version: row.version + 1 });
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('INSERT INTO image_edit_events')) {
      events.push({ task_id: values[0], edit_id: values[1], action: values[2], actor: values[3],
        reason: values[4], request_id: values[5], detail: values[6] });
      return { rows: [] };
    }
    assert.fail(`Unexpected query: ${text}`);
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { service: createImageEditingService({ pool, storageRoot: process.cwd() }), edits, users, calls };
}

function savedEdit(input, username = 'alice') {
  return { id: randomUUID(), task_id: 429, request_id: input.requestId,
    created_by: username, created_at: createdAt, status: 'DRAFT', version: 1,
    operation: input.operation, config: JSON.parse(JSON.stringify(normalizeEdit(input))) };
}

test('task edit history retains all creators and exposes numeric account identities with reused names excluded', async () => {
  const input = request();
  const rows = ['alice', 'bob', 'reused-name', 'deleted-name'].map(username => savedEdit(input, username));
  rows[0].status = 'ACCEPTED';
  rows[1].status = 'QUEUED';
  rows[2].status = 'FAILED';
  rows[3].status = 'REJECTED';
  const { service } = fixture(input, rows);
  const history = await service.list(429);
  assert.deepEqual(history.map(row => row.created_by), ['alice', 'bob', 'reused-name', 'deleted-name']);
  assert.deepEqual(history.map(row => row.created_by_account_id), [17, 22, null, null]);
  assert.equal((await service.get(rows[0].id)).created_by_account_id, 17);
  assert.equal((await service.get(rows[2].id)).created_by_account_id, null);
  assert.deepEqual((await service.list(429, { pendingOnly: true })).map(row => row.created_by_account_id), [22]);
});

test('new edit creation returns the verified actor identity and preserves it on reads', async () => {
  const input = request();
  const { service } = fixture(input);
  const created = await service.create(429, input, actor);
  assert.equal(created.created_by, actor.username);
  assert.equal(created.created_by_account_id, actor.userId);
  assert.equal((await service.get(created.id)).created_by_account_id, actor.userId);
});

test('idempotent create returns the original creator identity rather than the replaying administrator', async () => {
  for (const [username, expected] of [['alice', 17], ['reused-name', null]]) {
    const input = request();
    const row = savedEdit(input, username);
    const { service, calls } = fixture(input, [row]);
    const replayed = await service.create(429, input, actor);
    assert.equal(replayed.id, row.id);
    assert.equal(replayed.created_by_account_id, expected);
    assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO image_edit_requests')), false);
  }
});

test('normal and idempotent administrator actions retain the request creator identity', async () => {
  for (const [username, expected] of [['alice', 17], ['reused-name', null]]) {
    const input = request();
    const row = savedEdit(input, username);
    const { service } = fixture(input, [row]);
    const action = { requestId: randomUUID(), version: 1, reason: 'queue preview' };
    const queued = await service.action(row.id, 'queue', action, actor);
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.created_by, username);
    assert.equal(queued.created_by_account_id, expected);
    const replayed = await service.action(row.id, 'queue', action, actor);
    assert.equal(replayed.version, queued.version);
    assert.equal(replayed.created_by_account_id, expected);
  }
});
