# 执行机并发配置

文案与图片分别使用独立任务池，按空闲容量批量领取、并发执行，完成一条即补位。正式执行机与 DeepSeek 模拟执行机使用相同调度器。并发数属于每台执行机的 `.env` 配置，不是中心“生产配置”页面的模型参数。

## 环境变量

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `EXECUTOR_COPY_CONCURRENCY` | 1 | 同时持有并处理的文案执行数 |
| `EXECUTOR_IMAGE_CONCURRENCY` | 1 | 同时持有并处理的图片执行数 |
| `IMAGE_WORKER_ENABLED` | false | 是否领取图片任务，关闭时有效图片容量为 0 |
| `EXECUTOR_POLL_MS` | 5000 | 空队列、暂时错误与未确认回报的重试间隔；允许 1000–60000 毫秒 |
| `XHS_CODEX_CONCURRENCY` | 2 | 同一运行状态库中所有进程的 Codex 总调用许可 |
| `XHS_CODEX_IMAGE_CONCURRENCY` | 1 | 上述调用中生图/改图的许可 |

四个并发值均为 1–32 的十进制整数；空字符串、零、小数、越界值会拒绝启动/创建客户端。Codex 图片许可不得大于总许可。同机共享状态库的调用进程须使用一致配置；修改后先让旧调用收尾，再统一重启执行机、Web 与 Worker。配置不一致且已有调用运行时返回 `CODEX_CONCURRENCY_MISMATCH`。

例如要让执行机最多同时处理 3 条文案、2 条图片任务，并允许相应的 Codex 调用并发，可配置：

```dotenv
EXECUTOR_COPY_CONCURRENCY=3
EXECUTOR_IMAGE_CONCURRENCY=2
IMAGE_WORKER_ENABLED=true
XHS_CODEX_CONCURRENCY=5
XHS_CODEX_IMAGE_CONCURRENCY=2
```

这是应用容量配置示例，不是订阅账号吞吐保证。认证、额度暂停、429 冷却和原有错误处理继续生效。一个任务可能经历规划、文本、OCR、生成、上传等阶段，因此任务池活跃数和实际 Codex 调用数可能不同。

`XHS_IMAGE_CONCURRENCY` 是原有单个任务内部的图片并发，`XHS_TASK_CONCURRENCY` 是旧本机 drain 的完整任务并发；均不控制分布式执行池。OpenClaw 回退仍保留其文本串行限制，本次提供方许可扩展针对当前使用的 Codex。

## 领取与恢复

- 每次领取数量是当前空闲槽位数。中心再按注册容量减去该节点同类 `RUNNING` 数截断，单条旧 API 也遵守容量限制。文案指定节点、生图恢复绑定与重试冷却规则保留。
- 同批任务使用独立执行 ID、快照、日志及目录。批次共用一次读取的已发布配置数据，恢复任务仍保留原快照。
- 请求 ID 使用 [RFC 9562 UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7)。响应丢失时保留请求 ID 和预留槽位，对账后只运行仍为 `RUNNING` 的执行；普通网络错误不能释放不确定槽位。
- 请求时间起 24 小时后，空回执及所有执行已终态的回执可在后续领取事务中清理，每次最多 100 条。仍有运行执行的回执持续保留并可重放。已清理的过期请求返回 `CLAIM_REQUEST_EXPIRED`，不会再领取任务；执行机收到该明确结果后才释放其预留槽位。节点停止轮询后剩余回执在下次领取时清理。中心与执行机需同步系统时间。
- 失败回报按执行 ID 单独重试，确认前继续占槽，不重复运行生成流程。单条失败不会阻塞其他任务和空闲槽位。
- SIGINT/SIGTERM 停止新补领，等待在途请求、执行与回报收尾，期间继续心跳。网络持续中断会延长收尾；强制终止后的中心 `RUNNING` 记录按现有人工恢复流程处理，不自动回收。
- `--once` 每种启用类型最多尝试一条，关闭图片能力时不请求图片 API。图片完成只清理本次执行目录；历史失败检查点保留，确认不再恢复后可由管理员清理。

## 升级与回退

1. 停止旧执行机并等待在途任务收尾，备份中心数据库，保留本机恢复检查点。
2. 中心部署包含 `0007_executor_concurrency.sql`、`0008_claim_receipt_retention.sql` 的完整版本。先预览 `npm --prefix server run db:upgrade`，再执行 `npm --prefix server run db:upgrade -- --apply`；中心启动也会自动应用未执行迁移。
3. 重启中心，确认 `/health` 返回 `capabilities.executorConcurrency: true`；Codex 还要求 `executionRetryControl: true`。新执行机连接旧中心会拒绝启动。
4. 执行机更新代码，配置各容量并重启 `npm run executor`。启动日志显示文案容量与有效图片容量。缺省仍为 1/1，降低容量不会强杀已经运行的任务。

应用回退时保留已应用迁移文件和新增数据，不修改有校验和的迁移或 `schema.sql`。旧单条 API 继续可用。此次本机测试未更新现有中心服务。

## 本机无额度测试

```powershell
npm test
npm --prefix server test
npm run typecheck
npm run build
```

真实 PostgreSQL 集成测试需要本机已有 PostgreSQL 可执行程序，但不需要已有数据库或服务。指定其 `bin` 目录后运行：

```powershell
$env:TEST_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
node --test server/integration/executor-concurrency.mjs
```

测试自行在系统临时目录初始化独立集群，仅监听 `127.0.0.1` 的临时端口；不读取 `.env` / `DATABASE_URL`，不会连接已配置的中心数据库。覆盖迁移重入、节点竞争、同请求并发重放、事务回滚、容量下调、回执清理，以及本机 HTTP → 客户端 → 执行池的 3/2 并发与完成补位。结束后关闭并删除测试集群，所有生成步骤使用 fake。

## 真实模型效率测试

以下命令会消耗已登录账号及已配置检索服务的真实额度，不属于 `npm test`：

```powershell
$env:TEST_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
node --env-file-if-exists=.env scripts/benchmark-executor.mjs --live
```

脚本从 `CONTROL_PLANE_URL` 只读获取已发布的生产设置、提示词和知识，复制到临时 PostgreSQL，启动仅监听本机的新版中心；所有创建、领取、测试文案审核、生图、上传均在本机进行。默认 3 条文案、其中成功的前 2 条各生成 3 张图片，任务容量 3/2，Codex 许可 5/2。结束后关闭临时服务和数据库，保留 `.codex_artifacts/executor-benchmark/<时间>/` 中的逐步耗时、模型调用、失败输出与真实图片。

可用 `--copy-concurrency=3 --image-concurrency=2 --image-tasks=2` 调整规模；`--queries=<JSON字符串数组文件>` 指定需求；`--copy-results=<上次evidence.json>` 复用已有真实文案，只测图片；`--output=<目录>` 指定独立证据目录。同一状态库已有模型调用时拒绝启动，避免中途改变其许可配置。不要让两次运行覆盖同一个证据目录。

生图和改图采用 Codex CLI 的 `app-server --stdio` 原生图片完成事件。文案和视觉审核仍使用 `exec --json`。两者共享现有 ChatGPT 登录和许可，不读取模型回答中的路径冒充工具证据。详见 [Codex 接线](codex-exec-migration.md) 和 [真实测试记录](executor-concurrency-live-results.md)。
