# 当前图片修改工作台

基线：`auto-clow-poker` 的 `4c8d63b`。实现已合并到集成分支 `codex/integrate-workflow-upgrades`。
只使用中央 PostgreSQL；没有调用旧 SQLite image-edit store/worker，没有启用发布或生产定时任务。

## 页面与操作

管理员打开任务图片审核/归档对话框，选中当前页，点击“修改图片”。仅允许已批准文案、无未完成强制文案质检、且处于 MANUAL_ARCHIVE/REVIEWED 的任务。

- 添加文字：只处理“人工生成标识”。作业员可把默认文字改成 1～12 个文字、数字、下划线或短横线，并选择只应用到当前页，或批量应用到当前整套图片。每页只调用一次图片编辑模型，只把完整原图作为唯一输入，不使用蒙版，也不进行局部像素贴回。整套请求共享现代无衬线白字、约 32px 视觉字号、深炭色不透明圆角底框和内边距的统一样式指令。程序直接验收首次结果；文字错误、重复或不可读时直接失败，不再自动进行第二次修改。
- 实体替换：作业员上传一张真实产品图片，填写被替换物品的可辨识描述，并在原图上框选且只框住一个完整目标。“完整产品”模式要求参考图只有一个清楚、完整、遮挡很少的产品；“外观参考”模式允许手部、手腕、裁切或次要产品，但主产品必须清楚且唯一可识别。外观参考只迁移可确认的颜色、材质、表壳、屏幕、按钮、标志和关键细节，忽略手部、背景和次要产品，未展示部分沿用原目标结构、姿态和透视补全。无法唯一定位、框内包含其他受保护物体、目标被截断、主产品无法识别，或严格模式的参考图不完整时，会在调用图片生成模型之前失败，因此不会产生本次图片生成费用。定位通过后，系统把原图、参考图和目标蒙版交给图片编辑模型，仅允许模型改动框选区域；最终再用原图像素覆盖蒙版外区域，保证同类物品和其他内容不会被误改。生成后另做参考产品身份、外形、颜色、标志、关键细节、单目标替换和背景拓扑一致性校验。
- 局部修改：作业员在说明中写清“改哪里”和“改什么”，例如“把画面右上角的白色水杯改成蓝色”。系统先把原图与原说明交给视觉规划模型，识别唯一目标、源位置、目标位置和 1～4 个安全编辑区域。目标贴住画面边缘不再自动失败，只要可见部分足以完成修改即可；多个候选、必须覆盖受保护文字或确实依赖画外未知结构时才阻断。原说明涉及移动、原位置修复、贴边目标或缺少必要保护约束时，工作台先展示模型建议描述与编辑区域，尚不调用图片编辑模型；作业员可采用建议后继续，也可复用原说明自行修改。执行时使用多个区域的联合蒙版覆盖源位置、目标位置和自然修复范围，再过滤低幅背景漂移并用原图逐像素恢复蒙版外区域。生成后另用源图与结果图做语义验收，核对任务完成、目标数量、落点/原位置修复、文字和无关内容。历史已创建的遮罩任务仍按原遮罩逻辑执行。
- 处理记录展示状态、失败原因、审计、校验结果、重试、拒绝、取消和采用。支持修改前后滑动对比、缩放及选择某一结果比较。
- 恢复历史图集也先排队校验、生成恢复预览，仍需明确采用；只能恢复当前批准文案对应的历史版本。

参考图自身不能进入交付图集。历史 `COMPOSITE` 和 `AI_FULL` 记录仍可查看、重试或恢复，但新界面不再创建这两类请求。

人工生成标识、真实产品替换和局部修改都使用管理员“提示词 → 图片编辑（IMAGE_EDIT_SYSTEM）”中当前已发布的规则。创建请求时会冻结提示词版本、内容和哈希；人工重试继续使用原版本，人工生成标识不再自动修复。作业员填写的文字、局部说明和上传图片作为不可信任务数据附加，不能覆盖管理员规则。未发布图片编辑提示词时不允许创建这些模型改图请求。

