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

## `0021` / `0022` 自动分配升级

`0021_task_assignment_integrity.sql` 会修复历史任务的负责人元数据、增加负责人外键和一致性约束；`0022_auto_assignment_cursor.sql` 会增加独立的公平轮转游标。`0021` 需要扫描并短暂锁定任务表，已有任务较多时应安排维护窗口。

生产升级顺序：

1. 暂停 Web 写入并让中心服务、文案执行机和生图执行机停止领取新任务。
2. 备份 PostgreSQL 和 `CONTROL_PLANE_STORAGE_ROOT`。先运行 `npm run db:upgrade` 预览，再在 `server` 目录运行 `npm run db:upgrade -- --apply`。
3. 先启动同一发布包中的新版中心服务，确认 `/health` 的 `taskAssignmentVersion=2`、`autoAssignmentPoolVersion=2`；随后立即启动新版 Web，再恢复写入，最后启动文案执行机和生图执行机。新版 Web 会在相关写操作前校验这两个 V2 capability，版本不兼容或无法确认版本时拒绝写入；V2 的手工分配和人员池写入还会同时校验账号名与不可复用的数字账号 ID，旧 Web 缺少该 ID 时会被新版中心明确拒绝，不能在两版混用期间恢复写入。
4. 在管理员页面只把确实需要自动接单的普通用户加入人员池，设置各自在手任务上限，最后开启总开关。

不要让旧中心与新中心同时写同一个数据库。数据库记录了迁移校验和，缺少 `0021`/`0022` 的旧发布包会拒绝连接升级后的数据库。需要回切时，应保留迁移文件并回切到兼容这些字段的代码；若必须回到不兼容版本，只能在停机后恢复升级前的数据库和文件备份。不要修改已经执行过的迁移文件。
