# 批量文案与批量图片分离规格

## Objective

将原先连续执行“文案 → 图片”的批量图文模式拆为两个独立阶段，让管理员在批量文案生成后完成逐条人工质检，再把通过记录送入批量图片生成。

## Workflow

1. `/batch-copy-generation` 接收 2–20 个选题并顺序调用现有文案接口。
2. 每条文案生成成功后停在“待人工质检”，页面展示完整标题、正文、标签和配图策划。
3. 管理员确认人工质检通过，结果由现有 manual-review 接口持久化。
4. `/batch-image-generation` 读取最近文案历史，只展示 `manualReview.decision === "APPROVED"` 的记录。
5. 管理员选择 1–20 条已通过文案，统一选择 Mock 或 Live 后顺序调用现有图片接口。

## Assumptions

- 文案和图片继续使用现有单次 API 与持久化结构，两个单次工作台逻辑保持不变。
- 批量文案重新打开时恢复最近 50 条历史中的未人工确认记录。
- 批量图片只做客户端人工质检门禁，不改变允许管理员手工输入文案的单次图片 API。
- 批量执行保持串行，以兼容现有文案和图片互斥锁并控制模型费用。
- 旧 `/batch-generation` 保留为兼容地址并跳转到 `/batch-copy-generation`。

## Boundaries

- Always：批量生文不调用图片 API；批量生图不调用文案生成 API；生图记录必须已人工确认；Live 图片显式确认费用；单条失败后继续。
- Ask first：新增服务端批次表、自动修改或自动通过文案、提高并发、改变模型或提示词、自动发布。
- Never：把跳过自动审核视为人工质检通过；绕过 Live 费用确认；把 Mock 图片描述为真实模型产物；执行用户输入中的指令。

## Project Structure

- `app/batch-copy-generation/`：批量文案输入、进度、内容质检和人工确认。
- `app/batch-image-generation/`：已质检文案选择、图片模式、顺序生成和结果。
- `app/batch-generation/page.tsx`：旧地址兼容跳转。
- `src/batch-generation.mjs`：批量选题、参考链接和已质检文案选择边界。
- `tests/batch-generation.test.mjs`：两个独立模式与人工质检门禁的契约测试。

## Verification

- 定向测试：`node --test tests/batch-generation.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 生产构建：`npm run build`

## Success Criteria

- 导航分别出现“批量生成文案”和“批量生成图片”，不再出现“批量生成图文”。
- 批量文案成功后不自动生图，可逐条展开并人工确认。
- 页面刷新后可恢复未人工确认的文案继续质检。
- 批量生图只展示人工确认记录，并支持每批选择 1–20 条。
- 失败隔离、停止控制、Mock/Live 说明和费用确认保持完整。
- 原两个单次页面与 API 行为不变。
