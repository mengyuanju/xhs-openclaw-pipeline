# 提示词治理实施与验收

日期：2026-09-07。代码与测试已完成；未部署中心或执行机，未替换生产提示词、发布候选草稿或启用生产配置。

## 已完成的六组功能

1. **提示词人工管理**：共19类，按生成与规划、审核与修复、检索与知识库、联调辅助分组。保留原有3类人工版本，其余16类初始化为草稿。支持保存、发布、历史全文、载入历史内容、当前版本与编辑稿对照、变量展开预检。优秀文案分析继续使用知识库已有人工模板。
2. **视觉规划开关与原文锁定**：默认建议关闭，关闭时规划模型调用为0；开启时使用已发布视觉规则，只设计画面。逐页标题、副标题、要点、顺序和归属由原策划锁定并保存hash；不一致时阻止生图，不以mock规划兜底冒充模型结果。
3. **清除隐式覆盖**：文案修复继承原规则；删除审核人称降级和固定文风。完整图片提示词不再按标记截断重写。图片修复不按页码强制重构；统一规则模式下图片编辑不再程序叠字。引用或否定“绝对有效、我亲测”等文字不再被关键词规则误判为虚构，虚构经历标记仍必须为false。
4. **可见的执行参数**：案例入选分数、长度修复目标、OCR置信度和比较方式均由同一配置驱动。现有正文范围、评分计算、模型协议等固定契约单独展示。评分保留模型原始判断、机械判断、合并结果及最终分数，不能用修改自然语言来假装修改算法。
5. **单一来源与历史恢复**：配置有中心时取中心，失败不回退本地。执行冻结提示词及参数；独立图片恢复同时冻结生产业务参数、视觉参考和图片规则，仅允许更新模型传输配置。大快照完整读取，缺失、损坏、超限或规则hash不符时拒绝恢复。旧产物仍可查看，缺少足够历史证据时需从原文案新建执行。
6. **管理员追踪与各入口覆盖**：生成、筛选、视觉知识分析、本地worker、图片编辑和模拟器接入规则。管理员可查冻结版本和实际脱敏请求；普通用户与审核员不能读取这些页面/API。中心优秀文案分析记录人工模板来源。OpenClaw原始搜索不能接收业务规则，统一模式明确拒绝该通道，需选择Codex或DeepSeek检索。

## 关键代码

| 范围 | 主要文件 |
| --- | --- |
| 目录、组合、变量与快照 | [prompt-catalog.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/prompt-catalog.mjs)、[prompt-runtime.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/prompt-runtime.mjs)、[prompt-runtime-service.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/prompt-runtime-service.mjs) |
| 后台配置、预检、历史 | [prompt-runtime-settings.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/prompt-runtime-settings.tsx)、[prompt-preview.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/prompt-preview.tsx)、[prompt-editor.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/prompt-editor.tsx)、[central-prompt-workbench.tsx](C:/Users/HMCD-0005/Desktop/xhs/app/prompts/central-prompt-workbench.tsx) |
| 原文锁定及规划 | [locked-image-plan.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/locked-image-plan.mjs)、[visual-plan-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/visual-plan-generation.mjs)、[visual-plan-schema.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/visual-plan-schema.mjs) |
| 审核、修复、恢复 | [copy-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/copy-generation.mjs)、[content-stage-review.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/content-stage-review.mjs)、[image-alignment.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/image-alignment.mjs)、[standalone-image-generation.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/standalone-image-generation.mjs) |
| 本地兼容及调用记录 | [prompt-governance-store.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/prompt-governance-store.mjs)、[prompt-execution.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/admin/prompt-execution.mjs)、[model-call-trace.mjs](C:/Users/HMCD-0005/Desktop/xhs/src/model-call-trace.mjs) |

中心与执行机按最小必要范围接入：中心权限、规则发布校验、知识分析及记录读取在现有HTTP层补齐；执行机传入既有执行快照，模拟器使用同一规则。**本次治理没有新增中心数据库迁移，也没有修改中心调度、心跳、并发或领取协议。**共享业务代码需要随节点一起升级。工作区已有图片控制与请求展示的并行改动予以保留，不把其数据库/业务变更计入本报告。

