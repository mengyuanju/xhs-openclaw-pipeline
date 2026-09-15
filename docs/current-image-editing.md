# 当前图片修改工作台

基线：`auto-clow-poker` 的 `4c8d63b`。实现已合并到集成分支 `codex/integrate-workflow-upgrades`。
只使用中央 PostgreSQL；没有调用旧 SQLite image-edit store/worker，没有启用发布或生产定时任务。

## 页面与操作

管理员打开任务图片审核/归档对话框，选中当前页，点击“修改图片”。仅允许已批准文案、无未完成强制文案质检、且处于 MANUAL_ARCHIVE/REVIEWED 的任务。

- 添加文字：只处理“人工生成标识”。作业员可把默认的“AI生成”改成 1～12 个文字、数字、下划线或短横线；位置固定在右下角，不再选择文字类型、字号、颜色、底色、透明度或边距。最终仍由图片编辑模型把标识自然融入图片，绝不使用程序叠字兜底。自定义标识会替换当前页已有标识，不会同时保留两条。
- 实体替换：作业员只上传一张真实产品图片。系统把原图作为编辑底图、上传图作为身份参考，通过图生图把对应物品替换为真实产品并自然融合；不再提供精确贴图、坐标、裁剪、层级、透明度和抠图。生成后另做参考产品身份、外形、颜色、标志和关键细节的一致性校验。
- 局部修改：作业员只在说明中同时写清“改哪里”和“改什么”，例如“把画面右上角的白色水杯改成蓝色”。系统把原图和说明交给图生图模型，由模型按文字定位目标；所有未点名区域和已有文字都要求保持不变。新界面不再画选区或填写坐标。历史已创建的遮罩任务仍按原遮罩逻辑执行。
- 处理记录展示状态、失败原因、审计、校验结果、重试、拒绝、取消和采用。支持修改前后滑动对比、缩放及选择某一结果比较。
- 恢复历史图集也先排队校验、生成恢复预览，仍需明确采用；只能恢复当前批准文案对应的历史版本。

参考图自身不能进入交付图集。历史 `COMPOSITE` 和 `AI_FULL` 记录仍可查看、重试或恢复，但新界面不再创建这两类请求。

三项新操作都使用管理员“提示词 → 图片编辑（IMAGE_EDIT_SYSTEM）”中当前已发布的规则。提示词页面的说明会明确标注使用位置为“人工生成标识、真实产品 AI 融合替换、局部修改”。创建请求时会冻结提示词版本、内容和哈希；后续重试继续使用原版本。作业员填写的局部说明和上传图片作为不可信任务数据附加，不能覆盖管理员规则。未发布图片编辑提示词时不允许创建会调用图片模型的新请求。

## 状态与运行

`DRAFT → QUEUED → RUNNING → PREVIEW_READY → ACCEPTED / REJECTED`

可取消草稿、排队、执行和预览请求；失败进入 FAILED，可明确重试，最多三次执行。每次领取带独立租约 token；领取使用 `FOR UPDATE SKIP LOCKED`，执行期间续租。过期任务进入 FAILED，不自动重复收费。取消/过期后，旧执行无法回传生效；AI 调用在下一次续租检查时收到中止信号。

中心服务不再运行图片编辑模型，也不再提供中心机单次改图入口。手动改图与普通生图统一进入图片执行机的 `IMAGE` 容量池；只有启用图片能力的执行机才会领取。中心在同一领取事务中按任务优先级、等待补偿和负责人轮转统一选择普通生图或改图，`PAUSE` 任务不会被领取。改图占用现有 `EXECUTOR_IMAGE_CONCURRENCY`、共享 Codex 总许可和图片许可，不会额外开启一套并发。

