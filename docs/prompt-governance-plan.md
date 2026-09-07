# 提示词统一管理、视觉规划开关与文案锁定优化方案

日期：2026-09-07。状态：用户已授权完整实施，A～F六组功能与验收已完成，未部署或发布生产配置。最终结果见 [实施与验收](./prompt-governance-acceptance.md)；请求展示的独立说明见 [管理员实际模型请求明细](./model-request-visibility.md)。

下文保留最初设计及范围估计。实施中为权限隔离和知识分析补充了中心HTTP薄接口，实际改动与限制以验收报告为准；未增加中心数据库迁移或调整任务调度。

补充说明：[隐藏业务规则人工管理修改细则](./prompt-business-rules-detail.md)，包含审核降级、文案修复、图片规则截断、评分计算和案例阈值的具体调整。

用户目标：视觉规划进入提示词版本管理并支持开关；修正文案策划与最终图片不一致；让项目可控制的全部业务提示词能由人工优化，消除代码内规则覆盖用户配置的黑盒；尽量减少中心服务与执行机基础设施改动。

用户确认的展示边界：“展示真正发送给模型的内容”仅在管理员后台提供。业务提示词版本、程序追加内容、请求中的任务数据与参考案例、完整脱敏请求及技术约束明细均仅供 ADMIN 查看，不向普通用户或审核员开放。

**1. 推荐范围和改动边界**

采用“复用中心存储、统一业务提示词解析、执行机薄接入”的方案。

中心现有 prompt_templates.kind 没有固定三种枚举，createPromptVersion 接受新类型；global_settings 接受任意合法 key 的 JSON；configurationSnapshots 会取全部已发布提示词和全部设置。这三项足以支持新增提示词类型和全局开关。

源码依据：[server/src/schema.sql](C:/Users/HMCD-0005/Desktop/xhs/server/src/schema.sql)、[server/src/postgres-repository.mjs](C:/Users/HMCD-0005/Desktop/xhs/server/src/postgres-repository.mjs) 的 configurationSnapshots / upsertSetting / createPromptVersion、[server/src/http-server.mjs](C:/Users/HMCD-0005/Desktop/xhs/server/src/http-server.mjs) 的现有 prompts/settings 路由。

- 当前分布式生产主链路：预计 **中心 API、中心表结构、任务状态机、中心调度代码均无需修改**；新增提示词和开关通过现有接口保存数据。
- [src/executor/agent.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/executor/agent.mjs) 需要少量接线，把快照中的提示词集合与开关传给共享生成模块。
- 共享生成模块在执行机进程中运行，因此仍需更新、重启执行机一次；不能只改后台界面就宣称开关生效。
- 执行机的 scheduler、CLI、领取任务、心跳、并发、任务上传协议保持现有设计。
- 本地离线 SQLite 模式有三类提示词 CHECK 限制，要全覆盖该模式需本地兼容迁移；这不是中心 PostgreSQL 迁移。
- 中心执行的优秀文案分析已支持传入人工 analysisPrompt，先复用这个参数；其固定包装以技术约束展示。若要求由中心返回实际包装的逐次版本与完整请求，则这是一个独立的小扩展，不能承诺零中心代码即可获得服务器实际调用证据。
- 此轮只制定方案，不发布提示词、不切换全局配置、不触发真实生产任务。

**2. 视觉规划开关的行为**

在“提示词版本 → 视觉规划”中展示全局“启用视觉规划”开关，建议新的配置方案默认关闭。开关与提示词是否发布是两个状态，不以空提示词表示关闭。

| 状态 | 执行行为 | 图上文字 |
| --- | --- | --- |
| 关闭 | 跳过视觉规划模型调用；直接使用原 imagePlan 的场景提示和页类型，程序适配下游结构 | 原 headline / subtitle / bullets 保持一致 |
| 开启 | 调用已发布 VISUAL_PLAN_SYSTEM，仅规划主体、构图、配色、布局和不新增事实的视觉元素 | 同样锁定原文案，不允许重写、删减、换序或跨页搬移 |
| 开启但缺少已发布版本 | 调用模型前报出缺少的提示词类型 | 不使用未展示的硬编码替代 |
| 历史执行/断点继续 | 使用历史冻结模式、提示词与既有规划 | 不因全局开关变化而重做或覆盖 |

