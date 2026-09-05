# Codex 订阅执行器迁移计划（2026-09-05）

## 目标与边界

以 `codex exec` 和现有 ChatGPT 登录接替默认 OpenClaw 运行时，保留显式 OpenClaw 回切；文案、搜索、图片、审核、导入筛选、知识库分析和分布式执行入口均使用统一工厂。已有业务质量门禁、人工审批和重试断点继续生效。此次不创建生产定时任务、不发布内容、不启用额外付费 API。

用户已授权先规划、再直接实施，无需再次确认计划。原有 DeepSeek 搜索修改保留。历史计划保留在本文下方。

## 决策

- `agentProvider` / `XHS_AGENT_PROVIDER` 选择 CODEX 或 OPENCLAW；默认 CODEX。原有正文 OPENCLAW 选项兼容为默认 Agent，DOTS 仍可独立选择；原有 OPENCLAW 搜索选项同样兼容为默认 Agent，DEEPSEEK 仍独立。
- 保持七项客户端接口与现有业务返回字段；新增真实 provider / execution 信息，不把 Codex 结果标为 OpenClaw。
- Codex 使用官方登录缓存、参数数组、`shell: false`、标准输入传递完整提示词，独立运行目录及明确沙箱。清除子进程中的业务凭据与 API Key，防止订阅调用意外变为 API 计费。
- 文本和视觉返回结构化外层响应，由现有业务解析器继续验证内部契约；搜索必须有真实搜索工具事件和公开来源；图片必须有真实图片工具事件以及可验证的生成文件。
- 同一机器/用户的 Worker 共享 SQLite 限流状态，最多两个在途调用、其中一个图片调用。不同机器不会凭空获得账户级协调，跨主机共用一个订阅仍需集中调度。
- 限流使用共享冷却，认证/额度错误暂停新模型调用；超时和图片结果不确定时不在适配器里盲目重放。队列与断点负责恢复，结果落盘与进程完成一起决定成功。
- 保留当前 `openai/<model>` 配置格式，调用 Codex 时严格映射模型名；不静默替换模型。
- `$imagegen` 可用性、账户容量和真实吞吐需真实验收；无额度测试不能被表述为已完成生产压力测试。

## 实施步骤与验收

1. 配置与统一工厂：增加 provider 设置、参数验证及回切测试；保留 Dots/DeepSeek 的独立选择。验证：配置与客户端工厂测试。
2. 进程与输出契约：实现安全启动、终止、JSONL 解析、缺失结果/失败事件/上下文错误处理。验证：真实本地假进程与协议故障测试，不调用模型。
3. 模态适配：实现文本/审核/视觉、搜索、生成/编辑和文件验证。验证：假 CLI 驱动真实文件校验与研究快照解析。
4. 并发与恢复：实现同机跨进程限流、冷却与暂停状态，接入 Worker 领取前检查。验证：并发、取消、进程退出及认证/额度故障测试。
5. 业务接线与溯源：迁移 CLI、后台、执行器与知识库入口，允许 CODEX 筛选/审核来源并兼容历史记录。验证：数据库迁移、端到端假客户端及来源展示测试。
6. 验收与交付：运行根目录和中心服务测试、类型检查、生产构建、Mock 冒烟；提供预检与回切说明，记录尚未执行的真实模型验收。

每一阶段先验证新增行为，再进入下一阶段；最终检查不覆盖既有未提交修改。

## 完成情况

六个实现阶段及无额度回归已完成，详见 `tasks/todo.md` 与 `docs/codex-exec-migration.md`。补充的安全决策：中心失败上报新增可选 `autoRetry`；Codex 已失败的分布式图片任务等待人工续跑，防止中心层重复提交结果未知的生成。旧中心缺少 `executionRetryControl` 能力时，Codex 执行器预检拒绝启动。原有断点续跑的中心接线缺口也已由现成回归测试定位并修复。

真实模型调用、持续并发吞吐和生产部署没有执行，不能将本次代码交付表述为全部线上能力已获保证。

## 官方依据

- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)：JSONL、JSON Schema、stdin、认证与沙箱。
- [搜索](https://learn.chatgpt.com/docs/web-search)：live 模式与 web_search 事件。
- [图片生成](https://learn.chatgpt.com/docs/image-generation)：CLI 图片输入、内置 imagegen 与订阅用量。

---

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

## Phase 20: 单条文案双版本保存与对比

### Overview

为“单独生成文案”增加原始版、质检修订版、两次审核证据的原子持久化，并提供历史恢复与双栏对比。详细契约见 `docs/standalone-copy-comparison-spec.md`。

### Architecture Decisions

- 首次结构合法的模型输出是原始版；以原始版和首次质检证据为输入进行第二次完整生成，得到质检版。
- 质检版再进行一次独立文本复检；两次证据都保存。
- 新增独立 SQLite 表，不创建生产任务；POST 成功后一次事务写入整对版本。
- API 叠加 `original` 和 `reviewed`，旧 `copy` 字段继续指向质检版。

### Checkpoints

- Contract/Store：生成顺序、双版返回、SQLite 读写和分页测试通过。
- Interface：POST 保存、GET 历史、分别复制和响应式对比通过。
- Complete：全量测试、类型检查、构建和浏览器验证通过。

### Timing Observability

- 使用单调时钟记录成功生成的总耗时和六阶段耗时，不记录请求正文、令牌等敏感信息。
- SQLite 对旧表增量增加可空耗时列；旧记录继续可读并排除在统计样本之外。
- 历史汇总使用最近最多 1000 条有效样本的平均值与 nearest-rank P50/P95；单条记录展示阶段明细，便于定位模型或研究瓶颈。

### Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 第二遍增加模型费用 | 中 | 确认框明示两次文案调用与两次审核 |
| 质检修订引入新事实 | 高 | 复用相同允许来源与严格 Post 契约，再独立复检 |
| 历史 JSON 过大 | 中 | 字段字节上限与有界分页 |
| 旧调用方契约中断 | 高 | 只添加字段，保留 `copy`/`imagePlan` 别名 |

## Phase 19: 任务级内容质检负责人

### Overview

把生产质检从“每个文案版本一张工单”迁移为“每个内容任务一个负责人”。管理员按批次、质检员和条数分配；同一负责人在统一详情页完成文案与图片阶段审核。详细契约见 `docs/review-work-management-spec.md`，设计理由见 `docs/decisions/001-task-level-review-ownership.md`。

### Architecture Decisions

- Query 预审继续使用独立工单；生产质检使用 `task_id` 唯一的分配记录。
- `COPY_REVIEWER` 作为兼容内部角色保留，产品名称改为内容质检员。
- 文案/图片结论追加保存并绑定阶段快照；图片指纹包含当前文案指纹。
- 按条数分配使用短写事务，库存不足整次回滚；转派与提交使用乐观版本。
- 旧 COPY 工单迁入任务负责人/文案阶段历史，新 UI 不再生成。

### Checkpoints

- Domain：精确分配、唯一负责人、阶段新鲜度、迁移和越权测试通过。
- Interface：严格 API、统一详情和受控图片读取通过。
- Complete：全量测试、类型检查、构建、浏览器与安全验证通过。

### Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 多个组长同时分配造成超发 | 高 | `BEGIN IMMEDIATE` 内重新选择未分配任务，数量不足回滚 |
| 文案变化后旧图片结论误生效 | 高 | 图片快照包含文案指纹，加载时实时判断新鲜度 |
| 质检员枚举图片 ID 读取他人素材 | 高 | assignment、task、asset 三重归属校验 |
| 旧文案工单历史丢失 | 中 | 只增表迁移，保留旧表并迁移负责人和 COPY 结论 |
| 人工流程阻塞现有生产 | 中 | 本阶段不改 Worker 门禁，后续单独设计暂停/恢复 |

## Phase 18: Query 与文案质检作业中心

### Overview

在不打断现有 Worker 连续生产流程的前提下，新增独立质检人员、角色、作业单、派单/领取、版本化结论和质检工作台。详细契约见 `docs/review-work-management-spec.md`。

### Dependency Graph

```text
人员与会话兼容层
  └─ 质检领域存储与授权
       ├─ 人员管理 API/UI
       └─ 作业生成/派单/领取/结论 API
            └─ 质检工作台与单条审核页
```

### Architecture Decisions

- 保留环境变量管理员为超级管理员；质检人员存 SQLite，禁止公共注册。
- 自动审核证据与人工质检结论分表保存，不改变 `generation_runs.stage_reviews_json`。
- 作业单绑定不可变主体快照和 SHA-256；内容新版本产生新作业单。
- 现有 API 默认仅 `ADMIN` 可访问；质检 API 显式开放角色并在领域层二次校验活动用户。
- 第一阶段不让 Worker 等待人工，后续另行拆分文本/视觉作业。

### Checkpoints

- Foundation：人员会话兼容、领域测试和现有认证测试通过。
- Operations：生成、派单、领取、提交的 SQLite/API 测试通过。
- Complete：页面运行时、全量测试、类型检查、构建和安全扫描通过。

### Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 质检 Token 角色过期 | 高 | 新端点从数据库重读启用状态和角色 |
| 同一作业并发领取/提交 | 高 | 短事务、条件更新、版本号与 409 |
| 历史内容变化后误审 | 高 | 主体快照、SHA-256 和幂等键 |
| 旧管理员/接口回归 | 高 | Token v1 兼容，现有 API 默认 ADMIN |
| 跨设备明文局域网登录 | 中 | 文档继续限定可信私网，实际多人部署建议 HTTPS 反代 |

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

- [x] Task 26: 定义并测试固定命令、并发锁和最多 20 条的后台 Worker 启动器。
- [x] Task 27: 增加认证 `POST /api/worker-runs`，校验费用确认并按当前待处理数收紧上限。
- [x] Task 28: 在已提交导入批次中增加二次确认、异步启动反馈和内容审核入口。

### Checkpoint: Web Worker Launch

- [x] 网页请求立即返回 `202`，模型生成在独立进程中继续，页面不会长时间阻塞。
- [x] 取消费用确认不发送请求；无任务或已有运行返回明确冲突提示。
- [x] 命令、路径、模式和最大数量均由服务端固定，客户端无法注入 Shell 参数。

### Web Worker Launch Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 误触造成批量模型费用 | 高 | 二次确认、服务端确认字面值、单次最多 20 条 |
| 重复点击启动并发 Worker | 高 | 进程内活动锁与数据库 processing 状态双重检查 |
| 长请求阻塞 Next.js 页面 | 高 | 只启动独立 Node 进程并返回 202，不在请求内执行模型 |
| 命令注入或任意程序执行 | 高 | 固定 CLI 路径、参数数组、`shell: false`、只接收整数 max |

## Phase 10: Text-Grounded, Diverse Image Production

- [x] Task 29: 定义最终正文之后的视觉计划契约，逐页记录来源证据、允许显示的简体中文、内容主体和布局职责。
- [x] Task 30: 将视觉计划接入 Worker，使图片提示词只使用当前文本版本和逐页白名单，并把视觉知识库 `layoutRules` 真正加入运行提示词。
- [x] Task 31: 增加逐页视觉验收契约、有限重试和 QC 阻断，验证图文语义、额外事实、简体中文和布局风格。
- [x] Task 32: 将生成资产绑定文本修订、页码、视觉计划哈希和验收状态；文本修改后旧图片变为 `STALE`。
- [x] Task 33: 将视觉知识选择从单一最高分改为内容过滤后的稳定 Top-K 调度，并增加近期去重与批次配额。
- [x] Task 34: 更新费用说明、审核信息和文档，完成定向测试、全量测试、类型检查、构建和 Mock 冒烟。
- [x] Task 35: 在现有视觉验收调用中增加 GPT OCR 逐字抄录、90% 置信度门槛、繁体与额外文字检测。

### Checkpoint: Text-Grounded Image Production

- [x] 每张图可追溯到当前文本修订和唯一页面计划，关键文字使用明确的简体中文白名单。
- [x] Live 图片在进入审核前经过视觉模型验收；失败页最多修复两次，仍失败时被 QC 阻断。
- [x] 同一篇笔记风格统一，不同任务在匹配内容的候选风格间受控轮换。
- [x] 文本修改后旧图片不能继续作为通过审核的有效图片。

### Text-Grounded Image Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 二次视觉规划和逐页验收扩大模型成本 | 高 | 网页费用确认显示 2 次文本类调用和 3–5 次视觉验收；每页最多两次修复 |
| 视觉模型误判导致假通过或假失败 | 高 | 严格 JSON 契约、硬失败字段、保留证据和人工覆盖边界 |
| 中文图片仍出现伪文字 | 高 | 简体中文白名单、视觉验收；后续可切换模型素材＋程序排版 |
| 风格多样性损害内容相关性 | 中 | 先过滤内容不匹配候选，再在 Top-K 中稳定抽样；候选不足时相关性优先 |
| 数据库迁移影响历史资产 | 高 | 只增加可空列和新表；历史资产默认 `UNVERIFIED`，不改写原文件 |

## Phase 11: Rule-Document Quality Scoring V2

- [x] Task 35: 定义并测试 0–3 分维度输入、证据、类型校正和漏斗聚合契约。
- [x] Task 36: 将现有机械 QC 映射为保守维度证据，在 `qc.json` 中增加 V2 评分详情并保持旧字段兼容。
- [ ] Task 37: 更新评分文档与审核展示，完成全量测试、类型检查、构建和差异审查。

### Checkpoint: Quality Scoring V2

- [x] 0、1、2、3 与证据不足五种结果互斥、可复核，不使用平均分。
- [x] 类型校正只影响 2/3 边界；平台样本不足时最终分最高为 2。
- [x] 旧机械阻断、Mock 门槛、SQLite 生成记录和人工审核边界无回归。

### Quality Scoring V2 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 把未检测到问题误判为 3 分 | 高 | 机械证据默认最高 2；3 分要求显式人工/VLM 高质量证据 |
| 新分数破坏旧审核流程 | 高 | 保留 `overallScore`/`disposition`，新详情使用附加 `rubric` 字段 |
| 2/3 条件重叠 | 高 | 任一适用维度为 2 或存在轻微标签时固定为 2 |
| 缺少平台样本仍判 3 | 高 | `platformAdaptation` 自动封顶 2 并记录证据限制 |

## Phase 12: Batch Reliability and Resume Safety

- [x] Task 38: 增加 Live 批次预检，在领取任务前验证 OpenClaw 运行时、模型配置和本地输出边界。
- [x] Task 39: 增加任务租约续期，并在文本、视觉规划、逐页生成和验收边界刷新租约。
- [x] Task 40: 将正文与视觉计划在图片生成前原子落盘，并让配置未变化的失败任务复用已通过阶段。
- [x] Task 41: 保存逐页生成检查点，只复用通过验收且哈希匹配的当前任务图片。
- [x] Task 42: 完成全量测试、类型检查、构建、Mock 冒烟和差异审查。

### Checkpoint: Batch Reliability

- [x] 全局配置错误在任何任务被领取或增加 attempts 前失败。
- [x] 超过默认十分钟的任务持续持有合法租约，不会被另一个 Worker 重复领取。
- [x] 图片阶段失败后，重试不重复调用已经成功且配置未变化的文本与视觉规划。
- [x] 只复用结构、文件哈希和图文验收全部通过的页面；人工文案变更自动使旧检查点失效。

### Batch Reliability Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 复用过期文案或图片 | 高 | 检查点绑定 Query、输入、提示词快照、人工文案修订和视觉计划哈希 |
| 并发 Worker 重复处理同一任务 | 高 | 定期续租且完成/失败继续校验 lease owner |
| 检查点文件被部分写入 | 高 | 同目录临时文件写入后原子重命名 |
| 预检误消费模型额度 | 高 | 只执行本地运行时与 OpenClaw 状态命令，不发送推理请求 |

## Phase 13: Content Review Workbench Layout

- [x] Task 43: Persist bounded quality details and expose plain-language score evidence to the review UI.
- [x] Task 44: Group generated images, run state, prompt versions, text revision, and QC into generation batches.
- [x] Task 45: Reorder the workbench around full text, the retained review decision, and batch-first image review.
- [x] Task 46: Move zoom, preview-only rotation, conditional 3:4 crop, and targeted AI edit into the image preview.

### Checkpoint: Review Workbench

- [x] Current title and body render in full while remaining editable.
- [x] The current score and its evidence are readable text; raw JSON is never shown.
- [x] Images are organized by generation batch with version and QC context inside each batch.
- [x] Rotation creates no asset revision, and crop is hidden for images already matching 3:4.
- [x] Review approval, rejection, reopening, upload, export, and AI edit remain available.

### Review Workbench Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Historical runs do not contain detailed QC evidence | Medium | Show a clear legacy fallback reason while persisting full detail for every new run |
| Historical assets do not store a generation-run foreign key | Medium | Associate generated roots by run completion boundaries and keep unmatched assets in a labeled historical batch |
| Large text and dense image batches make the page unwieldy | Medium | Use a strong top-level hierarchy, compact batch metadata, collapsible trace details, and responsive single-column fallbacks |

## Phase 14: Configurable Quality Repair and Production Analytics

- [x] Task 47: Define and persist the global production settings contract.
- [x] Task 48: Add the score-1 whole-delivery repair loop and bounded repair evidence.
- [x] Task 49: Persist generation-run timing and aggregate import-batch statistics.
- [x] Task 50: Add settings, analytics, batch timing, and repair-history UI surfaces.
- [x] Task 51: Complete focused/full verification and update operator documentation.

### Checkpoint: Quality Repair and Analytics

- [x] A first Live score of 1 is repaired to at least 2 when possible, with no more than two repair rounds.
- [x] Repair reasons, methods, before/after scores, and durations are visible in the review workbench.
- [x] Quality-repair and AI-disclosure behavior can be changed from one validated settings module.
- [x] Generation batches and import batches expose explicit timing, while analytics summarizes scores and repairs.

### Quality Repair and Analytics Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Whole-set repair multiplies image and VLM cost | High | Default maximum is two rounds; only an initial score of exactly 1 triggers it |
| Configuration changes reuse stale checkpoints | High | Include normalized production settings in the checkpoint fingerprint and manifest |
| Generic repair instructions fail to address the limiting dimension | Medium | Build instructions from stored dimension evidence and a deterministic dimension strategy map |
| Historical rows lack timing and repair evidence | Low | Add nullable columns and show explicit unavailable states instead of inferred values |

## Phase 15: Natural Copy Structure

- [x] Task 52: Add regression tests for type-aware body structure and the non-default step style.
- [x] Task 53: Update the base post contract and task-pinned text prompt with natural, type-aware writing rules.
- [x] Task 54: Run focused and project-wide verification; document prompt publication behavior.

### Checkpoint: Natural Copy Structure

- [x] Only genuinely sequential tutorials default to numbered steps.
- [x] Other content types use scenes, criteria, differences, causes, boundaries, or tradeoffs.
- [x] Human tone comes from concrete details and natural transitions, never fabricated experience.

## Phase 16: Web Research Source Provenance

- [x] Task 55: 定义联网研究快照、提供方后备、失败关闭和来源留存契约。
- [x] Task 56: 增加 OpenClaw web search 适配器与不可信搜索结果归一化。
- [x] Task 57: 在正文生成前接入研究阶段，绑定来源白名单、提示词、交付文件和检查点。
- [x] Task 58: 在生成记录中持久化成功或失败的研究快照，并兼容旧数据库。
- [x] Task 59: 完成定向/全量测试、类型检查、构建、真实提供方探测和操作文档。

### Checkpoint: Web Research Provenance

- [x] Live 新文案在模型推理前获得至少一个公开来源；否则任务明确失败。
- [x] Codex Hosted Search 失败时可切换到 DuckDuckGo，且提供方尝试链完整留存。
- [x] 模型只能返回任务输入或研究快照中的 URL，来源快照在重试期间保持稳定。
- [x] Mock、人工文案图片重生和历史记录不伪造联网行为。

### Web Research Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 搜索结果含提示注入 | 高 | 将全部搜索文本标记为不可信证据；模型输出仍受严格 JSON 与来源白名单校验 |
| 搜索服务不可用却继续产文 | 高 | 两个提供方依次尝试；全部失败或零公开 URL 时失败关闭 |
| 图片失败重试时资料漂移 | 高 | 成功快照写入 checkpoint，同一配置重试直接复用 |
| 历史任务显示伪造来源 | 高 | 新字段可空，只记录新运行实际发生的检索 |
| 搜索摘要被误认为网页全文 | 中 | 快照字段明确为 snippet/summary，当前不记录 fetchedContent |

## Phase 17: Query and Text Stage Reviews

- [x] Task 60: 定义严格、有界的 Query/文本审核契约与 OpenClaw 独立调用。
- [x] Task 61: 在联网研究前和视觉规划前接入失败关闭门禁，并保存审核产物。
- [x] Task 62: 持久化审核证据并在生成批次中展示。
- [x] Task 63: 完成定向/全量测试、类型检查、构建、Mock 冒烟和文档更新。

### Checkpoint: Content Stage Reviews

- [ ] Query 拒绝后不检索、不生文；文本拒绝后不规划、不生图。
- [ ] 真实与 Mock 审核来源不混淆，每个生成批次的结果可追溯。
- [ ] 历史数据库、检查点恢复、人工审批和最终质量门禁无回归。

### Content Stage Review Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 新增两次模型调用增加费用与耗时 | 高 | Query 审核放在所有后续付费阶段之前；结果写入检查点供重试复用 |
| 审核模型假通过或假拒绝 | 高 | 有界契约、证据留存、后续整套终审和人工审批仍保留 |
| Query/正文中的提示注入劫持审核器 | 高 | 不可信标记、严格 JSON 白名单、不暴露凭据或系统提示词 |
| 历史批次没有阶段审核字段 | 低 | SQLite 只增加可空列，界面显示明确的历史空状态 |

## Phase 18: Standalone Batch Generation

- [x] Task 64: 固化 2–20 条批量输入、共享参数和顺序执行契约。
- [x] Task 65: 新增独立“批量生成图文”入口，逐条复用现有文案与图片接口。
- [x] Task 66: 完成失败隔离、停止控制、响应式状态展示和自动化质量门。

### Checkpoint: Standalone Batch Generation

- [x] 原“单独生成文案”和“单独生成图片”组件及 API 行为不变。
- [x] 每条严格按文案后图片执行，一条失败不会阻断后续条目。
- [x] Live 费用只在明确确认后发生，Mock 图片不被描述为真实模型产物。
- [x] 定向/全量测试、类型检查和生产构建通过。
- [ ] 已登录浏览器中的页面交互检查；当前可用浏览器均被现有登录页拦截。

### Standalone Batch Generation Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 并发触发现有互斥锁并造成 409 | 高 | 浏览器端严格顺序执行，复用单次接口而不提高并发 |
| 一条失败导致整批停止 | 高 | 每条独立捕获错误、记录阶段并继续下一条 |
| Live 批量费用被低估 | 高 | 启动前展示条目数和图片页数范围，并执行一次显式确认 |
| 页面刷新后丢失批次视图 | 中 | 单条记录仍由现有接口持久化；服务端批次恢复留作独立后续需求 |

## Phase 21: Split Batch Copy and Image Generation

- [x] Task 80: 将批量生文与批量生图拆为独立路由和导航入口。
- [x] Task 81: 批量生文在文案保存后停止，支持恢复待质检记录并逐条人工确认。
- [x] Task 82: 批量生图只读取人工确认记录，保持顺序执行、失败隔离和费用确认。
- [x] Task 83: 完成全量测试、生产构建和运行态验证。

### Checkpoint: Manual Copy Gate Before Batch Images

- [x] 批量生文不调用图片接口，批量生图不调用文案生成接口。
- [x] 跳过自动审核不等于人工质检通过。
- [x] 旧批量地址兼容跳转，两个单次工作台保持不变。
- [x] 502 项全量测试、类型检查和生产构建通过；Chrome 管理员会话完成桌面与 375px 运行态检查且控制台无错误。

## Phase 22: Batch Copy Grouping

- [x] Task 84: 定义并实现批次元数据、旧库迁移、聚合查询和 API 契约。
- [x] Task 85: 批量生文页增加批次命名、筛选、状态恢复与历史展示。
- [x] Task 86: 完成全量自动化、构建、浏览器验证和差异复核。

### Checkpoint: Recoverable Copy Batches

- [x] 一次提交中的混合内容共享唯一批次 ID，批次名称不进入提示词。
- [x] 页面刷新后可按批次找回成功、运行中和失败记录。
- [x] 旧记录保持未分组，单条生成和人工质检流程无回归。

## Proposal 2026-09-04: 执行机文案案例匹配

状态：用户已确认方案，已实施并完成验证（2026-09-04）。

2026-09-04 补充：用户要求放开字符数量、不进行截断。生成链路取消硬编码的 8,000/12,000 字符知识裁剪及 30,000 字符 prompt 拒绝条件；全文传递，以实际模型上下文容量作为调用边界。

### 需求与现状

- 执行机先把 Query 和所有优秀文案案例的分析摘要交给模型逐条评分；以 0–100 分表示匹配度，70 分及以上合格，再从合格案例中选最高分的一条。
- 仅把胜出案例的完整 analysis 加入本次文案生成的系统提示词内容，不改写中心已发布的 TEXT_SYSTEM。
- 当前 executeCopyClaim 把中心 COPY 知识拼入 referenceText，最多保留 8,000 字符；没有评分、门槛或完整分析选择。
- configurationSnapshot 已查询全部 ACTIVE 条目的 PUBLISHED 版本，并包含 itemId、versionId 和 content。文案知识现有字段包含 summary 和 analysis，可复用领取时的完整快照，无需新增数据库字段或在执行中读取最新知识。
- 当前“优秀案例”按已入库、有效且已发布的 COPY 知识定义；没有独立的优秀标记或质量门槛，不凭空添加筛选条件。

### 执行流程

1. 执行机领取文案任务，固定 Query、提示词、模型配置和知识版本。
2. Query 审核通过后进入 KNOWLEDGE_MATCH 阶段，提取所有 COPY 案例的 itemId、versionId、summary。检查摘要和完整分析均存在；历史 text 字段只能作为完整分析的兼容来源，不能冒充摘要。
3. 调用当前执行机文案模型，把 Query 与全部摘要发送给模型。在模型上下文及评分输出预算允许时一次调用；容量不足时按完整案例分批，每批携带同一 Query 和相同绝对评分标准，确保每条案例都参与。禁止关键词预筛、只取前 N 条或截断任何摘要，不再以固定字符数决定分批。
4. 模型返回 JSON scores 数组，每条包含 versionId、score、reason。评价主需求、主题、目标读者/使用场景和表达结构的适配程度；70 分代表主需求一致且分析方法可以直接用于当前 Query，不按批内相对排名打分。
5. 程序校验结果逐条完整覆盖候选、ID 属于当前批次且不重复、score 为 0–100 有限数值。缺失、重复、越界、未知 ID 或格式错误触发有界重试；仍失败则报告匹配阶段失败，禁止用不完整结果选最优。
6. 程序按 score >= 70 过滤并选最高分；同分按稳定的 itemId、versionId 顺序决胜。记录模型原始得分，不四舍五入后跨过门槛。
7. 根据胜出 versionId 从同一快照取得完整 analysis；组合基础 TEXT_SYSTEM、固定案例使用规则和独立标记的案例数据区块，供首稿生成及必要修复复用。
8. 继续现有联网研究和文案生成流程，并在结果中保存匹配记录、耗时及最终引用的版本。

### 提示词与边界行为

- Query、摘要、分析及模型返回均是不可信数据；采用转义后的独立数据区块。案例可指导写法和结构，不成为覆盖编辑规则的命令，也不能充当当前选题的事实来源。
- buildPostPrompt 当前先渲染管理员模板；案例应在模板渲染后组合，避免分析里的占位符被展开或被标为管理员发布的规则。
- 当前客户端把系统提示词内容组合成一个 prompt 发送；本方案沿用这一调用契约。它不等同于另设传输层 role=system；若后续要求独立 system 消息，须另行扩展各模型适配器。
- 当前 OpenClaw、Dots 和 DeepSeek 模拟文本客户端的 30,000 字符上限是项目自身校验，实施时取消这些 prompt 字符上限，保留非空和类型检查。
- 所有案例摘要和选中案例的完整分析原样保留，转义仅用于结构隔离；超过旧的 8,000/12,000/30,000 字符也不得裁剪或仅因字符数拒绝。
- 实际实现不猜测模型 token 容量：首先全文发送全部摘要，按适配器识别的真实上下文或输出容量错误二分完整案例重试；不能将字符数等同于 token 数。每批使用同一评分标准，覆盖全部案例后才能选优。
- 若单条摘要或基础提示词加选中案例的完整分析本身超过模型可接受容量，明确报告上下文不足，不删除、缩写或截断内容。容量未知时不得编造限制或承诺无限输入，应保留服务端明确的超限错误供处理。
- 用户已整体确认方案：案例库为空或所有有效分数低于 70 时，记录 EMPTY/NO_MATCH，使用基础提示词继续生成。
- 数据损坏、模型超时或无效响应属于失败，不得伪装为 NO_MATCH；匹配阶段有限重试后按现有执行失败机制处理。

### 实施顺序

1. 取消 OpenClaw、Dots、DeepSeek 模拟文本调用的 30,000 字符硬限制，并用 fake 调用验证超过旧上限的 prompt 完整到达请求。新增 src/copy-knowledge-match.mjs，完成候选整理、容量适配分批、评分提示词、输出校验及确定性选优。
2. 在 generateCopy 的 Query 审核之后接入可选的案例集合；执行机传入快照，替换原 taskWithKnowledge 拼接逻辑，并添加阶段进度。DeepSeek 模拟执行入口复用同一规则，保留模拟标记。
3. 在 post-contract 中组合案例参考区块，使生成与修复遵守相同引用；验证未选中案例不会进入生成提示词。
4. 扩展生成结果的 generation.knowledgeMatch 和 timing，并经现有 completeCopy JSON 持久化。记录 candidateCount、scoredCount、scores、status、threshold、selectedItemId、selectedVersionId、模型、评分规则版本及分析哈希；完整内容由执行快照追溯。
5. 定向及现有测试回归，使用 fakes，不消耗真实模型额度；更新分布式执行说明。

### 验收与检查点

- 核心检查点：69.99 不合格、70 合格、最高分唯一选中、同分结果稳定；多批总评分数等于候选数，后续批次里的最高分可胜出。
- 提示词检查点：只出现胜出案例的完整分析，管理员模板原文不被持久化修改，案例中的标签/占位符不能逃出数据边界。
- 长度检查点：超过旧字符上限的合法输入完整到达模型适配器；多批次不截断任何摘要；实际上下文不足与普通连接失败分别处理，单条分析超限不能静默压缩。
- 执行检查点：EMPTY/NO_MATCH 正常生成；评分调用失败或数据不完整阻断生成；Query 被拒绝时不调用匹配模型。
- 结果检查点：中心完成记录可追溯案例版本、模型、分数、阶段耗时；普通重试继续遵守现有快照策略。
- 交付检查点：正式执行机和模拟执行机测试通过、现有文案输出兼容；仅在实施阶段按改动范围运行必要回归。

### 实施验证记录

- 新增 `src/copy-knowledge-match.mjs`，正式与模拟执行入口共用；新增匹配单元测试、生成集成测试和模型适配器容量测试。
- `npm test`：653 项测试通过，无失败或跳过；`npm run typecheck`、`npm run build` 通过。
- 独立只读审查未发现必须修改的问题；检查了分批部分失败、完整分析引用、质检修订和快照重试。模型适配器的长输入及容量错误由 fake fetch/runner 测试验证。
- 复用现有中心快照和结果 JSON，无数据库变更。执行机更新并重启后使用新流程；本次未部署或启动生产执行。
