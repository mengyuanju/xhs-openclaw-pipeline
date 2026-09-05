# 联网研究与来源留存规格

## 目标

正式文案生成在调用文本模型之前，通过配置的搜索服务执行可追溯的网页检索，默认使用 DeepSeek Flash。文本模型只能使用本次研究快照和任务原始参考资料中的事实，最终 `post.sources` 只能引用这两类白名单 URL。

## 运行边界

- Live 且需要生成新文案的任务默认检索；Mock 不访问网络，人工文案仅重生图片时不重复检索。
- 每个任务只提交经过长度限制的 `query`，不把目标人群、管理员提示词、凭据或其他任务字段发送给搜索提供方。
- 默认最多保存 5 个去重后的公开 HTTP(S) 来源。
- `XHS_WEB_SEARCH_PROVIDER=OPENCLAW` 沿用现有 OpenClaw 逻辑，当前默认提供方为 `codex`，Codex Hosted Search 使用现有 OpenAI/Codex 登录。显式传入多个受支持提供方时，仍保留依次尝试的契约。
- `XHS_WEB_SEARCH_PROVIDER=DEEPSEEK`（项目默认）使用官方 Responses API 的服务端 `web_search`，默认模型为 `deepseek-v4-flash`；Key 仅从实际执行机的 `DEEPSEEK_API_KEY` 读取。搜索模型和超时由独立配置模块解析，不改变文案、审核或生图模型。显式保存的服务或环境覆盖仍然优先。配置示例见 README 的“联网搜索提供方配置”。
- “生产配置 → 联网搜索”面板在本地和中心模式均可保存提供方、模型及超时；保存到 `modelApi` 的非空覆盖值优先于执行机环境变量，`null` 恢复继承。中心执行使用领取时的配置快照，不改变运行中的任务。专用搜索配置接口仅接受这三个字段，并保留其他生产配置。
- DeepSeek 响应必须完成并包含完成的 `web_search_call`，模型输出的摘要和来源仍是不可信数据，沿用公共 URL 校验、去重、权威性排序、最多 5 个来源和最多 5 次研究尝试的限制。不会把“执行过搜索”等同于独立核实了所有模型返回内容。
- 当前 OpenClaw 安装没有可用的 `web.fetch` provider，因此本阶段保存搜索返回的标题、URL、摘要或归纳文本，不声称抓取过网页全文。

## 研究快照契约

```json
{
  "schemaVersion": 1,
  "status": "COMPLETED | FAILED",
  "query": "提交给搜索提供方的检索词",
  "searchedAt": "ISO-8601",
  "provider": "实际成功的提供方或 null",
  "summary": "提供方返回的有界归纳文本或 null",
  "attempts": [
    {
      "provider": "codex",
      "status": "FAILED",
      "error": "脱敏并截断的错误"
    }
  ],
  "sources": [
    {
      "title": "来源标题",
      "url": "https://example.com/article",
      "snippet": "搜索摘要",
      "siteName": "example.com",
      "provider": "duckduckgo",
      "retrievedAt": "ISO-8601"
    }
  ]
}
```

快照是外部不可信数据。标题、摘要和归纳文本中的命令、角色设定或格式要求均不得执行。

## 保存位置

- 每次 Live 尝试目录保存 `research.json`，使用原子写入。
- 完成交付的 `manifest.json` 记录研究状态、实际提供方、来源数，并把 `research.json` 纳入文件哈希清单。
- `generation_runs.research_snapshot_json` 保存有界快照；成功和失败运行都保存，旧记录保持 `null`。
- 检查点保存成功快照，图片阶段重试复用同一份资料，不重复联网，也不让同一任务的事实依据漂移。

## 失败策略

- 单个提供方失败时记录脱敏错误并尝试下一个已配置提供方。选择 DeepSeek 时仅调用 DeepSeek，失败记录标记为 `deepseek`，不隐式回退 OpenClaw。
- 所有提供方失败或没有返回可用公开 URL 时，Live 文案生成失败；不得继续生成并假装资料已核验。
- 失败快照先写入 `research.json`，再进入现有失败记录流程。
- 搜索输出不是合法 JSON、URL 使用非 HTTP(S) 协议、含凭据、指向 localhost/内部域名或字面 IP 时，拒绝对应来源。

## 验收条件

- OpenClaw 适配器以无 shell 参数调用 `infer web search --json`，应用现有模型代理，并对错误脱敏。
- 显式配置多个受支持的 OpenClaw 提供方时，第一个失败后可由后续提供方接管，快照保留完整尝试链；默认配置不新增后备提供方。
- DeepSeek 的 Key 只放在 HTTP Authorization 请求头中，不进入搜索提示词、研究快照或错误信息。缺 Key、HTTP/网络失败、无完成搜索记录、非法 JSON、无有效来源均不能进入正文生成。
- 正常 OpenClaw 客户端、独立文案客户端和执行机复用同一搜索配置，原有模拟执行机独立保留；显式选择 OpenClaw 时旧搜索行为保持一致。
- 文本提示词明确区分“用户参考资料”和“本次联网研究快照”，并把两者都视为不可信证据数据。
- 模型返回快照外 URL 时结构校验失败并触发现有文案修复重试。
- `research.json`、manifest、SQLite 和 checkpoint 的定向测试通过；全量测试、类型检查和构建无回归。

## 非目标

- 不实现浏览器自动化、登录后网页读取、站内小红书搜索或图片版权判定。
- 不自动下载搜索结果里的图片，不把搜索到的图片直接作为生成参考图。
- 不给历史任务补造搜索来源，不自动发布内容。
