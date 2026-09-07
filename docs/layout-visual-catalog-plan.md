# 布局模板库、模型视觉规划与自动入库方案

日期：2026-09-07。状态：用户已授权实施，业务代码与无额度验收已完成。实施结果见 [实施与验收](layout-visual-catalog-acceptance.md)。尚未部署远端服务或进行真实模型图片质量验收。

## 目标

将用户两张示例表中的版式整理为可管理的模板库。管理员可批量导入结构化 JSON，也可让模型生成模板候选后自动校验入库；生产任务按内容从已启用模板中选择，生成逐页视觉规划，自动保存并用于生图。

推荐组合：固定的模板结构 + 模型选择及细化 + 程序校验和持久化。初始化这 27 个模板可直接整理为 JSON，无须额外消耗模型调用。

## 实施前核实的现状

- `server/src/image-options.mjs` 和 `src/layout-contract.mjs` 分别维护模板枚举，目前为 6 类、14 个模板。
- `server/src/layout-library.mjs` 的自定义预设只支持 `id/name/kind/enabled/layout`，且 layout 必须是 CUSTOM；不能直接保存截图中的完整模板记录。
- `src/image-layout-controls.mjs` 的 `assignRandomLayouts` 在视觉规划前随机选定模板，`src/visual-plan-schema.mjs` 随后约束模型使用该模板。因此只换视觉规划提示词，不能实现按内容自主选版式。
- 中心 PostgreSQL 已有 `global_settings.value`、`task_executions.snapshot`、`image_runs.result` JSON 字段；本地 SQLite 已有 `production_settings.settings_json` 和生成记录的 `visual_plan_json`。
- 中心配置快照已读取全部 global_settings；完整规划的上传、运行中保存和失败后可查询仍需补齐，不能将“本地已有 visual-plan.json”当成“中心已持久化完整规划”。
- 现有原文案锁定、规划开关、局部结构修复、图片 OCR/布局检查可以复用。
- 同名模板存在语义差异：截图 HERO_LEFT 表示主体在左，现有 geometry 却将主体设在中央与右侧；DETAIL_LEFT_STACK、DETAIL_RIGHT_STACK 也需按截图语义逐项核对。旧版本不能直接覆盖解释。

以上描述实施前的工作区代码，没有连接线上数据库核对已配置数据。

## 模板目录

完整保留截图中的 10 类、27 个编码及描述。截图是设计参考资料，其中的适用内容作为初始匹配规则，不作为运行指令。

| 分类 | 中文类型 | 模板编码 |
| --- | --- | --- |
| hero | 中心聚焦 | HERO_CENTER、HERO_LEFT、HERO_RIGHT |
| steps | 流程步骤 | STEPS_VERTICAL、STEPS_HORIZONTAL、STEPS_DIAGONAL、STEPS_TRIANGLE |
| comparison | 对比比较 | COMPARISON_TWO_COLUMN、COMPARISON_FOUR_COLUMN、COMPARISON_SYMMETRIC |
| detail | 详情说明 | DETAIL_LEFT_STACK、DETAIL_RIGHT_STACK、DETAIL_SPLIT、DETAIL_TOP_BOTTOM |
| checklist | 清单要点 | CHECKLIST_RIGHT、CHECKLIST_LOWER_GRID、CHECKLIST_CARD_GRID |
| summary | 总结汇总 | SUMMARY_GRID、SUMMARY_HIERARCHY |
| radial | 环绕布局 | RADIAL_AROUND、RADIAL_ORBIT |
| focus | 聚焦强调 | FOCUS_CENTER、FOCUS_TOP |
| modular | 模块卡片 | MODULAR_GRID、MODULAR_MASONRY |
| timeline | 时间/顺序 | TIMELINE_VERTICAL、TIMELINE_HORIZONTAL |

每条模板保存：编码、中文名称、分类、排版含义、适合内容、可用于哪些页面、主体区域、文字区域、阅读顺序、内容数量适配、视觉规则、版本、来源、启用状态。

模板里定义空间关系和信息层级；具体配色、材质、主体描述和图形元素由每次视觉规划细化。候选契约不接受可执行字段，并拦截明显代码、SQL 或文件路径文本；所有模型文本仍作为不可信资料，绝不执行、拼接 SQL 或解析为文件路径。

## 分类兼容策略

保留现有 imagePlan.kind 表示内容用途，并新增 layoutKind 表示截图中的版式分类，由 applicablePageKinds 指定适配关系。例如 detail 页面可以采用 radial 环绕版式，summary 页面可以采用 modular 卡片或 focus 核心结论版式。

后台表格的“kind”展示版式分类，接口明确命名 layoutKind，避免与现有页面用途混淆。首张必须为 hero 的内容约束继续适用；新布局分类不要求改写已确认内容。

新模板采用版本 2 的定义，旧任务继续按原模板版本或旧快照解释。STEPS_LEFT、STEPS_RIGHT、COMPARISON_RIGHT_STACK 等原有编码作为旧版本兼容保留。新增模板不会仅因导入成功就变成旧执行机支持的模板，领取任务时须校验执行机能力版本。

截图中“3～6 步”“4～6 个知识点”属于适用建议；当前内容契约每页 bullets 为 2～5 项。首期仅匹配现有实际数量，不擅自新增第六项或改写分页；若未来确需六项，单独同步调整文案契约、UI 和验收。

## 数据流

