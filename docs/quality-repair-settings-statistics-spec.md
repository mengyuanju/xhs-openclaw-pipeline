# Spec: 可配置质量修复与生产统计

## Objective

在现有 0–3 分整套图文终审之后增加受控修复：只有 Live 交付的首次终审恰好为 1 分时，才基于实际评分证据重新生成整套图片；修复目标为至少 2 分，最多修复 2 次。每轮必须记录修复前后分数、原因、方法和耗时，并在内容审核页可读展示。

增加后台生产配置中心，统一维护质量修复开关、触发分、目标分、最大修复次数，以及“AI生成”标识的开关和文字。配置在 Worker 领取任务时读取，写入检查点指纹和交付清单，保证配置变化后不会误用旧图片。

增加统计分析模块，展示任务生成批次耗时、导入批次进度和耗时、评分分布、质量修复次数及成功率，为后续数据分析保留稳定的读取契约。

## Tech Stack

- Node.js 24 ESM、`node:sqlite`、`node:test`
- Next.js 16 App Router、React 19、Zod 4
- OpenClaw 文本/视觉/图片适配器、Sharp

## Commands

- 定向测试：`node --test tests/production-settings.test.mjs tests/quality-repair.test.mjs tests/generation-store.test.mjs tests/production-statistics.test.mjs tests/pipeline.test.mjs tests/frontend-ux.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`
- Mock 冒烟：`npm run smoke`

## Project Structure

- `src/production-settings.mjs`：默认配置、边界校验和运行时解析。
- `src/quality-repair.mjs`：从 QC 证据生成有界、可展示、可注入提示词的修复计划。
- `src/admin/production-settings-store.mjs`：SQLite 单例配置与兼容迁移。
- `src/admin/production-statistics.mjs`：批次与全局统计聚合。
- `src/pipeline.mjs`：整套图片评分修复循环和配置快照。
- `app/api/production-settings/`、`app/settings/`：配置 REST 接口和管理页。
- `app/api/statistics/`、`app/analytics/`：分页统计接口和分析页。
- `app/tasks/[id]/`、`app/imports/`：修复证据和批次耗时展示。

## Code Style

使用小型命名导出和边界校验，外部输入先归一化后进入内部逻辑：

```js
export function shouldRunQualityRepair({ initialScore, currentScore, attempts, settings }) {
  return settings.qualityRepairEnabled
    && initialScore === settings.qualityRepairTriggerScore
    && currentScore < settings.qualityRepairTargetScore
    && attempts < settings.qualityRepairMaxAttempts;
}
```

## Testing Strategy

- 纯函数单元测试覆盖配置边界、触发条件、修复原因/方法生成和统计聚合。
- SQLite 集成测试覆盖新库、旧库迁移、配置往返、生成批次时间持久化。
- Fake OpenClaw 管线测试覆盖 1→2、1→1→2、两次后仍为 1、首次 0/2 不修复和标识关闭。
- 前端契约测试覆盖配置、统计、批次耗时、修复历史的可读展示；自动测试不得消耗模型额度。

## Boundaries

- Always：修复只使用结构化 QC 证据；每轮重新执行逐页验收和整套终审；记录配置快照与时间。
- Ask first：把最大修复次数提高到 2 次以上、改变 0–3 分定义、增加自动发布、引入外部分析服务。
- Never：因修复掩盖 0 分红线；把 1 分伪装成 2 分；将模型返回文字作为指令执行；覆盖历史生成记录。

## Success Criteria

- 首次 Live 终审为 1 分时自动修复，达到至少 2 分即停止，最多修复 2 次。
- 首次为 0、2 或 3 分时不进入该修复循环；2 分及以上继续现有质量门禁和人工审核语义。
- 每轮 QC 记录并展示修复原因、修复方法、修复前后分数和耗时。
- 后台可修改修复策略和“AI生成”标识；关闭标识时生成提示词、OCR 白名单、Mock/编辑叠层均不添加该文字。
- 每个任务生成批次显示开始、结束、耗时；每个导入批次显示进度、开始、结束、墙钟耗时和平均任务耗时。
- 数据统计页展示分页批次数据、评分分布、修复次数、达到目标比例和耗时汇总。
- 历史数据库可原地打开；历史缺失字段显示“暂无数据”，不伪造耗时或修复记录。

## Open Questions

- 无阻断问题。当前实现把“重新生成”定义为：以当前整套图片作为逐页图生图修复输入，并结合首图风格参考重新生成完整页面；不是仅修改评分结果。
