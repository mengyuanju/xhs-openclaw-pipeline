# 完整功能测试发现的问题及回归证据（2026-10-02）

本文记录本轮服务端及页面缺陷，以及历史测试与当前实现不一致的修复；包含用户截图反馈后的“网页来源节点未注册”补测。浏览器、真实数据库、单元fake和真实模型证据分开；fake图片不称为真实模型生图，源码盘点不等于页面实测。

## R-SERVER-001：生图连续失败后修改文案/规划遗漏强制复检

触发步骤：任务已有3分文案；生图连续失败进入 `COPY_REVIEW_PENDING / IMAGE_RETRY_EXHAUSTED`；负责人实际修改正文或图片文案规划；通过文案审核。旧V2实现丢失了 `approveCopy` 传入的 `retryExhaustedCopyChanged`，在关闭普通抽检时直接进入 `IMAGE_QUEUED`，没有进行该路径要求的强制复检。

修复：`server/src/copy-quality-control.mjs` 的 `routeManualCopyApproval` 接收该标志，以 `mandatory_copy_qc=true`、`mandatory_copy_qc_origin=IMAGE_RETRY_REVIEW` 交给现有V2审核路由。因此改文案和仅改规划都会形成独立单任务全检批次，采用不可变的已批准revision与approval event。没有修改“需强制复检”的业务期望来消除失败。

回归断言：

- `server/tests/human-quality-assessments.test.mjs` 分别执行实际文案编辑和仅规划编辑，并验证最终状态 `COPY_QC_PENDING`、新revision和 `IMAGE_RETRY_REVIEW`。
- 验证V2批次 `PERSONAL_AUTO`、`full_inspection=true`、比例10000、成员数1、抽检数1；唯一成员为当前批准revision，状态 `PENDING`。
- 同文件仍验证保存/重新打开/审核、评分解释、低分改稿、规划保存和重复提交的原有契约。修正fake对压缩SQL空格的识别，以及当前V2参数位置。

实际结果：上述文件24/24通过，记录在 `reports/full-functional-2026-10-02/human-quality-retry-regressions.log`。另在最终100条临时真实PG环境中，F016实际执行连续3次生图失败、改稿审核、单任务V2全检、质检放行和重新生图，结果PASS，见 `reports/full-functional-2026-10-02/functional-100-results.json`。该100条链路模型输出仍为fake，与独立真实模型检查分别记账。

## R-SERVER-002：V2盲审任务能通过通用任务入口泄漏信息

触发步骤：开启文案独立盲评，负责人审核稿件进入V2质检批次；质检员在通用任务列表或直接猜 `/v1/tasks/{taskId}`，绕过只应显示匿名内容的质检入口。旧 `activeBlindQaSql` 只识别历史 `copy_sampling_items` 和图片质检，遗漏 `copy_qa_batch_members_v2`；V2匿名数据虽已在批次详情隐藏，但通用入口保护缺失。

修复：`server/src/repository-context.mjs` 的 `activeBlindQaSql` 增加V2批次成员检查。保护当前revision处于 `INSPECTING / COPY_QC_PENDING` 的盲审任务，并保护同一 `quality_cycle` 退回/整批影响后待修改的任务。放行后或进入不相关的新周期，不因历史盲审记录永久隐藏。

真实PostgreSQL与HTTP回归：`server/tests/modular-workflow-postgres.e2e.test.mjs` 的完整业务流程运行于临时PostgreSQL18与真实HTTP服务，验证：

- 负责人审批形成两个实际V2全检批次；质检员批次详情的taskId/query/approver为null，管理员能看到真实绑定。
- 通用质检员任务列表排除盲审任务；猜任务ID返回404 `TASK_NOT_FOUND`。
- 单条质检退回后，通用任务入口仍返回404；改稿后独立V2强制复检可操作。
- 质检放行后通用详情恢复200，不暴露管理员执行记录。
- 后续图片负责人初审、图片质检退文案、文案V2全检、重生图、图片复检及交付池/单条和历史ZIP下载完整通过。

