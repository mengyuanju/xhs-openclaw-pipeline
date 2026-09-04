# Admin Console v0.2 Tasks

## Phase 20: 单条文案双版本保存与对比

- [x] Task 73: 双版本生成契约与质检修订。
  - Acceptance: 原始版、首次质检、质检修订版和最终复检顺序可验证；返回双版且旧字段仍可用。
  - Verify: `node --test tests/copy-generation.test.mjs`
  - Files: `src/copy-generation.mjs`, `tests/copy-generation.test.mjs`

- [x] Task 74: 双版本 SQLite 持久化与 API 历史。
  - Acceptance: POST 原子保存两版、模型、审核和研究证据；GET 按新到旧有界分页。
  - Verify: `node --test tests/standalone-copy-generation-store.test.mjs tests/copy-generation.test.mjs`
  - Files: `src/admin/standalone-copy-generation-store.mjs`, `src/admin/admin-store.mjs`, `app/api/copy-generations/route.ts`, `tests/`

- [x] Task 75: 历史选择与双栏对比界面。
  - Acceptance: 刷新后可选择历史；原始版/质检版并排展示并可分别复制；窄屏单列且空/错/忙状态可读。
  - Verify: `node --test tests/copy-generation-ui.test.mjs && npm run typecheck && npm run build`，浏览器检查桌面和 390px。
  - Files: `app/copy-generation/**`, `app/globals.css`, `tests/copy-generation-ui.test.mjs`

- [x] Task 76: 文档、全量验证与代码审查。
  - Acceptance: README/API 说明两次调用与持久化；无真实模型调用、无其他工作区改动被覆盖。
  - Verify: `npm test && npm run typecheck && npm run build`
  - Files: `README.md`, `docs/standalone-copy-comparison-spec.md`, `tasks/`

- [x] Task 77: 生成链路阶段计时与持久化迁移。
  - Acceptance: 成功记录包含总耗时和六阶段耗时；升级前记录保持可读且不伪造数据。
  - Verify: `node --test tests/copy-generation.test.mjs tests/standalone-copy-generation-store.test.mjs`
  - Files: `src/copy-generation.mjs`, `src/admin/standalone-copy-generation-store.mjs`, `tests/`

- [x] Task 78: 历史耗时聚合与界面展示。
  - Acceptance: API 返回样本数、平均、P50、P95；历史区和单条对比页分别展示汇总与阶段明细。
  - Verify: `node --test tests/copy-generation-ui.test.mjs && npm run typecheck`
  - Files: `app/copy-generation/**`, `app/globals.css`, `tests/copy-generation-ui.test.mjs`

- [x] Task 79: 耗时统计完整验证。
  - Acceptance: 全量测试、构建和桌面/窄屏浏览器验证通过，无真实模型调用。
  - Verify: `npm test && npm run typecheck && npm run build`
  - Files: `README.md`, `docs/standalone-copy-comparison-spec.md`, `tasks/`

## Phase 19: 任务级内容质检负责人

- [x] Task 69: 任务级分配、阶段结论与兼容迁移。
  - Acceptance: 每个任务唯一负责人；按条数精确分配；文案/图片结论绑定快照；旧 COPY 负责人和结论可迁移。
  - Verify: `node --test tests/review-work-store.test.mjs`
  - Files: `src/admin/review-task-store.mjs`, `src/admin/review-work-store.mjs`, `src/admin/admin-store.mjs`, `tests/review-work-store.test.mjs`

- [x] Task 70: 任务分配与阶段审核 API。
  - Acceptance: 严格输入、角色授权、版本冲突、跨任务图片读取禁止。
  - Verify: `node --test tests/review-center-ui.test.mjs tests/reviewer-auth.test.mjs && npm run typecheck`
  - Files: `app/api/review-task-assignments/**`, `app/api/_lib.ts`, `src/admin/proxy-policy.mjs`, `tests/`

- [x] Task 71: 按条数派单与统一审核详情。
  - Acceptance: 管理员按批次/人员/条数分配；内容质检员在同一任务页查看文案和图片并提交两个阶段结论。
  - Verify: `node --test tests/review-center-ui.test.mjs && npm run build`，浏览器检查桌面和 390px。
  - Files: `app/reviews/**`, `app/globals.css`, `tests/review-center-ui.test.mjs`

- [x] Task 72: 完整验证与迁移说明。
  - Acceptance: Query 工单、旧管理员、Worker、任务审核与导出无回归；无高危依赖或秘密。
  - Verify: `npm test && npm run typecheck && npm run build && npm run smoke && npm audit --audit-level=high`
  - Files: `README.md`, `docs/review-work-management-spec.md`, `docs/decisions/001-task-level-review-ownership.md`, `tasks/`

## Phase 18: Query 与文案质检作业中心