关闭后仍是真实生图，不使用 mock 图、不伪称模型完成了视觉规划。进度显示“视觉规划已关闭，使用原配图策划”。程序选用的默认版式与适配规则也要可见；不能通过默认模板偷偷覆盖原场景提示。

第一期只加全局开关及每次执行的冻结状态展示，降低入口与中心改动。若后续增加单任务覆盖，可复用 task.input 的现有 JSON 扩展空间，但不混入本次必需范围。

**3. 前置文案策划的修改**

文案生成时一次输出正文与最终可上图的 imagePlan，仍保留现有数据结构，避免中心审核、存储和导出契约重做。新增独立可编辑的 COPY_IMAGE_PLAN_SYSTEM，与 TEXT_SYSTEM 一同用于该次调用，不新增一个必然消耗额度的文案模型步骤。

建议人工优化的文案策划规则：

> imagePlan 的 headline、subtitle、bullets 是本次交付图片需要逐字呈现的最终文字。请在文案阶段完成压缩、分页和信息分配，逐页完整表达同一信息焦点。prompt 只描述画面、构图、风格与视觉元素，不另写一套应显示的文字。正文和各页事实一致，不增加正文未支持的日期、数字或承诺。后续视觉规划只能优化画面设计，不能改写这些文字。

图片运行开始时，从已确认 imagePlan 由程序生成唯一的最终文字契约与 hash；视觉模型不再拥有重新生成该字段的权限。可在视觉规划输出 schema 中使用 const 固定文字或不让模型返回该字段，再由程序注入并校验。最终选择需保持旧产物可读取。

源证据追踪仍需真实：不能用“正文第 N 句”之类的轮转填充伪造当前页证据。原策划与正文冲突时明确返回修订，不通过改文案或随意匹配句子掩盖。

原文案、视觉阶段输入、最终图片 OCR 形成三列对照；换行不算改文案，内容和每页归属不可变。合规标识明确列入必需文字，避免成为提示词末尾的一句例外。

**4. 全部可控提示词的盘点与归宿**

“统一管理”指业务规则可编辑、可版本化、可预览；已有人工作业入口的分析提示词保留现有数据，统一目录展示来源，不建立两份互相覆盖的真源。

| 业务步骤 | 拟管理类型/归属 | 现有隐藏或分散来源 | 处理方式 |
| --- | --- | --- | --- |
| 文案生成 | TEXT_SYSTEM（已有） | post-contract、prompts/post.md 的拼接 | 已发布文案规则为业务主规则；机器返回结构单独展示 |
| 文案阶段配图策划 | COPY_IMAGE_PLAN_SYSTEM | post-contract 的分页和配图建议 | 人工完成最终图文与分页；后续锁定 |
| 生图前视觉规划 | VISUAL_PLAN_SYSTEM | visual-plan、visual-plan-generation | 可发布、可关闭；只设计画面 |
| 图片生成 | IMAGE_SYSTEM（已有） | standalone/pipeline 的长固定提示、onePassImageSystemPrompt、layout-contract | 风格、背景、留白、字号、排版偏好等归入可编辑版本；实际页数据单列 |
| 图片编辑 | IMAGE_EDIT_SYSTEM（已有） | image-edit-worker、各类编辑附加语句 | 保留人工编辑要求；对文本锁定例外需显式新版本，不能静默 |
| Query 审核 | QUERY_REVIEW_SYSTEM | content-stage-review | 审核尺度可编辑；保留机器输出契约 |
| 文案审核 | TEXT_REVIEW_SYSTEM | content-stage-review | 采用当前人工规则；清除隐藏的人称例外与程序自动降级 |
| 文案修复/长度修复/质检修订 | COPY_REPAIR_SYSTEM / COPY_LENGTH_REPAIR_SYSTEM / COPY_REVISION_SYSTEM | copy-generation、pipeline | 修复仍引用同一冻结编辑规则；三类修复权限分开，不再隐式切回总分总、固定目标字数或其他文风 |
| 单图 OCR 和图文验收 | IMAGE_ALIGNMENT_SYSTEM | image-alignment | 验收政策可编辑，强调真实抄录与裁字检查；机械比较标准另列 |
| 整套质量评分 | DELIVERY_REVIEW_SYSTEM | quality-assessment | 评分说明可编辑；代码计算公式、阈值与版本可见 |
| 单页/整套图片修复 | IMAGE_REPAIR_SYSTEM | images、image-alignment、quality-repair | 修复策略人工管理，动态错误只作为数据，不作为新规则来源 |
| 选题批量筛选 | DEMAND_SCREENING_SYSTEM | admin/demand-screening-service | 需求等级解释与筛选政策可编辑 |
| 检索资料整理 | RESEARCH_SYSTEM | deepseek-web-search、codex、deepseek-responses-client | 来源偏好、摘要策略可编辑；实际搜索证据要求可见 |
| 文案案例匹配 | COPY_KNOWLEDGE_MATCH_SYSTEM | copy-knowledge-match | 匹配评分说明可编辑；分数范围及选择阈值展示 |
| 案例借鉴规则 | COPY_KNOWLEDGE_USE_SYSTEM | copy-knowledge-match | 借鉴方法与事实隔离规则统一展示和管理 |
| 视觉知识分析 | VISUAL_KNOWLEDGE_ANALYSIS_SYSTEM | admin/visual-knowledge-service | 视觉分析指令可编辑 |
| 优秀文案分析 | 关联已有分析模板 | admin/copy-knowledge-service、server/deepseek-copy-analysis | 复用现有 analysisPrompt；展示真实来源与技术包装，不复制一份隐藏模板 |
| 模拟器图片检索 | IMAGE_SEARCH_SYSTEM（标记仅联调） | deepseek-responses-client | 归入辅助流程，标明不是生产生图 |

