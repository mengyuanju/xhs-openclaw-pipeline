import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { generateLabCopy, validateGenerateRequest } from '../search-lab/generate.mjs';
import { CopyGenerationUnchangedError, generateCopy } from '../src/copy-generation.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { createPromptRuntime, defaultBusinessPrompt } from '../src/prompt-runtime.mjs';
import { PROMPT_KINDS } from '../src/prompt-catalog.mjs';

const QUERY = '湖北黄石市无籽黑皮西瓜怎么样';
const SOURCE_URL = 'https://www.example.com/watermelon';
const TEXT_RULES = '发布的文案提示词原文：依据公开来源解释产品特点，不编造亲身体验。';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function runtime(queryReviewEnabled = true) {
  return createPromptRuntime({ source: 'LOCAL', capturedAt: '2026-09-29T00:00:00.000Z',
    settings: { queryReviewEnabled },
    prompts: { ...Object.fromEntries(PROMPT_KINDS.map((kind) => [kind,
      { content: defaultBusinessPrompt(kind) }])),
      TEXT_SYSTEM: { content: TEXT_RULES, versionId: 19, version: 3 } } });
}

function research(query = QUERY) {
  return { schemaVersion: 1, status: 'COMPLETED', query,
    searchedAt: '2026-09-29T00:00:00.000Z', provider: 'tencent-wsa', summary: '可核验的公开资料摘要。',
    attempts: [{ provider: 'tencent-wsa', status: 'COMPLETED', error: null }],
    sources: [{ title: '公开西瓜资料', url: SOURCE_URL, snippet: '资料中的可核验信息。',
      siteName: 'example.com', provider: 'tencent-wsa', retrievedAt: '2026-09-29T00:00:00.000Z' }] };
}

function post(title = '无籽黑皮西瓜的选购要点') {
  return { ...createMockPost(3), title, body: `${'公开资料中的产品信息。'.repeat(44)}。`,
    sources: [SOURCE_URL] };
}

function review(decision = 'PASS') {
  return { rawText: JSON.stringify({ schemaVersion: 1, decision, summary: decision === 'PASS'
    ? '审核通过' : '正文仍有必须修订的问题', issues: decision === 'PASS' ? [] : [{
      code: 'QUERY_ANSWER_INCOMPLETE', severity: 'BLOCKING', message: '请补充来源中已有的特点。',
    }] }), model: 'fake-review-model' };
}

function passingClient({ text = post(), onText = () => {}, onReview = () => {} } = {}) {
  return {
    async runText(input) { onText(input); return { rawText: JSON.stringify(text), model: 'fake-text-model' }; },
    async runReview(input) { onReview(input); return review(); },
    async runWebSearch() { assert.fail('已有搜索资料不得重复调用联网 API'); },
  };
}

