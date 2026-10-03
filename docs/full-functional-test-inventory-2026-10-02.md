# 当前系统完整功能测试清单（2026-10-02）

> 本文件是稳定功能盘点，执行结果见逐项浏览器动作审计和主报告。清单保留598个稳定ID，其中当前中心界面577项，另12项本机配置分支已经在实际ProductionSettingsForm浏览器夹具执行，9项当前页面未挂载。引用已有测试文件本身不能证明本轮通过，也不能替代浏览器动作。每项执行范围、截图、日志、数据及修复结果应关联其稳定ID。

## 范围与判定

- 主应用：`app/**/page.tsx`、实际导航、其当前挂载组件及权限分支。
- 其他用户界面：`search-lab/public/` 和 `preview-service/app/`；不能因不在主侧栏而漏测。
- 主应用认证角色为 `ADMIN`、`REVIEWER`、`USER`。文案审核、文案质检、图片质检还分别受 `copyReviewEnabled`、`copyQcEnabled`、`imageQcEnabled` 控制。
- 同一组件在任务弹窗、作业模式、图片质检和独立图片编辑中复用时，必须验证各实际入口及不同权限 / 状态，不能用单一入口代替全部。
- 当前已挂载功能与源码存在但未挂载功能分开。知识库视觉切换当前被 `SHOW_KNOWLEDGE_TYPE_SWITCHER = false` 隐藏，列在末尾，不能冒充当前页面测试通过。
- 此清单不创建生产发布或生产调度。已有发布功能应在隔离测试目标验证，并遵守 AGENTS.md 的现有边界。
- 单元 / 合约 / HTTP / 源码测试、真实浏览器交互、真实模型调用分别记账；Mock 或 fallback 不能标成 Codex 真生图。测试代码使用 fakes，不消耗模型额度。

## 约 100 条测试数据与完整覆盖要求

100 条是端到端数据规模，不是本文件用例数量。需为每条数据保留输入、任务 ID、角色、所走路径、模型来源、最终状态及产物映射；真实模型条数与 fake 条数单独汇总。正常任务应覆盖单条 / 批量创建、词包导入、文案初审、自动 / 手动成批、图文质检、返修、图片编辑、交付打包。边界数据需包括空值、长度界限、重复 Query、Unicode、不可信指令、格式 / 文件尺寸错误、失败重试、并发 / 陈旧版本和取消。约 100 条正常 / 边界数据的分配比例由执行报告记录，不预先声称已执行。

功能测试完成必须同时满足：所有当前可见入口已经逐项执行；具有变更的 CRUD 已执行新增、读取、修改、删除及取消；权限正反例、加载失败 / 空态、分页 / 搜索、真实后台状态、文件产物与数据库事实已经核对。缺凭证 / 外部模型不可用或当前隐藏的项目应明确记录受阻 / 不适用及原因，不能写成通过。

## 页面与用例数量

| 分组 | 页面 / 入口 | 用例数 |
| --- | --- | ---: |
| AUTH · 登录、会话与个人资料 | /login；/profile | 14 |
| NAV · 全局导航、消息及通用交互 | 全部后台路由 | 13 |
| VIEW · 作业中心全部视图 | /workbench | 10 |
| LIST · 任务列表筛选、分页和批量操作 | /workbench/{view} | 35 |
| QPK · Query词包导入、筛选派单与生命周期 | /query-packages | 41 |
| CREATE · 创建 Query 作业 | /workbench/personal（创建笔记弹窗） | 9 |
| ASSIGN · 负责人分配与任务优先级 | /workbench/{view}（分配 / 优先级弹窗） | 10 |
| COPY · 任务详情、文案人工审核及草稿 | /workbench/{view}（任务详情）；/work-mode | 25 |
| PLAN · 图片文案规划与布局编辑 | 任务详情图片文案规划 | 17 |
| IREVIEW · 图片初审、返修与集中修改处置（另2项旧评分/返工未挂载） | 任务详情图片初审 / 返修 | 15 |
| IPREVIEW · 通用图片大图预览及历史面板参数恢复 | 任务详情 / 质检 / 交付图片预览；图片历史面板 | 12 |
| EDIT · 任务内与独立图片编辑器共用功能 | 任务详情图片编辑；/image-editor | 40 |
| STAND · 独立图片工作空间 | /image-editor | 13 |
| WORK · 作业模式专注队列 | /work-mode | 18 |
| CFLOW · 文案工作入口与批次创建 | /copy-flow | 10 |
| CQA · 文案质检批次与明细 | /copy-qa | 15 |
| IQA · 图片质检队列（另1项升级提交未挂载） | /image-qa | 16 |
| REASSIGN · 待二次分配管理员处置 | /reassignment | 15 |
| DELIVERY · 共享交付池及文件记录 | /delivery-pool；个人统计交付记录弹窗 | 21 |
| DLEGACY · 图文预览、预览发布与原始批次工具 | /delivery-pool（折叠工具区） | 14 |
| PROMPT · 提示词版本与执行配置（另1项本机条件分支） | /prompts | 18 |
| KNOW · 当前文案知识库 | /knowledge | 15 |
| SETTING · 生产配置全部可见分区（另12项本机条件分支） | /settings | 36 |
| USER · 用户管理与自动分配人员池 | /users | 24 |
| EXEC · 执行机与小红书搜索节点 | /executors | 7 |
| PERSONAL · 个人数据统计全部页签和明细 | /workbench/personal-statistics | 15 |
| STAT · 管理员数据统计及账号明细 | /workbench-statistics | 15 |
| REPORT · 任务数据统计（另5项查询方案未挂载） | /reports/task-data | 16 |
| ANNOT · 标注作业统计报表与趋势 | /reports/annotation-jobs | 10 |
| LAB · 搜索与文案对照实验室 | search-lab / | 26 |
| PREVIEW · 独立预览服务全部页面功能 | preview-service /；/login；/preview；/p/{publicId} | 25 |
| TRACE · 任务历史、模型请求 / 响应可见性 | 任务详情历史与模型记录 | 7 |
| 合计 | 当前中心可见范围（另12项本机条件分支、9项未挂载，稳定ID总计598） | 577 |

## 相关源码和已有测试索引

所有路径均相对于仓库根目录。`E-分组` 是该分组已有测试定位索引。文件是否通过应以本轮实际日志为准；有的浏览器命名测试仍会使用 fake 环境，因此不能据文件名推断调用了真实服务。

### E-AUTH

源码：`app/login/login-form.tsx`、`app/components/session-keeper.tsx`、`app/profile/profile-manager.tsx`。

已有相关测试 / 脚本：`tests/auth-routes.test.mjs`、`tests/login-rate-limits.test.mjs`、`tests/session-renewal-browser.test.mjs`、`server/tests/user-management.test.mjs`。

### E-NAV

源码：`app/components/side-nav.tsx`、`app/components/app-topbar.tsx`、`app/components/background-tasks.tsx`。

已有相关测试 / 脚本：`tests/app-topbar-route.test.mjs`、`tests/background-tasks-browser.test.mjs`、`tests/background-task-ownership-browser.test.mjs`、`tests/dialog-notification-browser.test.mjs`。

### E-VIEW

源码：`app/workbench/views.ts`、`app/workbench/[view]/page.tsx`。

已有相关测试 / 脚本：`tests/workbench-views.test.mjs`、`tests/admin-jobs-access.test.mjs`、`tests/personal-workspace-browser.test.mjs`。

### E-LIST

源码：`app/workbench/creation-workbench.tsx`、`app/workbench/personal-controls.tsx`、`app/workbench/admin-job-filters.tsx`、`app/workbench/workbench-pagination.tsx`。

已有相关测试 / 脚本：`tests/frontend-pagination-and-return-path.test.mjs`、`tests/task-date-filter.test.mjs`、`tests/admin-personnel-filters-ui.test.mjs`、`tests/duplicate-query-cleanup-ui.test.mjs`、`server/tests/task-view-filters.test.mjs`。

### E-QPK

源码：`app/query-packages/query-package-workbench.tsx`、`app/query-packages/virtual-query-list.tsx`、`app/query-packages/types.ts`。

已有相关测试 / 脚本：`tests/query-package-intake-contract.test.mjs`、`tests/query-package-assignment-fixture.test.mjs`、`server/tests/query-package-spreadsheet.test.mjs`、`server/tests/query-packages.test.mjs`、`server/tests/query-package-production-contract.test.mjs`、`server/tests/modular-workflow-http-contract.test.mjs`、`server/tests/modular-workflow-postgres.e2e.test.mjs`、`scripts/full-functional-100-e2e.mjs`。

### E-CREATE

源码：`app/workbench/creation-workbench.tsx`。

已有相关测试 / 脚本：`tests/creation-workbench-ui.test.mjs`、`tests/query-batch.test.mjs`、`tests/query-package-task-creation-gate.test.mjs`、`server/tests/skip-copy-review.test.mjs`。

### E-ASSIGN

源码：`app/workbench/task-assignment-dialog.tsx`、`app/workbench/task-priority-control.tsx`。

已有相关测试 / 脚本：`tests/task-assignment-ui.test.mjs`、`tests/task-priority-ui.test.mjs`、`server/tests/task-assignment.test.mjs`、`server/tests/task-priority.test.mjs`。

### E-COPY

源码：`app/workbench/task-review-dialog.tsx`、`app/workbench/copy-review-panel.tsx`、`app/workbench/human-quality-rating.tsx`。

已有相关测试 / 脚本：`tests/copy-review-submission.test.mjs`、`tests/copy-review-drafts-browser.test.mjs`、`tests/copy-rework-browser.test.mjs`、`tests/human-rating-ui.test.mjs`、`tests/copy-review-final-score-contract.test.mjs`。

### E-PLAN

源码：`app/workbench/image-plan-review-panel.tsx`、`app/components/image-controls.tsx`。

已有相关测试 / 脚本：`tests/image-plan-review-browser.test.mjs`、`tests/image-plan-editing.test.mjs`、`tests/locked-image-plan-regression.test.mjs`、`tests/review-image-plan-generation.test.mjs`。

### E-IREVIEW

源码：`app/workbench/image-review-panel.tsx`、`app/components/pending-image-edits-dialog.tsx`、`app/components/image-manual-modification-note.tsx`。

已有相关测试 / 脚本：`tests/image-review-notes-browser.test.mjs`、`tests/image-retry-rework-browser.test.mjs`、`tests/image-quality-browser.test.mjs`、`server/tests/pending-image-edits.test.mjs`。

### E-IPREVIEW

源码：`app/components/image-preview.tsx`、`app/components/image-preview-background-control.tsx`、`app/components/image-carousel-navigation.tsx`、`app/components/image-history-compare.tsx`。

已有相关测试 / 脚本：`tests/image-preview-browser.test.mjs`、`tests/image-controls-integration.test.mjs`、`tests/current-image-editor-layout-browser.test.mjs`。

### E-EDIT

源码：`app/components/current-image-editor.tsx`、`app/components/standalone-image-editor.tsx`、`app/components/image-disclosure-color-control.tsx`。

已有相关测试 / 脚本：`tests/current-image-editor-browser.test.mjs`、`tests/standalone-image-editor-browser.test.mjs`、`tests/image-edit-batch.test.mjs`、`server/tests/image-editing-http.test.mjs`、`server/tests/programmatic-image-edit-runner.test.mjs`。

### E-STAND

源码：`app/image-editor/workbench.tsx`、`app/image-editor/image-editor-list.tsx`。

已有相关测试 / 脚本：`tests/standalone-upload-session.test.mjs`、`tests/standalone-image-editor-browser.test.mjs`、`server/tests/standalone-image-uploads.test.mjs`、`server/tests/standalone-upload-cancellation.test.mjs`。

### E-WORK

源码：`app/work-mode/work-mode.tsx`、`app/work-mode/work-quality-editor.tsx`、`app/work-mode/previous-return-notice.tsx`。

已有相关测试 / 脚本：`tests/work-mode-browser.test.mjs`、`tests/work-mode-previous-return.test.mjs`、`server/tests/work-mode.test.mjs`。

### E-CFLOW

源码：`app/copy-flow/copy-flow-workbench.tsx`。

已有相关测试 / 脚本：`server/tests/copy-qa-v2-self-review.test.mjs`、`server/tests/stratified-copy-sampling.test.mjs`。

### E-CQA

源码：`app/copy-qa/copy-qa-workbench.tsx`、`app/copy-qa/copy-qa-reason-picker.tsx`、`app/copy-qa/copy-qa-revision-view.tsx`。

已有相关测试 / 脚本：`tests/copy-qa-overview-browser.test.mjs`、`tests/copy-qa-detail-browser.test.mjs`、`tests/copy-qa-reason-picker-browser.test.mjs`、`server/tests/copy-qa-v2-previous-return.test.mjs`。

### E-IQA

源码：`app/image-qa/image-qa-workbench.tsx`、`app/components/qa-escalate-button.tsx`、`app/components/image-discard-button.tsx`。

已有相关测试 / 脚本：`tests/image-quality-browser.test.mjs`、`tests/image-qa-admin-visibility.test.mjs`、`server/tests/image-review.test.mjs`、`server/tests/image-qa-blind-server-contract.test.mjs`。

### E-REASSIGN

源码：`app/reassignment/reassignment-queue.tsx`。

已有相关测试 / 脚本：`tests/reassignment-batch-browser.test.mjs`、`tests/secondary-assignment-feedback-browser.test.mjs`、`server/tests/secondary-assignment-http.test.mjs`。

### E-DELIVERY

源码：`app/delivery-pool/shared-delivery-workbench.tsx`。

已有相关测试 / 脚本：`tests/shared-delivery-browser.test.mjs`、`server/tests/shared-delivery.test.mjs`、`server/tests/delivery-archives.test.mjs`、`server/tests/delivery-batches.test.mjs`。

### E-DLEGACY

源码：`app/delivery-pool/delivery-pool-workbench.tsx`、`app/delivery-pool/delivery-preview-dialog.tsx`。

已有相关测试 / 脚本：`tests/delivery-pool-ui.test.mjs`、`tests/shared-delivery-browser.test.mjs`、`server/tests/delivery-preview.test.mjs`、`server/tests/delivery-spreadsheet.test.mjs`。

### E-PROMPT

源码：`app/prompts/central-prompt-workbench.tsx`、`app/prompts/local-prompt-workbench.tsx`、`app/prompts/prompt-editor.tsx`、`app/prompts/prompt-runtime-settings.tsx`。

已有相关测试 / 脚本：`tests/prompt-catalog-browser.test.mjs`、`tests/prompt-tabs-ui.test.mjs`、`tests/prompt-preview-and-artifacts.test.mjs`、`tests/prompt-governance-regressions.test.mjs`。

### E-KNOW

源码：`app/knowledge/knowledge-tabs.tsx`、`app/knowledge/copy-knowledge-workbench.tsx`、`app/knowledge/copy-knowledge-library.tsx`、`app/knowledge/copy-analysis-prompt-manager.tsx`。

已有相关测试 / 脚本：`tests/copy-knowledge-ui.test.mjs`、`tests/copy-knowledge-generation.test.mjs`、`tests/copy-knowledge-store.test.mjs`、`tests/knowledge-auth.test.mjs`。

### E-SETTING

源码：`app/components/central-data-workbench.tsx`、`app/settings/production-settings-form.tsx`、`app/settings/web-search-settings-panel.tsx`、`app/settings/workflow-quality-settings-panel.tsx`、`app/settings/xhs-query-search-settings-panel.tsx`、`app/settings/model-api-settings-section.tsx`。

已有相关测试 / 脚本：`tests/model-api-settings-ui.test.mjs`、`tests/web-search-settings.test.mjs`、`tests/workflow-quality-settings-input.test.mjs`、`tests/xhs-query-search-settings-ui.test.mjs`、`tests/human-quality-settings.test.mjs`、`tests/layout-catalog-settings.test.mjs`。

### E-USER

源码：`app/users/user-manager.tsx`、`app/users/user-management-workspace.tsx`、`app/users/auto-assignment-pool-manager.tsx`。

