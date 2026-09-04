import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('mobile navigation stays compact and exposes the active page', async () => {
  const [navigation, styles] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(navigation, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(navigation, /aria-expanded=\{isMenuOpen\}/);
  assert.match(navigation, /aria-controls="primary-navigation"/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.nav-list\[data-open="true"\] \{ display: grid/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.nav-group-items \{[^}]*grid-template-columns: repeat\(2/);
});

test('application shell groups product areas and keeps page context visible', async () => {
  const [frame, navigation, topbar, styles, packageJson] = await Promise.all([
    readFile(projectFile('app/components/app-frame.tsx'), 'utf8'),
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-topbar.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('package.json'), 'utf8'),
  ]);

  assert.match(frame, /<AppTopbar\s*\/>/);
  assert.match(frame, /id="main-content"/);
  assert.match(navigation, /const navigationGroups[^=]*= \[/);
  for (const group of ['创作工作台', '内容生产', '内容资产', '运营与系统']) {
    assert.match(navigation, new RegExp(`label: '${group}'`));
  }
  assert.match(navigation, /aria-label="切换主导航"/);
  assert.match(navigation, /aria-expanded=\{isMenuOpen\}/);
  assert.match(topbar, /const routeMeta/);
  assert.match(topbar, /aria-label="当前位置"/);
  assert.match(topbar, /aria-current="page"/);
  assert.doesNotMatch(topbar, /本地工作区|导入选题|topbar-actions/);
  assert.match(navigation, /roleGroups\.filter\(\(group\) => !group.hidden/u);
  for (const group of ['内容生产', '质检作业']) {
    assert.match(navigation, new RegExp(`label: '${group}',\\s+hidden: true`));
  }
  assert.match(styles, /\.app-workspace\s*\{/);
  assert.match(styles, /\.app-topbar\s*\{/);
  assert.match(styles, /\.skip-link\s*\{/);
  assert.match(packageJson, /"lucide-react"/);
});

test('the unified knowledge base remains grouped with reusable content assets', async () => {
  const navigation = await readFile(projectFile('app/components/side-nav.tsx'), 'utf8');

  assert.match(navigation, /label: '内容资产',[\s\S]*href: '\/prompts'[\s\S]*href: '\/knowledge'/);
  assert.ok(navigation.indexOf("href: '/prompts'") < navigation.indexOf("href: '/knowledge'"));
  assert.ok(navigation.indexOf("href: '/knowledge'") < navigation.indexOf("href: '/analytics'"));
});

test('primary section pages omit visible display headlines while keeping an accessible page name', async () => {
  const sectionPages = [
    ['app/page.tsx', '工作台'],
    ['app/imports/page.tsx', '选题导入'],
    ['app/prompts/page.tsx', '提示词'],
    ['app/tasks/page.tsx', '内容审核'],
    ['app/analytics/page.tsx', '数据统计'],
    ['app/settings/page.tsx', '生产配置'],
    ['app/knowledge/page.tsx', '知识库'],
  ];

  for (const [path, accessibleName] of sectionPages) {
    const page = await readFile(projectFile(path), 'utf8');
    assert.match(page, new RegExp(`<h1 className="sr-only">${accessibleName}<\\/h1>`));
    assert.doesNotMatch(page, /<h1(?! className="sr-only")/);
  }
});

test('task rows provide readable mobile card labels instead of narrow table columns', async () => {
  const [tasksPage, taskDetail, taskTiming, taskRefresh, styles] = await Promise.all([
    readFile(projectFile('app/tasks/page.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/page.tsx'), 'utf8'),
    readFile(projectFile('app/components/task-timing.tsx'), 'utf8'),
    readFile(projectFile('app/components/task-progress-refresh.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(tasksPage, /className="table-wrap mobile-cards task-table-wrap"/);
  for (const label of ['ID', '选题', '外部 ID', '图片数', '生成状态', '审核状态', '耗时']) {
    assert.match(tasksPage, new RegExp(`data-label="${label}"`));
  }
  assert.match(tasksPage, /TaskTiming/);
  assert.match(tasksPage, /TaskProgressRefresh/);
  assert.match(taskDetail, /TaskTiming/);
  assert.match(taskDetail, /TaskProgressRefresh/);
  assert.match(taskDetail, /getAdjacentTaskIds/);
  assert.match(taskDetail, /aria-label="审核题目导航"/);
  assert.match(taskDetail, />上一题<\/Link>/);
  assert.match(taskDetail, />下一题<\/Link>/);
  assert.match(taskDetail, />上一题<\/button>/);
  assert.match(taskDetail, />下一题<\/button>/);
  assert.match(taskDetail, /href=\{`\/tasks\/\$\{adjacent\.previousTaskId\}`\}/);
  assert.match(taskDetail, /href=\{`\/tasks\/\$\{adjacent\.nextTaskId\}`\}/);
  assert.match(taskTiming, /实际用时/);
  assert.match(taskTiming, /预计还需/);
  assert.match(taskTiming, /排队第/);
  assert.match(taskTiming, /首条完成后自动估算/);
  assert.match(taskTiming, /aria-live="off"/);
  assert.match(taskRefresh, /router\.refresh\(\)/);
  assert.match(taskRefresh, /document\.visibilityState/);
  assert.match(tasksPage, /自动 3–5/);
  assert.match(styles, /\.task-review-nav/);
});

test('task review stays scoped to one import batch across filters and navigation', async () => {
  const [tasksPage, taskDetail, tasksRoute] = await Promise.all([
    readFile(projectFile('app/tasks/page.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/page.tsx'), 'utf8'),
    readFile(projectFile('app/api/tasks/route.ts'), 'utf8'),
  ]);

  assert.match(tasksPage, /listImportBatches/);
  assert.match(tasksPage, /importBatchId: selectedBatchId/);
  assert.match(tasksPage, /<Select name="batchId"/);
  assert.match(tasksPage, /<SelectTrigger id="batchId"/);
  assert.match(tasksPage, /任务批次/);
  assert.match(tasksPage, /query\.set\('batchId', String\(selectedBatchId\)\)/);
  assert.match(tasksPage, /href=\{`\/tasks\/\$\{task\.id\}`\}/);
  assert.doesNotMatch(tasksPage, /<option value="">全部任务<\/option>/);
  assert.match(taskDetail, /task\.config\.importBatchId/);
  assert.match(tasksRoute, /importBatchId: url\.searchParams\.get\('batchId'\)/);
});

test('dashboard and import tables use the same readable mobile card treatment', async () => {
  const [dashboard, importsPage, importWorkbench, demandScreening] = await Promise.all([
    readFile(projectFile('app/page.tsx'), 'utf8'),
    readFile(projectFile('app/imports/page.tsx'), 'utf8'),
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/imports/demand-screening-panel.tsx'), 'utf8'),
  ]);

  assert.match(dashboard, /className="table-wrap mobile-cards"/);
  assert.match(importsPage, /className="table-wrap mobile-cards"/);
  assert.match(demandScreening, /className="table-wrap mobile-cards screening-table-wrap"/);
  assert.match(dashboard, /data-label="审核"/);
  assert.match(importsPage, /data-label="创建时间"/);
  assert.match(demandScreening, /data-label="结构校验"/);
});

test('dashboard prioritizes actionable production queues over a demo workflow', async () => {
  const [dashboard, styles, card] = await Promise.all([
    readFile(projectFile('app/page.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('components/ui/card.tsx'), 'utf8'),
  ]);

  assert.match(dashboard, /className="dashboard-overview"/);
  assert.match(dashboard, /className="dashboard-attention-list"/);
  assert.match(dashboard, /需要处理/);
  assert.match(dashboard, /href: '\/tasks\?reviewStatus=WAITING_REVIEW'/);
  assert.match(dashboard, /href="\/imports"/);
  assert.match(dashboard, /dashboard-metric-card/);
  assert.match(dashboard, /<Card/);
  assert.doesNotMatch(dashboard, /标准生产流/);
  assert.match(styles, /\.dashboard-attention-item\s*\{/);
  assert.match(styles, /\.dashboard-metric-icon\s*\{/);
  assert.match(card, /data-slot="card"/);
});

test('task center separates batch context, filters, and result operations', async () => {
  const [tasksPage, styles] = await Promise.all([
    readFile(projectFile('app/tasks/page.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(tasksPage, /className="tasks-command-header"/);
  assert.match(tasksPage, /className="tasks-context-grid"/);
  assert.match(tasksPage, /className="tasks-filter-panel"/);
  assert.match(tasksPage, /className="tasks-filter-grid"/);
  assert.match(tasksPage, /className="tasks-result-header"/);
  assert.match(tasksPage, /当前筛选/);
  assert.match(tasksPage, /可批量导出/);
  assert.match(styles, /\.tasks-context-grid\s*\{/);
  assert.match(styles, /\.tasks-filter-grid\s*\{/);
  assert.match(styles, /\.tasks-result-header\s*\{/);
});

test('Excel import exposes demand screening as a required step before queue commit', async () => {
  const [importWorkbench, demandScreening, demandRules] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/imports/demand-screening-panel.tsx'), 'utf8'),
    readFile(projectFile('app/imports/demand-screening-rules.tsx'), 'utf8'),
  ]);
  const importFlow = `${importWorkbench}\n${demandScreening}\n${demandRules}`;

  assert.match(importFlow, /需求强度筛选/);
  assert.match(importFlow, /强需/);
  assert.match(importFlow, /中需/);
  assert.match(importFlow, /弱需/);
  assert.match(importFlow, /无需/);
  assert.match(importFlow, /pendingScreeningRows/);
  assert.match(importFlow, /保存筛选结果/);
  assert.match(importFlow, /筛选未完成/);
  assert.match(importWorkbench, /OpenClaw 检测中/);
  assert.match(demandScreening, /screeningSource/);
  assert.match(demandScreening, /screeningModel/);
  assert.match(importWorkbench, /setMessageIsError\(true\)/);
  assert.doesNotMatch(importWorkbench, /const messageIsError = message\.includes/);
});

test('Excel import focuses one progressive step at a time instead of expanding the full workflow', async () => {
  const [importsPage, importWorkbench, flowPresentation, demandScreening, styles] = await Promise.all([
    readFile(projectFile('app/imports/page.tsx'), 'utf8'),
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/imports/import-flow-presentation.tsx'), 'utf8'),
    readFile(projectFile('app/imports/demand-screening-panel.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);
  const importFlow = `${importWorkbench}\n${flowPresentation}`;

  assert.match(importFlow, /type ImportFlowStep = 1 \| 2 \| 3 \| 4/);
  assert.match(importWorkbench, /aria-label="Excel 导入流程"/);
  assert.match(flowPresentation, /aria-expanded=\{isActive\}/);
  assert.match(flowPresentation, /aria-current=\{isActive \? 'step' : undefined\}/);
  assert.match(flowPresentation, /isActive && <div className="import-flow-step-body">/);
  assert.match(importWorkbench, /scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\)/);
  assert.match(importWorkbench, /onComplete=\{\(\) => \{[\s\S]*?setActiveStep\(3\)/);
  assert.match(importWorkbench, /available=\{Boolean\(committed \|\| \(batch && screeningComplete && activeStep >= 3\)\)\}/);
  assert.match(importWorkbench, /setActiveStep\(4\)/);
  assert.match(demandScreening, /dirtyRowIds\.size === 0 && pendingScreeningRows === 0/);
  assert.match(demandScreening, /确认复核，下一步/);
  assert.match(importsPage, /<details className="panel recent-imports-disclosure" open=\{!initialBatch\}>/);
  assert.match(styles, /\.import-flow-step\.is-active/);
  assert.match(styles, /\.import-flow-step-body \.screening-panel\s*\{[^}]*max-height: calc\(100vh -/);
  assert.match(styles, /\.import-flow-step-body \.screening-table-wrap\s*\{[^}]*overflow: auto/);
});

test('Excel step switches settle before paint without a second smooth scroll', async () => {
  const importWorkbench = await readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8');

  assert.match(importWorkbench, /useLayoutEffect\(\(\) => \{/);
  assert.match(importWorkbench, /scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\)/);
  assert.doesNotMatch(importWorkbench, /requestAnimationFrame/);
  assert.doesNotMatch(importWorkbench, /behavior:\s*'smooth'|\?\s*'auto'\s*:\s*'smooth'/);
});

test('file uploads use the branded, keyboard-focusable control', async () => {
  const [importWorkbench, knowledgeWorkbench, styles] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(importWorkbench, /id="excel-file" className="input file-input"/);
  assert.match(knowledgeWorkbench, /className="input file-input" id="knowledge-image"/);
  assert.match(styles, /\.file-input::file-selector-button\s*\{/);
  assert.match(styles, /\.file-input:focus-visible\s*\{/);
});

test('review decision appears before the image-heavy editor on narrow screens', async () => {
  const [reviewPanel, imageBatch] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
  ]);
  const reviewFlow = `${reviewPanel}\n${imageBatch}`;
  const decisionIndex = reviewPanel.indexOf('review-decision');
  const assetsIndex = reviewPanel.indexOf('review-assets');

  assert.ok(decisionIndex >= 0, 'review decision needs a stable layout class');
  assert.ok(assetsIndex >= 0, 'image editor needs a stable layout class');
  assert.ok(decisionIndex < assetsIndex, 'review decision must precede the image editor in source order');
  assert.doesNotMatch(reviewPanel, /<button(?![^>]*type=)[^>]*onClick=/);
  assert.match(reviewPanel, /alignmentStatus/);
  assert.match(reviewFlow, /ocrConfidence/);
  assert.match(reviewPanel, /完整图集均通过当前文案版本的图文匹配验收/);
  assert.match(reviewPanel, /qualityScoreLabel/);
  assert.match(reviewPanel, /失败预览/);
  assert.match(reviewPanel, /不可审批.*不可作为正式交付导出/su);
  assert.match(reviewPanel, /3 分 · 优质/);
  assert.match(reviewFlow, /自动 3–5 张/);
});

test('review images version their URLs with the immutable asset content hash', async () => {
  const imageBatch = await readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8');

  assert.match(imageBatch, /\/api\/assets\/\$\{asset\.id\}\?v=\$\{asset\.sha256\}/);
});

test('task details display per-run user prompts and the generated visual plan', async () => {
  const [taskDetail, imageBatch, promptTrace, imagePromptPresentation, visualPlanTrace, styles] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/page.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/generation-prompt-trace.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-prompt-presentation.mjs'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/generation-visual-plan.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);
  const promptDisplay = `${imageBatch}\n${promptTrace}\n${visualPlanTrace}`;

  assert.match(promptDisplay, /文案用户提示词/);
  assert.match(promptDisplay, /第 \$\{prompt\.pageIndex\} 张图片用户提示词/);
  assert.match(promptTrace, /summarizeImagePrompt/);
  assert.match(promptTrace, /className="image-prompt-summary"/);
  assert.match(promptTrace, /视觉主体/);
  assert.match(promptTrace, /构图与阅读顺序/);
  assert.match(promptTrace, /页面可见文字/);
  assert.match(promptTrace, /必须呈现/);
  assert.match(promptTrace, /避免出现/);
  assert.doesNotMatch(promptTrace, /content=\{prompt\.content\}/);
  assert.match(imagePromptPresentation, /current_image_plan/);
  assert.match(promptDisplay, /run\?\.promptTrace/);
  assert.match(promptDisplay, /contentKind !== 'USER_PROMPT'/);
  assert.match(promptDisplay, /imagePrompts\.map/);
  assert.doesNotMatch(promptDisplay, /content=\{config\?\.textPromptContent\}/);
  assert.doesNotMatch(promptDisplay, /content=\{config\?\.imagePromptContent\}/);
  assert.match(promptDisplay, /历史批次未单独保存用户提示词/);
  assert.doesNotMatch(promptDisplay, /系统模板 v#/);
  assert.doesNotMatch(imageBatch, /<dt>文本提示词<\/dt>/);
  assert.doesNotMatch(imageBatch, /<dt>图片提示词<\/dt>/);
  assert.match(imageBatch, /查看本批次用户提示词/);
  assert.match(imageBatch, /查看本批次 VisualPlan/);
  assert.match(imageBatch, /<VisualPlanTrace visualPlan=\{run\?\.visualPlan\}/);
  assert.match(visualPlanTrace, /JSON\.stringify\(visualPlan, null, 2\)/);
  assert.match(visualPlanTrace, /历史批次未保存 VisualPlan/);
  assert.match(visualPlanTrace, /aria-label="本批次 VisualPlan 完整内容"/);
  assert.match(taskDetail, /attachGenerationVisualPlans/);
  assert.match(promptDisplay, /className="prompt-content"/);
  assert.match(promptDisplay, /aria-label=\{`\$\{label\}完整内容`\}/);
  assert.match(styles, /\.prompt-content\s*\{/);
  assert.match(styles, /\.prompt-content\s*\{[^}]*overflow: auto/);
  assert.match(styles, /\.prompt-content\s*\{[^}]*white-space: pre-wrap/);
  assert.match(styles, /\.image-prompt-summary\s*\{/);
});

test('generation batches display Query and post-generation text review evidence', async () => {
  const [imageBatch, stageReviews] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/generation-stage-reviews.tsx'), 'utf8'),
  ]);

  assert.match(imageBatch, /<StageReviewTrace stageReviews=\{run\?\.stageReviews\}/u);
  assert.match(imageBatch, /查看 Query 与文本审核/u);
  assert.match(stageReviews, /Query 审核/u);
  assert.match(stageReviews, /文本生成后审核/u);
  assert.match(stageReviews, /历史批次未保存阶段审核结果/u);
  assert.match(stageReviews, /OPENCLAW/u);
  assert.match(stageReviews, /MOCK/u);
  assert.match(stageReviews, /BLOCKING/u);
});

test('review workbench exposes latest research links, readable prompts and stage reviews together', async () => {
  const [reviewPanel, evidencePanel, promptTrace, styles] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/generation-evidence-panel.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/generation-prompt-trace.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(reviewPanel, /<GenerationEvidencePanel run=\{latestRun\}/u);
  assert.match(evidencePanel, /生成依据与自动审核/u);
  assert.match(evidencePanel, /文案资料来源/u);
  assert.match(evidencePanel, /不代表每条都被最终文案引用/u);
  assert.match(evidencePanel, /target="_blank"/u);
  assert.match(evidencePanel, /rel="noopener noreferrer"/u);
  assert.match(evidencePanel, /<StageReviewTrace stageReviews=\{run\?\.stageReviews\}/u);
  assert.match(evidencePanel, /<PromptTrace run=\{run\}/u);
  assert.match(promptTrace, /summarizeTextPrompt/u);
  assert.match(promptTrace, /className="text-prompt-summary"/u);
  assert.match(promptTrace, /查看原始提示词/u);
  assert.doesNotMatch(promptTrace, /content=\{promptTrace\.text\?\.content\}/u);
  assert.match(styles, /\.generation-evidence-panel\s*\{/u);
  assert.match(styles, /\.research-source-link\s*\{/u);
  assert.match(styles, /\.text-prompt-summary\s*\{/u);
});

test('waiting and approved reviews expose ZIP downloads while blocked states explain why', async () => {
  const [taskDetail, reviewPanel] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/page.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
  ]);

  assert.match(taskDetail, /getTaskExportAvailability/);
  assert.match(reviewPanel, /exportAvailability\.canExport/);
  assert.match(reviewPanel, /href=\{`\/api\/tasks\/\$\{task\.id\}\/export`\}/);
  assert.match(reviewPanel, /download=\{`xhs-task-\$\{task\.id\}\.zip`\}/);
  assert.match(reviewPanel, />导出交付包<\/a>/);
  assert.match(reviewPanel, /aria-describedby="task-export-reason"/);
  assert.match(reviewPanel, /暂不可导出：\{exportAvailability\.reason\}/);
  assert.match(reviewPanel, /待审核和已通过任务均可下载/);
});

test('task rows enable eligible ZIP downloads and show a visible reason when blocked', async () => {
  const tasksPage = await readFile(projectFile('app/tasks/page.tsx'), 'utf8');

  assert.match(tasksPage, /getTaskExportAvailability/);
  assert.match(tasksPage, /task\.exportAvailability\.canExport/);
  assert.match(tasksPage, /href=\{`\/api\/tasks\/\$\{task\.id\}\/export`\}/);
  assert.match(tasksPage, /download=\{`xhs-task-\$\{task\.id\}\.zip`\}/);
  assert.match(tasksPage, />导出 ZIP<\/a>/);
  assert.match(tasksPage, /aria-describedby=\{`task-export-reason-\$\{task\.id\}`\}/);
  assert.match(tasksPage, /不可导出：\{task\.exportAvailability\.reason\}/);
});

test('task list supports accessible selection and one-file batch export', async () => {
  const [tasksPage, batchExport, styles, route] = await Promise.all([
    readFile(projectFile('app/tasks/page.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/task-batch-export-form.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('app/api/task-exports/route.ts'), 'utf8'),
  ]);

  assert.match(tasksPage, /import \{ TaskBatchExportForm \}/);
  assert.match(tasksPage, /<TaskBatchExportForm exportableCount=/);
  assert.match(tasksPage, /name="taskId"/);
  assert.match(tasksPage, /aria-label=\{`选择任务 #\$\{task\.id\}`\}/);
  assert.match(tasksPage, /disabled=\{!task\.exportAvailability\.canExport\}/);
  assert.match(batchExport, /^'use client';/);
  assert.match(batchExport, /处于待审核或已通过状态、且交付文件完整/);
  assert.match(batchExport, /全选本页可导出任务/);
  assert.match(batchExport, /已选 \{selectedTaskIds\.length\} 条/);
  assert.match(batchExport, /batch-export-guidance/);
  assert.match(batchExport, /请先勾选至少 1 条可导出任务/);
  assert.match(batchExport, /fetch\('\/api\/task-exports'/);
  assert.match(batchExport, /URL\.createObjectURL/);
  assert.match(batchExport, /aria-live="polite"/);
  assert.match(styles, /\.batch-export-toolbar/);
  assert.match(styles, /\.batch-export-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(styles, /\.batch-export-guidance[^}]*flex-basis:\s*auto/);
  assert.match(route, /MAX_BATCH_EXPORT_TASKS/);
  assert.match(route, /maxBytes: 4 \* 1024/);
  assert.match(route, /'Cache-Control': 'private, no-store'/);
});

test('generated assets open in an accessible centered Radix dialog preview', async () => {
  const [preview, imageBatch, dialog, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
    readFile(projectFile('components/ui/dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(preview, /export function ImagePreview/);
  assert.match(preview, /type="button"/);
  assert.match(preview, /<Dialog open=/);
  assert.match(preview, /<DialogContent/);
  assert.match(preview, /<DialogTitle/);
  assert.doesNotMatch(preview, /<dialog|showModal\(\)/);
  assert.match(preview, /aria-label="关闭图片预览"/);
  assert.match(preview, /预览与调整/);
  assert.match(imageBatch, /import \{ ImagePreview \}/);
  assert.match(imageBatch, /src=\{`\/api\/assets\/\$\{asset\.id\}\?v=\$\{asset\.sha256\}`\}/);
  assert.match(dialog, /@radix-ui\/react-dialog/);
  assert.match(dialog, /fixed inset-0/);
  assert.match(dialog, /left-1\/2 top-1\/2/);
  assert.match(dialog, /-translate-x-1\/2 -translate-y-1\/2/);
  assert.match(styles, /\.image-preview-dialog/);
  assert.doesNotMatch(styles, /\.dialog-content\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.doesNotMatch(styles, /\.confirm-dialog-content\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.match(styles, /\.image-preview-full/);
});

test('application dropdowns use the shared Radix select instead of native selects', async () => {
  const paths = [
    'app/tasks/page.tsx',
    'app/imports/demand-screening-panel.tsx',
    'app/knowledge/knowledge-workbench.tsx',
    'app/settings/production-settings-form.tsx',
  ];
  const [select, styles, ...screens] = await Promise.all([
    readFile(projectFile('components/ui/select.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    ...paths.map((path) => readFile(projectFile(path), 'utf8')),
  ]);

  assert.match(select, /@radix-ui\/react-select/);
  assert.match(select, /SelectPrimitive\.Portal/);
  assert.match(select, /SelectPrimitive\.Viewport/);
  assert.match(select, /SelectPrimitive\.ItemIndicator/);
  assert.match(styles, /\.select-trigger\s*\{[^}]*min-width:\s*0/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.select-trigger[^{}]*\.select-content[^{}]*\.dialog-overlay[^{}]*\.dialog-content[^{}]*\.confirm-dialog-content\s*\{[^}]*animation:\s*none/s,
  );
  for (const screen of screens) {
    assert.doesNotMatch(screen, /<select/);
    assert.match(screen, /<Select/);
    assert.match(screen, /<SelectTrigger/);
    assert.match(screen, /<SelectContent/);
  }
});

test('confirmation prompts use one accessible Radix alert dialog provider', async () => {
  const paths = [
    'app/knowledge/knowledge-workbench.tsx',
    'app/tasks/[id]/review-panel.tsx',
    'app/tasks/[id]/retry-button.tsx',
    'app/imports/import-workbench.tsx',
    'app/imports/queue-generation-panel.tsx',
    'app/prompts/prompt-editor.tsx',
  ];
  const [confirmation, frame, ...screens] = await Promise.all([
    readFile(projectFile('components/ui/confirm-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-frame.tsx'), 'utf8'),
    ...paths.map((path) => readFile(projectFile(path), 'utf8')),
  ]);

  assert.match(confirmation, /@radix-ui\/react-alert-dialog/);
  assert.match(confirmation, /export function ConfirmDialogProvider/);
  assert.match(confirmation, /export function useConfirmDialog/);
  assert.match(confirmation, /<AlertDialogPrimitive\.Title/);
  assert.match(confirmation, /<AlertDialogPrimitive\.Description/);
  assert.match(confirmation, /returnFocusRef/);
  assert.match(confirmation, /requestAnimationFrame/);
  assert.match(frame, /<ConfirmDialogProvider>/);
  for (const screen of screens) {
    assert.doesNotMatch(screen, /window\.confirm/);
    assert.match(screen, /useConfirmDialog/);
  }
});

test('reviewers can switch image previews between 100 percent and full-image modes', async () => {
  const [preview, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(preview, /type PreviewMode = 'actual' \| 'fit'/);
  assert.match(preview, /useState<PreviewMode>\('actual'\)/);
  assert.match(preview, /aria-label="图片显示模式"/);
  assert.match(preview, />100% 查看</);
  assert.match(preview, />完整显示</);
  assert.match(preview, /aria-pressed=\{viewMode === 'fit'\}/);
  assert.match(preview, /disabled=\{viewMode === 'fit'\}/);
  assert.match(styles, /\.image-preview-viewport\.is-fit/);
  assert.match(styles, /\.image-preview-full\.is-fit[^}]*object-fit:\s*contain/s);
});

test('image previews navigate within a batch and keep fitted landscape images geometrically centered', async () => {
  const [preview, imageBatch, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(imageBatch, /useState<number \| null>\(null\)/);
  assert.match(imageBatch, /isOpen=\{activeAssetIndex === assetIndex\}/);
  assert.match(imageBatch, /onPrevious=\{assetIndex > 0/);
  assert.match(imageBatch, /onNext=\{assetIndex < batch\.assets\.length - 1/);
  assert.match(preview, /aria-label="上一张图片"/);
  assert.match(preview, /aria-label="下一张图片"/);
  assert.match(preview, /\{position\} \/ \{total\}/);
  assert.match(preview, /className=\{`image-preview-stage/);
  assert.match(styles, /\.image-preview-stage\.is-fit\s*\{[^}]*place-items:\s*unsafe center/s);
  assert.match(styles, /\.image-preview-stage\.is-fit\s*\{[^}]*grid-template:\s*minmax\(0, 1fr\) \/ minmax\(0, 1fr\)/s);
  assert.match(styles, /\.image-preview-full\.is-fit\s*\{[^}]*width:\s*auto[^}]*height:\s*auto[^}]*margin:\s*0/s);
  assert.match(styles, /\.image-preview-full\.is-fit\.is-quarter-turn\s*\{[^}]*max-width:\s*100cqh[^}]*max-height:\s*100cqw/s);
});

test('review workbench prioritizes full text and generation batches without standalone history panels', async () => {
  const [reviewPanel, reviewCopy, imageBatch, qualityIssues, styles] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/review-copy-form.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/quality-issue-list.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);
  const reviewFlow = `${reviewPanel}\n${reviewCopy}\n${imageBatch}`;

  assert.match(reviewCopy, /className="textarea review-copy-textarea"/);
  assert.match(styles, /\.review-copy-textarea\s*\{[^}]*field-sizing: content/);
  assert.match(reviewPanel, /buildImageBatches/);
  assert.match(reviewFlow, /image-generation-batch/);
  assert.match(reviewPanel, /qualityReasons/);
  assert.match(reviewPanel, /评分原因/);
  assert.match(reviewPanel, /<QualityIssueList issues=\{currentIssues\}/);
  assert.match(imageBatch, /<QualityIssueList issues=\{issues\}/);
  assert.match(qualityIssues, /问题标签会按严重度限制最终分/);
  assert.match(qualityIssues, /详细原因/);
  assert.match(qualityIssues, /最终分最高 \{issue\.scoreCap\} 分/);
  assert.match(styles, /\.quality-issue-severity/);
  assert.match(styles, /\.quality-issue-reason/);
  assert.match(imageBatch, /compact-failed-batch/);
  assert.doesNotMatch(reviewPanel, /<h3>版本记录<\/h3>/);
  assert.doesNotMatch(reviewPanel, /<h3>生成与质检<\/h3>/);
  assert.doesNotMatch(reviewPanel, /<h3>固定生产配置<\/h3>/);
});

test('review workbench separates copy, evidence and images into focused review stages', async () => {
  const [reviewPanel, styles] = await Promise.all([
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(reviewPanel, /type ReviewStage = 'copy' \| 'evidence' \| 'images'/u);
  assert.match(reviewPanel, /useState<ReviewStage>\('copy'\)/u);
  assert.match(reviewPanel, /role="tablist"/u);
  assert.match(reviewPanel, /aria-label="审核内容分区"/u);
  assert.match(reviewPanel, /文案定稿/u);
  assert.match(reviewPanel, /生成依据/u);
  assert.match(reviewPanel, /图片审核/u);
  assert.match(reviewPanel, /role="tabpanel"/u);
  assert.match(reviewPanel, /hidden=\{activeStage !== 'copy'\}/u);
  assert.match(reviewPanel, /hidden=\{activeStage !== 'evidence'\}/u);
  assert.match(reviewPanel, /hidden=\{activeStage !== 'images'\}/u);
  assert.match(styles, /\.review-stage-nav\s*\{/u);
  assert.match(styles, /\.review-stage-tab\[aria-selected="true"\]/u);
  assert.match(styles, /\.review-stage-panel\[hidden\]/u);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.review-stage-nav\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /\.review-stage-status, \.review-stage-copy small\s*\{\s*display: none;/u);
});

test('image editing controls live in preview with local rotation and conditional crop', async () => {
  const [preview, reviewPanel, imageBatch] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/image-generation-batch.tsx'), 'utf8'),
  ]);

  assert.match(preview, /type="range"/);
  assert.match(preview, /aria-label="调整预览倍数"/);
  assert.match(preview, /setRotation/);
  assert.match(preview, /needsCrop/);
  assert.match(preview, /裁成 3:4/);
  assert.match(preview, /AI 图片修改要求/);
  assert.doesNotMatch(reviewPanel, /editImage\(asset\.id, \{ type: 'rotate'/);
  assert.match(imageBatch, /imageNeedsCrop\(asset\.width, asset\.height\)/);
});

test('interactive editors announce operation results and use explicit button behavior', async () => {
  const [importWorkbench, demandScreening, promptEditor, retryButton] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/imports/demand-screening-panel.tsx'), 'utf8'),
    readFile(projectFile('app/prompts/prompt-editor.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/retry-button.tsx'), 'utf8'),
  ]);

  assert.match(importWorkbench, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.match(promptEditor, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.match(retryButton, /role="alert"/);
  for (const source of [importWorkbench, demandScreening, promptEditor, retryButton]) {
    assert.doesNotMatch(source, /<button(?![^>]*type=)[^>]*onClick=/);
  }
});

test('prompt editors allow publishing an unchanged non-empty version', async () => {
  const promptEditor = await readFile(projectFile('app/prompts/prompt-editor.tsx'), 'utf8');

  assert.match(promptEditor, /disabled=\{busy \|\| !content\.trim\(\)\}/);
  assert.doesNotMatch(promptEditor, /content\.trim\(\) === published\?\.content/);
});

test('primary actions and small login copy meet WCAG AA text contrast', async () => {
  const styles = await readFile(projectFile('app/globals.css'), 'utf8');
  const primaryRed = styles.match(/--red:\s*(#[\da-f]{6})/i)?.[1];
  const footnote = styles.match(/\.login-story \.login-footnote \{[^}]*color:\s*(#[\da-f]{6})/i)?.[1];

  assert.ok(primaryRed, 'primary red token must be a six-digit hex color');
  assert.ok(footnote, 'login footnote must use an explicit six-digit hex color');
  assert.ok(contrastRatio(primaryRed, '#ffffff') >= 4.5, 'white primary-button text needs 4.5:1 contrast');
  assert.ok(contrastRatio(footnote, '#20201f') >= 4.5, 'small login footnote text needs 4.5:1 contrast');
});

test('the unified knowledge base exposes visual and copy modules with accessible controls', async () => {
  const [navigation, topbar, page, tabs, workbench] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-topbar.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/page.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-tabs.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
  ]);

  assert.match(navigation, /href: '\/knowledge', label: '知识库'/);
  assert.match(topbar, /pathname\.startsWith\('\/knowledge'\)[\s\S]*title: '知识库'/u);
  assert.match(page, /视觉经验与文案经验/u);
  assert.match(tabs, /role="tablist"/u);
  assert.match(tabs, /aria-selected/u);
  assert.match(tabs, /aria-controls/u);
  assert.match(workbench, /htmlFor="knowledge-image"/);
  assert.match(workbench, /PROMPT_ONLY/);
  assert.match(workbench, /IMAGE_AND_PROMPT/);
  assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.doesNotMatch(workbench, /<button(?![^>]*type=)[^>]*onClick=/);
});