执行机通过租约绑定的远程 HTTP 协议读取冻结上下文、源图和参考图，回传校验记录及最终 PNG；中心复核执行身份、源版本、PNG 尺寸/格式和校验哈希后落库。领取回执、校验提交和结果提交均支持不重放模型的网络重试。旧中心缺少 `imageEditExecutorVersion=1` 时，新图片执行机会在注册前停止并提示先升级；旧执行机不声明该版本，因此升级期间不会误领改图。

运行机只需要现有 Node/Sharp/Codex 环境，不安装或下载本地 OCR。源图和每次编辑结果都复用系统现有 `createImageAlignmentValidator` 与视觉模型进行文字、语义、布局和位置验收；其模型原始结论与程序比较结果一并保存。管理员可在“生产配置 → 图片与输出”把单页“添加文字”质检失败后的自动修复次数设为 0、1 或 2；首次生成不计入修复次数，设置在创建编辑请求时冻结。添加文字失败时以上一次结果为输入继续修复，达到上限仍未通过则显式进入 FAILED，不能采用，也不会切换为程序叠字。真实产品替换、局部修改和恢复同样经过现有视觉验收，但当前不会自动生成修复轮次。

全局 `productionDisclosure` 作为必需文字重新校验；新增文字也加入后续编辑的文字白名单。输出目标页为 1086×1448 PNG，其余页面复用原资产及原格式。源图不可覆盖。每次编辑新建完整 image run，目标页新资产，其他页通过成员关系引用原资产。结果包括父资产、源运行、文案版本、编辑操作、参考哈希、遮罩和校验记录。

创建修改时撤销旧 READY 交付并使用已有预览撤销队列；当前状态回到 MANUAL_ARCHIVE。采用时再次校验源版本和输出文件哈希，再切换当前图集、清空图片审核信息。尚有当前源图的待处理编辑时禁止重新进入交付池。采用后必须重新图片审核/人工归档。

## 数据迁移

基础数据迁移为 `server/migrations/0052_image_editing.sql`；执行机接管迁移为 `server/migrations/0056_executor_image_edits.sql`：

- `image_edit_requests`：版本快照、操作配置、状态、次数、租约、操作者、失败/校验信息，`requeue_reason=IMAGE_MANUAL_EDIT`。
- `image_edit_reference_assets`：请求与参考资产绑定、排序、用途、sha256。
- `image_edit_results`：目标资产、完整运行、遮罩、校验、采用状态。
- `image_edit_events`：创建、上传、执行、采用、拒绝、恢复、重试、取消及过期审计；动作 requestId 在任务内唯一。
- `assets` 新增 `parent_asset_id`、`asset_role`、`edit_metadata`；保留原有图片生产链字段。
- `image_run_asset_members` 与 `image_run_asset_view`：支持跨运行复用资产。任务详情、图片问题资产校验、交付归档检查和格式重处理读取此视图。
- `image_runs.execution_id` 允许 NULL：人工编辑不伪造普通模型任务执行。
- `image_edit_requests.execution_id` 绑定真实执行机的合成 `IMAGE` 执行；用于共享容量、模型调用审计、心跳和节点追踪。编辑生成的 `image_runs.execution_id` 也指向该执行。

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

执行机另使用 `/v1/executions/claim-image[-batch]` 统一领取，并通过 `/v1/executions/:executionId/image-edit/*` 完成上下文读取、租约心跳、受限资产下载、校验暂存、PNG 回传和失败上报。这些机器接口不接受普通用户会话代替执行机调用。

创建/恢复必须提供 `requestId, sourceImageRunId, sourceAssetId, copyRevisionId, sha256, targetPage`。创建还提供 operation 及对应 overlay/references/instruction；新建局部修改不提交 mask，历史客户端仍可提交合法 mask。直接排队的添加文字和所有 AI 操作必须提供 `confirmation=LIVE_IMAGE_COST_ACCEPTED`；仅保存草稿不会调用模型，可以稍后在“提交草稿”时确认费用。新界面的文字 overlay 固定为 `AI_DISCLOSURE / AI_GENERATED / bottom-right`，服务端也会覆盖旧式样式参数，只接受合规标识文字。真实产品替换只绑定一张参考图。动作接口必须提供 `requestId, version, reason`；草稿首次提交或未保留旧确认的失败任务重试还需费用确认。源版本变化返回冲突，无法覆盖新图集。重复 requestId 不重复采用或审计，复用到不同输入会拒绝。

