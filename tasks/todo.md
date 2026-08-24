# Admin Console v0.2 Tasks

## Task 1: 管理数据库与提示词版本

- [x] 创建管理表与种子提示词，发布版本不可修改。
- [x] 校验提示词变量并保存发布内容哈希。
- Verify：提示词创建、发布、回滚选择和非法变量测试。
- Dependencies：None。

## Task 2: Excel staging 导入

- [x] `.xlsx` 解析首表并返回合法/错误行预览。
- [x] 提交批次时批量入队并固定配置，重复提交幂等。
- Verify：空 Query、重复 externalId、非法 imageCount、1000 行提交测试。
- Dependencies：Task 1。

## Task 3: 文本修订与审核

- [x] 任务保存当前文本修订和完整历史。
- [x] 支持 WAITING_REVIEW、APPROVED、REJECTED 状态与审计记录。
- Verify：非法转换拒绝、修订不覆盖旧版本、操作日志测试。
- Dependencies：Task 1。

## Task 4: 素材与图片修订

- [x] 上传 PNG/JPEG/WebP 参考图，限制大小并用 Sharp 验证真实图片。
- [x] 支持旋转/裁剪修订和父子谱系，不覆盖原图。
- Verify：伪 MIME、路径穿越、尺寸和谱系测试。
- Dependencies：Task 3。

## Task 5: Web 外壳与任务页

- [x] Next.js 页面、导航、仪表盘、分页任务列表和统一错误响应。
- [x] 默认开发/生产命令只绑定 `127.0.0.1`。
- Verify：`npm run build`；任务 API 分页与筛选测试。
- Dependencies：Tasks 1–3。

## Task 6: Excel 与提示词页面

- [x] Excel 上传、预览、提交反馈和错误行展示。
- [x] 提示词草稿、版本发布与当前版本展示。
- Verify：浏览器完成示例 Excel 导入和提示词发布。
- Dependencies：Tasks 2、5。

## Task 7: 审核工作台

- [x] 修改标题/正文/标签、上传参考图、图片修订、通过/退回。
- [x] 展示生成、质检和资产历史。
- Verify：键盘可达、错误/加载/空状态、浏览器截图和网络检查。
- Dependencies：Tasks 3–5。

## Task 8: Worker 快照集成

- [x] Worker 使用任务固定的文本/图片提示词和图片数量。
- [x] 生成完成后同步文本、质检和图片资产到管理表。
- Verify：Fake OpenClaw 断言实际提示词；Mock 批次进入 WAITING_REVIEW。
- Dependencies：Tasks 1–4。

## Task 9: 图生图与编辑 Worker

- [x] OpenClaw 适配器支持 `infer image edit --file`。
- [x] 审核端 AI 编辑请求创建新运行与图片修订。
- Verify：Fake CLI 参数测试；无授权时保持明确失败状态。
- Dependencies：Tasks 4、8。

## Task 10: 最终质量门

- [x] 全量测试、构建、Mock 冒烟和关键浏览器流程通过。
- [x] `npm audit`、秘密扫描、可访问性和五轴代码审查无阻断问题。
- [x] README 更新为后台使用说明。
- Dependencies：Tasks 1–9。

## Task 11: 认证内核

- [x] 使用 scrypt 保存管理员密码哈希，HMAC-SHA256 签发 8 小时会话。
- [x] 配置缺失、会话过期/篡改和登录失败使用安全、稳定的错误语义。
- [x] 登录失败实行有界内存限流，成功后清除计数。
- Verify：纯单元测试先失败后通过；不向错误、日志或 Git 输出凭据。
- Dependencies：Task 10。

## Task 12: HTTP 与 LAN 边界

- [x] 只接受 loopback、私有 IP、link-local 或显式允许的 Host。
- [x] Proxy 保护页面；统一 `apiHandler` 在数据访问前再次验证会话。
- [x] 登录/退出和现有写 API 均保持严格同源校验。
- Verify：Host、401、跨站、篡改 Cookie 和合法私网请求集成测试。
- Dependencies：Task 11。

## Task 13: 登录体验与运行配置

- [x] 增加可访问、响应式登录页和退出按钮。
- [x] 增加本机 `auth:setup` 配置命令，不在命令行参数或 Git 中保存明文密码。
- [x] 默认脚本仍仅本机监听，显式 `dev:lan` / `start:lan` 才开放局域网端口。
- Verify：全量测试、类型检查、构建、安全扫描和真实浏览器登录/退出流程。
- Dependencies：Task 12。

## Task 14: 视觉知识领域层

- [x] 增加知识条目、不可变版本、可选素材和任务引用表。
- [x] 支持分页、状态流转、已发布配方检索和任务版本锁定。
- Verify：先写失败的 SQLite 集成测试，再实现并运行定向测试。
- Dependencies：Task 13。

## Task 15: 图片分析与双保留模式

