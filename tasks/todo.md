# MVP Tasks

## Task 1: 项目基础

- [x] 创建 `package.json`、`.gitignore`、`AGENTS.md` 和 README。
- [x] 安装 Sharp 并提交锁文件。
- Verify：`npm test` 可以启动，即使暂时没有业务测试。
- Dependencies：None。

## Task 2: SQLite 队列

- [x] 支持初始化、入队、原子领取、完成、失败和状态统计。
- [x] 任务 Query 为空或超过 500 字时拒绝。
- Verify：队列测试覆盖状态转换和租约回收。
- Dependencies：Task 1。

## Task 3: 文案生成契约

- [ ] Prompt 包含当前作业模式的真实性、结构和平台表达约束。
- [ ] OpenClaw 输出可提取并校验为受控 JSON。
- Verify：Fake 输出的合法、缺字段和围栏 JSON 测试通过。
- Dependencies：Task 2。

## Task 4: 配图与交付

- [ ] OpenClaw 生成一张 1080×1440 AI 主图。
- [ ] Sharp 生成两张 1080×1440 中文信息卡。
- [ ] 写出 `post.json`、`post.md`、`qc.json` 和 `manifest.json`。
- Verify：读取 PNG metadata 验证尺寸，清单中恰有 3 张图。
- Dependencies：Task 3。

## Task 5: Worker 与冒烟

- [ ] CLI 支持 init、enqueue、status、worker once 和 mock。
- [ ] Mock 冒烟从空库走到 completed。
- Verify：`npm test` 与 `npm run smoke` 通过。
- Dependencies：Task 4。

## Task 6: 真实 OpenClaw 文案

- [ ] `openai` 插件启用，`openai-codex` OAuth 有效。
- [ ] 真实文本推理返回合法文案 JSON。
- Verify：交付清单记录真实 provider/model。
- Dependencies：用户完成浏览器授权，Task 5。

## Task 7: 真实 OpenClaw 主图

- [ ] OpenClaw 图片推理输出 PNG。
- [ ] 真实单条完整任务状态为 completed。
- Verify：人工查看主图和两张卡片，机械质检不低于 2。
- Dependencies：Task 6。
