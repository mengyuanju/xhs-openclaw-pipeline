import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQueryPackageText } from '../app/query-packages/types.ts';

test('Query package intake keeps source order while removing normalized duplicates', () => {
  assert.deepEqual(parseQueryPackageText('\uFEFFQuery\r\n  桌面  收纳  \r\n桌面 收纳\r\n"通勤穿搭"\r\n关键词'), {
    queries: ['桌面  收纳', '通勤穿搭'],
    duplicates: 1,
    error: null,
  });
});

test('Query package intake rejects overlong rows and never truncates oversized packages', () => {
  const overlong = parseQueryPackageText(`正常 Query\n${'好'.repeat(501)}`);
  assert.deepEqual(overlong.queries, []);
  assert.match(overlong.error, /500/u);

  const oversized = parseQueryPackageText('一\n二\n三', 2);
  assert.deepEqual(oversized.queries, []);
  assert.match(oversized.error, /最多导入 2 条/u);
});