已有相关测试 / 脚本：`tests/user-management-ui.test.mjs`、`tests/account-copy-sampling-browser.test.mjs`、`tests/auto-assignment-pool-ui.test.mjs`、`server/tests/user-management.test.mjs`。

### E-EXEC

源码：`app/executors/executor-manager.tsx`、`app/components/xhs-account-alert.tsx`。

已有相关测试 / 脚本：`tests/executor-management-ui.test.mjs`、`tests/xhs-search-status-ui.test.mjs`。

### E-PERSONAL

源码：`app/workbench/personal-statistics/personal-statistics-dashboard.tsx`、`app/workbench/personal-statistics/personal-today-overview.tsx`、`app/workbench/personal-statistics/personal-quality-activity.tsx`。

已有相关测试 / 脚本：`tests/personal-workspace-browser.test.mjs`、`tests/personal-today-statistics.test.mjs`、`tests/personal-qa-statistics.test.mjs`、`server/tests/personal-overview.test.mjs`。

### E-STAT

源码：`app/workbench-statistics/page.tsx`、`app/workbench-statistics/operator-performance.tsx`、`app/workbench-statistics/operator-detail.tsx`。

已有相关测试 / 脚本：`tests/operator-performance-browser.test.mjs`、`tests/performance-round2-app-browser.test.mjs`、`tests/web-statistics-ui.test.mjs`、`server/tests/operator-performance-http.test.mjs`。

### E-REPORT

源码：`app/reports/task-data/task-data-report.tsx`、`app/reports/task-data/report-exports.tsx`。

已有相关测试 / 脚本：`tests/performance-round2-app.test.mjs`、`server/tests/task-data-report-http.test.mjs`、`server/tests/saved-task-report-queries.test.mjs`、`server/tests/task-report-exports-postgres.test.mjs`。

### E-ANNOT

源码：`app/reports/annotation-jobs/report.tsx`、`app/reports/annotation-jobs/trend-panel.tsx`、`app/reports/annotation-jobs/trend-chart.tsx`。

已有相关测试 / 脚本：`tests/annotation-job-report-browser.test.mjs`、`tests/annotation-assignment-cycles.test.mjs`、`server/tests/annotation-assignment-report.test.mjs`。

### E-LAB

源码：`search-lab/public/index.html`、`search-lab/public/app.js`、`search-lab/providers.mjs`。

已有相关测试 / 脚本：`tests/search-lab.test.mjs`、`tests/search-lab-copy-config.test.mjs`、`tests/search-lab-copy-generation.test.mjs`、`tests/search-lab-copy-service.test.mjs`。

### E-PREVIEW

源码：`preview-service/components/preview-manager.tsx`、`preview-service/components/batch-preview-creator.tsx`、`preview-service/components/api-key-manager-dialog.tsx`、`preview-service/components/public-preview-view.tsx`。

已有相关测试 / 脚本：`tests/preview-object-storage.test.mjs`、`tests/preview-migration-layout.test.mjs`、`preview-service/scripts/smoke.mjs`、`preview-service/scripts/smoke-batch.mjs`。

### E-TRACE

源码：`app/workbench/task-review-history.tsx`、`app/workbench/model-call-trace.tsx`、`app/workbench/model-request-details.tsx`、`app/workbench/model-response-view.tsx`。

已有相关测试 / 脚本：`tests/model-call-trace-browser.test.mjs`、`tests/model-request-presentation.test.mjs`、`tests/model-response-presentation.test.mjs`、`tests/model-call-trace-ui.test.mjs`。

## 完整功能矩阵

表内每项均需关联实际执行证据。合并列出的同类选项应逐个选择验证，不能只测默认值。CRUD、生成、保存、采用、拒绝、取消、废弃、恢复等不同动作均独立列出。

### AUTH · 登录、会话与个人资料

角色 / 条件：未登录及 ADMIN / REVIEWER / USER。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-AUTH-001 | /login；/profile | 正确账号密码登录及 next 返回地址 | 登录成功并回到授权页面，禁止不安全的外部返回地址 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-002 | /login；/profile | 空值、错误账号或密码 | 出现准确提示，不进入后台 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-003 | /login；/profile | 连续失败触发登录限制 | 受限状态可见，重试不会绕过限制 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-004 | /login；/profile | 强制初始密码修改弹窗 | 初始密码账号在完成修改前不能操作工作页面 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-005 | /login；/profile | 强制修改：空值、旧初始密码、两次不一致 | 展示验证提示，禁止提交 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-006 | /login；/profile | 强制修改：有效新密码 | 更新成功，要求使用新密码重新登录 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-007 | /login；/profile | 强制修改：退出并切换账号 | 清理当前会话，回到登录 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-008 | /login；/profile | 后台退出 | 跳转重新认证页面，旧会话不能继续访问 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-009 | /login；/profile | 会话自动续期、过期及多页并发 | 有效会话续期；过期跳登录；不因竞态退出另一新会话 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-010 | /login；/profile | 个人信息读取 | 姓名、账号、角色和密码状态对应当前账号 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-011 | /login；/profile | 显示姓名编辑并保存 | 长度及必填验证生效，刷新后保留 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-012 | /login；/profile | 普通修改登录密码 | 当前密码正确且新密码一致才成功，旧会话失效 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-013 | /login；/profile | 管理员设置 / 更新永久删除二级密码 | 校验当前登录密码、长度、两次确认及不能与登录密码相同 | E-AUTH | 已执行（范围见审计） |
| F-AUTH-014 | /login；/profile | 非管理员访问二级密码功能 | 不展示或拒绝操作 | E-AUTH | 已执行（范围见审计） |

### NAV · 全局导航、消息及通用交互

角色 / 条件：按角色及工作权限显示。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-NAV-001 | 全部后台路由 | 品牌、首页及作业中心重定向 | / 与 /workbench 最终进入 /workbench/personal | E-NAV | 已执行（范围见审计） |
| F-NAV-002 | 全部后台路由 | 展开 / 收起作业中心和报表子菜单 | 当前子路由高亮且 aria 状态一致 | E-NAV | 已执行（范围见审计） |
| F-NAV-003 | 全部后台路由 | 移动端展开 / 收起主导航 | 可访问全部当前有权限入口，导航后菜单收起 | E-NAV | 已执行（范围见审计） |
| F-NAV-004 | 全部后台路由 | 逐个导航入口及顶部面包屑 | 标题、选中状态与路由匹配；浏览器前进后退有效 | E-NAV | 已执行（范围见审计） |
| F-NAV-005 | 全部后台路由 | ADMIN / REVIEWER / USER 导航差异 | 管理员可用全部管理入口；其他角色只展示授权入口 | E-NAV | 已执行（范围见审计） |
| F-NAV-006 | 全部后台路由 | 权限开关组合及直接输入受限 URL | 文案审核、文案质检、图片质检开关与页面访问保持一致 | E-NAV | 已执行（范围见审计） |
| F-NAV-007 | 全部后台路由 | 全局后台任务提醒打开 / 关闭 | 正在处理、结果待确认、失败及历史任务正确分组 | E-NAV | 已执行（范围见审计） |
| F-NAV-008 | 全部后台路由 | 后台任务查看任务 | 打开对应任务 / 页面并保留任务归属 | E-NAV | 已执行（范围见审计） |
| F-NAV-009 | 全部后台路由 | 单项标已读 | 只改变该完成提醒的未读状态 | E-NAV | 已执行（范围见审计） |
| F-NAV-010 | 全部后台路由 | 全部标已读 | 全部可读提醒更新，运行中任务继续展示 | E-NAV | 已执行（范围见审计） |
| F-NAV-011 | 全部后台路由 | 后台历史折叠及跨账号隔离 | 历史可展开，另一账号不能读取前账号任务 | E-NAV | 已执行（范围见审计） |
| F-NAV-012 | 全部后台路由 | 弹窗 Escape、遮罩、取消、焦点返回及忙碌状态 | 遵守各弹窗允许关闭条件，不重复提交 | E-NAV | 已执行（范围见审计） |
| F-NAV-013 | 全部后台路由 | 错误 / 成功通知关闭与失败重试 | 错误可见，重试不覆盖成功回执或重复执行 | E-NAV | 已执行（范围见审计） |

### VIEW · 作业中心全部视图

角色 / 条件：ADMIN；REVIEWER 部分；USER 个人视图。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-VIEW-001 | /workbench/personal | 我的作业 | 范围与当前账号负责 / 创建关系匹配 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-002 | /workbench/unassigned | 待审核分配 | 只显示待文案审核且未分配负责人任务 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-003 | /workbench/all-copy | 全部文案任务 | 文案排队、运行、待质检和失败范围正确 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-004 | /workbench/copy-review | 待文案审核 | 首次审核、文案返修和生图失败回退任务正确 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-005 | /workbench/images | 生图中 | 只显示图片排队或运行任务 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-006 | /workbench/manual-archive | 图片初审与返修 | 图片初审和返修任务范围正确 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-007 | /workbench/completed | 历史交付池兼容路由 | 只显示门禁放行且就绪任务 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-008 | /workbench/all | 全部作业 | 所有状态可查，默认北京时间当天最近变更范围 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-009 | /workbench/discarded | 废弃池 | 只显示已废弃任务并保留历史 | E-VIEW | 已执行（范围见审计） |
| F-VIEW-010 | /workbench | 未知 view 与无中心服务配置 | 未知路由 404；无配置显示明确空状态 | E-VIEW | 已执行（范围见审计） |

### LIST · 任务列表筛选、分页和批量操作

角色 / 条件：管理员功能与个人功能分别验证。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-LIST-001 | /workbench/{view} | 刷新、读取失败重新读取 | 新状态可见，失败保留上次数据并标注 | E-LIST | 已执行（范围见审计） |
| F-LIST-002 | /workbench/{view} | Query 关键词搜索 | 命中范围正确，清空恢复列表 | E-LIST | 已执行（范围见审计） |
| F-LIST-003 | /workbench/{view} | #ID 与 Query ID 搜索 | 定位唯一任务或显示无结果 | E-LIST | 已执行（范围见审计） |
| F-LIST-004 | /workbench/{view} | 词包名称筛选 | 匹配正确词包，清除恢复 | E-LIST | 已执行（范围见审计） |
| F-LIST-005 | /workbench/{view} | 排序全部选项 | 优先级、创建时间、ID 的升降序及个人等待排序正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-006 | /workbench/{view} | 优先级来源筛选 | 系统、最高、高、普通、暂缓、暂停各选项正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-007 | /workbench/{view} | 管理员创建者筛选及姓名搜索 | 按选定人员身份匹配，不混入同名账号 | E-LIST | 已执行（范围见审计） |
| F-LIST-008 | /workbench/{view} | 管理员负责人筛选及姓名搜索 | 未分配 / 指定负责人结果正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-009 | /workbench/{view} | 创建者当前角色筛选 | 管理员、质检、标注、未知角色与当前角色事实一致 | E-LIST | 已执行（范围见审计） |
| F-LIST-010 | /workbench/{view} | 任务全部状态筛选 | 文案、图片、管理员处置、结束状态各项正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-011 | /workbench/{view} | 最近变更日期起止及边界 | 北京时间、含结束日；错误范围被拒绝 | E-LIST | 已执行（范围见审计） |
| F-LIST-012 | /workbench/{view} | 异常快捷筛选 | 全部异常、长期无进度、失败、我的失败范围正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-013 | /workbench/{view} | 个人作业关系筛选 | 我负责、我创建、与我相关范围正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-014 | /workbench/{view} | 个人作业分类及返修细分 | 初审、仅文案、仅图片、双返修、后台处理、已完成 / 废弃等范围正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-015 | /workbench/{view} | 个人今天 / 昨天 / 7 天 / 30 天 / 自定义日期 | 日期范围和历史完成记录一致 | E-LIST | 已执行（范围见审计） |
| F-LIST-016 | /workbench/{view} | 清空全部筛选及清除日期 | 还原默认状态且页码回到合法位置 | E-LIST | 已执行（范围见审计） |
| F-LIST-017 | /workbench/{view} | 保存当前常用视图 | 名称必填且最多 50 字；保存后可选 | E-LIST | 已执行（范围见审计） |
| F-LIST-018 | /workbench/{view} | 载入保存视图 | 人员、状态、日期、排序及搜索条件恢复 | E-LIST | 已执行（范围见审计） |
| F-LIST-019 | /workbench/{view} | 删除保存视图 | 删除后不再可选；取消保留 | E-LIST | 已执行（范围见审计） |
| F-LIST-020 | /workbench/{view} | Query 去重开关 | 按当前规则分组，显示代表条和隐藏数量 | E-LIST | 已执行（范围见审计） |
| F-LIST-021 | /workbench/{view} | 预览重复 Query 弹窗 | 展示拟保留 / 清理对象及影响，重试预览可用 | E-LIST | 已执行（范围见审计） |
| F-LIST-022 | /workbench/{view} | 确认清理重复 Query | 只处置预览范围，竞态 / 版本变化拒绝陈旧操作 | E-LIST | 已执行（范围见审计） |
| F-LIST-023 | /workbench/{view} | 行内查看更多操作菜单 | 动作数量、禁用原因及任务详情入口正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-024 | /workbench/{view} | 单选 / 全选当前页 / 清除选择 | 选中数量和可操作子集正确，不跨筛选遗留 | E-LIST | 已执行（范围见审计） |
| F-LIST-025 | /workbench/{view} | 批量分配 / 改派 | 只处理允许任务，逐条结果与列表更新一致 | E-LIST | 已执行（范围见审计） |
| F-LIST-026 | /workbench/{view} | 批量重试 | 只处理可重试文案 / 图片任务，不重复入队 | E-LIST | 已执行（范围见审计） |
| F-LIST-027 | /workbench/{view} | 批量废弃 | 允许状态正确，质检退回任务入口限制生效 | E-LIST | 已执行（范围见审计） |
| F-LIST-028 | /workbench/{view} | 单条恢复废弃任务 | 历史内容保留，回到适当流程阶段 | E-LIST | 已执行（范围见审计） |
| F-LIST-029 | /workbench/{view} | 单条永久删除及二级密码 | 影响范围、密码校验及确认正确，不能删除运行任务 | E-LIST | 已执行（范围见审计） |
| F-LIST-030 | /workbench/{view} | 批量永久删除及上限 | 最多 20 条、执行停止与废弃等待条件正确 | E-LIST | 已执行（范围见审计） |
| F-LIST-031 | /workbench/{view} | 批量导出交付任务 | 仅门禁放行任务可导出，最多 20 条 | E-LIST | 已执行（范围见审计） |
| F-LIST-032 | /workbench/{view} | 分页首页 / 上页 / 下页 / 尾页 | 无重复漏项，边界按钮禁用 | E-LIST | 已执行（范围见审计） |
| F-LIST-033 | /workbench/{view} | 每页 20 / 50 / 100 及删除末页 | 总数、页码和列表一致，越界自动回退 | E-LIST | 已执行（范围见审计） |
| F-LIST-034 | /workbench/{view} | 详情返回、刷新及 URL 状态恢复 | 保留搜索、筛选、排序、页码及目标任务 | E-LIST | 已执行（范围见审计） |
| F-LIST-035 | /workbench/{view} | 列表空态创建第一条与无匹配空态 | 可创建入口受权限控制，无结果不误报加载失败 | E-LIST | 已执行（范围见审计） |

### QPK · Query词包导入、筛选派单与生命周期

适用角色：管理员负责导入、分配、废弃与永久删除；标注/质检仅处理当前分配的Query。正式作业由筛选通过自动创建；当前页面没有独立“手动生产”按钮。

