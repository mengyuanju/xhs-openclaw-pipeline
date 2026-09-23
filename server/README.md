# 远端控制服务

该目录是可独立安装和部署的 Koa 服务，负责 PostgreSQL 中的任务、执行记录、审核、提示词、知识库和生产配置，以及服务器本地图片文件。它不运行 OpenClaw，也不保存执行机模型凭据。

## 安装与启动

要求 Node.js 24.19.x 和 PostgreSQL。先创建数据库与账号，再执行：

```powershell
cd server
npm install
npm run init
npm start
```

启动前在当前目录创建 `.env`：

```dotenv
DATABASE_URL=postgresql://xhs_control:替换为数据库密码@127.0.0.1:5432/xhs_control
# 可选：同一份 env 中配置正式库，使用 production 环境时自动替换 DATABASE_URL。
XHS_PRODUCTION_DATABASE_URL=postgresql://xhs_control_prod:替换为正式库密码@127.0.0.1:5432/xhs_control_prod
XHS_PRODUCTION_STORAGE_ROOT=D:\auto-claw\images_storage_prod
CONTROL_PLANE_HOST=0.0.0.0
CONTROL_PLANE_PORT=4310
CONTROL_PLANE_STORAGE_ROOT=server-storage
DEEPSEEK_API_KEY=替换为中心服务使用的DeepSeek密钥
# 可选，默认 deepseek-v4-pro
DEEPSEEK_COPY_ANALYSIS_MODEL=deepseek-v4-pro
# 可选；配置后管理员可从交付池批量创建预览
PREVIEW_BASE_URL=https://你的预览服务域名
PREVIEW_API_KEY=仅含preview:create权限的接口密钥
```

优秀文案的 AI 分析由中心服务直接调用 DeepSeek；结构校验通过后立即创建并发布到中心知识库。密钥只配置在中心机器的 `server/.env`，不要配置到执行机，也不要提交到 Git。

交付池预览同样由中心服务直接调用预览服务，接口密钥不会下发到浏览器。管理员必须明确勾选一个或多个词包；Web 只提交稳定的词包 ID，中心只从这些词包选择尚未上传且仍为 READY 的交付项。早期没有词包关联的 READY 内容会显示为独立的“历史未归属内容”范围，只有单独勾选后才会上传，不会伪造词包归属。一次操作可选择 1 条测试，或批量选择 10、25、50、100、200 条；任务行的“测试上传”会同时提交该任务 ID 与它的稳定来源范围，中心双重校验后只处理这一条。中心会按预览服务每批最多 10 条、60 张图片、60 MB 原图自动串行拆批，不放大单次远端请求。`0035_delivery_preview_links` 会把预览服务返回的 `preview.id`、`publicId`（noteId）和内容哈希关联到冻结的 `delivery_entries` 记录；`0036_delivery_preview_url_derivation` 不再持久化服务域名，公开链接按当前 `PREVIEW_BASE_URL` 和 noteId 动态生成。两套系统保持各自主键，通过这个关联审计和重试。

`npm run init` 可重复执行，首次运行会建表并安装默认生产配置和提示词。

“修改图片”仍保留独立预览、采用和审计状态，但执行工作由普通图片执行机承担。中心把普通生图和改图放入同一个图片领取与容量裁决中，按既有任务优先级和负责人轮转分派；中心机不需要 Codex 登录，也不会运行改图模型。最新中心返回 `imageEditExecutorVersion=12`：版本 12 将单目标产品框改为定位提示，取消完整覆盖前置门槛和产品遮罩，直接把完整画面交给模型并做结果验收；全部产品替换任务均要求版本 12。版本 11 支持框内全部同款产品的视觉定位，版本 9 支持直接局部修改，版本 8 支持 SVG + Sharp 程序标识。自动验收未通过的生成结果会隔离保存，作业员可查看、对比、从原图重试或明确确认后人工采用；版本 3 执行机仍可领取确定性合成与历史恢复。至少一台图片执行机需要启用 `IMAGE_WORKER_ENABLED=true`。

