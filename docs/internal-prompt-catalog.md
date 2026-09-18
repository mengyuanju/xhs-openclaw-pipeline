# 提示词完整目录与使用说明

管理入口：系统 → 提示词。支持跨分类搜索；每项均可查看用途、调用位置、当前发布版本、默认原文和运行时变量。

共 111 项：70 项可编辑模板，41 项只读程序协议。

## 生效规则

- 可编辑模板采用现有草稿、发布和历史版本机制。保存草稿不会改变执行；发布后供新执行加载。
- 未发布补充规则时使用页面展示的默认文件；执行快照冻结该内容和 hash，重试沿用快照。
- 已配置完整执行策略时，必需的业务阶段缺少发布版仍会阻断。补充模板不要求一次性全部发布。
- 程序协议逐字展示，但不能通过提示词编辑绕过 schema、字段长度、图片尺寸、工具边界或校验算法。
- 当前中心已新增 65 项缺失模板的草稿。原 5 项已发布版本保持不变。
- 优秀文案分析的人工分析要求、视觉知识配方和布局库内容继续在知识库或布局库维护；它们属于选定的参考配置，统一目录说明调用位置。
- DEMAND_SCREENING_SYSTEM 是预留项，当前没有运行入口；当前分布式文案流程不执行自动文案审核。
- 独立离线风格检查脚本仅用于维护检验，不参与生产任务。

## 分类概览

| 分类 | 可编辑 | 只读 |
| --- | ---: | ---: |
| 生成与规划 | 8 | 0 |
| 审核与修复 | 10 | 0 |
| 检索与知识库 | 6 | 0 |
| 联调辅助 | 1 | 1 |
| 输出与校验协议 | 0 | 30 |
| 构图补充 | 12 | 0 |
| 失败重试 | 8 | 0 |
| 模型执行协议 | 0 | 10 |
| 图片编辑 | 17 | 0 |
| 编辑检查 | 8 | 0 |

## 每项用途