## 状态与运行

`DRAFT → QUEUED → RUNNING → PREVIEW_READY → ACCEPTED / REJECTED`

可取消草稿、排队、执行、预览和失败请求；普通失败可明确重试，最多三次执行。可执行的局部修改建议暂存在 FAILED 记录中，但工作台显示为“待确认建议”；采用建议会冻结建议描述与区域并重新排队，避免第二次定位。每次领取带独立租约 token；领取使用 `FOR UPDATE SKIP LOCKED`，执行期间续租。过期任务进入 FAILED，不自动重复收费。取消/过期后，旧执行无法回传生效；AI 调用在下一次续租检查时收到中止信号。

中心服务不再运行图片编辑模型，也不再提供中心机单次改图入口。手动改图与普通生图统一进入图片执行机的 `IMAGE` 容量池；只有启用图片能力的执行机才会领取。中心在同一领取事务中按任务优先级、等待补偿和负责人轮转统一选择普通生图或改图，`PAUSE` 任务不会被领取。改图占用现有 `EXECUTOR_IMAGE_CONCURRENCY`、共享 Codex 总许可和图片许可，不会额外开启一套并发。

执行机通过租约绑定的远程 HTTP 协议读取冻结上下文、源图和参考图，回传校验记录及最终 PNG；中心复核执行身份、源版本、PNG 尺寸/格式和校验哈希后落库。领取回执、校验提交和结果提交均支持不重放模型的网络重试。中心和图片执行机通过 `imageEditExecutorVersion=5` 协商编辑能力：自然语言局部规划、建议采用和结果验收要求版本 5，外观参考实体替换要求版本 4；版本 3 执行机仍可领取严格实体替换与历史遮罩改图。

运行机只需要现有 Node/Sharp/Codex 环境，不安装或下载本地 OCR。人工生成标识由图片编辑模型在完整原图上单次绘制，不传蒙版、不做程序化像素拼接，并复用 `createImageAlignmentValidator` 核对必需文字和唯一出现次数。文字缺失、错字、重复、额外文字、OCR 置信度不足或尺寸错误会直接失败，不再触发自动二次修改。真实产品替换、局部修改和恢复继续按各自视觉验收规则执行。

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
| POST | `/v1/image-edits/:editId/apply-suggestion` | 采用局部修改建议并重新排队 |
| POST | `/v1/image-edits/:editId/cancel` | 取消 |
| POST | `/v1/image-edits/:editId/accept` | 校验并采用 |
| POST | `/v1/image-edits/:editId/reject` | 拒绝预览 |
| POST | `/v1/tasks/:taskId/image-versions/:runId/restore` | 创建恢复预览请求 |

执行机另使用 `/v1/executions/claim-image[-batch]` 统一领取，并通过 `/v1/executions/:executionId/image-edit/*` 完成上下文读取、租约心跳、受限资产下载、校验暂存、PNG 回传和失败上报。这些机器接口不接受普通用户会话代替执行机调用。

创建/恢复必须提供 `requestId, sourceImageRunId, sourceAssetId, copyRevisionId, sha256, targetPage`。创建还提供 operation 及对应 overlay/references/instruction；整套文字请求额外共享一个 `batchId`，便于恢复批次进度和批量采用；新建局部修改不提交 mask，历史客户端仍可提交合法 mask。直接排队的添加文字会调用图片编辑模型和视觉文字校验，必须提供 `confirmation=LIVE_IMAGE_COST_ACCEPTED`；批量模式按图片张数分别产生模型调用。仅保存草稿不会调用模型，可以稍后在“提交草稿”时确认费用。新界面的文字 overlay 固定为 `AI_DISCLOSURE / AI_GENERATED / bottom-right`，服务端覆盖客户端传入的字号、颜色、底色、透明度和边距，只接受合规标识文字。真实产品替换只绑定一张参考图，并必须提交 `target.description` 与 1086×1448 源图坐标系内、至少 24×24 的 `target.region`；`referenceMode` 可为默认的 `STRICT` 或显式选择的 `APPEARANCE`。动作接口必须提供 `requestId, version, reason`；草稿首次提交或未保留旧确认的失败任务重试还需费用确认。源版本变化返回冲突，无法覆盖新图集。重复 requestId 不重复采用或审计，复用到不同输入会拒绝。

