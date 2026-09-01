# Spec：单独生成图片试验模块

## Objective

新增一个与生产任务隔离的“单独生成图片”试验模块，用来验证现有主流程中从已完成文案到图片交付的中间链路。操作者输入上一步已经产出的 Query、标题、正文、标签和图片策划，选择 Mock 或 Live 模式后，模块独立执行视觉规划、逐页提示词组装、图片生成、OCR 对齐和质量检查，并在页面中预览结果。

第一阶段只验证图片链路，不创建生产任务、不修改原文案、不进入正式审核和导出流程，也不改变 `processNext` 的现有行为。试验稳定后，再把已经验证的编排服务抽成主流程与试验模块共同调用的共享模块。

## Current production flow

1. 导入 Query，完成需求筛选并创建队列任务，同时锁定提示词和生产配置。
2. 执行 Query 审核；Live 模式按需要进行联网研究。
3. 生成或读取人工修订后的标题、正文、标签和 3～5 页 `imagePlan`。
4. 执行正文审核；不通过时停止，不进入图片阶段。
5. 根据最终文案生成逐页 `visualPlan`，确定每页证据、主体、版式和精简可见文字。
6. 选择视觉知识库配方，组合图片系统提示词、视觉配方和当前页任务提示词。
7. 第一张先生成并作为套图风格参考；后续页面最多并发 2 张，生成全新场景和构图。
8. 每页统一规范化为 `1086×1448` PNG，执行 OCR 和图文语义对齐；失败页最多修复 3 次。
9. 对整套图片执行独立质量评估和机械 QC；按配置进行有限的质量修复。
10. 写入交付文件、运行记录和审核界面，等待人工审核或导出。

## Scope

### Included in the pilot

- 新页面 `/image-generation`，名称为“单独生成图片”。
- 输入字段：Query、标题、正文、标签和 3～5 页图片策划 JSON。
- Mock 模式：不调用外部模型，用确定性图片验证输入、分页、文件、尺寸和预览链路。
- Live 模式：必须二次确认费用，使用当前已发布的图片系统提示词和当前生产模型配置。
- 复用现有 `visual-plan`、逐页提示词、视觉知识、`renderDeliveryImages`、图片对齐和 QC 规则。
- 每次运行写入独立试验目录和有界结果清单，返回图片预览地址、逐页状态和 QC 摘要。
- 同一进程只允许一个试验运行，避免重复费用和本机资源争用。

### Excluded from the pilot

- 不写入 `tasks`、`generation_runs`、`assets`、审核工作项或正式导出记录。
- 不修改主队列、`processNext`、任务重试、生产检查点或现有任务快照。
- 不做批量运行、自动发布、正式任务回填、图片编辑和历史迁移。
- 不新增数据库表；试验产物采用隔离文件目录，后续合并阶段再决定持久化模型。

## API contract

### `POST /api/image-generations`

请求体：

```ts
type StandaloneImageGenerationInput = {
  query: string;
  copy: {
    title: string;
    body: string;
    tags: string[];
  };
  imagePlan: Array<{
    kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
    headline: string;
    subtitle: string;
    bullets: string[];
    prompt: string;
  }>;
  mode: 'MOCK' | 'LIVE';
  confirmation?: 'LIVE_IMAGE_COST_ACCEPTED';
};
```

约束：

- 请求对象严格校验，拒绝未知字段；Query、文案和图片策划沿用当前生产契约的长度与数量限制。
- `LIVE` 必须携带费用确认；`MOCK` 不接受也不需要确认。
- 只接受 3～5 页，首项必须为 `hero`。
- 输入内容始终作为不可信数据处理，不可覆盖系统提示词。

成功响应：

```ts
type StandaloneImageGenerationResult = {
  runId: string;
  mode: 'MOCK' | 'LIVE';
  status: 'COMPLETED' | 'BLOCKED';
  imageCount: number;
  images: Array<{
    pageIndex: number;
    kind: string;
    url: string;
    provider: string;
    model: string | null;
    generationAttempts: number | null;
    alignmentPassed: boolean | null;
  }>;
  qc: {
    passed: boolean;
    overallScore: number | null;
    summary: string;
  };
};
```

错误统一沿用现有 API 格式，至少区分 `VALIDATION_ERROR`、`IMAGE_GENERATION_IN_PROGRESS`、`LIVE_CONFIRMATION_REQUIRED`、`IMAGE_ALIGNMENT_FAILED` 和 `IMAGE_GENERATION_FAILED`。

### `GET /api/image-generations/{runId}/images/{file}`

- 只读取隔离试验目录下属于该运行的 PNG。
- `runId` 和文件名使用严格白名单，解析后的绝对路径必须仍在试验根目录内。
- 返回 `image/png` 和禁止嗅探头，不暴露本机绝对路径。

## Architecture

