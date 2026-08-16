# Spec: 小红书内容生产管理后台 v0.2

## Assumptions

1. 第一版只在本机 `127.0.0.1` 使用，单管理员，不提供公网或局域网匿名访问。
2. 保留现有 Node.js/OpenClaw/Sharp 生产核心；Web 端负责配置、入队、审核和修订，不在 HTTP 请求中同步等待模型生成。
3. 单机每日目标为 1000 条 Query；任务与元数据继续使用 SQLite，图片和 Excel 文件存放本地受控目录。多机部署前迁移 PostgreSQL 与对象存储。
4. 第一版不自动发布小红书。只有审核通过的内容可以标记为 `approved` 并导出。
5. OpenAI/Codex OAuth 只用于真实冒烟；生产批量运行应改为受预算与限流控制的 API 凭据。

## Objective

在现有批处理 MVP 上增加一个可运行的本地管理后台，使管理员能够：

- 上传 Excel，预览并批量导入合法 Query；错误行不得污染正式队列。
- 创建、测试、发布和回滚文本、图片、图片编辑提示词版本。
- 为每个任务固定提示词版本、图片数量与参考图；后续修改全局提示词不得改变已入队任务。
- 查看任务状态、生成结果、质检信息与历史修订。
- 修改标题、正文与标签；重新生成单张图；用参考图执行图生图；用文字指令编辑已有图片。
- 审核通过、退回或重试任务，并保留完整操作记录。

## Tech Stack

- Node.js 24.14+，ECMAScript modules。
- Next.js App Router + React + TypeScript，作为本地管理界面和 REST/BFF 路由。
- `node:sqlite` 保存队列、批次、提示词版本、素材与审核记录。
- ExcelJS 在服务器端解析 `.xlsx`。
- Zod 校验 HTTP、Excel 与配置输入。
- Sharp 校验、规范化和修订图片。
- OpenClaw 2026.5.7+ 执行文本、文生图与 `infer image edit`。

## Commands

- 安装：`npm install`
- 开发后台：`npm run dev`
- 构建后台：`npm run build`
- 启动后台：`npm run start`
- 初始化数据库：`npm run db:init`
- Mock Worker 单条：`npm run worker -- --once --mock`
- Mock Worker 连续消费：`npm run worker:drain -- --mock`
- 测试：`npm test`
- 冒烟：`npm run smoke`

## Project Structure

```text
app/                  Next.js 页面、组件与 API Route Handlers
src/admin/            管理后台领域逻辑、数据库、Excel 与素材服务
src/                  既有生产管线、OpenClaw 和质检逻辑
tests/                Node 单元与集成测试
prompts/              版本库中的默认提示词种子
data/queue.sqlite     本地数据库（忽略提交）
data/uploads/         原始 Excel 和参考图（忽略提交）
output/<task-id>/     生成结果与修订图片（忽略提交）
docs/                 规格与接口文档
tasks/                实施计划与任务清单
```

## Code Style

外部输入在边界处校验，内部服务只接收已规范化数据。公开 API 使用统一错误结构：

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
```

模型和 Excel 输出只能作为数据解析，不得进入 Shell、SQL、HTML 或文件路径。列表接口始终分页；枚举 API 值使用 `UPPER_SNAKE_CASE`。

## Data and State Contracts

任务生产状态继续使用 `pending | processing | completed | failed`，审核状态独立为：

```text
NOT_READY -> WAITING_REVIEW -> APPROVED
                         \-> REJECTED
