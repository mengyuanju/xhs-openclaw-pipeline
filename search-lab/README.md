# 联网搜索 API 对比测试站

从仓库根目录运行：

```powershell
npm run search:lab
```

浏览器打开 `http://127.0.0.1:3077`。测试站独立监听本机地址，不依赖生产站的登录、数据库或生产搜索配置。选择服务商、输入相应产品的 API Key 和同一个 Query，即可并行对比资料摘要、最多 5 条公开来源、调用耗时和失败原因。每个服务商只对原始 Query 发起一次研究调用；当前 DeepSeek 适配器会沿用生产代码内部的错误恢复重试。此处不生成完整小红书成稿。

Key 仅随本次请求发送到本机测试站，再由服务端转发至所选服务商；页面不使用浏览器存储，服务端不写入文件或数据库，也不回显 Key。测试会实际调用第三方 API，可能产生费用。未提供 Key 时仍可启动网站和查看支持列表；真实效果必须提供已开通相应搜索服务的 Key 才能验证。

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

自动化验证使用假的 HTTP 响应，不消耗模型或搜索额度：

```powershell
node --test tests/search-lab.test.mjs
```
