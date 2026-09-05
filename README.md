# 小红书内容工场（Codex / OpenClaw）

本项目把 Excel 选题批量转为 SQLite 任务，通过独立 worker 生成 3–5 张图的小红书图文草稿，再进入本机 Web 后台做文案修改、图片修订、图生图和人工审核。它不会自动发布到小红书。

生成引擎现默认使用 **Codex CLI + ChatGPT 订阅登录**，保留 OpenClaw 兼容回退；Dots 文案、DeepSeek 检索独立配置不变。Codex 同机共享并发限制为总调用最多 2 个、图片最多 1 个，认证/额度失败暂停领取任务。

代码与无额度测试不等于真实生成验收。启用生产前请完成 [迁移、预检、真实验收与回切](docs/codex-exec-migration.md)。本次不自动部署、启动生产批次或新增定时任务；下文旧 OpenClaw 安装说明仅用于回退引擎。

## 能力范围

- `.xlsx` 最多 5 MiB / 5,000 行，先预检、后确认入队，重复确认不会重复建任务。
- 文本、图片、图片编辑三类系统提示词支持不可变版本、发布和回滚。
- 任务入队时固定提示词内容、版本与 SHA-256，后续全局修改不污染在途任务。
- 文案和图片修改保留父子版本；审核通过后再次编辑会自动回到待审核。
- 处于待审核或审核通过状态、且当前交付文件完整的任务可导出 ZIP，内含当前文案、真实审核状态和按页序排列的完整图片。
- 参考图可以进入文生图流程；审核端 AI 图生图请求由后台 worker 异步消费。
- 视觉知识库可从优秀图片提炼结构化配方；默认只保存提示词，只有自有或已授权图片允许长期保留并进入参考图生成。
- 默认只监听 `127.0.0.1`；显式启动局域网模式后，所有页面和 API 仍要求管理员或已授权质检账号登录。
- 生产配置中心统一管理 1 分质量修复策略和“AI生成”标识；数据统计页汇总批次耗时、评分分布和修复表现。
- Live 新文案先通过已配置的检索提供方（默认 DeepSeek）检索公开资料，保存检索词、提供方、尝试链、标题、URL、摘要和时间，再把固定研究快照交给文本模型。
- Live Worker 在联网检索前执行 Query 审核，并在正文结构校验后、视觉规划前执行独立文本审核；不通过时不继续生图。

## 环境

- Node.js 24.19.x（Web 后台与 Worker）
- Codex CLI：本机预检版本 0.152.1；使用 `codex login` 登录 ChatGPT，不在仓库保存认证信息
- 回退模式可继续使用 OpenClaw 2026.8.2 及原授权

## 分布式中心服务（新架构）

配置 `CONTROL_PLANE_URL` 后，系统进入分布式模式：远端 PostgreSQL 和远端文件目录是任务、执行记录、文案版本、图片结果、审核、提示词、知识库和生产配置的唯一真源。本机 Web 只作为操作界面，本机执行代理负责 OpenClaw 模型调用和短期临时文件。

创建笔记时可以从当前在线节点中指定文案执行机，文案任务只会由被指定的执行机串行处理；人工审核指定文案版本后，任务直接进入全局生图队列。只有显式启用图片能力且当前空闲的执行机才能原子领取一条生图任务。每次执行都有独立 `executionId`；人工重试会作废旧代次，旧进程之后提交的结果会被中心服务拒绝，不能覆盖新结果。

生图整次执行失败后，原生图执行机最多自动重试 2 次（加上首次共 3 次；OpenClaw 内部重试不另计）。第 3 次仍失败会停止自动生图，回到“待文案审核”，状态显示“生图3次失败”。重新提交审核后开启新一轮生图。该限制需更新并重启远端中心服务与界面后生效，详细规则见 [分布式控制中心](docs/distributed-control-plane.md)。

完整状态与存储设计见 `docs/distributed-control-plane.md`。

### 生图失败后继续

图片任务失败后，在任务详情点击“从失败步骤继续”，系统沿用已审核文案与原配置，由原执行机读取检查点继续：已完成的视觉规划不重做，已验收图片不重画，图片已生成但验收失败时只继续验收，整套质检失败时只重试质检，上传失败时只补传未完成图片。模型返回后保留下来的原始图也可用于重试本地图片处理。

失败期间请保留执行机的 `data/executor-work/<task-id>/`；原执行机离线时，任务等待该节点恢复。检查点缺失时明确报错，不会自动退回整套重画。需要修改文案、提示词或模型配置时，选择“使用最新配置重新生成”或重新提交文案审核。

启用此功能需要同步更新并重启中心服务、本机执行器和 Web 服务；不需要数据库迁移。Web 会检查中心 `/health` 的 `capabilities.imageResume`，旧中心服务不接受界面的断点续跑请求。升级时先停止旧执行器，再更新中心服务，最后启动新版执行器和 Web。详细契约和验证见 [生图断点恢复说明](docs/image-resume-spec.md)。

### 远端中心机器安装

中心机器不安装 OpenClaw，也不保存模型密钥。它只需要项目要求的 Node.js 24.19.x、PostgreSQL、当前项目代码和一个服务端图片目录。PostgreSQL 只允许中心服务本机访问，执行机不得直连数据库。