- [x] Task 64: 质检人员与兼容会话。
  - Acceptance: 管理员 Token 保持兼容；质检人员密码使用 scrypt；Token 只保存最小身份与角色；停用人员无法调用质检领域接口。
  - Verify: `node --test tests/auth.test.mjs tests/auth-routes.test.mjs tests/reviewer-auth.test.mjs`
  - Files: `src/admin/auth.mjs`, `src/admin/http.mjs`, `src/admin/review-work-store.mjs`, `tests/reviewer-auth.test.mjs`

- [x] Task 65: 作业单领域与事务。
  - Acceptance: Query/文案作业幂等生成；分配、领取、提交结论均授权且防并发覆盖；事件完整。
  - Verify: `node --test tests/review-work-store.test.mjs`
  - Files: `src/admin/review-work-store.mjs`, `src/admin/admin-store.mjs`, `tests/review-work-store.test.mjs`

- [x] Task 66: 人员与作业 REST 接口。
  - Acceptance: 严格输入、统一错误、分页和角色授权；响应不含密码哈希。
  - Verify: `node --test tests/reviewer-auth.test.mjs tests/review-center-ui.test.mjs && npm run typecheck`
  - Files: `app/api/review-users/**`, `app/api/review-work-items/**`, `app/api/_lib.ts`, `tests/`

- [x] Task 67: 质检中心页面。
  - Acceptance: 管理员可创建人员、生成/派单；质检员可查看、领取、审核并自动回到待办；有空/错/忙状态且键盘可达。
  - Verify: `node --test tests/review-center-ui.test.mjs && npm run build`，浏览器检查 `/reviews` 与 `/reviews/:id`。
  - Files: `app/reviews/**`, `app/components/**`, `app/login/**`, `app/globals.css`, `tests/review-center-ui.test.mjs`

- [x] Task 68: 兼容、文档与完整验证。
  - Acceptance: 旧管理员/任务审核/Worker 保持工作；README 说明账号和派单；无高危依赖或秘密泄漏。
  - Verify: `npm test && npm run typecheck && npm run build && npm run smoke && npm audit --audit-level=high`
  - Files: `README.md`, `docs/review-work-management-spec.md`, `tasks/plan.md`, `tasks/todo.md`

## Phase 17: Query and Text Stage Reviews

- [x] Task 60: 审核契约与独立模型调用。
  - Acceptance: PASS/REJECT 语义、问题证据、字段长度和重试次数均严格校验。
  - Verify: `node --test tests/content-stage-review.test.mjs tests/openclaw.test.mjs`
  - Files: `src/content-stage-review.mjs`, `src/openclaw.mjs`, `tests/content-stage-review.test.mjs`, `tests/openclaw.test.mjs`

- [x] Task 61: 管线门禁与可恢复落盘。
  - Acceptance: Query 审核先于检索；文本审核先于视觉规划；拒绝时无后续付费调用。
  - Verify: `node --test tests/pipeline.test.mjs tests/checkpoint.test.mjs`
  - Files: `src/pipeline.mjs`, `src/checkpoint.mjs`, `tests/pipeline.test.mjs`, `tests/checkpoint.test.mjs`

- [x] Task 62: 存储与审核页展示。
  - Acceptance: 完成/失败运行都保存两阶段证据；批次可读显示决策、来源、原因与历史空状态。
  - Verify: `node --test tests/generation-store.test.mjs tests/worker-integration.test.mjs tests/frontend-ux.test.mjs && npm run typecheck`
  - Files: `src/admin/generation-store.mjs`, `src/admin/worker-service.mjs`, `app/tasks/[id]/generation-stage-reviews.tsx`, `app/tasks/[id]/image-generation-batch.tsx`, `tests/`

- [x] Task 63: 全量验证与操作文档。
  - Acceptance: README 说明新顺序、模型配置和图片提示词的实际组合时机。
  - Verify: `npm test && npm run typecheck && npm run build && npm run smoke`
  - Files: `README.md`, `docs/content-stage-review-spec.md`, `tasks/plan.md`, `tasks/todo.md`

## Task 1: 管理数据库与提示词版本

- [x] 创建管理表与种子提示词，发布版本不可修改。
- [x] 校验提示词变量并保存发布内容哈希。
- Verify：提示词创建、发布、回滚选择和非法变量测试。
- Dependencies：None。

## Task 2: Excel staging 导入

- [x] `.xlsx` 解析首表并返回合法/错误行预览。
- [x] 提交批次时批量入队并固定配置，重复提交幂等。
- Verify：空 Query、重复 externalId、非法 imageCount、1000 行提交测试。
- Dependencies：Task 1。

## Task 3: 文本修订与审核