| 用例 ID | 页面 / 入口 | 入口 / 动作 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-QPK-001 | /query-packages | 已加载词包概况、筛选进度和状态 | 总数、待筛、通过、淘汰、正式作业数以已加载范围为准 | E-QPK | 已执行（范围见审计） |
| F-QPK-002 | /query-packages | 刷新词包及读取失败重新读取 | 重新获取当前用户可见词包，错误消息与重试有效 | E-QPK | 已执行（范围见审计） |
| F-QPK-003 | /query-packages | 搜索词包名称、甲方批次和筛选人 | 只筛选已加载词包；有未加载内容时显示范围说明 | E-QPK | 已执行（范围见审计） |
| F-QPK-004 | /query-packages | 全部词包状态选项筛选 | 全部及当前可用状态正确过滤，不把已用完当可继续筛选 | E-QPK | 已执行（范围见审计） |
| F-QPK-005 | /query-packages | 加载更多词包 | 追加下一批且不重复；加载中禁用，全部载入后隐藏 | E-QPK | 已执行（范围见审计） |
| F-QPK-006 | /query-packages | 打开导入词包弹窗与取消 | 管理员可打开，取消不新增；提交中不可重复或关闭 | E-QPK | 已执行（范围见审计） |
| F-QPK-007 | /query-packages | 词包名称与32位甲方批次编号校验 | 名称必填且上限120，批次只允许32位十六进制并统一大小写 | E-QPK | 已执行（范围见审计） |
| F-QPK-008 | /query-packages | 粘贴Query文本与识别/重复计数 | 按导入规则解析单行、多行，计数和重复提示一致 | E-QPK | 已执行（范围见审计） |
| F-QPK-009 | /query-packages | 读取TXT与CSV文件及重新选择 | 显示来源文件和解析结果；选择器限定TXT/CSV/XLSX，读取失败可重新选择 | E-QPK | 已执行（范围见审计） |
| F-QPK-010 | /query-packages | 读取XLSX工作表与Query列 | 列/工作表切换重算预览，读取中阻止重复提交 | E-QPK | 已执行（范围见审计） |
| F-QPK-011 | /query-packages | 标准表生产Query优先与下发Query回退 | 生产Query为空时用下发Query；预览保存原始下发Query和实际作业Query | E-QPK | 已执行（范围见审计） |
| F-QPK-012 | /query-packages | 标准表按任务ID自动拆包 | 显示各32位任务ID条数，多个批次原子创建，批次编号来自标准表且只读 | E-QPK | 已执行（范围见审计） |
| F-QPK-013 | /query-packages | 导入空值、损坏文件、超限及无效批次 | 明确拒绝，不创建部分词包；修正后允许重试 | E-QPK | 已执行（范围见审计） |
| F-QPK-014 | /query-packages | 创建词包并核对候选数据 | 创建成功后列表可见，最多配置允许条数；导入本身不绕过人工筛选 | E-QPK | 已执行（范围见审计） |
| F-QPK-015 | /query-packages | 导入失败、陈旧版本及重复提交 | 保留可修正输入，错误可读；同请求重试不重复创建 | E-QPK | 已执行（范围见审计） |
| F-QPK-016 | /query-packages | 分配筛选弹窗读取与取消 | 管理员读取分配概况和人员；取消不改原分配 | E-QPK | 已执行（范围见审计） |
| F-QPK-017 | /query-packages | 选择多名可分配标注/质检人员 | 显示启用账号的姓名/角色/账号及分配数量，勾选变化同步预览 | E-QPK | 已执行（范围见审计） |
| F-QPK-018 | /query-packages | 平均分配策略 | 剩余待筛Query按人数均分，余数分配可预测且总数不超范围 | E-QPK | 已执行（范围见审计） |
| F-QPK-019 | /query-packages | 按条数分配策略与数量校验 | 可逐人输入，空/零/超总量拒绝；切换策略保留正确预览 | E-QPK | 已执行（范围见审计） |
| F-QPK-020 | /query-packages | 取消全部人员并收回待筛分配 | 保存后未筛Query仅管理员可筛；已提交结果和正式作业保留 | E-QPK | 已执行（范围见审计） |
| F-QPK-021 | /query-packages | 保存分配并重新分配 | 只影响未筛Query，版本冲突拒绝并提示刷新 | E-QPK | 已执行（范围见审计） |
| F-QPK-022 | /query-packages | 分配无待筛、无账号及加载错误 | 无待筛时禁用保存；没有启用账号时说明收回结果；错误可恢复 | E-QPK | 已执行（范围见审计） |
| F-QPK-023 | /query-packages | 打开筛选/查看Query及关闭 | 显示词包名称、可见范围、计数和来源；只读状态不可提交 | E-QPK | 已执行（范围见审计） |
| F-QPK-024 | /query-packages | 按Query或外部编号搜索并清空 | 应用搜索后重新读取明细；清空后应用恢复当前状态范围 | E-QPK | 已执行（范围见审计） |
| F-QPK-025 | /query-packages | 明细七种筛选结果选项 | 全部/待筛/通过/淘汰/无效/重复/已创建作业切换正确 | E-QPK | 已执行（范围见审计） |
| F-QPK-026 | /query-packages | 虚拟Query列表滚动与继续加载 | 滚动触发或按钮加载下一批，显示已加载/总数，行身份不串位 | E-QPK | 已执行（范围见审计） |
| F-QPK-027 | /query-packages | 单选和选择已加载可筛Query | 只勾选允许筛选项，取消不会保留错误选中数 | E-QPK | 已执行（范围见审计） |
| F-QPK-028 | /query-packages | 单行暂存通过与改判 | 通过仅暂存本地决定，可在提交前改为淘汰；显示待提交标记 | E-QPK | 已执行（范围见审计） |
| F-QPK-029 | /query-packages | 单行暂存淘汰与改判 | 淘汰仅暂存本地决定，可在提交前改为通过 | E-QPK | 已执行（范围见审计） |
| F-QPK-030 | /query-packages | 提交本批暂存筛选 | 按原行版本一次提交；成功清空暂存并显示结果，冲突不误提交 | E-QPK | 已执行（范围见审计） |
| F-QPK-031 | /query-packages | 批量通过并自动创建正式作业 | 选中候选变已通过并自动建作业，任务ID可核对；不会重复生产 | E-QPK | 已执行（范围见审计） |
| F-QPK-032 | /query-packages | 填写筛选原因并批量淘汰 | 原因最长300，记录正确范围及说明；不创建正式作业 | E-QPK | 已执行（范围见审计） |
| F-QPK-033 | /query-packages | 无效/重复/已产任务行只读门禁 | 对应行不可勾选或暂存，不修改既有正式作业 | E-QPK | 已执行（范围见审计） |
| F-QPK-034 | /query-packages | ADMIN/USER/REVIEWER筛选范围与直达权限 | 管理员全词包，其他账号仅自己的分配；未获分配/旧账号拒绝 | E-QPK | 已执行（范围见审计） |
| F-QPK-035 | /query-packages | 关闭带暂存决定的筛选弹窗 | 关闭清空本地暂存；再次打开显示正式记录，未提交决定不落库 | E-QPK | 已执行（范围见审计） |
| F-QPK-036 | /query-packages | 废弃词包原因、空值和取消 | 管理员必填最长500原因，空值禁用；取消保留词包 | E-QPK | 已执行（范围见审计） |
| F-QPK-037 | /query-packages | 确认废弃词包并保留已创建作业 | 停止继续筛选，审计记录原因；所有已产任务文案图片交付保留 | E-QPK | 已执行（范围见审计） |
| F-QPK-038 | /query-packages | 永久删除影响预检及状态门禁 | USED_UP/ABANDONED可预检；候选/批次/保留任务数正确，正式任务删除数必须0 | E-QPK | 已执行（范围见审计） |
| F-QPK-039 | /query-packages | 永久删除三项确认和失败处理 | 必填原因/正确二级密码/精确词包名；错误密码/名称/预检失败拒绝 | E-QPK | 已执行（范围见审计） |
| F-QPK-040 | /query-packages | 永久删除确认与取消并核对正式作业 | 取消保留，确认删除候选和词包；所有正式作业及历史仍能读取 | E-QPK | 已执行（范围见审计） |
| F-QPK-041 | /query-packages | 列表/明细空态、载入中和处理中按钮 | 无词包/无匹配/已筛完有清晰提示，处理中阻止重复或危险操作 | E-QPK | 已执行（范围见审计） |

### CREATE · 创建 Query 作业

角色 / 条件：ADMIN / USER；按创建权限。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-CREATE-001 | /workbench/personal（创建笔记弹窗） | 打开 / 取消创建笔记弹窗 | 表单显示，取消不入队 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-002 | /workbench/personal（创建笔记弹窗） | 单条 Query 创建 | 生成一个正式任务，列表可查且创建者正确 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-003 | /workbench/personal（创建笔记弹窗） | 多行 / 分隔符约 100 条批量创建 | 解析与输入计数一致；任务 ID 无重复；逐条可追踪 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-004 | /workbench/personal（创建笔记弹窗） | 空 Query、超长、重复和不可信内容 | 客户端与服务器校验一致，不执行输入指令 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-005 | /workbench/personal（创建笔记弹窗） | 配图自动 / 3 / 4 / 5 页 | 新任务冻结正确页数，自动遵循当前策略 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-006 | /workbench/personal（创建笔记弹窗） | 创建流程说明及表单提交状态 | 界面解释共享文案队列与派单时机，提交中按钮禁用防重复；当前没有额外任务说明输入框 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-007 | /workbench/personal（创建笔记弹窗） | 管理员免文案审核开关 | 只有管理员可用；明确标识免审核模式 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-008 | /workbench/personal（创建笔记弹窗）及创建后的图片审核 | 免审核生图后门禁（UI与后台组合） | 免文案审核创建的任务仍进入既有图片初审/质检；此处没有额外开关，由UI选择及API/PG状态证据组合验证 | E-CREATE | 已执行（范围见审计） |
| F-CREATE-009 | /workbench/personal（创建笔记弹窗） | 创建成功与接口 / 网络失败重试 | 成功提示数量与流程，失败保持输入、解除提交禁用；当前表单没有部分成功回执或 requestId 参数，服务端事务行为另由集成测试验证 | E-CREATE | 已执行（范围见审计） |

### ASSIGN · 负责人分配与任务优先级

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-ASSIGN-001 | /workbench/{view}（分配 / 优先级弹窗） | 单条首次分配及选择账号 | 只列可接手账号，成功后负责人与权限更新 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-002 | /workbench/{view}（分配 / 优先级弹窗） | 人员搜索、清除选择、重新读取 | 候选及当前选择正确，无自动错误选人 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-003 | /workbench/{view}（分配 / 优先级弹窗） | 改派账号并填写必填原因 | 当前任务责任转移且审计保留 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-004 | /workbench/{view}（分配 / 优先级弹窗） | 分配 / 改派取消 | 任务归属不变 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-005 | /workbench/{view}（分配 / 优先级弹窗） | 批量分配 / 改派及部分失败 | 逐项反馈，失败项可继续处理 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-006 | /workbench/{view}（分配 / 优先级弹窗） | 调整优先级：跟随系统 / 最高 / 高 / 普通 / 暂缓 / 暂停 | 预览及最终队列优先级符合选项 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-007 | /workbench/{view}（分配 / 优先级弹窗） | 优先级原因空值校验 | 原因必填，禁止空原因提交 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-008 | /workbench/{view}（分配 / 优先级弹窗） | 优先级影响预览 | 显示拟改任务数量、当前与新优先级 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-009 | /workbench/{view}（分配 / 优先级弹窗） | 确认优先级与取消 | 确认后生效；取消不写入 | E-ASSIGN | 已执行（范围见审计） |
| F-ASSIGN-010 | /workbench/{view}（分配 / 优先级弹窗） | 调整整个生产批次优先级 | 同批次选项仅在所选任务属于同一生产批次时展示；预览后只包括当前授权范围及对应priorityVersion | E-ASSIGN | 已执行（范围见审计） |

### COPY · 任务详情、文案人工审核及草稿

角色 / 条件：当前负责人及文案审核权限；ADMIN 查看 / 改派后代办。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-COPY-001 | /workbench/{view}（任务详情）；/work-mode | 打开任务详情及刷新 | 任务、状态、当前版本、负责人、失败原因正确 | E-COPY | 已执行（范围见审计） |
| F-COPY-002 | /workbench/{view}（任务详情）；/work-mode | 未分配 / 别人负责 / 已质检文案只读 | 不能评分、编辑或提交审核 | E-COPY | 已执行（范围见审计） |
| F-COPY-003 | /workbench/{view}（任务详情）；/work-mode | 文案 / 图片规划移动页签 | 内容完整，编辑状态保留 | E-COPY | 已执行（范围见审计） |
| F-COPY-004 | /workbench/{view}（任务详情）；/work-mode | 机器原稿评分全部档位 | 1、2、2.5、3 分的可编辑及可提交条件符合现有流程 | E-COPY | 已执行（范围见审计） |
| F-COPY-005 | /workbench/{view}（任务详情）；/work-mode | 原稿 1 分评分并废弃 | 原因 / 评分有效后废弃并保留记录 | E-COPY | 已执行（范围见审计） |
| F-COPY-006 | /workbench/{view}（任务详情）；/work-mode | 原稿 2 / 2.5 分编辑标题 | 最多 25 字，权限与评分限制生效 | E-COPY | 已执行（范围见审计） |
| F-COPY-007 | /workbench/{view}（任务详情）；/work-mode | 编辑正文及字数反馈 | 400–600 字验证正确，连续英文 / Unicode 计数符合实现 | E-COPY | 已执行（范围见审计） |
| F-COPY-008 | /workbench/{view}（任务详情）；/work-mode | 编辑标签 | 3–8 个标签校验，拆分与显示正确 | E-COPY | 已执行（范围见审计） |
| F-COPY-009 | /workbench/{view}（任务详情）；/work-mode | 扣分原因多选及说明 | 按评分要求必填，最多长度限制正确 | E-COPY | 已执行（范围见审计） |
| F-COPY-010 | /workbench/{view}（任务详情）；/work-mode | 人工修订稿评分及最终评分 | 原稿评分与最终评分独立且绑定正确版本 | E-COPY | 已执行（范围见审计） |
| F-COPY-011 | /workbench/{view}（任务详情）；/work-mode | 保存评分，暂不提交 | 保存评分 / 修订并保留当前处理状态 | E-COPY | 已执行（范围见审计） |
| F-COPY-012 | /workbench/{view}（任务详情）；/work-mode | 审核通过并进入后续流程 | 最终稿与图片规划冻结，进入待成批或后续门禁 | E-COPY | 已执行（范围见审计） |
| F-COPY-013 | /workbench/{view}（任务详情）；/work-mode | 审核草稿自动保存及状态 | 账号 + 任务 + 正式版本隔离；失败显示可重试 | E-COPY | 已执行（范围见审计） |
| F-COPY-014 | /workbench/{view}（任务详情）；/work-mode | 草稿立即保存 | 生成历史草稿并显示时间，不等同正式审核提交 | E-COPY | 已执行（范围见审计） |
| F-COPY-015 | /workbench/{view}（任务详情）；/work-mode | 恢复历史草稿 | 恢复内容、评分、规划和编辑状态，不覆盖别的版本 | E-COPY | 已执行（范围见审计） |
| F-COPY-016 | /workbench/{view}（任务详情）；/work-mode | 恢复正式版本 | 草稿内容恢复为当前正式稿 | E-COPY | 已执行（范围见审计） |
| F-COPY-017 | /workbench/{view}（任务详情）；/work-mode | 关闭 / 刷新有未提交修改 | 保存 / 放弃提示符合当前逻辑，不静默丢失 | E-COPY | 已执行（范围见审计） |
| F-COPY-018 | /workbench/{view}（任务详情）；/work-mode | 返工要求查看及历史质检反馈展开 | 问题标签、范围、具体说明和历史反馈正确 | E-COPY | 已执行（范围见审计） |
| F-COPY-019 | /workbench/{view}（任务详情）；/work-mode | 返工仅允许指定文案字段 | 未要求修改字段保持只读，指定字段可编辑 | E-COPY | 已执行（范围见审计） |
| F-COPY-020 | /workbench/{view}（任务详情）；/work-mode | 保存返工稿，暂不提交 | 保存有效修订，尚未进入复检 | E-COPY | 已执行（范围见审计） |
| F-COPY-021 | /workbench/{view}（任务详情）；/work-mode | 返工稿提交强制复检 | 需要真实修改及正确评分，复检绑定新修订版 | E-COPY | 已执行（范围见审计） |
| F-COPY-022 | /workbench/{view}（任务详情）；/work-mode | 质检建议废弃 / 废弃返工任务 | 原因必填，退出返工但历史保留 | E-COPY | 已执行（范围见审计） |
| F-COPY-023 | /workbench/{view}（任务详情）；/work-mode | 重试文案与生图连续失败回退 | 入队状态正确，既有历史可查 | E-COPY | 已执行（范围见审计） |
| F-COPY-024 | /workbench/{view}（任务详情）；/work-mode | AI 生成水印开关 | 权限、返工限制与保存后的任务配置一致 | E-COPY | 已执行（范围见审计） |
| F-COPY-025 | /workbench/{view}（任务详情）；/work-mode | 下载资源 / 进入质检批次 | 只有交付可下载；待质检入口定位正确 | E-COPY | 已执行（范围见审计） |

