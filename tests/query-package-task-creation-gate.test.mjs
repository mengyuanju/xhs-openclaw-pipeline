import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ordinary workers cannot open legacy creation or be sent to the administrator-only package workflow', async () => {
  const source = await readFile(new URL('../app/workbench/creation-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /role === 'ADMIN' && <Dialog open=\{createOpen\}/u);
  assert.match(source, /if \(role !== 'ADMIN'\) \{/u);
  assert.match(source, /role === 'ADMIN'[\s\S]*创建第一条笔记/u);
  assert.doesNotMatch(source, /router\.push\('\/query-packages'\)|前往 Query 词包/u);
  assert.doesNotMatch(source, /workerImportEnabled[\s\S]{0,300}setCreateOpen/u,
    'the package-import switch must not grant legacy task creation');
});