从 [PostgreSQL 官方下载页](https://www.postgresql.org/download/) 安装后，创建独立数据库和账号（密码请自行替换；如含特殊字符，写入连接 URL 时需要 URL 编码）：

```powershell
psql -U postgres -c "CREATE USER xhs_control WITH PASSWORD 'replace-this-password';"
psql -U postgres -c "CREATE DATABASE xhs_control OWNER xhs_control;"
```

远端服务已经从执行机项目中拆到独立的 `server/` 包，接口使用 Koa。中心机器只安装该目录的依赖；`npm run init` 可重复执行，首次会安装默认生产配置和三类默认提示词：

```powershell
cd server
npm install
npm run init
npm start
```

中心服务只使用 `server/.env`：

```dotenv
DATABASE_URL=postgresql://xhs_control:替换为数据库密码@127.0.0.1:5432/xhs_control
CONTROL_PLANE_HOST=0.0.0.0
CONTROL_PLANE_PORT=4310
CONTROL_PLANE_STORAGE_ROOT=server-storage
```

`CONTROL_PLANE_STORAGE_ROOT` 是中心服务保存任务图片等文件的目录；相对路径从 `server/` 目录计算。

默认端口是 `4310`。需要供局域网执行机访问时，将 `CONTROL_PLANE_HOST` 设为 `0.0.0.0`，并仅在专用/可信内网的防火墙中允许执行机网段访问该端口。当前第一版是内网 HTTP 且没有 Worker 身份认证，不得做公网端口映射。

### 中心数据库导出、首次导入与增量升级

这组命令只操作 `server/.env` 中 `DATABASE_URL` 指向的 **PostgreSQL 中心库**，不操作旧的本地 SQLite。
需要安装 PostgreSQL 客户端 `pg_dump` / `pg_restore`；Windows 自动查找 `C:\Program Files\PostgreSQL\<版本>\bin`。
不在默认位置时，在 `server/.env` 添加 `PG_BIN=C:\你的路径\PostgreSQL\18\bin`。客户端主版本不能低于源数据库，恢复目标建议使用相同或更新的 PostgreSQL 主版本。
不打印数据库密码，也不把密码放进子进程命令行；脚本从配置自动读取。

以下命令均在 `server/` 目录执行。也可以在项目根目录分别使用 `npm run server:db:export`、`npm run server:db:init -- ...`、`npm run server:db:upgrade -- ...`。
注意根目录旧的 `npm run db:init` 仍是 SQLite 初始化，不要混淆。

#### 1. 导出所有表结构和数据

```powershell
cd server
npm run db:export
# 可选：指定导出文件夹的父目录（每次自动新建唯一备份子目录，不覆盖已有备份）
npm run db:export -- --out=D:/backups/xhs
```

默认生成 `server/backups/backup-时间-随机后缀/`，包含：

- `database.dump`：完整结构和数据的 PostgreSQL 备份，包含索引、约束和序列。
- `database.sql`：同一份备份的可读 SQL，便于检查。
- `tables/*.jsonl`：增量合并使用的全表数据，支持流式读取和大整数 ID。
- `migrations/*.sql`：版本化表结构升级文件。
- `manifest.json`：表清单、行数、序列状态和各文件校验和；最后写入，缺少清单即为未完成备份。

全量备份与 JSONL 使用同一个数据库快照，保证表间一致。所有非系统表均导出；不导出 PostgreSQL 集群级账号、密码和授权配置。
备份包含内部业务数据，默认目录已被 Git 忽略。完整保留整个备份目录，不要只复制一个 SQL 文件。

#### 2. 在新机器首次导入

先安装 PostgreSQL、创建账号和**空数据库**，并将目标连接写入目标机器的 `server/.env`。
这里不要先运行旧的 `npm run init`，否则它会建表，数据库不再为空。

```powershell
cd server
npm install
# 只预览、检查文件完整性和目标库是否为空，不写入
npm run db:init -- --from=D:/backups/xhs/backup-实际目录
# 确认目标连接正确后执行
npm run db:init -- --from=D:/backups/xhs/backup-实际目录 --apply
```

只允许导入空库，不会 DROP / 清空现有数据。恢复使用单事务，SQL 执行失败会回滚。目标数据库和角色需要提前创建，脚本不要求超级用户或 CREATEDB 权限。
导入使用目标账号拥有对象，不复用源端 owner/ACL；新账号需要有目标 schema 的创建权限。

#### 3. 已有数据库增量升级（结构 + 新增/修改数据）

先停止目标中心服务及执行机，备份目标库，再导入来自同一数据源的新导出包：

```powershell
cd server
npm run db:export
npm run db:upgrade -- --from=D:/backups/xhs/backup-新版目录
npm run db:upgrade -- --from=D:/backups/xhs/backup-新版目录 --apply
```

合并规则：新增主键插入；相同主键以导出包为准更新；相同内容不重复更新；不删除目标库独有的行。
“增量”指目标端执行增量合并，导出包本身仍是完整快照，不是时间差分包。
不是按修改时间自动取较新值：较旧备份也可能覆盖目标修改，因此务必预览目标连接、先备份并确认数据方向。
发布版本跟随源库：同一提示词/知识条目已有的其他发布版本会归档，以保证只有一个当前发布版本；条目和历史内容不会删除。
表结构迁移记录、checksum 校验、循环外键检查与数据合并一起管理。中途遇到冲突会回滚表结构和数据；序列只前进不倒退，极端提交失败可能留下无害的 ID 间隔。

只支持**从同一源库衍生的数据**：独立两套系统可能用了相同数字 ID，不能当作同一条业务记录自动合并。
脚本会检查创建时间、版本归属等身份字段及唯一键，发现明显冲突就停止回滚，不会猜测并改写关联 ID。
没有主键的表不能安全增量合并；未记录为迁移 SQL 的手工结构差异也会被拒绝。全量初始化不受这两项增量限制。
预览只列出源表行数和待迁移版本；完整逐行冲突检查在执行事务中完成，不保证预览通过就一定无冲突。

只升级当前代码的表结构、不合并业务数据：

```powershell
npm run db:upgrade
npm run db:upgrade -- --apply
```

当前 `0006_manual_archive` 升级会把原“待图文审核”和“已完成”任务合并为“人工归档”；不会删除任务、文案版本、图片或执行历史。

后续新增字段/索引时，在 `server/migrations/` 新增编号 SQL，见该目录 README；不要修改已执行迁移或基线 `server/src/schema.sql`。
中心服务启动也会执行尚未应用的代码迁移，不会反复覆盖默认配置或用户数据。

**图片与安全注意事项：**

- 数据库不含 PNG/JPEG 文件。完整迁移还要单独复制 `CONTROL_PLANE_STORAGE_ROOT`（默认 `server/server-storage/`）。
- 当前资产表和部分历史快照保存绝对文件路径。搬机后需保持相同绝对路径；路径不同需另做路径迁移，脚本不会盲目替换 JSON 中的路径。
- 为了让文件目录与数据库对应，并避免复制正在执行的任务状态，整机迁移前先暂停执行机和中心服务，再备份数据库和文件目录；迁移完成后只启动预期的一套执行机。
- 只导入自己生成或已审查的可信备份：SQL/迁移文件会作为数据库代码执行，校验和只能校验完整性，不代表可信授权。
- 官方说明：[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)。

### 每台执行机安装

执行机需要 Node.js、项目依赖、OpenClaw 及本机模型授权。Windows 可使用 [OpenClaw 官方安装器](https://docs.openclaw.ai/install)：

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

已经自行管理 Node.js 时也可以使用 npm，并完成本机授权：

```powershell
npm install -g openclaw@latest --allow-scripts=openclaw
openclaw onboard --install-daemon
```

拉取项目后配置执行代理和本机 Web。`EXECUTOR_NODE_ID` 必须每台机器唯一且重启后保持不变：

```powershell
npm install
npm run auth:setup
npm run dev:lan
```

执行机只使用项目根目录 `.env`。`npm run auth:setup` 会在其中生成会话密钥（并保留兼容旧版所需的管理员密码哈希），不会覆盖下面的其他配置。实际登录账号和密码统一保存在中心服务：

```dotenv
CONTROL_PLANE_URL=http://中心服务器内网IP:4310
EXECUTOR_NODE_ID=每台机器唯一且长期不变的ID
EXECUTOR_NODE_NAME=便于识别的机器名称
IMAGE_WORKER_ENABLED=true
EXECUTOR_POLL_MS=5000
EXECUTOR_WORK_ROOT=data/executor-work
```

不承担生图任务的机器将 `IMAGE_WORKER_ENABLED` 设为 `false`。OpenClaw 模型、代理或 API Key 等本机配置也统一写在这份文件中。

另开一个终端启动执行代理。纯文案机器不会启动图片轮询：

```powershell
npm run executor -- --disable-image-worker
```

允许领取全局生图任务的机器必须显式开启：

```powershell
npm run executor -- --enable-image-worker
```

也可在根目录 `.env` 固定 `IMAGE_WORKER_ENABLED=true|false`。命令行开关优先级更高。文案和图片使用两个互不阻塞的执行通道：文案通道串行处理分配给本机的任务；图片通道开启后，只要本机当前没有正在执行的图片任务，就会独立领取一条全局图片任务，不需要等待文案队列清空。停止执行代理不会影响远端已保存数据；若某次执行长时间没有更新，在“远端作业中心”中人工选择复用原快照或使用最新配置重新执行。

执行代理启动时会先检查中心服务连接和本机工作目录；全部通过后才向中心注册上线并开始轮询。运行期间每 15 秒刷新在线状态，中心将 90 秒内有活动的节点视为在线。节点中途关闭时，已分配的待执行文案保留在原队列；该节点重启并重新通过就绪检查后才会继续领取。OpenClaw 和模型连接在实际执行任务时检查，当前不作为节点上线门禁。

分布式模式下：

- `/copy-generation` 创建单条或批量 Query，不在页面请求中同步跑模型。
- `/jobs` 展示所有节点的任务、阶段、开始时间、最后进度、人工文案审核、图文审核和重试。
- `/workbench` 默认展示本机文案队列，并可切换全部节点的待执行、执行中、失败、待审核、生图和已完成任务；创建笔记时可选择在线文案执行机。
- `/prompts`、`/knowledge`、`/settings` 读写远端中心数据。
- `/image-generation` 和 `/batch-image-generation` 不再直接生图，生图统一由启用图片能力的执行代理领取。

### 联网搜索提供方配置

正式文案流程可独立切换联网搜索提供方，项目默认使用 DeepSeek `deepseek-v4-flash`。显式配置 `XHS_WEB_SEARCH_PROVIDER=OPENCLAW` 时，保留原有 OpenClaw/Codex 搜索及重试逻辑。搜索切换只影响研究阶段，文案生成（OpenClaw 或 Dots）、审核、生图及人工审核流程仍沿用原配置。

在“生产配置”页面上方的“联网搜索服务”面板，可直接选择 OpenClaw / DeepSeek、DeepSeek 搜索模型和超时，并点击“保存搜索配置”；也可点击“使用 DeepSeek Flash”填入推荐配置后保存。面板区分已保存配置与未保存修改，本地模式显示实际生效的服务。本地和远端中心模式都支持；保存值优先于执行机环境变量。选择“跟随默认配置”或点击“恢复环境配置”后保存，即可恢复环境变量控制；未设置环境覆盖时使用 DeepSeek Flash。此面板只修改搜索字段，不覆盖文案模型或其他生产配置。

中心模式将配置保存在生产设置的 `modelApi.webSearchProvider`、`modelApi.deepseekSearchModel`、`modelApi.webSearchTimeoutMs` 中，后续创建的执行快照会携带这些值。各执行机须更新至支持这些字段的项目版本并重启一次；之后通过页面修改提供方或模型无需再次重启，已经领取的任务继续使用原快照。Key 始终由使用者在执行机提供，页面不接收、保存或下发密钥，也不把前端主机的 Key 状态当作远端执行机状态。

在**实际执行文案任务的机器**上，向项目根目录的本机 `.env` 或进程环境中添加以下配置，并自行填写 Key（禁止提交真实密钥）：

```dotenv
XHS_WEB_SEARCH_PROVIDER=DEEPSEEK
DEEPSEEK_API_KEY=
XHS_DEEPSEEK_SEARCH_MODEL=deepseek-v4-flash
XHS_DEEPSEEK_SEARCH_TIMEOUT_MS=120000
```

`DEEPSEEK_API_KEY` 必填；后两项可以省略。搜索模型支持 `deepseek-v4-pro` 和 `deepseek-v4-flash`，超时允许 5000–120000 毫秒。修改后重启相应服务：网页本地执行重启 Next.js，分布式执行重启 `npm run executor`。仅在中心服务器设置不会传递给远端执行机。旧 CLI worker 不自动加载 `.env`，可使用 `node --env-file-if-exists=.env src/cli.mjs worker --once`，或通过启动进程的环境提供配置。

没有页面覆盖值时，改回 `XHS_WEB_SEARCH_PROVIDER=OPENCLAW` 并重启即可恢复原搜索方式，不需要删除 Key；已有页面覆盖值时，直接在面板选择 OpenClaw 并保存。配置模块为 `src/web-search-config.mjs`，此开关与 `XHS_COPY_GENERATION_PROVIDER` 相互独立，也不改变临时 DeepSeek 模拟执行机的逻辑。

DeepSeek 通过官方 Responses API 执行服务端 `web_search`，使用 Node HTTPS 请求，不使用 OpenClaw 的 `XHS_MODEL_PROXY_URL` 子进程代理配置。缺少 Key、接口错误、没有完成搜索或缺少有效公开来源时，沿用现有研究失败流程并停止该次文案生成，不自动切回其他提供方。研究快照保留 `deepseek` 提供方及来源信息，不保存 Key、原始接口响应或模型推理内容。

接口依据：[DeepSeek Responses API 文档](https://api-docs.deepseek.com/api/create-response/)；返回格式及来源校验继续遵循 [联网研究规格](docs/web-research-source-spec.md)。测试使用假的接口响应，不消耗模型额度。

### DeepSeek 文案模拟执行（临时测试入口）

本机暂时无法调用 OpenClaw 时，可启动隔离的 DeepSeek 模拟执行机。它使用固定模型 `deepseek-v4-pro` 和 Responses API 的服务端 `web_search`，仍按 Query 审核、联网研究、首稿及图片策划的现有契约执行，并把结果写回中心进入人工文案审核；不会执行自动文案质检或自动改写。正常 `npm run executor`、`executeCopyClaim` 和 OpenClaw 调用链不受影响。

只在本机根目录 `.env` 配置密钥和独立节点 ID，禁止把真实密钥提交到 Git：

```dotenv
DEEPSEEK_API_KEY=在本机填写
DEEPSEEK_SIM_NODE_ID=poker-deepseek-sim
```

启动后，该节点会出现在创建笔记的在线执行机列表中。选择它创建任务；进程会常驻并持续轮询分配给本机的文案任务，队列为空时等待：

```powershell
npm run executor:deepseek-sim
```

进度和结果会明确标记为 `DEEPSEEK_SIMULATION`。只有显式传入 `--once` 才会在每个已启用通道轮询一次后退出，供自动化测试使用。测试结束后，删除 `src/deepseek-responses-client.mjs`、`src/executor/deepseek-copy-simulator.mjs`、`src/executor/deepseek-image-simulator.mjs`、`src/executor/deepseek-simulator-cli.mjs` 以及本脚本配置即可，生产执行链不需要回改。

### DeepSeek 搜图模拟执行（临时测试入口）

文案人工审核通过后会进入全局生图队列。本机无法调用 OpenClaw 生图时，可另外启动完全隔离的搜图模拟执行机。它使用 `deepseek-v4-pro` 的服务端联网搜索，为每页配图策划返回带来源和使用说明的候选图片；执行机逐个校验公网 URL、响应类型、大小和像素尺寸，统一裁切为 `900 × 1200` PNG 后上传中心文件服务。任务随后照常进入图文审核，弹窗会明确标记“联网搜索模拟图”并展示来源。它不会调用或修改正常的 `executeImageClaim`、`generateStandaloneImages` 与 OpenClaw 生图链路。

搜图模拟与文案模拟共用同一个常驻执行机进程和节点标识。沿用本机 `DEEPSEEK_API_KEY`，并通过已有开关决定是否启动图片轮询通道：

```dotenv
DEEPSEEK_SIM_NODE_ID=poker-deepseek-sim
IMAGE_WORKER_ENABLED=true
```

只需启动一个模拟执行机。文案通道始终持续轮询；当 `IMAGE_WORKER_ENABLED=true` 时，图片通道同时持续轮询全局 `IMAGE_QUEUED`，两个通道互不等待，进程不会因为暂时没有任务而退出：

```powershell
npm run executor:deepseek-sim
```

所有图片二进制都会通过中心服务上传接口保存到 `server/server-storage/tasks/<taskId>/image-runs/<runId>/`，本地执行机不作为图片真源。搜索图片仅用于内部流程联调，不等同于 OpenClaw 生成结果，也不代表已经完成版权、图文匹配或质量审核。

如果没有配置 `CONTROL_PLANE_URL`，旧的 SQLite 本地模式仍暂时保留，便于迁移和紧急回退；不要同时把两套模式当作业务真源写入。

已有本地 SQLite 中的提示词、文案知识、视觉知识和生产配置可做一次性追加迁移。先运行只读预览，再明确执行；旧任务与历史图片不会由第一版脚本迁移：

```powershell
npm run control-plane:migrate-local
npm run control-plane:migrate-local -- --apply
```

`--apply` 不是幂等导入，重复执行会追加重复版本。迁移验收完成后再启用分布式模式，避免新旧数据双写。

OpenClaw 进程使用的 Node 还必须满足已安装 OpenClaw 的 `engines.node` 约束；
如果后台使用的 Node 不兼容，可在根目录 `.env` 单独指定兼容运行时，不会替换系统 Node：

```dotenv
OPENCLAW_NODE_PATH=C:\Program Files\nodejs\node.exe
```

文案默认使用 `openai/gpt-5.6-sol`，文本请求固定使用 `thinking=high`；如需固定其他已授权模型，可在根目录 `.env`
设置 `XHS_TEXT_MODEL=provider/model`。需求检测默认沿用该值，也可用 `XHS_SCREENING_MODEL` 单独指定成本更低的模型。
两道阶段审核可用 `XHS_REVIEW_MODEL=provider/model` 单独指定；未设置时沿用 `XHS_TEXT_MODEL`。
逐页 OCR/图文验收可用 `XHS_VISION_MODEL=provider/model` 单独指定；最终 0–3 分终审可用
`XHS_QUALITY_MODEL=provider/model` 指定不同模型，以减少生成模型自评偏差。

如 TUN/Fake-IP 会中断 OpenClaw 的长图片连接，可只为图片生成与编辑子进程配置本机代理，
避免影响文本 Responses 链路：

```dotenv
XHS_IMAGE_PROXY_URL=http://127.0.0.1:7897
```

若日志出现 `Blocked: resolves to private/internal/special-use IP address`，且 `chatgpt.com`
被解析为 `198.18.x.x`，说明 TUN/Fake-IP 解析触发了 OpenClaw 的网络安全校验。
将上面的地址设为本机实际运行的 HTTP 代理，保存后重启使用 `.env` 的执行器。
图片生成与编辑重试会继续使用配置的代理；安全拦截不会作为瞬时网络故障重试。
页面会优先显示拦截原因，避免被前面的插件配置警告截断。

单次图片生成/编辑默认等待 5 分钟；如需调整，可设置
`XHS_IMAGE_TIMEOUT_MS=300000`（允许 30000–540000 毫秒）。整段进程超时不会在同一任务租约内自动重跑；错误会同时保留进程异常和 OpenClaw 日志，避免把认证路由提示误报为根因。`drain` 任务并发可用 `--concurrency 1|2` 或 `XHS_TASK_CONCURRENCY=1|2` 控制，默认为 2。单任务图片并发可用 `XHS_IMAGE_CONCURRENCY=1|2` 控制；当任务并发为 2 时，每个任务的图片并发会强制为 1，使同一 drain 内的总模型调用并发不超过 2。

## 启动后台

首次使用先生成界面服务的会话密钥，并确保中心服务已经执行数据库升级：

```powershell
npm install
npm run auth:setup
npm run server:db:upgrade -- --apply
npm run dev
```

生产构建与本机启动：

```powershell
npm run build
npm start
```

打开 `http://127.0.0.1:3001`。初始管理员账号为 `admin`，默认密码为 `123456`，首次登录会进入个人信息页修改密码。用户账号、姓名、角色、密码哈希以及任务创建者都保存在中心服务 PostgreSQL 中。数据库默认为 `data/queue.db`，生成交付在 `output/`，审核素材在 `data/assets/`；这些目录不会进入 Git。

### 局域网登录

完成密码配置后，构建并显式监听局域网地址：

```powershell
npm run build
npm run start:lan
```

同一私有局域网的设备打开 `http://<这台电脑的局域网IP>:3001`，使用刚设置的管理员密码登录。默认允许 loopback、`10/8`、`172.16/12`、`192.168/16`、IPv4 link-local 和 IPv6 ULA/link-local；如需使用电脑主机名，在根目录 `.env` 添加 `XHS_ALLOWED_HOSTS=主机名` 后重启。

`start:lan` 不等于公网部署。它只适用于可信家庭/办公局域网；不要在来宾 Wi-Fi、端口映射或公网服务器上直接使用 HTTP。跨网段或公网部署必须增加 HTTPS 反向代理、防火墙白名单和更完整的身份系统。

## Excel 导入

首个工作表必须包含 `query`、`查询`、`选题` 或 `主题` 之一。可选列：

```text
externalId, category/分类, targetAudience/目标用户,
promptSet, imageCount/图片数量, referenceImageFiles/参考图,
referenceUrls/参考链接, referenceText/参考资料,
priority/优先级, metadata/元数据
```

`imageCount` 为旧模板兼容字段，填写时仍只能为 3–5；Live 生成不会把它当成固定交付数，而会根据最终正文结构自动选择最少且足够的 3–5 张，并把实际数量写回任务记录。`metadata` 必须是 JSON 对象。页面流程为“上传与结构预检 → OpenClaw 需求检测 → 人工复核 → 确认入队”；所有结构合格行完成筛选前不能提交。

如工作表已经完成业务筛选，还可提供 `是否有效`、`废弃原因`、`需求强度判定`、`判定简要说明`，页面会直接带入并允许人工修正；未提供判定的结构合格行会在上传请求中调用 OpenClaw 文本模型自动检测。检测按最多 50 行和有界字符预算分批，全部批次通过严格 JSON 校验后才创建预览批次；任何一批缺行、重复行、非法档位或调用失败，整次上传都会失败，不会写入半成品批次。

需求强度支持“强需 / 中需 / 弱需 / 无需”：强需、中需进入生产队列，弱需、无需只保留在筛选记录中。页面展示判定来源和实际模型名，管理员修正后来源变为人工。可用 `XHS_SCREENING_MODEL` 单独指定检测模型；未设置时沿用 `XHS_TEXT_MODEL` 或 OpenClaw 客户端默认文本模型。大批次会增加上传等待时间和模型费用，常规自动化测试只使用 Fake，不消耗额度。

## Query 与文本阶段审核

Live 生产顺序为“Query 审核 → 联网研究 → 正文生成与结构校验 → 文本生成后审核 → 视觉规划 → 逐页生图与验收 → 整套终审 → 人工审核”。Query 审核关注内容目标是否清晰、合法且可生产；文本审核关注主需覆盖、标题兑现、事实来源、风险边界和图片规划一致性。

- 审核不通过时失败关闭，不自动改写 Query 或正文，也不继续后续付费阶段。
- 单独文案生成页采用“首稿优先”策略：首稿审核通过即直接交付，仅在发现阻断问题时按问题清单修订并复检。
- 联网检索优先采用权威来源；Codex 返回带依据摘要时可直接进入写作，其他提供方的带摘要结果会先继续查找权威来源。只有低权威搜索页且无摘要时会失败关闭，避免模型用弱资料补写事实。
- 当前尝试目录保存 `query-review.json` 和 `text-review.json`，每份结果绑定被审内容 SHA-256。
- `manifest.json` 与 SQLite `generation_runs.stage_reviews_json` 保存同一份有界证据；内容审核页按生成批次展示决策、模型、摘要和问题。
- Mock 只标记为 `MOCK 模拟验证`，不声称已经真实模型审核。

## Query 预审与任务级内容质检

管理员登录后可从左侧进入 `/reviews` 质检中心，并在“质检人员”中创建独立账号。账号可授予“Query 质检”“内容质检（文案+图片）”或“质检组长”角色；停用账号或修改角色后，旧会话会失效。内部角色名 `COPY_REVIEWER` 为兼容保留，实际岗位负责同一任务的文案与图片。

推荐作业顺序：

1. 生产质检选择导入批次、内容质检员和条数，原子分配恰好 N 条未分配任务；库存不足时整次不分配。
2. 每条任务只有一名当前负责人。该人员在统一详情页先核对当前文案，再核对当前文案对应的图片，直到两阶段通过。
3. 文案或图片改变后，旧阶段结论自动显示为失效，但任务不会换人；转派时文案与图片责任整条同步变更。
4. Query 预审保持独立：管理员按批次生成 Query 工单，随后派单或由 Query 质检员领取。
5. 驳回必须选择原因或填写说明。所有阶段结论都绑定审核人、时间、内容快照和 SHA-256，并追加审计记录。

本阶段人工 Query/内容质检是独立作业闭环，不会暂停现有 Worker；自动 Query/文本审核仍是生产门禁。若后续要求“人工文案通过后才能生图”，需要再把文本 Worker 与视觉 Worker 拆成两个可恢复阶段。完整数据与迁移契约见 `docs/review-work-management-spec.md`。

## 联网研究与来源保存

Live 且需要生成新文案的任务会在文本模型之前执行配置的联网搜索，项目默认使用 DeepSeek Flash。切换为 OpenClaw 时，通过 `infer web search --json` 调用默认的 Codex Hosted Search，使用 OpenClaw 已有的 OpenAI/Codex 登录；只有显式配置多个受支持提供方时才依次尝试，不会自动增加其他搜索后备。

每次实际检索都会形成不可变研究快照：

- 当前尝试目录保存 `research.json`，包含检索词、实际提供方、每个提供方的成功/失败、脱敏错误、检索时间，以及最多 5 个去重来源的标题、URL、站点和摘要。
- `manifest.json` 记录研究状态、提供方和来源数，并把 `research.json` 纳入 SHA-256 文件清单。
- SQLite 的 `generation_runs.research_snapshot_json` 保存同一份有界快照；旧运行保持 `null`，不会补造来源。
- 成功快照写入 checkpoint。图片阶段失败后重试会复用同一资料，不会重复搜索或让同一文案的依据漂移。
- `post.sources` 只能从 Excel 的 `referenceUrls` 或本次 `webResearch.sources` 中选择；模型补出的其他 URL 会被结构校验拒绝并重试。

若配置的搜索服务失败，或没有返回可用的公开 HTTP(S) URL，任务会在文本生成前失败，同时保留失败快照；不会在无资料时继续生成并声称已经核验。Mock 和人工文案仅重生图片不会联网。

当前接入保存搜索结果的摘要或 Codex 归纳文本，不等于读取网页全文。OpenClaw 的 `web_fetch` 需要当前安装中存在可用 fetch provider；未配置时本项目不会伪造正文抓取记录。官方能力边界见 [OpenClaw Web Search](https://docs.openclaw.ai/tools/web) 和 [OpenClaw Web Fetch](https://docs.openclaw.ai/tools/web-fetch)。

### Windows 搜索卡在 RESEARCH / EBUSY

OpenClaw 2026.8.2 的隔离搜索进程可能在启动时下载 Codex 插件目录，清理临时 `codex-home/.tmp/plugins-clone-*` 时发生 EBUSY。`scripts/patch-openclaw-bounded-search.mjs` 将搜索原有的 `features.plugins=false` 限制提前到子进程启动，不修改登录、普通文案/生图会话或 Hosted Search。

先用 `openclaw plugins inspect codex --json` 确认实际启用插件的 `plugin.rootDir`。独立安装的 `@openclaw/codex` 自带搜索模块，**只修补全局 `openclaw/dist` 不会修复它**。对查到的准确包目录执行：

```powershell
node scripts/patch-openclaw-bounded-search.mjs --openclaw-root="<plugin.rootDir>"
node scripts/patch-openclaw-bounded-search.mjs --openclaw-root="<plugin.rootDir>" --apply
```

第一条仅检查，第二条先保存 `.xhs-startup-plugins.bak` 再修补；输出包含包名和准确文件路径，已修补时不会重复修改。脚本只接受 `openclaw` 或 `@openclaw/codex`，拒绝未知代码结构和覆盖已有备份。上游包升级后需要重新检查。

先确认中心服务 `/health` 可用，再停止旧执行机并重新运行 `npm run executor`，使失败回报重试及长错误兼容逻辑生效；仅刷新网页或重启 Gateway 不会更新执行机进程。确认旧执行机已停止后，对仍卡住的任务执行“重试”，不需要废弃任务或重新录入。若搜索通过常驻 Gateway 调用，需在没有运行中任务时另行重启 Gateway；本项目 `infer web search` 的新 CLI 子进程会读取更新后的文件。

## 溯源规则提示词

三类运行提示词分别位于 `server/prompts/text-system.md`、`server/prompts/image-system.md` 和 `server/prompts/image-edit-system.md`。它们随中心服务独立部署，同时仍作为旧本地模式的初始种子。规则编号和原始来源映射保留在工作区上级文档 `图文生成统一系统提示词_原始文档溯源版.md`；运行提示词只包含规则正文，不携带 `[Rxxx]` 标签。

全新数据库会自动使用这些提示词。已有数据库需要显式发布新版本：

```powershell
npm run prompts:install-rules
```

该命令按内容哈希幂等安装并发布版本，不修改已入队任务固定的提示词快照。新版本只影响之后提交的任务。

## 视觉知识库

登录后台后打开 `/knowledge`。上传 PNG、JPEG 或 WebP 图片，系统会通过 OpenClaw `infer model run --file` 提炼图片类型、提示词模板、负面约束、风格标签和布局规则。图片中的文字始终按不可信数据处理，模型结果必须经过字段、枚举、变量和长度校验，并由管理员确认发布后才会进入生产。

保存模式：

- `PROMPT_ONLY`：只保存结构化配方和原图 SHA-256；分析临时目录会被删除。
- `IMAGE_AND_PROMPT`：保存规范化 PNG 和配方；仅允许 `SELF_OWNED` 或 `LICENSED`。

Worker 首次处理任务时，从已发布的 `MODEL_IMAGE` 配方中按分类、标签和质量分选择一条并锁定版本。每张图片的最终提示词按“全局图片规则 + 视觉配方 + 已生成的完整标题/正文 + 当前页计划”组合；授权保留图会进入受控 `referenceImagePaths`。重试继续使用同一版本，知识库为空时只省略配方部分。

文本模型的结构化输出里会同时包含 `imagePlan[].prompt` 作为逐页初始视觉方向；它不是直接提交给图片模型的最终提示词。文本审核通过后，系统还会基于完整正文生成独立 VisualPlan，再与图片系统规则、视觉配方和当前页白名单组合成实际生图提示词。

视觉图片默认存放在 `data/knowledge/`，可用 `XHS_KNOWLEDGE_ROOT` 覆盖；视觉分析模型可用 `XHS_VISION_MODEL` 覆盖。Live 交付图会先串行完成第一张，再让后续图片最多两张并发生成；第二张起都使用第一张作为只读风格参考。Sharp 只负责统一为 1086×1448 PNG，Live 主链路不再叠加第二层文字。最终图片继续执行逐页 OCR 与图文验收；合规标识由 `/settings` 的生产配置控制。真实模式至少产生 3–5 次图片模型调用，逐页修复和整套质量修复会增加调用次数，不应在未配置预算和限流时批量执行。

## 质量评分 V2

`qc.json` 使用规则文档的 0–3 分漏斗，并在 `rubric` 字段记录规则版本、分层得分、维度证据、类型校正和最低阻碍维度：

- 0 分：安全、法律、健康、隐私或严重误导红线。
- 1 分：需求未满足、严重重复，或任一适用基础可用维度低于 2。
- 2 分：所有基础维度合格，但仍有维度为 2 或轻微问题；进入人工审核。
- 3 分：所有适用维度均有明确高质量证据并达到 3，且没有问题标签；仍需人工确认，不会自动发布。

机械检查只能证明基础门槛，默认最高给 2 分。每个 Live 交付会在逐页 OCR 通过后，再由独立多图 VLM 对最终标题、正文和全部 3–5 张图片执行十维终审；可用 `XHS_QUALITY_MODEL` 与生成模型分离。首次终审恰好为 1 分时，默认以当前逐页图片为图生图输入，按照限制分数的证据重新生成整套图片，达到至少 2 分即停止，最多修复 2 次；每轮原因、方法、前后分数和耗时写入 QC 并在审核页展示。首次 0 分不进入该修复循环；2 分后继续现有逻辑，保存证据并被 3 分完成门禁退回。只有 3 分候选完成 Worker，仍需人工确认且不会自动发布。

## 生产配置与数据统计

登录后打开 `/settings` 可调整质量修复开关、触发分、目标分、最多修复次数，以及合规标识的开关和文字。最大整套修复次数限制为 2；配置在 Worker 领取任务时固定，并进入检查点指纹和交付清单。

打开 `/analytics` 可查看任务生成批次和导入批次的开始时间、结束时间、实际耗时、平均运行耗时、评分分布、修复次数和达标数量。历史记录缺少时间或修复详情时会明确显示“暂无数据”，不会反推或伪造统计值。

## Worker

导入批次确认入队后，页面会显示“4. 启动文案与图片生成”。点击按钮并确认真实模型费用后，后台会按全局队列顺序异步启动 Live Worker，最多同时生产 2 个完整任务；单次最多 20 条，网页无需保持等待。生成状态、失败原因和最终内容在“内容审核”页面查看。网页启动不会自动发布，也不会接受客户端传入的命令、路径、模型或并发参数。

每条新文案的基础 Live 流程通常会调用 4 次文本模型（Query 审核、正文生成、文本生成后审核、视觉规划）、3–5 次图片模型和 3–5 次逐页视觉验收；页面修复与整套质量修复可能增加额外调用。

如需通过终端操作，仍可使用以下命令。

Mock 单条，不调用模型：

```powershell
npm run worker -- --once --mock
```

Mock 连续消费，最多处理 1000 个内容或图片编辑工作项：

```powershell
npm run worker:drain -- --mock --max 1000
```

真实连续消费必须显式使用 `--live` 和上限。第一次建议从 10–20 条开始验证提示词、配图和预算：

```powershell
npm run worker:drain -- --live --max 20 --concurrency 2
```

真实模式会产生模型调用成本。订阅账号/OAuth 不适合作为每天 1000 条的长期批量额度；生产使用前应配置正式 API 预算、速率限制、失败重试和用量告警。

Live `worker` / `drain` 会在领取任何任务前执行一次 OpenClaw 无推理预检，检查兼容运行时、认证状态和当前文本/图片模型配置；预检失败不会增加任务 `attempts`。生成期间会在文本、视觉规划、逐页图片生成和视觉验收边界续租，长任务不会仅因超过默认十分钟而被重复领取。

每个任务在 `output/<task-id>/checkpoint.json` 保存配置指纹、已通过契约的正文、视觉计划和逐页图片检查点。失败重试仅在 Query、输入、固定提示词、生产配置、人工文案修订和参考图配置均未变化时复用；图片还必须同时满足当前视觉计划哈希、`alignment=PASS` 和文件 SHA-256 一致。检查点损坏、文件被修改、生产配置变化或人工文案变化时会安全失效并重新生成，不会把旧图片混入当前交付。

### 单独生成文案 API

`POST /api/copy-generations` 可脱离完整 Worker 单独生成并保存文案。提交后会先持久化一条 `RUNNING` 生成任务，再依次执行 Query 审核、联网研究和正文生成；首稿、模型、Query 审核证据和研究快照会作为同一条历史记录原子保存，任务同时转为 `COMPLETED`。失败任务保存安全、脱敏的错误摘要。它使用后台当前已发布的 `TEXT_SYSTEM` 提示词，不会启动文本生成后审核、图片生成或图片验收，也不会自动写入任务和文案修订表。

请求必须来自已登录管理员的同源会话，并显式确认真实模型费用。每次请求只生成一份文案；兼容参数 `autoReviseOnReject` 仍可传入，但当前不会触发自动文本审核或二次改写：

```json
{
  "query": "租房桌面怎么低成本整理？",
  "input": {
    "category": "收纳",
    "targetAudience": "小户型租房人群",
    "referenceText": "可选的参考资料，最多 12000 字",
    "referenceUrls": ["https://example.com/reference"]
  },
  "imageCount": "auto",
  "confirmation": "LIVE_MODEL_COST_ACCEPTED"
}
```

`imageCount` 可传 `3`、`4`、`5` 或 `"auto"`，只控制随文案返回的 `imagePlan` 项数，不会调用图片模型。成功返回 HTTP `201`：`data.original` 与兼容字段 `data.reviewed` 均指向同一份首稿，`review.skipped` 标记文本审核已跳过；`data.copy`、`data.imagePlan` 和 `data.generation.model` 也都指向这份首稿。Query 审核拒绝时返回 HTTP `422` 且不保存半成品；联网研究失败时返回 HTTP `502`；同一服务进程已有文案请求执行时返回 HTTP `409`。

`GET /api/copy-generations?page=1&pageSize=20` 按新到旧返回已保存的历史，`pageSize` 最大为 `50`；新增的 `jobs` 字段返回最近最多 20 条仍在生成或已失败的任务。页面刷新或切换板块后会从服务端恢复这些任务，并仅在存在 `RUNNING` 任务时定时刷新；完成后任务自动离开状态区并进入历史记录。每条新记录的 `generation.timing` 包含总耗时以及选题审核、联网研究和首稿生成耗时，文本审核与质检版阶段保持为 0；列表级 `statistics` 基于最近最多 1000 条有效样本返回样本数、平均耗时、P50、P95 和各阶段平均值。升级前的旧记录返回 `timing: null`，不参与统计。调用方如需进入后续生图，应通过任务文案修订接口显式保存确认后的文案。

### 批量生成文案与图片

批量流程拆成两个独立入口。管理员先在 `/batch-copy-generation` 一次输入 2–20 个选题，页面严格按输入顺序调用现有文案接口，只生成并保存文案，不自动调用图片接口。每条成功文案可展开查看完整标题、正文、标签和配图策划；人工质检通过后，确认结果持久化到对应文案记录。重新打开页面会恢复最近 50 条历史中的待质检记录。

随后在 `/batch-image-generation` 选择最近 50 条历史中已人工质检通过的文案，每批最多 20 条，确认预计图片数和真实模型费用后顺序调用图片接口。批量页会显示并刷新真实图片生成历史，每条批次记录从开始时就保留运行 ID，可跳转到单条工作台查看详细进度与结果；一条失败不会阻断后续条目，也可要求系统在当前条完成后停止剩余条目。未人工确认的文案不会进入可选列表；旧 `/batch-generation` 地址会跳转到批量生文。

两个批量入口不改写“单独生成文案”和“单独生成图片”的逻辑，也不创建正式生产任务或自动发布。文案、人工质检结果和图片仍由现有单次接口持久化；当前批次进度由页面持有，刷新后不会自动续跑尚未开始的条目。

## 存储优化与保留策略

同一磁盘上的新生成图片会在 `output/` 与 `data/assets/` 之间使用硬链接，共享一份物理数据；文件系统不支持硬链接时自动回退为独占复制。每次内容生成结束后，Worker 会自动保留当前交付图片、全部人工编辑图片及其父素材、最新尝试的完整文件，以及所有历史尝试的 JSON/Markdown 记录；其他历史尝试图片和未被当前交付或编辑链引用的生成素材会被清理。素材数据库删除会写入 `STORAGE_RETENTION_CLEANUP` 审计记录，清理失败不会把已生成任务改判为失败。

检查现有数据可以释放的空间，默认只预览、不修改文件：

```powershell
npm run storage:optimize
```

确认报告后显式执行：

```powershell
npm run storage:optimize -- --apply
```

## 导出交付包

在“内容审核”打开单条任务。任务进入待审核且当前文案对应的完整图集已经生成后，即可点击“导出交付包”下载 `xhs-task-<ID>.zip`；无需先标记为审核通过。待审核包可用于线下复核，压缩包元数据会保留导出时的真实审核状态。压缩包中包含：

- `content.txt`：标题、正文和标签。
- `metadata.json`：任务、文案修订、图片页序和内容哈希。
- `images/`：当前文案对应的每页最新已验收图片。

## OpenClaw 登录

当前版本可使用：

```powershell
openclaw plugins enable openai
openclaw models auth login --provider openai-codex
```

CLI 版本变化时，以 `openclaw models auth login --help` 和 `openclaw models list` 为准。授权码、设备码、Token 和 API Key 都不应写入本项目或后台表单。

## 验证

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
```

安全边界：Query 和模型输出不会进入 Shell；SQL 参数化；上传图片由 Sharp 解码并限制体积/像素；文件路径限定在受控根目录；API 要求有效会话并按管理员/质检角色授权，写操作还要求严格同源；提示词与审核操作保留版本和审计记录。
