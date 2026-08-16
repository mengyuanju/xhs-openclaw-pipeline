# 小红书 × OpenClaw 内容工场

本项目把 Excel 选题批量转为 SQLite 任务，通过独立 OpenClaw worker 生成 3–5 张图的小红书图文草稿，再进入本机 Web 后台做文案修改、图片修订、图生图和人工审核。它不会自动发布到小红书。

## 能力范围

- `.xlsx` 最多 5 MiB / 5,000 行，先预检、后确认入队，重复确认不会重复建任务。
- 文本、图片、图片编辑三类系统提示词支持不可变版本、发布和回滚。
- 任务入队时固定提示词内容、版本与 SHA-256，后续全局修改不污染在途任务。
- 文案和图片修改保留父子版本；审核通过后再次编辑会自动回到待审核。
- 参考图可以进入文生图流程；审核端 AI 图生图请求由后台 worker 异步消费。
- 默认只监听 `127.0.0.1`，没有自动发布能力。

## 环境

- Node.js 24.14+
- OpenClaw 2026.5.7+
- 真实模式需要 OpenClaw 中可用的文本与图片模型授权

## 启动后台

```powershell
npm install
npm run dev
```

生产构建与本机启动：

```powershell
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。数据库默认为 `data/queue.db`，生成交付在 `output/`，审核素材在 `data/assets/`；这些目录不会进入 Git。

## Excel 导入

首个工作表必须包含 `query`、`查询`、`选题` 或 `主题` 之一。可选列：

```text
externalId, category/分类, targetAudience/目标用户,
promptSet, imageCount/图片数量, referenceImageFiles/参考图,
priority/优先级, metadata/元数据
```

`imageCount` 只能为 3–5，`metadata` 必须是 JSON 对象。上传后先检查错误行，再点击确认入队。

## Worker

Mock 单条，不调用模型：

```powershell
npm run worker -- --once --mock
```

Mock 连续消费，最多处理 1000 个内容或图片编辑工作项：

```powershell
npm run worker:drain -- --mock --max 1000
```

真实连续消费必须显式使用 `--live` 和上限。第一次建议从 10–20 条开始验证提示词、配图和预算：

```powershell
npm run worker:drain -- --live --max 20
```

真实模式会产生模型调用成本。订阅账号/OAuth 不适合作为每天 1000 条的长期批量额度；生产使用前应配置正式 API 预算、速率限制、失败重试和用量告警。

## OpenClaw 登录

当前版本可使用：

```powershell
openclaw plugins enable openai
openclaw models auth login --provider openai-codex
```

CLI 版本变化时，以 `openclaw models auth login --help` 和 `openclaw models list` 为准。授权码、设备码、Token 和 API Key 都不应写入本项目或后台表单。

## 验证

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
```

安全边界：Query 和模型输出不会进入 Shell；SQL 参数化；上传图片由 Sharp 解码并限制体积/像素；文件路径限定在受控根目录；API 写操作要求 localhost 同源；提示词与审核操作保留版本和审计记录。
