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

test('image worker polling is opt-in and manual edits run on the same executor image lane', async () => {
  const [executor, repository, readme,centerCli] = await Promise.all([
    source('src/executor/agent.mjs'),
    source('server/src/postgres-repository.mjs'),
    source('README.md'),
    source('server/src/cli.mjs'),
  ]);
  assert.match(executor, /runCopyOnce: \(\) => claimAndExecute\('COPY'\)/u);
  assert.match(executor, /runImageOnce: \(\) => claimAndExecute\('IMAGE'\)/u);
  assert.match(repository, /FOR UPDATE OF task SKIP LOCKED/u);
  assert.match(repository, /JOIN executor_nodes owner ON owner\.id = execution\.node_id[\s\S]*WHERE owner\.codex_pool_id = \$1 AND execution\.status = 'RUNNING'/u);
  assert.match(repository, /COUNT\(\*\) FILTER \(WHERE execution\.kind = 'IMAGE'\) AS image_count/u);
  assert.match(repository, /STALE_EXECUTION/u);
  assert.match(repository, /current_execution_id/u);
  assert.match(repository,/imageEditExecutorVersion: 1/u);
  assert.match(repository,/image_edit_request_id/u);
  assert.match(executor,/executeImageEditClaim/u);
  assert.match(executor,/claim\.imageEdit/u);
  assert.doesNotMatch(centerCli,/startImageEditProcessing|image-edit-once/u);
  assert.match(readme, /--disable-image-worker/u);
  assert.match(readme, /--enable-image-worker/u);
  assert.match(readme, /中心机器不需要安装 Codex/u);
  assert.match(readme,/同一个图片容量池/u);
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
