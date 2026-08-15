# 小红书 × OpenClaw 自动生产 MVP

这个项目把 Query 放入本地 SQLite 队列，通过 OpenClaw 生成结构化小红书文案和一张 AI 主图，再用本地模板生成两张 3:4 信息卡。它只生产本地交付文件，不负责自动发布。

## 环境

- Node.js 24.14+
- OpenClaw 2026.5.7+
- 已启用 OpenClaw `openai` 插件
- 已完成 `openai-codex` OAuth

## 快速开始

```powershell
npm install
npm run db:init
npm run enqueue -- --query "租房卧室的桌面总是乱，怎么做低成本整理？"
npm run worker -- --once --mock
npm run status
```

Mock 模式只验证代码和文件链路，不会调用模型。真实调用：

```powershell
npm run enqueue -- --query "租房卧室的桌面总是乱，怎么做低成本整理？"
npm run worker -- --once
```

每条完成任务写到 `output/<task-id>/`：

- `post.json`：结构化文案和图片计划。
- `post.md`：便于人工审阅的文本。
- `01-hero.png`：OpenClaw AI 主图。
- `02-steps.png`、`03-checklist.png`：本地生成的信息卡。
- `qc.json`：机械质检结果。
- `manifest.json`：执行来源、模型、文件与时间记录。

## OpenClaw 登录

本机 2026.5.7 使用的 OAuth provider id 是 `openai-codex`：

```powershell
openclaw plugins enable openai
openclaw models auth login --provider openai-codex
```

新版本 CLI 的 provider 名称或命令可能变化，以 `openclaw models auth login --help` 和 `openclaw models list` 为准。

## 安全边界

- Query 不会被拼接为 Shell 命令。
- 模型输出必须先通过 JSON 契约校验。
- 输出路径只使用 SQLite 整数任务 ID。
- OAuth Token 和 API Key 不写入项目、日志或交付文件。
- 未提供真实经历时禁止生成“亲测”“我用了几年”等内容。
