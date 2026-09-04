import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('new creation workbench keeps the old dashboard and exposes lifecycle views', async () => {
  const [page, workbench, navigation, login, loginPage, proxyPolicy, oldDashboard] = await Promise.all([
    readFile(projectFile('app/workbench/page.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/api/auth/login/route.ts'), 'utf8'),
    readFile(projectFile('app/login/page.tsx'), 'utf8'),
    readFile(projectFile('src/admin/proxy-policy.mjs'), 'utf8'),
    readFile(projectFile('app/page.tsx'), 'utf8'),
  ]);

  assert.match(page, /<CreationWorkbench nodeId=\{executorNodeId\(\)\}/u);
  assert.match(workbench, /useState<ViewKey>\('LOCAL_COPY'\)/u);
  assert.match(workbench, /states: \['COPY_QUEUED', 'COPY_RUNNING'\]/u);
  assert.match(workbench, /localOnly: true/u);
  assert.match(workbench, /label: '全部文案任务'/u);
  assert.match(workbench, /states: \['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'\]/u);
  assert.match(workbench, /待文案审核/u);
  assert.match(workbench, /states: \['COPY_REVIEW_PENDING', 'IMAGE_FAILED'\]/u);
  assert.match(workbench, /生图失败后退回的任务/u);
  assert.match(workbench, /states: \['IMAGE_QUEUED', 'IMAGE_RUNNING'\]/u);
  assert.match(workbench, /图文待审核/u);
  assert.match(workbench, /已完成/u);
  assert.match(navigation, /href: '\/workbench', label: '作业中心'/u);
  assert.match(login, /homePath: username === 'admin' \? '\/workbench'/u);
  assert.match(loginPage, /: '\/workbench';/u);
  assert.match(proxyPolicy, /session\.subject === 'admin' \? '\/workbench'/u);
  assert.match(oldDashboard, /export default function DashboardPage/u);
  assert.match(oldDashboard, /内容生产总览/u);
});

