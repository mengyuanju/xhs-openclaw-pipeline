# 质检贡献统计

个人数据统计与管理员人员表现现在同时支持制作和质检贡献。个人页优先显示历史贡献，管理员可切换全部贡献、制作和质检视图；只做质检、只获派质检待办或只执行批量处置的账号均能进入对应统计。管理员实际操作按同样规则计入。

## 口径

- 制作贡献归实际提交人；质检操作归实际质检人。内容首轮通过率仍归提交人，不是质检人的准确率。
- 参与处理作业取有效制作提交与逐项质检的任务并集；质检作业按任务去重，结论次数按阶段与抽检项去重。复检有新的抽检项，计入结论次数并单列子集。
- 文案整批退回只在触发项尚无结论时增加一次逐项退回；已经单条退回的触发项保留原操作人。图片整批退回不生成逐项结论。
- 批量操作次数、快捷直放、质检废弃单列。新批量事件保存必要成员 ID，可计算已知影响任务并集；旧记录只存 affectedCount 时显示影响项次，并提示缺少完整范围。
- 自检、明确模拟、未抽中、缺失操作账号的记录不计有效逐项质检；普通复检不套用内容首轮通过率的排除条件。
- 当前质检待办按 assigned_review_account_id 读取，独立于历史日期和制作范围。仅当前有效版本且 PENDING 的抽检项进入指派列表；暂停及账号权限阻塞的项单列；图片修改期间仍可退回，保留为待办并提示暂不能通过。
- 日期使用北京时间，质检按结论日统计。无质量样本显示“—”；个人质检查询失败显示不可用，保留可读取的制作统计。

## 数据与接口

`0075_quality_review_activity.sql` 新增追加式 `quality_review_activity_events`，来源为文案/图片质检事件。事实来源键固定，重放及回填不重复计数；与业务事务同提交、同回滚。事实不随任务或账号级联删除，改派不会转移历史。

触发器安装后回填现存事件，避免并发写入漏过回填窗口。可信的既有 QUALITY 事实可补回源事件已删除的逐项结论，沿用同一个抽检项键去重。缺少身份、时间或原始范围的数据不推造；更早完全丢失的事件不可恢复。

`src/quality-review-statistics.mjs` 是两端共用的质检汇总模块；`server/src/quality-review-statistics.mjs` 在只读快照内加载历史事实和当前质检指派。每次限制 50,000 条质检事实，超限明确失败。查询不触发自动结批或其他状态变化。

- `GET /v1/personal-workspace/statistics` 增加 qa、contribution、qaTrend；质检与历史/交付失败分别提示。
- `GET /v1/personal-workspace/qa-activities` 提供本人操作明细，支持日期、阶段、结论、指标、分页。账号由认证绑定，拒绝指定其他账号。使用字段白名单返回匿名编号和本人操作结论，不返回任务编号、Query、内容提交人或版本信息。
- 管理员原 operator-performance 接口增加 activity=ALL/PRODUCTION/QA，以及 contributed、qa、qaRecheck、qaBatch、qaSpecial、qaPending、qaBlocked 等指标与排序。日期、账号、阶段、批次和姓名筛选覆盖对应事实。
- 管理员明细、分页与 CSV 复用同一成功快照。口径版本升级为 2；旧中心会提示升级。普通用户和质检员仍不能访问管理员接口。

质检提交沿用工作区更新通知触发刷新。个人待办卡片与阻塞卡片各自下钻到对应集合，管理员质检视图隐藏制作指标，避免把“无制作贡献”误读为“没有工作”。

## 升级

先在业务备份上评估迁移回填与索引耗时，再按现有中心数据库升级流程应用 `0075_quality_review_activity.sql`，同步更新中心和 Web。此修改仅在临时 PostgreSQL 中应用迁移，未修改运行中的业务数据库、部署或增加生产调度。

## 验证

- `npm test`、`npm --prefix server test`、`npm run typecheck`、`npm run build`。
- `RUN_OPERATOR_PERFORMANCE_POSTGRES=1`：运行 operator-performance-postgres、quality-review-statistics-postgres，验证只做 5 次文案与 3 次图片质检、两端一致、回填幂等、复检、批量操作归属、模拟排除、事务回滚、删除后的历史保留、快照和盲审字段隔离。
- `RUN_PERSONAL_WORKSPACE_POSTGRES=1`：运行 personal-workspace-postgres，验证原个人统计兼容。
- `RUN_POSTGRES_E2E=1`：运行 copy-quality-flow、image-quality-flow-postgres，回归真实业务事务中的质检、整批退回、返修和废弃。
- `RUN_OPERATOR_PERFORMANCE_BROWSER=1` 与 `RUN_PERSONAL_WORKSPACE_BROWSER=1`：验证真实组件的纯质检人员、视图筛选、5/3 次数、明细下钻、错误保留及手机宽度。
- 纯函数与 HTTP 用例覆盖跨日、去重、空时间待办、只待办人员、身份隔离和账号凭据撤销。

所有测试使用假数据或隔离临时库，不调用模型。页面截图输出到 `.codex_artifacts/operator-performance/`；个人截图可通过 `PERSONAL_WORKSPACE_SCREENSHOTS` 指定目录。
