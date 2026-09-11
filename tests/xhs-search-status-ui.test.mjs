import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('administrators receive a global Xiaohongshu login alert backed by polling status', async () => {
  const [frame, alert] = await Promise.all([
    source('../app/components/app-frame.tsx'),
    source('../app/components/xhs-account-alert.tsx'),
  ]);
  assert.match(frame, /XhsAccountAlert enabled=\{session\?\.roles\?\.includes\('ADMIN'\) === true\}/u);
  assert.match(alert, /\/api\/control-plane\/v1\/xhs-search-statuses/u);
  assert.match(alert, /window\.setInterval[\s\S]*STATUS_POLL_MS/u);
  assert.match(alert, /LOGIN_REQUIRED|xhsSearchNeedsAttention/u);
  assert.match(alert, /小红书账号需要人工处理/u);
  assert.match(alert, /href="\/executors"/u);
});

test('executor management shows center and worker search nodes with account state', async () => {
  const [page, manager, config] = await Promise.all([
    source('../app/executors/page.tsx'),
    source('../app/executors/executor-manager.tsx'),
    source('../.env.example'),
  ]);
  assert.match(page, /\/v1\/xhs-search-statuses/u);
  assert.match(manager, /小红书搜索节点/u);
  assert.match(manager, /xhsHostKindLabel/u);
  assert.match(manager, /xhsAuthStatusLabel/u);
  assert.match(manager, /未设置账号标识/u);
  assert.match(config, /XHS_SEARCH_ACCOUNT_LABEL=/u);
  assert.match(config, /XHS_SEARCH_HOST_KIND=EXECUTOR/u);
});
