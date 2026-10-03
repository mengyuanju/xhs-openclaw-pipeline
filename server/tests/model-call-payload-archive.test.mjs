import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { encodeModelCallPayload, decodeModelCallPayload,
  drainTerminalModelCallPayloadArchive } from '../src/model-call-payload-archive.mjs';
import { getModelCall, listModelCalls, normalizeModelCall } from '../src/model-call-traces.mjs';

test('archived call payload restores exact Unicode strings, nulls and credential sanitization output', async () => {
  const original = { prompt: '中文与 emoji 🧪'.repeat(3000), request: '{"quoted":"\\n"}', response: '', error: null };
  const encoded = await encodeModelCallPayload(original);
  assert.ok(encoded.payload.length < encoded.rawBytes / 20);
  const archive = { format_version: 1, payload: encoded.payload, raw_bytes: encoded.rawBytes, sha256: encoded.sha256 };
  assert.deepEqual(await decodeModelCallPayload(archive), original);
  await assert.rejects(decodeModelCallPayload({ ...archive, sha256: '0'.repeat(64) }), /integrity/);
  await assert.rejects(decodeModelCallPayload({ ...archive, raw_bytes: encoded.rawBytes + 1 }), /integrity/);
  await assert.rejects(decodeModelCallPayload({ ...archive, format_version: 2 }), /invalid/);
  await assert.rejects(decodeModelCallPayload({ ...archive, payload: Buffer.from('invalid gzip') }));
  await assert.rejects(decodeModelCallPayload({ ...archive, payload: gzipSync(Buffer.alloc(8388609)) }));
});

test('maximum legal escaped model texts fit the archive without losing control characters', async () => {
  const input = { sequence: 1, stage: 'TEXT_GENERATION', provider: 'synthetic', operation: 'TEXT', status: 'FAILED',
    prompt: '\u0001'.repeat(200000), request: '\u0002'.repeat(200000), response: '\u0003'.repeat(200000),
    error: '\u0004'.repeat(200000), startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:00:01.000Z', durationMs: 1000 };
  const normalized = normalizeModelCall(input);
  assert.equal(normalized.truncated, false);
  const encoded = await encodeModelCallPayload(normalized);
  assert.ok(encoded.rawBytes > 4194304 && encoded.rawBytes < 8388608);
  const restored = await decodeModelCallPayload({ format_version: 1, payload: encoded.payload,
    raw_bytes: encoded.rawBytes, sha256: encoded.sha256 });
  for (const field of ['prompt', 'request', 'response', 'error']) assert.equal(restored[field], input[field]);
});

test('trace detail transparently restores archived body without exposing storage fields; list remains metadata only', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const original = { prompt: 'same prompt', request: '{}', response: 'same response', error: 'same error' };
  const encoded = await encodeModelCallPayload(original);
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes('jsonb_agg') ? [{ items: [{ id }], total: 1, cleanup: null }] : [{
      id, taskId: 5, status: 'FAILED', truncated: true,
      prompt: '', request: '', response: null, error: null, payload_archived: true,
      format_version: 1, payload: encoded.payload, raw_bytes: encoded.rawBytes, sha256: encoded.sha256,
    }] };
  } };
  assert.deepEqual(await getModelCall(pool, 5, id), { id, taskId: 5, status: 'FAILED', truncated: true, ...original });
  await listModelCalls(pool, 5);
  assert.doesNotMatch(queries[1].sql, /payload_archived|model_call_payload_archives|c\.prompt|c\.response/);
  const corrupt = { query: async () => ({ rows: [{ id, payload_archived: true }] }) };
  await assert.rejects(getModelCall(corrupt, 5, id), /invalid/);
});

test('archive retention never accepts deletion of recent debug bodies', async () => {
  for (const retentionDays of [0, 1, 6, 7.5, 3651, '7']) {
    await assert.rejects(drainTerminalModelCallPayloadArchive(null, { retentionDays }), /retentionDays/);
  }
});