### PLAN · 图片文案规划与布局编辑

角色 / 条件：当前可编辑负责人。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-PLAN-001 | 任务详情图片文案规划 | 规划上一页 / 下一页及边界 | 页码、当前内容对应；首末边界禁用 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-002 | 任务详情图片文案规划 | 页类型选择与首图固定 | 首图只能 hero，其他页不允许 hero | E-PLAN | 已执行（范围见审计） |
| F-PLAN-003 | 任务详情图片文案规划 | 规划标题、副标题编辑 | 长度、必填 / 选填约束正确 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-004 | 任务详情图片文案规划 | 画面要点多行编辑 | 2–5 条、空行与超长提示及保存确认准确 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-005 | 任务详情图片文案规划 | 画面生成指令编辑 | 内容按正确页面持久化，不丢失 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-006 | 任务详情图片文案规划 | 删除允许的规划页 | 页数边界与首图限制生效 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-007 | 任务详情图片文案规划 | 自动匹配 / 自定义排版 | 模式切换正确，指定人工设计受保护 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-008 | 任务详情图片文案规划 | 自定义标题位置、主体位置、文字区域 | 每个位置选项保存到当前页 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-009 | 任务详情图片文案规划 | 文字对齐、留白及主体占比 | 20–90% 步长与选项正确，示意图同步 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-010 | 任务详情图片文案规划 | 补充布局要求 | 最多 1000 字，保存后保留 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-011 | 任务详情图片文案规划 | 单独保存图片规划 | 创建 / 更新正确规划，不意外通过文案审核 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-012 | 任务详情图片文案规划 | 未保存规划差异定位 | 差异提示可跳到对应页和字段 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-013 | 任务详情图片文案规划 | 重新生成图片文案规划 | 后台状态、费用 / 前置要求及结果正确 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-014 | 任务详情图片文案规划 | 规划生成中关闭弹窗 | 后台继续，通知可找回结果 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-015 | 任务详情图片文案规划 | 载入已完成规划结果 | 显式采用生成结果，原草稿和人工锁定保护生效 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-016 | 任务详情图片文案规划 | 规划生成失败 / 重试 | 错误可见，旧规划保留 | E-PLAN | 已执行（范围见审计） |
| F-PLAN-017 | 任务详情图片文案规划 | 返修规划及提交门禁 | 按允许范围编辑，生图失败返工以正确新版本强制复检 | E-PLAN | 已执行（范围见审计） |

### IREVIEW · 图片初审、返修与集中修改处置

角色 / 条件：ADMIN / USER 当前任务负责人。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-IREVIEW-001 | 任务详情图片初审 / 返修 | 逐页缩略图与当前成品展示 | 页顺序、数量、当前成品版本正确 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-002 | 任务详情图片初审 / 返修 | 放大成品及图片来源链接 | 预览对应图；模拟 / 兜底图标签如实显示 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-003 | 任务详情图片初审 / 返修 | 图片审核备注编辑 | 可选备注保存到对应初审 / 返修，非负责人只读 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-004 | 任务详情图片初审 / 返修 | 查看返修范围、问题页及文案字段 | 当前与历史反馈清楚，绑定正确图集 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-005 | 任务详情图片初审 / 返修 | 首次图片初审完成 | 整套成品完整且无阻塞修改时提交抽检 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-006 | 任务详情图片初审 / 返修 | 图片返修提交强制复检 | 即使无系统内改图也遵循备注及当前版本门禁 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-007 | 任务详情图片初审 / 返修 | 图片编辑期间集中处理修改 | 显示已完成预览、运行中及失败修改 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-008 | 任务详情图片初审 / 返修 | 集中处理逐项采用 / 拒绝 / 暂不处理 | 选择可保存，冲突页与不可采用原因明确 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-009 | 任务详情图片初审 / 返修 | 一键采用已完成修改 | 同页冲突禁止；所有合法预览采用一次 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-010 | 任务详情图片初审 / 返修 | 一键拒绝已完成修改 | 统一拒绝且保留审计 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-011 | 任务详情图片初审 / 返修 | 取消未完成修改 | 仅指定 / 全部运行中修改被取消 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-012 | 任务详情图片初审 / 返修 | 集中处理应用选择及继续初审 | 存在未处置修改时阻止通过，完成后继续 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-013 | 任务详情图片初审 / 返修 | 集中处理刷新与稍后处理 | 状态刷新，关闭保留未完成结果 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-014 | 任务详情图片初审 / 返修 | 旧图片评分、扣分原因和说明 | use-task-review-controller 当前 canReviewImages=false，旧评分面板不挂载；当前评分在独立图片质检页按F-IQA记录 | E-IREVIEW | 不适用（当前旧评分未挂载） |
| F-IREVIEW-015 | 任务详情图片初审 / 返修 | 旧图片审核发起仅图片 / 仅文案 / 双返工 | 旧评分面板不挂载；当前图片质检返工范围按F-IQA-010记录 | E-IREVIEW | 不适用（当前旧返工未挂载） |
| F-IREVIEW-016 | 任务详情图片初审 / 返修 | 图片任务废弃 | 必填说明、取消不废弃、确认后历史保留 | E-IREVIEW | 已执行（范围见审计） |
| F-IREVIEW-017 | 任务详情图片初审 / 返修 | 从失败步骤继续 / 重试生图 / 重新生成 | 重用允许检查点，状态与新版本正确 | E-IREVIEW | 已执行（范围见审计） |

### IPREVIEW · 通用图片大图预览

角色 / 条件：所有可查看对应图片用户。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-IPREVIEW-001 | 任务详情 / 质检 / 交付图片预览 | 打开 / 关闭及 Esc、焦点返回 | 图片加载成功，关闭回到原触发按钮 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-002 | 任务详情 / 质检 / 交付图片预览 | 上一张 / 下一张及键盘导航 | 顺序、边界与当前图片标题正确 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-003 | 任务详情 / 质检 / 交付图片预览 | 透明棋盘 / 浅色 / 深色预览背景 | 只影响预览且偏好保存，不改源文件 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-004 | 任务详情 / 质检 / 交付图片预览 | 100%查看 / 完整显示 / 倍数滑杆 | 缩放范围、倍率和图像显示一致 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-005 | 任务详情 / 质检 / 交付图片预览 | 放大后原生滚动查看边缘 | 操作可用且不会影响页面其他滚动 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-006 | 任务详情 / 质检 / 交付图片预览 | 左 / 右旋转 | 每次 90 度，仅改变预览 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-007 | 任务详情 / 质检 / 交付图片预览 | 恢复预览 | 恢复默认显示模式、100%缩放和0度旋转；没有独立平移参数或平移复位控件 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-008 | 任务详情 / 质检 / 交付图片预览 | 查看处理前源图 | 有源图时切换正确；不混淆正式成品 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-009 | 任务详情 / 质检 / 交付图片预览 | 加载失败重试 | 显示错误，重试仅刷新图片 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-010 | 任务详情 / 质检 / 交付图片预览 | 下载当前图片与打开原图 | 文件对应当前授权资产 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-011 | 任务详情 / 质检 / 交付图片预览 | 历史版本选择与并列对比 | 旧 / 当前图正确，版本标签准确 | E-IPREVIEW | 已执行（范围见审计） |
| F-IPREVIEW-012 | 任务详情历史图片对照面板（LazyImageHistory） | 恢复历史格式与背景参数 | 选择历史版本后，实际“恢复此版本的格式与背景参数”按钮回传该版本参数；ImagePreview本身不提供此动作 | E-IPREVIEW | 已执行（范围见审计） |

### EDIT · 任务内与独立图片编辑器共用功能

角色 / 条件：ADMIN / USER 对应工作空间权限。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-EDIT-001 | 任务详情图片编辑；/image-editor | 添加文字 / 实体替换 / 局部修改页签 | 编辑方式切换，表单及预览正确 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-002 | 任务详情图片编辑；/image-editor | 当前图 / 修改预览 / 前后对比 | 未生成结果禁用相应入口，图片版本准确 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-003 | 任务详情图片编辑；/image-editor | 预览 / 编辑 / 记录移动页签与桌面面板 | 布局可用，状态不丢失 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-004 | 任务详情图片编辑；/image-editor | 预览缩放与前后对比滑块 | 倍率和遮罩对齐正确 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-005 | 任务详情图片编辑；/image-editor | 添加文字：程序叠加与图片模型融合 | 程序方式不调用模型；模型方式显示费用确认 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-006 | 任务详情图片编辑；/image-editor | 添加文字：描边 / 实心徽章 | 风格、透明区域及对比度符合选择 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-007 | 任务详情图片编辑；/image-editor | 程序配色：自动 / 自定义 | 按图主题或指定色正确生成 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-008 | 任务详情图片编辑；/image-editor | 程序配色：取色器与颜色值 | 有效十六进制颜色可用，无效颜色提示并禁提交 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-009 | 任务详情图片编辑；/image-editor | 程序配色：屏幕取色 | 仅支持的安全浏览器显示；选色 / 取消 / 失败可恢复 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-010 | 任务详情图片编辑；/image-editor | 人工标识文字与最近常用 | 最多 12 字允许字符；最近成功使用 5 条可复用 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-011 | 任务详情图片编辑；/image-editor | 标识应用逐页选择 / 全选 / 清空 | 选择数量正确，空选择禁止生成 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-012 | 任务详情图片编辑；/image-editor | 标识逐页预览 | 当前预览图与已选应用范围独立正确 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-013 | 任务详情图片编辑；/image-editor | 程序标识提交 | 生成整套预览，明确程序来源 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-014 | 任务详情图片编辑；/image-editor | 模型标识费用确认及提交 | 未确认禁提交；结果验收绑定当前原图 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-015 | 任务详情图片编辑；/image-editor | 标识批次状态及一次采用 | 所有预览就绪且合法才能采用，部分采用可继续剩余 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-016 | 任务详情图片编辑；/image-editor | 真实产品参考图上传 / 更换 / 移除 | PNG / JPEG / WebP、最大 5 MiB 校验，引用清理 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-017 | 任务详情图片编辑；/image-editor | 添加第二至第四产品与移除 | 上限 4 个，每个参考图和应用页独立 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-018 | 任务详情图片编辑；/image-editor | 严格完整产品 / 外观参考模式 | 模式发送正确；模型前置提醒符合设定 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-019 | 任务详情图片编辑；/image-editor | 产品逐页应用、切页及框选 | 每个产品每页目标区域独立持久化 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-020 | 任务详情图片编辑；/image-editor | 只替换一个 / 框内全部同款 | 模式及目标识别范围正确，不串用参考图 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-021 | 任务详情图片编辑；/image-editor | 目标物品说明及重新框选 | 说明 500 字限制与选区校验生效 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-022 | 任务详情图片编辑；/image-editor | 产品费用确认并提交单图 / 多图批次 | 构建正确每页请求，阻止空目标 / 缺参考图 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-023 | 任务详情图片编辑；/image-editor | 产品替换执行前提醒 | 提醒不错误阻止现有允许调用条件 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-024 | 任务详情图片编辑；/image-editor | 实体批次一次采用全部 | 完整结果验收通过才允许，原资产更新与审计一致 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-025 | 任务详情图片编辑；/image-editor | 局部修改点击目标定位 / 清除 | 定位准确，清除不保留旧坐标 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-026 | 任务详情图片编辑；/image-editor | 局部修改动作选择 / 取消 | 当前动作与要求正确组合 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-027 | 任务详情图片编辑；/image-editor | 局部修改补充要求与快捷要求 | 最多 2000 字，内容追加不覆盖 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-028 | 任务详情图片编辑；/image-editor | 局部修改费用确认并提交 | 生成后台预览，原成品在采用前保留 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-029 | 任务详情图片编辑；/image-editor | 本次编辑 / 编辑记录切换及刷新 | 每页编辑历史、状态、时间对应当前页面 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-030 | 任务详情图片编辑；/image-editor | 生成恢复历史图集预览 | 只生成恢复候选；采用前不覆盖当前图 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-031 | 任务详情图片编辑；/image-editor | 历史结果在左侧对比 / 打开结果 | 对应选定编辑，失败结果明确标识 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-032 | 任务详情图片编辑；/image-editor | 采用单条预览及必填操作原因 | 正式资产与图集 lineage 更新，空原因禁止 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-033 | 任务详情图片编辑；/image-editor | 拒绝预览及取消原因弹窗 | 拒绝审计正确，取消不改变结果 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-034 | 任务详情图片编辑；/image-editor | 取消排队 / 运行中修改 | 取消信号、后台通知及终态正确 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-035 | 任务详情图片编辑；/image-editor | 失败重试 / 定向修复 | 原因与额外模型费用确认生效 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-036 | 任务详情图片编辑；/image-editor | 局部修改失败的替代描述方案 | 可选方案清楚，采用后重新生成不混入旧说明 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-037 | 任务详情图片编辑；/image-editor | 复用说明并修改 | 原编辑说明和定位正确载入，允许新提交 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-038 | 任务详情图片编辑；/image-editor | 质量校验记录、失败原因和操作审计展开 | 来源、结论与操作者准确且不暴露凭证 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-039 | 任务详情图片编辑；/image-editor | 背景运行后离开、返回及刷新 | 预览请求可恢复，未误报已采用 | E-EDIT | 已执行（范围见审计） |
| F-EDIT-040 | 任务详情图片编辑；/image-editor | 只读 / 运行中工作空间 | 不允许上传、修改、采用或删除越权内容 | E-EDIT | 已执行（范围见审计） |

### STAND · 独立图片工作空间

角色 / 条件：ADMIN / USER。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-STAND-001 | /image-editor | 图片列表加载、状态和失败原因 | 名称、页数、状态和当前所属账号正确 | E-STAND | 已执行（范围见审计） |
| F-STAND-002 | /image-editor | 新增图片弹窗及名称 | 可选名称最多 200 字，取消不创建残留工作空间 | E-STAND | 已执行（范围见审计） |
| F-STAND-003 | /image-editor | 多图上传与进度 | 满足显示格式、尺寸、数量和大小限制，进度清楚 | E-STAND | 已执行（范围见审计） |
| F-STAND-004 | /image-editor | 错误 MIME / 损坏 / 超限 / 错误尺寸图片 | 拒绝并明确错误，不部分污染资产 | E-STAND | 已执行（范围见审计） |
| F-STAND-005 | /image-editor | 上传进行中的关闭和重复操作保护 | 忙碌时Escape/遮罩不能关闭、关闭图标隐藏，不可重复提交；当前没有取消上传功能 | E-STAND | 已执行（范围见审计） |
| F-STAND-006 | /image-editor | 完成上传及逐页按钮 | 工作空间建立，页数与上传顺序一致 | E-STAND | 已执行（范围见审计） |
| F-STAND-007 | /image-editor | 查看 / 编辑已有工作空间 | 完整加载同一编辑器和历史 | E-STAND | 已执行（范围见审计） |
| F-STAND-008 | /image-editor | 独立工作空间修改结果采用 | 只影响当前空间，不污染正式任务交付 | E-STAND | 已执行（范围见审计） |
| F-STAND-009 | /image-editor | 运行中查看限制 | 只读可查看，删除 / 编辑禁用 | E-STAND | 已执行（范围见审计） |
| F-STAND-010 | /image-editor | 列表刷新及 20 条分页 | 总量正确，末页删除自动回退 | E-STAND | 已执行（范围见审计） |
| F-STAND-011 | /image-editor | 单条删除与取消确认 | 只删除授权非运行空间，取消保留 | E-STAND | 已执行（范围见审计） |
| F-STAND-012 | /image-editor | 本页单选 / 全选与批量删除取消、确认、失败 | 固定20条当前页内选择，运行中禁选；取消不提交，失败提示并重读；没有独立超20选择或逐项部分失败面板 | E-STAND | 已执行（范围见审计） |
| F-STAND-013 | /image-editor | 编辑器载入失败重新加载 | 可恢复页面，不静默空白 | E-STAND | 已执行（范围见审计） |

