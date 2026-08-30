# Spec: Query 与文本阶段审核

## Objective

在现有图文生产 Worker 中增加两道独立门禁：Query 审核位于联网研究和正文生成之前，文本审核位于结构化正文校验之后、视觉规划与图片生成之前。审核结果必须可追溯、可展示，不通过时失败关闭。

## Tech Stack

- Node.js 24 ESM；`node:test`。
- OpenClaw 文本推理，审核模型由 `XHS_REVIEW_MODEL` 指定，未配置时沿用文本模型。
- SQLite `generation_runs` 保存有界 JSON 审核证据。
- Next.js App Router 审核页展示每个生成批次的阶段结果。

## Commands

- 定向测试：`node --test tests/content-stage-review.test.mjs tests/pipeline.test.mjs tests/generation-store.test.mjs tests/worker-integration.test.mjs tests/frontend-ux.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`
- Mock 冒烟：`npm run smoke`

## Project Structure

- `src/content-stage-review.mjs`：审核提示词、严格 JSON 契约和执行器。
- `src/pipeline.mjs`：两道门禁的编排、落盘和失败关闭。
- `src/admin/generation-store.mjs`：审核证据持久化。
- `app/tasks/[id]/`：生成批次中的审核证据展示。
- `tests/`：契约、管线、存储和界面回归测试。

## Code Style

采用现有的命名导出与小函数风格；审核对象统一为有界、可序列化数据：

```js
const review = await reviewQuery({ client, task });
if (review.decision !== 'PASS') throw new Error(describeStageReviewFailure(review));
```

Query、正文和模型输出始终按不可信数据处理，不进入 Shell。

## Testing Strategy

- 单元：正常、非法 JSON、字段越界、PASS/REJECT 语义不一致、有限重试。
- 管线：Query 拒绝后不联网/不生文；文本拒绝后不规划/不生图；通过时两个 JSON 文件进入 manifest。
- 存储：历史数据库增量列、有界序列化和读回。
- 界面：文字标签、决策、原因和旧批次空状态的源码回归；构建验证类型与 Server/Client 边界。
- 所有自动化测试使用 Fake/Mock，不消耗模型额度。

## Boundaries

- Always：Live 审核使用独立推理调用；严格验证输出；拒绝时停止后续付费阶段；保存可读原因。
- Ask first：改变人工审批语义、放宽现有 3 分完成门禁、新增第三方依赖。
- Never：Mock 冒充真实模型审核；审核不通过仍继续生图；将 Query 或模型输出作为指令执行；把审核结果当作自动发布授权。

## Success Criteria

1. Live 任务的 Query 在联网检索前被审核，拒绝时不产生检索或生成调用。
2. 结构合法的最终文本在视觉规划前被独立审核，拒绝时不产生图片。
3. `query-review.json` 与 `text-review.json` 绑定被审内容哈希，并进入 manifest、生成记录和审核页。
4. Mock 结果明确标记 `MOCK`；历史批次无该数据时正常显示。
5. 定向测试、全量测试、类型检查、构建和 Mock 冒烟全部通过。

## Open Questions

- 无阻断项。默认审核是硬门禁；审核不通过不自动改写 Query 或正文，避免审核器静默改变用户意图。