- [x] 任务保存当前文本修订和完整历史。
- [x] 支持 WAITING_REVIEW、APPROVED、REJECTED 状态与审计记录。
- Verify：非法转换拒绝、修订不覆盖旧版本、操作日志测试。
- Dependencies：Task 1。

## Task 4: 素材与图片修订

- [x] 上传 PNG/JPEG/WebP 参考图，限制大小并用 Sharp 验证真实图片。
- [x] 支持旋转/裁剪修订和父子谱系，不覆盖原图。
- Verify：伪 MIME、路径穿越、尺寸和谱系测试。
- Dependencies：Task 3。

## Task 5: Web 外壳与任务页

- [x] Next.js 页面、导航、仪表盘、分页任务列表和统一错误响应。
- [x] 默认开发/生产命令只绑定 `127.0.0.1`。
- Verify：`npm run build`；任务 API 分页与筛选测试。
- Dependencies：Tasks 1–3。

## Task 6: Excel 与提示词页面

- [x] Excel 上传、预览、提交反馈和错误行展示。
- [x] 提示词草稿、版本发布与当前版本展示。
- Verify：浏览器完成示例 Excel 导入和提示词发布。
- Dependencies：Tasks 2、5。

## Task 7: 审核工作台

- [x] 修改标题/正文/标签、上传参考图、图片修订、通过/退回。
- [x] 展示生成、质检和资产历史。
- Verify：键盘可达、错误/加载/空状态、浏览器截图和网络检查。
- Dependencies：Tasks 3–5。

## Task 8: Worker 快照集成

- [x] Worker 使用任务固定的文本/图片提示词和图片数量。
- [x] 生成完成后同步文本、质检和图片资产到管理表。
- Verify：Fake OpenClaw 断言实际提示词；Mock 批次进入 WAITING_REVIEW。
- Dependencies：Tasks 1–4。

## Task 9: 图生图与编辑 Worker

- [x] OpenClaw 适配器支持 `infer image edit --file`。
- [x] 审核端 AI 编辑请求创建新运行与图片修订。
- Verify：Fake CLI 参数测试；无授权时保持明确失败状态。
- Dependencies：Tasks 4、8。

## Task 10: 最终质量门

- [x] 全量测试、构建、Mock 冒烟和关键浏览器流程通过。
- [x] `npm audit`、秘密扫描、可访问性和五轴代码审查无阻断问题。
- [x] README 更新为后台使用说明。
- Dependencies：Tasks 1–9。

## Task 11: 认证内核

- [x] 使用 scrypt 保存管理员密码哈希，HMAC-SHA256 签发 8 小时会话。
- [x] 配置缺失、会话过期/篡改和登录失败使用安全、稳定的错误语义。
- [x] 登录失败实行有界内存限流，成功后清除计数。
- Verify：纯单元测试先失败后通过；不向错误、日志或 Git 输出凭据。
- Dependencies：Task 10。

## Task 12: HTTP 与 LAN 边界

- [x] 只接受 loopback、私有 IP、link-local 或显式允许的 Host。
- [x] Proxy 保护页面；统一 `apiHandler` 在数据访问前再次验证会话。
- [x] 登录/退出和现有写 API 均保持严格同源校验。
- Verify：Host、401、跨站、篡改 Cookie 和合法私网请求集成测试。
- Dependencies：Task 11。

## Task 13: 登录体验与运行配置

- [x] 增加可访问、响应式登录页和退出按钮。
- [x] 增加本机 `auth:setup` 配置命令，不在命令行参数或 Git 中保存明文密码。
- [x] 默认脚本仍仅本机监听，显式 `dev:lan` / `start:lan` 才开放局域网端口。
- Verify：全量测试、类型检查、构建、安全扫描和真实浏览器登录/退出流程。
- Dependencies：Task 12。

## Task 14: 视觉知识领域层

- [x] 增加知识条目、不可变版本、可选素材和任务引用表。
- [x] 支持分页、状态流转、已发布配方检索和任务版本锁定。
- Verify：先写失败的 SQLite 集成测试，再实现并运行定向测试。
- Dependencies：Task 13。

## Task 15: 图片分析与双保留模式

- [x] 使用 Sharp 校验图片，并通过 OpenClaw `infer model run --file` 提炼结构化配方。
- [x] `PROMPT_ONLY` 不落盘；授权 `IMAGE_AND_PROMPT` 保存规范化 PNG。
- Verify：Fake runner、伪 MIME、超大图片、授权组合和临时文件清理测试。
- Dependencies：Task 14。

## Task 16: 视觉知识后台

- [x] 增加认证 REST API、分页列表、创建/发布/归档和图片预览。
- [x] 增加“视觉知识库”导航、上传分析表单和配方列表。
- Verify：HTTP 集成测试、类型检查、构建和键盘/响应式浏览器检查。
- Dependencies：Tasks 14–15。

