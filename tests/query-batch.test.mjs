import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQueryBatch } from '../src/control-plane/query-batch.mjs';

test('batch queries support mixed newlines and Chinese/English commas in input order', () => {
  assert.deepEqual(parseQueryBatch('  桌面收纳\r\n通勤穿搭， 周末露营,读书计划\r健康饮食\n'), {
    queries: ['桌面收纳', '通勤穿搭', '周末露营', '读书计划', '健康饮食'], error: '',
  });
});

test('batch queries ignore blank segments without splitting spaces or other punctuation', () => {
  assert.deepEqual(parseQueryBatch('，,\n  \nAI writing tips；清单：三步  ,\n'), {
    queries: ['AI writing tips；清单：三步'], error: '',
  });
  for (const value of ['', ' ,，\n\r ', undefined]) {
    assert.deepEqual(parseQueryBatch(value), { queries: [], error: '请至少输入一条 Query。' });
  }
});

test('duplicate queries are identified after trimming without silently dropping input', () => {
  const result = parseQueryBatch('收纳,穿搭， 收纳 ');
  assert.deepEqual(result.queries, ['收纳', '穿搭', '收纳']);
  assert.match(result.error, /第 3 条.*第 1 条重复/u);
});

test('batch limit is 100 nonempty queries and over-limit batches are not truncated', () => {
  const values = Array.from({ length: 100 }, (_, index) => `选题 ${index + 1}`);
  assert.equal(parseQueryBatch(values.join('\n')).error, '');
  const result = parseQueryBatch([...values, '第101条'].join(','));
  assert.equal(result.queries.length, 101);
  assert.match(result.error, /最多创建 100 条/u);
});

test('each query is limited to 500 Unicode characters rather than the whole textarea', () => {
  const valid = parseQueryBatch('好'.repeat(500) + ',' + '🖼'.repeat(500));
  assert.equal(valid.error, '');
  assert.equal(valid.queries.length, 2);
  const invalid = parseQueryBatch('第一条\n' + '🖼'.repeat(501));
  assert.match(invalid.error, /第 2 条 Query 超过 500/u);
  assert.equal([...invalid.queries[1]].length, 501);
});