```text
独立页面
  │
  ▼
POST /api/image-generations
  │  边界校验、费用确认、并发保护
  ▼
standalone image service
  ├─ 规范化上一步文案输出
  ├─ visualPlan
  ├─ published IMAGE_SYSTEM + visual recipe + page prompt
  ├─ renderDeliveryImages
  ├─ image alignment / OCR
  └─ QC
  │
  ▼
隔离运行目录 + 结果清单
  │
  ▼
只读图片路由与页面预览
```

试验阶段允许服务层调用现有图片链路的公开函数，但不让主流程反向依赖试验模块。合并阶段再提取一个共享的 `image-generation-stage`，由主流程和试验模块共同调用，以删除重复编排逻辑。

## Tech stack

- Node.js 24、Next.js 16、React 19、TypeScript 7。
- Zod 负责 API 边界校验。
- 现有 OpenClaw 客户端负责文本视觉规划、图片生成和视觉验收。
- Sharp 负责 PNG 解码、尺寸规范化和 Mock 输出。
- Node test runner 负责单元与集成测试。

## Commands

- 开发：`npm run dev`
- 定向测试：`node --test tests/standalone-image-generation.test.mjs tests/standalone-image-generation-ui.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 生产构建：`npm run build`

## Project structure

- `src/standalone-image-generation.mjs`：试验编排、输入规范化和结果契约。
- `app/api/image-generations/route.ts`：POST 边界、运行配置和并发保护。
- `app/api/image-generations/[runId]/images/[file]/route.ts`：只读 PNG 响应。
- `app/image-generation/page.tsx`：页面入口。
- `app/image-generation/image-generation-workbench.tsx`：输入、确认、运行状态和结果预览。
- `tests/standalone-image-generation.test.mjs`：服务与失败边界测试。
- `tests/standalone-image-generation-ui.test.mjs`：API、页面和导航契约测试。

## Code style

沿用现有 ESM、小函数和严格边界校验风格。外部输入先转换为生产可接受的 `post`，后续内部函数只接收规范化对象：

```js
export async function generateStandaloneImages({
  source,
  mode,
  runtime,
  outputRoot,
}) {
  const post = normalizeStandaloneImageSource(source);
  return runIsolatedImageStage({ post, mode, runtime, outputRoot });
}
```

## Testing strategy

- 先写失败测试，再实现每个行为。
- 小型单元测试覆盖输入规范化、Live 确认、路径逃逸和响应映射。
- 中型集成测试使用 Mock 模式真实生成 3 张 PNG，验证尺寸为 `1086×1448`、文件互不重复且不写入生产任务表。
- API 契约测试验证严格请求体、409 并发保护和有界错误响应。
- UI 契约测试验证表单标签、Mock/Live 状态、费用确认、加载、错误和结果预览。
- 页面完成后在隔离浏览器中验证桌面与移动布局、控制台、网络请求、键盘操作和可访问名称。

## Boundaries

### Always

- 使用当前发布的 `IMAGE_SYSTEM` 和当前生产设置，不硬编码另一套提示词。
- Mock 先通过后才运行 Live；Live 必须显式确认费用。
- 所有输入、模型输出、文件名和路径都在边界校验。
- 每个增量通过定向测试后再提交；最终运行全量测试、类型检查和构建。

### Ask first

- 新增或修改数据库结构。
- 让试验结果回写正式任务、审核或导出记录。
- 批量 Live、提高图片并发或改变 3～5 页范围。
- 抽取并替换主流程的图片编排实现。

### Never

- 自动调用 Live 模型或隐藏费用确认。
- 使用试验输入修改已发布提示词或生产配置。
- 把本机绝对路径、模型内部错误或凭据返回给浏览器。
- 删除、覆盖或重用正式任务的输出目录。

## Success criteria

- 操作者能在独立页面提交一份合法的上一步文案输出并选择 Mock 或 Live。
- Mock 运行生成 3～5 张不同的 `1086×1448` PNG，页面可预览且主任务数量、状态和审核记录保持不变。
- Live 未确认时零模型调用；确认后按当前图片提示词执行视觉规划、逐页生成和 OCR 对齐。
- 第一张先完成，后续页面继承风格参考且最多并发 2 张。
- 人像页右下角“AI生成”进入生成提示和 OCR 白名单。
- 失败时返回明确阶段与安全错误，不产生“成功”结果或写入主流程。
- 全量测试、类型检查、生产构建和浏览器验证通过。

## Merge-back gate

只有以下条件全部满足后，才进入“并入主系统”阶段：

1. 至少完成 1 次 Mock 全链路和 1 次人工确认的 Live 全链路。
2. Live 每页 OCR 对齐通过，整套 QC 没有阻断项。
3. 输出尺寸、页序、数据和文案对应关系人工抽查通过。
4. 试验模块没有修改主任务、审核、导出或历史快照。
5. 用户确认试验结果符合预期，并授权抽取共享图片阶段。

## Open questions

- 第一版输入采用“手动粘贴上一步的 Query、文案和图片策划”，还是直接读取“单独生成文案”的历史记录？推荐先手动粘贴，避免试验模块依赖仍在开发中的文案历史功能。
- 试验结果是否需要跨服务重启保留历史？推荐第一版只保留隔离文件和当前响应，不新增数据库。
