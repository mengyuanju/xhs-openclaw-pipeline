# 小红书内容工场（Codex）

通过当前创作工作台批量提交 Query，由中心服务调度执行机完成文案、人工审核、生图与资源下载。生成引擎使用 Codex CLI；文案正文可选择 Dots，联网研究可选择 DeepSeek。系统不自动发布到小红书。

2026-09-09 已参考远程 `dev_xhs` 清理移除 OpenClaw 执行器及旧 Web 的导入、独立生成、批量生成、任务审核、统计、追踪页面和专属 API。首页统一进入 `/workbench/personal`。历史配置中的 `OPENCLAW` 在读取时归一为 `CODEX`，不会调用旧引擎；历史执行来源记录和业务数据保持原样。

## 当前功能与数据流

- `/workbench/*`：个人任务、待审核派单、文案审核、生图、图文审核与归档；保留批量操作、重试、断点恢复、执行证据和资源下载。
- `/query-packages`、`/copy-qa`、`/delivery-pool`：Query 词包筛选后自动进入文案生成、文案抽检和最终交付；创建作业时的词包名称作为任务快照保留，可用于下游列表搜索、按词包导出，以及由管理员按 10–200 条操作上限批量创建独立预览。预览 noteId 关联冻结交付条目，不与本地主键混用；独立盲评不暴露来源。
- `/workbench-statistics`：个人与管理员作业效率统计。
- `/prompts`：提示词版本、发布与回滚。任务使用冻结的执行快照，全局修改不会污染在途任务。
- `/knowledge`：文案知识分析与发布；保留视觉知识及素材能力。
- `/settings`：生产参数、布局模板、人工作业评分、文案提供方、联网搜索、模型及并发配置。
- `/executors`、`/users`、`/profile`：执行机状态、用户管理与个人信息。

普通 Query 进入全局文案队列时不预先绑定执行机或人工负责人，执行机按容量领取；文案生成完成后，系统才按自动派单池或管理员选择分配审核负责人。显式跳过文案审核的任务必须在创建时指定普通作业员或当前管理员。需要人工审核时，机器原稿只有 `3` 分可在不修改文案的情况下确认通过；`2` 分或 `2.5` 分必须实际修改标题、正文或标签，人工确认达标后系统把最终稿记录为 `3` 分。普通生产批次可能先进入文案抽检；抽检或图文终审打回的返工稿必须提交强制复检，提交本身不会立即开始生图。只有无需抽检、普通抽检完成或强制复检通过后，任务才进入待生图队列。图片审核仍允许 `2.5` 分或 `3` 分通过。只有启用图片能力的执行机可以领取待生图任务；人工重试产生新的执行代次，旧执行不能覆盖新结果。

当前 Codex 图片执行失败时上报 `autoRetry:false`，进入 `IMAGE_FAILED`，由人工检查后从失败步骤继续。已验收图片不重画，上传失败仅补传；检查点缺失时明确报错。保留原节点 ID 和 `data/executor-work/<task-id>/`，详见 [生图断点恢复](docs/image-resume-spec.md)。中心仍保留其他调用方使用的有限自动重试协议。

## SQLite 和中心数据库

| 存储 | 用途 | 当前是否需要 |
| --- | --- | --- |
| 中心 PostgreSQL + 中心文件目录 | 任务、执行记录、提示词版本、知识库、生产配置、用户及图片资产 | 当前分布式系统的业务真源 |
| 本地 `data/queue.db`（Web 使用 `XHS_DB_PATH`，CLI 使用 `XHS_DATABASE_PATH` 覆盖） | 无 `CONTROL_PLANE_URL` 时提示词、知识库、生产配置的本地分支，以及保留的 CLI 队列和历史数据迁移 | 中心模式下这三项不读取它；本次保留本地分支与文件 |
| `CODEX_HOME/xhs-runtime/limits.sqlite` | 同机跨进程调用许可、额度/认证暂停和冷却状态 | Codex 执行需要，与业务 SQLite 无关 |

本地业务库不是中心缓存，不会自动同步。配置了中心地址但中心不可用时不会自动切回本地；只有未配置中心地址才选择本地分支。当前网页登录仍需要中心账户服务，本地分支不等于完整的离线 Web 模式。

如果后续取消本地业务模式，应先核对待迁移数据，再移除对应读写分支；不能连同 Codex 的运行状态库一起删除。已有 SQLite 的提示词、知识和生产配置可通过一次性脚本追加到中心：

```powershell
npm run control-plane:migrate-local
# 核对预览及目标后执行；重复执行会追加重复版本：
npm run control-plane:migrate-local -- --apply
```

