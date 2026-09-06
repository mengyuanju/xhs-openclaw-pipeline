# Windows 执行机部署指南

整理日期：2026-09-05。适用场景：在另一台 Windows 电脑部署执行代理，连接已经运行的中心服务。示例项目目录为 `C:\xhs`，示例中心地址为 `http://192.168.1.100:4310`；请替换为实际地址。

## 1. 先确认部署的代码版本

本文保留历史 OpenClaw 部署路径，并按当前包含 Codex 适配器与执行机并发队列的版本更新。不要把历史提交的引擎能力当作当前版本的能力。

| 项目版本 | 执行引擎 | 安装与检查方式 |
| --- | --- | --- |
| 历史提交 `f2070c6` | OpenClaw | 按第 4.1 节安装；该历史版本没有 `agent:check`、`agent:status`、`agent:resume` 脚本 |
| 当前 Codex 集成及并发版本 | Codex CLI，可回切 OpenClaw | 按第 4.2 节安装；提供 Codex 诊断脚本及文案/图片并发配置 |

当前执行器通过 `src/agent-client.mjs` 选择引擎，默认使用 Codex CLI 的 ChatGPT 登录。历史 OpenClaw 版本只安装 Codex 或增加环境变量不能获得适配器功能，必须更新完整代码。当前并发版本还要求中心先更新 `0007`、`0008` 迁移与批量领取 API，见 [执行机并发配置](executor-concurrency.md)。

部署前，在准备复制的源码目录检查：

```powershell
npm.cmd run
```

如果使用 Git，再记录代码版本：

```powershell
git branch --show-current
git rev-parse --short HEAD
```

Codex 集成版本至少应包含 `src/agent-client.mjs`、`src/codex.mjs`、`scripts/agent-runtime.mjs`，并在 `package.json` 中提供 `agent:check` 等脚本。目标电脑应使用与中心接口兼容、已经验收的完整版本。

## 2. 需要安装什么

| 项目 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js 与 npm | 必需 | 项目要求 `>=24.19.0 <25`；可与本机保持一致，使用 Node.js 24.19.0 |
| 项目源码和依赖 | 必需 | 保留 `package-lock.json`，在目标电脑执行 `npm.cmd ci` |
| OpenClaw | OpenClaw 版本必需 | 当前 README 的集成基线为 2026.8.2，需在执行机完成模型授权 |
| Codex CLI | Codex 集成版本必需 | 此前本机登录和版本预检使用 0.152.1；需在执行机完成 ChatGPT 登录 |
| DeepSeek Key | 选择 DeepSeek 搜索时必需 | 由每台执行文案任务的电脑本地提供，中心不会下发密钥 |
| Dots Key | 选择 Dots 文案时必需 | 配置 `XHS_DOTS_API_KEY`，并确认中心的文案提供方设置 |
| Git | 可选 | 用于获取和更新源码；也可使用可信的源码压缩包 |
| 本机 Web 后台 | 可选 | 仅需要在新电脑运行操作界面时安装配置，见第 8 节 |

纯执行机不需要单独安装 PostgreSQL、SQLite 服务、Docker 或 Codex 桌面应用；SQLite 和 Sharp 由 Node.js／项目依赖提供。当前云端模型调用方案不要求独显或下载本地模型权重。

网络需要能访问中心服务，以及实际选用的模型和搜索服务。当前中心采用可信内网 HTTP，执行机不直连 PostgreSQL；中心的 4310 端口应仅对预期内网设备开放。

## 3. 准备项目目录

安装符合要求的 Node.js 后，重新打开 PowerShell：

```powershell
node --version
npm.cmd --version
```

通过 Git 或源码包，将选定版本放到 `C:\xhs`。复制源码时，保留项目代码、`package.json`、`package-lock.json`、提示词和配置模板，跳过以下运行数据：

