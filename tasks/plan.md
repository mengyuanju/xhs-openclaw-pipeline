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
