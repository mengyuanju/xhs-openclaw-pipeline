# Query 与图片规划配置

## 已确认范围

- Query 仅按换行分条；逗号保留，空行忽略，重复、100 条及单条 500 字限制不变。
- 配置页提供页面类型、视觉布局两页签；名称、描述、启停、排序可编辑，支持新增。布局关联适用页面类型，区域控件放在高级设置。
- 配置中的描述参与规划与生图，生成记录展示实际类型和布局名称、描述。
- 每次生成固定配置与所选项；后续编辑不改变旧结果或恢复中的生成。
- 原目录正在运行 Next 开发服务及执行器。本功能仅在独立 worktree 开发、测试；不改原目录源码、环境配置、数据库、构建产物或服务进程，不部署。

## 数据与兼容

`production.planningCatalog = { version: 1, pageTypes, layouts }` 为可选字段。缺失时使用内置目录加旧 `layoutPresets`，保持原有默认行为。配置页首次保存才写入完整目录；无数据库迁移。

页面类型为 `{ id, name, description, baseKind, enabled }`。`id` 是稳定标识；现有六种基础结构保留用于旧数据、首图位置与文字数量校验，自定义业务类型默认使用细节基础结构，可在高级设置调整。模型返回 `pageTypeId`，程序根据冻结的目录解析 `kind`，附上经过校验的 `pageType` 名称/描述快照，绝不信任模型自填描述。

布局为 `{ id, name, description, kind, enabled, layout }`，`kind` 关联一个页面类型或 `all`。内置布局使用现有 TEMPLATE，自定义布局使用 CUSTOM；随机选择仅在启用且适用项中进行，保存 `layoutPreset` 快照。页面类型禁用影响后续模型选择；旧页面可继续使用自己的类型快照。禁止保存没有启用封面类型/内容类型、或启用类型没有可用布局的目录。

配置描述始终为不可信设计数据，JSON 转义后交给模型；不能修改正文、增加事实或执行操作。历史页面无新增字段仍按原约定处理。

## 实现顺序

1. Query 回归测试与输入提示。
2. 纯目录校验、兼容默认值、快照和随机布局单元测试。
3. 配置持久化、生成提示词和输出校验、执行器及恢复接线。
4. 配置编辑器、规划选择与详情展示。
5. 假模型集成测试、类型检查、隔离构建和浏览器检查。

## 工程与验证

- Node.js 24 ESM、Next.js/React、node:test，使用现有 UI 组件及命名导出。
- 共享纯合同放在 `server/src/planning-catalog.mjs`；生成接线在 `src/`；页面在 `app/`；测试在 `tests/`、`server/tests/`。
- `node --test tests/query-batch.test.mjs tests/planning-catalog.test.mjs`
- `npm test -- --test-concurrency=2`（实际全量运行使用 Node 显式并发参数）。
- `npm run typecheck`、`npm run build` 只在隔离目录运行。
- 测试使用临时数据库和 fake client，不运行正式 worker，不消费模型额度。
