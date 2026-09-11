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

V3 将负责人分配推迟到文案待审核阶段。任务创建、负责人写入和自动派单池写入的语义已经改变，因此 Web 必须通过 V3 capability 阻止请求落到 V2 中心。普通任务复用已有字段；旧版 Query 词包任务的创建时预分配由 `0033_query_package_preassignment_repair.sql` 单独修复。

生产升级顺序：

1. 暂停 Web 写入并让中心服务、文案执行机和生图执行机停止领取新任务。
2. 备份 PostgreSQL 和 `CONTROL_PLANE_STORAGE_ROOT`。先运行 `npm run db:upgrade` 预览，再在 `server` 目录运行 `npm run db:upgrade -- --apply`。
3. 以停机切换或原子切流方式启动同一发布包中的新版中心服务和新版 Web，确认 `/health` 的 `taskAssignmentVersion=3`、`autoAssignmentPoolVersion=3`、`queryPackageVersion=3`。不要让新旧中心处于同一个负载均衡池中滚动混跑：capability 检查和写请求是两个请求，混合后端不能保证命中同一版本。新版 Web 会在任务创建、负责人写入、自动派单池写入和 Query 词包写操作前校验对应 capability；版本过旧、版本缺失或无法确认时均拒绝写入。V3 的任务分配、人员池写入和词包筛选人分配都会同时校验账号名与不可复用的数字账号 ID。
4. 在文案执行机仍停止时，先清点历史未分配文案积压：`SELECT id, query, created_at FROM tasks WHERE state = 'COPY_QUEUED' AND assigned_to_user_id IS NULL ORDER BY id;`。V3 会把这些任务视为可执行的机器队列；通过新版管理员界面废弃不应产生模型调用的旧任务，明确确认其余任务可以执行后再继续。
5. 在管理员页面只把确实需要自动接单的普通用户加入人员池，设置各自的待审核任务额度，最后开启总开关。
6. 恢复 Web 写入，再启动文案执行机和生图执行机。

不要让旧中心与新中心同时写同一个数据库，也不要让新旧版本同时承接同一入口流量。数据库记录了迁移校验和，缺少 `0021`/`0022` 的旧发布包会拒绝连接升级后的数据库。需要回切时，应保留迁移文件并回切到兼容这些字段的代码；若必须回到不兼容版本，只能在停机后恢复升级前的数据库和文件备份。不要修改已经执行过的迁移文件。

## `0023` 执行机信息安全移除

`0023_executor_node_retirement.sql` 为执行机增加退役时间。管理员删除离线执行机时只会将它从当前管理清单中移除，任务、执行和审核历史继续保留；同一节点 ID 再次启动并完成注册后会自动恢复显示。

新版 Web 会在删除前校验中心的 `executorManagementVersion=1`，因此应先应用迁移并升级中心服务，再更新 Web。在线或仍有关联运行任务的执行机不能删除；先停止执行机并处理相关任务，等待其显示为离线后再操作。

## `0024`–`0033` Query、抽检与交付闭环

`0024`–`0028` 增加 Query 词包、文案抽检、冻结交付版本和账号身份幂等约束。`0029_final_delivery_compatibility_repair.sql` 用于收敛早期本地部署曾执行过的交付迁移草稿：它安全补齐文案父版本，按最近机器稿重新核对历史修改标记，并重新执行 READY 交付来源完整性检查；不会修改任务状态、删除业务数据或自动满足返工要求。

`0030_delivery_asset_runtime_integrity.sql` 将交付资产编号限制与 JavaScript 安全整数上限统一，撤回运行时无法无损表示的 READY 记录，并保留异常记录的首次发现时间。

`0033_query_package_preassignment_repair.sql` 只清理能被完整证明为旧版 Query 词包创建时预分配的任务：词包、明细、生产批次和批次明细的来源链必须完整一致，分配来源必须为 `MANUAL`，分配时间必须等于任务创建时间，且不存在任何负责人审计事件。迁移仅处理尚在文案生成阶段的任务，或 `state` 与 `current_stage` 均为 `COPY_REVIEW_PENDING` 的任务；跳过文案审核、已进入生图/交付后半程、被后续改派、来源已删除或任何无法证明的记录都保持不变。

