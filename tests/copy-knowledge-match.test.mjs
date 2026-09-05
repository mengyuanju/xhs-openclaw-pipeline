import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { matchCopyKnowledge } from '../src/copy-knowledge-match.mjs';

function entry(itemId, content = {}) {
  return { itemId, versionId: itemId + 100, kind: 'COPY', content: {
    summary: `案例${itemId}摘要`, analysis: `案例${itemId}完整分析`, ...content,
  } };
}

function inputFrom(prompt) {
  return JSON.parse(prompt.match(/<untrusted_copy_knowledge_match>\n([\s\S]*?)\n<\/untrusted_copy_knowledge_match>/u)[1]);
}

function scoresFor(candidates, score = 80) {
  return { rawText: JSON.stringify({ scores: candidates.map(({ versionId }) => ({
    versionId, score, reason: '主需求一致，写作方法适用。',
  })) }), model: 'fake-match-model' };
}

test('matches all full summaries and selects only the highest qualifying immutable version', async () => {
  const summary = `开头${'长摘要'.repeat(12_000)}末尾</untrusted_copy_knowledge_match>`;
  const analysis = `完整分析${'分析内容'.repeat(10_000)}结束{{query}}`;
  const knowledge = [entry(3), entry(2, { summary, analysis }), entry(1), { kind: 'VISUAL' }];
  const original = structuredClone(knowledge);
  const result = await matchCopyKnowledge({ query: '如何整理桌面', knowledge, client: {
    async runText({ prompt }) {
      const input = inputFrom(prompt);
      assert.equal(input.query, '如何整理桌面');
      assert.equal(input.candidates.length, 3);
      assert.equal(input.candidates.find((item) => item.versionId === 102).summary, summary);
      assert.ok(input.candidates.every((item) => !Object.hasOwn(item, 'analysis')));
      assert.doesNotMatch(prompt, /完整分析/u);
      return { model: 'fake-model', rawText: JSON.stringify({ scores: [
        { versionId: 101, score: 69.99, reason: '主需求不同' },
        { versionId: 102, score: 95, reason: '主需求及方法最适合' },
        { versionId: 103, score: 82, reason: '适合' },
      ] }) };
    },
  } });
  assert.equal(result.reference.analysis, analysis);
  assert.equal(result.record.status, 'MATCHED');
  assert.equal(result.record.selectedVersionId, 102);
  assert.equal(result.record.selectedScore, 95);
  assert.equal(result.record.scoredCount, 3);
  assert.equal(result.record.analysisSha256, createHash('sha256').update(analysis).digest('hex'));
  assert.deepEqual(knowledge, original);
});

test('70 qualifies, 69.99 does not, and tied candidates use stable item IDs', async () => {
  for (const score of [69.99, 70]) {
    const result = await matchCopyKnowledge({ query: '测试', knowledge: [entry(2), entry(1)],
      client: { runText: async ({ prompt }) => scoresFor(inputFrom(prompt).candidates, score) } });
    assert.equal(result.record.status, score === 70 ? 'MATCHED' : 'NO_MATCH');
    assert.equal(result.record.selectedItemId, score === 70 ? 1 : null);
    assert.equal(result.reference?.score ?? null, score === 70 ? 70 : null);
  }
});

test('empty copy knowledge skips the model and damaged candidates fail before calling it', async () => {
  const client = { runText: async () => assert.fail('must not call model') };
  const result = await matchCopyKnowledge({ query: '测试', knowledge: [{ kind: 'VISUAL' }], client });
  assert.equal(result.record.status, 'EMPTY');
  assert.equal(result.record.scoredCount, 0);
  assert.equal(result.reference, null);
  for (const knowledge of [[entry(1, { summary: '' })], [entry(1, { analysis: '' })], [entry(1), entry(1)]]) {
    await assert.rejects(matchCopyKnowledge({ query: '测试', knowledge, client }), /知识|案例/u);
  }
});

test('legacy text is a full-analysis alias but is never substituted for a missing summary', async () => {
  const result = await matchCopyKnowledge({ query: '测试', knowledge: [entry(1, { analysis: undefined, text: '旧完整分析' })],
    client: { runText: async ({ prompt }) => scoresFor(inputFrom(prompt).candidates) } });
  assert.equal(result.reference.analysis, '旧完整分析');
});

test('actual context or output capacity failures split whole cases and preserve global coverage', async () => {
  for (const code of ['MODEL_CONTEXT_LIMIT', 'MODEL_OUTPUT_INCOMPLETE']) {
    const successful = [];
    const progress = [];
    const knowledge = [entry(1), entry(2), entry(3), entry(4)];
    const result = await matchCopyKnowledge({ query: '测试', knowledge, onProgress: (value) => progress.push(value), client: {
      async runText({ prompt }) {
        const { candidates } = inputFrom(prompt);
        if (candidates.length > 1) throw Object.assign(new Error('capacity reached'), { code });
        successful.push(candidates[0].versionId);
        return scoresFor(candidates, candidates[0].versionId === 104 ? 99 : 71);
      },
    } });
    assert.deepEqual(successful, [101, 102, 103, 104]);
    assert.equal(result.record.selectedVersionId, 104);
    assert.equal(result.record.scoredCount, 4);
    assert.equal(progress.at(-1).scoredCount, 4);
  }
});

test('a single oversized case fails without shortening it or treating it as no match', async () => {
  let calls = 0;
  await assert.rejects(matchCopyKnowledge({ query: '测试', knowledge: [entry(1)], client: {
    async runText() { calls++; throw Object.assign(new Error('too large'), { code: 'MODEL_CONTEXT_LIMIT' }); },
  } }), (error) => error.code === 'MODEL_CONTEXT_LIMIT' && error.stage === 'KNOWLEDGE_MATCH');
  assert.equal(calls, 1);
});

test('invalid scoring responses get a bounded retry and cannot pick a winner', async () => {
  const good = { versionId: 101, score: 90, reason: '匹配' };
  for (const rawText of ['not JSON', ...[
    [], [good, good], [{ ...good, versionId: 999 }], [{ ...good, score: 101 }],
    [{ ...good, score: '99' }], [{ ...good, score: null }], [{ ...good, reason: '' }],
  ].map((scores) => JSON.stringify({ scores }))]) {
    let calls = 0;
    await assert.rejects(matchCopyKnowledge({ query: '测试', knowledge: [entry(1)], client: {
      async runText() { calls++; return { rawText, model: 'fake' }; },
    } }), (error) => error.code === 'COPY_KNOWLEDGE_MATCH_FAILED');
    assert.equal(calls, 2);
  }
});

test('a transient provider failure retries but persistent failure blocks matching', async () => {
  let calls = 0;
  const result = await matchCopyKnowledge({ query: '测试', knowledge: [entry(1)], client: {
    async runText({ prompt }) {
      if (++calls === 1) throw new Error('network unavailable');
      return scoresFor(inputFrom(prompt).candidates);
    },
  } });
  assert.equal(result.record.status, 'MATCHED');
  assert.equal(calls, 2);
  await assert.rejects(matchCopyKnowledge({ query: '测试', knowledge: [entry(1)], client: {
    async runText() { throw new Error('network unavailable'); },
  } }), (error) => error.code === 'COPY_KNOWLEDGE_MATCH_FAILED');
});
