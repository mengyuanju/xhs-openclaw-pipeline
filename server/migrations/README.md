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