上传限制：PNG/JPEG/WebP 文件签名与解码格式一致，拒绝 SVG、动画、截断及伪造 MIME；每个文件原始大小 ≤5 MiB、像素 ≤16M、规范化后 ≤10 MiB。每请求 ≤4 图、合计 ≤20 MiB/32M 像素；每任务累计 ≤20 参考资产/50 MiB。去除 EXIF 后统一保存 PNG，同时保存原始与规范化 sha256、原始类型、尺寸、上传人、用途、来源。路径仅由服务器生成，不使用客户端文件名。

## 验证与合并

自动化测试包括真实的隔离 PostgreSQL 18 数据库、假视觉模型/假图片模型、像素比较和真实无头浏览器交互；默认不会消耗模型额度。另有默认跳过、必须显式开启的真实模型端到端测试。真实测试会执行实际图片模型调用，但不会发布内容。

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

PowerShell 中先设置对应的环境变量。要验证真实多物品实体替换，还需同时设置 `LIVE_E2E_MULTI_OBJECT_SOURCE` 和 `LIVE_E2E_PRODUCT_REFERENCE`；前者是 1086×1448 的真实业务图片，后者是产品实拍参考图。`LIVE_E2E_SKIP_TEXT=1` 只用于隔离诊断实体替换和自然语言修改，不是生产配置。PostgreSQL 测试和付费真实模型测试默认自行启动并删除一次性本地 PostgreSQL 18 集群，也可显式提供专用本地维护库地址；不会读取生产 `DATABASE_URL`。浏览器测试默认使用已安装的 Edge，`IMAGE_EDIT_BROWSER_CHANNEL` 可指定 Chrome。测试依赖安装树中已有的 esbuild/playwright-core。

2026-09-15 集成验收：图片编辑 PostgreSQL 生命周期 9/9、图片初审与独立质检 PostgreSQL 端到端 1/1、图片编辑与图片质检浏览器端到端 2/2；根目录全量 1160 通过、2 跳过、0 失败，服务端全量 575 通过、19 跳过、0 失败；全仓类型检查和两套生产构建均通过。

2026-09-16 最终真实模型验收采用两个隔离运行，覆盖当前全部三类操作且都没有发布。文字运行调用图片模型 1 次，生成白色无衬线“AI生成”与深炭色实心圆角底框；像素改动仅位于右下角 `{x:834,y:1322,width:215,height:88}`。真实多物品运行调用图片模型 2 次、视觉模型 7 次：首先用真实红色马克杯参考照片替换前景唯一米白色马克杯，再按自然语言只把中间栏黑色手冲壶壶身改为浅鼠尾草绿。实体替换的全部 38,985 个改动像素位于人工框选 `{x:420,y:1280,width:235,height:168}`；自然语言修改的全部 4,847 个改动像素位于视觉定位 `{x:558,y:716,width:91,height:82}`；两次蒙版外改动均为 0。视觉复核确认同图其他杯子、手冲壶壶盖/壶嘴/手柄、全部文字和布局未改变。文字产物位于 `output/live-e2e/1789497020088/attempt-1`，真实多物品产物和结构化报告位于 `output/live-e2e/1789499213209/attempt-1`。完整用例矩阵见 `docs/image-edit-e2e-results-2026-09-16.md`。

迁移顺序已经集成为 0050 优先级、0051 文案质检、0052 图片编辑、0053 账号权限与审核分配协调、0054 交付批次、0055 图片初审与独立质检、0056 执行机改图。图片编辑继续使用独立租约和 `IMAGE_MANUAL_EDIT` 原因，但由中心统一图片领取事务安全分派给声明新版能力的图片执行机。
