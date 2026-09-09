import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('distributed mode routes copy creation and global data through the control plane', async () => {
  const [copyPage, promptsPage, knowledgePage, settingsPage, navigation] = await Promise.all([
    source('app/workbench/[view]/page.tsx'),
    source('app/prompts/page.tsx'),
    source('app/knowledge/page.tsx'),
    source('app/settings/page.tsx'),
    source('app/components/side-nav.tsx'),
  ]);
  assert.match(copyPage, /controlPlaneUrl\(\)/u);
  assert.match(copyPage, /CreationWorkbench/u);
  assert.match(promptsPage, /CentralPromptWorkbench/u);
  assert.match(knowledgePage, /withKnowledgeStore/u);
  assert.match(knowledgePage, /<KnowledgeTabs/u);
  const knowledgeRuntime = await source('src/admin/knowledge-runtime.mjs');
  assert.match(knowledgeRuntime, /CONTROL_PLANE_URL/u);
  assert.match(knowledgeRuntime, /createRemoteKnowledgeStore/u);
  assert.match(settingsPage, /CentralDataWorkbench/u);
  assert.match(navigation, /href: '\/workbench', label: '作业中心'/u);
});

test('image worker polling is opt-in and documented for separate machines', async () => {
  const [executor, repository, readme] = await Promise.all([
    source('src/executor/agent.mjs'),
    source('server/src/postgres-repository.mjs'),
    source('README.md'),
  ]);
  assert.match(executor, /runCopyOnce: \(\) => claimAndExecute\('COPY'\)/u);
  assert.match(executor, /runImageOnce: \(\) => claimAndExecute\('IMAGE'\)/u);
  assert.match(repository, /FOR UPDATE OF task SKIP LOCKED/u);
  assert.match(repository, /node_id = \$1 AND kind = \$2 AND status = 'RUNNING'/u);
  assert.match(repository, /STALE_EXECUTION/u);
  assert.match(repository, /current_execution_id/u);
  assert.match(readme, /--disable-image-worker/u);
  assert.match(readme, /--enable-image-worker/u);
  assert.match(readme, /中心机器不需要安装 Codex/u);
});

test('remote control plane is an independently installable Koa package', async () => {
  const [serverPackageSource, serverSource, rootPackageSource] = await Promise.all([
    source('server/package.json'),
    source('server/src/http-server.mjs'),
    source('package.json'),
  ]);
  const serverPackage = JSON.parse(serverPackageSource);
  const rootPackage = JSON.parse(rootPackageSource);
  assert.equal(serverPackage.dependencies.koa.startsWith('^'), true);
  assert.equal(serverPackage.dependencies.pg.startsWith('^'), true);
  assert.equal(rootPackage.dependencies.pg, undefined);
  assert.match(serverSource, /new Koa\(\)/u);
  assert.match(serverSource, /new Router\(\)/u);
  assert.match(serverSource, /bodyParser/u);
});

test('every session-backed control-plane request carries the immutable user id', async () => {
  const adapters = await Promise.all([
    source('app/api/control-plane/[...path]/route.ts'),
    source('app/api/human-quality-settings/route.ts'),
    source('app/api/_prompt-runtime.ts'),
    source('app/api/web-search-settings/route.ts'),
    source('app/central-user-client.ts'),
    source('src/admin/knowledge-runtime.mjs'),
  ]);
  for (const value of adapters) assert.match(value, /sessionActorHeaders/u);
  assert.match(await source('src/control-plane/session-actor-headers.mjs'), /'X-Actor-User-Id'/u);
  assert.match(await source('src/web-statistics/service.mjs'), /'X-Actor-User-Id'/u);
});

test('direct Next adapters preserve stale-session failures and server pages request reauthentication', async () => {
  assert.match(await source('app/api/_prompt-runtime.ts'), /forwardControlPlaneRequest/u);
  assert.match(await source('app/api/visual-analyses/route.ts'), /forwardControlPlaneRequest/u);
  assert.match(await source('app/api/knowledge-assets/[id]/route.ts'), /controlPlaneResponseError/u);
  const centralUser = await source('app/central-user-client.ts');
  assert.match(centralUser, /throw await controlPlaneResponseError\(response\)/u);
  assert.match(centralUser, /redirect\(`\/login\?reauth=1&next=/u);
  for (const page of ['app/users/page.tsx', 'app/executors/page.tsx', 'app/profile/page.tsx']) {
    assert.match(await source(page), /readCentralPageData/u);
  }
});
