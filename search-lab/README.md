# 搜索与文案对照实验室

从仓库根目录运行：

```powershell
npm run search:lab
```

浏览器打开 `http://127.0.0.1:3077`。测试站独立监听本机地址，搜索比较可独立运行。选择服务商、输入相应产品的 API Key 和同一个 Query，即可并行对比资料摘要、最多 5 条公开来源、调用耗时和失败原因。每个服务商只对原始 Query 发起一次研究调用；当前 DeepSeek 适配器会沿用生产代码内部的错误恢复重试。搜索完成后可以使用各家的资料生成最终小红书文案。

Key 仅随本次请求发送到本机测试站，再由服务端转发至所选服务商；页面不使用浏览器存储，服务端不写入文件或数据库，也不回显 Key。测试会实际调用第三方 API，可能产生费用。未提供 Key 时仍可启动网站和查看支持列表；真实效果必须提供已开通相应搜索服务的 Key 才能验证。

## 查看最终文案

1. 选择搜索服务商，填写 Key 和 Query，点击「开始对照搜索」。
2. 在「统一文案生成设置」查看系统模型与提示词来源，可填写分类、人群、补充要求和配图文字页数。
3. 点击某张成功结果卡的「生成最终文案」，或「为所有成功结果生成」。同批使用相同的模型、要求与配置快照。
4. 查看标题、正文、标签、原稿与修订稿、审核问题、修复记录、逐页配图文字和场景。文案可复制或下载，本次实际发送的提示词与模型原始输出可以展开查看。

文案编排直接复用 `src/copy-generation.mjs`：系统策略允许时进行 Query 审核，系统开启案例库时进行案例匹配，然后复用已完成的搜索快照，生成首稿，按生产规则修复正文与结构，并输出配图文字规划。生成不会重新搜索，也不会制作真实图片或提交生产任务。

当前生产执行机生成后进入人工质检；测试页默认增加自动文案审核和拒绝后的自动修订，使用现有审核、修订提示词。关闭这两个选项即可查看原生成流程的成稿。审核未通过时保留文案和问题，并显示未通过状态；关闭审核时明确显示未审核。

如果两次修订都没有实际改变原稿，页面会显示「修订未产生修改，已保留原稿」，保留原稿、未改变的修订输出和原稿审核问题，便于调整要求后重新生成。该结果未通过审核，修订输出未复检，复制与下载仍可使用，下载文件以「生成稿」命名；修订尝试和模型原始输出可在诊断记录中查看。

默认沿用当前系统的生成模型、审核模型与思考强度，使用本机已有 Codex 登录；选择 Dots 时可以填写单独的生成 Key，审核仍使用系统审核模型。启动命令读取 `.env`、`.env.local`，网页不会获得其中的密钥。点击生成按钮后才会调用模型。

## 提示词与系统配置来源

优先只读读取本机中心服务当前使用的生产或开发数据库，复用已发布提示词原文、版本、模型设置、案例库开关与审核策略。通过 `CONTROL_PLANE_URL` 对应的本机监听进程识别环境，也可以显式设置：

```powershell
$env:SEARCH_LAB_SERVER_ENV = 'production'
npm run search:lab
```

中心数据库连接沿用 `server` 的环境配置，仅执行只读查询；不会初始化、迁移或修改生产库。无法读取时改用已有本机 SQLite 的只读配置，再无法读取则使用仓库内置原文；页面会显示来源与回退说明。`SEARCH_LAB_DATABASE_URL` 可指定只读访问的中心数据库连接，但不要把凭据写进仓库或发到聊天中。

每次读取的配置有一个内存快照，生成时固定它；「重新读取系统配置」可以获取新发布版本并保留页面内已填 Key。配置与文案结果仅保留在服务端内存，终态任务保留一小时、最多 24 个；服务重启后清空。如果旧页面的配置快照已过期或服务重启导致快照失效，点击生成时会自动读取最新系统配置并重试一次，页面输入与 Key 不会被清空。只补偿确定尚未创建任务的配置过期错误，模型失败或不确定的网络失败不会自动重发。最多同时运行 2 个文案流程，其余排队，每个流程的最长等待时间为 20 分钟。

## 服务商和凭据