### WORK · 作业模式专注队列

角色 / 条件：工作类型由角色和权限开关决定。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-WORK-001 | /work-mode | 文案审核 / 图片初审 / 文案质检 / 图片质检类型切换 | 仅显示有权限类型，数量和首个待办正确 | E-WORK | 已执行（范围见审计） |
| F-WORK-002 | /work-mode | 文案质检分类：全部 / 第一次抽检 / 强制复检 | 队列及数量对应类型 | E-WORK | 已执行（范围见审计） |
| F-WORK-003 | /work-mode | 待办刷新、重试和加载更多 | 无重复漏项，失败保留已有成功提交 | E-WORK | 已执行（范围见审计） |
| F-WORK-004 | /work-mode | 已加载待办关键词搜索 | 筛选范围明确，不误称全库搜索 | E-WORK | 已执行（范围见审计） |
| F-WORK-005 | /work-mode | 展开 / 收起待办侧栏 | 布局和数量保持，偏好正确恢复 | E-WORK | 已执行（范围见审计） |
| F-WORK-006 | /work-mode | 点击队列任务及 URL 直接定位 | 可定位未加载页任务，分页不跳过其他任务 | E-WORK | 已执行（范围见审计） |
| F-WORK-007 | /work-mode | 暂跳过 | 进入下一项，不增加已提交数量 | E-WORK | 已执行（范围见审计） |
| F-WORK-008 | /work-mode | 保存草稿与导航确认 | 可保存未提交修改；草稿不计已提交 | E-WORK | 已执行（范围见审计） |
| F-WORK-009 | /work-mode | 审核 / 质检提交并下一条 | 服务端成功后只移除当前项，下一待办正确 | E-WORK | 已执行（范围见审计） |
| F-WORK-010 | /work-mode | 本次已提交记录展开 / 收起 | 只含真实成功提交，最新在前 | E-WORK | 已执行（范围见审计） |
| F-WORK-011 | /work-mode | 文案质检规划翻页 | 查看当前最终稿绑定规划，页边界正确 | E-WORK | 已执行（范围见审计） |
| F-WORK-012 | /work-mode | 图片质检缩略图、背景、放大及当前页问题标记 | 当前页与问题页选择正确 | E-WORK | 已执行（范围见审计） |
| F-WORK-013 | /work-mode | 强制复检上次退回说明 | 上次问题标签、具体说明和范围可见 | E-WORK | 已执行（范围见审计） |
| F-WORK-014 | /work-mode | 质检打回表单及返回核验 | 必填条件正确，取消不提交 | E-WORK | 已执行（范围见审计） |
| F-WORK-015 | /work-mode | 质检通过并下一条 | 有待完成图片编辑时禁通过，成功只提交一次 | E-WORK | 已执行（范围见审计） |
| F-WORK-016 | /work-mode | 复检提交管理员 | 具体原因必填，进入二次分配且统计保留 | E-WORK | 已执行（范围见审计） |
| F-WORK-017 | /work-mode | 质检废弃图片任务 | 明确原因后退出待办，保留审计 | E-WORK | 已执行（范围见审计） |
| F-WORK-018 | /work-mode | 空队列刷新及权限变化 | 显示合理空状态 / 被阻塞状态，不可越权处理 | E-WORK | 已执行（范围见审计） |

### CFLOW · 文案工作入口与批次创建

角色 / 条件：ADMIN；直接访问按 canAccessWorkflowPage 实现校验。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-CFLOW-001 | /copy-flow | 个人模式 / 混合模式页签 | 候选范围、选择及状态正确切换 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-002 | /copy-flow | 按用户列表查看待入批任务 | 待入批、自动成批、全量质检配置正确 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-003 | /copy-flow | 选择用户任务与返回用户列表 | 只加载目标用户，返回重置选择 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-004 | /copy-flow | 入批单选 / 全选 | 质检样本必须属于成员；取消成员同步取消样本 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-005 | /copy-flow | 质检项单选 / 全选 | 选择样本同时加入成员 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-006 | /copy-flow | 个人手动创建批次 | 成员和样本冻结，确认取消不创建 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-007 | /copy-flow | 按比例随机抽检并创建 | 遵循账号比例与全量质检策略 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-008 | /copy-flow | 混合手动创建批次 | 多审核人成员及样本正确冻结 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-009 | /copy-flow | 零选择、刷新及重复点击 | 无成员禁止；加载不覆盖选择；请求防重复 | E-CFLOW | 已执行（范围见审计） |
| F-CFLOW-010 | /copy-flow | 创建成功后进入文案质检 | 显示准确批次名称，可找到对应新批次 | E-CFLOW | 已执行（范围见审计） |

### CQA · 文案质检批次与明细

角色 / 条件：ADMIN 或 copyQcEnabled。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-CQA-001 | /copy-qa | 待质检 / 已完成批次切换 | 状态、数量、成员数、样本数及批次模式正确 | E-CQA | 已执行（范围见审计） |
| F-CQA-002 | /copy-qa | 列表刷新及 20 条分页 | 分页边界正确，错误可见 | E-CQA | 已执行（范围见审计） |
| F-CQA-003 | /copy-qa | 进入批次与返回列表 | 正确明细及汇总；返回刷新列表 | E-CQA | 已执行（范围见审计） |
| F-CQA-004 | /copy-qa | 批次本页刷新及 50 条明细分页 | 不重复漏项，当前项关闭后翻页 | E-CQA | 已执行（范围见审计） |
| F-CQA-005 | /copy-qa | 查看并质检 / 查看文案 | 待处理项可操作；完成项只读 | E-CQA | 已执行（范围见审计） |
| F-CQA-006 | /copy-qa | 最终稿与逐页图片规划对照 | 绑定冻结的人工最终稿与版本指纹 | E-CQA | 已执行（范围见审计） |
| F-CQA-007 | /copy-qa | 独立盲评 | 隐藏任务 ID、Query、审核人等禁止信息 | E-CQA | 已执行（范围见审计） |
| F-CQA-008 | /copy-qa | 质检通过及确认取消 | 确认后通过；取消不改状态 | E-CQA | 已执行（范围见审计） |
| F-CQA-009 | /copy-qa | 单条打回：原因标签分类展开 / 多选 | 所选问题标签正确提交 | E-CQA | 已执行（范围见审计） |
| F-CQA-010 | /copy-qa | 单条打回：说明及空原因校验 | 至少标签或说明，错误不丢输入 | E-CQA | 已执行（范围见审计） |
| F-CQA-011 | /copy-qa | 确认单条驳回 | 绑定当前 revisionToken 并更新批次 | E-CQA | 已执行（范围见审计） |
| F-CQA-012 | /copy-qa | 批次驳回率阈值及全量质检差异 | 达到阈值自动处置剩余成员，全量模式逐项完成 | E-CQA | 已执行（范围见审计） |
| F-CQA-013 | /copy-qa | 废弃任务理由、必填说明及二次确认 | 取消保留；废弃不计批次驳回率 | E-CQA | 已执行（范围见审计） |
| F-CQA-014 | /copy-qa | 已废弃详情及历史记录 | 理由、说明、最终稿仍可读 | E-CQA | 已执行（范围见审计） |
| F-CQA-015 | /copy-qa | 重复提交 / 陈旧版本 / 自己审核样本 | 防重复及版本 / 自检权限约束生效 | E-CQA | 已执行（范围见审计） |

### IQA · 图片质检队列

角色 / 条件：ADMIN 或 REVIEWER + imageQcEnabled。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-IQA-001 | /image-qa | 待质检 / 已通过 / 已打回 / 全部 / 已提交管理员 / 已废弃 | 每个页签范围与统计正确 | E-IQA | 已执行（范围见审计） |
| F-IQA-002 | /image-qa | 刷新、重新检查、返回待质检 | 列表和状态更新，空态正常 | E-IQA | 已执行（范围见审计） |
| F-IQA-003 | /image-qa | 管理员人员姓名 / 账号筛选及清除 | 对应实际图片提交人，非管理员不可扩大范围 | E-IQA | 已执行（范围见审计） |
| F-IQA-004 | /image-qa | 上一页 / 下一页 | 分页与总数正确 | E-IQA | 已执行（范围见审计） |
| F-IQA-005 | /image-qa | 查看图片弹窗及页缩略图 | 只显示当前最终成品，源图 / 历史图不计页数 | E-IQA | 已执行（范围见审计） |
| F-IQA-006 | /image-qa | 大图、背景和页码导航 | 对应当前质检资产 | E-IQA | 已执行（范围见审计） |
| F-IQA-007 | /image-qa | 盲评 / 非盲评信息 | 敏感身份按配置隐藏，管理员可见范围符合权限 | E-IQA | 已执行（范围见审计） |
| F-IQA-008 | /image-qa | 质检通过 | 按当前版本放行门禁，完成编辑前禁通过 | E-IQA | 已执行（范围见审计） |
| F-IQA-009 | /image-qa | 打回评分 1 / 2 与返工范围 | 仅图 / 仅文案 / 双返工提交正确 | E-IQA | 已执行（范围见审计） |
| F-IQA-010 | /image-qa | 问题原因多选及具体修改要求 | 必填及长度验证准确 | E-IQA | 已执行（范围见审计） |
| F-IQA-011 | /image-qa | 问题图片选择 | 图片返工至少一张，页码准确 | E-IQA | 已执行（范围见审计） |
| F-IQA-012 | /image-qa | 返工文案标题 / 正文 / 标签 / 图片规划字段 | 文案返工至少一项 | E-IQA | 已执行（范围见审计） |
| F-IQA-013 | /image-qa | 确认单条打回与取消 | 目标任务进入返工，取消不写入 | E-IQA | 已执行（范围见审计） |
| F-IQA-014 | /image-qa | 整批图片打回 | 权限及开关生效，范围与所有受影响任务正确 | E-IQA | 已执行（范围见审计） |
| F-IQA-015 | /image-qa | 旧强制复检提交管理员动作 | 当前没有提交管理员按钮；仅保留ADMIN_ESCALATED状态过滤和历史展示，按队列筛选用例记录 | E-IQA | 不适用（当前升级提交未挂载） |
| F-IQA-016 | /image-qa | 图片任务废弃 | 退出图片待办，历史图和原因保留 | E-IQA | 已执行（范围见审计） |
| F-IQA-017 | /image-qa | 陈旧图集 / 多人并发处置 | 拒绝陈旧结论，不错误放行 | E-IQA | 已执行（范围见审计） |

### REASSIGN · 待二次分配管理员处置

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-REASSIGN-001 | /reassignment | 待处理 / 已重新分配 / 已废弃 / 全部记录 | 状态筛选和数量正确 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-002 | /reassignment | 刷新、重新加载及分页 | 无重复漏项，失败可恢复 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-003 | /reassignment | 查看处置 / 查看记录 | 原操作者、移交原因与准备状态准确 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-004 | /reassignment | 重试还原 / 清理 | 使用可信机器初稿，失败原因与可分配状态更新 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-005 | /reassignment | 缺少初稿重新生成初始数据 | 模型状态可追踪，完成前禁止分配 / 删除 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-006 | /reassignment | 查看初始数据与分配记录 | 旧修改清理状态及责任历史真实 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-007 | /reassignment | 选择接手账号、账号载入失败重试 | 只有适用已启用账号可选 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-008 | /reassignment | 确认二次分配及原因校验 | 完成还原 / 清理后可分配，新负责人重新完整审核 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-009 | /reassignment | 最终废弃与取消 | 必填原因，任务退出流程并保留记录 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-010 | /reassignment | 撤销废弃恢复待二次分配 | 原因必填，恢复正确准备状态 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-011 | /reassignment | 本页单选 / 全选 / 清空 | 只能选择待处理且非生成中任务 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-012 | /reassignment | 批量分配 | 统一接手人 / 原因，逐条成功失败反馈 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-013 | /reassignment | 批量重试还原 / 清理 | 逐条操作结果，失败项保留选择 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-014 | /reassignment | 批量废弃及取消 | 统一原因审计，取消不执行 | E-REASSIGN | 已执行（范围见审计） |
| F-REASSIGN-015 | /reassignment | 二次分配后的新作业提示 | 新账号可见历史质检反馈，历史贡献不转移 | E-REASSIGN | 已执行（范围见审计） |

### DELIVERY · 共享交付池及文件记录

角色 / 条件：ADMIN 全池 / USER 当前账号。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-DELIVERY-001 | /delivery-pool；个人统计交付记录弹窗 | 当前交付内容 / 交付记录含历史版本 | 视图与当前 / 历史版本一致 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-002 | /delivery-pool；个人统计交付记录弹窗 | 全部 / 未交付 / 已交付 / 版本更新待重交卡片 | 统计范围与点击后的列表正确 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-003 | /delivery-pool；个人统计交付记录弹窗 | 交付状态全部选项筛选 | 未交付、待打包、已打包待交付、已交付范围正确 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-004 | /delivery-pool；个人统计交付记录弹窗 | 日期依据选择与起止日期 | 可交付、打包、确认、最近变更按北京时间过滤 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-005 | /delivery-pool；个人统计交付记录弹窗 | 今天 / 昨天 / 7 天 / 30 天 / 不限日期 | 日期快捷范围正确 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-006 | /delivery-pool；个人统计交付记录弹窗 | 任务号 / Query / 批次号搜索 | 命中范围正确，重置恢复初始条件 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-007 | /delivery-pool；个人统计交付记录弹窗 | 版本情况筛选 | 历史 / 更新待重交与当前版本事实一致 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-008 | /delivery-pool；个人统计交付记录弹窗 | 负责人 / 打包人 / 确认人筛选及清除 | 管理员人员范围和卡片统计一致 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-009 | /delivery-pool；个人统计交付记录弹窗 | 管理员汇总保存、精确词包名、甲方批次筛选 | 过滤正确，USER 无扩大范围入口 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-010 | /delivery-pool；个人统计交付记录弹窗 | 选择本页 / 单选 / 清空 | 最多 200 条，跨页选中与当前版本键一致 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-011 | /delivery-pool；个人统计交付记录弹窗 | 打包并下载 | 冻结正确图文版本，生成批次和可下载包 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-012 | /delivery-pool；个人统计交付记录弹窗 | 下载所选冻结内容 | 既有冻结版本准确，生成状态与自动下载 / 重新下载卷可用 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-013 | /delivery-pool；个人统计交付记录弹窗 | 确认所选已交付 | 只有已本人下载的允许条目可确认，确认记录归实际账号 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-014 | /delivery-pool；个人统计交付记录弹窗 | 汇总保存已交付内容 | 管理员范围正确，异步生成文件 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-015 | /delivery-pool；个人统计交付记录弹窗 | 选择全部筛选已交付结果 | 最多 2000 条，只用于允许的汇总保存 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-016 | /delivery-pool；个人统计交付记录弹窗 | 刷新与每 15 秒自动同步 | 状态及时更新，不覆盖当前用户选择 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-017 | /delivery-pool；个人统计交付记录弹窗 | 分页及每页 20 / 50 / 100 | 总数、范围、页码正确 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-018 | /delivery-pool；个人统计交付记录弹窗 | 文件记录展开 / 收起与分页 | 只显示可访问下载 / 汇总任务 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-019 | /delivery-pool；个人统计交付记录弹窗 | 成功文件多卷下载 | 各卷内容完整，下载次数更新 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-020 | /delivery-pool；个人统计交付记录弹窗 | 失败文件按原范围重试 | 冻结范围不变化，不扩大任务集 | E-DELIVERY | 已执行（范围见审计） |
| F-DELIVERY-021 | /delivery-pool；个人统计交付记录弹窗 | 版本更新 / 改派 / 删除后的历史交付 | 保留历史冻结记录，当前门禁正确 | E-DELIVERY | 已执行（范围见审计） |

