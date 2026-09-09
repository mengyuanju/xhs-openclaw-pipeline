# 代码清理结果与保留边界

更新日期：2026-09-09。本次以当前分支 05482ea 为基线，参考远程
origin/dev_xhs 的第一次冗余代码清理，再按当前分支新增功能复核并移植。

## 清理结果

其中代码清理主体涉及 223 个文件：删除 139 个、修改 81 个、新增 3 个；净删除约 1.9 万行。
删除范围包含旧页面、旧 API、无入口服务、专属测试、脚本、模板和样式。直接依赖
exceljs 已移除；当前共享按钮仍使用的 class-variance-authority 与
@radix-ui/react-slot 保留。

| 功能或结构 | 状态 | 删除范围与替代入口 |
| --- | --- | --- |
| 隐藏的旧导航与首页仪表盘 | 已删除 | 首页直接进入 /workbench/personal，导航仅保留当前工作台、内容资产与系统管理 |
| 通用中心组件中的旧提示词/知识库分支 | 已删除 | 配置组件只处理生产设置；提示词和知识库使用各自当前页面 |
| OpenClaw 执行器、追踪导出和补丁脚本 | 已删除 | 当前模型调用统一经 createAgentClient 和 Codex 客户端 |
| Excel 导入与需求筛选 Web | 已删除 | 删除 /imports、导入 API、Excel 解析/筛选服务及模板；工作台批量 Query 提交保留 |
| 独立/批量文案与图片生成 Web | 已删除 | 删除 generation 页面、专属 API、历史浏览器脚本与孤立转换端点；中心队列执行保留 |
| 旧任务、审核、统计和追踪页面 | 已删除 | 删除 /tasks、/reviews、/analytics、/openclaw-traces 及其专属 API |
| 旧远端作业中心 | 已删除 | 删除 /jobs，统一使用 /workbench/* |
| 无入口的 Web 后端服务 | 已删除 | 删除旧素材上传、需求筛选、本地文案分析、生成附件读取、本地 ZIP 导出等服务 |
| 旧预览编辑分支和页面专属样式 | 已删除 | 当前预览保留缩放、适配、旋转、上下张、底色和加载恢复 |

旧路由下线后返回 404，不再保留可触发旧模型调用的隐藏接口。当前
ADMIN、REVIEWER、USER 均从新首页进入各自有权限的工作台。

## 当前功能边界

~~~mermaid
flowchart TB
  UI[当前工作台 /workbench] --> Proxy[登录与中心 API 代理]
  Assets[提示词 / 知识库 / 生产配置] --> Proxy
  Proxy --> Server[中心服务 server/]
  Server --> DB[(PostgreSQL)]
  Server --> Files[(中心图片文件)]
  Executor[执行机] -->|领取 / 进度 / 回传| Server
  Executor --> Copy[文案生成]
  Executor --> Image[图片生成 / 质检 / 断点恢复]
  Copy --> Codex[Codex]
  Image --> Codex
  Copy --> Dots[可选 Dots 正文]
  Copy --> Search[DeepSeek 或 Codex 检索]
  Assets -. 未配置中心地址时 .-> Local[(本地 queue.db)]
  CLI[本地 CLI / 数据迁移] --> Local
~~~

| 保留能力 | 主要代码 | 原因 |
| --- | --- | --- |
| 创作、人工审核、资源下载和统计 | app/workbench/、app/workbench-statistics/、server/src/ | 当前生产入口 |
| Codex 文本、视觉和原生生图 | src/codex*.mjs、src/agent-client.mjs | 当前模型执行链路 |
| 文案研究、生成和审核 | src/copy-generation.mjs、src/content-stage-review.mjs | 当前执行器共享，Dots 与 DeepSeek 仍可选 |
| 生图、图文对齐、质检和恢复 | src/standalone-image-generation.mjs、src/images.mjs、src/executor/ | 文件名中的 standalone 是历史命名，但模块仍由核心执行器调用 |
| 提示词、知识库和生产配置 | app/prompts/、app/knowledge/、app/settings/ | 当前版本管理和生产规则入口 |
| 本地 CLI、迁移和模拟执行器 | src/cli.mjs、维护脚本、src/executor/deepseek-*-simulator.mjs | 仍有明确运行入口；模拟结果不会冒充 Codex |

当前调用参数已统一命名为 agentClient。历史数据库来源枚举、旧配置读取兼容和
SQLite 熔断键 openclaw-auth 暂时保留，以免破坏已有记录或恢复流程。旧配置中的
OPENCLAW 会在读取时归一为 CODEX，新页面和写入接口只接受当前提供方。

本地 data/queue.db 仍服务于未配置中心地址时的提示词、知识库、生产设置及本地
CLI；它不是中心数据库缓存，中心故障时不会自动回退。Codex 的调用许可与冷却状态
单独保存在运行状态 SQLite 中。本次没有迁移或删除任何业务数据库、图片资产和任务
检查点。

## 回归证据

| 检查 | 结果 |
| --- | --- |
| 根目录测试 | 948 项通过，0 失败、0 跳过 |
| 中心服务测试 | 293 项通过，0 失败、0 跳过 |
| TypeScript | tsc --noEmit 通过 |
| Mock smoke | 通过，不消耗真实模型额度 |
| 旧入口边界 | 源码测试确认代表性旧页面与旧变更接口已不存在 |
| 静态依赖 | 当前源码无对删除模块、旧页面或旧 API 的静态引用 |
| 生产构建 | Next.js 生产构建通过；路由表只包含当前页面和保留接口 |

## 复查与撤回范围

本批只修改源码和依赖锁文件，不包含部署、发布、生产调度或数据迁移。当前开发端口
继续使用 3001。若需撤回，应只撤回本批文件，不能用整个工作区重置覆盖其他未提交
改动。