实际结果：该完整流程及当前优先级流程2/2通过，记录在 `reports/full-functional-2026-10-02/modular-v2-final-check.log`。图片产物是明确标注的合成测试文件，未调用模型。

## 历史测试契约和夹具修复

初始标准服务端基线：942通过、12失败、75跳过。12个失败由下列六个文件承担；不能把这些旧接口期望直接当作当前页面缺陷。

| 文件 | 原因与修复 |
| --- | --- |
| control-plane-http.test.mjs | 旧v1文案质检/管理员直通入口已退役，改为验证410且不访问repository；新增当前V2候选账号过滤和摘要回归 |
| copy-sampling-freeze-contract.test.mjs | 旧生产批次自动冻结已停用，验证调用无SQL、不会制造新的旧抽检范围；保留不可变revision批准事件幂等性 |
| human-quality-assessments.test.mjs | 修正V2 SQL fake，并修复R-SERVER-001；保留原强制复检要求 |
| modular-workflow-http-contract.test.mjs | 旧v1列表/冻结路线退役；新增V2分页、三角色列表、盲评明细、管理员候选权限、原因校验及统计权限 |
| permanent-delete-batch-closure-contract.test.mjs | 永久删除不再复活旧文案抽检冻结；核对任务删除、事务提交和无冻结副作用 |
| quality-review-coverage.test.mjs | fake缺少最新image approval event查询；补准确事件绑定，保留真正新放行成员的覆盖断言 |

六文件修复定向102/102通过：`server-baseline-repaired-targeted.log`；新增规划耗尽场景后，以24条human回归及最终全量标准服务端日志合并确认。

额外PostgreSQL夹具：

- `standalone-image-editor-migrations.test.mjs`：0083兼容修复测试仅应用到0083，避免把后来迁移新增字段混入行级前后快照；草稿、正式0082、无效旧数据和校验和测试共5/5通过（`standalone-migration-repaired.log`）。
- `modular-workflow-postgres.e2e.test.mjs`：升级迁移期待从当前迁移清单和已应用边界派生，历史校验和/数据保持断言保留；现代生产批次夹具补合法32位clientBatchCode。
- 该文件旧综合流程搬到当前文案V2和图片负责人初审/图片质检入口；没有将已经退役的`review-images`当成可见新功能。历史0050分配算法迁移测试保持截至0054的明确历史范围；当前优先级测试核对图片初审仍属于负责人。

所有数据库均由测试创建为临时隔离实例；没有操作开发或生产数据库。最终全量结果由主测试报告合并，本文各证据文件保留实际失败与复测历史，不删除失败记录。

## R-UI-003：用户账号原生字符规则在当前浏览器失效

触发：管理员打开新增用户，输入大写 `UPPERCASE`。旧 `pattern="[a-z0-9][a-z0-9._-]{2,49}"` 在浏览器当前Unicode Sets（v）字符规则下不合法，原生 `validity.valid` 错误地为true，虽然后台仍拒绝非法账号，页面约束已失效。

修复：`app/users/user-manager.tsx` 用JavaScript字符串明确保留反斜杠，渲染的字符集为 `[a-z0-9][a-z0-9._\-]{2,49}`。保留后台小写账号规则，没有放宽字符集。

真实浏览器复验：`scripts/full-functional-admin-supplement.mjs` A001核对大写和包含斜杠的账号均原生无效，合法小写 `admin-supp-*` 可新增。随后真实重置密码、强制初始改密、删除取消和确认均通过。管理员14组最终全部通过：`reports/full-functional-2026-10-02/functional-admin-supplement.json`、`admin-supplement-final3.log`、`admin-permissions-final.log`。A014实际编辑REVIEWER权限、自动成批/全检与数量，保存重开核对，再翻转各开关保存核对；0和5001原生无效。仅操作另建合成账号/备用词包/节点；全淘汰或废弃词包不产生正式任务，原100条任务保留。

## 本轮新增实际页面补测及测试等待修正