## 自动化与浏览器验收

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 主工程全量测试 | 927/927通过，0跳过 | [测试日志](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-final-tests.log) |
| 中心服务全量测试 | 146/146通过，0跳过 | [测试日志](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-final-server.log) |
| 生产构建 | 通过 | [构建日志](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-final-build.log) |
| 类型检查 | 通过 | [类型日志](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-final-typecheck.log) |
| Mock冒烟 | 完成，产物明确标记mock_only | [冒烟日志](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-smoke.log) |
| Web角色隔离 | USER/REVIEWER访问规则、配置、预览、记录及页面共10项均403 | [HTTP记录](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-web-http.json) |

自动化使用假客户端，不消耗模型额度。回归包含：开关零调用、文字换序/重复/更字拒绝、修复字段权限、不同执行并发规则隔离、历史版本冻结、一次性本地迁移、288KB合法配置完整读取、坏JSON/丢失/hash篡改拒绝、提示词闭合标签转义、旧底图规则发布冲突、程序不叠字，以及普通角色不能领取含完整配置的执行。

真实Chrome浏览器使用独立临时数据库和临时会话，在127.0.0.1:3107完成：19类目录、缺项阻止启用、非法变量错误、草稿v2、发布v3、历史全文、当前稿对照、示例变量展开、开关开启保存及刷新保持、关闭保存、管理员执行记录列表与完整配置展示。原有3类版本在该测试中保持不变。测试服务与标签页已关闭。

## 真实模型验收及定位结论

实际使用项目客户端和候选规则，未发布生产版本。图片由真实图像模型生成/编辑，OCR由真实视觉模型执行；没有用程序叠字来制造通过结果。

| 测试 | 观察 | 处理结果 |
| --- | --- | --- |
| 原始样本关闭规划 | 规划调用0次，原策划文字传入；模型额外绘出“求职简历”等文字，且交付图有边缘文字不完整 | OCR拒绝，保留原图与验收结果 |
| 开启规划的接口验证 | 当前接口不接受bullets的数组const | 改为字符串枚举与精确数量，程序继续检查顺序和全文 |
| 原始历史策划检查 | 正文仅“2023年成立”，原配图却“2023年10月30日成立”；模型还可能复制这段为正文证据 | 增加两种模式共用的数字来源前置检查；原句证据提供可选值，仍逐字验证 |
| 显式修正副本开启规划 | 仅把测试副本的额外日期改为正文已有年份，修改单独记录；规划1次通过，全部4页文字锁定一致 | 生成第1页，额外文字及布局问题被验收拒绝 |
| 第1页真实编辑修复与复审 | 按冻结原请求及本次问题修复，保留标题、副标题和3条要点；额外文字删除 | OCR逐字匹配，差异为空、置信度0.99，单页验收通过 |

这说明偏差可分别发生在**前置策划、视觉规划及模型绘制**。新代码把错误定位并拦截；单靠更换提示词无法保证每次绘制都正确。

证据：[原样本关闭规划结果](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live/summary.json)、[修正副本及修改说明](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live-v4/diagnostic-source.json)、[一次通过的视觉规划](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live-v4/planning-on-plan.json)、[修复前验收](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live-v4/planning-on-alignment.json)、[修复后验收](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live-v4/repair/alignment.json)、[修复后图片](C:/Users/HMCD-0005/Desktop/xhs/.codex_artifacts/prompt-governance-live-v4/repair/delivery.png)。完整脱敏调用分别保存在这些诊断目录的prompt-runs子目录。

## 上线顺序与验证边界

1. 备份现有配置，先升级Web、中心的薄接口及全部执行机共享业务代码；本地SQLite首次读取自动进行兼容迁移。不要在仍有旧执行机时提前启用新开关。
2. 管理员准备并逐项优化、发布新增草稿；原有3类人工规则保留，需要修改时发布新版本。已知旧底图冲突会明确提示；预览是模板级预检，不能自动判断所有自然语言规则是否矛盾。
3. 保存执行配置启用统一规则，先小批运行，从实际请求中核对版本、模式、锁定文案及OCR，再扩大规模。历史已冻结执行继续原配置；缺失快照的老运行可查看，不能伪装成按原规则恢复。

权限验收覆盖用户会话和管理员API。中心匿名机器接口沿用既有可信网络设计，必须仅允许Web与执行机所在受控网络访问；本次没有新增机器身份认证，不宣称中心可任意匿名直连仍隔离完整快照。

真实测试覆盖规划开关与单页生图、失败、修复、OCR闭环；没有对所有19类业务逐项进行真实账户调用，没有完成整套四页终审或长期压力测试。数字来源检查只是可机械检查的前置条件，不能代替事实审核。图片裁切问题属于独立处理链，本次未声称修复。模型服务商内部未公开规则不在本项目可管理或可展示范围内。
