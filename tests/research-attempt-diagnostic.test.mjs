import { readTaskReviewSource } from './helpers/task-review-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { safeDoubaoSearchDiagnostic } from '../app/workbench/research-attempt-diagnostic.mjs';

test('admin Doubao diagnostics show fixed failures and bounded error codes', () => {
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search requires DOUBAO_SEARCH_API_KEY'), '执行机缺少豆包搜索 Key');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with HTTP 403'), 'HTTP 403');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with an invalid service response'), '接口响应格式无效（旧记录）');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with service code 9001'), '服务错误码 9001');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with API code 10408'), 'API 错误码 10408');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with API code 700901'), 'API 错误码 700901');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with API code PermissionDenied'), 'API 错误码 PermissionDenied');
});

test('admin Doubao diagnostics never echo arbitrary upstream text or credential-like values', () => {
  const key = 'sk-test-secret-api-key-value';
  assert.equal(safeDoubaoSearchDiagnostic(`upstream says ${key}`), null);
  assert.equal(safeDoubaoSearchDiagnostic(`Doubao web search failed with API code ${key}`), 'API 错误码已隐藏');
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with API code ArbitraryUpstreamText'), 'API 错误码已隐藏');
  assert.equal(safeDoubaoSearchDiagnostic(`Doubao web search failed with HTTP 403 ${key}`), null);
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with HTTP 999'), null);
  assert.equal(safeDoubaoSearchDiagnostic('Doubao web search failed with service code 12345678'), null);
  assert.equal(safeDoubaoSearchDiagnostic({ message: key }), null);
});

test('task details gate Doubao diagnostics on admin role and provider', async () => {
  const source = await readTaskReviewSource();
  assert.match(source, /isAdmin && attempt\.status === 'FAILED'[\s\S]*attempt\.provider\.toLowerCase\(\) === 'doubao'/u);
  assert.match(source, /safeDoubaoSearchDiagnostic\(attempt\.error\)/u);
  assert.doesNotMatch(source, /\$\{attempt\.error\}/u);
});