### 开发/生产环境切换

中心服务显式支持 `development` 与 `production` 两个环境，两者都读取同一个未提交的 `.env`。默认环境使用
`DATABASE_URL`；生产环境把 `XHS_PRODUCTION_DATABASE_URL` 作为实际数据库，并可用 `XHS_PRODUCTION_STORAGE_ROOT`
覆盖正式文件目录。系统不会根据 `NODE_ENV` 猜测数据库，避免普通构建命令误连正式库。

```powershell
# 查看两个环境将使用的数据库与文件目录（不会显示密码）
npm run env:status
npm run env:status:production

# 默认环境 / 正式环境
npm start
npm run start:production
```

也可以设置 `XHS_SERVER_ENV=production` 后运行普通命令，或向数据库维护命令传入
`--environment=production`。命令行选项只选择固定环境名，不接受数据库 URL；数据库密码仍只保存在未提交的 `.env` 或进程 Secret 中。

### Windows 后台常驻

中心机可使用 Windows 计划任务运行正式服务，无需保留命令窗口。项目根目录提供的安装脚本会禁止同一任务重复启动，并在异常退出后每分钟重启；运行日志按日期写入 `server/logs/control-plane-YYYY-MM-DD.log`，默认保留 14 天。

普通方式安装后，任务会在当前 Windows 账号登录时自动启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-control-plane-task.ps1
```

若中心服务必须在无人登录时也运行，请以管理员身份打开 PowerShell，并安装为 SYSTEM 开机任务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-control-plane-task.ps1 -RunAsSystem
```

