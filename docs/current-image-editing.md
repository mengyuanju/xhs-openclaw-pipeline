# 当前图片修改工作台

基线：`auto-clow-poker` 的 `4c8d63b`。实现已合并到集成分支 `codex/integrate-workflow-upgrades`。
只使用中央 PostgreSQL；没有调用旧 SQLite image-edit store/worker，没有启用发布或生产定时任务。

## 页面与操作

管理员打开任务图片审核/归档对话框，选中当前页，点击“修改图片”。仅允许已批准文案、无未完成强制文案质检、且处于 MANUAL_ARCHIVE/REVIEWED 的任务。

- 添加文字：锁定指定图片页，输入逐字准确的短句并选择标题、副标题、正文要点、标签、AI 生成标识或自定义类型；支持 AI生成预设、可追踪 AI 标识类型、四角/上下/安全区域坐标、字号、颜色、底色、透明度、边距和风格描述。浏览器文字框只是传给模型的版式示意，最终图片复用现有 `createAgentClient().runImageEdit` 进行 AI 改图，绝不使用程序叠字兜底。
- 实体图片：最多四张参考图。默认精确合成，支持裁剪、缩放、坐标、层级、透明度及纯白背景的确定性抠图。AI 融合使用现有 `createAgentClient().runImageEdit`，明确展示实体细节可能改变及费用确认，另做参考实体一致性校验。
- 提示词修改：整图或矩形/画笔选区、必须保留内容、负面要求、费用确认。遮罩保存为独立 MASK 资产；二值遮罩仅替换白色区域，RGBA 遮罩外差异阈值为零。
- 处理记录展示状态、失败原因、审计、校验结果、重试、拒绝、取消和采用。支持修改前后滑动对比、缩放及选择某一结果比较。
- 恢复历史图集也先排队校验、生成恢复预览，仍需明确采用；只能恢复当前批准文案对应的历史版本。

预览中的裁剪/纯白抠图以生成后的结果为准；纯白抠图不等同于任意背景的语义分割。参考图自身不能进入交付图集。

## 状态与运行

`DRAFT → QUEUED → RUNNING → PREVIEW_READY → ACCEPTED / REJECTED`

可取消草稿、排队、执行和预览请求；失败进入 FAILED，可明确重试，最多三次执行。每次领取带独立租约 token；领取使用 `FOR UPDATE SKIP LOCKED`，执行期间续租。过期任务进入 FAILED，不自动重复收费。取消/过期后，旧执行无法回传生效；AI 调用在下一次续租检查时收到中止信号。

新增显式单次执行入口，在具备中央数据库及同一资产存储访问能力的运行机执行：

```text
node server/src/cli.mjs image-edit-once --environment=development
```

它只领取独立编辑队列，普通 IMAGE 任务领取不会领取编辑请求。此入口不安装后台服务、不自动轮询、不配置生产计划。部署者需要显式运行它；本次未新增远程 HTTP 领取/回传协议，也未将编辑任务接入现有普通 IMAGE 调度。

运行机只需要现有 Node/Sharp/Codex 环境，不安装或下载本地 OCR。源图和每次编辑结果都复用系统现有 `createImageAlignmentValidator` 与视觉模型进行文字、语义、布局和位置验收；其模型原始结论与程序比较结果一并保存。添加文字会调用图片编辑模型，失败时以上一次结果为输入最多自动修复三次，仍失败则显式进入 FAILED，不能采用，也不会切换为程序叠字。精确合成、局部修改和恢复同样经过现有视觉验收。

全局 `productionDisclosure` 作为必需文字重新校验；新增文字也加入后续编辑的文字白名单。输出目标页为 1086×1448 PNG，其余页面复用原资产及原格式。源图不可覆盖。每次编辑新建完整 image run，目标页新资产，其他页通过成员关系引用原资产。结果包括父资产、源运行、文案版本、编辑操作、参考哈希、遮罩和校验记录。

创建修改时撤销旧 READY 交付并使用已有预览撤销队列；当前状态回到 MANUAL_ARCHIVE。采用时再次校验源版本和输出文件哈希，再切换当前图集、清空图片审核信息。尚有当前源图的待处理编辑时禁止重新进入交付池。采用后必须重新图片审核/人工归档。

## 数据迁移

独立迁移 `server/migrations/0052_image_editing.sql`：

- `image_edit_requests`：版本快照、操作配置、状态、次数、租约、操作者、失败/校验信息，`requeue_reason=IMAGE_MANUAL_EDIT`。
- `image_edit_reference_assets`：请求与参考资产绑定、排序、用途、sha256。
- `image_edit_results`：目标资产、完整运行、遮罩、校验、采用状态。
- `image_edit_events`：创建、上传、执行、采用、拒绝、恢复、重试、取消及过期审计；动作 requestId 在任务内唯一。
- `assets` 新增 `parent_asset_id`、`asset_role`、`edit_metadata`；保留原有图片生产链字段。
- `image_run_asset_members` 与 `image_run_asset_view`：支持跨运行复用资产。任务详情、图片问题资产校验、交付归档检查和格式重处理读取此视图。
- `image_runs.execution_id` 允许 NULL：人工编辑不伪造普通模型任务执行。

