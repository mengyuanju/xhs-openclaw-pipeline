import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  decodeCopyReviewDraftContent, encodeCopyReviewDraftContent, hydrateCopyReviewDrafts,
} from '../src/copy-review-draft-archive.mjs';

test('copy review draft archives preserve complete Unicode content and detect corruption', async () => {
  const content = { version: 1, draft: { copy: { title: '归档后可以读取', body: '内容'.repeat(1500), tags: ['#测试'] } } };
  const archive = await encodeCopyReviewDraftContent(content);
  assert.ok(archive.payload.length < archive.original_byte_length);
  assert.deepEqual(await decodeCopyReviewDraftContent(archive), content);
  await assert.rejects(decodeCopyReviewDraftContent({ ...archive, sha256: '0'.repeat(64) }), /integrity/u);
  await assert.rejects(decodeCopyReviewDraftContent({ ...archive, original_byte_length: archive.original_byte_length - 1 }), /integrity/u);
  await assert.rejects(decodeCopyReviewDraftContent({ ...archive, codec: 'unknown' }), /metadata/u);
  await assert.rejects(decodeCopyReviewDraftContent({ ...archive, payload: Buffer.from('corrupt') }));
});

test('copy review draft archives bound both input and decompression output', async () => {
  await assert.rejects(encodeCopyReviewDraftContent({ body: 'a'.repeat(1024 * 1024) }), /size limit/u);
  await assert.rejects(encodeCopyReviewDraftContent([]), /invalid/u);
  await assert.rejects(decodeCopyReviewDraftContent({
    codec: 'gzip', payload: gzipSync(Buffer.alloc(1024 * 1024 + 1)),
    original_byte_length: 100, sha256: '0'.repeat(64),
  }), /larger|length|size|buffer/u);
});

test('draft hydration keeps hot rows untouched, batches cold reads and fails closed on missing content', async () => {
  const content = { version: 1, draft: { copy: { title: 'Recovered draft' } } };
  const archive = { draft_id: '19', ...await encodeCopyReviewDraftContent(content) };
  const hot = { id: '18', content: { hot: true } };
  const cold = { id: '19', content: {}, content_archived_at: new Date() };
  const calls = [];
  const queryable = { async query(sql, values) { calls.push(values); return { rows: [archive] }; } };
  assert.equal(await hydrateCopyReviewDrafts(queryable, [hot]).then(rows => rows[0]), hot);
  assert.equal(calls.length, 0);
  const rows = await hydrateCopyReviewDrafts(queryable, [hot, cold]);
  assert.equal(rows[0], hot);
  assert.notEqual(rows[1], cold);
  assert.deepEqual(rows[1].content, content);
  assert.deepEqual(cold.content, {});
  assert.deepEqual(calls, [[['19']]]);
  await assert.rejects(hydrateCopyReviewDrafts({ async query() { return { rows: [] }; } }, [cold]), /missing/u);
});