- 管理员14组：用户新增/账号校验、重置密码、解除登录限制确认、自动派单池搜索/加入/模式/数量/暂停恢复/移出、用户删除、纯文本词包导入、按数/平均/收回筛选分配、暂存筛选/关闭不保存/搜索/批量淘汰、另一个待筛词包废弃、永久删除预检/名称/二级密码、执行机在线禁删和离线删除、离线搜索节点删除、权限/自动成批配置。解除限制页面按钮有实际操作，未在该组制造真正被限制账号，不能据此声称完整限制行为已在UI覆盖；登录限流由另一个真实隔离账号边界补测验证。
- Prompt4组：准备候选草稿幂等、执行配置数值边界/大小关系/保存刷新恢复、草稿放弃与历史载入取消确认、Web记录展开刷新及固定契约/知识库实际导航。中心不挂载本机旧版本重新发布按钮，未冒充中心UI回滚。最终 `functional-prompt-supplement.json` 4/4通过。无新增模型调用。
- 创建表单独立浏览器：`tests/creation-form-browser.test.mjs` 实际解析100条输入，逐个点选自动/3/4/5页，验证空/重复/501字/101条拒绝、免审核负责人必选、角色筛选、提交禁用、503输入保持与重试、不可信Query原样文本。`creation-form-browser-initial.tap` 1/1通过。HTTP夹具不代表真实队列执行或免审核图片门禁；当前表单没有额外任务说明输入、部分成功回执或requestId。
- 文案废弃独立浏览器：`tests/copy-qa-discard-browser.test.mjs` 实际理由/说明必填、确认取消、失败保持与同requestId重试、只读废弃最终稿/原因、403错误展示；`copy-qa-discard-browser-initial.tap` 1/1通过。批次实际计算和自检/陈旧revision后台门禁由真实PG及HTTP测试负责。
- 图片整批与文案成批补测：`image-qa-batch-browser-retest.tap` 2/2通过，实际capability隐藏/开放、理由/说明必填、范围预览、确认取消/确认及精确请求；`copy-flow-modes-browser-retest.tap` 1/1通过，单选/全选、混合成员/样本和个人随机模式取消/确认、成功进入当前文案质检组件。均HTTP夹具，未修改100主业务库。

测试脚本修正与产品缺陷分开：词包分配初轮未清除3名预选人，填2条导致合计4超过3，UI正确拒绝，脚本随后先明确清空选择；待筛词包初导入实际为IMPORTED，不能将READY错误期望当产品缺陷。Prompt初轮刷新后在客户端绑定前修改首个字段，实际未更新React数据；等待处理器绑定并等待真实PUT完成后复验通过。原失败JSON和日志均保留，不将这些测试错误记成生产修复。

## R-UI-004：词包并发筛选失败提示被重读清除

触发步骤：打开词包，暂存通过/淘汰选择；其他操作更新筛选版本；本页提交得到409。旧实现先显示陈旧版本错误，再调用 `openPackage` 读取最新内容；重读函数立即清空同一个错误状态，用户只能看到选择消失，无法得知并发失败原因。

修复：`app/query-packages/query-package-workbench.tsx` 的 `openPackage` 增加默认false的 `preserveError`。提交失败后的重读显式保留错误，同时继续加载权威最新版本并清除陈旧暂存；其他正常打开仍清空旧错误。没有放宽版本校验或复用陈旧选择。

复现日志 `query-package-browser-retest6.tap` 保留409后错误消失的失败。修后 `tests/query-package-browser.test.mjs` 实际提交409、断言错误保持可见、列表重读到最新版本、原暂存清除，`query-package-browser-final-pass.tap` 1/1通过。相关词包源码/合约31/31通过，见 `query-package-source-after-fix.tap`。浏览器后台为HTTP夹具，真实数据库并发校验另由服务端PG测试验证。

## 文件、范围、并发及提示词保护规则补测

