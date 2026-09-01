# Spec: Query 预审与任务级内容质检中心

## Objective

在现有内容工场中提供两类人工质检作业：

1. Query 预审仍以导入行为独立工单，可生成、领取、分配和提交结论。
2. 生产质检以“内容任务”为唯一分配单位。管理员按批次、审核人和条数分配任务；一个任务从文案核对、图片核对到最终完成始终由同一名内容质检员负责。

本阶段不改变 Worker 的连续生产语义。自动 Query/文案门禁继续运行；人工质检作为独立的可追溯作业闭环，不阻塞正文或图片生成。

## Assumptions

1. 现有环境变量管理员账号继续作为系统超级管理员和应急入口。
2. 质检人员由管理员创建，不开放公共注册。
3. `QUERY_REVIEWER` 只处理 Query 预审；内部兼容角色名 `COPY_REVIEWER` 的产品含义升级为“内容质检员（文案+图片）”。
4. 一个生产任务只能有一条任务级分配记录；文案或图片版本变化不会改变负责人。
5. 文案结论和图片结论分别绑定提交时的不可变内容快照与 SHA-256。版本变化后旧结论显示为“已失效”，但不被覆盖。
6. 管理员按批次为某位内容质检员分配精确条数；库存不足时整次分配失败，不做静默的部分分配。
7. 第一阶段继续使用 SQLite/WAL 和本地局域网部署；跨公网使用必须另行配置 HTTPS。

## Tech Stack

- Node.js 24 ESM、`node:sqlite`、scrypt、HMAC-SHA256。
- Next.js 16 App Router、React 19、TypeScript、Zod。
- `node:test`，不增加第三方认证或状态管理依赖。

## Commands

- 定向测试：`node --test tests/review-work-store.test.mjs tests/reviewer-auth.test.mjs tests/review-center-ui.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`
- 安全检查：`npm audit --audit-level=high`

## Project Structure

- `src/admin/review-work-store.mjs`：人员、Query 工单和旧 COPY 工单兼容事务。
- `src/admin/review-task-store.mjs`：任务级分配、文案/图片阶段结论、快照失效和任务审计事务。
- `src/admin/auth.mjs` / `src/admin/http.mjs`：兼容管理员会话的人员会话与角色授权。
- `app/api/review-users/`：管理员人员管理接口。
- `app/api/review-work-items/`：Query 工单的分页、生成、分配、领取和结论接口；旧 COPY 工单接口仅作迁移兼容。
- `app/api/review-task-assignments/`：任务分配、转派、阶段结论和受控图片读取接口。
- `app/reviews/`：按条数派单、我的任务、Query 队列和统一文案/图片审核详情。
- `tests/`：领域、认证、接口边界和页面契约测试。

## Data Contract

### Roles

- `ADMIN`：系统管理员，管理人员、生成 Query 工单并按条数分配生产任务。
- `QC_LEAD`：查看全部质检作业并分配/转派。
- `QUERY_REVIEWER`：领取和处理 Query 预审工单。
- `COPY_REVIEWER`：兼容内部标识；产品名称为“内容质检员”，负责同一任务的文案与图片。

### Query work item lifecycle

```text
OPEN --assign/claim--> IN_REVIEW --approve--> APPROVED
                               \--reject---> REJECTED
OPEN/IN_REVIEW ---------------------------> STALE | CANCELLED
```

Query 终态不可修改。重新审核须创建绑定新内容指纹的工单。

### Production task ownership lifecycle

```text
未分配 --按条数分配--> 同一内容质检员
                           |
                           +-- 文案结论（可多次，追加保存）
                           +-- 图片结论（文案当前版本已通过且存在当前图片后可提交）
                           +-- 文案/图片更新后旧结论变为失效，负责人不变
                           +-- 当前文案和当前图片均通过后显示已完成
```

转派只改变当前负责人和并发版本，不删除原审核人提交的历史结论。

### Tables

- `review_users`：用户名、显示名、scrypt 密码哈希、角色 JSON、启用状态和凭据版本。
- `review_work_items` / `review_decisions` / `review_events`：Query 工单及旧 COPY 工单的兼容历史。
- `review_task_assignments`：每个 `task_id` 唯一的负责人、批次、并发版本和分配时间。
- `review_task_stage_decisions`：`COPY|IMAGE` 阶段的追加式结论、审核人、原因、主体快照与哈希。
- `review_task_events`：按条数分配、转派和阶段提交的追加式审计记录。

### Freshness rules