## 安装与启动

使用 Node.js `>=24.19.0 <25`。执行机需要已完成 ChatGPT 登录的 Codex CLI。安装及检查步骤见 [Windows 执行机部署](docs/windows-executor-deployment.md) 和 [Codex 迁移与验收](docs/codex-exec-migration.md)。

中心机器不需要安装 Codex，也不保存模型密钥。中心使用独立的 `server/` 包、PostgreSQL 和服务端文件目录：

```powershell
npm --prefix server ci
# 配置 server/.env，先预览数据库升级，再执行：
npm run server:db:upgrade
npm run server:db:upgrade -- --apply
npm --prefix server start
```

中心部署、数据库导出和增量升级详见 [分布式中心服务](docs/distributed-control-plane.md)。保留备份，不直接覆盖已有数据库。

界面和执行机在项目根目录安装依赖。将 `.env.example` 复制为本机配置，设置 `CONTROL_PLANE_URL`、`EXECUTOR_NODE_ID` 和会话密钥。不要提交凭据。

```powershell
npm ci
npm run auth:setup
npm run dev
```

默认打开 `http://127.0.0.1:3001`。登录由中心账户服务验证，初始管理员需按界面提示修改密码。

```powershell
npm run build
npm start
# 如需监听可信局域网：
npm run start:lan
```

执行机使用 `.env` 中的中心地址及稳定节点 ID，先完成预检：

```powershell
npm run agent:check
npm run agent:status
# 仅领取文案任务：
npm run executor -- --disable-image-worker
# 领取文案及图片任务：
npm run executor -- --enable-image-worker
```

同机 Codex 默认总调用许可为 2、图片许可为 1；任务池容量和模型许可分别控制。详细配置见 [执行机并发](docs/executor-concurrency.md)。认证或额度失败会暂停新任务，解决原因后使用 `npm run agent:resume` 清除暂停。预检不消耗模型额度，也不能证明实际生成成功或持续吞吐量。

## 提供方与配置

生成引擎固定 `CODEX`。`XHS_COPY_GENERATION_PROVIDER` 支持 `CODEX`、`DOTS`；`XHS_WEB_SEARCH_PROVIDER` 支持 `CODEX`、`DEEPSEEK`，默认 DeepSeek Flash。文案和搜索的切换相互独立。

生产配置中保存的非空值优先于执行机环境变量，`null` 表示继承环境或默认值。中心配置进入后续执行快照，已领取任务使用原快照。页面搜索面板只修改搜索字段，保留其他生产参数。Key 由实际调用服务的主机提供，不保存到配置 JSON。

```dotenv
XHS_AGENT_PROVIDER=CODEX
XHS_COPY_GENERATION_PROVIDER=CODEX
XHS_WEB_SEARCH_PROVIDER=DEEPSEEK
XHS_DEEPSEEK_SEARCH_MODEL=deepseek-v4-pro
XHS_DEEPSEEK_SEARCH_TIMEOUT_MS=120000
DEEPSEEK_API_KEY=
```

Dots 使用 `XHS_DOTS_API_KEY`、`XHS_DOTS_BASE_URL`、`XHS_DOTS_MODEL`。Codex 模型和代理变量见 `.env.example`。模型调用使用参数数组、`shell:false`，模型输出和外部 Query 始终作为不可信输入验证。

DeepSeek 搜索模型不使用版本白名单：生产配置或 `XHS_DEEPSEEK_SEARCH_MODEL` 可填写任意符合安全格式的模型 ID（最多 128 个字符），因此 DeepSeek 发布新模型时无需升级执行机代码。项目默认使用已验证能完成服务端 `web_search` 的 `deepseek-v4-pro`；切换模型前应先实测响应包含完成的 `web_search_call`，不能只以 HTTP 成功作为可用依据。

`executor:deepseek-sim` 仍是内部流程联调入口。搜图或本地兜底结果明确标记为模拟，不能视为 Codex 原生生成，也不能作为真实模型验收证据。

## 保留的本地维护工具

CLI 的 `db:init`、`enqueue`、`status`、`worker`、`worker:drain`、`storage:optimize` 和本地数据迁移工具仍保留。它们依赖本地业务库，已不由旧 Web 页面调用。执行维护命令前核对目标数据路径。

## 验证

```powershell
npm test
npm --prefix server test
npm run typecheck
npm run build
npm run smoke
```

自动化测试使用 Fake，不消耗真实模型额度。清理范围、保留原因和验证结果见 [代码清理审计](docs/code-cleanup-audit-2026-09-06.md)。
