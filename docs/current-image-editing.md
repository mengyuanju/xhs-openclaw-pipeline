# 当前图片修改工作台

基线：`auto-clow-poker` 的 `4c8d63b`。实现分支：`codex/current-image-editing`。
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

运行机前置条件：现有 Node/Sharp/Codex 环境，以及 PATH 中的 Tesseract 和 `chi_sim`、`eng` 语言包。添加文字会调用图片编辑模型，并在每次结果后运行本地 OCR；精确合成/恢复只运行本地 OCR。文字结果要求指定短句只出现一次、位于指定安全区域、无错字、无白名单外文字、无低置信度字符且不遮挡已有文字；失败时沿用当前图片生成逻辑，以上一次结果为输入最多自动修复三次，仍失败则显式进入 FAILED，不能采用，也不会切换为程序叠字。当前开发机未检测到 Tesseract，所以真实中文 OCR 尚未人工验收。

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

新增测试包括真实的隔离 PostgreSQL 18 数据库、假 OCR/假模型、像素比较和真实无头浏览器交互。不会消耗模型额度，测试产物不代表真实 AI 输出。

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

验收记录：新增功能专项 21 项通过；类型检查、Next 生产构建通过。服务端全量 552 通过、14 跳过、0 失败（默认跳过显式启用的 PostgreSQL E2E）。根目录全量 1140 通过、1 跳过、3 项旧 UI 契约失败：duplicate-query-cleanup-ui、task-assignment-ui、web-statistics-ui；均在独立 `4c8d63b` 工作区复现。显式运行旧 modular-workflow PostgreSQL E2E 为 9 通过、4 失败，基线也为同样结果：三项历史迁移名单断言过时，一项工作流能力版本断言仍期望旧值。没有为本功能修改这些不相关契约。

真实验收仍需：准备已批准文案对应的真实三页图集和中文 OCR；验证中文实际字形与安全区、真实产品裁剪/抠图、全图编辑、局部矩形/画笔编辑、参考实体一致性；确认费用后运行单次 worker；比较源/结果、明确采用、重新审核，并核对旧交付已撤销。当前未消耗真实模型额度。

与并行分支合并：保留 0050 优先级、0051 质检迁移，不重编号为这些预留值；0052 独立新增。`http-server.mjs`、`postgres-repository.mjs`、`final-delivery.mjs`、`task-review-dialog.tsx` 是主要冲突点。保留本分支的图集成员视图和交付闸门，同时保留 0051 的文案强制复检条件。0050 后续若接管编辑队列，沿用独立租约和 IMAGE_MANUAL_EDIT 原因，不让普通任务领取路径误领；本分支未实现通用管理员优先级。
