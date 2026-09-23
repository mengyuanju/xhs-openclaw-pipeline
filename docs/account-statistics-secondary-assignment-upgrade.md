# 账号质量统计与二次分配：实施及升级说明

本次代码已实现设计方案的核心流程。此文档记录升级步骤，编写文档和运行隔离测试不代表已经迁移或部署生产环境。

## 已实现行为

- 每个“任务 × 阶段 × 实际提交账号”只计一个质量样本。已判定总量 = 废弃 + 一次通过 + 打回；有样本时三项显示比例合计 100%，无样本显示“—”。统计按首次有效独立质检时间、上海时区归日。
- 改派不会迁走原账号样本，也不会重复增加原账号总量；新账号在自己的首次有效质检时形成样本。同账号再次接回同一任务、同一阶段仍是一个样本。
- 先打回、后通过仍计打回；管理员最终废弃将对应原账号、原阶段、原质检日期的分类改为废弃。撤销误废弃及再次废弃均保留事件，已打开的报表快照不变，刷新后更新。
- 文案强制复检只允许通过或提交管理员；文案旧打回、直接废弃及快捷直放接口受后端约束。图片强制复检可继续打回返修，再次提交后进入新一轮强制复检；图片复检也保留直接废弃能力，不进入二次分配。
- 提交管理员后进入 `PENDING_SECOND_ASSIGNMENT`（待二次分配），清空当前负责人，脱离旧质检批次的任务门禁。未处理的其他成员不会自动通过。
- 有可信初始机器稿时，还原初始正文、标签和图片规划；删除旧草稿、人工提交记录、编辑请求及事件、派生执行内容、旧图片结果和任务专属图片文件。保留无正文的统计事实、评分信息、分配链及质检证据；因外键关系保留的旧版本空壳不能恢复正文，资产读取接口不再提供已清理文件。
- 缺少可信初稿时不清空原内容，处置单显示受阻；管理员可重新生成机器初稿。共享资产引用或文件清理失败时同样禁止分配，处理原因后可以重试。
- 管理员通过 `/reassignment` 查看初稿和分配记录，重新分配、最终废弃或撤销废弃。接手人从文案初始审核开始，文案和图片均必须完整质检。

“废弃”调整以本次处置单的责任账号和阶段为范围。后一个人的结果不会自动覆盖前一个人的样本，也不会把图片责任自动算到文案阶段。普通首次文案质检保留现有打回后废弃处置路径。

## 迁移文件与存量状态

| 迁移 | 作用 |
| --- | --- |
| `0086_secondary_assignment` | 扩充状态和动作；新增不可变初始基线、分配记录、管理员处置单及清理清单；增加陈旧状态写入保护 |
| `0087_account_quality_records` | 新增独立质量事件与统计主体；根据现有质检、废弃、恢复证据回填 |

两项迁移均使用现有迁移登记与事务机制，可重复启动而不会重复回填。不得修改已经在目标库执行过的迁移校验值。

升级本身不把任何任务改成“待二次分配”，不删除历史内容、不改变负责人、当前版本或原有任务状态。已有待复检任务保留状态；文案复检使用通过或提交管理员，图片复检可反复打回直至通过。待返工任务继续完成原流程，已完成和已废弃任务保持原状态。已有图片二次分配记录仍可供管理员查看和处理，但不再从图片复检创建新记录。

初始基线仅从有明确 `GENERATION` 来源、无父版本、未修改文案且没有 `manualReview` 标记的机器版本回填；无法证明是机器初稿的记录保持缺失。不会用最新人工稿冒充原始数据。存量分配只建立当前责任的迁移基线，旧 `task_assignment_events` 仍保留，不伪造以前缺失的分配区间或身份。

质量回填使用已保存的有效质检事实；自审、模拟、无实际质检人、身份不明、未抽中和未判定记录不会凭当前状态补算。历史复检如错误继承了前一个提交人的身份，以对应文案审批记录中的实际提交账号修正归属。废弃与恢复按实际事件时间回放，报表日期仍为首次质检日。

## 上线顺序

