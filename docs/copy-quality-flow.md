# 文案质检流程优化

原实现分支：`codex/copy-quality-flow`，现已合并到 `codex/integrate-workflow-upgrades`，共同基线为 `4c8d63b`。

## 入口与权限

- `/copy-flow`：浏览、文案审核、文案质检三个入口，按当前账号返回能力；显示各队列待审核、待质检、冻结、返工、可生图数量。管理员可手动结批。
- `/users`：`copyReviewEnabled`、`copyQcEnabled` 独立开关。新旧账号迁移默认审核开启、质检关闭；原质检人员需要管理员开启质检能力。
- 审核修改接口重新锁定账号、验证实时权限和任务负责人。关闭审核时释放该账号待审核任务并清理词包分配；其他进行中任务保留负责人，管理员可转派。自动分配及数据库分配触发器禁止再次分给已关闭审核的人员。
- 质检通过、单条打回、整批打回均重新检查质检权限；普通用户角色也可独立开启质检。禁止质检自己最终审核的文案，包括管理员本人。管理员仍可只读查看全量。
- 异常放行仅管理员可执行，必须填写原因，写入事件审计。强制复检不能异常跳过。原“单独通过并立即生图”改为正常质检通过，不再绕过批次关卡。

## 批次与抽样

复用 `production_batches` 与 `copy_sampling_freezes/strata/items/events/mutation_requests`。同一投产批次可有多个冻结轮次，每个新冻结轮次只包含一个最终审核账号；已冻结成员不变，新批准任务属于下轮。

正常开放时使用整数基点累计：20% 每 5 条冻结一组、抽 1 条；100% 每条都选中。每账号独立持久化基点余数，不向另一账号借数。关闭批次或超时时对尾数保底抽检；保底额外抽样不抵扣后续比例，尾数继续按账号保存。开启普通抽检且比例为 0 时只在结批时保底抽 1；关闭普通抽检可放行初次审核任务，强制复检仍生效。

冻结保存版本号、内容哈希、成员快照摘要、比例、审核人、算法版本、随机种子以及前后余数。种子在冻结时由服务器生成，审批响应不公开种子和排名，可使用保存的种子重放抽样结果。旧算法仍用于历史快照重放；新流程每次只传入一个人员组和精确抽样数。

超时固定为 **30 分钟**。在质检/流程页面读取以及执行机 HTTP 生图领取时触发过期批次检查，最多检查 100 个过期批次；后续请求继续推进。没有新增后台定时任务或生产调度。系统无任何请求时不会自行唤醒；恢复使用后补结批。

已有冻结快照与历史审核记录不重写；新的冻结轮次使用按人员分组的规则。迁移前已经冻结的历史混合批次保留原有成员范围，不能通过迁移悄悄重抽。

## 状态与关卡

| 动作 | 结果状态 | 生图条件 |
| --- | --- | --- |
| 初审通过、等待凑样或批次结论 | `COPY_QC_PENDING` | 冻结轮次尚未通过，不可生图 |
| 抽样全部通过 | `IMAGE_QUEUED` | 同轮全部成员版本有效、没有活动冻结 |
| 单条打回 | `COPY_REVIEW_PENDING` + mandatory | 仅当前任务修改，其他成员保持冻结 |
| 整批打回 | 同人员同轮所有成员 `COPY_REVIEW_PENDING` + mandatory | 原审核人、版本链和原因保留 |
| 返工重新提交 | `COPY_QC_PENDING` + mandatory | 独立 100% 复检轮次；旧轮次仍阻塞整批 |
| 强制复检通过 | 仍等待或 `IMAGE_QUEUED` | 本轮与全部活动祖先轮次均解决后才整批放行 |
| 图片终审打回文案 | `COPY_REVIEW_PENDING` + `FINAL_REWORK` | 修改、强制复检通过后重新生图 |
| 图片终审只打回图片 | `IMAGE_QUEUED` | 复用仍有效的文案质检放行版本 |
| 已质检文案版本发生变化 | 旧质检项 `SUPERSEDED`，任务回修改并 mandatory | 新文案不能沿用旧通过结论 |