- `node_modules`、`.next`：在目标电脑重新安装／构建。
- `data`、`output`、`outputs`、`data-bak`、`.codex_artifacts`：新节点不需要旧机器的业务数据和调试产物。
- `server/backups`、`server/server-storage`：属于中心备份或文件存储。
- `.env`、`.env.local` 和模型认证文件：由目标电脑单独配置。

执行：

```powershell
cd C:\xhs
npm.cmd ci
```

本指南默认部署新节点；如果是迁移原节点并继续失败任务，需要另行保留原节点 ID 和对应检查点，不能按新节点方式丢弃工作目录。

## 4. 安装生成引擎

按第 1 节确认的项目版本选择一个方案。

### 4.1 OpenClaw 回退或历史版本

使用当前项目 README 的版本基线安装：

```powershell
npm.cmd install -g openclaw@2026.8.2 --allow-scripts=openclaw
openclaw.cmd --version
openclaw.cmd onboard
```

`--allow-scripts` 适用于 npm 11.16 及以上；更早的 npm 不支持该参数。安装方式和平台说明见 [OpenClaw 官方安装文档](https://docs.openclaw.ai/install)。

在向导中完成本机配置和模型授权。首次联调采用前台运行方式，按向导启动 Gateway；具体界面随 CLI 版本变化。需要常驻服务时另行配置，不把执行代理自动启动和 Gateway 安装混为一件事。参见 [OpenClaw 入门说明](https://docs.openclaw.ai/start/getting-started)。

当前项目 README 给出的 OpenAI/Codex 授权入口为：

```powershell
openclaw.cmd plugins enable openai
openclaw.cmd models auth login --provider openai-codex
```

如果对应 CLI 不接受参数，先查看 `openclaw.cmd models auth login --help`，按已安装版本的授权入口操作。

完成后检查：

```powershell
openclaw.cmd models status --check --json
openclaw.cmd models list
openclaw.cmd gateway status
```

模型状态和 Gateway 状态只证明各自的连接或配置情况；正式上线前还要按第 7 节完成实际任务验收。

### 4.2 Codex 集成版本：Codex CLI

本节适用于包含 Codex 适配器的项目版本。本机使用 CLI 0.152.1 完成了登录检查及真实文案、生图和改图测试；具体成功率、耗时与边界见 [真实测试报告](executor-concurrency-live-results.md)。其他电脑仍需使用自己的环境完成验收。

```powershell
npm.cmd install -g @openai/codex@0.152.1
codex.cmd --version
codex.cmd login
codex.cmd login status
```

使用具有所需模型权限的 ChatGPT 账号完成浏览器登录。登录和运行执行器应使用同一个 Windows 用户；不要复制另一人的认证文件。官方命令和登录方式见 [OpenAI 身份验证说明](https://learn.chatgpt.com/docs/auth)。

该项目的 Codex 适配器要求 ChatGPT 登录，不能用单独填写 `OPENAI_API_KEY` 替代这个登录检查。

如果 `codex.cmd` 能运行，但项目提示找不到原生可执行文件，可在全局 npm 安装目录查找：

```powershell
$codexPackages = Join-Path (npm.cmd root -g) '@openai'
Get-ChildItem -LiteralPath $codexPackages -Recurse -Filter codex.exe |
    Select-Object -ExpandProperty FullName
```

将实际安装中正确架构的 `codex.exe` 绝对路径填入 `.env` 的 `XHS_CODEX_BIN`。该字段不能填 `codex.cmd` 或 `codex.ps1`。

## 5. 配置执行机 `.env`

在 `C:\xhs` 新建名为 `.env` 的 UTF-8 文本文件，注意不要保存成 `.env.txt`。以下中心 IP、节点标识和密钥必须按实际情况填写。

```dotenv
CONTROL_PLANE_URL=http://192.168.1.100:4310
EXECUTOR_NODE_ID=xhs-executor-02
EXECUTOR_NODE_NAME=执行机02
EXECUTOR_COPY_CONCURRENCY=1
EXECUTOR_IMAGE_CONCURRENCY=1
EXECUTOR_POLL_MS=5000
EXECUTOR_WORK_ROOT=data/executor-work
IMAGE_WORKER_ENABLED=false

XHS_COPY_GENERATION_PROVIDER=OPENCLAW

# 本示例显式选择 DeepSeek 搜索；不是对所有项目版本默认值的声明。
XHS_WEB_SEARCH_PROVIDER=DEEPSEEK
DEEPSEEK_API_KEY=替换为本机实际使用的Key
XHS_DEEPSEEK_SEARCH_MODEL=deepseek-v4-flash
XHS_DEEPSEEK_SEARCH_TIMEOUT_MS=120000
```

仅在使用 Codex 集成版本时，追加：

```dotenv
XHS_AGENT_PROVIDER=CODEX
XHS_CODEX_CONCURRENCY=2
XHS_CODEX_IMAGE_CONCURRENCY=1
```

配置规则：

1. 每台机器的 `EXECUTOR_NODE_ID` 必须唯一，重启后保持不变，例如 `xhs-executor-02`、`xhs-executor-03`。
2. 当前版本的 `XHS_COPY_GENERATION_PROVIDER=OPENCLAW` 是兼容值，实际生成引擎由 `agentProvider` 决定；缺省为 Codex。
3. 中心保存的生产配置优先于本机环境默认值。核对文案、搜索、模型和生成引擎；新配置不会改写已领取任务的旧快照。
4. 选择 Dots 时补充本机 `XHS_DOTS_API_KEY`，以及与中心配置一致的地址和模型。选择 DeepSeek 时必须提供本机 `DEEPSEEK_API_KEY`。
5. `npm run executor` 自动加载根目录 `.env`，不自动加载 `.env.local`。执行器所需配置放在 `.env` 或进程环境中；修改后重启执行器。
6. `EXECUTOR_WORK_ROOT` 相对路径按启动时的当前目录解析，因此每次先进入 `C:\xhs`。也可以配置稳定的本地绝对路径。

如果需要模型代理，可按实际网络追加 `XHS_MODEL_PROXY_URL` 和 `XHS_IMAGE_PROXY_URL`。其中 `127.0.0.1` 指新执行机自己，不能照搬旧电脑不存在的代理端口。DeepSeek 请求使用独立的 HTTPS 客户端，不使用这两个模型子进程代理字段。

## 6. 预检：连接与本地测试

先确认中心机器运行了兼容版本的服务，并允许新执行机访问 4310 端口。替换 IP 后执行：

```powershell
Test-NetConnection 192.168.1.100 -Port 4310
$centerHealth = Invoke-RestMethod http://192.168.1.100:4310/health
$centerHealth | ConvertTo-Json -Depth 5
```

应看到 TCP 连接成功，且健康检查 `ok` 为 `true`。不要将中心地址写成新执行机的 `127.0.0.1`。

当前并发版本要求中心返回 `capabilities.executorConcurrency: true`，Codex 还要求 `capabilities.executionRetryControl: true`；缺少时应先更新并重启中心服务。需要断点续跑时，也要确认中心具备对应的 `imageResume` 能力。

执行本地无模型额度测试：

```powershell
cd C:\xhs
npm.cmd test
npm.cmd run smoke
```

Codex 集成版本额外执行：

```powershell
npm.cmd run agent:check
npm.cmd run agent:status
```

`agent:check` 应通过本机 ChatGPT 登录检查，状态检查没有待处理的认证／额度暂停。历史 `f2070c6` 没有这些脚本，使用第 4.1 节的 OpenClaw 检查。

`smoke` 使用独立的 `data/smoke.sqlite` 和 `output/smoke`，生成明确标为 mock 的文案、PNG 和 manifest。Mock QC 的 `mock_only`／占位图不可发布属于预期结果；该测试不证明真实模型、中心任务流或账号额度可用。

此前本机会话的 758 项测试通过记录属于当时的代码版本，不应作为另一台机器或当前不同提交的验收结果。

## 7. 启动与真实任务验收

### 7.1 启动执行器

只处理分配给本机的文案任务：

```powershell
cd C:\xhs
npm.cmd run executor -- --disable-image-worker
```

或同时开启文案通道和全局图片通道：

```powershell
cd C:\xhs
npm.cmd run executor -- --enable-image-worker
```

两种命令选其一。命令行开关优先于 `.env` 的 `IMAGE_WORKER_ENABLED`，不要为同一个节点重复启动两个执行器。开启图片通道后，空闲时会领取符合条件的全局图片任务，并不限于本机生成文案的任务。

看到 `is ready and connected` 后，在现有 Web 后台查看节点是否在线。执行器约每 15 秒上报在线状态，中心以最近约 90 秒活动判断在线。它需要持续运行，空队列时会轮询等待。

启动执行器后会实际领取任务并调用模型。`--once` 同样可能执行真实任务，它不是只读预检或 mock 开关。

### 7.2 验收一个完整任务

1. 在现有后台创建一条测试 Query，明确选择新节点。
2. 确认新节点领取文案，执行阶段持续更新，结果保存到中心并进入人工文案审核。
3. 核对文案、研究来源、图片规划与实际模型记录，然后审核通过指定文案版本。
4. 图片任务进入全局队列，由具备图片能力的空闲节点领取；如果要验证新节点生图，需安排测试时的图片队列和节点分工，并核对实际执行节点。
5. 核对逐页生图、图文验收、文件上传和最终结果保存，确认进入图文审核且图片能够打开。
6. 有失败时检查准确阶段与错误，必要时验证“从失败步骤继续”能复用已经保存的检查点。

保留测试任务 ID、文案／图片执行节点、最终状态和异常记录。节点上线与登录预检通过，均不能代替真实文案和图片验收。

## 8. 可选：在新电脑部署 Web 后台

如果继续使用现有后台操作任务，可以跳过本节。纯执行器无需生成管理员密码或运行 Next.js。

需要本机操作界面时：

```powershell
cd C:\xhs
npm.cmd run auth:setup
npm.cmd run typecheck
npm.cmd run build
npm.cmd start
```

`auth:setup` 会在 `.env` 中写入管理员密码哈希和会话密钥，并保留其他设置。打开 [本机 Web 后台](http://127.0.0.1:3001)，使用刚设置的账号入口登录。启动 Web 不会自动启动执行器，执行器需要另一个终端。

如需可信局域网设备访问，将启动命令改为 `npm.cmd run start:lan`，并按实际网络设置该电脑的 3001 端口访问范围。4310 是中心服务端口，3001 是可选 Web 后台端口，两者用途不同。

## 9. 日常运行、更新与恢复

- 保持执行机联网、接通电源并避免自动休眠。前台终端关闭后不会继续承担执行任务；自动启动服务或计划任务需要单独安排。
- 停止时按 `Ctrl+C`。程序收到停止信号后会停止后续轮询，在途任务可能继续完成；确认旧进程退出后再启动新版本。
- 更新前记录版本并保留 `.env` 和 `data/executor-work`。若涉及中心协议升级，先更新并重启中心，再更新执行器、执行 `npm.cmd ci` 和预检，最后重新上线。
- 新增节点使用新 ID；原节点重启／升级继续使用原 ID。不要同时运行两个共享同一 ID 的实例。
- 图片失败时保留 `data/executor-work/<task-id>`。断点续跑可能绑定原节点和原快照；缺失检查点时不能承诺旧图不重画。
- 需要改文案、提示词或模型配置时，使用后台明确提供的“使用最新配置重新生成”；“从失败步骤继续”保留原快照语义。

当前任务池的文案/图片默认容量为 1/1；Codex 同机共享状态库默认总调用 2、图片调用 1。四个并发配置都允许 1–32，图片模型许可不超过总许可；修改后统一重启使用该状态库的进程。示例文案 3、图片 2 可配置任务池 3/2、Codex 许可 5/2，见 [并发配置说明](executor-concurrency.md)。这个限制不跨电脑；同一个账号增加电脑不会增加账号额度。不要将 SQLite 状态库放在网络共享盘充当多机锁。

Codex 登录或额度问题解决后，可执行：

```powershell
npm.cmd run agent:check
npm.cmd run agent:resume
```

`agent:resume` 仅清除项目的本地暂停，不补充额度，也不自动重新提交失败任务。

## 10. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| `Missing script: agent:check` | 当前代码不含 Codex 集成；核对第 1 节，使用匹配版本的部署路径 |
| 提示找不到 `node`、`npm.cmd` 或引擎 CLI | 检查安装和 PATH，重新打开终端；Node 必须满足项目版本约束 |
| PowerShell 拒绝执行 `npm.ps1` | 使用文档中的 `npm.cmd`；npm 安装的 CLI 同理可使用 `.cmd` 启动器 |
| `CONTROL_PLANE_URL` 或节点 ID 缺失 | 确认在项目根目录启动，文件确实叫 `.env`，字段不为空 |
| 中心连接失败 | 检查中心 IP、服务状态、监听地址和内网防火墙；先看 TCP 和 `/health` 检查结果 |
| 节点在线但任务失败 | 当前 OpenClaw 执行器上线检查不证明模型可用；检查本机授权、Gateway、配置模型和实际失败阶段 |
| 配置了 Key 仍提示缺失 | 检查是否只写在 `.env.local`、是否写在中心而非执行机，以及进程是否已重启 |
| 修改 `.env` 后提供方未改变 | 检查中心保存的生产配置，以及任务是否仍使用旧快照 |
| Codex CLI 可运行，项目仍找不到它 | 按第 4.2 节设置真实 `codex.exe` 的绝对路径 |
| 执行器拒绝启动并提示 `executorConcurrency` 或 `executionRetryControl` | 中心缺少批量领取或失败重试控制能力，先升级并重启中心 |
| 开启生图后未领取测试任务 | 核对图片开关、人工文案审核状态、全局队列，以及是否被其他在线图片节点领取 |
| 失败步骤继续提示缺少检查点 | 检查原节点、稳定工作目录和对应任务文件；不要先删除工作目录再尝试恢复 |

## 11. 交接检查表

- [ ] 已记录部署源码版本，并确认使用 OpenClaw 或 Codex 对应的完整实现。
- [ ] Node.js 满足版本范围，项目依赖安装成功。
- [ ] 目标 Windows 用户已完成模型登录和配置。
- [ ] `.env` 的中心地址、唯一节点 ID、工作目录和图片开关正确。
- [ ] 所选搜索／文案服务需要的密钥已在执行机本地配置。
- [ ] 中心健康检查、本地测试和 mock smoke 已通过。
- [ ] 新节点在线，实际测试任务的文案、图片节点记录符合预期。
- [ ] 已完成至少一条真实任务的文案、审核、生图、上传和图文审核验证。
- [ ] 已说明停机、升级、检查点保留与失败恢复方式。

## 12. 依据与关联资料

当前代码依据：[项目命令](../package.json)、[执行器 CLI](../src/executor/cli.mjs)、[执行器实现](../src/executor/agent.mjs)、[配置模板](../.env.example)。

项目说明：[README](../README.md)、[分布式控制中心](distributed-control-plane.md)、[图片断点恢复](image-resume-spec.md)、[Codex 迁移与验收](codex-exec-migration.md)、[执行机并发配置](executor-concurrency.md)。

官方说明：[OpenClaw 安装](https://docs.openclaw.ai/install)、[OpenClaw 入门](https://docs.openclaw.ai/start/getting-started)、[Codex CLI](https://learn.chatgpt.com/zh-Hans/docs/codex/cli)、[OpenAI 身份验证](https://learn.chatgpt.com/docs/auth)。工具版本和官方默认安装方式可能变化；项目兼容版本以部署源码和实际验收为准。
