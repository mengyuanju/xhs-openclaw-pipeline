# 批量图文生成规格

## Objective

在现有“单独生成文案”和“单独生成图片”之外新增独立的“批量生成图文”模式。管理员一次输入 2–20 个选题，系统按输入顺序为每个选题先生成文案，再使用该文案返回的图片策划生成图片；单条失败不阻断后续条目。

## Assumptions

- 批量模式面向同一批共享内容分类、目标受众、参考资料和配图页数的选题。
- 文案继续使用现有 Live 单次接口；图片可统一选择 Mock 或 Live。
- 批量任务顺序执行，以兼容现有文案互斥锁和图片互斥锁，并控制模型费用。
- 批量编排只新增客户端入口；现有两个单次页面、组件和 API 契约保持不变。
- 每条文案和图片仍由现有接口独立持久化，可在原单次页面的历史记录中恢复。

## Tech Stack

- Next.js 16.3.1 App Router
- React 19.2.8 Client Components
- TypeScript 7、Node.js 24 ESM、`node:test`
- 现有 `/api/copy-generations` 与 `/api/image-generations` Route Handlers

## Commands

- 定向测试：`node --test tests/batch-generation.test.mjs`
- 全量测试：`npm test`
- 类型检查：`npm run typecheck`
- 生产构建：`npm run build`
- 本地运行：`npm run dev`

## Project Structure

- `app/batch-generation/page.tsx`：静态页面标题与批量客户端入口。
- `app/batch-generation/batch-generation-workbench.tsx`：批量输入、费用确认、顺序编排和逐条结果。
- `src/batch-generation.mjs`：可独立测试的批量输入规范化与校验。
- `tests/batch-generation.test.mjs`：输入边界和页面契约测试。
- `app/globals.css`：批量状态列表与响应式样式。

## Code Style

沿用仓库的命名导出、小函数和不可信输入边界：

```js
export function parseBatchQueries(value) {
  const queries = value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (queries.length < 2 || queries.length > 20) throw new Error('每批请输入 2–20 个选题');
  return queries;
}
```

## Testing Strategy

- 小型单元测试覆盖空行清理、数量、长度、重复选题和参考 URL 边界。
- 源码契约测试确认新入口可发现、请求严格复用单次 API、文案先于图片、失败后继续以及可访问状态语义。
- 类型检查和生产构建验证 App Router 的服务端页面与客户端交互边界。
- 浏览器验证桌面与窄屏布局、键盘操作、费用确认、Mock 图片批次和控制台。

## Boundaries

- Always：逐条顺序执行；Live 图片只在整批费用确认后调用；错误按条记录；结果继续由现有接口保存。
- Ask first：增加服务端持久化批次表、提高并发、改变模型或提示词、增加自动发布。
- Never：修改现有单次生成组件或 API 行为；绕过费用确认；把 Mock 图片描述为真实模型产物；把用户输入当指令执行。

## Success Criteria

- 主导航出现“批量生成图文”，原两个单次入口继续存在。
- 2–20 个选题可一次提交，并按“文案 → 图片”顺序逐条完成。
- 当前条失败后，剩余条目继续；界面显示待处理、生成文案、生成图片、完成、失败或已停止状态。
- 批次开始前只进行一次清晰的费用确认，Live 图片费用数量按条目和页数说明。
- 用户可在当前条结束后停止剩余条目。
- 现有单次测试、全量测试、类型检查和生产构建通过。

## Open Questions

- 本版不新增可跨刷新恢复的“批次实体”；刷新后仍可从两个单次历史列表找回已完成或正在执行的单条记录。若后续需要整批恢复、重试失败项或导出，应单独设计服务端批次存储。