- [x] 使用 Sharp 校验图片，并通过 OpenClaw `infer model run --file` 提炼结构化配方。
- [x] `PROMPT_ONLY` 不落盘；授权 `IMAGE_AND_PROMPT` 保存规范化 PNG。
- Verify：Fake runner、伪 MIME、超大图片、授权组合和临时文件清理测试。
- Dependencies：Task 14。

## Task 16: 视觉知识后台

- [x] 增加认证 REST API、分页列表、创建/发布/归档和图片预览。
- [x] 增加“视觉知识库”导航、上传分析表单和配方列表。
- Verify：HTTP 集成测试、类型检查、构建和键盘/响应式浏览器检查。
- Dependencies：Tasks 14–15。

## Task 17: Worker 融合

- [x] 任务首次生成时匹配并锁定已发布配方版本。
- [x] 主图组合全局规则、视觉配方和任务内容；授权图片加入参考图路径。
- Verify：Fake OpenClaw 断言提示词、路径和重试锁定；空知识库回归测试。
- Dependencies：Tasks 14–16。

## Task 18: 质量门与文档

- [ ] 全量测试、类型检查、构建、Mock 冒烟、浏览器和安全检查通过。
- [x] README 记录模块边界、保留模式、真实分析成本和后续范围。
- 当前：自动化测试、构建和真实 HTTP 流程通过；本机浏览器控制层拦截 localhost，未取得浏览器截图。
- Verify：无秘密、无高危依赖、无跳过测试、现有流程无回归。
- Dependencies：Tasks 14–17。

## Task 19: 全量图片计划契约

- [x] `imagePlan` 数量严格等于任务的 3–5 张配置。
- [x] 每张包含独立职责、信息要点和非空图像模型提示词。
- Verify：3/5 张合法，数量不符、首项非 hero、空提示词均被契约测试拒绝。
- Dependencies：Task 18。

## Task 20: 逐图文本驱动提示词

- [x] 每张最终提示词包含生成后的完整标题/正文和本页计划。
- [x] 每张叠加任务固定图片规则及锁定视觉配方，限制总长度 8,000 字符。
- Verify：Fake OpenClaw 捕获的所有提示词包含正文和对应页要点。
- Dependencies：Task 19。

## Task 21: 全模型图集渲染

- [x] Live 模式每张交付图调用一次文生图或图生图。
- [x] 第二张起使用首图作风格参考，但生成新页面；Sharp 只做 1080×1440 规范化。
- Verify：3/5 张调用次数、参考路径、模型来源、尺寸和唯一文件测试。
- Dependencies：Task 20。

## Task 22: 提示词发布与质量门

- [x] 发布新的文本与图片系统提示词版本，历史任务快照不变。
- [x] 定向测试、全量测试、类型检查、构建和差异审查完成。
- Verify：`npm run prompts:install-rules`、`npm test`、`npm run typecheck`、`npm run build`。
- Dependencies：Tasks 19–21。

## Task 23: OpenClaw 需求检测契约

- [x] 按行数和字符预算构造有界批次，Query 作为不可信 JSON 数据传入。
- [x] 严格拒绝缺行、重复行、额外行、非法档位、空或超长理由。
- Verify：先写失败的服务测试，再用 Fake OpenClaw 通过。
- Dependencies：Task 22。

## Task 24: Excel 预检集成

- [x] 只检测结构合格且未带 Excel 判定的行；全部检测成功后才创建预览批次。
- [x] SQLite 记录 `OPENCLAW` 来源与实际模型名，人工修改后来源变为 `MANUAL`。
- Verify：管理存储测试、路由相关测试和迁移回归通过。
- Dependencies：Task 23。

## Task 25: 体验与质量门

- [x] 上传按钮和成功信息明确显示 OpenClaw 检测状态、成本与人工复核边界。
- [x] README 记录自动检测、模型配置和失败语义。
- Verify：`npm test`、`npm run typecheck`、`npm run build`、浏览器导入页检查。
- Dependencies：Task 24。

## Task 26: 网页 Worker 启动器

- [x] 使用固定 Node CLI 路径与参数数组启动 `drain --live`，禁止 Shell。
- [x] 单次最多 20 条；活动进程未退出时拒绝重复启动，退出后允许下一次运行。
- Verify：Fake child process 先写失败测试，再验证参数、冲突、错误与退出恢复。
- Dependencies：Task 25。

## Task 27: Worker Run API

- [x] 新增认证同源 `POST /api/worker-runs`，严格校验 max 与费用确认字面值。
- [x] 无待处理任务、存在 processing 任务或已有网页 Worker 时返回统一 409。
- Verify：路由契约测试、类型检查与构建通过。
- Dependencies：Task 26。

## Task 28: 导入页生成入口

- [x] 已提交且有准入任务的批次显示“启动 OpenClaw 生成”，说明全局队列顺序和调用成本。
- [x] 浏览器二次确认后异步启动，展示成功/失败状态和“内容审核”入口。
- Verify：前端契约测试、键盘操作、浏览器控制台和响应式页面检查。
- Dependencies：Task 27。