test('creation dialog accepts ordered Query rows and creates one remote batch', async () => {
  const [workbench, reviewDialog, styles, jobsPage, jobsWorkbench] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('app/jobs/page.tsx'), 'utf8'),
    readFile(projectFile('app/jobs/distributed-jobs-workbench.tsx'), 'utf8'),
  ]);

  assert.match(workbench, /<Dialog open=\{createOpen\}/u);
  assert.match(workbench, /queryRows\.map\(\(row, index\)/u);
  assert.match(workbench, /添加一条 Query/u);
  assert.match(workbench, /tasks: queries\.map\(\(query\)/u);
  assert.match(workbench, /copyExecutorNodeId: selectedExecutor\.id/u);
  assert.match(workbench, /apiPath\('\/v1\/nodes'\)/u);
  assert.match(workbench, /当前没有在线执行机/u);
  assert.match(workbench, /创建并加入队列/u);
  assert.match(workbench, /role="tablist"/u);
  assert.match(workbench, /aria-selected=\{selected\}/u);
  assert.match(styles, /\.workbench-create-dialog\s*\{/u);
  assert.match(styles, /\.workbench-view-tab\[aria-selected="true"\]/u);
  assert.doesNotMatch(workbench, /href=\{`\/jobs\?taskId=/u);
  assert.match(workbench, /<TaskReviewDialog/u);
  assert.match(reviewDialog, /任务详情与审核/u);
  assert.match(reviewDialog, /Query 原文/u);
  assert.match(reviewDialog, /review-copy-title/u);
  assert.match(reviewDialog, /review-copy-body/u);
  assert.match(reviewDialog, /review-copy-tags/u);
  assert.match(reviewDialog, /workbench-image-plan-card/u);
  assert.match(reviewDialog, /currentImageRun\?\.result\?\.simulation\?\.enabled/u);
  assert.match(reviewDialog, /联网搜索模拟图/u);
  assert.match(reviewDialog, /本地流程联调兜底图/u);
  assert.match(reviewDialog, /resultImage\.source\.pageUrl/u);
  assert.match(reviewDialog, /edits: draft/u);
  assert.match(reviewDialog, /\['COPY_REVIEW_PENDING', 'IMAGE_FAILED'\]\.includes\(detail\?\.state \?\? ''\)/u);
  assert.match(reviewDialog, /<ImagePreview src=\{apiPath\(asset\.url\)\}/u);
  assert.match(reviewDialog, />提交审核</u);
  assert.match(workbench, /按 Query 关键字搜索/u);
  assert.match(workbench, /includeTotal: 'true'/u);
  assert.match(workbench, /Array\.isArray\(rawTaskPage\)/u);
  assert.match(workbench, /legacyTasks = await apiRequest<DistributedTask\[\]>\(apiPath\('\/v1\/tasks\?limit=200&offset=0'\)\)/u);
  assert.match(workbench, /countsFromTasks\(legacyTasks \?\? taskPage\.items, nodeId\)/u);
  assert.match(workbench, /workbench-pagination/u);
  assert.match(workbench, />重新生文<\/button>/u);
  assert.match(workbench, />废弃<\/button>/u);
  assert.match(workbench, />审核<\/button>/u);
  assert.match(workbench, />查看<\/button>/u);
  assert.match(workbench, /\/v1\/tasks\/\$\{task\.id\}\/cancel/u);
  assert.match(workbench, /STAGE_LABELS\[task\.currentStage\] \?\? STATE_LABELS\[task\.state\]/u);
  assert.match(reviewDialog, /STAGE_LABELS\[detail\.currentStage\] \?\? STATE_LABELS\[detail\.state\]/u);
  assert.match(reviewDialog, /<dt>当前阶段<\/dt><dd>\{stageLabel\(detail\)\}<\/dd>/u);
  assert.doesNotMatch(workbench, /\{task\.currentStage \|\| STATE_LABELS/u);
  assert.doesNotMatch(reviewDialog, /\{detail\.currentStage \?\? '尚未开始'\}/u);
  assert.doesNotMatch(reviewDialog, /JSON\.stringify\(.*imagePlan/u);
  assert.match(styles, /\.workbench-review-dialog\s*\{/u);
  assert.match(jobsPage, /initialTaskId=\{taskId\}/u);
  assert.match(jobsWorkbench, /if \(initialTaskId\) void openTask\(initialTaskId\)/u);
});

test('task detail shows the image collection directly after copy and before planning', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');
  const headings = ['标题、正文与标签', '当前生成图片', '配图策划', '联网资料来源'];
  const positions = headings.map((heading) => source.indexOf(`<h3>${heading}</h3>`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(source.match(/<h3>当前生成图片<\/h3>/gu)?.length, 1);
  assert.match(source, /assets\.length > 0 \? '04' : '03'/u);
  assert.match(source, /assets\.length > 0 \? '05' : '04'/u);
});

test('executor CLI gates registration and polling behind readiness', async () => {
  const [cli, simulationCli] = await Promise.all([
    readFile(projectFile('src/executor/cli.mjs'), 'utf8'),
    readFile(projectFile('src/executor/deepseek-simulator-cli.mjs'), 'utf8'),
  ]);
  const prepareAt = cli.indexOf('await agent.prepare()');
  const registerAt = cli.indexOf('await agent.register()');
  const copyClaimAt = cli.indexOf('agent.runCopyOnce()');
  const imageClaimAt = cli.indexOf('agent.runImageOnce()');

  assert.ok(prepareAt >= 0 && prepareAt < registerAt);
  assert.ok(registerAt < copyClaimAt);
  assert.ok(registerAt < imageClaimAt);
  assert.match(cli, /agent\.heartbeat\(\)/u);
  assert.match(cli, /await Promise\.all\(lanes\)/u);
  assert.match(cli, /polling failed; retrying/u);
  assert.match(simulationCli, /executeCopy: executeDeepSeekCopySimulation/u);
  assert.match(simulationCli, /executeImage: executeDeepSeekImageSimulation/u);
  assert.match(simulationCli, /environment\.IMAGE_WORKER_ENABLED/u);
  assert.match(simulationCli, /runLane\('COPY', \(\) => agent\.runCopyOnce\(\)\)/u);
  assert.match(simulationCli, /runLane\('IMAGE', \(\) => agent\.runImageOnce\(\)\)/u);
  assert.match(simulationCli, /await Promise\.all\(lanes\)/u);
  assert.match(simulationCli, /polling failed; retrying/u);
  assert.doesNotMatch(simulationCli, /option\('max'\)|processed <|config\.max/u);
});
