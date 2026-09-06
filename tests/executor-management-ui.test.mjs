import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('administrator-only executor management shows live capacity and heartbeat status', async () => {
  const [page, manager, navigation, topbar, proxy, server, repository, styles] = await Promise.all([
    source('app/executors/page.tsx'),
    source('app/executors/executor-manager.tsx'),
    source('app/components/side-nav.tsx'),
    source('app/components/app-topbar.tsx'),
    source('app/api/control-plane/[...path]/route.ts'),
    source('server/src/http-server.mjs'),
    source('server/src/postgres-repository.mjs'),
    source('app/globals.css'),
  ]);

  assert.match(page, /if \(!session\.roles\?\.includes\('ADMIN'\)\) redirect\('\/workbench\/personal'\)/u);
  assert.match(page, /readCentralData\('\/v1\/executor-statuses'/u);
  assert.match(navigation, /href: '\/executors', label: '执行机管理'/u);
  assert.match(topbar, /pathname\.startsWith\('\/executors'\)[\s\S]*title: '执行机管理'/u);
  assert.match(proxy, /executor-statuses/u);
  assert.match(server, /router\.get\('\/v1\/executor-statuses'[\s\S]*requestActor\(ctx, \['ADMIN'\]\)/u);
  assert.match(repository, /AS image_running_count/u);
  assert.match(manager, /每 15 秒自动刷新/u);
  assert.match(manager, /node\.copyRunningCount[\s\S]*node\.copyConcurrency/u);
  assert.match(manager, /node\.imageRunningCount[\s\S]*node\.imageConcurrency/u);
  assert.match(styles, /\.executor-status-ready/u);
  assert.match(styles, /\.executor-status-offline/u);
});
