# 小红书 × OpenClaw 内容工场

本项目把 Excel 选题批量转为 SQLite 任务，通过独立 OpenClaw worker 生成 3–5 张图的小红书图文草稿，再进入本机 Web 后台做文案修改、图片修订、图生图和人工审核。它不会自动发布到小红书。

## 能力范围

- `.xlsx` 最多 5 MiB / 5,000 行，先预检、后确认入队，重复确认不会重复建任务。
- 文本、图片、图片编辑三类系统提示词支持不可变版本、发布和回滚。
- 任务入队时固定提示词内容、版本与 SHA-256，后续全局修改不污染在途任务。
- 文案和图片修改保留父子版本；审核通过后再次编辑会自动回到待审核。
- 参考图可以进入文生图流程；审核端 AI 图生图请求由后台 worker 异步消费。
- 视觉知识库可从优秀图片提炼结构化配方；默认只保存提示词，只有自有或已授权图片允许长期保留并进入参考图生成。
- 默认只监听 `127.0.0.1`；显式启动局域网模式后，所有页面和 API 仍要求管理员登录。

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
priority/优先级, metadata/元数据
```

`imageCount` 只能为 3–5，`metadata` 必须是 JSON 对象。页面流程为“上传与结构预检 → OpenClaw 需求检测 → 人工复核 → 确认入队”；所有结构合格行完成筛选前不能提交。

如工作表已经完成业务筛选，还可提供 `是否有效`、`废弃原因`、`需求强度判定`、`判定简要说明`，页面会直接带入并允许人工修正；未提供判定的结构合格行会在上传请求中调用 OpenClaw 文本模型自动检测。检测按最多 50 行和有界字符预算分批，全部批次通过严格 JSON 校验后才创建预览批次；任何一批缺行、重复行、非法档位或调用失败，整次上传都会失败，不会写入半成品批次。

需求强度支持“强需 / 中需 / 弱需 / 无需”：强需、中需进入生产队列，弱需、无需只保留在筛选记录中。页面展示判定来源和实际模型名，管理员修正后来源变为人工。可用 `XHS_SCREENING_MODEL` 单独指定检测模型；未设置时沿用 `XHS_TEXT_MODEL` 或 OpenClaw 客户端默认文本模型。大批次会增加上传等待时间和模型费用，常规自动化测试只使用 Fake，不消耗额度。

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

视觉图片默认存放在 `data/knowledge/`，可用 `XHS_KNOWLEDGE_ROOT` 覆盖；视觉分析模型可用 `XHS_VISION_MODEL` 覆盖。全部 3–5 张交付图都会按顺序调用图片模型；第二张起使用第一张规范化图片作为风格参考，Sharp 只负责统一裁切为 1080×1440 PNG。真实模式每个任务会产生 3–5 次图片模型调用，不应在未配置预算和限流时批量执行。

## Worker

导入批次确认入队后，页面会显示“4. 启动文案与图片生成”。点击按钮并确认真实模型费用后，后台会按全局队列顺序异步启动 Live Worker；单次最多 20 条，网页无需保持等待。生成状态、失败原因和最终内容在“内容审核”页面查看。网页启动不会自动发布，也不会接受客户端传入的命令、路径或模型参数。

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
npm run worker:drain -- --live --max 20
```

真实模式会产生模型调用成本。订阅账号/OAuth 不适合作为每天 1000 条的长期批量额度；生产使用前应配置正式 API 预算、速率限制、失败重试和用量告警。

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