## Task 17: Worker 融合

- [x] 任务首次生成时匹配并锁定已发布配方版本。
- [x] 主图组合全局规则、视觉配方和任务内容；授权图片加入参考图路径。
- Verify：Fake OpenClaw 断言提示词、路径和重试锁定；空知识库回归测试。
- Dependencies：Tasks 14–16。

## Task 18: 质量门与文档

- [ ] 全量测试、类型检查、构建、Mock 冒烟、浏览器和安全检查通过。
- [x] README 记录模块边界、保留模式、真实分析成本和后续范围。
- 当前：自动化测试、构建和真实 HTTP 流程通过；本机浏览器控制层拦截 localhost，未取得浏览器截图。
- Verify：无秘密、无高危依赖、无跳过测试、现有流程无回归。
- Dependencies：Tasks 14–17。

## Task 19: 全量图片计划契约

- [x] `imagePlan` 数量严格等于任务的 3–5 张配置。
- [x] 每张包含独立职责、信息要点和非空图像模型提示词。
- Verify：3/5 张合法，数量不符、首项非 hero、空提示词均被契约测试拒绝。
- Dependencies：Task 18。

## Task 20: 逐图文本驱动提示词

- [x] 每张最终提示词包含生成后的完整标题/正文和本页计划。
- [x] 每张叠加任务固定图片规则及锁定视觉配方，限制总长度 8,000 字符。
- Verify：Fake OpenClaw 捕获的所有提示词包含正文和对应页要点。
- Dependencies：Task 19。

## Task 21: 全模型图集渲染

- [x] Live 模式每张交付图调用一次文生图或图生图。
- [x] 第二张起使用首图作风格参考，但生成新页面；Sharp 只做 1080×1440 规范化。
- Verify：3/5 张调用次数、参考路径、模型来源、尺寸和唯一文件测试。
- Dependencies：Task 20。

## Task 22: 提示词发布与质量门

- [x] 发布新的文本与图片系统提示词版本，历史任务快照不变。
- [x] 定向测试、全量测试、类型检查、构建和差异审查完成。
- Verify：`npm run prompts:install-rules`、`npm test`、`npm run typecheck`、`npm run build`。
- Dependencies：Tasks 19–21。

## Task 23: OpenClaw 需求检测契约

- [x] 按行数和字符预算构造有界批次，Query 作为不可信 JSON 数据传入。
- [x] 严格拒绝缺行、重复行、额外行、非法档位、空或超长理由。
- Verify：先写失败的服务测试，再用 Fake OpenClaw 通过。
- Dependencies：Task 22。

## Task 24: Excel 预检集成

- [x] 只检测结构合格且未带 Excel 判定的行；全部检测成功后才创建预览批次。
- [x] SQLite 记录 `OPENCLAW` 来源与实际模型名，人工修改后来源变为 `MANUAL`。
- Verify：管理存储测试、路由相关测试和迁移回归通过。
- Dependencies：Task 23。

## Task 25: 体验与质量门

- [x] 上传按钮和成功信息明确显示 OpenClaw 检测状态、成本与人工复核边界。
- [x] README 记录自动检测、模型配置和失败语义。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、浏览器导入页检查。
- Dependencies：Task 24。

## Task 26: 网页 Worker 启动器

- [x] 使用固定 Node CLI 路径与参数数组启动 `drain --live`，禁止 Shell。
- [x] 单次最多 20 条；活动进程未退出时拒绝重复启动，退出后允许下一次运行。
- Verify：Fake child process 先写失败测试，再验证参数、冲突、错误与退出恢复。
- Dependencies：Task 25。

## Task 27: Worker Run API

- [x] 新增认证同源 `POST /api/worker-runs`，严格校验 max 与费用确认字面值。
- [x] 无待处理任务、存在 processing 任务或已有网页 Worker 时返回统一 409。
- Verify：路由契约测试、类型检查与构建通过。
- Dependencies：Task 26。

## Task 28: 导入页生成入口

- [x] 已提交且有准入任务的批次显示“启动 OpenClaw 生成”，说明全局队列顺序和调用成本。
- [x] 浏览器二次确认后异步启动，展示成功/失败状态和“内容审核”入口。
- Verify：前端契约测试、键盘操作、浏览器控制台和响应式页面检查。
- Dependencies：Task 27。

## Task 29: 最终正文视觉计划契约

- [x] 在正文生成后执行独立视觉规划，输出与图片数量严格一致的逐页计划。
- [x] 每页包含来源证据、允许显示文字、视觉主体、必须展示和禁止内容，并严格校验不可信模型 JSON。
- Verify：先写失败的纯契约测试；合法 3/5 页通过，缺页、额外页、正文外证据和非法简体中文字段失败。
- Dependencies：Task 28。

