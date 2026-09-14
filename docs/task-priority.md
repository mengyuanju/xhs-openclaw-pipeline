# 统一任务优先级与管理员调序

开发基线：本地 `auto-clow-poker` 的 `4c8d63b`；原分支 `codex/task-priority` 已合并到 `codex/integrate-workflow-upgrades`。未发布，也未增加生产定时任务。

## 优先级规则

| 来源 | 等级 |
| --- | ---: |
| 强制复检，或累计两次及以上返工 | 400 |
| 一次返工后的修改、图片终审打回 | 300 |
| 人工重试／重新排队 | 200 |
| 系统自动恢复 | 150 |
| 首次任务 | 100 |
| 管理员最高／高／普通／暂缓 | 500／350／100／10 |

`system_priority` 消费现有 `mandatory_copy_qc`、审核状态、当前稿件版本变化和返工记录。正常质检通过或强制复检通过进入生图不会新增返工次数；历史回填分别统计质检退回稿和终审返工记录，普通修改稿不重复计数。`manual_priority` 是管理员覆盖值，`effective_priority = COALESCE(manual_priority, system_priority)`。跟随系统会清除覆盖和暂停；暂停保留业务状态，停止自动领取和新的审核处理，不终止已经运行的执行。

防饥饿使用稳定的虚拟入队时间：`priority_sort_at = queue_entered_at - effective_priority × 10 分钟`，从小到大排序，最后以任务 ID 消除完全相同时间的并列。这等价于等待每小时增加 6 点优势。因此通常按等级处理，同级严格先入先出；长时间等待的低优先任务最终可排在新来的高优先任务前。补偿不需要后台定时更新，游标分页也不用保存不断变化的分数。

切换状态、重新分配生产负责人以及当前审核队列内产生新的修改稿，会记录当前队列的进入时间。单纯调整管理员优先级不重置等待时间。运行中修改优先级只改变排序元数据；当前执行 ID、状态和执行机均保持不变，下次排队时使用新设置。

## 分配与状态关卡

- 文案自动派工保留原来的 USER 成员池、配额和连续／定量模式。排序选取候选任务后，以实时加权负载选择人；同负载取最久未分配者。定量模式仍尊重管理员指定的人员，但候选任务按统一优先级选取。
- 负载为每项基础 1，加上高优先增量 `max(0, effective_priority - 100) / 100`、最多 3 点返工增量，以及处理中任务 2 点增量。每次分配后立即更新计划中的负载。图片终审负责人只在任务仍处于图片终审时承担该项审核负载，退回到文案或生图后不再计入旧审核人的负载。
- 质检和图片终审具有独立的审核负责人字段，按 ACTIVE 的 ADMIN／REVIEWER 加权分配。质检排除最终初审人，保留盲审约束。审核分配使用事务级咨询锁串行化；已有有效负责人不会因调序而改变。
- 审核员待处理列表只列自己的新分配任务。原有管理员总览、历史查看和持有合法匿名链接的审核权限继续保留；新增字段没有替代原来的权限检查。
- 图片执行仍先按生产负责人公平轮转，负责人内部按优先级排序。原执行机恢复亲和性、重试冷却、行锁与 `SKIP LOCKED` 均保留。
- 暂停中完成的机器任务不会立即分配下一轮图片终审；恢复时再分配。已经分配的审核任务暂停后保留负责人。
- 调序接口仅修改优先级元数据，不修改文案审核、冻结、质检、稿件批准或生图状态。单条加急不能放行冻结成员。整批调整在一个事务内检查完整成员集合和各自版本；成员或管理员版本变化会整体失败。

## 管理员 API 和页面

所有接口均验证 ADMIN 角色；仓储事务内再次锁定并验证账户 ID、用户名、角色、ACTIVE 状态和凭据版本。