### DLEGACY · 图文预览、预览发布与原始批次工具

角色 / 条件：ADMIN；USER 部分。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-DLEGACY-001 | /delivery-pool（折叠工具区） | 展开工具区及内容 / 预览上传 / 交付历史页签 | 角色可见页签正确，工作区不混用选择 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-002 | /delivery-pool（折叠工具区） | 多行搜索、清除、甲方批次和交付状态 | 输入范围、待交付 / 已打包 / 全部过滤正确 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-003 | /delivery-pool（折叠工具区） | 内容选择与加载更多 | 只选择已加载合法结果，无重复漏项 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-004 | /delivery-pool（折叠工具区） | 图文预览弹窗 | 最终标题、正文、标签及图片完整 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-005 | /delivery-pool（折叠工具区） | 图文预览上一页 / 下一页 / 缩略图 | 页顺序与对应文件正确 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-006 | /delivery-pool（折叠工具区） | 导出已选 / 全部文章与图片 Excel | 表格与图片链接 / 内容对应，不混入测试任务 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-007 | /delivery-pool（折叠工具区） | 新建全部待交付 / 已选 / 单条批次 | 冻结版本及范围正确，USER 只打包本人 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-008 | /delivery-pool（折叠工具区） | 重下原批次 / 下载本条 | 权限正确，历史压缩包不被新版本覆盖 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-009 | /delivery-pool（折叠工具区） | 预览上传范围搜索、勾选当前结果和清空 | 词包 / 历史未归属范围与任务选择独立 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-010 | /delivery-pool（折叠工具区） | 整包上传条数上限 | 1 条测试及其他允许上限生效 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-011 | /delivery-pool（折叠工具区） | 上传这一条 / 上传已选 / 整包上传 | 在隔离测试目标验证请求与状态；生产发布须遵守仓库授权边界 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-012 | /delivery-pool（折叠工具区） | 已发布预览打开 | URL 对应正确公开预览，撤销状态不误称可访问 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-013 | /delivery-pool（折叠工具区） | 交付历史查看明细、关闭和下载 | 批次范围、冻结版本、sha256 及下载次数正确 | E-DLEGACY | 已执行（范围见审计） |
| F-DLEGACY-014 | /delivery-pool（折叠工具区） | 交付门禁与测试任务隔离 | 只有 READY 且图文匹配、图片质检放行的正式内容出现 | E-DLEGACY | 已执行（范围见审计） |

### PROMPT · 提示词版本与执行配置

角色 / 条件：ADMIN；中心 / 本机模式分别验证。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-PROMPT-001 | /prompts | 提示词目录搜索与选择 | 名称、类型、业务阶段定位正确 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-002 | /prompts | 分组选择、业务类型页签及快捷编辑 Query 规则 | 所有实际目录项可打开，标题匹配 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-003 | /prompts | 页签键盘导航及切换保留编辑 | 方向 / Home / End 有效，未提交内容不丢 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-004 | /prompts | 业务规则编辑与程序协议只读 | 只读协议不能提交；业务规则可修改 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-005 | /prompts | 保存草稿 | 生成正确草稿版本，不自动发布 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-006 | /prompts | 提交更新 / 创建新版本并发布 | 当前发布版本切换，运行中任务冻结原版本 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-007 | /prompts | 放弃修改确认及取消 | 确认恢复当前发布内容；取消保留 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-008 | /prompts | 历史版本展开 / 载入编辑 | 完整内容和元数据准确，载入不立即发布 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-009 | /prompts | 本机重新发布历史版本 | 明确确认，版本状态及运行快照一致 | E-PROMPT | 条件分支（本机模式，当前中心界面不适用） |
| F-PROMPT-010 | /prompts | 中心刷新、陈旧 baseId 冲突 | 旧编辑保留并提示，禁止覆盖最新发布 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-011 | /prompts | 提示词优化约束提示 | 缺失关键规则可见，限制符合当前实现 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-012 | /prompts | 预检及变量展开示例 Query | 不调用模型，展示展开和契约错误 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-013 | /prompts | 准备缺失候选草稿 | 只补缺失候选，可刷新目录找到 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-014 | /prompts | 启用 Query 筛选 / 视觉规划 | 策略正确保存，不影响运行快照 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-015 | /prompts | 案例入选分数及文案修复上下限 | 0–100 / 400–600 等范围和上下限关系验证 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-016 | /prompts | OCR 最低置信度和比较方式 | 范围 0–1，与两种比较策略正确保存 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-017 | /prompts | 检查版本并启用统一规则 / 保存执行配置 | 缺版本和无效策略阻止，保存后来源及启用状态准确 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-018 | /prompts | 执行记录位置、本机 / 中心选择与刷新最近 50 次 | 数据来源及数量正确 | E-PROMPT | 已执行（范围见审计） |
| F-PROMPT-019 | /prompts | 打开执行记录 | 阶段、实际提示词、模型调用和错误证据对应正确执行 | E-PROMPT | 已执行（范围见审计） |

### KNOW · 当前文案知识库

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-KNOW-001 | /knowledge | 知识库使用总开关 | 后续任务引用开关正确保存，不删除既有内容 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-002 | /knowledge | 新增文案分析弹窗与取消 | 表单可用，取消不调用模型 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-003 | /knowledge | 优秀文案及分析 Prompt 输入 | 非空、长度约束生效，外部文本不执行指令 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-004 | /knowledge | 载入已保存分析 Prompt | 选择正确历史规则填入，提示准确 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-005 | /knowledge | 保存新的分析 Prompt | 名称 / 内容校验，新增后可载入 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-006 | /knowledge | 同类 Prompt 替换目标选择及确认 | 替换正确条目，取消不变化 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-007 | /knowledge | 调用模型分析并自动入库 | 结果有标题、摘要、全文、分类标签，失败可见 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-008 | /knowledge | 全部 / 分类标签及展开更多标签 | 过滤范围、标签数量及选中状态正确 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-009 | /knowledge | 分析标题搜索 | Unicode / 长度及无结果正常 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-010 | /knowledge | 查看分析详情与关闭 | 优秀文案、Prompt、完整分析正确 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-011 | /knowledge | 编辑分析各字段并保存 | 标题、原文、Prompt、摘要、全文、标签合法持久化 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-012 | /knowledge | 编辑取消 / 无效内容 | 取消不更改，必填限制生效 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-013 | /knowledge | 删除文案分析确认与取消 | 删除后数量和页码更新；取消保留 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-014 | /knowledge | 每页 10 / 20 / 50 与分页 | 总数、标签及搜索参数一致 | E-KNOW | 已执行（范围见审计） |
| F-KNOW-015 | /knowledge | 读取失败重新加载 | 提示可读，失败不覆盖知识库 | E-KNOW | 已执行（范围见审计） |

### SETTING · 生产配置全部可见分区

角色 / 条件：ADMIN；中心 / 本机模式。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-SETTING-001 | /settings | 生成与模型 / 质量与审核 / 图片与输出 / 兼容与高级 | 所有页签可切，未保存状态保留 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-002 | /settings | 搜索主服务：继承 / 豆包 / DeepSeek / Codex | 实际生效与继承显示正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-003 | /settings | 备用搜索新增 / 移除 / 上移 / 下移 | 不重复服务，保存顺序正确；没有独立“恢复默认顺序”按钮，恢复环境属于F-SETTING-006 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-004 | /settings | DeepSeek 搜索模型、超时及来源数量 | 长度和数值范围校验，继承有效 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-005 | /settings | 豆包 Custom / Global 及 ICP 范围 | 模式字段正确，非适用项禁用 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-006 | /settings | 搜索恢复环境 / 首次读取失败重新读取 | 只恢复该模块配置，失败可恢复；没有独立“撤销修改”按钮 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-007 | /settings | 保存搜索配置及失败恢复 | 保存新配置，失败保留草稿；此接口没有expectedVersion字段，不虚构版本冲突按钮或协议（流程版本冲突见F-SETTING-028） | E-SETTING | 已执行（范围见审计） |
| F-SETTING-008 | /settings | 小红书搜索开关及关闭确认 | 状态、登录节点及待处理搜索提示正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-009 | /settings | 小红书极速 / 深度排序模式 | 模式及链接数生效 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-010 | /settings | 小红书链接数、最短间隔、60 分钟 / 24 小时限额 | 整数范围与组合校验正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-011 | /settings | 小红书恢复默认节奏 / 保存 / 重新读取 | 默认值准确，保存后刷新一致 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-012 | /settings | 文案提供方继承 / Codex / Dots | 提供方、当前默认值及权限显示正确 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-013 | /settings | Dots API 地址与模型 | 格式 / 长度验证，凭证仅展示是否配置 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-014 | /settings | 文案思考强度全部选项 | 继承及 minimal 至 max 正确保存 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-015 | /settings | 文本生成模型选择 | 保存覆盖 / 清空继承，当前值显示准确 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-016 | /settings | 需求检测模型选择 | 独立保存对应阶段 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-017 | /settings | 阶段审核模型选择 | 独立保存对应阶段 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-018 | /settings | 视觉验收模型选择 | 独立保存对应阶段 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-019 | /settings | 独立终审模型选择 | 独立保存对应阶段 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-020 | /settings | 图片生成模型选择 | 只使用允许图片模型 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-021 | /settings | 容量备用模型与主模型满载冷却 | 范围及当前有效配置正确 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-022 | /settings | 文本视觉代理 / 图片代理 / 图片调用超时 | URL 禁止凭证、允许范围生效 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-023 | /settings | 恢复环境配置及保存模型配置 | 只清空页面覆盖，显式保存后生效 | E-SETTING | 条件分支已执行（本机控件浏览器；当前中心未挂载） |
| F-SETTING-024 | /settings | 流程文案抽检开关 / 独立盲评 / 默认比例 | 0–100% 含小数保存，盲评信息正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-025 | /settings | 文案批次自动驳回阈值 | 比例范围与新批次行为一致 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-026 | /settings | 图片抽检开关 / 盲评 / 比例 | 按新任务 / 批次冻结，既有记录保留 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-027 | /settings | 允许质检员整批图片打回 | 权限开关与质检按钮一致 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-028 | /settings | 流程撤销 / 重新读取 / 保存 | 不同模块不覆盖，失败禁用空配置保存 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-029 | /settings | 评分档位名称、说明及显示开关 | 不能新增档位或改变分数，可保存文字 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-030 | /settings | 文案 / 图片扣分原因及展示开关 | 每组最多 10 项、每项最多 50 字，开启图片原因需非空 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-031 | /settings | 文案 / 图片评分说明占位提示 | 只作提示，不预填真实审核说明 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-032 | /settings | 保存人工评分标准 | 空值 / 超限禁提交，保存后审核页面读取新值 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-033 | /settings | 自动返修开关、触发分数、目标分数和 0–2 次 | 目标高于触发值，自动修复上限正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-034 | /settings | 保存返修策略 | 运行任务旧快照保持，新任务取新策略 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-035 | /settings | 布局模板搜索、分类、启用状态 | 筛选准确，刷新和分页每页选项有效 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-036 | /settings | 布局模型规划 / 匹配随机选择方式 | 保存后后续视觉规划行为正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-037 | /settings | 布局模板启用 / 禁用 | 只修改对应模板版本，刷新保留 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-038 | /settings | 编辑布局新版本 / 取消 | 名称、语义、适用内容、条目上下限及视觉规则可维护 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-039 | /settings | 保存布局新版本 | 版本递增，旧任务版式保留 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-040 | /settings | 批量导入模板 JSON 文件 / 文本 | 1 MB 与 JSON schema、版本冲突验证，整批原子性 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-041 | /settings | 导入内置 27 模板与查看当前 JSON | 模板目录准确，重复导入处理正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-042 | /settings | 模型生成布局候选并自动入库 | 未启用候选，使用实际规则来源，失败不破坏目录 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-043 | /settings | 图片模型标识单次生成说明 | 只读 0 自动修复次数，旧值不误导为运行策略 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-044 | /settings | AI 生成标识开关 / 文字及保存交付配置 | 12 字允许字符校验，任务级水印继承正确 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-045 | /settings | 旧版布局添加 / 编辑 / 参与随机 / 删除 | 名称、页面类型、布局参数及最大 50 项限制 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-046 | /settings | 保存旧版布局配置 | 仅对应兼容项保存，不覆盖模板目录 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-047 | /settings | 中心其他配置 JSON 保存新版本 | 无效 JSON 拒绝，凭证不可写入，独立模块不重复覆盖 | E-SETTING | 已执行（范围见审计） |
| F-SETTING-048 | /settings | 各分区未保存提示、忙碌禁用和重新读取 | 模块状态准确，失败不替换真实值为空默认 | E-SETTING | 已执行（范围见审计） |

### USER · 用户管理与自动分配人员池

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-USER-001 | /users | 账号与权限 / 自动分配池页签及顶部概览 | 用户、启用数、待分配数、可用成员准确 | E-USER | 已执行（范围见审计） |
| F-USER-002 | /users | 用户姓名 / 账号搜索、角色 / 状态筛选和分页 | 组合范围正确，空态和边界正常 | E-USER | 已执行（范围见审计） |
| F-USER-003 | /users | 新增用户基础信息 | 账号 3–50 合法字符、姓名必填、角色正确，初始密码需修改 | E-USER | 已执行（范围见审计） |
| F-USER-004 | /users | 新增重复 / 无效账号与取消 | 校验明确，不创建错误用户 | E-USER | 已执行（范围见审计） |
| F-USER-005 | /users | 编辑姓名、角色、启用 / 停用状态 | 保存刷新正确，当前用户安全限制生效 | E-USER | 已执行（范围见审计） |
| F-USER-006 | /users | 文案审核权限开关 | Query、初审和工作类型入口同步授权 | E-USER | 已执行（范围见审计） |
| F-USER-007 | /users | 文案质检权限开关 | 批次和作业模式权限正确 | E-USER | 已执行（范围见审计） |
| F-USER-008 | /users | 图片质检权限开关 | 仅 REVIEWER 可授予，角色变化撤销不适用权限 | E-USER | 已执行（范围见审计） |
| F-USER-009 | /users | 账号文案抽检继承 / 单独配置 | 0–100% 两位小数及新批次冻结正确 | E-USER | 已执行（范围见审计） |
| F-USER-010 | /users | 自动文案成批开关和 1–5000 数量 | 达到阈值按当前规则成批 | E-USER | 已执行（范围见审计） |
| F-USER-011 | /users | 文案全量质检 | 个人批次按全量策略，不提前阈值结束 | E-USER | 已执行（范围见审计） |
| F-USER-012 | /users | 更多菜单重置密码与取消 | 初始密码 / 强制修改及会话失效正确 | E-USER | 已执行（范围见审计） |
| F-USER-013 | /users | 删除用户与取消 | 当前账号不能删除，任务责任及历史贡献处理符合契约 | E-USER | 已执行（范围见审计） |
| F-USER-014 | /users | 解除登录限制与确认 | 只重置允许范围限制，反馈可见 | E-USER | 已执行（范围见审计） |
| F-USER-015 | /users | 分配池持续补位 / 定量模式切换 | 确认才切换，保存版本及说明正确 | E-USER | 已执行（范围见审计） |
| F-USER-016 | /users | 分配总开关开启 / 关闭 | 持续补位与定量触发受开关控制 | E-USER | 已执行（范围见审计） |
| F-USER-017 | /users | 加入标注：搜索 / 人员选择 / 取消 | 仅尚未入池已启用 USER，默认不自动选人 | E-USER | 已执行（范围见审计） |
| F-USER-018 | /users | 加入标注并设置上限 / 数量 | 1–500 整数，加入后概览更新 | E-USER | 已执行（范围见审计） |
| F-USER-019 | /users | 编辑成员上限 / 单次数量 | 对应模式值保存，陈旧版本拒绝 | E-USER | 已执行（范围见审计） |
| F-USER-020 | /users | 暂停 / 恢复接单 | 暂停不接单，停用账号不能恢复 | E-USER | 已执行（范围见审计） |
| F-USER-021 | /users | 移出人员池确认与取消 | 成员移除但现有任务和派单历史保留 | E-USER | 已执行（范围见审计） |
| F-USER-022 | /users | 定量分配按钮 | 一次按数量派单，不自动继续，池不足显示实际数量 | E-USER | 已执行（范围见审计） |
| F-USER-023 | /users | 持续补位行为 | 开关开启后只补足待审上限，完成后持续补位 | E-USER | 已执行（范围见审计） |
| F-USER-024 | /users | 池当前待审、可补、累计 / 今日定量记录 | 统计按北京时间且历史派单不因改派减少 | E-USER | 已执行（范围见审计） |

