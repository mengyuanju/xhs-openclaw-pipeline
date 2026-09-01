import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('review center HTTP and UI contracts', () => {
  it('accepts an account name at login while retaining the administrator path', async () => {
    const [form, route] = await Promise.all([
      source('app/login/login-form.tsx'),
      source('app/api/auth/login/route.ts'),
    ]);

    assert.match(form, /name="username"/u);
    assert.match(form, /autoComplete="username"/u);
    assert.match(route, /attemptReviewUserLogin/u);
    assert.match(route, /username === 'admin'/u);
  });

  it('exposes strictly validated people and work item routes with role allowlists', async () => {
    const routes = await Promise.all([
      source('app/api/review-users/route.ts'),
      source('app/api/review-users/[id]/route.ts'),
      source('app/api/review-work-items/route.ts'),
      source('app/api/review-work-items/[id]/assignments/route.ts'),
      source('app/api/review-work-items/[id]/claims/route.ts'),
      source('app/api/review-work-items/[id]/decisions/route.ts'),
    ]);
    const combined = routes.join('\n');

    assert.match(combined, /\.strict\(\)/u);
    assert.match(combined, /QUERY_REVIEWER/u);
    assert.match(combined, /COPY_REVIEWER/u);
    assert.match(combined, /QC_LEAD/u);
    assert.match(combined, /expectedVersion/u);
    assert.doesNotMatch(combined, /passwordHash.*ok\(/u);
  });

  it('adds a role-aware review center with useful empty and action states', async () => {
    const [sideNav, topbar, page, workbench, detail, decisionForm, peoplePage, serverSession] = await Promise.all([
      source('app/components/side-nav.tsx'),
      source('app/components/app-topbar.tsx'),
      source('app/reviews/page.tsx'),
      source('app/reviews/review-workbench.tsx'),
      source('app/reviews/[id]/page.tsx'),
      source('app/reviews/[id]/review-decision-form.tsx'),
      source('app/reviews/people/page.tsx'),
      source('app/server-session.ts'),
    ]);
    const combined = [page, workbench, detail, decisionForm, peoplePage].join('\n');

    assert.match(sideNav, /href: '\/reviews'/u);
    assert.match(sideNav, /质检中心/u);
    assert.match(topbar, /pathname\.startsWith\('\/reviews'\)/u);
    assert.match(combined, /我的待办/u);
    assert.match(combined, /生成质检单/u);
    assert.match(combined, /领取/u);
    assert.match(combined, /提交审核结论/u);
    assert.match(combined, /还没有符合条件的质检作业/u);
    assert.match(combined, /质检人员/u);
    assert.match(combined, /aria-live/u);
    assert.match(workbench, /from '@\/components\/ui\/select'/u);
    assert.doesNotMatch(workbench, /<select\b/u);
    assert.match(workbench, /review-pagination/u);
    assert.match(workbench, /canQuery/u);
    assert.match(workbench, /canCopy/u);
    assert.match(serverSession, /withAuthorizedReviewStore/u);
    assert.match(serverSession, /error\.status === 401/u);
  });

  it('allocates production work by task count and keeps copy and image review in one detail', async () => {
    const [
      listRoute,
      allocationRoute,
      reassignmentRoute,
      stageDecisionRoute,
      assetRoute,
      page,
      workbench,
      detail,
      stageForm,
    ] = await Promise.all([
      source('app/api/review-task-assignments/route.ts'),
      source('app/api/review-task-assignments/allocations/route.ts'),
      source('app/api/review-task-assignments/[id]/reassignments/route.ts'),
      source('app/api/review-task-assignments/[id]/stage-decisions/route.ts'),
      source('app/api/review-task-assignments/[id]/assets/[assetId]/route.ts'),
      source('app/reviews/page.tsx'),
      source('app/reviews/review-workbench.tsx'),
      source('app/reviews/tasks/[id]/page.tsx'),
      source('app/reviews/tasks/[id]/stage-decision-form.tsx'),
    ]);
    const routes = [listRoute, allocationRoute, reassignmentRoute, stageDecisionRoute].join('\n');
    const ui = [page, workbench, detail, stageForm].join('\n');

    assert.match(routes, /\.strict\(\)/u);
    assert.match(allocationRoute, /count: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/u);
    assert.match(allocationRoute, /allocateReviewTasks/u);
    assert.match(reassignmentRoute, /expectedVersion/u);
    assert.match(stageDecisionRoute, /z\.enum\(\['COPY', 'IMAGE'\]\)/u);
    assert.match(stageDecisionRoute, /decideReviewTaskStage/u);
    assert.match(assetRoute, /authorizeReviewTaskAsset/u);
    assert.match(assetRoute, /relative\(root, path\)/u);
    assert.match(assetRoute, /isAbsolute\(relation\)/u);
    assert.match(ui, /按任务条数分配/u);
    assert.match(ui, /内容质检员（文案\+图片）/u);
    assert.match(ui, /文案审核/u);
    assert.match(ui, /图片审核/u);
    assert.match(detail, /currentAssets/u);
    assert.match(stageForm, /COPY/u);
    assert.match(stageForm, /IMAGE/u);
    assert.match(stageForm, /const canApprove/u);
    assert.match(stageForm, /disabled=\{!canApprove\}/u);
    assert.match(ui, /需重新审核/u);
    assert.doesNotMatch(workbench, /<SelectItem value="COPY">文案质检<\/SelectItem>/u);
  });
});
