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
      +-> IMAGE_FAILED -> IMAGE_QUEUED（人工重试，回到全局池）
```

文案任务不会被其他机器领取。创建任务时，中心服务同时记录 `createdByNodeId` 和 `copyExecutorNodeId`；本机执行代理只领取分配给自己的 `COPY_QUEUED`。图片任务无创建机优先级。

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

第一版每台机器共用一个执行槽：优先串行处理本机文案队列；没有本机文案任务时，启用图片能力的机器才领取一条图片任务。这可避免同一台机器同时进行联网文案生成和多页生图导致资源与模型额度竞争。
