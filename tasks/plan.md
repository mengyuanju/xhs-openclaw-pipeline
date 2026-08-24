# Implementation Plan: 小红书内容生产管理后台 v0.3

## Overview

把现有单条 CLI 管线扩展为本机管理后台，按“领域数据 -> Excel 批次 -> 审核修订 -> Web 页面 -> Worker 集成”的依赖顺序纵向交付。每个切片都必须保持旧 CLI 与 Mock 冒烟可用。

## Architecture Decisions

- 第一版采用 Next.js BFF + SQLite + 本地文件存储，默认只监听 `127.0.0.1`。
- 内容生产 Web 请求只创建或修改任务，Worker 独立领取任务；Excel 上传预检是显式例外，会同步等待 OpenClaw 完成需求强度检测后再创建预览批次。
- 提示词发布版本不可变，任务固定版本与哈希；修订内容和图片永不覆盖原件。
- Excel 先进入 staging 批次，预览后显式提交；提交幂等。
- 图片能力通过适配器暴露 `generateImage` 与 `editImage`，保留以后切换 API/ComfyUI 的边界。

## Dependency Graph

```text
管理数据库/契约
  ├─ 提示词版本
  ├─ Excel staging/提交
  ├─ 任务审核与素材谱系
  │    └─ Worker 提示词/参考图集成
  └─ REST Route Handlers
       └─ Next.js 管理页面
            └─ 浏览器端到端验证
```

## Task List

### Phase 1: Foundation

- [x] Task 1: 管理数据库、提示词版本与统一领域契约。
- [x] Task 2: Excel 解析、预览和幂等提交。

### Checkpoint: Foundation

- [x] 新领域测试与全部旧测试通过；1000 行导入测试通过。

### Phase 2: Review and Assets

- [x] Task 3: 文本修订、审核状态和审计记录。
- [x] Task 4: 参考图上传、图片谱系和确定性图片修订。

### Checkpoint: Review

- [x] 一个任务可经历导入、生成、修改、退回和通过，历史不丢失。

### Phase 3: Web Console

- [x] Task 5: Next.js 外壳、导航、仪表盘和任务分页。
- [x] Task 6: Excel 导入页与提示词工作台。
- [x] Task 7: 任务审核页、参考图和图片编辑操作。

### Checkpoint: Web

- [x] 构建通过，后台在 320/768/1440 宽度可用，控制台无错误。

### Phase 4: Worker Integration

- [x] Task 8: 提示词快照、图片数量和参考图进入生产管线。
- [x] Task 9: OpenClaw 图生图/编辑适配与连续消费命令。

### Checkpoint: Complete

- [x] 全量测试、构建、Mock Excel 到审核流程和浏览器验证通过。
- [x] 安全扫描、秘密扫描和五轴代码审查无阻断问题。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Next.js 与同步 `node:sqlite` 打包边界 | 高 | 数据访问保留在 Node runtime server modules，先做最小构建冒烟 |
| Excel 恶意或超大压缩包 | 高 | 5 MiB/5000 行/首表限制，超限立即拒绝 |
| Web 与 Worker 并发写 SQLite | 中 | WAL、短事务、5 秒 busy timeout、幂等状态更新 |
| 提示词改动污染在途任务 | 高 | 任务固定版本 ID、内容和 SHA-256 快照 |
| 图片上传伪造 MIME 或路径穿越 | 高 | 随机/数据库 ID 文件名、Sharp 解码、尺寸/大小限制 |
| OAuth 无法承担目标规模 | 高 | Mock 完成产品验收；真实生产切换 API 凭据并加预算熔断 |

## Open Questions

- 无阻断问题；跨公网 HTTPS、多用户认证和自动发布留到后续版本。

## Phase 5: LAN Authentication

- [x] Task 11: 密码哈希、会话签名、配置校验与登录限流。
- [x] Task 12: 私网 Host 策略、Proxy 预检和 API 二次授权。
- [x] Task 13: 登录/退出界面、管理员配置命令与 LAN 启动脚本。

### Checkpoint: LAN Authentication

- [x] 未登录页面重定向、API 401、成功登录、退出、会话过期和篡改均通过自动化测试。
- [x] `start:lan` 可从本机私网 IP 打开，页面控制台无错误，安全头和 Cookie 属性符合规格。

## Phase 6: Visual Knowledge Module

- [x] Task 14: 定义视觉知识领域契约、SQLite 表、版本和任务锁定。
- [x] Task 15: 增加安全图片分析、双保留模式与 OpenClaw 视觉适配。
- [x] Task 16: 增加配方 REST API、管理页面和鉴权图片预览。
- [x] Task 17: 将已发布配方锁定并接入主图提示词和参考图。
- [ ] Task 18: 完成全量验证、安全审查和使用文档。

