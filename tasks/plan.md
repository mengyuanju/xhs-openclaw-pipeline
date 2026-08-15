# Implementation Plan: 小红书图文自动生产 MVP

## Overview

先做可重复测试的本地队列和 Mock 端到端，再接入 OpenClaw 文本与图片能力。每一阶段都保持项目可运行，真实 OAuth 是最后一个外部验收点。

## Architecture Decisions

- 使用 SQLite 任务状态机，避免用文件名推断状态。
- OpenClaw 调用走 `spawn` 参数数组并关闭 Shell，Query 不进入命令文本。
- 文案输出采用严格 JSON 契约；模板卡由本地渲染，避免 AI 图片中的中文错字。
- 真实主图失败时任务失败，不静默替换成“已完成”；Mock 仅用于程序验证。

## Task List

### Phase 1: Foundation

- [ ] Task 1: 初始化项目、规则、依赖和测试入口。
- [ ] Task 2: 实现并测试 SQLite 队列状态机。

### Checkpoint: Foundation

- [ ] 队列测试通过，项目无高危依赖漏洞。

### Phase 2: Core Flow

- [ ] Task 3: 实现文案契约、Prompt 和 OpenClaw 文本适配器。
- [ ] Task 4: 实现 3:4 信息卡、AI 主图适配与交付清单。
- [ ] Task 5: 串联 Worker、CLI 和机械质检。

### Checkpoint: Core Flow

- [ ] Mock 冒烟能生成完整交付包。

### Phase 3: Live Verification

- [ ] Task 6: 完成 OpenAI/Codex OAuth 并验证真实文案。
- [ ] Task 7: 验证真实 AI 主图和完整单条任务。

### Checkpoint: Complete

- [ ] 测试、Mock 冒烟和真实单条均通过。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| OAuth 未完成或订阅无图片能力 | 高 | 保留明确阻塞状态，不伪装为真实成功 |
| OpenClaw 版本与最新文档不同 | 中 | 以本机 `--help` 和插件清单为执行契约 |
| 模型返回非 JSON | 中 | 提取 JSON 后严格校验，失败可重试 |
| Query/模型输出诱导命令执行 | 高 | `spawn` 参数数组、禁用 Shell、文件名只用数据库 ID |
| 中文卡片字体缺失 | 中 | 使用 Windows 常见中文字体栈并在冒烟后检查成图 |

## Open Questions

- 无阻断问题；正式调度与发布不在当前范围。
