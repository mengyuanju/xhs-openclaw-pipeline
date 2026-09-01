# Spec: 单条文案双版本保存与对比

## Objective

让管理员在“单独生成文案”中同时获得并持久保存首次生成的原始版和根据文本质检意见再次修订的质检版；生成中的任务和失败状态同样持久保存，刷新或离开页面后仍可恢复状态，成功后从任务区转入历史记录并排对比。

同时记录成功生成的总耗时与六个阶段耗时，回答三个运营问题：单条生成实际花多久、瓶颈位于哪个阶段、最近最多 1000 条成功记录的平均/P50/P95 是否发生变化。升级前的旧记录保持可读，但不纳入耗时样本。

## Tech Stack

- Node.js 24 ESM、`node:sqlite`、`node:test`。
- Next.js 16 App Router Route Handler 与 React 19 Client Component。
- 现有 OpenClaw/Dots 文案客户端与 OpenClaw 审核客户端。

## Commands

- 定向测试：`node --test tests/copy-generation.test.mjs tests/standalone-copy-generation-store.test.mjs tests/copy-generation-ui.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`

## Project Structure

- `src/copy-generation.mjs`：原始生成、首次质检、质检修订与复检编排。
- `src/admin/standalone-copy-generation-store.mjs`：生成任务状态、双版本 SQLite 持久化和分页历史。
- `app/api/copy-generations/route.ts`：新增历史 GET，POST 生成后原子保存双版本。
- `app/copy-generation/`：生成表单、历史选择与双栏对比。
- `tests/`：生成契约、存储迁移与 UI 源码回归。

## Code Style

沿用命名导出、小函数和严格边界校验；新响应字段保持叠加兼容：

```js
return {
  original: copyVersion(originalPost, originalModel, originalReview),
  reviewed: copyVersion(reviewedPost, reviewedModel, reviewedReview),
  copy: copyFrom(reviewedPost),
};
```

## Testing Strategy

- 生成单元测试：断言调用顺序为原始生成→首次审核→质检修订→复检，且两版内容均返回；相同或仅空白变化的质检版会重试，连续未修改则失败。
- SQLite 集成测试：双版本、两次审核证据、输入、模型和时间可读回，列表按新到旧分页。
- 耗时统计测试：单调时钟阶段计时、旧表增量迁移、有效样本平均值与 nearest-rank P50/P95。
- UI 回归：历史 GET、生成中/失败任务恢复与轮询、原始版/质检版标签、分别复制、对比结构和空/错/忙状态。
- 构建后使用本地浏览器检查桌面和窄屏布局，控制台无错误。

## Boundaries

- Always：提交后先保存生成任务；原始版与质检版不覆盖；成功结果与任务完成状态同一事务保存；失败原因有界且脱敏；修订仍只能使用原始允许来源；质检版必须在标题、正文、标签或配图规划中产生至少一项实质修改。
- Ask first：将单条历史自动加入生产队列、生成图片或发布。
- Never：用质检版覆盖原始版；把模型内容当作指令；在测试中消耗真实模型额度。

## Success Criteria

1. 成功的单条生成返回原始版和质检版，并保留两次文本审核证据。
2. 两版内容和证据以一条历史记录原子保存；刷新后可从 GET 历史恢复。
3. 页面在桌面端并排显示，窄屏自动改为单列，两版可分别复制。
4. 现有 `copy`/`imagePlan`/生成元数据字段继续可用，其中 `copy` 代表质检版。
5. 定向测试、全量测试、类型检查和构建全部通过。
6. 新记录保存总耗时和六阶段耗时；历史接口返回有效样本数、平均值、P50、P95，旧记录不伪造耗时。
7. 第一份质检版没有实质修改时自动重试一次；连续两次未修改则失败且不保存记录，空白和字段顺序变化不计为修改。
8. 刷新或离开页面后仍能恢复生成中和失败任务；页面只在存在生成中任务时轮询，完成后自动进入历史记录。

## Open Questions

- 无阻断项。“质检版”按质检意见再生成完整修订文案，不是只保存一份质检报告。