### Checkpoint: Visual Knowledge

- [x] `PROMPT_ONLY` 不落盘原图，授权 `IMAGE_AND_PROMPT` 可鉴权预览。
- [x] 任务固定视觉配方版本，知识库为空时原生产链路不变。
- [ ] 全量测试、类型检查、构建、Mock 冒烟和浏览器关键流程通过。

### Visual Knowledge Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 模型把图片中的文字当指令 | 高 | 图片内容按不可信数据处理，结构化 JSON 白名单校验 |
| 未授权图片被长期保存或进入图生图 | 高 | 保留模式与授权状态在领域层强制组合 |
| 配方变更导致重试结果漂移 | 高 | 首次生成写入不可变版本引用，重试复用 |
| 视觉分析阻塞 HTTP 或产生费用 | 中 | 单图、超时和大小上限；常规测试只用 Fake |

## Phase 7: Full Model-Generated Image Sets

- [x] Task 19: 让文本输出契约逐张规划全部 3–5 张图片，并为每张提供非空模型提示词。
- [x] Task 20: 基于完整生成文本组合逐图提示词，并把全局规则与视觉配方应用到每一张图。
- [x] Task 21: Live 模式逐张调用图像模型，后续页面使用首图作风格参考，移除本地模板交付路径。
- [x] Task 22: 更新提示词版本和文档，完成定向测试、全量测试、类型检查与构建。

### Checkpoint: Full Model-Generated Image Sets

- [x] 3–5 张 Live 交付图的模型调用次数等于图片数量。
- [x] 每张提示词包含完整文案与本页信息，后续页面引用首图保持统一风格。
- [x] 所有图片为 1080×1440 PNG，现有 QC、资产同步和审核流程无回归。

### Full Model Image Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 单任务模型成本扩大 3–5 倍 | 高 | 保留显式 Live 和 `--max` 上限，测试默认使用 Fake/Mock |
| 后续图片复制首图而非生成新页面 | 高 | 首图只作为风格参考；逐页提示词明确要求新信息和新构图 |
| 长提示词超过适配器限制 | 中 | 总长度提高到有界 8,000 字符并在调用前校验 |
| 模型图片中文字错误 | 高 | 逐张 QC 和人工终审继续作为交付门槛 |

## Phase 8: OpenClaw Demand Screening

- [x] Task 23: 定义并测试有界批量需求检测契约，严格校验模型 JSON、行号覆盖和四档枚举。
- [x] Task 24: 将自动检测接入 Excel 预检，记录 `OPENCLAW` 来源与模型名，保留 Excel 判定和人工复核。
- [x] Task 25: 更新导入界面与文档，完成全量测试、类型检查、构建和浏览器验证。

### Checkpoint: OpenClaw Demand Screening

- [x] 未预筛选的结构合格行全部经过 OpenClaw，已有 Excel 判定不重复调用。
- [x] 任一批次模型输出不完整或非法时不创建导入批次。
- [x] 页面展示自动判定并允许管理员修改后再入队。

### Demand Screening Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 大 Excel 导致调用时间和成本上升 | 高 | 按行数和字符预算分批，界面明确提示，测试只用 Fake |
| Query 中的提示注入影响检测 | 高 | 将行数据标记为不可信，只接受严格结构化白名单输出 |
| 部分批次成功后写入不完整结果 | 高 | 全部模型批次通过校验后才写 SQLite |

## Phase 9: Web-launched Live Worker

- [ ] Task 26: 定义并测试固定命令、并发锁和最多 20 条的后台 Worker 启动器。
- [ ] Task 27: 增加认证 `POST /api/worker-runs`，校验费用确认并按当前待处理数收紧上限。
- [ ] Task 28: 在已提交导入批次中增加二次确认、异步启动反馈和内容审核入口。

### Checkpoint: Web Worker Launch

- [ ] 网页请求立即返回 `202`，模型生成在独立进程中继续，页面不会长时间阻塞。
- [ ] 取消费用确认不发送请求；无任务或已有运行返回明确冲突提示。
- [ ] 命令、路径、模式和最大数量均由服务端固定，客户端无法注入 Shell 参数。

### Web Worker Launch Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 误触造成批量模型费用 | 高 | 二次确认、服务端确认字面值、单次最多 20 条 |
| 重复点击启动并发 Worker | 高 | 进程内活动锁与数据库 processing 状态双重检查 |
| 长请求阻塞 Next.js 页面 | 高 | 只启动独立 Node 进程并返回 202，不在请求内执行模型 |
| 命令注入或任意程序执行 | 高 | 固定 CLI 路径、参数数组、`shell: false`、只接收整数 max |
