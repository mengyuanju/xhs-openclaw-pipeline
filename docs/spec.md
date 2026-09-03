# Spec: 小红书图文自动生产 MVP

## Assumptions

1. 本阶段只验证本机单条 Query 的端到端生产，不自动发布到小红书。
2. 默认测试 Query 为“租房卧室的桌面总是乱，怎么做低成本整理？”。
3. 每条任务默认产出一份结构化文案、一张 OpenClaw AI 主图和两张本地模板信息卡，图片统一为 1080×1440 PNG。
4. “真人感”来自具体场景、动作和选择规则；没有真实素材时禁止虚构第一人称体验。
5. OAuth 未完成时只允许 `--mock` 验证程序链路；只有真实 OpenClaw 调用成功才算实跑完成。

## Objective

建立一个可扩展的本地批处理 MVP：把 Query 放入 SQLite 队列，Worker 原子领取一条任务，通过 OpenClaw 生成合法 JSON 文案和 AI 主图，再生成两张信息卡、执行机械质检并落盘。失败任务保留错误与重试次数，不能静默丢失。

## Tech Stack

- Node.js 24.19，ECMAScript modules。
- Node 内置 `node:sqlite` 保存任务队列。
- Node 内置 `node:test` 执行测试。
- OpenClaw 2026.8.2 CLI 执行文本与图片推理。
- Sharp 将受控 SVG 模板渲染为 PNG。

## Commands

- 安装：`npm install`
- 初始化数据库：`npm run db:init`
- 加入示例任务：`npm run enqueue -- --query "租房卧室的桌面总是乱，怎么做低成本整理？"`
- Mock 单条：`npm run worker -- --once --mock`
- 实跑单条：`npm run worker -- --once`
- 查看队列：`npm run status`
- 测试：`npm test`
- 冒烟测试：`npm run smoke`

## Project Structure

```text
src/                 应用源码
tests/               单元与集成测试
server/prompts/      版本化提示词
tasks/               实施计划和任务清单
data/queue.sqlite    本地队列（忽略提交）
output/<task-id>/    文案、图片、质检与执行清单（忽略提交）
```

## Code Style

使用小函数、命名导出、显式依赖注入。模型输出只能作为数据解析和校验：

```js
export function parsePost(raw) {
  const value = JSON.parse(raw);
  return validatePost(value);
}
```

OpenClaw 通过参数数组启动，不启用 Shell，也不把 Query 或模型输出拼进命令字符串。

## Testing Strategy

- 纯逻辑：标题、正文、图标、图片计划和安全字段校验。
- SQLite 集成：入队、原子领取、完成、失败和过期租约回收。
- OpenClaw 边界：使用可控 Fake，不在常规测试里消耗模型额度。
- 冒烟：Mock 模式必须生成完整交付包；OAuth 可用后再运行真实单条。

## Boundaries

- Always：校验 Query 长度；使用参数化 SQL；校验模型 JSON；限制超时、输出大小、图片数量和文件路径。
- Ask first：升级全局 OpenClaw、创建正式定时任务、启用自动发布、扩大并发或每日额度。
- Never：保存或打印 OAuth Token/API Key；执行模型输出；虚构第一人称体验；把未核验内容标成终审通过。

## Success Criteria

1. `npm test` 全部通过。
2. Mock 冒烟从空库入队一条任务并生成 `post.json`、`post.md`、3 张 1080×1440 PNG、`qc.json` 和 `manifest.json`。
3. 真实冒烟通过 `openai-codex` OAuth 生成文案，通过 OpenClaw 图片能力生成主图并完成同样的交付包。
4. 队列最终状态为 `completed`；失败时为 `failed` 且包含可读错误，不泄露凭据。

## Open Questions

- 正式阶段的输入文件格式、事实研究来源、账号级语气模板、发布接口和每日预算留到 MVP 成功后确认。

## Official Sources

- OpenClaw inference: https://docs.openclaw.ai/cli/infer
- OpenClaw image generation: https://docs.openclaw.ai/tools/image-generation
- Node SQLite: https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html
- Node test runner: https://nodejs.org/download/release/v24.19.0/docs/api/test.html
- Node child processes: https://nodejs.org/download/release/v24.19.0/docs/api/child_process.html
- Sharp installation/output: https://sharp.pixelplumbing.com/install/ and https://sharp.pixelplumbing.com/api-output/
