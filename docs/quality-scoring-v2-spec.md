# Spec: 规则文档 0–3 分质量评分 V2

## Objective

新增一套基于原始验收规则的 0–3 分评分引擎，采用“是否满足 → 是否可用 → 是否优质 → 类型校正 → 最低阻碍分”的漏斗。现有机械 QC 继续负责收集可复核证据；新引擎负责维度校正、分层聚合和最终处置，不用平均分掩盖硬伤。

成功结果必须同时满足：

- 0 分仅用于安全、法律、健康、隐私或严重误导红线。
- 1 分用于需求满足度低于 2、严重重复，或任一适用基础可用维度低于 2。
- 2 分用于所有基础维度合格，但任一适用维度仍为 2 或存在轻微问题标签。
- 3 分只在所有适用维度经类型校正后均为 3、没有问题标签，并具有独立人工或 VLM 终审证据时产生。
- 未提供站内正文和图集候选时，`contentOriginality` 保留为 `applicable: false` 的未核验标识，不参与 3 分门禁；字节级重复图片仍按严重重复阻断。
- 只有机械证据且平台样本缺失或未核验时，平台表达适配最高为 2；独立人工/VLM 对最终交付完成直接平台评审时记录为 `direct_review`。
- 缺少必需维度证据时返回“证据不足”，不得猜测分数。

## Tech Stack

- Node.js 24 ESM
- `node:test` / `node:assert`
- 现有 `src/qc.mjs`、SQLite 生成记录和 JSON 交付文件
- 不新增依赖，不修改数据库 schema

## Commands

- 定向测试：`node --test tests/quality-scoring.test.mjs tests/qc.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`

## Project Structure

- `src/quality-scoring.mjs`：纯评分契约、输入校验、类型校正和漏斗聚合。
- `src/qc.mjs`：把现有机械证据映射为保守的评分维度，并保持旧字段兼容。
- `src/quality-assessment.mjs`：对最终标题、正文和 3–5 张图片执行独立 VLM 终审，输出完整十维证据。
- `tests/quality-scoring.test.mjs`：覆盖 0/1/2/3、前置终止、平台封顶、校正和证据不足。
- `tests/qc.test.mjs`：覆盖机械 QC 与评分 V2 的集成结果。
- `docs/quality-scoring-v2-spec.md`：评分来源、契约和边界。

## Interface Contract

评分输入包含：

- `dimensions`：每个维度的 `score`、`evidence`、`source` 和 `applicable`。
- `issueLabels`：`minor | major | redline` 严重度、标签和证据。
- `typeAdjustments`：只允许 `+0.5` 或 `-0.5`，并要求维度和理由。
- `targetPlatform` 与 `platformSampleEvidence`。

固定维度：

- 是否满足：`queryRelevance`、`contentOriginality`。
- 是否可用：`imageBaseQuality`、`imageTextQuality`、`imageConsistency`、`noteTone`、`platformAdaptation`。
- 是否优质：`informationValue`、`imageAesthetics`、`imageDiversity`。

原创度和多样性的边界：

- `contentOriginality` 只判断与站内已有正文、图集的重复性；没有站内候选时不猜测分数。
- `imageDiversity` 判断跨页主体、背景、构图、信息载体和阅读动线是否实质重复。
- 统一色调、字体、卡片装饰和视觉符号是整套图片风格一致性的要求，不得单独作为 `imageDiversity` 扣分理由。

评分输出包含：

- `ruleId: "production-v2"`
- `finalScore: 0 | 1 | 2 | 3 | null`
- `action: redline_block | return_for_revision | normal_review | priority_review | supplement_evidence`
- `stoppedAt`、`layerScores`、校正后的 `dimensions`
- `lowestObstacleDimensions`、`missingDimensions`

类型校正规则：

- `+0.5` 只把 2 提升为 3；`-0.5` 只把 3 下调为 2。
- 0 和 1 不得被类型校正挽救。
- 最终不输出半分。

兼容规则：

- `qc.overallScore` 等于 V2 最终分；证据不足时保留现有机械结果并在 `qc.rubric` 中明确缺项。
- 0/1 分映射为 `blocked`；Live 2 分写入完整 QC 后由 3 分门禁退回，只有 3 分候选可完成 Worker，系统仍不自动发布。
- Mock 继续为 `mock_only`，不得因 V2 得分进入人工批准。

## Code Style

使用小型命名导出和显式对象，不使用类或隐式全局状态：

```js
const result = scoreQualityAssessment({
  dimensions,
  issueLabels: [],
  typeAdjustments: [],
  targetPlatform: '小红书',
  platformSampleEvidence: 'sufficient',
});
```

## Testing Strategy

- 先写失败的纯函数测试，再实现评分引擎。
- 每个最终分至少一个正例；终止条件、平台封顶、类型校正和缺证据分别有反例。
- 集成测试证明旧的机械阻断行为不变，Live 最终交付必须经过独立 VLM 终审，2 分不完成、3 分可进入人工确认。
- 常规测试只使用本地 Fake/生成 PNG，不调用模型。

## Boundaries

- Always：验证所有外部评分输入；保留证据和来源；使用最低阻碍分；保持旧 JSON 字段兼容。
- Ask first：新增数据库列、自动发布、放宽红线或把缺失证据默认为 3。
- Never：使用平均分；用类型校正挽救 0/1；把机械检查未发现问题等同于优质；删除现有 QC 证据。

## Success Criteria

- 纯引擎对 0、1、2、3 和证据不足输出确定、互斥的结果。
- 任一维度为 2 时不会得到 3；缺少平台样本且没有直接专家终审时不会得到 3。
- 0/1 前置终止后不为后续层伪造分数。
- `qc.json` 包含 V2 规则详情，现有 manifest、SQLite 和审核流程继续工作。
- 定向测试、全量测试、类型检查和构建通过。

## Open Questions

- 无。已确认采用无重叠 2/3 边界，并纳入平台表达适配。

## Implementation Status

- 已完成纯评分契约、机械 QC 映射、最终多图 VLM 终审、`qc.json.rubric`、manifest 终审模型元数据和 Live 3 分门禁。
- 机械失败不能被外部评分抬高；无问题的直接人工/VLM 平台终审可作为 `direct_review` 证据。
- Mock 仍只用于流程验证，不参与 3 分候选。
