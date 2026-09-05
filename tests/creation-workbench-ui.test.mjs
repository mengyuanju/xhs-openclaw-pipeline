import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('new creation workbench keeps the old dashboard and exposes lifecycle views', async () => {
  const [page, workbench, navigation, login, loginPage, proxyPolicy, oldDashboard, views, listPage, proxy] = await Promise.all([
    readFile(projectFile('app/workbench/page.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/api/auth/login/route.ts'), 'utf8'),
    readFile(projectFile('app/login/page.tsx'), 'utf8'),
    readFile(projectFile('src/admin/proxy-policy.mjs'), 'utf8'),
    readFile(projectFile('app/page.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/views.ts'), 'utf8'),
    readFile(projectFile('app/workbench/[view]/page.tsx'), 'utf8'),
    readFile(projectFile('app/api/control-plane/[...path]/route.ts'), 'utf8'),
  ]);

  assert.match(page, /redirect\('\/workbench\/personal'\)/u);
  assert.match(listPage, /viewKey=\{definition.key\}/u);
  assert.match(listPage, /key=\{definition.key\}/u);
  assert.match(listPage, /creatorUserId=\{session.username \|\| 'admin'\}/u);
  assert.match(listPage, /role=\{role\}/u);
  assert.match(listPage, /if \(!definition\) notFound\(\)/u);
  assert.match(workbench, /view.personalOnly\) search.set\('mine', 'true'\)/u);
  assert.doesNotMatch(workbench, /LOCAL_COPY|localOnly|search.set\('nodeId'/u);
  assert.match(proxy, /searchParams.set\('createdByUserId', username\)/u);
  assert.match(proxy, /'X-Actor-Username': username/u);
  assert.match(proxy, /'X-Actor-Role': role/u);
  assert.match(proxy, /'Content-Disposition': contentDisposition/u);
  assert.match(views, /生图连续3次失败的任务会回到此处，等待重新审核/u);
  assert.match(views, /states: \['COPY_REVIEW_PENDING'\]/u);
  assert.match(views, /states: \['IMAGE_QUEUED', 'IMAGE_RUNNING'\]/u);
  assert.match(views, /label: '人工归档'/u);
  assert.match(views, /states: \['MANUAL_ARCHIVE'\]/u);
  assert.doesNotMatch(views, /label: '已完成'|key: 'COMPLETED'/u);
  assert.match(navigation, /children: WORKBENCH_VIEWS/u);
  assert.match(navigation, /aria-current=\{selected \? 'page' : undefined\}/u);
  assert.match(navigation, /href: '\/workbench', label: '作业中心'/u);
  assert.match(login, /homePath: user.mustChangePassword \? '\/profile' : '\/workbench\/personal'/u);
  assert.match(loginPage, /: '\/workbench\/personal';/u);
  assert.match(proxyPolicy, /legacyReviewer \? '\/reviews' : '\/workbench\/personal'/u);
  assert.match(oldDashboard, /export default function DashboardPage/u);
  assert.match(oldDashboard, /内容生产总览/u);
});

test('all distributed task status displays distinguish exhausted image retries from normal copy review', async () => {
  for (const path of ['app/workbench/creation-workbench.tsx', 'app/workbench/task-review-dialog.tsx',
    'app/jobs/distributed-jobs-workbench.tsx']) {
    const source = await readFile(projectFile(path), 'utf8');
    assert.match(source, /isImageRetryExhausted/u);
    assert.match(source, /IMAGE_RETRY_EXHAUSTED_LABEL/u);
  }
});