管理员后台 UI 按“生成与规划 / 审核与修复 / 检索与知识库 / 技术约束”分组，避免出现十几项横排标签。每个条目显示调用阶段、所在流程、当前版本、变量、是否启用或该流程未启用。

**5. 清理提示词之外的隐式覆盖**

只把字符串搬到编辑框仍不够。当前以下代码会改变实际规则或使人工优化不生效：

- copy-generation 的失败修复另写了固定文风和不同目标字数；需要与初稿引用同一份已发布规则，字数硬性范围由契约统一给出。
- content-stage-review 不仅在 prompt 中覆盖第一人称要求，applyTextReviewPolicy 还会把相应 BLOCKING 改为 WARNING。应移除无条件覆盖，按明确的审核配置处理并记录结果来源。
- standalone/pipeline 的 onePassImageSystemPrompt 会查找特定标记、截掉其后的内容，再追加固定规则。此前“正则替换”的描述不准确，现更正为标记截断与规则追加。应改为发布前明确提示冲突、展示迁移差异；运行时不得偷偷改用户版本。
- quality-repair 的固定逐页重构策略可能覆盖已确认布局。应变成可编辑策略，同时受文字锁定约束。
- visual knowledge 配方、负面提示、布局规则是额外影响来源；不必复制进提示词版本库，但要记录具体知识版本、为何选中、实际追加的内容。
- 硬性 JSON 字段、枚举、当前存储与解析长度范围、图片尺寸、工具协议与额度限制仍由程序保障，完整只读展示；不把可变文风或审美偏好伪装成技术限制。
- 评分公式、选择阈值、OCR 的 NFKC/空白/引号归一化规则属于运行规则：展示实际值、版本和作用。细化方案中，案例阈值、OCR 比较方式、长度修复目标等简单业务参数做成显式配置，程序与提示词共用；当前评分聚合算法与正文契约范围先沿用并明确展示为固定业务策略。修改自然语言提示不会自动修改这些固定策略，页面必须说明。
- 本轮不更改中心的数据字段上限或评分输出字段。与现有契约冲突的人工目标应在发布预检中指出；不能让用户误以为单改提示词能突破程序限制。

**6. 统一解析和可见性设计**

拟新增一个共享提示词目录与编排模块。模块职责有限：根据阶段取被冻结的已发布业务版本，填充允许的变量，加入结构契约与任务数据，并生成来源清单。不另写第二套默认文风。

拟新增文件（名称可在实施时微调）：