- 词包4组：`query-package-browser-evidence.json` 对应实际列表200+1条、9种状态、名称/批次/负责人搜索、失败刷新；TXT/CSV和真实XLSX工作表/列选择、标准批次拆包、空/损坏/超长/10001条/非法批次、输入保持及同requestId重试；200+5虚拟列表、7种行状态、外部ID、重复/已建任务禁操作、通过/淘汰双向暂存、关闭不保存、确认提交和409重读；无人员/关闭词包/角色门禁。Excel解析调用生产解析器；持久化为HTTPfake，未创建正式100任务。
- 交付筛选：`functional-delivery-filter-supplement.json` DF01–05在临时真实服务5/5通过，验证五种时间范围、成员/查询/批次搜索、当前/历史版本、三个汇总条件及20/50/100分页。真实数据未绑定词包/批次时明确验证零结果；正向关联词包/批次的125条HTTPfixture由 `shared-delivery-filter-browser-retest.tap` 1/1通过、逐请求核对精确成员，不能将其当真实数据库关联。
- 任务优先级：`task-priority-batch-browser-initial.tap` 1/1通过，实际六种优先级、必填原因/2000字、整生产批次预览与取消、503重试、三条expectedVersions、409强制新预览后提交，以及混合生产批次无勾选项。此功能为同一生产批次，清单已更正原“同Query”的错误盘点。
- 图片质检陈旧版本：`image-qa-stale-browser-final.tap` 2/2通过。真实点击旧样本提交409，保留填写内容；关闭并点击实际“刷新队列”，重读新样本后提交使用新样本ID和新requestId。当前图片质检API绑定样本ID，没有虚构额外revisionToken控件。
- 提示词保护规则：`prompt-guard-browser-retest.tap` 1/1通过。实际打开TEXT_SYSTEM规则区，核对完整提示，删除标识/空规则/缺结束标识均显示缺失；警告取消无写入并保留草稿，恢复完整内容更新提示，明确确认继续保存草稿。未发布、未调用模型。
- 提示词最后控件审阅：`prompt-controls-final-pass2.tap` 1/1通过，保留原目录与保护规则操作，新增Home/End/左右循环、Query快捷入口、其他管理员新发布后刷新旧稿保持/禁旧保存/放弃恢复、示例选题500字和预检503恢复、WEB/CENTER两来源非空记录按钮/原始请求响应/错误文本。预检调用真实 `previewPrompt`，核对安全转义后的untrusted_task_data JSON逐值等于原始输入，不按未转义字符串错误判失败。初轮取消并发警告的fixture并没有未存草稿、动态页签标签新增“未提交”、以及最后pre并非结果等定位/期望修正日志保留，不属于产品修复。
- 独立图片空间最后边界：`standalone-boundary-browser-initial.tap` 1/1通过，21行20/1分页和末页删除自动回退、运行行禁选/禁删、单条与当前页19条批量取消确认和503保持/重试、列表503旧行保持、名称200字/重开清空/关闭零POST、6张拒5上限、实际decodeReference损坏和尺寸错误、上传503姓名保持、PNG/JPEG/WebP五张合法上传及第1/5张切换。没有独立超20选择或逐项partial失败控件，未把不存在功能计通过。

上述浏览器证据分别说明控件和请求范围；生产业务状态、算法、文件格式以及外部模型调用仍引用各自真实HTTP/PG/模型证据，不用复合用例名替代逐项范围审阅。

## R-UI-005：大图加载重试完成后仍显示损坏图片

触发：大图首次请求503，点击预览中的重试。预加载对象后来成功解码，忙碌状态也结束，但画面上的原img节点仍保留失败加载结果，实际naturalWidth为0。只断言错误提示消失会漏掉这个问题。

修复：`app/components/image-preview.tsx` 的可见img使用重试次数作为key，在重新加载时重建节点。`tests/image-preview-browser.test.mjs` 保留实际503失败请求，重试返回SVG后，核对可见图片complete=true、naturalWidth=20、正确src和无失败提示；另实际核对大图横向/纵向滚动、适应窗口、旋转、底色、源图切换、默认偏好及真实下载字节。定点通过见 `copy-controls-preview-retest2.tap`，整套最终结果见主报告。SVG仅用于受控浏览器夹具，不是模型产物。