迁移只在隔离测试数据库应用过，未操作生产数据库。使用现有数据库升级流程应用迁移。

## HTTP 接口

全部沿用 Koa 的响应封装和现有账户身份验证，第一阶段限 ADMIN；写入事务再次验证管理员账号、状态和凭据版本。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/tasks/:taskId/image-edit-references` | 上传 base64、mediaType、purpose、source |
| POST / GET | `/v1/tasks/:taskId/image-edits` | 创建请求 / 最近 100 条历史（含审计） |
| GET | `/v1/image-edits/:editId` | 请求、结果与审计 |
| POST | `/v1/image-edits/:editId/queue` | 提交草稿 |
| POST | `/v1/image-edits/:editId/retry` | 明确重试 |
| POST | `/v1/image-edits/:editId/cancel` | 取消 |
| POST | `/v1/image-edits/:editId/accept` | 校验并采用 |
| POST | `/v1/image-edits/:editId/reject` | 拒绝预览 |
| POST | `/v1/tasks/:taskId/image-versions/:runId/restore` | 创建恢复预览请求 |

创建/恢复必须提供 `requestId, sourceImageRunId, sourceAssetId, copyRevisionId, sha256, targetPage`。创建还提供 operation 及对应 overlay/references/mask/instruction；添加文字和所有 AI 操作都必须提供 `confirmation=LIVE_IMAGE_COST_ACCEPTED`。文字 overlay 包含精确短句及 `HEADLINE / SUBTITLE / BULLET / LABEL / AI_DISCLOSURE / CUSTOM` 类型。动作接口必须提供 `requestId, version, reason`。源版本变化返回冲突，无法覆盖新图集。重复 requestId 不重复采用或审计，复用到不同输入会拒绝。

上传限制：PNG/JPEG/WebP 文件签名与解码格式一致，拒绝 SVG、动画、截断及伪造 MIME；每个文件原始大小 ≤5 MiB、像素 ≤16M、规范化后 ≤10 MiB。每请求 ≤4 图、合计 ≤20 MiB/32M 像素；每任务累计 ≤20 参考资产/50 MiB。去除 EXIF 后统一保存 PNG，同时保存原始与规范化 sha256、原始类型、尺寸、上传人、用途、来源。路径仅由服务器生成，不使用客户端文件名。

## 验证与合并

自动化测试包括真实的隔离 PostgreSQL 18 数据库、假视觉模型/假图片模型、像素比较和真实无头浏览器交互；默认不会消耗模型额度。另有默认跳过、必须显式开启的真实模型端到端测试。

```text
node --test tests/current-image-editing.test.mjs server/tests/image-editing-http.test.mjs
RUN_POSTGRES_E2E=1 node --test server/tests/image-editing-postgres.test.mjs
RUN_IMAGE_EDIT_BROWSER=1 node --test tests/current-image-editor-browser.test.mjs
npm run typecheck
npm run build
npm --prefix server test
npm test
```

PowerShell 中先使用 `$env:RUN_POSTGRES_E2E='1'` 或 `$env:RUN_IMAGE_EDIT_BROWSER='1'`。浏览器测试默认使用已安装的 Edge，`IMAGE_EDIT_BROWSER_CHANNEL` 可指定 Chrome。测试依赖安装树中已有的 esbuild/playwright-core。

2026-09-15 集成验收：图片编辑单元测试 11/11、隔离 PostgreSQL 图片编辑闭环 8/8、合并工作流 PostgreSQL 闭环 15/15；根目录全量 1145 通过、1 跳过、0 失败；服务端全量 559 通过、18 跳过、0 失败；全仓类型检查、两套生产构建和 smoke 均通过。

真实模型端到端测试完成了：管理员最高优先级、100% 按人员抽检、整批打回、强制复检、质检通过后才开放图片、指定单页添加“AI生成”、视觉模型核对原标题/新增文字/位置/版式、明确采用。最终通过轮次使用 1 次 `gpt-image-2` 编辑和 2 次原有视觉验收，识别结果为“低成本也能保持AI生成”，没有发布。测试产物保存在 `output/live-e2e/1789407594135/attempt-1`。此前 3 次图片调用的结果因验收不通过而未采用；整个真实测试共发生 4 次图片编辑调用，Codex 订阅未提供可换算的逐次货币账单。

迁移顺序已经集成为 0050 优先级、0051 文案质检、0052 图片编辑、0053 账号权限与审核分配协调。0053 统一权限过滤、分配与返工计数；图片编辑继续使用独立租约和 `IMAGE_MANUAL_EDIT` 原因，不会被普通图片任务误领。