每条被清理的任务会在同一个迁移事务中写入一条 `task_assignment_events` 记录，固定操作人为 `migration-0033-query-preassignment`，并保留原负责人。升级前应暂停 Web 写入与派单进程，记录候选数量并备份数据库；升级后核对这一操作人的新增审计数量与清理数量相等，并确认上述排除项的负责人信息未变。`COPY_REVIEW_PENDING` 候选任务会改为“文案生成完成，等待分配负责人后审核”，升级后可由 V3 自动派单池接管。

迁移器只允许两个明确、单向且由 `0029` 修复的历史校验值：`0026_final_delivery` 的 `99a236324d33b10f1b66c0822795b83954fa2a8edf2c322ae2017c6316df8437`，以及 `0027_delivery_archive_integrity` 的 `bfeba2869813a17adf1119e688c965faa920a1206874ae95671b289ca296a2e3`。数据库中的原校验值会保留作为真实审计记录；未知校验值、反向降级、缺少或被修改的 `0029` 仍会拒绝启动，不能通过手工更新 `control_plane_migrations` 绕过。

`0029`、`0030` 会扫描文案版本和待交付记录，`0033` 会扫描并锁定符合安全谓词的任务记录。升级前应暂停写入并完成 PostgreSQL 与文件存储备份，先运行 `npm run db:upgrade` 预览，再运行 `npm run db:upgrade -- --apply`。升级完成后再次预览应显示没有待执行迁移。

## `0034` 小红书搜索结果条数

`0034_xhs_query_search_result_limit.sql` 新增独立的 `xhs_query_search` 全局设置，默认每个 Query 保留 3 条按点赞量排序的结果，管理员可在 1–10 条之间调整。搜索任务在执行机领取时把当时的设置冻结到 `xhs_query_search_jobs.result_limit`；管理员之后修改配置不会改变已经运行中的搜索，只影响后续领取或重新领取的任务。

升级时先停止小红书搜索执行机，再应用迁移并同步更新中心服务和搜索执行机。新版中心通过 `/health` 报告 `capabilities.xiaohongshuQuerySearchVersion=3`，并拒绝旧搜索协议领取任务，避免旧执行机继续固定保存 3 条而绕过管理员配置。

## `0035` / `0036` 交付预览关联

`0035_delivery_preview_links.sql` 在冻结交付条目上增加预览服务的记录 ID、公开 noteId、内容哈希、状态和上传人审计字段；`0036_delivery_preview_url_derivation.sql` 移除早期草稿中持久化的公开链接，页面按当前预览服务地址和 noteId 动态生成链接，切换域名时无需批量改历史数据。两套系统不共享主键；中心以不可变 `delivery_entries.id` 生成 `sourceRef`，预览服务据此提供幂等创建，中心再保存远端标识的关联。

生产升级时，先部署并迁移支持 `sourceRef` 的预览服务，再暂停中心 Web 写入，备份 PostgreSQL，依次应用 `0035`、`0036`（正常执行 `npm run db:upgrade -- --apply` 即可），最后同步切换新版中心服务和 Web。确认 `/health` 返回 `deliveryPreviewVersion=4` 后再开放管理员上传。版本 4 要求管理员明确勾选词包，并按稳定的 `source_query_package_id` 限定上传范围；早期没有词包关联的内容作为独立范围显式勾选，不会伪造词包归属。单任务测试上传还会把任务 ID 与来源范围同时提交并在中心校验。预览 API 密钥只保存在中心服务 Secret 中，不写数据库、不发送到浏览器。

## `0037` 小红书搜索账号状态

`0037_xhs_search_account_status.sql` 为每个小红书搜索节点增加主机类型、非敏感账号标签、最新登录状态和最近搜索任务引用。中心服务器本机与普通执行机使用同一状态协议；搜索进程心跳与账号登录状态分开判断，机器离线不会被误写成账号掉线。

升级时先停止小红书搜索进程，备份 PostgreSQL 并应用迁移，再同步更新中心服务、Web 和所有搜索主机。中心通过 `/health` 报告 `xiaohongshuAccountStatusVersion=1`。浏览器登录目录和 Cookie 仍只保存在各自主机的仓库外专用目录，不进入中心数据库。

## `0038` 小红书登录状态验证时间

`0038_xhs_search_auth_checked_at.sql` 增加最近一次明确验证小红书登录状态的时间。该时间只在搜索成功、检测到需要登录或验证码时更新；普通网络或搜索失败不会被误判为账号状态变化。