生图领取的候选查询与加锁后的查询均调用 `copyQualityImageGate`，校验：当前版本已批准、放行版本与当前版本一致、mandatory=false、没有活动冻结、没有当前版本未解决质检项、存在有效通过/放行记录。批准后的文案内容不可原位修改，须追加新版本。

冻结锁投产批次和对应人员余数；质检写操作沿用账号/requestId 事务锁、版本令牌、成员快照确认和幂等回执。相互冲突的任务锁返回可重试冲突，不会部分提交。

## 迁移与优先级分支合并

质检主体迁移为 **`server/migrations/0051_copy_quality_flow.sql`**；集成环境按 0050 优先级、0051 质检、0052 图片编辑、0053 账号审核分配协调的顺序完整应用。0053 让 USER/REVIEWER 都按账号的 `copy_review_enabled`、`copy_qc_enabled` 能力参与分配，管理员保留全局人工操作能力但不自动占用生产审核负载，并统一返工事件计数，避免质检打回重复累计。

不引入 priority 字段、排序规则或优先级管理页。维护 `rework_count`、`requeue_reason`、原有 `mandatory_copy_qc_origin`；新增 `copy_quality_queue_events` 记录进入审核、质检和生图队列的事件，优先级模块可读取这些信息。

集成后 `postgres-repository.mjs` 的优先级排序和两个生图领取查询均保留 `copyQualityImageGate`；管理员调序不能绕过冻结、强制复检或当前文案版本校验。账号关闭审核/质检能力时会释放不再合格的待办并触发重新均衡。此次只在隔离测试库执行迁移，没有发布或安排生产调度。

## 验证

- 集成迁移与完整工作流 PostgreSQL 测试 15/15，通过真实行锁、`SKIP LOCKED`、权限分配、整批打回、强制复检、生图门禁和管理员优先级验证。
- 服务端完整测试：559 通过、0 失败、18 个显式可选测试跳过。
- 新增数学边界测试与真实 PostgreSQL 流程测试：独立随机测试数据库，全量迁移重复执行、人员隔离、冻结幂等、并发通过回放、整批返工/版本链、强制复检整批关卡、旧版本失效、单条打回、超时保底、终审文案返工、账号权限关闭及数据库领取门禁均通过。
- `npm run typecheck` 通过。
- 根测试：1145 通过、1 跳过、0 失败；全仓类型检查、生产构建和 smoke 通过。
- 默认测试使用假模型或纯数据库数据。另行显式执行的真实端到端测试证明质检通过前不能生图、整批打回后必须强制复检；测试没有发布内容。

复跑数据库测试：将 `COPY_QUALITY_TEST_DATABASE_URL` 指向**本机专用测试 PostgreSQL** 的维护数据库，执行 `node --test server/tests/copy-quality-flow.test.mjs`。测试创建随机 `qc_test_*` 数据库并在结束时删除该测试库，不使用现有业务库。

## 主要文件

- 服务端：`server/src/copy-quality-control.mjs`、`copy-quality-flow.mjs`、`stratified-copy-sampling.mjs`、`workflow-quality-settings.mjs`、`postgres-repository.mjs`、`task-auto-assignment-runner.mjs`、`http-server.mjs`。
- 数据库：`server/migrations/0051_copy_quality_flow.sql`、`server/migrations/0053_account_review_assignment.sql`。
- 页面：`app/copy-flow/page.tsx`、用户权限编辑页、质检页、设置页、工作台与任务详情中的管理员质检操作。
- 路由保护：`src/control-plane/proxy-access.mjs`、`src/admin/proxy-policy.mjs`、侧栏和登录返回路径。
- 测试：`server/tests/copy-quality-flow.test.mjs` 及现有冻结、复检、权限、导航和页面契约测试。