### EXEC · 执行机与小红书搜索节点

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-EXEC-001 | /executors | 执行机列表与刷新 | 在线、心跳、能力、并发、运行任务及额度状态准确 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-002 | /executors | 执行机并发、容量、执行器版本和状态 | 文案/图片并发及容量状态标签对应节点报告；当前没有模型名称或冷却说明独立控件 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-003 | /executors | 删除离线且无有效执行机 | 确认删除合法节点，取消保留 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-004 | /executors | 在线 / 正在执行节点删除限制 | 禁用原因明确，服务端不能绕过 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-005 | /executors | 小红书搜索节点登录与能力状态 | 已登录 / 未登录 / 限流 / 搜索忙碌提示正确 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-006 | /executors | 移除小红书搜索节点 | 仅允许安全节点，确认 / 取消正确 | E-EXEC | 已执行（范围见审计） |
| F-EXEC-007 | /executors | 全局小红书账号异常提示 | 跳转 / 处理提示与实际节点状态一致 | E-EXEC | 已执行（范围见审计） |

### PERSONAL · 个人数据统计全部页签和明细

角色 / 条件：已登录用户，按工作能力显示。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-PERSONAL-001 | /workbench/personal-statistics | 个人数据 / 作业数据页签、我的作业和刷新 | 数据独立读取，导航正确 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-002 | /workbench/personal-statistics | 今日概览及交付池入口 | 北京时间当天，独立于下方历史日期 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-003 | /workbench/personal-statistics | 今日文案 / 图片质检通过详情 | 仅本人对应当日事实，分页正确 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-004 | /workbench/personal-statistics | 今天 / 昨天 / 7 天 / 自定义日期 | 范围验证与历史统计一致 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-005 | /workbench/personal-statistics | 个人文案标注首次 / 返修 / 废弃 / 提交指标 | 各指标下钻只含本人有效操作 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-006 | /workbench/personal-statistics | 个人图片全部提交 / 首次审核 / 返修提交指标 | 阶段和版本对应，改派不转移历史贡献；当前图片区无废弃指标卡片 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-007 | /workbench/personal-statistics | 个人质检次数、通过、退回、复检和整批影响 | 按实际操作账号，指标不是准确率 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-008 | /workbench/personal-statistics | 个人明细弹窗分页、时间线及打开任务 | 绑定所选阶段 / 时间，已删除任务保留统计但无打开入口 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-009 | /workbench/personal-statistics | 当前质检待办 / 暂不可处理 | 不受历史时间筛选影响，权限 / 暂停阻塞正确 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-010 | /workbench/personal-statistics | 作业关系：我负责 / 我创建 / 与我相关 | 当前作业状态统计对应范围 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-011 | /workbench/personal-statistics | 作业状态各卡片跳转 | 返回我的作业带正确分类 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-012 | /workbench/personal-statistics | 返修仅文案 / 仅图片 / 双返工 | 计数及跳转过滤正确 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-013 | /workbench/personal-statistics | 返修待修改 / 后台处理中 / 待确认 / 超 24 小时 | 当前等待事实与作业过滤一致 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-014 | /workbench/personal-statistics | 我的交付记录弹窗 | 复用共享交付，下载 / 确认权限正确 | E-PERSONAL | 已执行（范围见审计） |
| F-PERSONAL-015 | /workbench/personal-statistics | 加载错误重试及过时数据提示 | 错误可恢复，旧数据不误报实时 | E-PERSONAL | 已执行（范围见审计） |

### STAT · 管理员数据统计及账号明细

角色 / 条件：ADMIN；普通角色按 page.tsx 分流。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-STAT-001 | /workbench-statistics | 管理员总数据及标注作业报表入口 | 入口和权限正确，普通用户按当前实现分流 | E-STAT | 已执行（范围见审计） |
| F-STAT-002 | /workbench-statistics | 今日 / 昨日 / 7 天 / 本月 / 30 天 / 自定义日期 | 北京时间范围和刷新一致 | E-STAT | 已执行（范围见审计） |
| F-STAT-003 | /workbench-statistics | 人员、账号搜索、文案 / 图片筛选及应用 | 历史 / 停用账号可查，清除范围正确 | E-STAT | 已执行（范围见审计） |
| F-STAT-004 | /workbench-statistics | 一次通过 / 打回 / 废弃质量卡片下钻 | 分母、范围、结果明细对应所选指标 | E-STAT | 已执行（范围见审计） |
| F-STAT-005 | /workbench-statistics | 建议改派 / 待质检下钻 | 当前待办范围与历史指标区分正确 | E-STAT | 已执行（范围见审计） |
| F-STAT-006 | /workbench-statistics | 工作量与趋势展开 | 图表和总工作量显示准确，收起不丢条件 | E-STAT | 已执行（范围见审计） |
| F-STAT-007 | /workbench-statistics | 全部 / 标注 / 质检账号表现切换 | 对应列、数量、指标及分母正确 | E-STAT | 已执行（范围见审计） |
| F-STAT-008 | /workbench-statistics | 列排序、移动排序及分页 | 各质量比率、判定量、质检量升降序正确 | E-STAT | 已执行（范围见审计） |
| F-STAT-009 | /workbench-statistics | 人员姓名、指标、复检 / 通过 / 逐项退回下钻 | 打开对应账号和阶段 | E-STAT | 已执行（范围见审计） |
| F-STAT-010 | /workbench-statistics | 明细操作 / 质量与时效 / 趋势与待办页签 | 当前内容、口径、图表完整 | E-STAT | 已执行（范围见审计） |
| F-STAT-011 | /workbench-statistics | 明细范围、阶段、结论筛选和分页 | 样本 / 事件范围正确，绑定报表快照 | E-STAT | 已执行（范围见审计） |
| F-STAT-012 | /workbench-statistics | 事件版本与处理时间线及当前任务链接 | 历史时间、实际账号及版本准确 | E-STAT | 已执行（范围见审计） |
| F-STAT-013 | /workbench-statistics | 当前待办分页及返修等待时间 | 后台等待与可处理时段分开，未知历史明确 | E-STAT | 已执行（范围见审计） |
| F-STAT-014 | /workbench-statistics | 导出报表 | CSV 与当前筛选完整数据一致，文件名日期准确 | E-STAT | 已执行（范围见审计） |
| F-STAT-015 | /workbench-statistics | 读取失败、超时和明细刷新提示 | 可重试，不混用旧新快照 | E-STAT | 已执行（范围见审计） |

### REPORT · 任务数据统计与查询方案

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-REPORT-001 | /reports/task-data | 任务池状态概览与刷新 | 当前全池概览与查询报告范围分别准确 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-002 | /reports/task-data | 开始 / 结束日期时间选择器 | 月份前后、日期、时分秒和完成按钮有效 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-003 | /reports/task-data | 标注人、任务状态及查询 | 首轮审核操作时间范围正确，隐藏机器失败状态不误露入口 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-004 | /reports/task-data | 更多条件展开 / 收起 | 任务ID或名称、驳回次数、改派次数、质检人员可编辑 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-005 | /reports/task-data | 任务ID / 名称查询 | 字符、数字和模糊匹配符合契约 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-006 | /reports/task-data | 驳回次数、改派下限及质检人筛选 | 数值边界和实际历任人员事实正确 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-007 | /reports/task-data | 无效日期 / 数字条件 | 明确提示并禁用查询；当前7种固定条件不能在UI重复添加超过20条，过多条件仅为后台边界 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-013 | /reports/task-data | 任务数量标签设置 | 所有可见数量标签逐项选择 / 取消 / 保存 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-014 | /reports/task-data | 数量标签本地偏好恢复与迁移 | 刷新保持，旧偏好迁移不丢新指标 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-015 | /reports/task-data | 标注作业概览与作业明细 XLSX 导出 | 按操作日期统计；下载工作簿与当前条件一致 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-016 | /reports/task-data | 任务数量详情展开和次要指标显示 | 当前汇总及标签切换正确 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-017 | /reports/task-data | 任务明细固定顺序及上一页/下一页 | 按FIRST_COPY_REVIEW_ACTION倒序、每页20条；总数、页码、当前数据一致，当前无排序控件 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-018 | /reports/task-data | 任务行展开 / 收起时间线 | 复制、审核、改派、图片和交付事实完整 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-019 | /reports/task-data | 生成任务明细 CSV | 异步任务、进度和导出范围正确 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-020 | /reports/task-data | 下载 CSV 与导出记录刷新 | 未过期完整下载，过期不可错误下载 | E-REPORT | 已执行（范围见审计） |
| F-REPORT-021 | /reports/task-data | 报告读取失败 | 继续合法查询，错误提示可见；查询方案读取只属未挂载历史实现 | E-REPORT | 已执行（范围见审计） |

### ANNOT · 标注作业统计报表与趋势

角色 / 条件：ADMIN。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-ANNOT-001 | /reports/annotation-jobs | 日期起止、标注人查询及刷新 | 北京时间范围有效，汇总与明细一致 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-002 | /reports/annotation-jobs | 人员作业表及首次 / 返修口径 | 每次接手首次计首次，再次操作计返修 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-003 | /reports/annotation-jobs | 查看 / 隐藏仅有质检记录人员 | 只影响展示，不改变报告总事实 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-004 | /reports/annotation-jobs | 统计口径折叠说明 | 内容准确且可读 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-005 | /reports/annotation-jobs | 总作业 / 首次文案审核 / 文案一次通过率 / 首次图片审核图表 | 每个页签曲线、汇总与单位准确 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-006 | /reports/annotation-jobs | 有作业日 / 自然日 | 无作业日折叠或保留零值正确 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-007 | /reports/annotation-jobs | 显示 / 隐藏数值 | 图中标签切换有效 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-008 | /reports/annotation-jobs | 人员图例选择、全选及反选 | 显示人数和曲线对应，空选正常 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-009 | /reports/annotation-jobs | 图表工具提示、缩放与长时间范围 | 提示数字正确，多人员可操作 | E-ANNOT | 已执行（范围见审计） |
| F-ANNOT-010 | /reports/annotation-jobs | 无数据 / 无有效首检 / 加载失败 | 不将零分母显示成 0% 或虚假通过 | E-ANNOT | 已执行（范围见审计） |

### LAB · 搜索与文案对照实验室

角色 / 条件：实验室访问者；凭证从本次输入或合法环境提供。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-LAB-001 | search-lab / | 服务商列表读取、失败重新加载 | 13 家当前配置提供方显示正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-002 | search-lab / | 搜索 Query 空值 / 500 字上限 | 必填和长度限制正确，输入作为不可信数据 | E-LAB | 已执行（范围见审计） |
| F-LAB-003 | search-lab / | 服务商勾选 / 取消及已选数量 | 零选择不能开始，缺凭证显示待完善 | E-LAB | 已执行（范围见审计） |
| F-LAB-004 | search-lab / | API Key 输入显示 / 隐藏 | 默认掩码，只本次请求使用，输出脱敏 | E-LAB | 已执行（范围见审计） |
| F-LAB-005 | search-lab / | 搜索模型及服务专属选项输入 | 字段按服务商显示，格式验证正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-006 | search-lab / | DeepSeek 对照搜索 | 成功 / 失败 / 耗时、资料与来源正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-007 | search-lab / | 阿里 IQS / OpenSearch / 百炼对照搜索 | 专属 host、workspaceName / workspaceId、region 校验正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-008 | search-lab / | 小米 MiMo / 智谱 / 百度千帆搜索 | 成功结果与错误分别展示 | E-LAB | 已执行（范围见审计） |
| F-LAB-009 | search-lab / | 讯飞星火 / 腾讯 WSA 搜索 | 适配响应和失败消息正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-010 | search-lab / | 豆包 Global / Custom 及 ICP 选项 | 模式、范围和结果正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-011 | search-lab / | Kimi / MiniMax 搜索及地域 | 成功 / 无凭证 / 不支持状态如实展示 | E-LAB | 已执行（范围见审计） |
| F-LAB-012 | search-lab / | 开始多家对照搜索与停止等待 | 部分成功不被失败覆盖，取消可重新开始 | E-LAB | 已执行（范围见审计） |
| F-LAB-013 | search-lab / | 搜索结果统计及摘要复制 | 每家成功、失败、来源与耗时真实；复制内容正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-014 | search-lab / | 来源链接与正文展示 | 链接安全、来源可读，无 HTML / 指令注入 | E-LAB | 已执行（范围见审计） |
| F-LAB-015 | search-lab / | 读取 / 重读系统文案配置 | 显示实际规则来源与生成服务，失败可重试 | E-LAB | 已执行（范围见审计） |
| F-LAB-016 | search-lab / | 生成服务选择、模型及本次生成 Key | 合法参数只影响本次生成，凭证不输出 | E-LAB | 已执行（范围见审计） |
| F-LAB-017 | search-lab / | 内容分类、目标人群、配图 auto / 3 / 4 / 5 | 统一参数应用每家成功资料 | E-LAB | 已执行（范围见审计） |
| F-LAB-018 | search-lab / | 补充文案要求 2000 字及自动审核 / 自动修订开关 | 参数与流程行为一致 | E-LAB | 已执行（范围见审计） |
| F-LAB-019 | search-lab / | 单家生成最终文案 | 使用该家搜索快照，展示真实阶段进度及模型证据 | E-LAB | 已执行（范围见审计） |
| F-LAB-020 | search-lab / | 为所有成功结果生成 | 只对成功搜索创建文案任务，不重用错误资料 | E-LAB | 已执行（范围见审计） |
| F-LAB-021 | search-lab / | 文案生成中禁止新搜索及重复生成 | 任务不串 Query，按钮状态正确 | E-LAB | 已执行（范围见审计） |
| F-LAB-022 | search-lab / | 重新生成文案 | 创建新的明确结果，不误把旧结果当新 | E-LAB | 已执行（范围见审计） |
| F-LAB-023 | search-lab / | 最终稿、原稿、修订输出与审核结果展开 | 区分真实最终稿和未变化修订，图文规划完整 | E-LAB | 已执行（范围见审计） |
| F-LAB-024 | search-lab / | 复制最终文案及下载 TXT | 标题、正文、标签与当前结果对应 | E-LAB | 已执行（范围见审计） |
| F-LAB-025 | search-lab / | 任务失败 / 拒绝 / 超时及凭证脱敏 | 错误真实，可重试，不将 fallback 声称为真实模型 | E-LAB | 已执行（范围见审计） |
| F-LAB-026 | search-lab / | 模型 / 服务不可用条件 | 标记受外部配置阻塞，不伪报所有 13 家实调通过 | E-LAB | 已执行（范围见审计） |