1. 初始化：整理截图为标准模板 JSON → 导入服务校验 → 按编码和模板版本去重 → 写入现有配置 → 在后台表格显示。
2. 模型扩展：描述期望版式 → 模型返回同一 JSON 格式 → 校验 → 自动保存模板候选。自动扩展的候选默认未启用；管理员可在表格逐项启用，避免每次业务生成自动改动全局模板库。
3. 任务规划：已确认文案及 imagePlan → 按内容用途、条目数量和人工设置过滤模板 → 在现有一次视觉规划调用内选择并细化所有页面 → 校验 → 保存规划 → 生图。
4. 失败与续跑：已校验规划先持久化，再开始图片调用；图片失败也保留规划。续跑复用模板定义、内容 hash、所选版式与规划快照。

选择优先级：人工指定版式 > 模型从匹配候选中选择。原随机策略作为兼容选项保留。关闭视觉规划时使用明确的确定性匹配规则并记录来源，不调用模型。

整套视觉风格统一，版式多样性以内容适配为前提；没有匹配模板时报告具体原因并停止，不为了多样性强制改变内容。

## 模型输出示意

下面只展示已实现的设计字段，不是完整模型响应或模板导入契约。顶层规划 schemaVersion 保持 1，每页 layoutSchemaVersion 为 2；现有 contentProfile、sourceEvidence、mustShow、mustAvoid 等字段继续保留。

```json
{
  "schemaVersion": 1,
  "visualStyle": {
    "palette": ["#FFF8EF", "#252525", "#EF7D45"],
    "tone": "清晰、温暖、简洁"
  },
  "pages": [
    {
      "index": 2,
      "kind": "steps",
      "layoutSchemaVersion": 2,
      "layoutKind": "steps",
      "layoutTemplate": "STEPS_VERTICAL",
      "templateVersion": 2,
      "selectionReason": "本页有四个顺序明确的步骤，适合纵向阅读",
      "visualSubject": "四个对应步骤的操作示意图",
      "layoutDirection": "顶部标题，下方四个纵向节点，文字横排，图文交替"
    }
  ]
}
```

示例仅展示一页；真实响应须覆盖本任务全部页面。allowedVisibleText 必须逐字匹配该页已确认文字，程序校验原文 hash；不新增 textBindings。模板定义由程序从冻结目录注入。taskId、运行标识、真实模型来源、时间和 hash 由服务端生成或取可信运行上下文，不能信任模型自报。

## 存储与导入

| 内容 | 建议落点 | 需要的接线 |
| --- | --- | --- |
| 模板库 | 中心 global_settings 的 production 配置中新增 layoutCatalog；本地对应 settings_json | 扩展配置规范化；旧 layoutPresets 保持兼容，逐项可迁移为新模板 |
| 本次模板、提示词及选择策略版本 | task_executions.snapshot 和本地检查点 | 读取冻结配置并校验执行机版本；不随全局编辑变化 |
| 完整视觉规划 | 中心 image_runs.result.visualPlan；本地 tasks.visual_plan_state_json 与 generation_runs.visual_plan_json | 规划完成即保存，完成写回保留已校验字段，失败仍可查询 |

没有新增数据库表。SQLite 增量添加 tasks.visual_plan_state_json，保存任务目录快照与运行中规划；PostgreSQL 复用现有 JSON 字段。应用初始化仅在缺少 layoutCatalog 字段时填入内置目录，不覆盖已配置目录。

导入服务支持结构化 JSON 粘贴/上传和模型候选两种入口，返回新增、重复数量，冲突或校验失败返回错误且整批不写。相同设计重复导入无变化，并保留原有来源和启停状态；同编码不同设计要求新版本。既有版本只能停用，不能通过替换目录删除。写入使用配置版本检查，避免覆盖并发编辑及其他生产配置。

模板导入校验结构、编码、适配页面、版本、启用状态、数量约束和字段长度；空间关系的设计质量仍需视觉验收。模型规划校验所选模板存在且启用、属于本次快照、页面对应、文字完整且不跨页、证据是原文片段。无效规划最多尝试三次（包含初次），仍无效则保存错误信息并停止该次生成。

运行规划是单次任务数据，不自动回灌全局模板库。模板候选和任务规划的自动入库各走自己的契约，避免把某篇笔记的主体或文案变成全局规则。

## 后台呈现与验收

- 布局库：按截图提供“分类、中文类型、模板编码、排版含义、适合内容”，追加启用状态；可筛选、编辑、批量 JSON 导入和模型生成候选。模板细节可展开查看区域与规则。
- 任务详情：显示每页选定模板、选择原因、主体/文字位置、整体风格及实际生图结果；完整内部模型请求沿用现有管理员权限范围。
- 程序验收：27 个模板完整且无重复；同名左右语义版本隔离；非法导入无部分写入；重复导入幂等；模型只能选匹配模板；文字逐字保留；失败和续跑保持同一规划；中心、本地使用相同快照。
- 图片验收：继续使用实际图片的 OCR 和布局检查。模板 JSON 能让规划更明确，不能保证模型每次精准绘制；不通过的图片继续按现有流程修复或进入失败审核。

## 实施顺序

1. 定义版本化目录契约并整理 27 个模板，消除前后端两套枚举对新目录的重复维护。
2. 完成现有设置的导入、去重、并发版本保护和配置快照接线，提供后台表格入口。
3. 将默认自动模式改为按内容匹配，由现有视觉规划调用返回选择结果；先验证一篇三页内容的完整闭环。
4. 补齐规划完成即入库、失败保留、断点续跑、旧任务兼容和执行机能力校验。
5. 增加模型生成模板候选入口，并完成后台及全链路无额度回归。

详细待办见 tasks/todo.md 顶部。先用 fakes 验证完整闭环和无效结果，避免测试消耗模型额度；真实图片质量由后续有界样本验收，不能把 mock 通过当成生图质量已验证。