| 选项 | 凭据 | 输出类型 | 官方文档 |
| --- | --- | --- | --- |
| DeepSeek（当前系统） | DeepSeek API Key | 模型联网回答 | [DeepSeek](https://api-docs.deepseek.com/) |
| 阿里云 IQS | IQS API Key | 网页搜索摘要 | [IQS](https://help.aliyun.com/zh/document_detail/2883041.html) |
| 阿里云 OpenSearch | OS Key、工作空间、公网 HTTPS 接入地址 | 网页搜索摘要 | [OpenSearch](https://help.aliyun.com/zh/open-search/search-platform/developer-reference/web-search) |
| 阿里云百炼联网 | 百炼 API Key、业务空间 ID | 模型联网回答，来源通常没有逐条摘要 | [百炼](https://help.aliyun.com/zh/model-studio/web-search) |
| 小米 MiMo | 普通按量 API Key，需开通联网插件 | 模型联网回答及引用摘要 | [MiMo](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/tool-calling/web-search) |
| 智谱 Web Search | 智谱 API Key | 网页搜索摘要 | [智谱](https://docs.bigmodel.cn/api-reference/%E5%B7%A5%E5%85%B7-api/%E7%BD%91%E7%BB%9C%E6%90%9C%E7%B4%A2) |
| 百度千帆 AI Search | 千帆 API Key | 网页搜索摘要 | [千帆](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5) |
| 讯飞星火万搜 | 万搜 APIPassword，需开通权限 | 网页搜索摘要 | [万搜](https://www.xfyun.cn/doc/spark/Search_API/search_API.html) |
| 腾讯云联网搜索 WSA | WSA 服务 API Key | 网页搜索摘要 | [WSA](https://cloud.tencent.com/document/product/1806/130615) |
| 火山引擎豆包搜索 | 豆包搜索 Global 版按量后付费 Key | 网页搜索摘要 | [豆包搜索](https://www.volcengine.com/docs/87772/2548026) |
| Kimi 联网搜索 Basic | Kimi 开放平台 API Key | 网页搜索摘要 | [Kimi](https://platform.kimi.com/docs/api/tools-search) |
| MiniMax Coding Plan 搜索 | Token Plan 订阅 Key，选择对应地域 | 网页搜索摘要 | [MiniMax](https://platform.minimax.cn/docs/token-plan/mcp-guide) |

阿里云的三项搜索产品使用不同的服务和 Key，不能互换。原始搜索 API 返回的“摘要”是按网页片段排列的摘录，模型联网接口返回的是模型回答；页面会注明输出类型。来源 URL 沿用生产研究快照的公开地址校验和去重规则，快照包含 `status`、`query`、`searchedAt`、`provider`、`summary`、`attempts` 和 `sources`。若医疗、法律、金融等主题未通过当前系统的权威来源规则，测试页仍会展示经过相同公开 URL 过滤的服务商原始资料，并明确标为“未通过规则”。

豆包搜索默认开启「仅国内ICP备案网站」，请求传入 `Filter.IcpHostOnly=true`，取消勾选可比较不限来源的搜索效果。该选项限制网站来源，国内网站仍可能包含国外案例；不会改写输入的 Query。旧页面没有发送该参数时也默认启用。参数含义见[Global 版官方接口文档](https://docs.volcengine.com/docs/Networkedsearch/doubao-search-global-edition?lang=zh)。

## 腾讯 WSA 失败排查

腾讯请求只传 `Query`，使用接口默认的自然检索，兼容不支持显式 `Mode` 参数的极速版。失败时页面保留腾讯返回的错误码、已脱敏的说明和 `RequestId`，也会识别 HTTP 200 内的业务错误。按[官方接入文档](https://cloud.tencent.com/document/product/1806/130615)，`UnauthorizedOperation` 应核对 WSA 服务 Key，`ResourceNotFound` 应开通服务，`ResourceUnavailable` 应检查欠费及服务状态，`RequestLimitExceeded` 表示请求频率超限。WSA 服务 Key 与腾讯云账号的 `SecretId`、`SecretKey` 不通用。

自动化验证使用假的 HTTP 响应，不消耗模型或搜索额度：

```powershell
node --test tests/search-lab.test.mjs tests/search-lab-copy-generation.test.mjs tests/search-lab-copy-config.test.mjs tests/search-lab-copy-service.test.mjs
```