## R-SERVER-003：网页审核来源节点未注册导致保存/提交失败

用户截图：作业模式已有自动保存草稿，点击“保存评分，暂不提交”或“提交并下一条”仍显示 `executor node is not registered (NOT_FOUND)`。真实开发页面由启动器配置 `EXECUTOR_NODE_ID=dev-web-test`，开发库原先没有该记录；其他执行节点生成、分配的任务不经过该网页的创建入口，因此也不会触发 `createTasks` 已有的来源登记。此前测试预先登记页面节点，遗漏了这条初始化路径，原通过记录不能证明此场景已覆盖。

修复位置：`server/src/repository-task-writes.mjs`。`approveCopy` 在验证当前账号、审核权限、任务负责人及当前修订后，对缺失的已认证网页来源登记离线占位：`image_worker_enabled=false`、`last_seen_at=epoch`、`codex_pool_id=NULL`，采用参数化SQL及 `ON CONFLICT DO NOTHING`。既保留人工修订的节点外键与原始账号审计，也不标记执行机在线，不启用图片能力，不创建并发池，不覆盖已有节点配置。登记与评分、人工修订和提交在同一事务内，后续校验失败会一起回滚；无真实actor的兼容调用仍要求节点已注册。管理员图片规划修改写入同一外键的repository路径也复用此处理；其旧HTTP入口按原契约仍返回410，不能当作当前页面入口。

新增 `server/tests/human-review-web-node-postgres.test.mjs`，真实临时PostgreSQL18与实际HTTP路由、不调用模型。16个子场景包括：首次保存评分；首次提交及人工版本/账号审计；修改后保存再提交；单独保存规划后评分仍为ORIGINAL；管理员批准现有修订；废弃；已有执行节点保持不变；他人任务、关闭审核权限、过期会话、未登录拒绝；陈旧修订和低分拒绝；无actor兼容调用；登记后更晚的原稿评分校验失败整体回滚；网页来源不能领取COPY/IMAGE任务；管理员修改图片规划满足外键及继承审计。测试器含父用例计17项。

证据保留在 `reports/full-functional-2026-10-02/`：

| 日志 | 结果及口径 |
| --- | --- |
| `review-node-before-fix-final-fixture.log` | 使用最终合法夹具还原本次修改前的代码：17项7通过10失败；其中7个保存/提交请求复现同一NOT_FOUND，图片规划复现节点外键失败，另有依赖前序成功的断言及父用例失败，不能计成10个独立缺陷 |
| `review-node-after-fix-4.log` | 修后17/17通过，即16子场景加父用例；此前三轮fixture的显式抽检策略、图片链/来源/放行字段错误日志另行保留，不计为产品缺陷 |
| `review-node-existing-server-tests.log` | 相关服务端85/85通过 |
| `review-node-image-review-tests.log` | 图片审核19/19通过；其既有fake补齐已注册节点查询响应 |
| `review-node-all-server-tests-final.log` | 标准服务端1033项，957通过、0失败、76按配置跳过；新增真实PG用例在此默认跳过，已由前述独立运行实际执行 |
| `review-node-browser-regressions.log`、`review-node-browser-drafts.log` | 文案审核、作业模式、草稿实际组件浏览器3/3通过；第一份日志的草稿用例因环境变量名称错误跳过，第二份使用正确开关单独通过。组件后台是HTTP夹具，不冒充真实数据库端到端 |
| `review-node-development-repair.json` | 只向已确认与生产分离的开发库补入1条dev-web-test来源记录，0任务变更、0模型调用、0服务重启；中心及网页均200，原登录会话保持 |

当前已运行的中心仍保留启动时载入的代码；这次补入来源记录让其旧校验立即满足，无需为了这个错误重启或使用户退出登录。后续中心启动时会载入源码中的自动补齐修复。来源占位会在节点列表显示为离线，这与现有网页创建任务的登记方式一致。此次补测与原100条隔离数据、153案例和88项浏览器回归分别计数。