### PREVIEW · 独立预览服务全部页面功能

角色 / 条件：管理员后台；公开访客查看。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-PREVIEW-001 | preview-service /；/login；/preview；/p/{publicId} | 后台登录正确 / 错误 / 空值及退出 | 认证有效，未登录管理页跳登录 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-002 | preview-service /；/login；/preview；/p/{publicId} | 单条创建 / 批量创建页签 | 表单草稿切换保留，创建模式独立 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-003 | preview-service /；/login；/preview；/p/{publicId} | 单条标题、正文、原图上传 | 标题必填、长度和支持 PNG / JPEG / WebP / GIF / AVIF 正确 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-004 | preview-service /；/login；/preview；/p/{publicId} | 单条缺图、过多、单图 / 总字节超限 | 校验明确，禁止部分错误发布 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-005 | preview-service /；/login；/preview；/p/{publicId} | 生成单条预览链接 | 保存原始图片字节，公开 URL 正确 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-006 | preview-service /；/login；/preview；/p/{publicId} | 成功复制链接 / 打开预览 | 链接对应新建内容，复制失败提示可读 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-007 | preview-service /；/login；/preview；/p/{publicId} | 批量添加一条 | 达到批次上限禁用 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-008 | preview-service /；/login；/preview；/p/{publicId} | 批量移除条目 | 至少保留一条，移除不误删其他输入 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-009 | preview-service /；/login；/preview；/p/{publicId} | 批量各条文案及各自图片 | 标题、正文、图片不串条 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-010 | preview-service /；/login；/preview；/p/{publicId} | 批量数量 / 总图 / 总字节与原子校验 | 任一无效条目阻止创建整批 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-011 | preview-service /；/login；/preview；/p/{publicId} | 生成多个预览及复制全部 / 打开第一个 | 回执数量与实际已创建一致 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-012 | preview-service /；/login；/preview；/p/{publicId} | 预览记录刷新与搜索标题 / Query / publicId | 匹配范围和清空正确 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-013 | preview-service /；/login；/preview；/p/{publicId} | 全部 / 可访问 / 已撤销 / 未找到分类 | 数量和状态准确，未找到禁止无意义搜索 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-014 | preview-service /；/login；/preview；/p/{publicId} | 记录每页大小和上下页 | 分页总量、边界正确 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-015 | preview-service /；/login；/preview；/p/{publicId} | 记录复制及打开预览 | 链接与各条记录对应 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-016 | preview-service /；/login；/preview；/p/{publicId} | 撤销预览确认与取消 | 取消保持可用，确认后公开内容不可访问 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-017 | preview-service /；/login；/preview；/p/{publicId} | 接口密钥弹窗打开及已有列表 | 只展示前缀、权限、有效 / 撤销、使用时间 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-018 | preview-service /；/login；/preview；/p/{publicId} | 新密钥名称及创建 / 读取 / 撤销权限勾选 | 至少一项，长度验证正确 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-019 | preview-service /；/login；/preview；/p/{publicId} | 生成与复制新密钥 | 只显示一次，关闭后不能再读取明文 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-020 | preview-service /；/login；/preview；/p/{publicId} | 撤销接口密钥及确认取消 | 取消保留，撤销立即阻止对应 API 权限 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-021 | preview-service /；/login；/preview；/p/{publicId} | API Key 不同 scope 请求 | 创建、读取、撤销权限分别生效 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-022 | preview-service /；/login；/preview；/p/{publicId} | 公开预览图文显示 | 标题、正文与图片匹配，不暴露后台信息 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-023 | preview-service /；/login；/preview；/p/{publicId} | 公开预览上一张 / 下一张与边界 | 页码和图片顺序正确，原图保持 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-024 | preview-service /；/login；/preview；/p/{publicId} | 公开不可用：非法、缺失、已撤销 ID | 显示合适状态，不继续泄露旧原图 | E-PREVIEW | 已执行（范围见审计） |
| F-PREVIEW-025 | preview-service /；/login；/preview；/p/{publicId} | 公开页移动尺寸与多图布局 | 图文可读，长正文及长标题可用 | E-PREVIEW | 已执行（范围见审计） |

### TRACE · 任务历史、模型请求 / 响应可见性

角色 / 条件：ADMIN 可见原始诊断；其他角色按组件权限。

| 用例 ID | 页面路由 / 入口 | 操作 / 功能点 | 期望结果 | 已有测试索引 | 本轮状态 |
| --- | --- | --- | --- | --- | --- |
| F-TRACE-001 | 任务详情历史与模型记录 | 任务历史与人工评分记录展开 | 版本、操作者、时间和真实评分准确 | E-TRACE | 已执行（范围见审计） |
| F-TRACE-002 | 任务详情历史与模型记录 | 图集生成、修改、格式处理历史 | 每个 run 对应文案与当前 lineage | E-TRACE | 已执行（范围见审计） |
| F-TRACE-003 | 任务详情历史与模型记录 | 模型调用列表及阶段选择 | 模型、来源、队列 / 实际耗时与状态正确 | E-TRACE | 已执行（范围见审计） |
| F-TRACE-004 | 任务详情历史与模型记录 | 模型请求完整 Prompt / 结构化字段 / 图片附件 | 实际执行请求可读，无凭证泄露 | E-TRACE | 已执行（范围见审计） |
| F-TRACE-005 | 任务详情历史与模型记录 | 模型响应正文 / JSON / 工具与错误展示 | 按实际响应呈现，截断和缺档提示准确 | E-TRACE | 已执行（范围见审计） |
| F-TRACE-006 | 任务详情历史与模型记录 | 失败调用诊断 / 重试读取 / 请求截断与附件文件位置显示 | 原因、截断提示和只读文件路径可见，原始不可信Prompt文本不执行；没有附件下载控件，实际资产访问权限另用API/PG验证 | E-TRACE | 已执行（范围见审计） |
| F-TRACE-007 | 任务详情历史与模型记录 | 调研来源及小红书 Query 文章链接 | 链接安全、匹配 Query、搜索状态与来源真实 | E-TRACE | 已执行（范围见审计） |

## 源码存在、当前页面未显示的功能

这些项目只完成静态确认；不得计入当前用户可见功能通过数量。如果执行环境显式打开对应 feature flag，再补实际用例与运行证据。

| 功能 | 源码 / 原因 | 状态 |
| --- | --- | --- |
| 视觉知识库页签及视觉配方 | `app/knowledge/knowledge-views.ts` 设置 `SHOW_KNOWLEDGE_TYPE_SWITCHER = false` | 当前隐藏；未执行 |
| 上传优秀图片分析、编辑名称 / 类型 / 生成目标 / 质量分 / Prompt / 负面约束 / 风格 / 分类 / JSON | `app/knowledge/knowledge-workbench.tsx` 存在；未挂载视觉页签 | 当前隐藏；未执行 |
| 视觉配方图片保留方式、授权选择、保存草稿、发布、归档、看图 | 同上；保留图片只允许自有 / 已授权 | 当前隐藏；未执行 |
| 部分旧管理员统计展示组件 | `app/workbench-statistics/admin-statistics.tsx` 等存在，但需以 `page.tsx` 的实际挂载入口为准 | 非当前必测独立入口 |
| 不同中心 / 本机模式功能分支 | 提示词及生产配置按 `controlPlaneUrl()` 分支挂载 | 根据实际配置记录适用分支 |
| 旧图片审核评分和返工动作 | `app/workbench/use-task-review-controller.ts` 将 `canReviewImages` 固定为false，旧ImageReviewPanel评分分支不显示；当前改由图片质检独立页面处理 | 对应F-IREVIEW-014/015当前不适用 |
| 图片强制复检升级提交管理员动作 | `app/image-qa/image-qa-workbench.tsx` 没有升级提交处理器或按钮；保留ADMIN_ESCALATED状态过滤和历史显示 | 对应F-IQA-015当前不适用 |

## 执行记录字段

为每项填写：执行时间（北京时间）、测试环境 / 代码版本、账号角色、数据 / 任务 ID、步骤和输入、实际结果、结论（通过 / 失败 / 受阻 / 不适用）、浏览器截图或操作记录、HTTP / 后台日志、产物文件、缺陷编号、修复文件、复测证据。源码审查或自动化合约通过应另外注明，不能替代页面交互结论。



## 经挂载审计确认不可操作的历史功能

任务数据报表保留查询方案弹窗源码，但当前 `setSchemeOpen` 只有初始 false 和关闭调用，没有页面打开入口。以下稳定ID移出当前可见范围；本轮按“不适用（当前未挂载）”记账，已有API/单元证据不能算浏览器通过。

| 用例ID | 路由 | 历史功能 | 历史契约 | 已有索引 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| F-REPORT-008 | /reports/task-data | 我的查询方案打开 / 关闭及选择方案 | 载入即查询，条件及排序恢复 | E-REPORT | 不适用（当前未挂载） |
| F-REPORT-009 | /reports/task-data | 方案另存为 | 名称必填，创建个人保存方案 | E-REPORT | 不适用（当前未挂载） |
| F-REPORT-010 | /reports/task-data | 覆盖方案 | 只更新当前方案，其他方案不变 | E-REPORT | 不适用（当前未挂载） |
| F-REPORT-011 | /reports/task-data | 设为默认方案 | 当前账号默认方案保存，初次日期按当天规则 | E-REPORT | 不适用（当前未挂载） |
| F-REPORT-012 | /reports/task-data | 删除方案确认与取消 | 确认删除，取消保留 | E-REPORT | 不适用（当前未挂载） |

## 逐项期望的收尾审阅

本轮完整口径为当前实际控件、可选分支及代表性的正常、失败、边界、权限和持久化场景，不穷举任意数据排列或全部数值组合。598个稳定ID中，577项当前中心页面功能已关联实际浏览器动作，12项本机配置控件另在实际组件浏览器执行，9项当前未挂载。表内“已执行”说明执行事实；是否满足具体预期要结合逐项动作范围与后台证据，不能把动作审计中的PARTIAL自动换成整项PASS。最后统一回归的结论和总数以主报告为准。

审阅时发现并补齐的真实控件缺口如下；这些项目均有实际浏览器复测，不以源码匹配代替动作：

| 功能范围 | 最后审阅结果与证据 |
| --- | --- |
| AUTH011、用户权限与派单池 | 姓名必填/80字/失败保持及刷新；账号原生规则；权限、全检/数量、总开关、定量和持续模式均已执行。`profile-name-boundary-browser.tap`、`functional-admin-supplement.json`、`user-auto-assignment-ui-summary.json`；持续完成后补位另用真实PG |
| VIEW007/010、LIST035 | 真实Next未知路由404与兼容交付成员逐ID核对；无中心配置用实际Page SSR加隔离适配器验证；ADMIN空态CTA打开、USER隐藏、无匹配无错误。`functional-compatibility-route-supplement.json`、`workbench-route-empty-browser.tap`、`admin-list-empty-controls-retest2.tap` |
| CREATE001–009、ASSIGN006–010 | 创建表单全部页数、免审核负责人、100条解析与边界/失败；优先级六模式、同生产批次预览/取消/expectedVersions/409新预览。`creation-form-browser-initial.tap`、`task-priority-batch-browser-initial.tap` |
| COPY/PLAN/IREVIEW/IPREVIEW/TRACE | 已补正文/标签/原稿和最终评分、返工保存、全部布局控件、规划503保持/重试、图片继续/重试/整套生成确认、预览原生双向滚动与实际img重试、历史选择/格式背景恢复、历史及调用失败重试。逐项见动作审计中的相应实际测试行 |
| CFLOW/CQA/IQA | 实际个人随机和跨审核人混合成员/样本、文案废弃确认与历史、图片整批权限/取消/确认、旧样本409内容保持并刷新新样本再提交。`copy-flow-modes-browser-retest.tap`、`copy-qa-discard-browser-initial.tap`、`image-qa-stale-browser-final.tap` |
| QPK001–041 | TXT/CSV/真实XLSX工作表列与拆包、错误/上限、搜索和所有状态、200+5虚拟行、暂存双向/关闭不保存、任务链接、409保留错误与重读、分配/收回/废弃/另包永久删除。实际UI持久化分别由临时真实服务与HTTP夹具承担，算法和并发另有PG。`query-package-browser-evidence.json`、`functional-admin-supplement.json`、主流程F021/F067 |
| STAND001–013 | 名称200字/关闭无写、max5拒6、损坏/尺寸与上传失败、PNG/JPEG/WebP五张顺序和第1/5张、20/1分页和末页删除回退、运行禁选、单条和批量取消/确认/失败重试、载入失败恢复。`standalone-boundary-browser-evidence.json`与原独立编辑器实际回归 |
| DELIVERY/DLEGACY | 真实服务日期/搜索/当前历史/汇总及分页，正向关联词包与批次独立125条HTTPfixture；全部折叠工具、下载事件/字节、上传范围/取消/确认/公开预览和权限。`functional-delivery-filter-supplement.json`、`shared-delivery-filter-browser-evidence.json`、`knowledge-legacy-browser-retest.tap` |
| PROMPT001–019 | 草稿/发布/载入、键盘和快捷入口、保护规则正反例、并发刷新保持及禁旧保存、示例500字/预检失败恢复与实际生产展开、WEB/CENTER非空执行记录按钮/明细/失败。`functional-prompt-supplement.json`、`prompt-controls-final-pass2.tap`；当前中心没有直接重发布旧版本按钮 |
| SETTING001–048 | 联网和XHS控件、搜索模型/默认/超时、盲评开关/0/100/小数、流程撤销/409重读、评分说明100字与实际placeholder、全部catalog与legacy字段/选项/分页/文件/schema/原子性/版本/失败；本机十二项另实际执行。四份settings与production浏览器回归及三份详细summary分别记录范围 |
| KNOW/PERSONAL/STAT/REPORT/ANNOT/EXEC | 知识库替换/分析/全部字段与分页；各统计实际人员/指标/事件/当前任务链接和图表控件；报表固定条件/日期/XLSX全部成员、分页与失败恢复；只质检无作业人员和搜索异常提示另夹具执行。各`functional-*-supplement.json`、`annotation-and-xhs-alert-summary.json`及逐项审计 |
| LAB/PREVIEW | 搜索实验室13个提供方控件及假HTTP、空/500字/再次生成、复制/下载/取消与诊断；预览服务全部25项独立本地D1/R2流程。来源真实性和模型调用分别见主报告，不将假HTTP当第三方真实成功调用 |

CREATE008属于创建UI选择与后续后台门禁组合，没有额外页面开关。实际免文案审核选择/负责人/payload已执行；`server/tests/skip-copy-review.test.mjs`的12项HTTP/repository回归核对管理员授权、原子生图入队、无负责人/非法/模型伪造标志不可绕过。临时真实PG完整流程另核对负责人图片初审与图片质检门禁。动作审计JSON的该ID另列这13项后台证据类型，不声称它们是13次UI操作或一条额外真实模型链路。

精确边界：任务报表查询方案五项、旧图片审核两项、图片升级提交一项和本机直接重发布旧版本一项在当前中心未挂载，合计9项。报表的超过20条件无法由7个固定条件触发，作业明细固定排序没有额外排序控件；独立编辑器固定当前页20条，没有超20选择或逐项部分失败面板；搜索PATCH没有版本参数；大图预览没有自定义拖动；模型附件显示只读路径，没有下载按钮。盘点已据实际源码更正，未新增入口冒充既有功能。

剩余限制为环境与证据来源：设备屏幕取色使用EyeDropper夹具，第三方13服务不是全部真实外部联调；图片和模型产物在100条主流程中为明确合成，真实模型另独立记账；条件本机组件并不代表中心页面挂载这些控件。当前清单没有发现尚未执行的可见控件；最后统一回归仍应保留真正失败及修复历史，不按文件存在或CASE数量生成覆盖率。