## Task 30: 视觉计划与布局提示词集成

- [x] 每张图片提示词使用最终正文、当前页视觉计划和简体中文白名单。
- [x] 将锁定视觉配方的 `layoutRules` 按页面类型加入提示词，继续保持 8,000 字符上限。
- Verify：Fake OpenClaw 捕获的逐页提示词包含唯一来源证据、白名单和对应布局规则。
- Dependencies：Task 29。

## Task 31: 逐页视觉验收与有限重试

- [x] 使用 `runVision` 对规范化 PNG 做严格结构化验收，检查主体、场景、文字、额外事实、风格和布局。
- [x] 失败页携带修复指令重新生成，首次生成后最多修复两次；最终失败进入 QC 阻断。
- Verify：Fake 视觉模型覆盖首次通过、修复后通过、非法 JSON 和达到上限仍失败。
- Dependencies：Task 30。

## Task 32: 文本版本与图片验收状态

- [x] 生成资产记录文本修订、页码、视觉计划哈希和验收状态，迁移保持历史数据库可打开。
- [x] 新文本修订创建后将旧生成/编辑图片标记为 `STALE`，审核批准拒绝过期或未通过的图片。
- Verify：SQLite 集成测试覆盖新库、旧库迁移、生成同步、文本修改失效和批准门槛。
- Dependencies：Task 31。

## Task 33: 批量风格调度

- [x] 已发布且内容匹配的视觉配方进入 Top-K 稳定带权选择。
- [x] 同批次近期任务避免重复，单配方达到默认 15% 配额时优先选择其他合格候选；候选不足时安全回退。
- Verify：SQLite 测试覆盖稳定复现、近期去重、配额和单候选回退。
- Dependencies：Task 32。

## Task 34: 体验、文档与最终质量门

- [x] 更新真实调用成本说明和审核页图文匹配状态，不触发自动发布。
- [x] 更新优化文档的实施状态和剩余混合排版边界。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、`npm run smoke`、差异和秘密检查。
- Dependencies：Tasks 29–33。

## Task 35: GPT OCR 逐字验收

- [x] 同一次 `runVision` 返回标题、副标题、要点、额外文字、不可辨认区域、繁体标记和 OCR 置信度。
- [x] 程序将识别文字与 `allowedVisibleText` 逐字段比较，低于 90% 或任何关键字段不一致时改判失败并触发修复。
- Verify：契约测试覆盖完全一致、名义 PASS 但错字、额外文字、繁体、不可辨认区域和低置信度。
- Dependencies：Task 31。

## Task 35: 0–3 分评分聚合契约

- [x] 定义固定维度、证据来源、问题标签、类型校正和互斥最终结果。
- [x] 覆盖 0/1 前置终止、2/3 边界、平台样本封顶和证据不足。
- Verify：先运行失败的 `tests/quality-scoring.test.mjs`，再实现到全部通过。
- Dependencies：Task 34。

## Task 36: 机械 QC 集成

- [x] 把现有检查映射为保守维度分，机械证据不足时不得给 3。
- [x] `qc.json` 增加 `rubric`，顶层旧字段、manifest、SQLite 和审核门槛保持兼容。
- Verify：`tests/qc.test.mjs` 与 pipeline/worker 集成测试通过。
- Dependencies：Task 35。

## Task 37: 评分展示与最终质量门

- [x] 审核页展示 0–3 分语义，manifest 记录规则版本和处置动作，不增加自动发布。
- [x] 更新 README/规格实施状态并完成差异、秘密和兼容性检查。
- [ ] 全量测试清零；当前受 Phase 10 `image-alignment` OCR 契约的 5 个既有失败阻塞。
- Verify：`npm test`、`npm run typecheck`、`npm run build`。
- Dependencies：Task 36。

## Task 38: Live 批次预检

- [x] 在 `drain --live` 领取任务前执行一次无推理、无图片调用的本地预检。
- [x] 运行时不兼容、OpenClaw 不可启动或模型配置仍使用旧 provider 时立即失败。
- Verify：Fake runner 覆盖成功、Node 不兼容、旧模型配置和命令失败；CLI 测试确认 attempts 保持不变。
- Dependencies：Task 37。

## Task 39: 任务租约续期

- [x] Queue 支持同一 owner 有界续租，其他 owner 和非 processing 状态不能续租。
- [x] Worker 在各模型阶段和逐页生成/验收边界刷新租约。
- Verify：SQLite 时间测试与管线 Fake 覆盖长任务、错误 owner 和租约丢失。
- Dependencies：Task 38。

## Task 40: 文本与视觉计划检查点

