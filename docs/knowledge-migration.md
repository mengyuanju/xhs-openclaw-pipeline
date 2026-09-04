# 知识库页面迁移

本次以旧项目 `http://127.0.0.1:3000/knowledge` 为功能基准，恢复视觉／文案页签、文案分析后人工检查保存、原文与完整分析查看、标签筛选、已保存文案编辑、常用分析 Prompt 保存和替换，以及视觉配方和图片保留流程。

## 存储与行为

- 未设置 `CONTROL_PLANE_URL`：继续使用 `XHS_DB_PATH`（默认 `data/queue.db`）及 `XHS_KNOWLEDGE_ROOT`（默认 `data/knowledge`）。文案、标签关联、常用 Prompt 使用旧版 SQLite 表；编辑更新原记录，保留创建时间和分析模型。
- 设置 `CONTROL_PLANE_URL`：页面与所有知识库 API 使用中心服务，读取失败会显示错误，写入不会退回本地。文案正文、摘要、完整分析和标签存入现有 `knowledge_versions.content`；保持文案 ID，每次人工保存原子发布一个新版本，以保护运行中任务的配置快照，界面不额外增加“发布文案”步骤。
- 中心侧常用 Prompt 存在 `global_settings.copy_analysis_prompts`，事务行锁保证多台机器合计最多 10 条。相同内容去重，达到上限后由用户选择替换，替换保留 ID 和创建时间。无需新建 PostgreSQL 表或修改既有迁移文件。
- 旧库未使用的分类标签也迁入：SQLite 保留标签表，中心保存分类目录 `global_settings.copy_knowledge_labels`；页面筛选只显示有文案引用的标签。
- 分析只返回草稿，不写入知识库。真实模型仍由本机 OpenClaw 调用；测试使用 fake，不消耗模型配额。
- 视觉知识先存草稿，再由用户发布；归档后不进入后续任务快照。仅提示词模式不保存图片。保留图片必须是自有或已授权，校验类型、大小和像素后转为 PNG；中心模式直接上传规范化后的图片，不在执行机长期保存参考图片。图片更换后需重新分析。

## 上线顺序

1. 更新并重启中心机器的 `server/`（包括新文件 `server/src/knowledge-admin.mjs`）。依赖未变化。
2. 只读检查 `GET /v1/knowledge/capabilities`，应返回 `data.workbenchVersion: 1`。
3. 更新本机界面，运行 `npm run build` 后按既有方式启动，或在开发模式刷新 `/knowledge`。
4. 先预检旧库，再执行正式导入。旧库只读；不要用整个旧 `queue.db` 覆盖当前项目数据库。

```powershell
npm run knowledge:migrate -- --source-db 'C:\Users\HMCD-0005\Desktop\小红书\xhs-openclaw-pipeline\data\queue.db'
# 审核 DRY_RUN 输出后，导入当前 CONTROL_PLANE_URL 指向的中心：
npm run knowledge:migrate -- --source-db 'C:\Users\HMCD-0005\Desktop\小红书\xhs-openclaw-pipeline\data\queue.db' --apply
```

独立 SQLite 模式明确指定目标：

```powershell
npm run knowledge:migrate -- --source-db '旧库绝对路径' --target-db 'data/queue.db' --apply
```

写入已有 SQLite 目标前自动产生 `queue.db.backup-时间戳` 在线备份。迁移按源路径和源记录 ID 记账，重复运行跳过已迁入项，不覆盖迁入后的人工作业。移动源文件时可传入首次输出的 `--source-key` 保持身份。中心导入使用事务锁处理重复请求；中途失败后可重跑同一命令。

专用导入命令面向本次旧文案库（视觉知识／参考图片均为 0）。若检测到视觉数据会明确拒绝，避免遗漏图片；包含视觉版本的全模块搬迁使用现有 `control-plane:migrate-local` 流程。本次也修正了该流程跳过无 `versions` 文案、只取前 100 条文案及漏迁常用 Prompt 的问题；该全模块流程仍会追加提示词和视觉版本，不应重复执行 `--apply`。

## 本次验证

- 旧库只读预检：98 条文案、61 个标签、1 条常用 Prompt、0 条视觉知识、0 张参考图片。
- 独立预览库：`data/knowledge-preview/queue.db`；正式本地库和远端数据均未导入。
- Chrome 已验证 98 条记录展示、Prompt 载入、标签筛选和编辑保存；桌面与 390px 窄屏检查通过，浏览器无 error 日志。
- 根项目 580 项测试通过；新增中心知识库 12 项测试通过；类型检查和生产构建通过。
- 全量中心测试另有 3 项 `image-resume.test.mjs` 失败，涉及工作区原有的图片断点续跑改动，与本次知识库功能分开处理。

远端正式启用前需要完成上述中心更新和数据导入。预览页的成功不表示远端已部署。
