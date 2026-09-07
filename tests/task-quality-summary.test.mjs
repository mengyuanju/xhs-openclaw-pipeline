import assert from 'node:assert/strict';
import test from 'node:test';
import { taskQualitySummary } from '../app/workbench/task-quality-presentation.mjs';

test('low scores retain reasons and put severe issues first', () => {
  const view = taskQualitySummary({ qc: { overallScore: 1, summary: '文字需要修正',
    issues: [{ severity: 'minor', label: '间距', evidence: '第2页偏紧' },
      { severity: 'major', label: '错字', evidence: '第1页标题错误' }],
    rubric: { dimensions: { imageTextQuality: { score: 1, applicable: true, evidence: ['部分文字模糊'] } } },
  } });
  assert.equal(view.score, 1);
  assert.equal(view.needsAttention, true);
  assert.equal(view.issues[0].label, '错字');
  assert.equal(view.dimensions[0].label, '图片文字质量');
  assert.equal(view.dimensions[0].evidence[0], '部分文字模糊');
});

test('missing, malformed and locally converted reports never imply a passing quality score', () => {
  for (const qc of [undefined, null, 'bad', { overallScore: '3' }, { overallScore: 9 }]) {
    assert.equal(taskQualitySummary({ qc }).score, null);
  }
  const converted = taskQualitySummary({ processing: { type: 'LOCAL' }, qc: { overallScore: 3 } });
  assert.equal(converted.score, null);
  assert.equal(converted.needsAttention, true);
  assert.match(converted.summary, /未重新/);
});

test('model output is bounded text and excluded dimensions do not become warnings', () => {
  const view = taskQualitySummary({ qc: { overallScore: 0, summary: { malicious: true },
    issues: [null, { label: {}, evidence: [] }, { label: '<script>x</script>', evidence: 'x'.repeat(2000) }],
    rubric: { dimensions: { unknown: { score: 1 }, imageTextQuality: { score: 0, applicable: false } } },
  } });
  assert.equal(view.score, 0);
  assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0].label, '<script>x</script>');
  assert.ok(view.issues[0].evidence.length <= 500);
  assert.deepEqual(view.dimensions, []);
});

test('production rubric evidence and issue labels are visible without a model summary', () => {
  const view = taskQualitySummary({ qc: { overallScore: 1, rubric: {
    dimensions: { imageBaseQuality: { score: 1, evidence: ['页面存在遮挡。'] } },
    issueLabels: [{ severity: 'major', label: '遮挡', evidence: '页面存在遮挡。' }],
    lowestObstacleDimensions: ['imageBaseQuality'],
  }, issues: [{ severity: 'major', label: '遮挡', evidence: '页面存在遮挡。' }] } });
  assert.equal(view.issues.length, 1);
  assert.match(view.summary, /页面存在遮挡/);
  assert.equal(view.dimensions[0].label, '图片基础质量');
});
