# 小红书 × OpenClaw 内容工场

本项目把 Excel 选题批量转为 SQLite 任务，通过独立 OpenClaw worker 生成 3–5 张图的小红书图文草稿，再进入本机 Web 后台做文案修改、图片修订、图生图和人工审核。它不会自动发布到小红书。

## 能力范围

- `.xlsx` 最多 5 MiB / 5,000 行，先预检、后确认入队，重复确认不会重复建任务。
- 文本、图片、图片编辑三类系统提示词支持不可变版本、发布和回滚。
- 任务入队时固定提示词内容、版本与 SHA-256，后续全局修改不污染在途任务。
- 文案和图片修改保留父子版本；审核通过后再次编辑会自动回到待审核。
- 参考图可以进入文生图流程；审核端 AI 图生图请求由后台 worker 异步消费。
- 默认只监听 `127.0.0.1`；显式启动局域网模式后，所有页面和 API 仍要求管理员登录。

## 环境

- Node.js 24.14+
- OpenClaw 2026.5.7+
- 真实模式需要 OpenClaw 中可用的文本与图片模型授权

## 启动后台

首次使用先在主机终端配置管理员密码。输入过程不会回显，项目只保存 scrypt 哈希：

```powershell
npm install
npm run auth:setup
npm run dev
```

生产构建与本机启动：

```powershell
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。数据库默认为 `data/queue.db`，生成交付在 `output/`，审核素材在 `data/assets/`；这些目录不会进入 Git。

### 局域网登录

完成密码配置后，构建并显式监听局域网地址：

```powershell
npm run build
npm run start:lan
```

同一私有局域网的设备打开 `http://<这台电脑的局域网IP>:3000`，使用刚设置的管理员密码登录。默认允许 loopback、`10/8`、`172.16/12`、`192.168/16`、IPv4 link-local 和 IPv6 ULA/link-local；如需使用电脑主机名，在 `.env.local` 添加 `XHS_ALLOWED_HOSTS=主机名` 后重启。

`start:lan` 不等于公网部署。它只适用于可信家庭/办公局域网；不要在来宾 Wi-Fi、端口映射或公网服务器上直接使用 HTTP。跨网段或公网部署必须增加 HTTPS 反向代理、防火墙白名单和更完整的身份系统。

## Excel 导入

首个工作表必须包含 `query`、`查询`、`选题` 或 `主题` 之一。可选列：

```text
externalId, category/分类, targetAudience/目标用户,
promptSet, imageCount/图片数量, referenceImageFiles/参考图,
priority/优先级, metadata/元数据
```

`imageCount` 只能为 3–5，`metadata` 必须是 JSON 对象。上传后先检查错误行，再点击确认入队。

如工作表已经完成业务筛选，还可提供 `是否有效`、`废弃原因`、`需求强度判定`、`判定简要说明`：明确为“否”的行只保留在预检结果中，不会入队；明确为“是”的行须填写“强需”或“中需”，判定会随任务输入传给 Worker。

## 溯源规则提示词

三类运行提示词分别位于 `prompts/text-system.md`、`prompts/image-system.md` 和 `prompts/image-edit-system.md`，其中的 `[Rxxx]` 对应工作区上级文档 `图文生成统一系统提示词_原始文档溯源版.md` 的来源表。

全新数据库会自动使用这些提示词。已有数据库需要显式发布新版本：

```powershell
npm run prompts:install-rules
```

该命令按内容哈希幂等安装并发布版本，不修改已入队任务固定的提示词快照。新版本只影响之后提交的任务。

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

安全边界：Query 和模型输出不会进入 Shell；SQL 参数化；上传图片由 Sharp 解码并限制体积/像素；文件路径限定在受控根目录；API 要求有效管理员会话，写操作还要求严格同源；提示词与审核操作保留版本和审计记录。
