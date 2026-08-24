# Spec: 视觉知识库与提示词配方模块 v0.1

## Objective

在现有内容工场中增加一个可独立关闭、可独立演进的视觉知识库模块。管理员上传优秀作品图片后，系统通过 OpenClaw 视觉推理提炼结构化图片提示词；每条知识可以选择只保存提示词，或在授权允许时同时保存规范化参考图。只有人工发布的不可变配方版本能够进入任务，任务首次生成时锁定选中的版本，重试保持一致。

当前版本覆盖图片分析、双保留模式、配方创建/发布/归档、分页列表、自动匹配、任务锁定，以及整套 3–5 张模型图片的提示词/参考图接入。配方试生成评分留作后续切片，不伪装为已完成能力。

## Assumptions

1. `PROMPT_ONLY` 是外部或版权不明确作品的默认模式，分析完成后不保存图片文件。
2. `IMAGE_AND_PROMPT` 只允许 `SELF_OWNED` 或 `LICENSED`，图片规范化为 PNG 后保存在 `data/knowledge/`。
3. OpenClaw `infer model run --file` 是当前视觉分析边界；常规测试使用 Fake，不消耗模型额度。
4. 全部交付图片均调用图片模型；视觉配方应用到每一页，第一张规范化图片会作为后续页面的风格参考。Sharp 只负责解码、裁切和 PNG 规范化。
5. 现有单管理员认证、同源写保护、SQLite、本地素材目录和任务状态保持不变。

## Tech Stack

- Node.js 24 ESM、`node:sqlite`、Sharp、Zod。
- Next.js 16 App Router + React 19。
- OpenClaw 2026.5.7 `infer model run --file` 进行视觉分析。

## Commands

- Tests: `npm test`
- Type check: `npm run typecheck`
- Build: `npm run build`
- Mock smoke: `npm run smoke`
- Development: `npm run dev`

## Project Structure

```text
src/admin/visual-knowledge-store.mjs    视觉知识表、版本、检索与任务锁定
src/admin/visual-knowledge-service.mjs  图片校验、临时分析、可选持久化
app/knowledge/                          管理页面与交互组件
app/api/visual-analyses/                临时图片分析接口
app/api/knowledge-items/                配方列表、创建和状态变更接口
tests/visual-knowledge-*.test.mjs       领域、HTTP 与 worker 集成测试
data/knowledge/                         授权参考图，Git 忽略
```

## Data and Interface Contracts

知识类型：`PHOTO_HERO | STEP_GUIDE | CHECKLIST | COMPARISON | TIMELINE | TRAVEL_GUIDE | EMOTION_STORY | PRODUCT_DISPLAY`。

生成目标：`MODEL_IMAGE | LOCAL_CARD`。保留模式：`PROMPT_ONLY | IMAGE_AND_PROMPT`。授权状态：`SELF_OWNED | LICENSED | INTERNAL_ANALYSIS_ONLY | UNKNOWN`。生命周期：`DRAFT | TESTING | PUBLISHED | RETIRED`。

```js
{
  versionId,
  type,
  generationTarget,
  prompt,
  negativePrompt,
  layoutRules,
  referenceImagePaths,
}
```

REST 接口：

```text
GET/POST  /api/knowledge-items
GET/PATCH /api/knowledge-items/:id
POST      /api/visual-analyses
GET       /api/knowledge-assets/:id
```

列表始终分页；写请求沿用严格同源和管理员认证。模型输出先解析 JSON、再按白名单和长度校验，不能进入 Shell、SQL、HTML 或文件路径。

## Generation Contract

每张最终图片提示词按顺序组合：任务固定的全局 `IMAGE_SYSTEM`、任务锁定的已发布视觉配方、已经生成的完整标题和正文、当前页 `imagePlan`。有授权保留图时加入初始 `referenceImagePaths`；第二张起始终加入第一张规范化图片作为风格参考，并明确要求生成当前页的新场景和新构图。知识库为空或无匹配时仍逐张调用图片模型，只省略视觉配方部分。

自动匹配只从 `PUBLISHED` 配方中选择，按图片目标、选题分类、标签和质量分排序。任务一旦锁定 `visual_knowledge_version_id`，后续重试不得自动换版。

## Code Style

边界函数接收已校验的普通对象，数据库查询全部参数化：

```js
const reference = store.resolveVisualReference({
  taskId,
  query,
  category,
  targetAudience,
});
```

公开对象使用 camelCase，数据库列使用 snake_case，枚举值使用 UPPER_SNAKE_CASE。发布后的知识版本不可修改；修改必须创建新版本。

## Testing Strategy

- 单元：模型 JSON 解析、提示词变量、授权/保留模式组合、提示词合成。
- SQLite 集成：创建、分页、发布、归档、版本不可变、自动匹配和任务锁定。
- HTTP：认证、同源、上传大小、伪造 MIME、非法枚举和统一错误结构。
- Worker：Fake OpenClaw 验证最终提示词与参考图，知识库为空时旧行为不变。
- Browser：创建配方、查看列表、发布配方、移动端布局和控制台错误。

## Boundaries

- Always：校验图片真实格式、限制 10 MiB/4000 万像素、参数化 SQL、随机文件名、发布版本不可变、记录图片哈希和分析模型。
- Ask first：启用真实批量视觉分析额度、抓取远程 URL、让未授权图片作为图生图输入、把模块拆成独立服务。
- Never：保存 `PROMPT_ONLY` 原图、把 `UNKNOWN`/`INTERNAL_ANALYSIS_ONLY` 图片加入生成参考图、执行模型输出、覆盖原图片或已发布版本、自动把生成结果加入知识库。

## Success Criteria

1. 管理员能上传 PNG/JPEG/WebP，获得通过校验的结构化提示词草稿。
2. `PROMPT_ONLY` 分析后磁盘不存在原图；授权的 `IMAGE_AND_PROMPT` 保存规范化 PNG 并可鉴权预览。
3. 配方可分页查看、发布和归档；非法状态、变量或授权组合被拒绝。
4. 任务只匹配已发布配方并锁定版本；重试保持相同版本。
5. 全部 3–5 张模型图片都收到全局规则、配方、完整生成文本和当前页计划；有授权图片时收到受控路径，后续页面还收到首图风格参考。
6. 模块无数据时现有生成、审核和 Mock 冒烟行为不变。
7. `npm test`、`npm run typecheck`、`npm run build`、浏览器关键流程和安全检查通过。

## Open Questions

- 配方试生成与评分面板、向量检索和批量导入留在后续版本。
