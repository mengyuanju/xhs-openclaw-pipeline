# 个人统计与我的作业

入口分为 `/workbench/personal-statistics`（个人数据统计）与 `/workbench/personal`（我的作业）。登录和旧任务链接仍进入我的作业。交付记录在弹窗中按需加载，支持状态筛选及分页。

## 统计口径

- 当前统计默认“我负责的”，可切换“我创建的”和“与我相关”。与历史日期范围独立。
- “我需处理”是本人负责且需要人工操作的作业集合，按作业 ID 去重；纯机器运行、排队和等待质检不纳入。
- 待返修来源为文案质检、图片质检或最终审核退回，分为仅文案、仅图片、两者返修；三类互斥。普通修改、机器失败与生图重试耗尽不会自动计为质检返修。
- 返修进度分为待修改、后台处理中、待确认结果。提交审核后进入复检，再次退回后重新进入待返修。
- 等待时间从当前阶段进入时间计算；状态或负责人变化才重置。心跳、草稿和同阶段版本修改不重置。规划或图片结果待确认时，从结果就绪时间计算。
- 历史完成按 `copy_approval_events`、`image_approval_events` 中实际操作账号归属；改派不转移历史贡献。文案和图片分别去重，完成作业合并去重；返修次数按阶段提交事件计数。
- 图片退回记录在旧抽检项变成 `SUPERSEDED` 后仍保留。首轮通过率只使用首轮随机抽中的实际审核结论，排除未抽中、免检、待审核及强制复检；无样本显示“—”。
- “可交付”只计算当前版本 READY 且尚未打包的作业。交付的计数单位为批次，同时展示期内去重作业数。“待确认交付”只计算已成功下载且未确认的本人可见批次。

## 接口与同步

`GET /v1/personal-workspace/statistics` 和 `GET /v1/personal-workspace/tasks` 使用已认证账号，不接受查询参数指定其他统计账号。二者共用 `src/personal-workspace.mjs` 分类逻辑，服务端读取同一数据库快照。

作业查询支持 `mode=CURRENT|COMPLETED|RETURNS|REWORK|QUALITY`，以及 `personalScope`、`category`、`query`、`page`、`pageSize`、`sort`、`priorityMode`、`reworkType`、`reworkProgress`、`reworkSource`、`longWaiting`、`repeated`。历史使用 `period/from/to/stage`；所有日期按北京时间、首日含末日含查询，数据库终点为次日零时。统计卡片携带相同筛选条件跳转。

当前列表不读取历史报表或交付批次，只补齐当前页有详情权限的作业。失去当前详情权限的历史作业只保留历史展示，不提供操作入口或当前返修内容。历史与交付查询失败时，统计页分别提示不可用，当前待办仍能显示；整体刷新失败保留并标明旧数据。单次事实/事件读取上限为 50,000，超过上限明确报错，避免静默截断计数。

审核和其他写操作、后台任务完成后发送不含业务数据的刷新信号，同页及其他标签页会重新查询；另有可见页面定时刷新。规划详情可从中心恢复最新任务，关闭窗口和重新进入后仍可查看结果。

## 升级与验证

先应用 `0071_personal_workspace.sql`，再同步升级中心与 Web。旧作业的等待起点由最后可得队列时间初始化；更早已被覆盖的等待时间无法恢复。缺少账号身份/时间或已被删除的历史事件不补造。

自动化验证不调用模型：

- `npm test`、`npm --prefix server test`、`npm run typecheck`
- `RUN_PERSONAL_WORKSPACE_POSTGRES=1 node --test server/tests/personal-workspace-postgres.test.mjs`：临时 PostgreSQL 18，验证分类、分页、改派、后台结果及图片返修历史。
- `RUN_PERSONAL_WORKSPACE_BROWSER=1 node --test tests/personal-workspace-browser.test.mjs`：真实组件和假接口，验证跳转、筛选恢复、只读历史、刷新、交付弹窗及移动端。

PowerShell 中可通过 `$env:RUN_PERSONAL_WORKSPACE_BROWSER='1'` 设置测试开关。测试不会修改现有数据库或发布环境。
