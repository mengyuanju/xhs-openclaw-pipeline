import assert from 'node:assert/strict';
import test from 'node:test';
import { copyReworkChanges, findCopyReworkBaseline } from '../src/copy-rework.mjs';

const baseline = {
  copy: { title: '原标题', body: '第一行\n第二行', tags: ['#标签'] },
  imagePlan: [{ kind: 'hero', headline: '封面', subtitle: '', bullets: ['一', '二'], prompt: '画面说明' }],
};

test('each editable copy or plan field independently satisfies rework', () => {
  for (const field of ['title', 'body', 'tags']) {
    const content = structuredClone(baseline);
    content.copy[field] = field === 'tags' ? ['#新标签'] : '修改后的内容';
    assert.deepEqual(copyReworkChanges(baseline, content), {
      copyChanged: true, imagePlanChanged: false, satisfied: true,
    }, field);
  }
  for (const field of ['kind', 'headline', 'subtitle', 'bullets', 'prompt', 'layout']) {
    const content = structuredClone(baseline);
    content.imagePlan[0][field] = field === 'layout' ? { mode: 'CUSTOM' }
      : field === 'bullets' ? ['新要点', '二'] : '修改内容';
    assert.deepEqual(copyReworkChanges(baseline, content), {
      copyChanged: false, imagePlanChanged: true, satisfied: true,
    }, field);
  }
});

test('metadata, image settings, disclosure and normalized whitespace/defaults do not count', () => {
  const content = structuredClone(baseline);
  content.copy.title = ' 原标题 ';
  content.copy.body = '第一行\r\n第二行\n';
  content.imagePlan[0].subtitle = undefined;
  content.imagePlan[0].layout = { mode: 'AUTO' };
  content.imageSettings = { format: 'JPEG' };
  content.aiDisclosureEnabled = true;
  content.manualReview = { submittedAt: new Date().toISOString() };
  assert.equal(copyReworkChanges(baseline, content).satisfied, false);
  const custom = structuredClone(baseline);
  custom.imagePlan[0].layout = { mode: 'CUSTOM' };
  const explicit = structuredClone(custom);
  explicit.imagePlan[0].layout = { mode: 'CUSTOM', titlePosition: 'top-center', direction: ' ' };
  assert.equal(copyReworkChanges(custom, explicit).satisfied, false);
});

test('saved plan changes survive reopen; reverting and a new return reset eligibility', () => {
  const edited = structuredClone(baseline);
  edited.imagePlan[0].headline = '新封面';
  const revisions = [
    { id: 1, revisionOrigin: 'QA_RETURN', content: baseline },
    { id: 2, parentRevisionId: 1, revisionOrigin: 'PLAN_EDIT', content: edited },
    { id: 3, parentRevisionId: 2, revisionOrigin: 'PLAN_EDIT', content: baseline },
    { id: 4, parentRevisionId: 2, revisionOrigin: 'FINAL_REWORK', content: edited },
    { id: 5, parentRevisionId: 4, revisionOrigin: 'PLAN_EDIT', content: edited },
  ];
  for (const [id, expected] of [[2, true], [3, false], [4, false], [5, false]]) {
    const current = revisions.find(item => item.id === id);
    const returned = findCopyReworkBaseline(revisions, id);
    assert.equal(copyReworkChanges(returned.content, current.content).satisfied, expected);
  }
  assert.equal(findCopyReworkBaseline(revisions, 5).id, 4);
  assert.equal(findCopyReworkBaseline([{ id: 1, parentRevisionId: 1 }], 1), null);
});

test('legacy reviewed content compares identically with current top-level fields', () => {
  assert.equal(copyReworkChanges({ reviewed: baseline }, baseline).satisfied, false);
  assert.equal(copyReworkChanges({ post: { ...baseline.copy, imagePlan: baseline.imagePlan } }, baseline).satisfied, false);
});