test('running and failed copy tasks expose retry in personal and all-copy lists', async () => {
  const source = await readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8');
  assert.match(source, /activeView === 'PERSONAL' && canRetryCopy && <button[^>]*disabled=\{busy\}[^>]*onClick=\{\(\) => \{ void retryCopy\(task\); \}\}[^>]*><RotateCcw[^>]*\/>重试<\/button>/u);
  assert.match(source, /const canRetryCopy = canDiscard && \['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task.state\)/u);
  assert.match(source, /activeView === 'ALL_COPY'[\s\S]*?\{canRetryCopy && <button/u);
  assert.match(source, /if \(!\['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task.state\)\) return/u);
  assert.match(source, /if \(!await confirm\(/u);
  assert.match(source, /\/v1\/tasks\/\$\{task.id\}\/retry/u);
  assert.match(source, /useLatestConfig: true/u);
});

test('creation dialog accepts a single batch textarea and creates one remote batch', async () => {
  const [workbench, reviewDialog, styles, jobsPage, jobsWorkbench] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('app/jobs/page.tsx'), 'utf8'),
    readFile(projectFile('app/jobs/distributed-jobs-workbench.tsx'), 'utf8'),
  ]);

  assert.match(workbench, /<Dialog open=\{createOpen\}/u);
  assert.match(workbench, /<textarea[\s\S]*?id="workbench-query-text"/u);
  assert.match(workbench, /parseQueryBatch\(queryText\)/u);
  assert.match(workbench, /const \{ queries, error: validationError \} = queryBatch/u);
  assert.match(workbench, /已识别 \{queryBatch.queries.length\} 条 Query/u);
  assert.match(workbench, /中文逗号（，）、英文逗号（,）/u);
  assert.match(workbench, /disabled=\{creating \|\| !selectedExecutor \|\| Boolean\(queryBatch.error\)\}/u);
  assert.match(workbench, /createError && <div className="notice error" role="alert"/u);
  assert.doesNotMatch(workbench, /queryRows|nextQueryKey|添加一条 Query|workbench-remove-query/u);
  assert.match(workbench, /tasks: queries\.map\(\(query\)/u);
  assert.match(workbench, /copyExecutorNodeId: selectedExecutor\.id/u);
  assert.match(workbench, /apiPath\('\/v1\/nodes'\)/u);
  assert.match(workbench, /当前没有在线执行机/u);
  assert.match(workbench, /创建并加入队列/u);
  assert.doesNotMatch(workbench, /role="tablist"|role="tab"/u);
  assert.match(styles, /\.workbench-create-dialog\s*\{/u);
  assert.match(styles, /\.nav-submenu\[hidden\]/u);
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
  assert.match(reviewDialog, /aiDisclosureEnabled/u);
  assert.match(reviewDialog, /workbench-ai-disclosure-toggle/u);
  assert.match(reviewDialog, /<span>AI生成<\/span>/u);
  assert.match(reviewDialog, /const editable = detail\?\.state === 'COPY_REVIEW_PENDING'/u);
  assert.match(reviewDialog, /<ImagePreview src=\{apiPath\(asset\.url\)\}/u);
  assert.match(reviewDialog, />提交审核</u);
  assert.match(reviewDialog, /href=\{apiPath\(`\/v1\/tasks\/\$\{detail\.id\}\/archive`\)\}/u);
  assert.match(reviewDialog, /<Download size=\{14\} \/>下载资源/u);
  assert.doesNotMatch(reviewDialog, /approve-delivery|提交图文审核/u);
  assert.match(workbench, /按 Query 关键字搜索/u);
  assert.match(workbench, /includeTotal: 'true'/u);
  assert.match(workbench, /Array\.isArray\(rawTaskPage\)/u);
  assert.match(workbench, /caught\.message !== 'task state filter is invalid'/u);
  assert.match(workbench, /compatibilitySearch\.set\('mine', 'true'\)/u);
  assert.match(workbench, /compatibilityTasks\s*\?\?/u);
  assert.match(workbench, /matchesWorkbenchView\(task, view, creatorUserId\)/u);
  assert.match(workbench, /sort\(compareTasksByStatePriority\)/u);
  assert.match(workbench, /workbench-pagination/u);
  assert.match(workbench, />重试<\/button>/u);
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
  const [cli, simulationCli, runtime] = await Promise.all([
    readFile(projectFile('src/executor/cli.mjs'), 'utf8'),
    readFile(projectFile('src/executor/deepseek-simulator-cli.mjs'), 'utf8'),
    readFile(projectFile('src/executor/runtime.mjs'), 'utf8'),
  ]);
  const prepareAt = runtime.indexOf('await agent.prepare()');
  const registerAt = runtime.indexOf('await agent.register()');
  assert.ok(prepareAt >= 0 && prepareAt < registerAt);
  assert.ok(registerAt < runtime.indexOf('await scheduler.start()'));
  assert.match(runtime, /agent\.heartbeat\(\)/u);
  assert.match(cli, /await runExecutor\(/u);
  assert.match(cli, /concurrencyEnabled: true/u);
  assert.match(simulationCli, /executeCopy: executeDeepSeekCopySimulation/u);
  assert.match(simulationCli, /executeImage: executeDeepSeekImageSimulation/u);
  assert.match(simulationCli, /executorConfig\(.*simulation: true/u);
  assert.match(simulationCli, /await runExecutor\(/u);
  assert.match(simulationCli, /concurrencyEnabled: true/u);
  assert.doesNotMatch(simulationCli, /option\('max'\)|processed <|config\.max/u);
});