- 当前文案指纹包含任务、Query、external ID、当前文本修订 ID、标题、正文和标签。
- 当前图片指纹包含当前文案指纹和当前文本修订所对应的生成/编辑图片 ID、文件哈希、页码、版本与图文匹配状态。
- 阶段最新结论的指纹与当前指纹不一致时，状态为 `STALE`。
- 图片通过必须建立在当前文案已通过、所需页码完整且每张当前图片均已通过图文匹配验收之上。

## API Contract

- `GET/POST /api/review-users`：管理员查询或创建人员；响应永不返回密码哈希。
- `PATCH /api/review-users/:id`：管理员更新显示名、角色或启用状态。
- `GET /api/review-work-items`：查询 Query/兼容历史工单。
- `POST /api/review-work-items`：仅在产品 UI 中生成 Query 工单。
- `GET /api/review-task-assignments`：管理员/组长查看全部；内容质检员只查看分配给自己的任务。
- `POST /api/review-task-assignments/allocations`：按 `importBatchId + assigneeUserId + count` 原子分配最早的未分配任务。
- `POST /api/review-task-assignments/:id/reassignments`：管理员/组长以 `expectedVersion` 转派。
- `POST /api/review-task-assignments/:id/stage-decisions`：当前负责人提交 `COPY|IMAGE` 的 `APPROVED|REJECTED` 结论。
- `GET /api/review-task-assignments/:id/assets/:assetId`：仅管理员、组长或当前负责人读取该任务图片。

所有列表分页；所有写输入使用严格 Zod 契约；无权限返回 `403`，版本冲突返回 `409`，分配库存不足返回 `409`。

## Migration

1. 新表采用只增不改迁移，现有 Query 工单不受影响。
2. 每个已有、已分配的 COPY 工单按 `task_id` 迁入一条任务级分配；同任务多条记录以最早已分配记录建立负责人，后续可显式转派。
3. 已有 COPY 结论迁入 `COPY` 阶段历史，并保留原审核人、时间、快照和哈希。
4. 产品 UI 停止生成新 COPY 工单；旧接口和表暂时保留一个兼容周期，避免历史数据与旧客户端立即失效。

## Security and Abuse Cases

- 质检员伪造分配 ID 或图片 ID 查看他人内容：领域层同时校验当前用户、角色、assignment、task 与 asset 归属。
- 质检员替别人提交阶段结论：只允许数据库中的当前负责人写入。
- 两位组长同时按条数分配：`BEGIN IMMEDIATE` 内重新统计并插入，库存不足整次回滚。
- 转派与提交同时发生：所有写入携带 `expectedVersion`，失败返回 `409`。
- 停用人员继续使用旧 Cookie：质检领域接口重新读取数据库中的人员状态和角色。
- 文案修改后沿用图片通过结论：图片快照包含当前文案指纹；任何文案或图片变化都会使旧结论失效。

## Testing Strategy

- SQLite 集成：精确按条数分配、任务唯一负责人、库存不足回滚、并发版本冲突、转派、阶段顺序、内容失效和旧 COPY 迁移。
- 认证/授权：活动账号重读、跨任务读取/提交禁止、图片归属检查。
- API 契约：严格输入、角色白名单、分页、expectedVersion 和统一错误。
- UI 源码契约：按批次/人员/条数派单、任务级列表、统一文案图片详情、阶段状态与旧 Query 队列。
- 运行时：管理员分配 N 条、内容质检员登录、核对文案、查看图片并提交图片结论。

## Boundaries

- Always：服务端授权；参数化 SQL；任务唯一负责人；阶段快照；追加审计；密码哈希；通用登录错误。
- Ask first：把人工结论改为 Worker 硬门禁、自动负载均衡、二审抽检、内容编辑与审核岗位强制隔离。
- Never：共享质检账号；客户端决定角色或任务归属；覆盖历史结论；把模型审核结果冒充人工结论。

## Success Criteria

1. 管理员可选择一个批次、内容质检员和条数，原子分配恰好 N 个尚未分配的生产任务。
2. 同一任务只有一个当前负责人，文案/图片版本更新后负责人保持不变。
3. 内容质检员只能看到自己的任务，可在同一详情页核对文案和当前图片。
4. 文案和图片结论分别记录审核人、内容指纹、理由和时间；旧结论不会套用到新版本。
5. 当前文案通过且完整当前图片集均通过图文匹配验收后才允许图片通过；两阶段当前版本均通过后任务显示质检完成。
6. 旧 Query 质检、管理员登录、任务审核、导入、Worker 和导出行为保持兼容。
7. 定向测试、全量测试、类型检查、构建和高危依赖扫描通过。

## Open Questions

- 人工文案通过是否必须成为生图前硬门禁，留给后续 Worker 拆分规格决定。
- 是否要求同一人员不得同时承担内容修改与审核，留给后续岗位隔离策略。
