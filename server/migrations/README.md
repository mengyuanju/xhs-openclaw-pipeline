# 数据库增量迁移

`src/schema.sql` 是不可变的 `0001_baseline`，兼容首次建库和旧版无迁移记录的数据库。
发布此机制后不要再改这个基线文件；后续变更新增 `0002_description.sql`、`0003_description.sql`。

SQL 文件不能自行 `BEGIN` / `COMMIT`，迁移器会与数据合并一起管理事务。
已执行迁移的校验和会保存到 `public.control_plane_migrations`，重复运行不会重复执行。
修改已执行迁移或使用落后于目标库的升级包会被拒绝。

示例（实际需要新增字段时才创建文件）：

```sql
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS remark text;
```

已有业务数据只能通过明确的迁移 SQL 转换，不要在迁移中清表或覆盖用户提示词。
导出包会携带这些迁移；手工改库但未提供迁移 SQL 的结构差异会在合并前报错回滚。

## `0021` / `0022` 自动分配与 V3 工作流升级

`0021_task_assignment_integrity.sql` 会修复历史任务的负责人元数据、增加负责人外键和一致性约束；`0022_auto_assignment_cursor.sql` 会增加独立的公平轮转游标。`0021` 需要扫描并短暂锁定任务表，已有任务较多时应安排维护窗口。

V3 将负责人分配推迟到文案待审核阶段。这次工作流变更复用已有字段，不新增数据库迁移，但任务创建、负责人写入和自动派单池写入的语义已经改变，因此 Web 必须通过 V3 capability 阻止请求落到 V2 中心。

生产升级顺序：

1. 暂停 Web 写入并让中心服务、文案执行机和生图执行机停止领取新任务。
2. 备份 PostgreSQL 和 `CONTROL_PLANE_STORAGE_ROOT`。先运行 `npm run db:upgrade` 预览，再在 `server` 目录运行 `npm run db:upgrade -- --apply`。
3. 以停机切换或原子切流方式启动同一发布包中的新版中心服务和新版 Web，确认 `/health` 的 `taskAssignmentVersion=3`、`autoAssignmentPoolVersion=3`。不要让 V2/V3 中心处于同一个负载均衡池中滚动混跑：capability 检查和写请求是两个请求，混合后端不能保证命中同一版本。新版 Web 会在任务创建、负责人写入和自动派单池写入前校验对应的 V3 capability，V2 或更旧版本、版本缺失及无法确认版本时均拒绝写入；V3 的手工分配和人员池写入仍会同时校验账号名与不可复用的数字账号 ID。
4. 在文案执行机仍停止时，先清点历史未分配文案积压：`SELECT id, query, created_at FROM tasks WHERE state = 'COPY_QUEUED' AND assigned_to_user_id IS NULL ORDER BY id;`。V3 会把这些任务视为可执行的机器队列；通过新版管理员界面废弃不应产生模型调用的旧任务，明确确认其余任务可以执行后再继续。
5. 在管理员页面只把确实需要自动接单的普通用户加入人员池，设置各自的待审核任务额度，最后开启总开关。
6. 恢复 Web 写入，再启动文案执行机和生图执行机。

不要让旧中心与新中心同时写同一个数据库，也不要让新旧版本同时承接同一入口流量。数据库记录了迁移校验和，缺少 `0021`/`0022` 的旧发布包会拒绝连接升级后的数据库。需要回切时，应保留迁移文件并回切到兼容这些字段的代码；若必须回到不兼容版本，只能在停机后恢复升级前的数据库和文件备份。不要修改已经执行过的迁移文件。

## `0023` 执行机信息安全移除

`0023_executor_node_retirement.sql` 为执行机增加退役时间。管理员删除离线执行机时只会将它从当前管理清单中移除，任务、执行和审核历史继续保留；同一节点 ID 再次启动并完成注册后会自动恢复显示。

新版 Web 会在删除前校验中心的 `executorManagementVersion=1`，因此应先应用迁移并升级中心服务，再更新 Web。在线或仍有关联运行任务的执行机不能删除；先停止执行机并处理相关任务，等待其显示为离线后再操作。

## `0024`–`0030` Query、抽检与交付闭环

`0024`–`0028` 增加 Query 词包、文案抽检、冻结交付版本和账号身份幂等约束。`0029_final_delivery_compatibility_repair.sql` 用于收敛早期本地部署曾执行过的交付迁移草稿：它安全补齐文案父版本，按最近机器稿重新核对历史修改标记，并重新执行 READY 交付来源完整性检查；不会修改任务状态、删除业务数据或自动满足返工要求。

`0030_delivery_asset_runtime_integrity.sql` 将交付资产编号限制与 JavaScript 安全整数上限统一，撤回运行时无法无损表示的 READY 记录，并保留异常记录的首次发现时间。

迁移器只允许两个明确、单向且由 `0029` 修复的历史校验值：`0026_final_delivery` 的 `99a236324d33b10f1b66c0822795b83954fa2a8edf2c322ae2017c6316df8437`，以及 `0027_delivery_archive_integrity` 的 `bfeba2869813a17adf1119e688c965faa920a1206874ae95671b289ca296a2e3`。数据库中的原校验值会保留作为真实审计记录；未知校验值、反向降级、缺少或被修改的 `0029` 仍会拒绝启动，不能通过手工更新 `control_plane_migrations` 绕过。

`0029`、`0030` 会扫描文案版本和待交付记录。升级前应暂停写入并完成 PostgreSQL 与文件存储备份，先运行 `npm run db:upgrade` 预览，再运行 `npm run db:upgrade -- --apply`。升级完成后再次预览应显示没有待执行迁移。