```

核心实体：

- `import_batches` / `import_rows`：Excel 预览、错误与提交记录。
- `prompt_templates` / `prompt_versions`：提示词种类、草稿与不可变发布版本。
- `task_configs`：任务固定的提示词版本、图片数量、审核状态与当前文本修订。
- `assets`：参考图、生成图、修订图和父子谱系。
- `generation_runs`：文本、图片和编辑请求的运行记录。
- `audit_logs`：发布提示词、修改内容和审核动作。

关键 REST 接口：

```text
GET/POST   /api/import-batches
POST       /api/import-batches/:id/commit
GET        /api/tasks?page=&pageSize=&status=&reviewStatus=
GET/PATCH  /api/tasks/:id
POST       /api/tasks/:id/retry
POST       /api/tasks/:id/review
POST       /api/tasks/:id/assets
POST       /api/tasks/:id/images/:assetId/edit
GET/POST   /api/prompts
POST       /api/prompts/:id/versions
POST       /api/prompt-versions/:id/publish
```

## Excel Contract

- 只接受 `.xlsx`，最大 5 MiB、5000 个数据行，只读取首个工作表。
- 必填列：`query`。
- 可选列：`externalId`、`category`、`targetAudience`、`promptSet`、`imageCount`、`referenceImageFiles`、`priority`、`metadata`。
- `externalId` 在同一批次中去重；`imageCount` 只能为 3–5。
- 参考图使用已上传素材文件名，第一版不从用户提供的远程 URL 抓取，避免 SSRF。
- 预览批次只有在显式提交后才创建任务，重复提交必须幂等。

## Prompt Contract

- 类型：`TEXT_SYSTEM`、`IMAGE_SYSTEM`、`IMAGE_EDIT_SYSTEM`。
- 状态：`DRAFT`、`PUBLISHED`、`RETIRED`。
- 发布版本不可修改；新内容必须创建新版本。
- 允许变量：`query`、`category`、`targetAudience`、`imageIndex`、`imageCount`、`reviewInstruction`。
- 发布前必须校验未知变量；任务入队时固定版本 ID 和内容哈希。

## Testing Strategy

- 单元：Excel 行规范化、提示词变量、状态转换、文件名与图片操作校验。
- SQLite 集成：批次预览/提交幂等、提示词发布、任务配置、文本修订、素材谱系、审核记录。
- API 集成：统一错误结构、分页、大小限制和非法状态拒绝。
- Worker：Fake OpenClaw 验证自定义提示词、参考图与图片编辑参数，不在常规测试消耗额度。
- 浏览器：导入、提示词发布、任务审核三个关键流；检查控制台、网络、可访问性与响应式布局。

## Boundaries

- Always：参数化 SQL；上传大小、MIME 和图片解码校验；发布版本不可变；操作留痕；任务和文件路径使用数据库 ID。
- Ask first：绑定非回环地址、增加身份认证、迁移 PostgreSQL、启用真实批量额度、接入自动发布。
- Never：公开无认证后台；保存或展示 Token/API Key；覆盖原始生成物；执行模型输出；从任意 URL 抓取参考图；把未审核内容标记为已通过。

## Success Criteria

1. 管理员能上传示例 Excel，预览合法/错误行，并一次性导入至少 1000 条合法任务且重复提交不重复入队。
2. 管理员能发布三类提示词；任务固定版本快照，后续发布新版本不改变旧任务。
3. 管理后台能分页查看任务、修改文本、上传参考图、创建图片编辑修订并审核通过/退回。
4. Mock Worker 能连续消费导入任务并生成现有交付包；真实 OpenClaw 可使用固定提示词与参考图调用文本、生成和编辑命令。
5. `npm test`、`npm run build`、Mock 冒烟和关键浏览器流程全部通过；无高危依赖漏洞或凭据泄漏。

## Open Questions

- 多用户角色、远程部署、PostgreSQL、对象存储、自动发布和审核抽样策略留到 v0.3；本规格不阻塞本地单管理员版本。

## Official Sources

- Next.js Route Handlers and request bodies: https://nextjs.org/docs/app/api-reference/file-conventions/route
- Next.js forms: https://nextjs.org/docs/app/guides/forms
- ExcelJS workbook reader: https://github.com/exceljs/exceljs
- OpenClaw inference: https://docs.openclaw.ai/cli/infer
- OpenClaw image editing: https://docs.openclaw.ai/tools/image-generation
- Node SQLite: https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html

