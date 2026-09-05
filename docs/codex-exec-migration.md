# Codex exec 迁移与验收

## 交付边界

默认生成引擎为 `CODEX`，使用官方 CLI 已保存的 ChatGPT 登录。OpenClaw 代码、历史来源记录和注入接口保留，便于回切。现有发布限制、人工审核、图片尺寸/质量门槛不变；没有新增自动发布、生产定时器或常驻后台服务。

这次完成的是实现与不消耗额度的验证。`agent:check` 只检查本机登录/版本，不调用模型，也不能证明模型权限、剩余额度、生图 JSONL 协议或持续吞吐量可用。真实生图/改图和持续并发验收仍待执行，不能承诺订阅账号 24/7 无中断。

官方参考：[非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[图片生成](https://learn.chatgpt.com/docs/image-generation)、[联网搜索](https://learn.chatgpt.com/docs/web-search)。订阅计费与 API 计费不是可互换的无限容量承诺，任务量大时仍应评估官方 API。

## 接线范围

| 现有能力 | Codex 实现 |
| --- | --- |
| 文案、Excel 需求筛选、文案知识分析 | stdin 完整提示词，结构化最终输出包装为原 `rawText` 接口 |
| Query / 正文 / 质量审核 | 独立调用和原模型覆盖配置，保留审核证据与检查点 |
| OCR / 图文对齐 / 视觉知识 | 最多 5 张规范化附件副本，不覆盖源图 |
| 原生联网检索 | 显式开启 live search，要求实际搜索事件和合法来源 URL；来源真实性仍依赖模型核对 |
| 生图 / 改图 | 原生图片工具，最多 10 张改图附件；验证工具记录、受限目录、新鲜 PNG 和完整解码后交付 |
| 本机 Worker / 分布式执行器 / 独立生成页面 | 统一 `createAgentClient`，保留原队列、审核、追踪和恢复流程 |

模型引用仍保存为 `openai/<model>`；CLI 调用时去掉 `openai/` 前缀。内置图片模型只接受 `openai/gpt-image-2`，由文本模型驱动原生图片工具。模型和思考强度最终是否获账号支持，需要真实验收；不会静默降级到其他模型。

原生图片事件支持 `image_generation` / `imageGeneration` 及 `saved_path` / `savedPath`；没有事件证据、目录越界、旧文件、坏 PNG、CLI 失败或覆盖现有目标都会报错，不会用 Sharp 绘制的占位图伪装成功。这里的 Sharp 只用于输入规范化和输出验证；后续原有业务图片处理继续保留。

## 配置与回切

优先级：后台 `modelApi.agentProvider` > `XHS_AGENT_PROVIDER` > `CODEX`。保存为 `null` 表示继承执行机环境，而非固定账号或固定引擎。

- 本机：生产配置 → 模型 API 与网络 → 生成引擎。
- 分布式：生产配置 → 生产配置 JSON → 生成引擎 → 保存新版本。下拉框覆盖同次提交 JSON 中的 `modelApi.agentProvider`，其他字段保留。
- 旧字段 `copyGenerationProvider: OPENCLAW` / `webSearchProvider: OPENCLAW` 是兼容值，现表示“默认生成引擎”；真正的引擎由 `agentProvider` 决定。`DOTS` / `DEEPSEEK` 仍分别调用各自服务，凭据独立管理。
- 模型切换不强行改写已有执行快照或重启在途任务。本机长批次 Worker 使用启动时的客户端，需结束后重启才能换引擎。已有失败快照要改引擎时，明确选择“使用最新配置重新生成”；“从失败步骤继续”保留旧快照。

回切选择 `OPENCLAW`，确保原 OpenClaw 登录/网关可用，再重启相应 Worker。后台已有显式配置时，只改环境变量不会覆盖它。Codex 的本地暂停不阻止显式 OpenClaw 回退。

## 同机并发与暂停

默认状态库：`CODEX_HOME/xhs-runtime/limits.sqlite`，未配置 `CODEX_HOME` 时为当前用户 `.codex/xhs-runtime/limits.sqlite`。可用 `XHS_CODEX_RUNTIME_DB` 指定统一的本地绝对路径。

同一主机、同一订阅账号的进程应共享此文件：总调用最多 2 个（`XHS_CODEX_CONCURRENCY=1` 可降为 1），其中生图/改图最多 1 个。任务内并发参数不能突破共享限制。SQLite 短事务跨进程抢占许可；父进程和模型子进程都已退出才回收崩溃遗留许可。进程超时/取消会终止该次进程树，等待退出后释放许可。

此限制只覆盖使用本适配器和同一状态库的进程，不覆盖其他 Codex 窗口、OpenClaw、其他电脑或其他 `CODEX_HOME`。它不是全账号配额服务。不要把 SQLite 放到网络共享盘冒充跨主机锁；高并发多机应另做中心调度。限制值变化需所有进程统一配置并重启。

- 认证失效、订阅额度耗尽：共享暂停；执行器不再领取新任务。原有在途调用不被强杀，但后续调用会检查暂停。
- 429：共享约 60–65 秒冷却，无无限重试。冷却后可继续领取；本机队列允许有限重试。
- 分布式 Codex 图片执行失败：上报 `autoRetry:false`，进入 `IMAGE_FAILED`，由人工检查额度/检查点后续跑（包括限流导致当前任务失败的情况）。避免中心服务把结果未知的超时重试为新一轮生图。OpenClaw 原有 3 次总尝试预算保留。
- `agent:resume` 只清除暂停，不充值、不绕过额度、不自动重排失败任务；额度未恢复时再调用仍会暂停。

```powershell
npm run agent:check
npm run agent:status
# 只有额度/登录问题解决后由管理员执行：
npm run agent:resume
```

以上脚本加载 `.env` 和可选 `.env.local`。现有 `executor` 脚本加载 `.env`；运行 Worker 时请保证主机进程环境一致。诊断命令不读取/打印认证文件内容。模型子进程只继承系统、代理和 Codex 目录所需环境，不传业务密钥或 `OPENAI_API_KEY`，且强制 ChatGPT 登录模式。

## 升级顺序

1. 结束旧 Worker / 执行器，保留任务数据库、图片资产和 `data/executor-work/<task-id>/` 检查点。不要强删在途文件。
2. 更新并重启中心服务（若使用分布式模式）。`/health` 必须报告 `capabilities.executionRetryControl: true`；Codex 执行器在缺少此能力时拒绝启动，避免旧服务忽略重试控制。此次还补齐了已有图片恢复契约：传递原执行 ID 链、限定原节点领取、快照缺失拒绝默默重画。
3. 更新本机 Web 与执行器，安装/保留 Codex CLI，在每台执行主机由账号持有人运行 `codex login`，然后运行 `npm run agent:check`。
4. 配置生成引擎及统一状态库，先执行下面的小规模真实验收，再启动已有的有限批次命令。此文档不授权自动发布或新增生产定时任务。

本机 SQLite 首次打开会扩展需求筛选来源约束以接受 `CODEX`，迁移保留现有导入行及历史模型字段。中心服务这次无新增业务表；失败上报新增可选布尔字段 `autoRetry`（默认 `true`），旧调用方行为不变。它属于 `POST /v1/executions/:id/fail` 请求体，与 `error` 并列。

## 真实验收清单（尚未执行）

1. 用一条不含敏感数据的需求验证文案、审核、检索与视觉分析，核对保存的 provider/model/执行记录。
2. 生成一张图，再以这张图测试改图，确认 CLI 实际返回原生图片事件和可读 PNG；不能只看退出码或最终文字。此项尤其需要确认当前 CLI 的 exec JSONL 输出形态。
3. 两条任务并发（至少一条含图片），核对共享槽位总数不超过 2、图片不超过 1，记录延迟与失败率。
4. 在可控测试环境模拟暂停、恢复与失败步骤继续，确认旧图不重画；不要为测试刻意耗尽账号额度。
5. 小批量观察实际额度消耗；持续运行时长与吞吐量必须由实测给出，不能从订阅价格推算保障。

若真实图片协议不符合预期，保持失败状态，保留日志并回切 OpenClaw；不要删掉证据校验让功能“看起来通过”。

## 无额度验证

`npm test`、`npm --prefix server test`、`npm run typecheck`、`npm run build`、`npm run smoke`。Codex 专用测试使用假 JSONL / 假 PNG 和本地 Node 子进程；跨进程测试只验证调度与取消，不衡量真实模型吞吐量。最终执行结果记录在 `tasks/todo.md`。
