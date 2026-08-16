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