- [x] 正文和视觉计划通过契约后立即原子保存，而不是等全部图片完成。
- [x] 失败任务重试时，配置指纹一致才复用；人工文案或提示词变化必须重新生成。
- Verify：管线测试证明图片失败后重试不再调用文本/视觉规划，指纹变化后会重新调用。
- Dependencies：Task 39。

## Task 41: 逐页图片检查点

- [x] 每张通过图文验收的图片记录文件哈希、页码、视觉计划哈希和最终证据。
- [x] 重试只复用文件存在、哈希一致且 alignment PASS 的页面，其余页面重新生成。
- Verify：测试覆盖部分成功、文件篡改、验收失败和人工文案变更。
- Dependencies：Task 40。

## Task 42: 批量可靠性质量门

- [x] 全量测试、类型检查、生产构建和 Mock 冒烟通过。
- [x] 审查性能、安全、秘密、旧数据库迁移和未提交差异，不增加自动发布。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、`npm run smoke`。
- Dependencies：Tasks 38–41。

## Task 43: 审核评分详情

- [x] SQLite 生成记录保存有界的完整质检详情，并兼容旧数据库。
- [x] 当前评分、限制分数的维度和证据以中文文本显示，不渲染 JSON。
- Verify：生成记录迁移/往返测试；评分原因展示模型测试。
- Dependencies：Task 42。

## Task 44: 图片生成批次

- [x] 图片按生成运行归组，编辑后版本跟随其生成根图所在批次。
- [x] 每个批次内统一显示运行状态、文案/提示词版本、视觉配方和质检摘要。
- Verify：批次归组测试覆盖完成、失败、编辑后版本和历史未匹配图片。
- Dependencies：Task 43。

## Task 45: 审核工作台排版

- [x] 完整文案与审核结论优先展示，保留通过、驳回、重开、导出和上传。
- [x] 删除独立版本记录、生成质检和固定生产配置板块，将信息移入图片批次。
- Verify：前端契约测试、320/768/1024/1440 响应式检查。
- Dependencies：Task 44。

## Task 46: 预览内图片操作

- [x] 预览支持倍率缩放和不落盘旋转，不再生成旋转副本。
- [x] 只有非 3:4 图片显示裁剪按钮；裁剪与当前图片 AI 编辑均在预览中执行。
- Verify：组件行为测试、键盘操作、真实浏览器截图与控制台检查。
- Dependencies：Task 45。

## Task 47: 全局生产配置

- [x] 持久化质量修复开关、触发分、目标分、最多修复次数和 AI 标识配置，兼容旧数据库。
- [x] 配置进入 Worker、检查点指纹和交付清单，提供严格 GET/PATCH API。
- Verify：配置纯函数、SQLite 迁移/往返和 API 契约测试。
- Dependencies：Task 42。

## Task 48: 1 分整套质量修复

- [x] 首次 Live 终审恰好 1 分时，以当前图片为输入重新生成整套页面，至少 2 分即停止，最多修复两次。
- [x] 每轮记录原因、方法、修复前后分数和耗时，最终 QC 保留完整历史。
- Verify：Fake OpenClaw 覆盖 1→2、1→1→2、两次仍失败，以及首次 0/2 不触发。
- Dependencies：Task 47。

## Task 49: 批次耗时与统计聚合

- [x] 生成运行保存开始、完成和实际耗时；旧记录保持可读。
- [x] 聚合导入批次进度、墙钟耗时、平均任务耗时、评分分布和质量修复次数。
- Verify：生成存储迁移测试和统计纯函数/SQLite 集成测试。
- Dependencies：Task 48。

## Task 50: 配置、统计和证据展示

- [x] 增加生产配置页和数据统计页，并加入主导航。
- [x] 审核页展示质量修复历史和生成批次耗时；导入页展示批次时间与进度。
- Verify：前端契约、键盘可用性、响应式构建和浏览器检查。
- Dependencies：Task 49。

## Task 51: 最终质量门

- [x] 更新 README，完成定向测试、全量测试、类型检查、生产构建和 Mock 冒烟。
- [x] 审查未提交差异、秘密、迁移兼容性和模型调用上限。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、`npm run smoke`。
- Dependencies：Tasks 47–50。

## Task 52: 自然文案结构回归测试

- [x] 固化按内容类型选结构、默认不写步骤体的提示词要求。
- Verify：`node --test tests/default-prompts.test.mjs tests/post-contract.test.mjs` 先失败。
- Dependencies：Task 51。

## Task 53: 文案提示词调整

- [x] 修改基础正文契约和任务固定文本提示词，加入自然表达与分类结构规则。
- [x] 保留事实、来源、安全、长度和 JSON 契约。
- Verify：Task 52 的定向测试转为通过。
- Dependencies：Task 52。

## Task 54: 自然文案质量门