- src/prompt-catalog.mjs：阶段目录、显示名称、变量、默认候选模板路径、调用范围。
- src/prompt-runtime.mjs：解析冻结模式、已发布版本、合同版本；拒绝缺失和不兼容配置。
- src/prompt-composer.mjs：同一个构建过程同时返回请求与可追踪来源，避免“展示内容”和“真实发送内容”分叉。
- src/admin/prompt-runtime-service.mjs：适配中心、本地试验和离线来源；有中心时统一读取中心，途中不刷新配置。
- src/locked-image-plan.mjs：原文案锁定、直接生图适配、文字相等校验；不复用 createMockVisualPlan 冒充正式流程。
- prompts/business/：建议候选模板，进入版本管理后由人工发布。
- prompts/contracts/：本项目可控的机器结构和工具约束说明，只读可查。

仅向管理员展示的每次实际请求追踪应包含：

1. 使用的业务提示词类型、版本、hash。
2. 当前执行的视觉规划开关与来源。
3. 实际系统/developer instructions、输入文本、输出 schema、工具约束。
4. 注入的 Query、正文、逐页锁定文字、参考案例/视觉配方和修复错误数据。
5. 完整脱敏请求、模型输出和截断标记。输入过长在调用前报错，不把截断摘要标成完整内容。

复用现有 model-call-traces 的 prompt/request 文本字段存放结构化来源清单，无需新增中心列。特别修正 Codex 当前追踪只记业务 prompt、未完整展示 developer_instructions 的问题，以及 DeepSeek 搜索追踪只显示 query、未显示 instructions 的问题。只展示本项目实际能控制和取得的内容，不声称可以展示模型服务商内部未公开规则。

权限限定为现有 ADMIN 角色，并沿用现有任务访问范围。普通用户和审核员不显示本功能入口；Web 接口和中心服务都校验管理员权限，直接请求追踪列表、详情或预览也不能绕过。普通任务响应不得夹带本功能的内部提示词、请求明细或含这些内容的执行快照；已有业务任务数据按原权限正常返回。

JSON 格式、字段限制、工具协议等技术约束继续由程序校验，管理员界面只读展示；编辑业务提示词不会改变这些约束。追踪中的实际请求是历史只读记录，业务提示词的修改仍通过已有版本管理流程完成。

**7. 存储、发布与快照**

- 新提示词通过现有 /v1/prompts/versions 和 publish 接口创建/发布。
- 开关建议保存为独立 global_settings key：prompt_runtime。避免塞进 production.modelApi，也避免被当前 normalizeProductionSettings 丢弃。
- 保存 schemaVersion、visualPlanningEnabled 和规则配置版本；完整提示词仍留在已有版本表，不把业务内容重复塞进普通设置。
- 中心现有领取任务快照会携带新类型和设置。使用现有 capturedAt 语义：当前中心通常在执行领取时冻结，不宣称新增任务时就已经冻结。
- 文案与图片属于不同执行，界面分别显示各自快照。发布新版本只影响之后取得新快照的执行；断点继续沿用原配置。
- 不覆盖当前人工发布的三个版本。新增类型先生成可编辑草稿；将旧隐藏业务规则作为迁移对照展示，人工作出调整后再发布。
- 新规则方案启用前检查必需提示词齐全。缺项不静默使用硬编码 fallback。
- 保留旧快照与产物读取；历史运行标记“旧规则/历史快照”，不冒充新版本。在途任务建议先结束或按原检查点继续；没有足够历史证据时明确提示，不能自动用最新规则覆盖。
- 所有执行节点完成升级后再启用新配置，避免旧执行机忽略开关。无需改中心调度；部署记录及现有节点列表用于核对升级覆盖。

**8. 拟修改代码清单**

以下是待实施范围，不代表本轮已经修改。按模块分批完成，全部范围完成前不宣称清除了所有业务提示词黑盒。