| 分类 | 提示词 | 用途与触发时机 | 类型 |
| --- | --- | --- | --- |
| 生成与规划 | 文案生成（TEXT_SYSTEM） | 文案初稿生成时调用；标题、正文、人称和结构由此决定。文案修复与审核继承本次冻结的规则。 | 可编辑 |
| 生成与规划 | 配图文案策划（COPY_IMAGE_PLAN_SYSTEM） | 文案初稿、最终正文配图重规划和界面“重新生成规划”使用；确定逐页最终文字和信息顺序。 | 可编辑 |
| 生成与规划 | 视觉规划（VISUAL_PLAN_SYSTEM） | 启用视觉规划时调用，仅规划画面；关闭时跳过模型，由程序适配布局。 | 可编辑 |
| 生成与规划 | 布局模板设计（LAYOUT_CATALOG_SYSTEM） | 管理员在布局库生成候选模板时调用；不参与每次正文生成。 | 可编辑 |
| 生成与规划 | 图片生成（IMAGE_SYSTEM） | 生成每一张完整图文图片时调用，与锁定文字和当前页面数据共同传入图片模型。 | 可编辑 |
| 生成与规划 | 图片编辑（IMAGE_EDIT_SYSTEM） | 人工生成标识、产品融合或局部修改时调用；与本次操作对应的图片编辑补充模板组合。 | 可编辑 |
| 审核与修复 | Query 筛选（选题审核）（QUERY_REVIEW_SYSTEM） | 启用 Query 筛选后，在生成正文前判断准入；默认关闭。 | 可编辑 |
| 审核与修复 | 文案审核（TEXT_REVIEW_SYSTEM） | 自动文案审核启用时检查正文和证据；当前分布式文案流程跳过自动文案审核。 | 可编辑 |
| 审核与修复 | 正文定向修复（COPY_LENGTH_REPAIR_SYSTEM） | 正文长度或句子完整性校验失败时调用，只修改正文。 | 可编辑 |
| 审核与修复 | 格式修复（COPY_REPAIR_SYSTEM） | 文案 JSON 字段、格式或其他结构校验失败时调用。 | 可编辑 |
| 审核与修复 | 质检修订（COPY_REVISION_SYSTEM） | 需要依据质检问题生成修订稿时调用，保留已合格内容。 | 可编辑 |
| 审核与修复 | 图片验收（IMAGE_ALIGNMENT_SYSTEM） | 生图或编辑图片后，核对可见文字、场景、语义和布局；图片编辑也用于原图文字预检。 | 可编辑 |
| 审核与修复 | 质量评分（DELIVERY_REVIEW_SYSTEM） | 整套图片质量评分时调用；评分聚合和阻断阈值由程序执行。 | 可编辑 |
| 审核与修复 | 图片修复（IMAGE_REPAIR_SYSTEM） | 图片验收或整套质检未通过且允许修复时，针对实际问题生成修复请求。 | 可编辑 |
| 检索与知识库 | 需求筛选（DEMAND_SCREENING_SYSTEM） | 预留模板：当前代码没有调用此模板的模型入口。编辑或发布不会改变现有任务，不能用它代替 Query 筛选。 | 可编辑 |
| 检索与知识库 | 资料检索（RESEARCH_SYSTEM） | 文案生成所需的真实联网资料检索阶段调用。 | 可编辑 |
| 检索与知识库 | 案例匹配（COPY_KNOWLEDGE_MATCH_SYSTEM） | 启用知识库且存在候选案例时，为每个案例进行绝对匹配评分。 | 可编辑 |
| 检索与知识库 | 案例借鉴（COPY_KNOWLEDGE_USE_SYSTEM） | 存在入选文案案例时，随文案请求传入，限定可借鉴的方法及事实边界。 | 可编辑 |
| 检索与知识库 | 视觉知识分析（VISUAL_KNOWLEDGE_ANALYSIS_SYSTEM） | 管理员在知识库分析参考图片时调用，提炼视觉配方。 | 可编辑 |
| 联调辅助 | 模拟图片检索（IMAGE_SEARCH_SYSTEM） | 仅用于兼容图片检索模拟流程；正常图片生成不会因此改为网络下载图片。 | 可编辑 |
| 生成与规划 | 自动页数选择（INTERNAL_AUTO_PAGE_COUNT） | 未指定页数时，根据正文的信息量选择页数。 | 可编辑 |
| 输出与校验协议 | 指定页数协议（INTERNAL_FIXED_PAGE_COUNT） | 用户指定页数时，说明 imagePlan 的固定项数。 | 只读程序协议 |
| 输出与校验协议 | 历史文案规则组合（INTERNAL_LEGACY_EDITORIAL_WRAPPER） | 兼容未启用完整运行配置的任务，组合管理员文案规则、配图规则和任务数据。 | 只读程序协议 |
| 输出与校验协议 | 正文配图输出协议（INTERNAL_IMAGE_PLAN_OUTPUT） | 基于最终正文重新规划配图时，约束字段、页数和长度。 | 只读程序协议 |
| 输出与校验协议 | 合规标识叠加协议（INTERNAL_IMAGE_DISCLOSURE_OVERLAY） | 程序后置叠加合规标识时，阻止模型重复绘制。 | 只读程序协议 |
| 输出与校验协议 | 完整页面生成协议（INTERNAL_IMAGE_PAGE_OUTPUT） | 生图时锁定文字、页归属、画布尺寸及布局参数。 | 只读程序协议 |
| 构图补充 | 人工图片配置解读（INTERNAL_IMAGE_MANUAL_LAYOUT） | 用户指定版式、图文区域或背景时，解释这些配置如何影响画面。 | 可编辑 |
| 构图补充 | 实底背景要求（INTERNAL_IMAGE_SOLID_BACKGROUND） | 图片背景配置为不透明纯色时，指定底色及文字对比。 | 可编辑 |
| 输出与校验协议 | 布局库区域协议（INTERNAL_CATALOG_LAYOUT_OUTPUT） | 使用版本化布局模板时，传递模板编码、版本和区域关系。 | 只读程序协议 |
| 输出与校验协议 | 默认布局区域协议（INTERNAL_LEGACY_LAYOUT_OUTPUT） | 使用默认布局时，传递主体和文字区域定义。 | 只读程序协议 |
| 输出与校验协议 | 选题与文案审核协议（INTERNAL_STAGE_REVIEW_OUTPUT） | 选题审核和文案审核共用的通过、拒绝和问题结构。 | 只读程序协议 |
| 输出与校验协议 | 文案审核计数协议（INTERNAL_TEXT_REVIEW_METRICS） | 传递实际字数、合法范围和本次冻结的编辑要求。 | 只读程序协议 |
| 失败重试 | 审核格式重试（INTERNAL_STAGE_REVIEW_RETRY） | 选题或文案审核返回无效 JSON 时，要求完整重答。 | 可编辑 |
| 输出与校验协议 | 正文修复输出协议（INTERNAL_BODY_REPAIR_OUTPUT） | 正文长度或完整性校验失败时，只允许返回完整 body。 | 只读程序协议 |
| 输出与校验协议 | 质检修订输出协议（INTERNAL_QUALITY_REVISION_OUTPUT） | 质检修订必须保留原结构及无关的合格字段。 | 只读程序协议 |
| 输出与校验协议 | 质量评分输出协议（INTERNAL_QUALITY_SCORE_OUTPUT） | 限定评分对象、十个维度和证据结构。 | 只读程序协议 |
| 失败重试 | 质量评分格式重试（INTERNAL_QUALITY_SCORE_RETRY） | 图片终审评分结构不合格时，重查全部图片并补齐字段。 | 可编辑 |
| 输出与校验协议 | 图片验收输出协议（INTERNAL_IMAGE_ALIGNMENT_OUTPUT） | 限定逐字识别、语义和布局判断、失败类型等返回字段。 | 只读程序协议 |
| 输出与校验协议 | 温度单位等价协议（INTERNAL_OCR_CELSIUS_EQUIVALENCE） | 图片验收中 ℃ 与 °C 的等价处理，与程序比较保持一致。 | 只读程序协议 |
| 失败重试 | 图片验收格式重试（INTERNAL_IMAGE_ALIGNMENT_RETRY） | 图片验收结果不符合 JSON 结构时纠正输出格式。 | 可编辑 |
| 输出与校验协议 | 界面配图重规划协议（INTERNAL_REVIEW_IMAGE_PLAN_OUTPUT） | 用户在文案界面重新生成配图文案时，固定字段与正文边界。 | 只读程序协议 |
| 失败重试 | 配图文案格式重试（INTERNAL_REVIEW_IMAGE_PLAN_RETRY） | 重新规划配图返回无效结构或超长文字时，携带原错误重试。 | 可编辑 |
| 输出与校验协议 | 非文字画面元素协议（INTERNAL_VISUAL_ELEMENTS_ONLY） | 视觉规划仅输出画面元素；可见文字由程序按锁定文案重建。 | 只读程序协议 |
| 输出与校验协议 | 视觉证据引用协议（INTERNAL_VISUAL_EVIDENCE_OPTIONS） | 视觉证据必须从服务端候选中逐字选择。 | 只读程序协议 |
| 失败重试 | 视觉规划局部重试（INTERNAL_VISUAL_PLAN_RETRY） | 视觉规划部分页面失败时，仅返回失败页面并保留已通过页面。 | 可编辑 |
| 输出与校验协议 | 模拟图片检索协议（INTERNAL_IMAGE_SEARCH_OUTPUT） | 限定图片检索候选页数、公开网址和归属信息。 | 只读程序协议 |
| 失败重试 | 模拟图片检索重试（INTERNAL_IMAGE_SEARCH_RETRY） | 兼容图片检索返回空值或错误结构时重新搜索。 | 可编辑 |
| 模型执行协议 | 联网检索工具协议（INTERNAL_SEARCH_TOOL_EXECUTION） | DeepSeek 联网搜索请求的工具和输出约束。 | 只读程序协议 |
| 模型执行协议 | 检索收尾执行协议（INTERNAL_SEARCH_FINALIZATION） | 搜索结束后，仅用已有证据整理结果，不再调用搜索。 | 只读程序协议 |
| 模型执行协议 | 检索收尾输出协议（INTERNAL_SEARCH_FINAL_JSON） | 搜索收尾时输出摘要和来源，证据不足时返回空来源。 | 只读程序协议 |
| 模型执行协议 | Codex 图片执行协议（INTERNAL_CODEX_IMAGE_EXECUTION） | 图片生成或编辑时，约束原生工具调用、画布和文件输出。 | 只读程序协议 |
| 模型执行协议 | Codex 编辑附件协议（INTERNAL_CODEX_EDIT_ATTACHMENT） | 图片编辑时区分编辑目标和后续参考图。 | 只读程序协议 |
| 模型执行协议 | Codex 生图附件协议（INTERNAL_CODEX_IMAGE_ATTACHMENT） | 新图生成时将附件解释为视觉参考。 | 只读程序协议 |
| 模型执行协议 | Codex 检索执行协议（INTERNAL_CODEX_SEARCH_EXECUTION） | 要求真实联网搜索及对应来源，外部内容仅作数据。 | 只读程序协议 |
| 模型执行协议 | Codex 文本执行协议（INTERNAL_CODEX_TEXT_EXECUTION） | 文案或审核调用的工具禁用、数据隔离及返回封装。 | 只读程序协议 |
| 模型执行协议 | Codex 结构化返回协议（INTERNAL_CODEX_STRUCTURED_OUTPUT） | 提供输出 schema 时直接返回业务 JSON。 | 只读程序协议 |
| 模型执行协议 | Codex 原文封装协议（INTERNAL_CODEX_RAW_TEXT_OUTPUT） | 未提供业务 schema 时，将完整答案放入 rawText。 | 只读程序协议 |
| 构图补充 | 视觉布局选择（INTERNAL_VISUAL_LAYOUT_SELECTION） | 启用布局库的视觉规划中，从候选模板选择版式并说明原因。 | 可编辑 |
| 输出与校验协议 | 视觉规划输出协议（INTERNAL_VISUAL_PLAN_OUTPUT） | 固定视觉规划页数、锁定文字、证据及画布要求。 | 只读程序协议 |
| 输出与校验协议 | 案例匹配评分协议（INTERNAL_KNOWLEDGE_MATCH_OUTPUT） | 对每个知识候选的原始 ID 返回一条绝对匹配分数。 | 只读程序协议 |
| 输出与校验协议 | 资料检索输出协议（INTERNAL_RESEARCH_OUTPUT） | 真实联网检索必须返回摘要及限定数量的可核对来源。 | 只读程序协议 |
| 输出与校验协议 | 布局候选输出协议（INTERNAL_LAYOUT_CANDIDATE_OUTPUT） | 布局库生成只返回模板结构；来源及启用状态由程序设置。 | 只读程序协议 |
| 输出与校验协议 | 视觉知识分析协议（INTERNAL_VISUAL_KNOWLEDGE_OUTPUT） | 定义视觉知识分析字段、类型、变量和评分范围。 | 只读程序协议 |
| 检索与知识库 | 优秀文案知识分析（INTERNAL_COPY_ANALYSIS） | 按知识库中管理员选定的分析要求提炼标题、摘要、完整分析和分类标签。 | 可编辑 |
| 图片编辑 | 人工生成标识编辑（INTERNAL_EDIT_DISCLOSURE） | 通过图片模型为完整原图添加指定合规标识，保留已有内容。 | 可编辑 |
| 图片编辑 | 产品可见外观替换（INTERNAL_EDIT_PRODUCT_APPEARANCE） | 外观参考模式下，仅迁移参考图明确展示的主产品外观。 | 可编辑 |
| 图片编辑 | 产品完整身份替换（INTERNAL_EDIT_PRODUCT_STRICT） | 严格参考模式下，将选中目标替换为参考产品的完整身份与结构。 | 可编辑 |
| 图片编辑 | 失败图修复附件说明（INTERNAL_EDIT_REPAIR_ATTACHMENTS） | 定向补救以失败图为编辑目标，以最初源图作核对参考。 | 可编辑 |
| 图片编辑 | 整图移动附件说明（INTERNAL_EDIT_MOVE_ATTACHMENTS） | 整图移动时，第二张原图用于保护未点名对象。 | 可编辑 |
| 图片编辑 | 移动几何引导图说明（INTERNAL_EDIT_MOVE_GUIDE） | 有几何引导图时，解释目标位置与液流颜色，不复制引导线。 | 可编辑 |
| 图片编辑 | 语义位置图说明（INTERNAL_EDIT_ROLE_GUIDE） | 有位置引导图时，解释原位置、目标位置和接触区域的颜色。 | 可编辑 |
| 图片编辑 | 移除标识内容保护（INTERNAL_EDIT_REMOVE_PRESERVE） | 移除指定标识时，保留其余区域和文字。 | 可编辑 |
| 图片编辑 | 移除标识修改边界（INTERNAL_EDIT_REMOVE_NEGATIVE） | 移除指定标识时，禁止修改其余文字和未点名区域。 | 可编辑 |
| 图片编辑 | 对象移动整图编辑（INTERNAL_EDIT_MOVE_FULL_FRAME） | 移动任务同时完成原位置修复、目标重建和接触关系。 | 可编辑 |
| 图片编辑 | 对象移动失败补救（INTERNAL_EDIT_MOVE_REPAIR） | 整图移动失败后，补齐未完成项并保证完整移动任务成立。 | 可编辑 |
| 图片编辑 | 局部蒙版编辑（INTERNAL_EDIT_LOCAL_MASK） | 以蒙版约束局部编辑，并在移动时同时处理原位置和新位置。 | 可编辑 |
| 图片编辑 | 蒙版编辑失败补救（INTERNAL_EDIT_MASK_REPAIR） | 蒙版编辑失败后，只处理未完成部分。 | 可编辑 |
| 图片编辑 | 移除指定生成标识（INTERNAL_EDIT_REMOVE_DISCLOSURE） | 在允许的选区中移除任务点名的标识，其他文字保持原样。 | 可编辑 |
| 图片编辑 | 按文字定位局部编辑（INTERNAL_EDIT_LOCAL_TEXT） | 没有蒙版时，根据作业员说明定位并修改指定对象。 | 可编辑 |
| 图片编辑 | 历史整图编辑（INTERNAL_EDIT_LEGACY_FULL） | 兼容历史整图修改请求，保留未明确要求修改的内容。 | 可编辑 |
| 编辑检查 | 产品替换目标定位检查（INTERNAL_EDIT_TARGET_CHECK） | 付费编辑前核对选区内目标数量、保护范围及参考图可用性。 | 可编辑 |
| 构图补充 | 老抽勺移动构图特例（INTERNAL_EDIT_SOY_SPOON_GEOMETRY） | 仅匹配“加半勺老抽”类目标时，使用现有勺子位置、容量和液流构图规则。 | 可编辑 |
| 构图补充 | 移动目标参考区域（INTERNAL_EDIT_DESTINATION_BAND） | 提供目标横向参考带，避开文字及画面边缘。 | 可编辑 |
| 构图补充 | 老抽勺目标位置特例（INTERNAL_EDIT_SOY_SPOON_DESTINATION） | 老抽勺移动分支的目的位置描述。 | 可编辑 |
| 构图补充 | 勺子移动可见性（INTERNAL_EDIT_SPOON_VISIBILITY） | 移动目标为勺子时，要求勺碗和完整勺柄同时可见。 | 可编辑 |
| 构图补充 | 非目标生抽勺保护特例（INTERNAL_EDIT_SOY_SPOON_PROTECTION） | 老抽勺移动时，保留画面中另一个生抽勺。 | 可编辑 |
| 构图补充 | 贴边目标移动留白（INTERNAL_EDIT_EDGE_CLEARANCE） | 原目标贴右边或底边时，为移动后的完整目标保留边缘空隙。 | 可编辑 |
| 图片编辑 | 对象移动完整指令（INTERNAL_EDIT_MOVE_INSTRUCTION） | 把编辑计划中的目标、构图、数量、关系和原位置修复组合为移动指令。 | 可编辑 |
| 构图补充 | 液流接触关系（INTERNAL_EDIT_FLOW_CONTACT） | 存在倾倒关系时，要求液流在容器内部接触并结束。 | 可编辑 |
| 编辑检查 | 自然语言局部编辑规划（INTERNAL_EDIT_LOCAL_PLAN） | 编辑前将作业员说明转为目标、区域及修改计划，返回可执行、建议或阻断。 | 可编辑 |
| 编辑检查 | 局部编辑结果验收（INTERNAL_EDIT_LOCAL_REVIEW） | 对编辑前后图核对修改完成度、构图、目标完整性和文字保护，并生成失败修复建议。 | 可编辑 |
| 编辑检查 | 定向修复验收附件说明（INTERNAL_EDIT_REVIEW_ATTACHMENTS） | 定向补救验收同时比较最初源图、上次失败图和本次修复图。 | 可编辑 |
| 编辑检查 | 标识位置与样式检查（INTERNAL_EDIT_DISCLOSURE_CHECK） | 检查指定标识出现次数、位置、字体和可读性。 | 可编辑 |
| 编辑检查 | 真实产品替换验收（INTERNAL_EDIT_PRODUCT_REVIEW） | 替换后核对产品身份、目标位置、替换数量和无关内容保护。 | 可编辑 |
| 编辑检查 | 外观参考验收尺度（INTERNAL_EDIT_APPEARANCE_REVIEW） | 外观模式只核对主产品可见细节及补全合理性。 | 可编辑 |
| 编辑检查 | 完整参考验收尺度（INTERNAL_EDIT_STRICT_REVIEW） | 严格模式核对产品结构、颜色、材质及部件拓扑。 | 可编辑 |
| 输出与校验协议 | 关闭合规标识协议（INTERNAL_IMAGE_NO_DISCLOSURE） | 关闭合规标识时，禁止模型自行添加标识。 | 只读程序协议 |
| 构图补充 | 自定义布局补充（INTERNAL_CUSTOM_LAYOUT） | 使用人工指定布局时，模型补充尚未指定的细节。 | 可编辑 |
| 构图补充 | 透明背景要求（INTERNAL_TRANSPARENT_BACKGROUND） | 用户选择透明背景时，保留透明像素并保证文字可读。 | 可编辑 |
| 输出与校验协议 | 格式修复输出协议（INTERNAL_COPY_REPAIR_OUTPUT） | 格式修复只返回原结构并修改失败字段及必要联动。 | 只读程序协议 |
| 审核与修复 | 正文修复信息保留（INTERNAL_BODY_REPAIR_COMPLETENESS） | 正文压缩或补全时，保留关键事实和数字并完整收尾。 | 可编辑 |
| 输出与校验协议 | 图片修复文字锁定协议（INTERNAL_IMAGE_REPAIR_BOUNDARY） | 验收失败后的图片修复必须保留锁定文字和页归属。 | 只读程序协议 |
| 审核与修复 | 质量问题修复方法（INTERNAL_QUALITY_REPAIR_METHOD） | 将质量评分证据转成对应维度的修复要求。 | 可编辑 |
| 输出与校验协议 | 质量修复页归属协议（INTERNAL_QUALITY_REPAIR_BOUNDARY） | 质量修复只处理本页问题，不更换页面信息职责。 | 只读程序协议 |
| 失败重试 | 优秀文案分析格式重试（INTERNAL_COPY_ANALYSIS_RETRY） | 知识分析无法解析时，要求重新返回完整 JSON。 | 可编辑 |
| 输出与校验协议 | 案例事实隔离协议（INTERNAL_KNOWLEDGE_FACT_BOUNDARY） | 借鉴案例时限制案例仅提供表达方法，不能成为选题事实来源。 | 只读程序协议 |
| 生成与规划 | 人工文案更新后的视觉重规划（INTERNAL_MANUAL_COPY_REPLAN） | 人工修改正文后，旧画面方向只保留页类型，具体内容跟随新规划。 | 可编辑 |
| 输出与校验协议 | 文案完整结构协议（INTERNAL_POST_OUTPUT） | 每次生成完整文案时，与管理员文案规则及配图规则共同组成请求。 | 只读程序协议 |
| 联调辅助 | 套图风格离线检查协议（INTERNAL_STYLE_AUDIT_TOOL） | 只在 scripts/audit-image-set-style.mjs 独立检验工具运行时调用；输出字段和判定尺度与脚本机械检查对应。 | 只读程序协议 |
| 输出与校验协议 | 本地图片编辑输出协议（INTERNAL_LOCAL_IMAGE_EDIT_OUTPUT） | 本地管理界面的图片修改任务调用；不改变已有交付页的文字验收。 | 只读程序协议 |
| 失败重试 | 最终正文分页格式重试（INTERNAL_DYNAMIC_IMAGE_PLAN_RETRY） | 本地完整管线依据最终正文重新分页，首次规划输出不合格时调用。 | 可编辑 |

## 维护约定

- 业务规则放在 prompts/business 或 server/prompts；补充规则及程序协议放在 prompts/internal。prompts/post.md 是完整文案输出协议。
- 新增模型指令必须登记 src/prompt-catalog.mjs 或 src/internal-prompt-catalog.mjs，写明用途、调用位置和变量。不要在模型调用处重新写一套隐藏规则。
- 补充规则通过 internalPrompt 渲染；业务阶段通过 businessPrompt 渲染。两者共用冻结运行时、版本存储和调用溯源。
- slot 占位符保存时逐项检查，不能漏掉当前阶段需要的输入数据；变量按一次替换展开，不递归执行用户输入。
- 图片编辑请求冻结 IMAGE_EDIT_SYSTEM、图片验收规则和补充规则；知识分析入口同样加载当前模板运行时。
- 只读协议的 API 写入也被拒绝，不能仅依赖界面禁用按钮。

## 验证

使用本地假模型与浏览器接口夹具检查版本加载、变量保护、并发隔离、冻结重放、草稿保存和只读边界；不消费真实模型额度。

运行已部署到本机的提示词页面；其他执行节点需要同步这些代码后，才能通过新增模板替换其原有内置规则。未更新节点仍使用其原有代码。
