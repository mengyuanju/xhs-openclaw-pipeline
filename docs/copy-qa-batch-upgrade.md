# 文案质检批次升级

本次升级依次执行 `0088_copy_qa_batch_redesign.sql`、补偿迁移 `0089_release_unreviewed_legacy_copy_qa_batches.sql`、批次命名迁移 `0090_copy_qa_batch_display_names.sql` 和可信机器初稿修复迁移 `0091_copy_qa_initial_baseline_null_review.sql`。已执行的版本不会重复运行；中心服务启动时检查迁移版本，有待执行迁移时会提示先使用统一升级命令。

## 执行

先停止中心服务和执行机，并备份目标数据库。项目根目录执行：

```bash
npm run server:db:upgrade
npm run server:db:upgrade -- --apply
```

生产环境显式指定环境：

```bash
npm run server:db:upgrade -- --environment=production
npm run server:db:upgrade -- --environment=production --apply
```

预览只显示目标和待执行迁移。`--apply` 在一个数据库事务中执行尚未应用的版本化 SQL，并将文件校验和写入 `control_plane_migrations`。以后新增数据升级脚本，继续放在 `server/migrations/` 并使用相同命令；不要修改已应用脚本。

0090 给已有批次回填“文案质检-日期-当日序号”名称；此后创建批次自动递增当天序号。内部 UUID 只用于接口定位。

0091 将历史生成稿中 `manualReview: null` 正确识别为未人工修改的机器初稿，补录满足机器执行记录和首稿条件的 `task_initial_baselines`，并清除因此产生的“缺少可信机器初稿”阻塞状态。升级后刷新二次分配页面，对这些任务点击“重试还原 / 清理”；无需点击“重新生成初始数据”。实际还原仍由原有操作执行，不在迁移中清理任务内容。

## 迁移口径

- 旧批次中当前文案版本已通过的任务直接放行到待生图。
- 0088 曾把旧批次中待检任务逐条锁入系统迁移批次；0089 仅释放尚无任何新质检决定的系统迁移批次成员，使这些任务回到个人/混合待入批池。已产生新质检决定的批次保留原记录。
- 旧驳回记录保留，并按任务的重新分配责任周期回填。再次被驳回时，只计算当前周期内的既有驳回。
- 旧批次没有剩余抽检项时，未抽中成员直接放行。服务重启后会按用户的自动成批配置处理重新释放的待入批任务；低于阈值的任务会显示在个人和混合入口，供手动选择。

升级后可查询 `copy_qa_v2_migration_report` 查看当前仍保留的系统批次、成员和历史驳回数量。0089 释放的批次不再计入前两项。文案工作入口使用个人或混合模式创建新批次，旧质检操作接口返回 `410 LEGACY_COPY_QA_RETIRED`。
