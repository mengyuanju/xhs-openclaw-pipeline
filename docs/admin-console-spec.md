# Spec: 小红书内容生产管理后台 v0.3

## Assumptions

1. 后台支持本机和可信私有局域网访问，仍为单管理员；任何页面、API 和素材都不得匿名访问。
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
- 管理员能从同一私有局域网登录后台；未登录、会话过期、非法 Host 和跨站写请求必须在进入领域逻辑前被拒绝。

## LAN Authentication Contract

- 默认 `npm run dev` / `npm run start` 仍只监听 `127.0.0.1`；显式使用 `dev:lan` / `start:lan` 才监听 `0.0.0.0`。
- 允许访问的 Host 为 loopback、RFC1918 IPv4、IPv4 link-local、IPv6 loopback/ULA/link-local，以及管理员通过 `XHS_ALLOWED_HOSTS` 显式添加的主机名；公网 IP 默认拒绝。
- 单管理员密码只以 scrypt 哈希保存在被 Git 忽略的 `.env.local`；会话密钥至少 32 字节随机值，也只保存在环境变量。
- 登录成功后签发 8 小时 HMAC-SHA256 会话，Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；HTTPS 时额外使用 `Secure`。
- 登录接口统一返回通用失败消息，不区分“未配置”和“密码错误”；15 分钟内最多 5 次失败，成功登录后清除失败计数。
- Next.js Proxy 只负责页面和 API 的快速预检；所有既有 `/api/*` Route Handler 仍在统一 `apiHandler` 边界再次验证会话。
- 登录和退出均为同源写操作；所有既有写 API 继续要求严格 `Origin === scheme://Host`。
- 局域网 HTTP 只适用于可信网络。跨 VLAN、Wi-Fi 来宾网络、VPN 或公网必须在反向代理处启用 HTTPS，并显式配置允许 Host。

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
- 设置管理员：`npm run auth:setup`
- 局域网开发：`npm run dev:lan`
- 局域网生产启动：`npm run start:lan`
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

- `import_batches` / `import_rows`：Excel 结构预检、强/中/弱/无需筛选、筛选来源与提交记录。
- `prompt_templates` / `prompt_versions`：提示词种类、草稿与不可变发布版本。
- `task_configs`：任务固定的提示词版本、图片数量、审核状态与当前文本修订。
- `assets`：参考图、生成图、修订图和父子谱系。
- `generation_runs`：文本、图片和编辑请求的运行记录。
- `audit_logs`：发布提示词、修改内容和审核动作。

关键 REST 接口：

```text
POST       /api/auth/login
POST       /api/auth/logout
GET/POST   /api/import-batches
POST       /api/import-batches/:id/screen
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
- 可选列：`externalId`、`category`、`targetAudience`、`promptSet`、`imageCount`、`referenceImageFiles`、`priority`、`metadata`，以及预筛选列 `是否有效`、`废弃原因`、`需求强度判定`、`判定简要说明`。
- `externalId` 在同一批次中去重；`imageCount` 只能为 3–5。
- 参考图使用已上传素材文件名，第一版不从用户提供的远程 URL 抓取，避免 SSRF。
- 结构合格行必须在入队前完成 `STRONG | MEDIUM | WEAK | NONE` 判定；Excel 已有判定自动带入，缺失或需要修正的判定由管理员在页面保存。
- 强需和中需标记为准入；弱需和无需标记为废弃。筛选理由必填，筛选操作记录审计日志。
- `POST /api/import-batches/:id/screen` 接受最多 5000 个 `{ rowId, demandLevel, reason }`，请求体最大 10 MiB；行必须属于当前未提交批次且已通过结构校验。
- 只有全部结构合格行完成需求筛选后才允许提交；提交只创建强需/中需任务，重复提交必须幂等。

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
- 认证：密码哈希/比对、会话篡改与过期、Host 策略、同源校验、限流、未登录 API 401。
- Worker：Fake OpenClaw 验证自定义提示词、参考图与图片编辑参数，不在常规测试消耗额度。
- 浏览器：导入、提示词发布、任务审核三个关键流；检查控制台、网络、可访问性与响应式布局。

## Boundaries

- Always：参数化 SQL；上传大小、MIME 和图片解码校验；发布版本不可变；操作留痕；任务和文件路径使用数据库 ID。
- Ask first：开放公网或非私有网段、改为多用户/角色、迁移 PostgreSQL、启用真实批量额度、接入自动发布。
- Never：公开无认证后台；在源码、Git、日志或响应中保存/展示明文密码、会话密钥、Token/API Key；覆盖原始生成物；执行模型输出；从任意 URL 抓取参考图；把未审核内容标记为已通过。

## Success Criteria

1. 管理员能上传示例 Excel，预览结构错误，按强/中/弱/无需完成筛选，并一次性导入至少 1000 条强需/中需任务；筛选未完成不得入队，重复提交不重复建任务。
2. 管理员能发布三类提示词；任务固定版本快照，后续发布新版本不改变旧任务。
3. 管理后台能分页查看任务、修改文本、上传参考图、创建图片编辑修订并审核通过/退回。
4. Mock Worker 能连续消费导入任务并生成现有交付包；真实 OpenClaw 可使用固定提示词与参考图调用文本、生成和编辑命令。
5. `npm test`、`npm run build`、Mock 冒烟和关键浏览器流程全部通过；无高危依赖漏洞或凭据泄漏。
6. 未登录访问页面会跳到 `/login`，未登录 API 返回统一 401；合法私网 Host 登录后可访问，公网 Host、篡改/过期会话和跨站写请求均被拒绝。

## Open Questions

- 多用户角色、跨公网部署、PostgreSQL、对象存储、自动发布和审核抽样策略留到后续版本。

## Official Sources

- Next.js Route Handlers and request bodies: https://nextjs.org/docs/app/api-reference/file-conventions/route
- Next.js authentication and session management: https://nextjs.org/docs/app/guides/authentication
- Next.js Proxy: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
- Next.js cookies: https://nextjs.org/docs/app/api-reference/functions/cookies
- Node.js 24 crypto: https://nodejs.org/download/release/v24.14.0/docs/api/crypto.html
- Next.js forms: https://nextjs.org/docs/app/guides/forms
- ExcelJS workbook reader: https://github.com/exceljs/exceljs
- OpenClaw inference: https://docs.openclaw.ai/cli/infer
- OpenClaw image editing: https://docs.openclaw.ai/tools/image-generation
- Node SQLite: https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html
