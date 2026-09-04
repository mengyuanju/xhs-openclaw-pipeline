import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminStore } from '../src/admin/admin-store.mjs';

test('knowledge analysis awaits centrally stored model configuration', async () => {
  const { readKnowledgeModelApi } = await import('../src/admin/knowledge-runtime.mjs');
  const modelApi = { textModel: 'fake-text', visionModel: 'fake-vision' };
  assert.deepEqual(await readKnowledgeModelApi({
    async getProductionSettings() { return { settings: { modelApi } }; },
  }), modelApi);
});

test('saved analysis prompts deduplicate, enforce ten slots and replace only the chosen record', () => {
  const store = createAdminStore(':memory:');
  try {
    const first = store.createCopyAnalysisPrompt({ content: ' 分析结构 ' });
    assert.equal(store.createCopyAnalysisPrompt({ content: '分析结构' }).id, first.id);
    for (let i = 1; i < 10; i++) store.createCopyAnalysisPrompt({ content: `提示词 ${i}` });
    assert.throws(() => store.createCopyAnalysisPrompt({ content: '第十一条' }), /at most 10/);
    store.replaceCopyAnalysisPrompt(first.id, { content: '分析节奏' });
    const items = store.listCopyAnalysisPrompts();
    assert.equal(items.length, 10);
    assert.equal(items.find((p) => p.id === first.id).content, '分析节奏');
  } finally { store.close(); }
});

test('remote knowledge adapter maps complete copy records and uses an atomic reviewed save', async () => {
  const { createRemoteKnowledgeStore } = await import('../src/admin/remote-knowledge-store.mjs');
  const calls = [];
  const item = { title: '标题', sourceCopy: '原文', analysisPrompt: '分析要求', summary: '摘要', analysis: '完整分析', labels: ['科普'], analysisModel: 'fake', createdAt: '2025-01-01T00:00:00.000Z' };
  const remote = { id: 5, kind: 'COPY', name: item.title, versions: [{ id: 10, status: 'PUBLISHED', content: item }] };
  const store = createRemoteKnowledgeStore({
    listKnowledge: async () => [remote],
    createKnowledgeVersion: async (input) => { calls.push(input); return { itemId: 5, versionId: 11, status: 'PUBLISHED' }; },
  });
  assert.equal((await store.listCopyKnowledge()).data[0].sourceCopy, '原文');
  await store.updateCopyKnowledge(5, { ...item, title: '修改' });
  assert.equal(calls[0].itemId, 5);
  assert.equal(calls[0].publish, true);
  assert.equal(calls[0].expectedVersionId, 10);
  assert.equal(calls[0].content.createdAt, item.createdAt);
  assert.equal(calls[0].content.analysisModel, 'fake');
});