| 模块 | 现有文件 | 修改内容 |
| --- | --- | --- |
| 提示词后台 | [app/prompts/central-prompt-workbench.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/central-prompt-workbench.tsx)、[app/prompts/prompt-editor.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/prompt-editor.tsx)、[app/prompts/page.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/page.tsx) | 分组目录、新类型、开关、预览、版本差异、技术约束 |
| 本地提示词与初始化 | [src/admin/prompt-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/prompt-service.mjs)、[src/admin/default-prompts.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/default-prompts.mjs)、[src/admin/rule-prompt-installer.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/rule-prompt-installer.mjs)、[src/admin/admin-store.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/admin-store.mjs) | 统一目录、合法变量与长度、草稿迁移；离线 CHECK 限制与快照兼容 |
| 文案与原配图策划 | [src/post-contract.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/post-contract.mjs)、[prompts/post.md](C:/Users/HMCD-0005/Desktop/xhs/prompts/post.md)、[src/copy-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/copy-generation.mjs) | 最终逐页文案规则；技术/业务分离；修复不再回到隐藏文风 |
| 视觉规划 | [src/visual-plan.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/visual-plan.mjs)、[src/visual-plan-schema.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/visual-plan-schema.mjs)、[src/visual-plan-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/visual-plan-generation.mjs) | 读取发布版本、跳过模型开关、仅布局输出、程序注入原文案 |
| 正式与独立图片流程 | [src/standalone-image-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/standalone-image-generation.mjs)、[src/pipeline.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/pipeline.mjs)、[src/layout-contract.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/layout-contract.mjs) | 接入统一模式；消除重复固定图像规则；默认版式来源可见 |
| 视觉配方拼接 | [src/admin/visual-knowledge-store.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/visual-knowledge-store.mjs) | 配方、负面提示、布局来源追踪；统一长度预检 |
| 文案审核 | [src/content-stage-review.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/content-stage-review.mjs) | 可编辑 Query/文本审核；清除人称等无条件覆盖 |
| 图片验收和修复 | [src/image-alignment.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/image-alignment.mjs)、[src/images.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/images.mjs)、[src/quality-assessment.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/quality-assessment.mjs)、[src/quality-repair.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/quality-repair.mjs) | 抽取审核/修复业务指令，引用冻结文字，展示机械规则 |
| 编辑入口 | [src/admin/image-edit-worker.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/image-edit-worker.mjs) | 编辑规则与验收引用一致；展示后续叠字/处理规则，避免隐藏处理 |
| 生成入口统一来源 | [app/api/copy-generations/route.ts](C:/Users/HMCD-0005/Desktop/xhs/app/api/copy-generations/route.ts)、[app/api/image-generations/_runtime.ts](C:/Users/HMCD-0005/Desktop/xhs/app/api/image-generations/_runtime.ts)、[app/api/image-generations/route.ts](C:/Users/HMCD-0005/Desktop/xhs/app/api/image-generations/route.ts) | 有中心时取中心；统一冻结 runtime，预览与执行同源 |
| 执行机薄接线 | [src/executor/agent.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/executor/agent.mjs) | 把 snapshot.prompts 和 prompt_runtime 传给共享业务模块；不改任务调度 |
| 断点与历史记录 | [src/standalone-image-recovery.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/standalone-image-recovery.mjs)、[src/checkpoint.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/checkpoint.mjs)、[src/admin/generation-store.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/generation-store.mjs) | 原配置恢复、版本/hash记录、旧产物兼容；必要时调整 executor/image-checkpoints 的读取适配 |
| 调用追踪 | [src/model-call-trace.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/model-call-trace.mjs)、[src/codex.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/codex.mjs)、[src/openclaw.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/openclaw.mjs)、[src/deepseek-web-search.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/deepseek-web-search.mjs) | 实际请求分层留痕；不改变鉴权、进程或额度逻辑 |
| 追踪界面 | [app/workbench/model-call-trace.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/workbench/model-call-trace.tsx)、[app/tasks/[id]/generation-prompt-trace.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/tasks/[id]/generation-prompt-trace.tsx)、[app/tasks/[id]/generation-visual-plan.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/tasks/[id]/generation-visual-plan.tsx) | 仅管理员可阅读的来源、开关、版本、原文与最终图文对照；技术约束与实际请求只读 |
| 筛选与案例 | [src/admin/demand-screening-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/demand-screening-service.mjs)、[src/copy-knowledge-match.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/copy-knowledge-match.mjs) | 业务规则取已发布模板；对应API入口传 runtime |
| 知识库分析 | [src/admin/visual-knowledge-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/visual-knowledge-service.mjs)、[src/admin/copy-knowledge-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/copy-knowledge-service.mjs)、[app/api/visual-analyses/route.ts](C:/Users/HMCD-0005/Desktop/xhs/app/api/visual-analyses/route.ts)、[app/api/copy-analyses/route.ts](C:/Users/HMCD-0005/Desktop/xhs/app/api/copy-analyses/route.ts) | 可编辑分析规则、统一来源与技术包装说明；中心分析保留现有参数 |
| 检索与联调兼容 | [src/research.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/research.mjs)、[src/web-search-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/web-search-service.mjs)、[src/deepseek-responses-client.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/deepseek-responses-client.mjs)、[src/executor/deepseek-copy-simulator.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/executor/deepseek-copy-simulator.mjs)、[src/executor/deepseek-image-simulator.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/executor/deepseek-image-simulator.mjs) | 业务检索规则与正式目录一致；模拟流程明确标注适用范围 |