首次切换时不要让手工进程和计划任务同时监听同一端口。可以安装后重启中心机，让计划任务接管；也可以先正常停止手工进程，再运行 `Start-ScheduledTask -TaskName XhsOpenClawControlPlane`。卸载命令如下，日志不会随任务删除：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-control-plane-task.ps1
```

### 仅迁移基础配置到新库

正式库需要继承现有生产设置、提示词、知识库和质量策略，但不需要任何作业数据时，先对空库运行
`npm run init:production`，再使用选择性迁移工具。工具只接受固定环境名，不接受命令行数据库 URL，
默认只预检，并拒绝同库迁移、待升级的 schema、含作业数据的目标库、已启用自动派单的目标库及包含文件路径的知识记录。

```powershell
npm run db:migrate:base-config -- --source-environment=development --target-environment=production
npm run db:migrate:base-config -- --source-environment=development --target-environment=production --apply
```

迁移范围固定为 `global_settings`、提示词模板及版本、知识条目及版本、`workflow_quality_settings`。
账号、派单人员、执行机、Query 词包、任务、执行、审核、素材和交付记录均不会迁移。目标库保留初始化生成的管理员账号，
正式账号及派单人员应在验收后重新建立。

`0005_user_management` 迁移会创建中心用户表和三个固定角色（管理员、审核员、普通用户），并创建初始管理员 `admin / 123456`。升级已有服务时运行 `npm run db:upgrade -- --apply`，然后重启中心服务。默认密码必须在首次登录后的个人信息页修改。

`0006_manual_archive` 会把旧的“待图文审核”和“已完成”任务统一迁移为“人工归档”，并让后续生图成功的任务直接进入该状态。升级命令仍为 `npm run db:upgrade -- --apply`；迁移保留任务、文案版本、图片和执行历史。

默认监听 `127.0.0.1:4310`。需要局域网执行机访问时，把 `CONTROL_PLANE_HOST` 改为 `0.0.0.0`，并用防火墙仅允许可信内网网段。当前版本没有 TLS 和节点身份认证，不能直接暴露到公网。

`0013_execution_heartbeats` 新增任务心跳和卡住执行回收。先升级并重启中心，再更新各执行机；旧卡住任务会保留产物并转为失败，供检查后重试或续跑。期限、兼容行为和验证步骤见 [执行恢复说明](../docs/execution-recovery.md)。

`0021_task_assignment_integrity` 和 `0022_auto_assignment_cursor` 提供任务负责人、显式人员池与历史任务完整性基础。当前 V3 契约下，普通任务先以未分配状态进入全局文案队列，文案执行机可直接领取；文案生成完成、进入待文案审核后，才按待审核额度自动补位或由管理员手工分配。只有加入且启用的普通用户会自动接单，管理员只能手工把任务分给自己，不能进入自动池。显式跳过文案审核的任务是例外，创建时必须指定负责人。普通任务的 V3 工作流复用现有字段；`0033_query_package_preassignment_repair` 会另外清理旧版 Query 词包在任务创建时写入的预分配。`0040_query_package_item_assignments` 把词包筛选负责人下沉到 Query 明细，支持多人平均分配、指定条数分配以及按明细版本并发提交；当前中心另支持 Excel 预检导入并报告 `queryPackageVersion=5`。筛选人只获得本人受派明细的读取和筛选权限，正式任务仍以未分配状态创建。新版 Web 会拒绝向不支持相应写操作的旧中心提交请求。仍应按 [迁移说明](migrations/README.md#0040-query-明细分配与并发筛选) 完成迁移，并先升级中心服务再更新界面。

启用交付池预览前先部署带 `sourceRef` 幂等和撤销支持的预览服务并应用其 D1 迁移，再应用中心迁移并同步更新中心服务和 Web。中心 `/health` 必须报告 `capabilities.deliveryPreviewVersion=6`；版本 6 在业务交付撤回时持久化撤销任务并自动重试，避免公网预览继续可见。旧中心缺少精确来源范围或可靠撤销能力时，新 Web 会拒绝相关写操作。

生成入口、终审 READY 门禁、ZIP 交付和预览上传只接受 PNG、JPEG、WebP、AVIF、GIF；TIFF 不再受支持。历史 TIFF 交付不会被改名伪装成 PNG，而会在读取文件前明确拒绝。

## 验证

```powershell
npm test
Invoke-RestMethod http://127.0.0.1:4310/health
```

业务代码、数据库 schema、默认提示词、测试和依赖锁文件均在本目录内；部署中心服务时不需要安装根目录执行机依赖。

## 模型调用链路

中心服务启动前先运行 `npm run db:upgrade` 预览，再运行 `npm run db:upgrade -- --apply` 执行待应用的版本化迁移。服务启动只检查迁移状态，不再自动升级数据库；随后更新并重启执行机。文案质检批次升级说明见 [文案质检批次升级](../docs/copy-qa-batch-upgrade.md)。

所有创作工作台列表共用的详情弹窗，底部提供默认折叠的“模型调用链路”。展开后分页加载调用摘要，每一步再按需加载实际提示词、请求参数、原始返回和错误。记录按任务及执行轮次保存，失败与重试不会覆盖此前调用。现有数据库导出/导入命令自动包含此表。

覆盖 OpenClaw 文案、搜索、视觉分析、生图/编辑调用，以及 Dots 文案和 DeepSeek 模拟调用。只记录项目可见的请求/返回，不能读取 OpenClaw 内部未暴露的子调用。历史任务无法补录实际调用原文；非模型兜底图片不会伪装成模型调用。

记录会脱敏常见密钥、认证头和密码字段，单项文本最多 200,000 字符，截断会显式提示；不记录环境变量、认证请求头或图片二进制。模型响应按原文只读显示，不执行其中内容。仍应仅允许可信内网访问，因为提示词及模型返回可能包含业务数据。

记录上传失败最多尝试两次，输出执行机警告，不影响原有生成结果、不重放模型调用；因此断网或执行机意外退出时可能缺少返回记录。“已返回”仅指接口返回，不代表后续业务格式或质量校验通过。