| 接口 | 用途 |
| --- | --- |
| `POST /v1/tasks/priority-scope` | 预览 `{ taskIds }` 或 `{ productionBatchId }` 的成员及优先级版本 |
| `POST /v1/tasks/priority` | 提交范围、`mode`、必填 `reason` 和所有成员的 `expectedVersions` |
| `GET /v1/tasks/:taskId/priority-audit` | 读取该任务的追加式调整记录 |
| `GET /v1/tasks?priorityMode=HIGH` | 按管理员设置筛选；其他枚举同样适用 |

模式枚举：`HIGHEST`、`HIGH`、`SYSTEM`、`NORMAL`、`DEFER`、`PAUSE`。批量选择最多 100 条；生产批次范围包含整个批次。重复提交旧版本返回 409，避免重复生效。批次有成员变化也返回冲突，要求重新预览。

任务列表、详情和批量操作均提供调整入口；同批任务可扩展为整个生产批次。提交前显示影响范围，必须填写原因。列表显示系统／人工／生效等级和来源；质检盲审只显示受限的优先级说明文本，不附带任务 ID、人员信息或管理员自由文本原因。

每条审计保留不可复用的账户 ID、用户名、原因、调整前后模式、生效等级、业务状态、批次、时间和版本。任务或账号删除不会级联删除审计。数据库触发器禁止修改、删除和清空审计表；规范化 JSON 的 SHA-256 链可检测证据变化。审计的信任边界是应用和数据库权限：这不是外部签名／独立存证系统，拥有数据库超级用户权限者仍能关闭触发器；如需超越此权限边界的法律级不可抵赖，需要对接独立签名及存证服务。

## 文件入口

- `server/migrations/0050_queue_priority.sql`：字段、历史回填、集中触发器、索引、审核分配及审计保护。没有改动 0048、0049。
- `server/src/task-priority.mjs`：等级、来源、排序及负载计算。
- `server/src/task-priority-store.mjs`：范围、版本冲突、原子批次调整和哈希证据。
- `server/src/postgres-repository.mjs`：领取、任务映射、分页筛选、管理员仓储方法和重排元数据。
- `server/src/task-auto-assignment-runner.mjs`：加权负载、分配历史及候选顺序。
- `server/src/copy-quality-control.mjs`：质检队列、盲审显示和暂停检查。
- `server/src/http-server.mjs`：鉴权入口、筛选和终审 `copyFields` 转发。后者修复了既有接口未将该字段传给仓储的问题，没有改造返工流程。
- `app/workbench/task-priority-control.tsx`、`creation-workbench.tsx`、`task-review-dialog.tsx`、`views.ts`：调序、展示和本地比较。
- `app/copy-qa/types.ts`、`copy-qa-workbench.tsx`：盲审白名单说明及队列显示。
- `server/tests/task-priority.test.mjs`、`tests/task-priority-ui.test.mjs`：新增规则、审计、负载和界面契约测试。
- 现有领取、分配、仓储和 `modular-workflow-postgres.e2e.test.mjs` 测试同步调整排序预期，并补充真实并发、批次、暂停、亲和性、游标、HTTP 和冻结验证。

## 验证

2026-09-15 集成复核，Node.js 24 / 独立临时 PostgreSQL 18：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck:all` | 通过 |
| `npm run build:all` | 通过 |
| 优先级、界面契约、领取、派单和仓储针对性测试 | 74 通过，0 失败 |
| `npm --prefix server test` | 559 通过，0 失败；18 条显式可选测试默认跳过 |
| `RUN_POSTGRES_E2E=1 node --test server/tests/modular-workflow-postgres.e2e.test.mjs` | 15 通过，0 失败，包括 5000／10000 条数据测试 |
| `npm test` | 1145 通过，1 跳过，0 失败 |
| `npm run smoke` | 通过 |

## 已完成的质检流程集成

0053 协调迁移已经统一优先级和质检的审核分配：图片审核候选按账号审核能力选取，文案质检候选按账号质检能力选取并排除最终初审人；管理员不自动占用队列但保留人工管理能力。`copy_sampling_freezes`／`copy_sampling_items` 继续作为冻结和强制复检权威数据，任何优先级都不能创建直通批准。`queue_entered_at`、独立 `priority_version`、盲审字段限制和行锁顺序均已保留，返工只计一次。
