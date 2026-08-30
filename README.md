# 小红书 × OpenClaw 内容工场

本项目把 Excel 选题批量转为 SQLite 任务，通过独立 OpenClaw worker 生成 3–5 张图的小红书图文草稿，再进入本机 Web 后台做文案修改、图片修订、图生图和人工审核。它不会自动发布到小红书。

## 能力范围

- `.xlsx` 最多 5 MiB / 5,000 行，先预检、后确认入队，重复确认不会重复建任务。
- 文本、图片、图片编辑三类系统提示词支持不可变版本、发布和回滚。
- 任务入队时固定提示词内容、版本与 SHA-256，后续全局修改不污染在途任务。
- 文案和图片修改保留父子版本；审核通过后再次编辑会自动回到待审核。
- 处于待审核或审核通过状态、且当前交付文件完整的任务可导出 ZIP，内含当前文案、真实审核状态和按页序排列的完整图片。
- 参考图可以进入文生图流程；审核端 AI 图生图请求由后台 worker 异步消费。
- 视觉知识库可从优秀图片提炼结构化配方；默认只保存提示词，只有自有或已授权图片允许长期保留并进入参考图生成。
- 默认只监听 `127.0.0.1`；显式启动局域网模式后，所有页面和 API 仍要求管理员登录。
- 生产配置中心统一管理 1 分质量修复策略和“AI生成”标识；数据统计页汇总批次耗时、评分分布和修复表现。
- Live 新文案会先通过 OpenClaw 检索公开资料，保存检索词、提供方、尝试链、标题、URL、摘要和时间，再把固定研究快照交给文本模型。
- Live Worker 在联网检索前执行 Query 审核，并在正文结构校验后、视觉规划前执行独立文本审核；不通过时不继续生图。

## 环境

- Node.js 24.14+（Web 后台与 Worker）
- OpenClaw 2026.5.7+
- 真实模式需要 OpenClaw 中可用的文本与图片模型授权

OpenClaw 进程使用的 Node 还必须满足已安装 OpenClaw 的 `engines.node` 约束；
如果后台使用的 Node 不兼容，可在 `.env.local` 单独指定兼容运行时，不会替换系统 Node：

```dotenv
OPENCLAW_NODE_PATH=C:\path\to\compatible\node.exe
```

文案默认使用 `openai/gpt-5.6-sol`；如需固定其他已授权模型，可在 `.env.local`
设置 `XHS_TEXT_MODEL=provider/model`。需求检测默认沿用该值。
两道阶段审核可用 `XHS_REVIEW_MODEL=provider/model` 单独指定；未设置时沿用 `XHS_TEXT_MODEL`。
逐页 OCR/图文验收可用 `XHS_VISION_MODEL=provider/model` 单独指定；最终 0–3 分终审可用
`XHS_QUALITY_MODEL=provider/model` 指定不同模型，以减少生成模型自评偏差。

如 TUN/Fake-IP 会中断 OpenClaw 的长图片连接，可只为图片生成与编辑子进程配置本机代理，
避免影响文本 Responses 链路：

```dotenv
XHS_IMAGE_PROXY_URL=http://127.0.0.1:7897
```

单次图片生成/编辑默认等待 5 分钟；如需调整，可设置
`XHS_IMAGE_TIMEOUT_MS=300000`（允许 30000–540000 毫秒）。整段进程超时不会在同一任务租约内自动重跑；错误会同时保留进程异常和 OpenClaw 日志，避免把认证路由提示误报为根因。`drain` 任务并发可用 `--concurrency 1|2` 或 `XHS_TASK_CONCURRENCY=1|2` 控制，默认为 2。单任务图片并发可用 `XHS_IMAGE_CONCURRENCY=1|2` 控制；当任务并发为 2 时，每个任务的图片并发会强制为 1，使同一 drain 内的总模型调用并发不超过 2。

## 启动后台

首次使用先在主机终端配置管理员密码。输入过程不会回显，项目只保存 scrypt 哈希：

```powershell
npm install
npm run auth:setup
npm run dev
```

生产构建与本机启动：

```powershell
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。数据库默认为 `data/queue.db`，生成交付在 `output/`，审核素材在 `data/assets/`；这些目录不会进入 Git。

### 局域网登录

完成密码配置后，构建并显式监听局域网地址：

```powershell
npm run build
npm run start:lan
```

同一私有局域网的设备打开 `http://<这台电脑的局域网IP>:3000`，使用刚设置的管理员密码登录。默认允许 loopback、`10/8`、`172.16/12`、`192.168/16`、IPv4 link-local 和 IPv6 ULA/link-local；如需使用电脑主机名，在 `.env.local` 添加 `XHS_ALLOWED_HOSTS=主机名` 后重启。