- [x] 完成全量测试、类型检查、构建和差异审查。
- [x] 说明新提示词只影响重新发布后创建的新任务。
- Verify：`npm test`、`npm run typecheck`、`npm run build`。
- Dependencies：Task 53。

## Task 55: 联网研究契约

- [x] 定义 Live/Mock/人工文案边界、来源快照字段、失败关闭和双重持久化。
- [x] 明确 Codex 优先、DuckDuckGo 后备，以及当前不声称抓取网页全文。
- Verify：`docs/web-research-source-spec.md` 覆盖成功、失败、安全和历史兼容。
- Dependencies：Task 54。

## Task 56: OpenClaw 检索适配器

- [x] 以无 shell 参数调用 `infer web search --json`，校验输入、解析输出并脱敏错误。
- [x] 归一化结构化结果和 Codex 归纳结果，过滤非公开 HTTP(S) URL。
- Verify：`node --test tests/openclaw.test.mjs tests/research.test.mjs`。
- Dependencies：Task 55。

## Task 57: Worker 研究阶段

- [x] Live 正文生成前检索，来源进入提示词和允许 URL 白名单。
- [x] 保存 `research.json`，写入 manifest 与 checkpoint；图片失败重试不重复检索。
- Verify：`node --test tests/pipeline.test.mjs tests/post-contract.test.mjs tests/checkpoint.test.mjs`。
- Dependencies：Task 56。

## Task 58: 生成记录来源快照

- [x] 为新旧 SQLite 增加可空、有界的 `research_snapshot_json`。
- [x] 成功和失败回调都保存实际快照，旧记录返回 `null`。
- Verify：`node --test tests/generation-store.test.mjs tests/worker-integration.test.mjs`。
- Dependencies：Task 57。

## Task 59: 联网研究质量门

- [x] 更新提示词、环境说明和 README，说明资料边界、提供方与失败行为。
- [x] 完成定向测试、全量测试、类型检查、生产构建和差异审查。
- Verify：`npm test`、`npm run typecheck`、`npm run build`。
- Dependencies：Tasks 55–58。

## Task 64: 批量输入与执行契约

- [x] 每行一个选题，清理空行并拒绝少于 2 条、多于 20 条、重复项或超过 500 字的项。
- [x] 共享参考链接沿用单次模式的协议、凭据、数量和长度边界。
- Verify：`node --test tests/batch-generation.test.mjs` 先失败再通过。
- Dependencies：Task 63。

## Task 65: 独立批量图文模式

- [x] 新增导航和 `/batch-generation` 页面，不改写两个单次工作台。
- [x] 每条依次调用单次文案 API 和单次图片 API，图片使用文案返回的当前版本与图片策划。
- Verify：源码契约测试、`npm run typecheck`、`npm run build`。
- Dependencies：Task 64。

## Task 66: 批次交互与质量门

- [x] 显示整批进度和逐条状态，支持当前条结束后停止；失败条记录阶段和原因并继续。
- [x] Live 图片整批费用确认、Mock 说明、键盘语义和窄屏布局完整。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、真实浏览器检查。
- 当前：自动化测试、类型检查和生产构建通过；可用浏览器没有已登录后台会话，只验证到受保护路由正确跳转登录页。
- Dependencies：Task 65。

## Phase 21: 批量文案与图片分离

## Task 80: 拆分批量入口

- [x] 新增 `/batch-copy-generation` 与 `/batch-image-generation`，更新导航和顶部上下文。
- [x] `/batch-generation` 兼容跳转到批量生文。
- Verify：`node --test tests/batch-generation.test.mjs`。
- Dependencies：Task 79。

## Task 81: 批量文案质检门禁

- [x] 文案生成成功后停在待人工质检，不调用图片 API。
- [x] 展示完整文案并通过现有接口持久化人工确认；恢复最近未确认记录。
- Verify：定向测试与 `npm run typecheck`。
- Dependencies：Task 80。

## Task 82: 已质检文案批量生图

- [x] 只展示 `manualReview=APPROVED` 的文案，每批选择 1–20 条。
- [x] 保留 Mock/Live、整批费用确认、顺序执行、失败隔离和停止控制。
- Verify：定向测试与 `npm run typecheck`。
- Dependencies：Task 81。

## Task 83: 分离模式质量门

- [x] 完成 502 项全量测试、类型检查、生产构建和五轴差异审查。
- [x] Chrome 管理员会话验证两个页面、旧地址跳转、完整质检内容、桌面与 375px 布局，控制台无错误。
- Dependencies：Tasks 80–82。

## Phase 22: 批量文案批次分组

## Task 84: 批次数据与 API 契约

- [x] 增加可空批次 ID/名称、旧库迁移、任务完成继承、批次筛选和聚合摘要。
- [x] POST 接受可选批次对象，GET 接受批次筛选并返回最近批次。
- Verify：存储与 API 回归测试先失败再通过。
- Dependencies：Task 83。