上传限制：PNG/JPEG/WebP 文件签名与解码格式一致，拒绝 SVG、动画、截断及伪造 MIME；每个文件原始大小 ≤5 MiB、像素 ≤16M、规范化后 ≤10 MiB。每请求 ≤4 图、合计 ≤20 MiB/32M 像素；每任务累计 ≤20 参考资产/50 MiB。去除 EXIF 后统一保存 PNG，同时保存原始与规范化 sha256、原始类型、尺寸、上传人、用途、来源。路径仅由服务器生成，不使用客户端文件名。

## 验证与合并

自动化测试包括真实的隔离 PostgreSQL 18 数据库、假视觉模型/假图片模型、像素比较和真实无头浏览器交互；默认不会消耗模型额度。另有默认跳过、必须显式开启的真实模型端到端测试。

```text
node --test tests/current-image-editing.test.mjs server/tests/image-editing-http.test.mjs
RUN_POSTGRES_E2E=1 node --test server/tests/image-editing-postgres.test.mjs
RUN_POSTGRES_E2E=1 node --test server/tests/image-quality-flow-postgres.test.mjs
RUN_IMAGE_EDIT_BROWSER=1 node --test tests/current-image-editor-browser.test.mjs
RUN_IMAGE_QA_BROWSER=1 node --test tests/image-quality-browser.test.mjs
RUN_LIVE_WORKFLOW_PAID_E2E=1 node --test server/tests/live-workflow-paid.manual.test.mjs
npm run typecheck
npm run build
npm --prefix server test
npm test
```

PowerShell 中先设置对应的环境变量。PostgreSQL 测试和付费真实模型测试默认自行启动并删除一次性本地 PostgreSQL 18 集群，也可显式提供专用本地维护库地址；不会读取生产 `DATABASE_URL`。浏览器测试默认使用已安装的 Edge，`IMAGE_EDIT_BROWSER_CHANNEL` 可指定 Chrome。测试依赖安装树中已有的 esbuild/playwright-core。

2026-09-15 集成验收：图片编辑 PostgreSQL 生命周期 9/9、图片初审与独立质检 PostgreSQL 端到端 1/1、图片编辑与图片质检浏览器端到端 2/2；根目录全量 1160 通过、2 跳过、0 失败，服务端全量 575 通过、19 跳过、0 失败；全仓类型检查和两套生产构建均通过。

当前纯提示词定位版真实模型完整端到端测试已通过：管理员设置最高优先级、100% 文案抽检、整批打回、返工后强制复检、复检通过前阻断图片生成，随后串行完成并采用指定单页添加“AI生成”、珊瑚红马克杯实体参考图 AI 融合和无蒙版提示词局部背景修改。`openai/gpt-image-2` 每种编辑各调用 1 次，共 3 次真实图片编辑和 7 次视觉验收；新增文字识别为“低成本也能保持AI生成”且仅出现一次，位置、实体一致性、必需文字和输出尺寸均通过。人工检查确认原标题、合规标识和马克杯在后续编辑中保持一致，局部修改只增加浅鼠尾草绿背景渐变。本轮没有发布，产物保存在 `output/live-e2e/1789457682976/attempt-1`。

迁移顺序已经集成为 0050 优先级、0051 文案质检、0052 图片编辑、0053 账号权限与审核分配协调、0054 交付批次、0055 图片初审与独立质检、0056 执行机改图。图片编辑继续使用独立租约和 `IMAGE_MANUAL_EDIT` 原因，但由中心统一图片领取事务安全分派给声明新版能力的图片执行机。
