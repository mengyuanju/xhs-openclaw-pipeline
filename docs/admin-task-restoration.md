# 管理员恢复废弃任务

管理员进入“作业中心 → 废弃池”，点击“恢复任务”并确认。全部作业的已废弃条目也提供同一入口。普通用户、质检员不能恢复；Web 代理与中心服务均校验权限，数据库事务内再次核对管理员账号状态。

恢复保留历史文案、图片、评分、质检结论和废弃原因，另记恢复人、原阶段及版本。已有文案恢复为新的待审核稿，无文案则进入文案执行队列；文案审核后须强制复检。已有有效文案放行记录的图片任务根据当前版本回到待生图、图片初审或返修；已提交初审的图片须修改形成新版本再初审，恢复后的图片须强制复检。不会直接恢复到交付池。

`POST /v1/tasks/:taskId/restore` 必须携带列表返回的 `expectedUpdatedAt`。事务锁与时间戳防止重复点击以及旧请求恢复后来再次废弃的任务。旧执行、恢复快照和交付放行标记不重新启用；任务仍保留原负责人和优先级设置。

部署时先应用 `0077_task_restore.sql` 并更新中心服务，再更新 Web。Web 要求中心 `/health` 声明 `taskRestoreVersion: 1`，版本不匹配时停止恢复操作。

验证：`node --test server/tests/task-restoration.test.mjs`；真实 PostgreSQL 流程测试在 `server/tests/image-quality-flow-postgres.test.mjs` 中；页面测试可设置 `RUN_TASK_RESTORE_BROWSER=1` 后运行 `node --test tests/task-restoration-browser.test.mjs`。全部测试使用测试数据，不调用模型。