## Task 85: 批次命名与恢复界面

- [x] 每次批量提交只创建一个唯一批次 ID，名称留空时自动生成时间名称。
- [x] 最近批次可筛选并展示该批次的成功、运行中和失败记录；历史数据标为未分组。
- Verify：批量 UI 契约测试、类型检查和生产构建。
- Dependencies：Task 84。

## Task 86: 批次分组质量门

- [x] 完成定向/全量测试、Mock smoke、浏览器桌面与窄屏检查。
- [x] 复核兼容性、安全边界、提示词隔离和未提交差异。
- Verify：513 项测试、类型检查、生产构建、Mock smoke 通过；Chrome 管理员会话以隔离测试库验证两个批次切换、成功/失败/进行中恢复和 375px 无横向溢出，控制台无错误。
- Dependencies：Tasks 84–85。

## 2026-09-04: 执行机文案案例匹配（已完成）

- [x] K0a：取消 OpenClaw 文本 prompt 的固定字符上限。
  - Acceptance：超过 30,000 字符的合法 prompt 全文传入调用；保留类型和非空校验；实际上下文错误可识别。
  - Verify：tests/text-client-capacity.test.mjs 与 tests/openclaw.test.mjs，使用 fake runner 验证完整消息内容及错误传播。
  - Files：src/openclaw.mjs、tests/text-client-capacity.test.mjs。
  - Dependencies：无。

- [x] K0b：同步 Dots 与 DeepSeek 模拟文本客户端。
  - Acceptance：两个客户端取消 30,000 字符限制且不裁剪请求；保留输出容量控制并识别不完整响应。
  - Verify：tests/text-client-capacity.test.mjs 与现有客户端测试，使用 fake fetch 验证大输入全文与容量错误。
  - Files：src/dots-chat-client.mjs、src/deepseek-responses-client.mjs、tests/text-client-capacity.test.mjs。
  - Dependencies：无。

- [x] K1：实现摘要评分与选优模块。
  - Acceptance：全部摘要不截断，以实际模型容量决定是否分批；每条候选都评分；score >= 70 才合格；最高分胜出，同分稳定；错误输出不能进入选优。
  - Verify：新增 tests/copy-knowledge-match.test.mjs，用 fakes 覆盖 69.99/70 边界、同分、分批、缺项、重复 ID、未知 ID 和非法分数。
  - Files：src/copy-knowledge-match.mjs、tests/copy-knowledge-match.test.mjs。
  - Dependencies：K0a、K0b。

- [x] K2：把胜出案例完整分析接入生成提示词。
  - Acceptance：基础提示词加单个完整分析；先渲染管理员模板再加入数据；不按固定字符数截断或拒绝，实际模型上下文不足时明确失败。
  - Verify：tests/copy-knowledge-generation.test.mjs 与现有提示词测试，检查完整内容、未选案例隔离、数据转义和长度边界。
  - Files：src/post-contract.mjs、src/copy-knowledge-match.mjs、tests/copy-knowledge-generation.test.mjs。
  - Dependencies：K1。

- [x] K3：接入执行机正式文案链路。
  - Acceptance：Query 审核后、首稿前执行匹配；使用领取快照；NO_MATCH/EMPTY 按建议继续基础生成，调用失败单独报错。
  - Verify：tests/copy-knowledge-generation.test.mjs 与现有生成/执行机测试，fake 调用验证顺序、阶段进度和失败路径。
  - Files：src/copy-generation.mjs、src/executor/agent.mjs、tests/copy-knowledge-generation.test.mjs。
  - Dependencies：K1、K2。

- [x] K4：保存可追溯结果。
  - Acceptance：generation.knowledgeMatch 保存覆盖数量、分数理由、门槛、选中版本、模型及分析哈希；匹配耗时随结果上传中心。
  - Verify：tests/copy-knowledge-generation.test.mjs，验证 completeCopy 收到完整元数据及原有结果字段。
  - Files：src/copy-generation.mjs、src/executor/agent.mjs、tests/copy-knowledge-generation.test.mjs。
  - Dependencies：K3。

- [x] K5：同步模拟执行入口并完成回归文档。
  - Acceptance：模拟入口复用评分规则、版本固定与门槛，保留模拟标记；更新执行流程说明。
  - Verify：tests/copy-knowledge-generation.test.mjs、tests/deepseek-copy-simulator.test.mjs；npm test 全量653项、类型检查、生产构建通过。
  - Files：src/executor/deepseek-copy-simulator.mjs、tests/copy-knowledge-generation.test.mjs、docs/distributed-control-plane.md。
  - Dependencies：K3、K4。