`start:lan` 不等于公网部署。它只适用于可信家庭/办公局域网；不要在来宾 Wi-Fi、端口映射或公网服务器上直接使用 HTTP。跨网段或公网部署必须增加 HTTPS 反向代理、防火墙白名单和更完整的身份系统。

## Excel 导入

首个工作表必须包含 `query`、`查询`、`选题` 或 `主题` 之一。可选列：

```text
externalId, category/分类, targetAudience/目标用户,
promptSet, imageCount/图片数量, referenceImageFiles/参考图,
referenceUrls/参考链接, referenceText/参考资料,
priority/优先级, metadata/元数据
```

`imageCount` 为旧模板兼容字段，填写时仍只能为 3–5；Live 生成不会把它当成固定交付数，而会根据最终正文结构自动选择最少且足够的 3–5 张，并把实际数量写回任务记录。`metadata` 必须是 JSON 对象。页面流程为“上传与结构预检 → OpenClaw 需求检测 → 人工复核 → 确认入队”；所有结构合格行完成筛选前不能提交。

如工作表已经完成业务筛选，还可提供 `是否有效`、`废弃原因`、`需求强度判定`、`判定简要说明`，页面会直接带入并允许人工修正；未提供判定的结构合格行会在上传请求中调用 OpenClaw 文本模型自动检测。检测按最多 50 行和有界字符预算分批，全部批次通过严格 JSON 校验后才创建预览批次；任何一批缺行、重复行、非法档位或调用失败，整次上传都会失败，不会写入半成品批次。

需求强度支持“强需 / 中需 / 弱需 / 无需”：强需、中需进入生产队列，弱需、无需只保留在筛选记录中。页面展示判定来源和实际模型名，管理员修正后来源变为人工。可用 `XHS_SCREENING_MODEL` 单独指定检测模型；未设置时沿用 `XHS_TEXT_MODEL` 或 OpenClaw 客户端默认文本模型。大批次会增加上传等待时间和模型费用，常规自动化测试只使用 Fake，不消耗额度。

## Query 与文本阶段审核

Live 生产顺序为“Query 审核 → 联网研究 → 正文生成与结构校验 → 文本生成后审核 → 视觉规划 → 逐页生图与验收 → 整套终审 → 人工审核”。Query 审核关注内容目标是否清晰、合法且可生产；文本审核关注主需覆盖、标题兑现、事实来源、风险边界和图片规划一致性。

- 审核不通过时失败关闭，不自动改写 Query 或正文，也不继续后续付费阶段。
- 当前尝试目录保存 `query-review.json` 和 `text-review.json`，每份结果绑定被审内容 SHA-256。
- `manifest.json` 与 SQLite `generation_runs.stage_reviews_json` 保存同一份有界证据；内容审核页按生成批次展示决策、模型、摘要和问题。
- Mock 只标记为 `MOCK 模拟验证`，不声称已经真实模型审核。

## 联网研究与来源保存

Live 且需要生成新文案的任务会在文本模型之前执行 OpenClaw `infer web search --json`。默认先尝试 Codex Hosted Search，再尝试无需密钥的 DuckDuckGo 后备；Codex 搜索使用 OpenClaw 已有的 OpenAI/Codex 登录，不需要为本项目另装一个 Codex 包。DuckDuckGo 集成基于非官方网页结果，适合作为可用性后备，不应被当成权威来源本身。

每次实际检索都会形成不可变研究快照：

- 当前尝试目录保存 `research.json`，包含检索词、实际提供方、每个提供方的成功/失败、脱敏错误、检索时间，以及最多 5 个去重来源的标题、URL、站点和摘要。
- `manifest.json` 记录研究状态、提供方和来源数，并把 `research.json` 纳入 SHA-256 文件清单。
- SQLite 的 `generation_runs.research_snapshot_json` 保存同一份有界快照；旧运行保持 `null`，不会补造来源。
- 成功快照写入 checkpoint。图片阶段失败后重试会复用同一资料，不会重复搜索或让同一文案的依据漂移。
- `post.sources` 只能从 Excel 的 `referenceUrls` 或本次 `webResearch.sources` 中选择；模型补出的其他 URL 会被结构校验拒绝并重试。

若 Codex 和 DuckDuckGo 都失败，或没有返回可用的公开 HTTP(S) URL，任务会在文本生成前失败，同时保留失败快照；不会在无资料时继续生成并声称已经核验。Mock 和人工文案仅重生图片不会联网。