1. 在生产副本上预演升级，检查基线缺失数量、统计变化及状态快照。新功能涉及实际内容清理，上线前备份数据库和 `CONTROL_PLANE_STORAGE_ROOT` 图片目录；数据库导出不包含图片文件。
2. 暂停旧版服务写入、执行机领取和派单，等待在途操作结束。记录任务状态、负责人、当前文案与图片版本的升级前快照。
3. 从此次代码包预览待执行迁移，确认目标环境及迁移列表。以下第一条命令只预览；第二条会写库，只在正式批准的上线窗口执行：

   ```powershell
   npm --prefix server run db:upgrade -- --environment=production
   npm --prefix server run db:upgrade -- --environment=production --apply
   ```

   本次为原库增量升级，不使用 `db:init`，也不传入其他来源库的 `--from` 参数。若目标库早于 0085，需同时审查所有待执行历史迁移。

4. 检查迁移登记和升级后状态快照完全一致，检查下方数据核对 SQL。新版本控制面初始化也会执行迁移，因此应先完成受控升级，再启动新版服务，避免首次启动时意外升级。
5. 同步发布控制面和前端，再恢复执行机及派单。健康信息应含 `secondaryAssignmentVersion: 1`、`accountQualityStatisticsVersion: 1`；账号报表 `metricVersion` 为 5。旧服务不支持新处置接口，前端能力检查会阻止写入。
6. 在测试任务上走通“复检提交管理员 → 初稿还原/清理完成 → 重新分配 → 新账号质检”。核对原账号总量不变，接手账号在实际质检前没有新增样本。

建议使用部署环境已有备份流程；项目数据库导出命令为 `npm --prefix server run db:export -- --environment=production`。备份应置于受控目录，不能把数据库导出或凭据加入代码仓库。

## 核对 SQL

升级前后均导出以下结果并逐行比较，应完全相同；比较期间须暂停业务写入：

```sql
SELECT id, state, assigned_to_user_id, current_copy_revision_id,
       current_image_run_id, current_execution_id, cancelled_from_state
FROM tasks ORDER BY id;
```

升级后检查登记、基线及处置队列：

```sql
SELECT id, applied_at FROM control_plane_migrations WHERE id >= '0086' ORDER BY id;
SELECT state, baseline_status, count(*)
FROM secondary_assignment_migration_report
GROUP BY state, baseline_status ORDER BY state, baseline_status;
SELECT id, task_id, status, reset_status, cleanup_status, reset_error
FROM task_reassignment_cases WHERE status = 'PENDING' ORDER BY id;
```

按账号、阶段、上海自然日对账。每行应满足 `judged = discarded + first_passed + returned`，`reassigned` 是总量内的标记，不额外加到分母：

```sql
SELECT operator_account_id, stage,
       (first_qa_at AT TIME ZONE 'Asia/Shanghai')::date AS qa_day,
       count(*) AS judged,
       count(*) FILTER (WHERE current_bucket = 'DISCARDED') AS discarded,
       count(*) FILTER (WHERE current_bucket = 'FIRST_PASS') AS first_passed,
       count(*) FILTER (WHERE current_bucket = 'RETURNED') AS returned,
       count(*) FILTER (WHERE reassigned) AS reassigned
FROM account_quality_records
GROUP BY operator_account_id, stage, qa_day ORDER BY qa_day, operator_account_id, stage;
```

基线缺失不等于迁移失败：旧任务仍按原状态工作。只有实际进入管理员处置时才阻止还原和分配，并显示原因。重新生成初稿沿用现有执行机，不增加生产调度；失败后可在管理员处置页重试。文件清理通过重试按钮恢复，不增加后台定时任务。

## 验证记录与回退边界

已通过根项目和服务端常规测试、TypeScript 检查及 Next.js 构建。新增隔离 PostgreSQL 18 测试从 0085 升级，覆盖状态不变、重复初始化、跨日统计、身份和权限、幂等、批次隔离、内容与文件清理、缺失基线、重新生成、并发分配，以及废弃 → 恢复 → 再废弃。模型结果使用测试数据，未调用真实模型。

复跑关键数据库测试：

```powershell
$env:RUN_SECONDARY_ASSIGNMENT_POSTGRES='1'
node --test server/tests/secondary-assignment-postgres.test.mjs
```

迁移失败时数据库事务回滚；已成功上线后优先前向修复，不删除新表或强行改旧状态。一旦实际执行了标注清理，切回旧代码不会恢复已清除内容，撤销废弃也只恢复管理员处置状态，不恢复旧改稿。若必须整库回退，需要配套数据库和存储备份，并单独处理备份时间之后的业务变更。