describe('search lab writing pipeline', () => {
  it('reuses completed research and keeps the original task for the Query reviewer', async () => {
    let reviewedQuery;
    let writtenPrompt;
    const result = await generateLabCopy({ query: QUERY, research: research(),
      requirements: '优先解释选购判断标准', requestedImageCount: 3 }, {
      client: passingClient({
        onText({ prompt }) { writtenPrompt = prompt; },
        onReview({ prompt }) {
          if (prompt.includes('kind="QUERY_REVIEW_SYSTEM"')) reviewedQuery = prompt;
        },
      }), promptRuntime: runtime(), systemPrompt: TEXT_RULES,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.ok(reviewedQuery);
    assert.doesNotMatch(reviewedQuery, /可核验的公开资料摘要/u);
    assert.match(writtenPrompt, /可核验的公开资料摘要/u);
    assert.match(writtenPrompt, /优先解释选购判断标准/u);
    assert.deepEqual(result.researchSnapshot, research());
    assert.equal(result.copy.title, post().title);
    assert.equal(result.imagePlan.length, 3);
    assert.equal(result.stageReviews.query.decision, 'PASS');
    assert.equal(result.review.decision, 'PASS');
    assert.ok(result.stages.some(({ id }) => id === 'RESEARCH'));
    assert.equal(result.generation.revisionAttempted, false);
    assert.equal(result.prompts.length, result.promptTrace.length);
  });

  it('records the exact published prompt version in the actual drafting request', async () => {
    const result = await generateLabCopy({ query: QUERY, researchSnapshot: research() }, {
      client: passingClient(), promptRuntime: runtime(), systemPrompt: TEXT_RULES,
    });
    assert.equal(result.status, 'COMPLETED');
    const trace = result.promptTrace.find(({ method }) => method === 'runText');
    assert.ok(trace.prompt.includes(TEXT_RULES));
    const version = trace.provenance.versions.find(({ kind }) => kind === 'TEXT_SYSTEM');
    assert.equal(version.versionId, 19);
    assert.equal(version.version, 3);
    assert.equal(version.templateSha256, hash(TEXT_RULES));
    assert.equal(trace.promptSha256, hash(trace.prompt));
    assert.equal(trace.rawOutput, JSON.stringify(post()));
    assert.equal(result.promptProvenance.source, 'LOCAL');
    assert.ok(result.promptProvenance.versions.some(({ kind, versionId }) =>
      kind === 'TEXT_SYSTEM' && versionId === 19));
  });

  it('uses the production body-only repair and keeps valid fields unchanged', async () => {
    const original = { ...post(), body: '较短正文。'.repeat(45) };
    let calls = 0;
    const result = await generateLabCopy({ query: QUERY, research: research(),
      textReviewEnabled: false, requestedImageCount: 3 }, {
      promptRuntime: runtime(false),
      client: {
        async runText({ outputSchema }) {
          calls += 1;
          if (calls === 1) return { rawText: JSON.stringify(original), model: 'fake-model' };
          assert.deepEqual(outputSchema.required, ['body']);
          return { rawText: JSON.stringify({ body: post().body }), model: 'fake-model' };
        },
        async runWebSearch() { assert.fail('不得重复联网'); },
      },
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(calls, 2);
    assert.equal(result.post.title, original.title);
    assert.deepEqual(result.post.imagePlan, original.imagePlan);
    assert.equal(result.post.body, post().body);
    assert.ok(result.stages.some(({ id, status }) => id === 'COPY_LENGTH_REPAIR' && status === 'COMPLETED'));
    assert.equal(result.review.skipped, true);
  });

  it('reuses quality revision prompts and exposes both draft and reviewed versions', async () => {
    let textCalls = 0;
    let reviewCalls = 0;
    const original = post();
    const revised = post('黄石无籽西瓜选购指南');
    const result = await generateLabCopy({ query: QUERY, research: { snapshot: research() } }, {
      promptRuntime: runtime(),
      client: {
        async runText({ prompt }) {
          textCalls += 1;
          if (textCalls === 2) assert.match(prompt, /kind="COPY_REVISION_SYSTEM"/u);
          return { rawText: JSON.stringify(textCalls === 1 ? original : revised), model: 'fake-model' };
        },
        async runReview() { reviewCalls += 1; return review(reviewCalls === 2 ? 'REJECT' : 'PASS'); },
        async runWebSearch() { assert.fail('不得重复联网'); },
      },
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(textCalls, 2);
    assert.equal(reviewCalls, 3);
    assert.equal(result.original.copy.title, original.title);
    assert.equal(result.reviewed.copy.title, revised.title);
    assert.equal(result.copy.title, revised.title);
    assert.equal(result.original.review.decision, 'REJECT');
    assert.equal(result.review.decision, 'PASS');
    assert.equal(result.generation.revisionAttempted, true);
    assert.ok(result.stages.some(({ id }) => id === 'REVIEWED_REVIEW'));
  });

  it('retains rejected drafts and diagnostics when both revision attempts are unchanged', async () => {
    const secret = 'fake-sensitive-revision-key';
    const original = { ...post(), body: `${post().body}诊断数据 ${secret}。` };
    let textCalls = 0;
    let reviewCalls = 0;
    const result = await generateLabCopy({ query: QUERY, research: research(),
      input: { referenceText: `输入诊断数据 ${secret}` } }, {
      promptRuntime: runtime(false), secrets: [secret], client: {
        async runText() {
          textCalls += 1;
          return { rawText: JSON.stringify(original), model: 'fake-model' };
        },
        async runReview() {
          reviewCalls += 1;
          const rejected = JSON.parse(review('REJECT').rawText);
          rejected.summary += ` ${secret}`;
          return { rawText: JSON.stringify(rejected), model: 'fake-review-model' };
        },
        async runWebSearch() { assert.fail('不得重复联网'); },
      },
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.qualityStatus, 'REJECT');
    assert.equal(textCalls, 3);
    assert.equal(reviewCalls, 1);
    assert.equal(result.copy.title, original.title);
    assert.equal(result.original.copy.title, original.title);
    assert.equal(result.reviewed.copy.title, original.title);
    assert.equal(result.post.title, original.title);
    assert.deepEqual(result.imagePlan, original.imagePlan);
    assert.equal(result.original.review.decision, 'REJECT');
    assert.equal(result.reviewed.review, null);
    assert.equal(result.review.decision, 'REJECT');
    assert.equal(result.stageReviews.originalText.decision, 'REJECT');
    assert.equal(result.stageReviews.reviewedText, null);
    assert.equal(result.stageReviews.text.decision, 'REJECT');
    assert.equal(result.revisionUnchanged, true);
    assert.equal(result.generation.revisionUnchanged, true);
    assert.equal(result.generation.revisionAttempted, true);
    assert.equal(result.revisionAttempts.length, 2);
    assert.equal(result.revisionAttempts[1].post.title, original.title);
    assert.equal(result.generation.revisionAttempts.length, 2);
    assert.equal(result.error.name, 'CopyGenerationUnchangedError');
    assert.equal(result.error.stage, 'REVIEWED_GENERATION');
    assert.equal(result.error.message, '修订未产生实际修改，已保留原稿和审核意见');
    assert.equal(result.promptTrace.length, 4);
    assert.equal(result.promptTrace.filter(({ stage }) => stage === 'REVIEWED_GENERATION').length, 2);
    assert.ok(result.promptTrace.every(({ status }) => status === 'COMPLETED'));
    assert.equal(result.stages.find(({ id }) => id === 'REVIEWED_GENERATION').status, 'FAILED');
    assert.equal(result.stages.find(({ id }) => id === 'REVIEWED_REVIEW').status, 'SKIPPED');
    assert.deepEqual(result.researchSnapshot, research());
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
    assert.match(result.post.body, /REDACTED_API_KEY/u);
  });

  it('reviews actual range punctuation changes instead of reporting an unchanged revision', async () => {
    const original = { ...post(), body: post().body.replace('公开资料', '按2～3元区间整理公开资料') };
    const revised = { ...original, body: original.body.replaceAll('～', '~') };
    let textCalls = 0;
    let reviewCalls = 0;
    const result = await generateLabCopy({ query: QUERY, research: research() }, {
      promptRuntime: runtime(false), client: {
        async runText() {
          textCalls += 1;
          return { rawText: JSON.stringify(textCalls === 1 ? original : revised), model: 'fake-model' };
        },
        async runReview() { reviewCalls += 1; return review(reviewCalls === 1 ? 'REJECT' : 'PASS'); },
        async runWebSearch() { assert.fail('不得重复联网'); },
      },
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.qualityStatus, 'PASS');
    assert.equal(textCalls, 2);
    assert.equal(reviewCalls, 2);
    assert.equal(result.copy.body, revised.body);
    assert.equal(result.original.review.decision, 'REJECT');
    assert.equal(result.reviewed.review.decision, 'PASS');
    assert.equal(result.generation.revisionAttempted, true);
    assert.ok(result.promptTrace.some(({ stage, method }) => stage === 'REVIEWED_REVIEW' && method === 'runReview'));
  });

  it('keeps invalid partial results on the normal failure path', async () => {
    const error = new CopyGenerationUnchangedError();
    error.partialResult = { post: post(), originalPost: post(), reviewedPost: post(),
      revisionAttempted: true, stageReviews: { originalText: { decision: 'PASS' },
        reviewedText: null, text: { decision: 'PASS' } } };
    const result = await generateLabCopy({ query: QUERY, research: research() }, {
      promptRuntime: runtime(false), client: { async runText() { throw error; } },
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.post, null);
    assert.equal(result.copy, null);
    assert.deepEqual(result.imagePlan, []);
    assert.equal(result.revisionUnchanged, undefined);
  });

  it('keeps a rejected final review visible alongside the generated text', async () => {
    const result = await generateLabCopy({ query: QUERY, research: research(), autoReviseOnReject: false }, {
      promptRuntime: runtime(false), client: {
        ...passingClient(), async runReview() { return review('REJECT'); },
      },
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.review.decision, 'REJECT');
    assert.equal(result.copy.title, post().title);
    assert.equal(result.generation.revisionAttempted, false);
  });

  it('returns a rejected Query and its prompt without invoking drafting or search', async () => {
    const result = await generateLabCopy({ query: QUERY, research: research() }, {
      promptRuntime: runtime(), client: {
        async runText() { assert.fail('选题拒绝后不得生成'); },
        async runReview() { return review('REJECT'); },
        async runWebSearch() { assert.fail('选题拒绝后不得联网'); },
      },
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.post, null);
    assert.equal(result.review.decision, 'REJECT');
    assert.equal(result.stageReviews.query.decision, 'REJECT');
    assert.equal(result.promptTrace.length, 1);
    assert.equal(result.stages.at(-1).status, 'FAILED');
  });

  it('retains failure diagnostics and redacts credentials in prompts and errors', async () => {
    const secret = 'fake-sensitive-api-key';
    const result = await generateLabCopy({ query: QUERY, research: research(),
      input: { referenceText: `输入中的密钥 ${secret}` } }, {
      promptRuntime: runtime(false), secrets: [secret], client: {
        async runText() { throw new Error(`服务错误信息包含 ${secret}`); },
      },
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.promptTrace.length, 1);
    assert.equal(result.promptTrace[0].status, 'FAILED');
    assert.match(result.error.message, /REDACTED_API_KEY/u);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
    assert.equal(result.stages.at(-1).status, 'FAILED');
  });

  it('preserves all invalid model responses when production contract retries are exhausted', async () => {
    let calls = 0;
    const result = await generateLabCopy({ query: QUERY, research: research() }, {
      promptRuntime: runtime(false), client: {
        async runText() { calls += 1; return { rawText: '无效的模型输出', model: 'fake-model' }; },
      },
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(calls, 3);
    assert.equal(result.error.name, 'CopyGenerationContractError');
    assert.equal(result.promptTrace.length, 3);
    assert.ok(result.promptTrace.every(({ rawOutput }) => rawOutput === '无效的模型输出'));
  });

  it('validates the Query, image count, review options, sources, and matching research', () => {
    for (const body of [
      { query: '' }, { query: '字'.repeat(501) }, { query: QUERY, requestedImageCount: 2 },
      { query: QUERY, textReviewEnabled: 'true' },
      { query: QUERY, research: research('另一个 Query') },
      { query: QUERY, research: { ...research(), status: 'FAILED', provider: null, sources: [] } },
      { query: QUERY, input: { referenceUrls: ['javascript:alert(1)'] } },
      { query: QUERY, input: { referenceText: '字'.repeat(12_001) } },
      { query: QUERY, requirements: [] },
    ]) assert.throws(() => validateGenerateRequest(body));
    assert.equal(validateGenerateRequest({ query: QUERY }).imageCount, 'auto');
    for (const requirements of ['', '   ']) {
      assert.deepEqual(validateGenerateRequest({ query: QUERY, requirements }).input, { referenceUrls: [] });
    }
    const normalized = validateGenerateRequest({ query: QUERY,
      requirements: { category: '农产品', targetAudience: '消费者' },
      input: { referenceUrls: [SOURCE_URL], untrustedExtraField: '不应直接转入提示词' } });
    assert.equal(normalized.input.category, '农产品');
    assert.equal(normalized.input.targetAudience, '消费者');
    assert.equal(normalized.input.untrustedExtraField, undefined);
  });

  it('production optional research validates before invoking any model', async () => {
    const client = { async runText() { assert.fail('无效快照不得调用模型'); } };
    for (const researchSnapshot of [research('另一 Query'),
      { ...research(), status: 'FAILED', provider: null, sources: [] }]) {
      await assert.rejects(generateCopy({ task: { query: QUERY, input: {} }, client,
        researchSnapshot, promptRuntime: runtime(false) }), /completed for the same query/u);
    }
  });
});
