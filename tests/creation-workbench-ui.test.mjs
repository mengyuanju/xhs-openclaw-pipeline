import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('new creation workbench owns the root route and exposes lifecycle views', async () => {
  const [page, workbench, navigation, login, loginPage, proxyPolicy, homePage, views, listPage, proxy] = await Promise.all([
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

  assert.equal(homePage.includes("redirect('/workbench/personal')"), true);
  assert.match(page, /redirect\('\/workbench\/personal'\)/u);
  assert.match(listPage, /viewKey=\{definition.key\}/u);
  assert.match(listPage, /key=\{[^\n]*definition\.key/u);
  assert.match(listPage, /creatorUserId=\{session.username \|\| 'admin'\}/u);
  assert.match(listPage, /role=\{role\}/u);
  assert.match(listPage, /if \(!definition\) notFound\(\)/u);
  assert.match(workbench, /view.personalOnly\) search.set\('mine', 'true'\)/u);
  assert.doesNotMatch(workbench, /LOCAL_COPY|localOnly|search.set\('nodeId'/u);
  assert.match(proxy, /searchParams.set\('personal', 'true'\)/u);
  assert.match(proxy, /searchParams.set\('assignedToUserId', username\)/u);
  assert.match(proxy, /searchParams.delete\('createdByUserId'\)/u);
  assert.match(proxy, /searchParams.delete\('createdByAccountId'\)/u);
  assert.match(proxy, /sessionActorHeaders\(session, \{ username, role \}\)/u);
  assert.match(proxy, /sessionActorHeaders/u);
  assert.match(proxy, /'Content-Disposition': contentDisposition/u);
  assert.match(views, /生图连续3次失败的任务会回到此处，等待重新审核/u);
  assert.match(views, /states: \['COPY_REVIEW_PENDING'\]/u);
  assert.match(views, /states: \['IMAGE_QUEUED', 'IMAGE_RUNNING'\]/u);
  assert.match(views, /label: '图文终审'/u);
  assert.match(views, /states: \['MANUAL_ARCHIVE'\]/u);
  assert.match(views, /label: '交付池'/u);
  assert.match(views, /states: \['REVIEWED'\]/u);
  assert.match(listPage, /if \(definition\.adminOnly && role !== 'ADMIN'\) redirect\('\/workbench\/personal'\)/u);
  assert.match(workbench, /role=\{role\}/u);
  assert.match(navigation, /children: WORKBENCH_VIEWS/u);
  assert.match(navigation, /child\.href !== '\/workbench\/completed'/u);
  assert.match(navigation, /aria-current=\{selected \? 'page' : undefined\}/u);
  assert.match(navigation, /href: '\/workbench', label: '作业中心'/u);
  assert.match(login, /homePath: user.mustChangePassword \? '\/profile' : '\/workbench\/personal'/u);
  assert.match(loginPage, /: '\/workbench\/personal';/u);
  assert.doesNotMatch(proxyPolicy, /legacyReviewPath|location: '\/reviews'/u);
});

test('ordinary users do not render Query package provenance or delivery downloads', async () => {
  const [workbench, reviewDialog, navigation] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
  ]);

  assert.match(navigation, /items\.filter\(\(item\) => item\.href === '\/workbench'\)/u,
    'ordinary users must not receive Query package or delivery-pool navigation entries');
  assert.match(workbench, /const canUseQueryPackageFilter = role !== 'USER'/u);
  assert.match(workbench, /canUseQueryPackageFilter \? initialListState\.queryPackageName : ''/u,
    'a package filter from the URL must not initialize for an ordinary user');
  assert.match(workbench, /if \(canUseQueryPackageFilter && queryPackageName\) search\.set\('queryPackageName', queryPackageName\)/u,
    'ordinary task requests must not submit the package-name filter');
  assert.match(workbench, /\{canUseQueryPackageFilter && <>[\s\S]{0,500}id="workbench-query-package-search"/u,
    'the package-name search control must not render for ordinary users');
  assert.match(workbench, /\{role !== 'USER' && <small[^>]*[\s\S]{0,200}>词包：\{task\.sourceQueryPackageName/u,
    'task rows must not render package provenance for ordinary users');
  assert.match(workbench, /role === 'USER' && state === 'REVIEWED' \? '已完成' : STATE_LABELS\[state\]/u,
    'ordinary users must see a completed state instead of the delivery-pool label');
  assert.match(reviewDialog, /\{role !== 'USER' && <div className="subtle">词包：\{detail\.sourceQueryPackageName \|\| '未归属词包'\}<\/div>\}/u,
    'task detail must not render package provenance for ordinary users');
  assert.doesNotMatch(reviewDialog, /\{role !== 'USER' && <section className="workbench-review-section" aria-labelledby="review-xiaohongshu-links-title">/u,
    'assigned operators must still see the Query-specific Xiaohongshu review links');
  assert.match(reviewDialog, /role === 'USER' \? '已完成任务详情' : '交付池任务详情'/u);
  assert.match(reviewDialog, /role === 'USER'[\s\S]{0,120}'任务已经完成，可查看最终内容。'/u);
  assert.match(reviewDialog, /role === 'USER'[\s\S]{0,120}'图片已经生成，正在等待图文终审；当前内容仅供查看。'/u);
  assert.doesNotMatch(reviewDialog, /const downloadable =[^;]*currentUserIsAssignee/u,
    'ordinary assignees must not regain the administrator-only delivery download');
  assert.match(reviewDialog, /const downloadable =[^;]*\bisAdmin\b[^;]*;/u);
});

test('all distributed task status displays distinguish exhausted image retries from normal copy review', async () => {
  for (const path of ['app/workbench/creation-workbench.tsx', 'app/workbench/task-review-dialog.tsx']) {
    const source = await readFile(projectFile(path), 'utf8');
    assert.match(source, /isImageRetryExhausted/u);
    assert.match(source, /IMAGE_RETRY_EXHAUSTED_LABEL/u);
  }
});

test('mandatory copy rechecks have a dedicated workbench status and next-step explanation', async () => {
  const [workbench, reviewDialog] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
  ]);

  assert.match(workbench, /QC_MANDATORY_RECHECK: '待强制复检'/u);
  assert.match(workbench, /task\.currentStage === 'QC_MANDATORY_RECHECK'[\s\S]{0,240}复检通过后才进入待生图/u);
  assert.match(reviewDialog, /detail\.currentStage === 'QC_MANDATORY_RECHECK'[\s\S]{0,240}返工稿已提交强制复检；复检通过后才会进入待生图队列/u);
});

test('running and failed copy tasks expose retry in personal, all-copy and all-jobs lists', async () => {
  const [source, reviewDialog] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
  ]);
  assert.match(source, /activeView === 'PERSONAL' && canRetryCopy && <Button[^>]*disabled=\{busy\}[^>]*onClick=\{\(\) => \{ void retryCopy\(task\); \}\}[^>]*><RotateCcw[^>]*\/>重试<\/Button>/u);
  assert.match(source, /const canRetryCopy = \(hasOwnerControl \|\| creatorCanControlMachineCopy\)[\s\S]*\['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task.state\)/u);
  assert.match(source, /activeView === 'ALL_COPY'[\s\S]*?\{canRetryCopy && <Button/u);
  assert.match(source, /if \(isAllJobs\)[\s\S]*?\{\['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task\.state\) && <Button[^>]*disabled=\{busy\}[^>]*onClick=\{\(\) => \{ void retryCopy\(task\); \}\}[^>]*><RotateCcw[^>]*\/>重试<\/Button>/u);
  assert.match(source, /if \(!\['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task.state\)\) return/u);
  assert.match(source, /if \(!await confirm\(/u);
  assert.match(source, /\/v1\/tasks\/\$\{task.id\}\/retry/u);
  assert.match(source, /useLatestConfig: true/u);
  assert.match(reviewDialog, /const canRetryCopy = Boolean\(detail[\s\S]*?\['COPY_RUNNING', 'COPY_FAILED'\]\.includes\(detail\.state\)[\s\S]*?detail\.assignedToUserId === null && currentUserIsCreator/u);
  assert.match(reviewDialog, /\/v1\/tasks\/\$\{detail\.id\}\/retry/u);
  assert.match(reviewDialog, /body: JSON\.stringify\(\{ useLatestConfig: true \}\)/u);
  assert.match(reviewDialog, /\{canRetryCopy && <Button[^>]*onClick=\{\(\) => \{ void retryCopy\(\); \}\}[^>]*><RotateCcw[^>]*\/>重试文案<\/Button>\}/u);
  assert.match(reviewDialog, /detail\?\.state === 'COPY_FAILED'[\s\S]{0,220}重试文案/u);
});

test('personal and image-work rows expose safe image requeue controls', async () => {
  const source = await readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8');
  assert.match(source, /async function retryImages\(task: DistributedTask\)/u);
  assert.match(source, /\/v1\/tasks\/\$\{task\.id\}\/retry-image/u);
  assert.match(source, /activeView === 'IMAGE_WORK'[\s\S]*\{retryImageButton\}/u);
  assert.match(source, /activeView === 'PERSONAL' && retryImageButton/u);
  assert.match(source, /文案尚未审核通过，暂不能重试生图/u);
  assert.match(source, />重试生图<\/Button>/u);
});

test('admin queued tasks expose a direct discard then permanent-delete workflow', async () => {
  const [source, rowActions, styles] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-row-actions.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);
  assert.match(source, /async function discardQueuedTask\(task: DistributedTask\)/u);
  assert.match(source, /已废弃；现在可以永久删除/u);
  assert.match(source, /canDiscard && !canDiscardQueue/u);
  assert.match(source, /creatorCanControlMachineCopy[\s\S]*\['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'\]\.includes\(task\.state\)/u);
  assert.match(source, /visibleActionCount=\{visibleActionCount\}/u);
  assert.match(source, /const visibleActionCount = role === 'ADMIN' && activeView !== 'UNASSIGNED' \? 2 : 1/u);
  assert.match(styles, /\.workbench-col-actions \{ width: 216px; min-width: 216px; max-width: 216px; \}/u);
  assert.match(source, /queued && <Button[^>]*onClick=\{\(\) => \{ void discardQueuedTask\(task\); \}\}[^>]*><Trash2[^>]*\/>废弃<\/Button>/u);
  assert.match(source, /\{permanentDeleteButton\}[\s\S]*\{task\.state === 'CANCELLED'/u);
  assert.match(rowActions, /visibleActionCount = 1/u);
  assert.match(rowActions, /actions\.slice\(0, Math\.max\(1, Math\.trunc\(visibleActionCount\)\)\)/u);
  assert.match(styles, /\.workbench-action-menu \.button\.primary \{ color: white; background: var\(--red\); \}/u,
    'primary actions inside the overflow menu must keep a visible filled background');
  assert.match(styles, /\.workbench-action-menu \.button\.primary\[data-highlighted\] \{ background: var\(--red-dark\); \}/u,
    'highlighted primary menu actions must remain legible');
  assert.match(source, /PERMANENT_DELETE_STATES\.includes\(task\.state\)/u);
  assert.match(source, /CANCELLED_EXECUTION_SETTLE_MS = 3 \* 60_000/u);
  assert.match(source, /cancelledExecutionSettled/u);
  assert.match(source, /function PermanentDeleteDialog/u);
  assert.match(source, /AlertDialogPrimitive\.Content className="permanent-delete-dialog/u);
  assert.match(source, /删除后无法恢复/u);
  assert.match(source, /error && <div className="notice error permanent-delete-error" role="alert"/u);
  assert.match(source, /const permanentlyDeletableTasks = selectedTasks\.filter\(isPermanentlyDeletableTask\)/u);
  assert.match(source, /\/v1\/tasks\/batch-permanent-delete/u);
  assert.match(source, /批量永久删除 \{tasks\.length\} 条任务/u);
  assert.match(source, /废弃排队中 \{queuedTasks\.length\}/u);
  assert.match(source, /单次最多永久删除 20 条/u);
});

test('workbench table columns resize automatically within readable limits', async () => {
  const [source, styles] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);
  assert.match(styles, /\.workbench-table-wrap table \{ min-width: 1040px; table-layout: auto; \}/u);
  assert.match(styles, /\.workbench-col-query \{ width: clamp\(220px, 23%, 300px\); min-width: 220px; max-width: 300px; \}/u);
  assert.match(styles, /\.workbench-col-creator \{ width: 13%; min-width: 120px; \}/u);
  assert.match(styles, /\.workbench-col-progress \{ width: 16%; min-width: 150px; \}/u);
  assert.match(styles, /\.workbench-col-executor \{ width: 10%; min-width: 96px; \}/u);
  assert.match(styles, /\.workbench-col-time \{ width: 13%; min-width: 120px; \}/u);
  assert.match(styles, /\.workbench-table-wrap \.query-cell > \.workbench-cell-stack \{ width: 100%; max-width: 300px; \}/u);
  assert.match(source, /className="query-cell workbench-col-query"/u);
  for (const column of ['creator', 'progress', 'executor', 'time']) {
    assert.match(source, new RegExp(`className="workbench-col-${column}"`, 'u'));
  }
});

test('permanent deletion rejects repeated submits and unlocks before refreshing the list', async () => {
  const source = await readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8');
  const singleStart = source.indexOf('async function permanentlyDeleteTask()');
  const batchStart = source.indexOf('async function permanentlyDeleteSelectedTasks()');
  const actionsStart = source.indexOf('function taskActions(', batchStart);
  const singleDelete = source.slice(singleStart, batchStart);
  const batchDelete = source.slice(batchStart, actionsStart);

  assert.ok(singleStart >= 0 && batchStart > singleStart && actionsStart > batchStart);
  for (const deletionFlow of [singleDelete, batchDelete]) {
    assert.match(deletionFlow, /permanentDeletionLock\.acquire\(\)/u);
    assert.match(deletionFlow, /finally \{[\s\S]*permanentDeletionLock\.release\(\)[\s\S]*\}[\s\S]*if \(refreshAfterDelete\) void refresh\(\{ silent: true \}\)/u);
    assert.doesNotMatch(deletionFlow, /await refresh\(\{ silent: true \}\)/u);
  }
  assert.match(source, /setTasks\(\(current\) => current\.filter/u);
  assert.match(source, /LIST_REFRESH_TIMEOUT_MS = 15_000/u);
  assert.match(source, /setFetchError\(timedOut \? '任务读取超时，请重试'/u);
  assert.match(source, /废弃满 3 分钟后可删除/u);
});

test('list state, saved views and centralized batch handling are available to administrators', async () => {
  const [workbench, page, proxy, listState] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/[view]/page.tsx'), 'utf8'),
    readFile(projectFile('app/api/control-plane/[...path]/route.ts'), 'utf8'),
    readFile(projectFile('app/workbench/list-state.ts'), 'utf8'),
  ]);
  assert.match(page, /parseWorkbenchListState/u);
  assert.match(page, /initialListState=\{initialListState\}/u);
  assert.match(workbench, /workbenchListSearch/u);
  assert.match(workbench, /router\.replace\(href, \{ scroll: false \}\)/u);
  assert.match(listState, /queryPackageName/u);
  assert.match(listState, /createdByAccountId|createdByUserId|deduplicateQuery|attention|taskId/u);
  assert.match(workbench, /<SelectItem value=\{DEFAULT_TASK_VIEW_VALUE\}>默认视图<\/SelectItem>/u);
  assert.match(workbench, /function applyDefaultView\(\)[\s\S]*setSort\(DEFAULT_WORKBENCH_LIST_STATE\.sort\)[\s\S]*setPageSize\(DEFAULT_WORKBENCH_LIST_STATE\.pageSize\)/u);
  assert.match(workbench, /保存当前视图/u);
  assert.match(workbench, /我的失败任务/u);
  assert.match(workbench, /长期无进度/u);
  assert.match(workbench, /\/v1\/tasks\/batch-actions/u);
  assert.match(workbench, /\/v1\/tasks\/batch-archive/u);
  assert.match(workbench, /\/v1\/tasks\/batch-permanent-delete/u);
  assert.match(workbench, /选择当前页全部任务/u);
  assert.match(proxy, /\/v1\/tasks\/batch-permanent-delete/u);
  assert.match(proxy, /仅管理员可使用任务集中处理功能/u);
});

test('creation dialog accepts a single batch textarea and creates one remote batch', async () => {
  const [workbench, reviewDialog, styles] = await Promise.all([
    readFile(projectFile('app/workbench/creation-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(workbench, /<Dialog open=\{createOpen\}/u);
  assert.match(workbench, /<Textarea[\s\S]*?id="workbench-query-text"/u);
  assert.match(workbench, /parseQueryBatch\(queryText\)/u);
  assert.match(workbench, /const \{ queries, error: validationError \} = queryBatch/u);
  assert.match(workbench, /已识别 \{queryBatch.queries.length\} 条 Query/u);
  assert.match(workbench, /中文逗号（，）、英文逗号（,）/u);
  assert.match(workbench, /disabled=\{creating \|\| Boolean\(queryBatch.error\) \|\| \(effectiveSkipCopyReview && !createAssignee\)\}/u);
  assert.match(workbench, /createError && <div className="notice error" role="alert"/u);
  assert.doesNotMatch(workbench, /queryRows|nextQueryKey|添加一条 Query|workbench-remove-query/u);
  assert.match(workbench, /tasks: queries\.map\(\(query\)/u);
  assert.match(workbench, /assigneeAccountId: createAssignee\?\.id \?\? null/u);
  assert.doesNotMatch(workbench, /copyExecutorNodeId:\s*selectedExecutor\.id|selectedExecutor|selectCopyExecutor/u);
  assert.match(workbench, /apiPath\('\/v1\/nodes'\)/u);
  assert.match(workbench, /共享文案队列/u);
  assert.match(workbench, /待领取/u);
  assert.doesNotMatch(workbench, /workbench-copy-executor|当前没有在线执行机/u);
  assert.match(workbench, /创建并加入队列/u);
  assert.doesNotMatch(workbench, /role="tablist"|role="tab"/u);
  assert.match(styles, /\.workbench-create-dialog\s*\{/u);
  assert.match(styles, /\.nav-submenu\[hidden\]/u);
  assert.doesNotMatch(workbench, /href=\{`\/jobs\?taskId=/u);
  assert.match(workbench, /<TaskReviewDialog/u);
  assert.match(reviewDialog, /任务详情与审核/u);
  assert.match(reviewDialog, /Query 原文/u);
  assert.match(reviewDialog, /xiaohongshuLinks: Array<\{/u);
  assert.match(reviewDialog, /detail\?\.xiaohongshuLinks \?\? \[\]/u);
  assert.match(reviewDialog, /<h3 id="review-xiaohongshu-links-title">Query 对应小红书文章<\/h3>/u);
  assert.doesNotMatch(reviewDialog, /role !== 'USER' && <section[^>]*review-xiaohongshu-links-title/u);
  assert.match(reviewDialog, /不属于联网资料来源/u);
  assert.match(reviewDialog, /aria-label="Query 对应小红书文章链接"/u);
  assert.match(reviewDialog, /按点赞量从高到低保留管理员设定的数量/u);
  assert.match(reviewDialog, /点赞量排序第 \{rank\} 条/u);
  assert.match(reviewDialog, /href=\{link\.url\} target="_blank" rel="noopener noreferrer"/u);
  assert.match(reviewDialog, /url\.protocol !== 'https:'[\s\S]*hostname !== 'xiaohongshu\.com'[\s\S]*!hostname\.endsWith\('\.xiaohongshu\.com'\)/u);
  assert.match(reviewDialog, /xiaohongshuSearchStatus\?:/u);
  assert.match(reviewDialog, /搜索已完成，但没有找到可展示的小红书文章链接/u);
  assert.match(reviewDialog, /xiaohongshuEmptyMessage\(detail\)/u);
  assert.match(reviewDialog, /const sources = revision\?\.content\.generation\?\.research\?\.sources \?\? \[\];/u);
  assert.match(reviewDialog, /review-copy-title/u);
  assert.match(reviewDialog, /review-copy-body/u);
  assert.match(reviewDialog, /review-copy-tags/u);
  assert.match(reviewDialog, /workbench-image-plan-card/u);
  assert.match(reviewDialog, /currentImageRun\?\.result\?\.simulation\?\.enabled/u);
  assert.match(reviewDialog, /联网搜索模拟图/u);
  assert.match(reviewDialog, /本地流程联调兜底图/u);
  assert.match(reviewDialog, /resultImage\.source\.pageUrl/u);
  assert.match(reviewDialog, /buildCopyReviewSubmission\(\{[\s\S]*draft,[\s\S]*copyContentChangedFromMachine/u);
  assert.match(reviewDialog, /aiDisclosureEnabled/u);
  assert.match(reviewDialog, /workbench-ai-disclosure-toggle/u);
  assert.match(reviewDialog, /AI生成水印/u);
  assert.match(reviewDialog, /aiDisclosureEnabled \? '已开启' : '已关闭'/u);
  assert.match(reviewDialog, /const editable = taskHasAssignee && canReviewCopy && detail\?\.state === 'COPY_REVIEW_PENDING'/u);
  assert.match(reviewDialog, /const canEditApprovedImagePlan = Boolean\(isAdmin && canReviewImages && canModifyImages\)/u);
  assert.match(reviewDialog, /const planFieldsReadOnly = !\(editable \|\| canEditApprovedImagePlan\)/u);
  assert.match(reviewDialog, /const planKindDisabled = !editable \|\| loading \|\| submitting/u);
  assert.match(reviewDialog, /readOnly=\{planFieldsReadOnly\}/u);
  assert.match(reviewDialog, /disabled=\{planKindDisabled\}/u);
  assert.match(reviewDialog, /decision === 'REWORK' && reworkTarget !== 'COPY' && imagePlanChanged[\s\S]*revisionId: revision!\.id[\s\S]*imagePlan: draft!\.imagePlan/u);
  assert.match(reviewDialog, /reviewImagePlanEdits !== true/u);
  assert.match(reviewDialog, /评分后重试会创建新的人工批准版本/u);
  assert.match(workbench, /currentUsername=\{creatorUserId\}/u);
  assert.match(workbench, /currentAccountId=\{creatorAccountId\}/u);
  assert.match(reviewDialog, /onPrevious=\{activeAssetIndex > 0/u);
  assert.match(reviewDialog, /onNext=\{activeAssetIndex < assets\.length - 1/u);
  assert.match(reviewDialog, /审核通过并进入后续流程/u);
  assert.match(reviewDialog, /确认文案达标并进入后续流程？/u);
  assert.match(reviewDialog, /提交审核结果/u);
  assert.match(reviewDialog, /确认返工文案达标并提交强制复检？/u);
  assert.match(reviewDialog, /提交强制复检/u);
  assert.match(reviewDialog, /系统将最终稿记录为 3 分并提交强制复检；复检通过后才会进入待生图队列/u);
  assert.match(reviewDialog, /按任务策略进入文案抽检或待生图队列/u);
  assert.doesNotMatch(reviewDialog, /审核通过并开始生图|确认文案达标并开始生图/u);
  assert.match(reviewDialog, /href=\{apiPath\(`\/v1\/tasks\/\$\{detail\.id\}\/archive`\)\}/u);
  assert.match(reviewDialog, /<Download size=\{14\} \/>下载资源/u);
  assert.doesNotMatch(reviewDialog, /approve-delivery|提交图文审核/u);
  assert.match(workbench, /Query 关键词或 #ID/u);
  assert.match(workbench, /TASK_SORT_OPTIONS\.map/u);
  assert.match(workbench, /search\.set\('sortBy', sortBy\)/u);
  assert.match(workbench, /search\.set\('sortOrder', sortOrder\)/u);
  assert.match(workbench, /search\.set\('taskId', String\(searchedTaskId\)\)/u);
  assert.match(workbench, /创建 \/ 开始 \/ 耗时/u);
  assert.match(workbench, /按 Query 去重/u);
  assert.match(workbench, /去重后 \$\{total\} 个 Query/u);
  assert.match(workbench, /search\.set\('deduplicateQuery', 'true'\)/u);
  assert.match(workbench, /includeTotal: 'true'/u);
  assert.match(workbench, /Array\.isArray\(rawTaskPage\)/u);
  assert.match(workbench, /caught\.message !== 'task state filter is invalid'/u);
  assert.match(workbench, /compatibilitySearch\.set\('mine', 'true'\)/u);
  assert.match(workbench, /compatibilityTasks\s*\?\?/u);
  assert.match(workbench, /matchesWorkbenchView\(task, view, creatorUserId, creatorAccountId\)/u);
  assert.match(workbench, /sort\(\(left, right\) => compareTasks\(left, right, sort\)\)/u);
  assert.match(workbench, /workbench-pagination/u);
  assert.match(workbench, />重试<\/Button>/u);
  assert.match(workbench, />废弃<\/Button>/u);
  assert.match(workbench, />审核<\/Button>/u);
  assert.match(workbench, />查看<\/Button>/u);
  assert.match(workbench, /\/v1\/tasks\/\$\{task\.id\}\/cancel/u);
  assert.match(workbench, /STAGE_LABELS\[task\.currentStage\] \?\? STATE_LABELS\[task\.state\]/u);
  assert.doesNotMatch(workbench, /\{task\.currentStage \|\| STATE_LABELS/u);
  assert.doesNotMatch(reviewDialog, /\{detail\.currentStage \?\? '尚未开始'\}/u);
  // Compare layouts internally while keeping raw image-plan JSON out of the rendered review.
  assert.doesNotMatch(reviewDialog.slice(reviewDialog.indexOf('return <Dialog')), /JSON\.stringify\(.*imagePlan/u);
  assert.match(styles, /\.workbench-review-dialog\s*\{/u);
});

test('task detail keeps image review after copy and before planning', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');
  const headings = ['标题、正文与标签', '图片审核', '图片文案规划'];
  const positions = headings.map((heading) => source.indexOf(`<h3>${heading}</h3>`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(source.match(/<h3>图片审核<\/h3>/gu)?.length, 1);
  // Editing, role restrictions, validation, and responsive layout are exercised
  // with the real component and in-memory API in scripts/test-task-review.mjs.
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
