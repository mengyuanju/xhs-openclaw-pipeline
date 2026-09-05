# Codex 执行机部署文档（Windows / PowerShell）

更新日期：2026-09-05。适用于“中心服务器管理任务，Windows 执行机通过 Codex CLI 的 ChatGPT 登录生成文案和图片”的部署方式。

部署基准为标签 [`executor-concurrency-2026-09-05`](https://github.com/mengyuanju/xhs-openclaw-pipeline/tree/executor-concurrency-2026-09-05)，对应提交 `e1b157cf27b780354afe9edfd049afe54019af74`，已推送至 `auto-clow-poker` 分支。本文中的 `C:\xhs`、中心地址和节点名称均为示例，请替换为实际值。命令在 PowerShell 中逐段执行，上一步成功后再继续。

## 1. 部署前准备

**先升级中心服务器，再启动新版执行机。** 只拉取执行机代码无法让旧中心支持批量领取。中心必须包含 `0007`、`0008` 数据库迁移及配套接口，并在 `/health` 返回 `executorConcurrency: true`、`executionRetryControl: true`；升级操作见第 10 节。

| 工具或条件 | 用途与要求 |
| --- | --- |
| Windows + PowerShell | 本文使用 Windows 原生命令，无需 WSL |
| Node.js 和 npm | 项目要求 `>=24.19.0 <25`；本次验证版本为 `24.19.0` |
| Git for Windows | 克隆仓库、获取标签及升级代码 |
| Codex CLI | 本次真实生成验证使用 `0.152.1`，下文固定安装此版本 |
| ChatGPT 账号 | 在执行机上登录，并具备所选模型和图片工具的使用权限 |
| DeepSeek API Key | 下方模板使用 DeepSeek 检索，需要本机提供 Key；文案和生图仍调用 Codex |
| 网络 | 执行机能访问中心 HTTP(S) 地址、Codex 和所选检索服务 |

纯执行机通过中心接口读写任务，不需要安装 PostgreSQL、单独的 SQLite 服务、Docker、OpenClaw、OpenClaw Gateway 或 Codex 桌面应用。Node.js 内置 SQLite，Sharp 随项目依赖安装。只运行执行机也不需要启动本机 Web 后台或执行 `npm run build`。

## 2. 安装工具与项目

### 2.1 Node.js、Git

从 [Node.js 官方下载页](https://nodejs.org/en/download) 选择满足上述范围的 **Node.js 24 Windows 安装包**，按本机架构安装并保留 npm、PATH 选项。复现本次环境可选择 24.19.0。不要直接安装下载页上的其他主版本。

Git 可从 [Git for Windows 官方安装页](https://git-scm.com/install/windows) 下载，也可在已安装 WinGet 的电脑执行官方提供的命令：

```powershell
winget install --id Git.Git -e --source winget
```

安装后重新打开 PowerShell，检查：

```powershell
node --version
npm.cmd --version
git --version
```

后续统一使用 `npm.cmd`、`codex.cmd`，避免 PowerShell 把命令解析到受执行策略限制的 `.ps1` 包装脚本。

### 2.2 安装 Codex CLI

```powershell
npm.cmd install -g @openai/codex@0.152.1
codex.cmd --version
```

期望版本为 `codex-cli 0.152.1`。CLI 的安装包与基本使用方式见 [OpenAI Codex 官方仓库](https://github.com/openai/codex)。升级 CLI 后应重新做真实文案和图片验收，尤其要验证原生图片事件。

### 2.3 获取已验证的项目版本

以下命令用于 **尚不存在 `C:\xhs` 的新电脑**；已有部署请使用第 9 节升级步骤。

```powershell
git clone https://github.com/mengyuanju/xhs-openclaw-pipeline.git C:\xhs
Set-Location C:\xhs
git fetch origin --tags
git switch --detach executor-concurrency-2026-09-05
git rev-parse HEAD
npm.cmd ci
```

提交应为本文开头的 `e1b157cf...`。固定标签部署处于 detached HEAD 状态是正常的，可以准确复现该版本。保留 `package-lock.json`，不要从其他电脑复制 `node_modules`。

## 3. 登录 ChatGPT

使用今后运行执行机的同一个 Windows 用户执行：

```powershell
codex.cmd login
codex.cmd login status
```

完成浏览器登录后，状态必须显示 `Logged in using ChatGPT`。本项目适配器强制使用 ChatGPT 登录，填写 `OPENAI_API_KEY` 不能替代此步骤。登录方式见 [OpenAI 身份验证文档](https://learn.chatgpt.com/docs/auth)。

如果远程电脑的浏览器回调不方便使用，可先在 ChatGPT 个人安全设置或工作区权限中开启设备码登录，再执行：

```powershell
codex.cmd login --device-auth
codex.cmd login status
```

登录凭据由 Codex 管理，可能保存在用户目录或系统凭据存储中。不要把认证文件、订阅令牌或实际 API Key 放入 Git。切换 Windows 用户运行执行机时，需要检查该用户自己的登录状态。

## 4. 配置执行机 `.env`

### 4.1 创建配置

在项目根目录创建或编辑 `.env`，已有文件时保留原配置并逐项修改：

```powershell
Set-Location C:\xhs
if (-not (Test-Path -LiteralPath .env)) {
    New-Item -ItemType File -Path .env | Out-Null
}
notepad.exe .env
```

以下是 **文案任务并发 3、图片任务并发 2** 的完整执行机模板，以 UTF-8 保存。先替换中心地址、节点标识和 DeepSeek Key，再启动。

```dotenv
# 中心服务地址：填写执行机能访问到的地址
CONTROL_PLANE_URL=http://192.168.1.100:4310

# 每台执行机唯一，重启后保持不变
EXECUTOR_NODE_ID=xhs-executor-02
EXECUTOR_NODE_NAME=Codex执行机02
EXECUTOR_WORK_ROOT=data/executor-work
EXECUTOR_POLL_MS=5000

# 执行机任务池
EXECUTOR_COPY_CONCURRENCY=3
EXECUTOR_IMAGE_CONCURRENCY=2
IMAGE_WORKER_ENABLED=true

# 生成引擎及本机共享模型许可
XHS_AGENT_PROVIDER=CODEX
XHS_CODEX_CONCURRENCY=5
XHS_CODEX_IMAGE_CONCURRENCY=2
XHS_TEXT_MODEL=openai/gpt-5.6-sol
XHS_IMAGE_MODEL=openai/gpt-image-2

# OPENCLAW 是兼容字段值：正文使用上面指定的默认生成引擎 CODEX
XHS_COPY_GENERATION_PROVIDER=OPENCLAW

# 文案的联网检索单独使用 DeepSeek
XHS_WEB_SEARCH_PROVIDER=DEEPSEEK
DEEPSEEK_API_KEY=替换为本机实际Key
XHS_DEEPSEEK_SEARCH_MODEL=deepseek-v4-flash
XHS_DEEPSEEK_SEARCH_TIMEOUT_MS=120000
```

### 4.2 并发值的含义

| 配置 | 代码默认值 | 上方示例 | 控制范围 |
| --- | --- | --- | --- |
| `EXECUTOR_COPY_CONCURRENCY` | 1 | 3 | 本节点同时持有并处理的文案执行数 |
| `EXECUTOR_IMAGE_CONCURRENCY` | 1 | 2 | 本节点同时持有并处理的图片执行数；一条任务可以包含多张图 |
| `IMAGE_WORKER_ENABLED` | false | true | 是否领取图片任务；关闭时有效图片容量为 0 |
| `XHS_CODEX_CONCURRENCY` | 2 | 5 | 共享状态库中的 Codex 总调用数，包括文本、审核、图片等 |
| `XHS_CODEX_IMAGE_CONCURRENCY` | 1 | 2 | 上述调用中，生图和改图的并发数 |

四个并发值都要求为 `1–32` 的整数，不能留空；Codex 图片许可不能超过总许可。较保守的配置是任务池 `1/1`、Codex 许可 `2/1`，需要生成图片时仍应开启 `IMAGE_WORKER_ENABLED=true`。

执行机按空闲槽位数领取任务，完成一条后立即尝试补位；空队列或暂时错误按 `EXECUTOR_POLL_MS` 重试。模型调用还需要取得 Codex 许可，因此任务活跃数与实际模型调用数可能不同。上方 `3/2 + 5/2` 是本次小批量测试使用的配置，不代表订阅账号保证此吞吐量。

这些并发值由 **每台执行机的 `.env`** 控制，不在中心“生产配置”页面设置。原有 `XHS_IMAGE_CONCURRENCY` 控制单个任务内部的图片并发，`XHS_TASK_CONCURRENCY` 控制旧本机 drain，两者不能替代分布式任务池配置。

同机执行机、Web、Worker 使用同一 Codex 状态库时，模型许可必须保持一致。默认状态库为当前 Windows 用户的 `.codex/xhs-runtime/limits.sqlite`；自定义 `CODEX_HOME` 时跟随其目录，也可用 `XHS_CODEX_RUNTIME_DB` 指定统一的本地绝对路径。该机制不限制其他电脑或独立 Codex 窗口，不能把 SQLite 放在网络盘上充当跨机锁。修改许可前先等待所有相关调用收尾，再统一配置并重启。

### 4.3 配置优先级与检索选择

中心已发布的 `production.value.modelApi` 中非空字段优先于本机对应环境变量。部署前在后台“生产配置”核对生成引擎为 `CODEX` 或继承环境、文案提供方使用默认生成引擎，并确认文本模型、图片模型和检索提供方。

界面或 JSON 中的文案提供方 `OPENCLAW` 是历史兼容值，表示“使用默认生成引擎”。当 `agentProvider=CODEX` 时，正文调用 Codex；只有引擎本身设置成 `OPENCLAW` 才需要 OpenClaw。若文案提供方显式为 `DOTS`，正文仍调用 Dots。

如果希望检索也走 Codex，可把本机 `XHS_WEB_SEARCH_PROVIDER` 改为 `OPENCLAW`，并让中心对应设置继承环境或同样选择默认引擎；此时不需要 DeepSeek Key。已有执行快照仍保留原设置，后台“从失败步骤继续”不会自动换模型；需要换配置时选择“使用最新配置重新生成”。

`npm run executor` 只加载根目录 `.env`；`agent:check/status/resume` 还加载可选 `.env.local`。为避免诊断和实际运行使用不同配置，把本机执行器配置统一放在 `.env`，检查 `.env.local` 和当前终端环境中是否存在冲突值。相对工作目录按启动位置解析，每次启动前先进入 `C:\xhs`。

### 4.4 可选：Codex 路径与代理

默认安装通常能自动找到原生 `codex.exe`。如果 `codex.cmd --version` 成功但项目提示找不到 Codex，可查找 npm 安装目录：

```powershell
$codexPackages = Join-Path (npm.cmd root -g) '@openai'
Get-ChildItem -LiteralPath $codexPackages -Recurse -Filter codex.exe |
    Select-Object -ExpandProperty FullName
```

把正确架构的实际文件路径写入 `.env` 的 `XHS_CODEX_BIN`。该值必须是原生 `.exe` 的绝对路径，不能填 `codex.cmd` 或 `codex.ps1`。

需要代理时，下面两项填写执行机实际可用的 HTTP(S) 代理；无需代理就不添加：

```dotenv
XHS_MODEL_PROXY_URL=http://127.0.0.1:7890
XHS_IMAGE_PROXY_URL=http://127.0.0.1:7890
```

这里的 `127.0.0.1` 指当前执行机。两项供项目启动的 Codex 子进程使用，不会替你配置直接运行 `codex login` 的网络，也不是 DeepSeek 请求的专用代理配置。中心显式保存的代理字段同样优先。

## 5. 启动前检查

### 5.1 检查中心接口

```powershell
$centerUrl = 'http://192.168.1.100:4310'
Test-NetConnection -ComputerName 192.168.1.100 -Port 4310
$centerHealth = Invoke-RestMethod -Uri "$centerUrl/health"
$centerHealth | ConvertTo-Json -Depth 5
if (-not $centerHealth.ok -or
    -not $centerHealth.capabilities.executorConcurrency -or
    -not $centerHealth.capabilities.executionRetryControl) {
    throw '中心未就绪或版本不兼容，请先升级并重启中心。'
}
```

地址与端口应和 `.env` 一致；如果使用 HTTPS 反向代理，按实际主机和端口检查。断点续跑还需要中心返回 `capabilities.imageResume: true`。中心端口可达不等于模型网络可用。

### 5.2 检查登录及本机暂停状态

```powershell
Set-Location C:\xhs
npm.cmd run agent:check
npm.cmd run agent:status
```

确认 `authentication` 为 `chatgpt`、`version` 为目标 CLI 版本，并检查 `runtime.code` 是否存在暂停或冷却。`imageCapability: requires-live-verification` 是正常提示：这些命令不调用真实模型，不能证明图片权限、剩余额度或生成速度。异常处理见第 8 节。

## 6. 启动与真实验收

### 6.1 启动常驻执行机

```powershell
Set-Location C:\xhs
npm.cmd run executor
```

使用上方模板时，启动成功会输出：

```text
Executor xhs-executor-02 is ready; copy concurrency: 3; image concurrency: 2.
```

任务结束时会输出类似 `COPY task 123: SUCCEEDED` 的结果。在中心后台确认节点在线、文案容量为 3、图片容量为 2。一个节点 ID 同时只运行一个执行机进程；多台电脑各用自己的节点 ID。

该命令会持续领取真实任务，PowerShell 窗口需要保持运行。项目自动启动每次所需的 Codex 子进程，管理员不需要另外手动启动 `codex app-server`。本文采用前台运行，不额外配置开机任务或服务。

### 6.2 其他启动方式

以下命令按需选一个执行：

```powershell
# 只领取文案任务；命令行开关覆盖 .env 的图片开关
npm.cmd run executor -- --disable-image-worker

# 显式开启图片领取
npm.cmd run executor -- --enable-image-worker

# 本次每种启用类型最多尝试一条，处理完退出
npm.cmd run executor -- --once

# 本次最多尝试一条文案，处理完退出
npm.cmd run executor -- --once --disable-image-worker
```

`--once` 会领取和执行真实任务，不是空跑检查；图片开启时可能同时执行一条文案和一条图片任务。它不能验证 `3/2` 满并发，也不保证领到刚创建的某一任务。

### 6.3 真实模型验收步骤

1. 在中心后台创建一条测试需求，把文案执行节点指定为这台电脑；检查文案生成、审核、检索记录及实际模型。
2. 文案通过人工审核后提交生图，查看执行记录确认由目标执行机处理。图片任务来自共享池，有其他生图节点在线时可能被其他节点领取。
3. 检查生成图片、任务耗时、失败阶段与重试记录；确认有原生图片证据和可读 PNG，再验收改图及失败步骤续跑。
4. 需要测并发时准备足够的待执行任务，以常驻方式观察文案最多 3 条、图片最多 2 条，任务完成后能补位，同时记录排队、模型调用和质量修复耗时。

以上会消耗真实模型及检索额度。既有测试过程与耗时见 [真实模型测试记录](executor-concurrency-live-results.md)。小批量成功不等于长期吞吐保证，质量审核后的修复调用也会计入任务耗时。

**中心尚未升级时的本机测试：** 可使用现有基准脚本，在本机临时中心测试新版链路。此方式额外需要本机 PostgreSQL 可执行程序和 `server` 依赖，普通执行机部署不需要它们。

```powershell
Set-Location C:\xhs
npm.cmd --prefix server ci
$env:TEST_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
node --env-file-if-exists=.env scripts/benchmark-executor.mjs --live
```

`TEST_POSTGRES_BIN` 替换为实际安装目录。脚本只读获取已配置中心的已发布设置、提示词与知识，任务写入和生成结果上传在自动创建的本机临时中心完成。它使用真实模型，结束后保留 `.codex_artifacts/executor-benchmark/` 中的耗时、日志和图片。先停止共享 Codex 状态库的其他模型调用，避免许可冲突。参数和数据边界见 [并发测试说明](executor-concurrency.md)。

## 7. 停止与日常检查

在执行机窗口按一次 **Ctrl+C**，停止补领并等待在途任务、请求与回报收尾，进程退出后再更新代码或重启。网络中断可能延长等待，不要通过删除工作目录来催促退出。

```powershell
# 另开一个 PowerShell 窗口检查共享许可和暂停状态
Set-Location C:\xhs
npm.cmd run agent:status
```

中心后台用于查看节点在线状态、任务步骤、执行错误和结果。执行机每 15 秒发送心跳；暂停领取不等于进程离线。若进程崩溃后中心仍有 `RUNNING` 执行，按后台现有人工恢复流程处理。

保留 `.env`、Codex 登录和共享状态库，以及 `data/executor-work/<任务ID>/` 下仍需恢复的检查点。生图失败后的续跑可能依赖原节点与这些文件。中心数据库和资产由中心服务器独立备份。

## 8. 常见问题与恢复命令

| 现象 | 处理 |
| --- | --- |
| `node:sqlite` 不可用或 Node 版本检查失败 | 安装满足 `>=24.19.0 <25` 的 Node.js，重新打开终端并检查版本 |
| `npm.ps1` / `codex.ps1` 被执行策略阻止 | 使用本文的 `npm.cmd` / `codex.cmd` |
| `Codex executable not found` | 按第 4.4 节找到原生 `.exe`，设置 `XHS_CODEX_BIN` |
| 登录检查不显示 ChatGPT | 以运行执行机的用户执行 `codex.cmd login`，再次检查状态 |
| 缺少 `executorConcurrency` / `executionRetryControl` | 升级完整中心代码、迁移数据库并重启中心；不能仅修改执行机配置绕过 |
| 节点在线但不领文案 | 检查任务指定节点是否匹配、队列是否有可执行任务、本机暂停状态及中心遗留的 `RUNNING` 记录 |
| 图片容量显示 0 | 检查 `IMAGE_WORKER_ENABLED=true`，以及启动命令是否带了关闭图片的参数 |
| 配置了 3/2，实际模型调用仍少 | 检查 Codex 许可、同机其他调用、任务所处阶段；池容量不代表每条任务始终占用模型 |
| `CODEX_CONCURRENCY_MISMATCH` | 等同机旧调用收尾，将所有相关进程的 Codex 两项许可统一后重启 |
| 429 / 冷却 | 查看 `agent:status` 的 `retryAt`，等待冷却；项目通常共享冷却约 60–65 秒，持续发生时降低并发 |
| 登录或订阅额度导致暂停 | 先解决登录或额度问题，再执行下面的恢复步骤 |
| 图片失败但没有自动重试 | Codex 图片失败默认交由人工处理；查看执行错误与检查点，再在后台选择续跑 |
| 图片已生成却提示缺少原生事件 | 核对 CLI 版本及完整代码；本版本图片通过 `app-server --stdio` 读取原生事件，保留日志排查，不能以回答中的路径替代证据 |
| 修改 `.env` 后仍使用原模型 | 检查中心显式配置、旧执行快照以及终端环境覆盖；更新后重启执行机 |

解决认证或额度问题后：

```powershell
Set-Location C:\xhs
# 仅登录失效时需要重新登录
codex.cmd login
npm.cmd run agent:check
# 确认问题已解决后，清除本项目记录的本机暂停
npm.cmd run agent:resume
npm.cmd run agent:status
```

`agent:resume` 不增加订阅额度、不绕过限制，也不会自动重排失败任务。执行机若已退出，重新运行 `npm.cmd run executor`；仍在运行则不要重复启动。失败业务任务在后台人工选择续跑。不要删除 `limits.sqlite` 或认证文件来绕过暂停。

## 9. 后续更新与回退

先停止执行机并等待退出，保留本机配置和检查点。若更新涉及中心接口或迁移，继续遵守“中心先更新，执行机后更新”。

固定标签部署更新时：

```powershell
Set-Location C:\xhs
git status --short
git fetch origin --tags
# 将下面的值替换为已确认的新版本标签
$executorRelease = '替换为已确认的新标签'
git switch --detach $executorRelease
npm.cmd ci
npm.cmd run agent:check
```

`git status` 若有本地修改，先核对并保留再切版本；任何命令失败都应停止后续步骤。重新检查中心健康，再启动执行机并做小规模验收。

如果部署约定为持续跟随当前开发分支，可在保存本地修改、停止执行机后使用以下命令替代切标签：

```powershell
git switch auto-clow-poker
git pull --ff-only origin auto-clow-poker
npm.cmd ci
npm.cmd run agent:check
```

回退应用版本同样先停止执行机，选择与中心契约兼容且已验证的标签。中心已经应用的迁移保留原文件及数据，不删除迁移、不修改迁移校验和。切换旧引擎的条件见 [Codex 迁移与回切说明](codex-exec-migration.md)。

## 10. 中心服务器升级操作（仅在中心主机执行）

如果中心仍是旧代码，安排停止旧执行机并等待收尾，再停止中心进程。保留中心的 `server/.env`、数据库和文件资产，先完成现有备份流程。数据库备份命令为 `npm.cmd --prefix server run db:export`，需要 PostgreSQL 的 `pg_dump` / `pg_restore`；它不包含图片资产，中心资产目录要单独备份。详见 [仓库中的中心备份说明](../README.md)。

将中心代码更新到本文标签或兼容的新版本后，在 **中心主机的项目根目录** 执行：

```powershell
npm.cmd --prefix server ci
# 读取 server/.env，预览待执行迁移
npm.cmd --prefix server run db:upgrade
# 核对目标数据库和预览结果后应用
npm.cmd --prefix server run db:upgrade -- --apply
```

预览确认后才执行 `--apply`。这是已有数据库的结构升级，不要使用面向空库恢复的 `db:init`。本次必须包含 `0007_executor_concurrency.sql`、`0008_claim_receipt_retention.sql` 及之前尚未应用的迁移。

按中心原有运行方式重启服务；若原本使用前台 PowerShell，可执行：

```powershell
npm.cmd --prefix server start
```

最后从执行机重新检查第 5.1 节的 `/health` 能力，确认通过后再启动新版执行机。已有服务管理器管理中心时，使用原管理器重启，避免重复启动实例。
