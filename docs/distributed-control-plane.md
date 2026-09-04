# 分布式创作控制中心（第一版）

## 目标边界

远端中心服务是任务、执行记录、文案版本、图片结果、审核结果、提示词、知识库和生产配置的唯一真源。执行机只运行本机 UI、OpenClaw 和模型调用，保留本机凭据、短期日志及任务临时文件，不维护可独立演进的业务数据库副本。

远端中心服务位于仓库的独立 `server/` 包，仅需 Node.js、PostgreSQL 和服务端文件目录，不安装根项目依赖、OpenClaw，也不保存模型凭据。接口使用 Koa、`@koa/router` 和统一错误/请求体中间件；所有机器位于受控内网，第一版不实现用户、团队、RBAC、TLS、Worker 租约或固定频率心跳。

## 生命周期

```text
COPY_QUEUED -> COPY_RUNNING -> COPY_REVIEW_PENDING
      |              |
      |              +-> COPY_FAILED -> COPY_QUEUED（人工重试）
      |
      + 本机创建、本机串行执行

COPY_REVIEW_PENDING --审核指定 copyRevisionId--> IMAGE_QUEUED
IMAGE_QUEUED --任意已启用图片能力的空闲节点原子领取--> IMAGE_RUNNING
IMAGE_RUNNING -> DELIVERY_REVIEW_PENDING -> COMPLETED
      |
      +-> IMAGE_QUEUED（第 1、2 次失败，由原生图执行机重试）
      +-> COPY_REVIEW_PENDING（第 3 次失败：生图3次失败，等待人工审核）
```

文案任务不会被非指定机器领取。创建任务时，中心服务分别记录 `createdByNodeId` 和用户选择的 `copyExecutorNodeId`；执行代理只领取分配给自己的 `COPY_QUEUED`。图片任务无创建机优先级。

每轮人工审核通过后，生图最多执行 3 次（首次 + 最多 2 次自动重试）。只有整次执行在 OpenClaw 内部重试结束后仍失败，才记 1 次；内部模型重试和失败回报的网络重发不额外计数。每次失败仍保留 `task_executions` 和 `image_runs` 的 `FAILED` 历史及脱敏错误。

第 1、2 次失败回到 `IMAGE_QUEUED`，至少等待 5 秒后由原生图执行机再次领取，保留原配置快照，创建新执行 ID；原节点离线时等待，不转交其他节点。中心在已有 JSON 快照中写入 `imageRetry: { failedAttempts, nodeId }`，经 `pending_snapshot` 传递到下一次执行，进程重启不清零，无需改表。此预算按整次任务执行计数，不改变 OpenClaw 内部重试策略。

第 3 次失败进入 `COPY_REVIEW_PENDING`，`currentStage` 为 `IMAGE_RETRY_EXHAUSTED`，界面状态显示“生图3次失败”。任务计入待文案审核列表与角标，保留原文案供人工修改或废弃；不再自动领取。重新提交文案审核后，清除旧重试快照，开始新的最多 3 次生图周期。旧快照没有 `imageRetry` 时从本次失败开始计数，不根据历史总次数追溯判定。

部署时必须更新并重启远端中心服务及界面；仅更新执行机或刷新页面不能启用次数限制。此实现不自动部署、不批量修改现有远端任务。

新版本中心启动时自动应用 `0002_requeue_failed_images`，将旧 `IMAGE_FAILED` 任务转回待生图；文案审核记录和失败历史不删除。这些任务归入工作台的“生图中”页签，状态为“待生图”，不再进入“待文案审核”。

## 执行隔离

每次开始或重试都创建新的 UUID `executionId`，并写入任务的 `currentExecutionId`。进度、成功和失败更新仅在两者仍匹配时生效；已经被人工作废的旧执行返回 `409 STALE_EXECUTION`，不能覆盖新结果。

没有固定心跳。模型阶段切换、逐页生图、OCR 对齐和质量检查等自然进度会更新 `lastActivityAt`。页面同时展示 `executionStartedAt`、`lastActivityAt`、当前阶段和耗时。第一版只标记疑似停滞，由人工点击“作废并重新执行”，不自动回收。

## 配置快照

文案执行开始时冻结当前已发布文案提示词、生产配置和文案知识版本；图片任务领取时冻结已审核的文案版本、当前已发布图片提示词、生产配置和视觉知识版本。全局配置后续变更不影响运行中的执行。

普通重试复用上次快照；“使用最新配置重试”才重新创建快照。第一版 API 已保留 `snapshotMode`，执行机永远以领取响应中的快照为准。

## 文件布局

服务端目录只使用数据库整数 ID 和服务端生成的运行 ID，不使用 Query 作为路径：

```text
server/server-storage/
  knowledge/copy/<itemId>/<versionId>/
  knowledge/visual/<itemId>/<versionId>/
  tasks/<taskId>/image-runs/<runId>/
```

Query 仅保存在 PostgreSQL 和可选的元数据文件中。重试产生新的 image run，旧运行不覆盖；任务通过 `currentImageRunId` 指向当前有效结果。

## 执行机开关

执行代理默认不领取图片任务。只有显式配置 `IMAGE_WORKER_ENABLED=true` 或传入 `--enable-image-worker` 时才启动图片轮询，并在节点注册信息中声明能力。关闭时不创建图片轮询定时器，也不会调用图片领取 API。

每台机器有两个互不阻塞的执行通道。文案通道串行处理分配给本机的文案队列；图片通道在启用图片能力后独立轮询，只要该节点当前没有 `IMAGE_RUNNING`，就可以领取一条全局图片任务，不需要等待文案队列清空。同一节点最多同时执行一条文案任务和一条图片任务。

执行代理必须先完成中心服务健康检查和工作目录读写检查，之后才能注册节点并开始领取。运行期间每 15 秒刷新节点活动时间；中心将 90 秒内有活动的节点提供给创建界面选择。节点掉线不会迁移已分配任务，重启后也必须重新通过完整就绪检查，才会继续领取原队列。OpenClaw 和模型连接当前不作为节点上线门禁，在实际执行任务时检查。

临时的 DeepSeek 模拟执行机使用 `npm run executor:deepseek-sim` 常驻运行。文案通道始终持续轮询；`IMAGE_WORKER_ENABLED=true` 时，图片通道也会同时持续轮询，并复用中心的图片领取、进度、文件上传和完成接口，但不进入正常 OpenClaw 生图方法。候选图片来自服务端联网搜索，经公网地址、响应类型、文件大小、像素尺寸校验并标准化为 PNG 后，上传到当前 `taskId/imageRunId` 对应的中心目录。结果必须标记为模拟并进入人工图文审核，不能声称由 OpenClaw 生成或已通过版权与质量检查。两个通道在没有任务或遇到暂时性轮询错误时都会按 `EXECUTOR_POLL_MS` 等待后继续，不会按处理数量自动退出。
