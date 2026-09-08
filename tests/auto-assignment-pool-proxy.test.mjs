import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('automatic assignment pool management is guarded as administrator-only at the web proxy', async () => {
  const proxy = await source('app/api/control-plane/[...path]/route.ts');

  assert.match(proxy, /\^\\\/v1\\\/auto-assignment\(\?:\\\/\|\$\)/u);
  assert.match(proxy, /role !== 'ADMIN'[\s\S]*auto-assignment/u);
});