当前接入保存搜索结果的摘要或 Codex 归纳文本，不等于读取网页全文。OpenClaw 的 `web_fetch` 需要当前安装中存在可用 fetch provider；未配置时本项目不会伪造正文抓取记录。官方能力边界见 [OpenClaw Web Search](https://docs.openclaw.ai/tools/web) 和 [OpenClaw Web Fetch](https://docs.openclaw.ai/tools/web-fetch)。

## 溯源规则提示词

三类运行提示词分别位于 `prompts/text-system.md`、`prompts/image-system.md` 和 `prompts/image-edit-system.md`。规则编号和原始来源映射保留在工作区上级文档 `图文生成统一系统提示词_原始文档溯源版.md`；运行提示词只包含规则正文，不携带 `[Rxxx]` 标签。

全新数据库会自动使用这些提示词。已有数据库需要显式发布新版本：

```powershell
npm run prompts:install-rules
```

该命令按内容哈希幂等安装并发布版本，不修改已入队任务固定的提示词快照。新版本只影响之后提交的任务。

## 视觉知识库

登录后台后打开 `/knowledge`。上传 PNG、JPEG 或 WebP 图片，系统会通过 OpenClaw `infer model run --file` 提炼图片类型、提示词模板、负面约束、风格标签和布局规则。图片中的文字始终按不可信数据处理，模型结果必须经过字段、枚举、变量和长度校验，并由管理员确认发布后才会进入生产。

保存模式：

- `PROMPT_ONLY`：只保存结构化配方和原图 SHA-256；分析临时目录会被删除。
- `IMAGE_AND_PROMPT`：保存规范化 PNG 和配方；仅允许 `SELF_OWNED` 或 `LICENSED`。

Worker 首次处理任务时，从已发布的 `MODEL_IMAGE` 配方中按分类、标签和质量分选择一条并锁定版本。每张图片的最终提示词按“全局图片规则 + 视觉配方 + 已生成的完整标题/正文 + 当前页计划”组合；授权保留图会进入受控 `referenceImagePaths`。重试继续使用同一版本，知识库为空时只省略配方部分。

文本模型的结构化输出里会同时包含 `imagePlan[].prompt` 作为逐页初始视觉方向；它不是直接提交给图片模型的最终提示词。文本审核通过后，系统还会基于完整正文生成独立 VisualPlan，再与图片系统规则、视觉配方和当前页白名单组合成实际生图提示词。

视觉图片默认存放在 `data/knowledge/`，可用 `XHS_KNOWLEDGE_ROOT` 覆盖；视觉分析模型可用 `XHS_VISION_MODEL` 覆盖。Live 交付图会先串行完成第一张，再让后续图片最多两张并发生成；第二张起都使用第一张作为只读风格参考。Sharp 只负责统一为 1080×1440 PNG，Live 主链路不再叠加第二层文字。最终图片继续执行逐页 OCR 与图文验收；合规标识由 `/settings` 的生产配置控制。真实模式至少产生 3–5 次图片模型调用，逐页修复和整套质量修复会增加调用次数，不应在未配置预算和限流时批量执行。

## 质量评分 V2

`qc.json` 使用规则文档的 0–3 分漏斗，并在 `rubric` 字段记录规则版本、分层得分、维度证据、类型校正和最低阻碍维度：

- 0 分：安全、法律、健康、隐私或严重误导红线。
- 1 分：需求未满足、严重重复，或任一适用基础可用维度低于 2。
- 2 分：所有基础维度合格，但仍有维度为 2 或轻微问题；进入人工审核。
- 3 分：所有适用维度均有明确高质量证据并达到 3，且没有问题标签；仍需人工确认，不会自动发布。

机械检查只能证明基础门槛，默认最高给 2 分。每个 Live 交付会在逐页 OCR 通过后，再由独立多图 VLM 对最终标题、正文和全部 3–5 张图片执行十维终审；可用 `XHS_QUALITY_MODEL` 与生成模型分离。首次终审恰好为 1 分时，默认以当前逐页图片为图生图输入，按照限制分数的证据重新生成整套图片，达到至少 2 分即停止，最多修复 2 次；每轮原因、方法、前后分数和耗时写入 QC 并在审核页展示。首次 0 分不进入该修复循环；2 分后继续现有逻辑，保存证据并被 3 分完成门禁退回。只有 3 分候选完成 Worker，仍需人工确认且不会自动发布。

## 生产配置与数据统计

登录后打开 `/settings` 可调整质量修复开关、触发分、目标分、最多修复次数，以及合规标识的开关和文字。最大整套修复次数限制为 2；配置在 Worker 领取任务时固定，并进入检查点指纹和交付清单。

打开 `/analytics` 可查看任务生成批次和导入批次的开始时间、结束时间、实际耗时、平均运行耗时、评分分布、修复次数和达标数量。历史记录缺少时间或修复详情时会明确显示“暂无数据”，不会反推或伪造统计值。

## Worker

导入批次确认入队后，页面会显示“4. 启动文案与图片生成”。点击按钮并确认真实模型费用后，后台会按全局队列顺序异步启动 Live Worker，最多同时生产 2 个完整任务；单次最多 20 条，网页无需保持等待。生成状态、失败原因和最终内容在“内容审核”页面查看。网页启动不会自动发布，也不会接受客户端传入的命令、路径、模型或并发参数。

每条新文案的基础 Live 流程通常会调用 4 次文本模型（Query 审核、正文生成、文本生成后审核、视觉规划）、3–5 次图片模型和 3–5 次逐页视觉验收；页面修复与整套质量修复可能增加额外调用。

如需通过终端操作，仍可使用以下命令。

Mock 单条，不调用模型：

```powershell
npm run worker -- --once --mock
```

Mock 连续消费，最多处理 1000 个内容或图片编辑工作项：

```powershell
npm run worker:drain -- --mock --max 1000
```

真实连续消费必须显式使用 `--live` 和上限。第一次建议从 10–20 条开始验证提示词、配图和预算：

```powershell
npm run worker:drain -- --live --max 20 --concurrency 2
```

真实模式会产生模型调用成本。订阅账号/OAuth 不适合作为每天 1000 条的长期批量额度；生产使用前应配置正式 API 预算、速率限制、失败重试和用量告警。

Live `worker` / `drain` 会在领取任何任务前执行一次 OpenClaw 无推理预检，检查兼容运行时、认证状态和当前文本/图片模型配置；预检失败不会增加任务 `attempts`。生成期间会在文本、视觉规划、逐页图片生成和视觉验收边界续租，长任务不会仅因超过默认十分钟而被重复领取。

每个任务在 `output/<task-id>/checkpoint.json` 保存配置指纹、已通过契约的正文、视觉计划和逐页图片检查点。失败重试仅在 Query、输入、固定提示词、生产配置、人工文案修订和参考图配置均未变化时复用；图片还必须同时满足当前视觉计划哈希、`alignment=PASS` 和文件 SHA-256 一致。检查点损坏、文件被修改、生产配置变化或人工文案变化时会安全失效并重新生成，不会把旧图片混入当前交付。

## 存储优化与保留策略

同一磁盘上的新生成图片会在 `output/` 与 `data/assets/` 之间使用硬链接，共享一份物理数据；文件系统不支持硬链接时自动回退为独占复制。每次内容生成结束后，Worker 会自动保留当前交付图片、全部人工编辑图片及其父素材、最新尝试的完整文件，以及所有历史尝试的 JSON/Markdown 记录；其他历史尝试图片和未被当前交付或编辑链引用的生成素材会被清理。素材数据库删除会写入 `STORAGE_RETENTION_CLEANUP` 审计记录，清理失败不会把已生成任务改判为失败。

检查现有数据可以释放的空间，默认只预览、不修改文件：

```powershell
npm run storage:optimize
```

确认报告后显式执行：

```powershell
npm run storage:optimize -- --apply
```

## 导出交付包

在“内容审核”打开单条任务。任务进入待审核且当前文案对应的完整图集已经生成后，即可点击“导出交付包”下载 `xhs-task-<ID>.zip`；无需先标记为审核通过。待审核包可用于线下复核，压缩包元数据会保留导出时的真实审核状态。压缩包中包含：

- `content.txt`：标题、正文和标签。
- `metadata.json`：任务、文案修订、图片页序和内容哈希。
- `images/`：当前文案对应的每页最新已验收图片。

## OpenClaw 登录

当前版本可使用：

```powershell
openclaw plugins enable openai
openclaw models auth login --provider openai-codex
```

CLI 版本变化时，以 `openclaw models auth login --help` 和 `openclaw models list` 为准。授权码、设备码、Token 和 API Key 都不应写入本项目或后台表单。

## 验证

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
```

安全边界：Query 和模型输出不会进入 Shell；SQL 参数化；上传图片由 Sharp 解码并限制体积/像素；文件路径限定在受控根目录；API 要求有效管理员会话，写操作还要求严格同源；提示词与审核操作保留版本和审计记录。