中心核心 [server/src/postgres-repository.mjs](C:/Users/HMCD-0005/Desktop/xhs/server/src/postgres-repository.mjs)、[server/src/schema.sql](C:/Users/HMCD-0005/Desktop/xhs/server/src/schema.sql)、[server/src/domain.mjs](C:/Users/HMCD-0005/Desktop/xhs/server/src/domain.mjs)、[server/src/http-server.mjs](C:/Users/HMCD-0005/Desktop/xhs/server/src/http-server.mjs) 作为复用与回归验证对象，主方案不修改。server/prompts 现有初始化文件也不靠覆盖来改变用户已发布版本。

若完整请求可见性要求扩展到中心运行的文案分析，最小例外是 server/src/deepseek-copy-analysis.mjs 及调用该功能的响应层，另列验收，不影响生产队列。

文件较多源于隐藏规则分散在生成、审核、修复、检索各处。可以少改基础设施，不能只增加一个编辑框便解决所有流程的黑盒。

**9. 实施顺序与验收**

第一批：目录、版本读取与追踪基础。现有三个已发布版本不变，新条目可编辑和预览；同一构建过程用于发送与展示。

第二批：原文案锁定与视觉开关。关闭时视觉 runText 调用次数为 0；开启时使用发布版本，任何原文字差异均在生图前拦截；恢复不重新规划。

第三批：审核、修复及图像附加规则。修改人工业务规则后，首稿、审核、格式重试、局部修复均使用冻结版本；不再出现人称/文风的隐式覆盖；实际外层指令可见。

第四批：检索、知识库、独立试验、离线与模拟入口。逐个登记覆盖，不把未运行的辅助流程写成已完成。全部入口统一来源、或明确标记本地/旧兼容来源。

每批先用 fake client 截获真实构建的请求，不消耗模型额度。关键验证：

- 新 kind 与 prompt_runtime 可通过现有中心API保存，进入既有执行快照，无数据库迁移。
- 发布 v2 后，旧执行仍用 v1；重试/局部修复不会偷偷换版本。
- 独立试验与分布式生产读取同一来源，不因入口不同产生两套规则。
- 开关关闭不调用视觉模型；开启时能在请求中找到准确发布版本，原文字保持一致。
- 人工发布的业务要求与固定契约不冲突；冲突在发布预检/生成前出现明确原因。
- 调用追踪展示所有本项目发送的业务层和适配层指令，缺失/截断不冒充完整。
- 管理员可查看完整脱敏请求和只读技术约束；普通用户、审核员在页面中无入口，直接访问相关 Web/中心读取接口也被拒绝；普通任务响应不包含内部请求或提示词快照，已有业务功能保持可用。
- OCR以冻结文字为准；业务阶段没有再授权模型重写原文案。
- 本地迁移保留历史版本与现有发布内容；旧产物可读取。
- 根据变动运行 npm test、npm --prefix server test、npm run typecheck、npm run build、npm run smoke；浏览器核对保存、发布、关闭/开启、历史与预览。
- 实施后再安排明确小样本真实调用，验证人工修改的提示词确实生效，不能用无额度测试代替真实验收。

开始涉及 Next.js 实现前，按仓库要求阅读 node_modules/next/dist/docs/ 对应指南。

**10. 当前不混入的修复**

上轮发现的错误比例与 cover 裁字属于图像后处理，需要独立修改 images/image-output-reception 等逻辑。可在提示词与验收说明中展示其约束，但本方案不会声称“开放提示词”就修复了裁字。后处理修复应单独排期，避免扩大本轮提示词改造与部署面。
