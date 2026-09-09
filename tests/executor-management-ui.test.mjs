import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('administrator-only executor management shows status and safely removes retired machines', async () => {
  const [page, manager, navigation, topbar, proxy, server, repository, capability, migration, styles] = await Promise.all([
    source('app/executors/page.tsx'),
    source('app/executors/executor-manager.tsx'),
    source('app/components/side-nav.tsx'),
    source('app/components/app-topbar.tsx'),
    source('app/api/control-plane/[...path]/route.ts'),
    source('server/src/http-server.mjs'),
    source('server/src/postgres-repository.mjs'),
    source('src/control-plane/mutation-capability.mjs'),
    source('server/migrations/0023_executor_node_retirement.sql'),
    source('app/globals.css'),
  ]);

  assert.match(page, /if \(!session\.roles\?\.includes\('ADMIN'\)\) redirect\('\/workbench\/personal'\)/u);
  assert.match(page, /readCentralPageData\('\/v1\/executor-statuses', session, '\/executors'\)/u);
  assert.match(navigation, /href: '\/executors', label: '执行机管理'/u);
  assert.match(topbar, /pathname\.startsWith\('\/executors'\)[\s\S]*title: '执行机管理'/u);
  assert.match(proxy, /executor-statuses/u);
  assert.match(server, /router\.get\('\/v1\/executor-statuses'[\s\S]*requestActor\(ctx, \['ADMIN'\]\)/u);
  assert.match(server, /router\.delete\('\/v1\/executor-statuses'[\s\S]*const actor = requestActor\(ctx, \['ADMIN'\]\)[\s\S]*repository\.retireNode\(requireJson\(ctx\)\.nodeId, actor\)/u);
  assert.match(repository, /AS image_running_count/u);
  assert.match(repository, /WHERE n\.retired_at IS NULL/u);
  assert.match(repository, /retired_at = NULL/u);
  assert.match(repository, /async retireNode\(rawNodeId, rawActor\)[\s\S]*lockCurrentActor\(client, rawActor\)/u);
  assert.match(repository, /EXECUTOR_STILL_ONLINE/u);
  assert.match(repository, /EXECUTOR_HAS_RUNNING_TASKS/u);
  assert.match(repository, /executorManagementVersion: 1/u);
  assert.match(repository, /SELECT \* FROM executor_nodes WHERE id = \$1 AND retired_at IS NULL FOR UPDATE/u);
  assert.match(manager, /每 15 秒自动刷新/u);
  assert.match(manager, /node\.copyRunningCount[\s\S]*node\.copyConcurrency/u);
  assert.match(manager, /node\.imageRunningCount[\s\S]*node\.imageConcurrency/u);
  assert.match(manager, /useConfirmDialog/u);
  assert.match(manager, /删除这条执行机信息/u);
  assert.match(manager, /apiRequest\('\/api\/control-plane\/v1\/executor-statuses'[\s\S]*method: 'DELETE'[\s\S]*JSON\.stringify\(\{ nodeId: node\.id \}\)/u);
  assert.match(manager, /current\.filter\(\(candidate\) => candidate\.id !== node\.id\)/u);
  assert.match(manager, /node\.online \|\| hasRunningTasks/u);
  assert.match(manager, /manualRefreshRunning\.current/u);
  assert.match(manager, /actionError \|\| refreshError/u);
  assert.match(manager, /aria-label=\{`删除执行机 \$\{node\.name\}`\}/u);
  assert.match(manager, /className="row-action" data-label="操作"/u);
  assert.match(capability, /executorManagementVersion[\s\S]*method === 'DELETE'/u);
  assert.match(migration, /ADD COLUMN retired_at timestamptz/u);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|TRUNCATE/u);
  assert.match(styles, /\.executor-status-ready/u);
  assert.match(styles, /\.executor-status-offline/u);
  assert.match(styles, /\.executor-row-actions/u);
});
