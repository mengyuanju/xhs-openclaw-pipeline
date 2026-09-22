# 账号文案抽检比例升级验证

日期：2026-09-22。实现依据：[升级设计](account-copy-sampling-rate-upgrade-design.md)。

## 已完成

- 迁移 `0084_account_copy_sampling_rate`：账号可空覆盖值、独立配置审计、冻结来源与账号版本。
- 用户管理支持继承/单独配置，生产配置标明默认比例，列表显示配置来源和全局关闭状态。
- 按最终人工通过账号解析有效比例，余数、普通冻结、强制复检和盲评边界继续沿用现有流程。
- 管理员抽检详情显示冻结比例、来源、时间和版本；登录、个人资料及非管理员抽检 DTO 不新增比例策略字段。
- 用户写入字段区分缺省、`null`、`0`，沿用版本冲突检查，不因仅修改比例轮换登录凭据。
- 页面与 Web 代理校验中心 `copySamplingVersion >= 2`，防止旧中心忽略新增字段。

## 通过的验证

| 验证 | 结果 |
| --- | --- |
| `npm test` | 1355 通过，15 跳过，0 失败（浏览器测试随后单独开启执行） |
| `npm --prefix server test` | 684 通过，33 跳过，0 失败 |
| `npm run typecheck` | 通过 |
| 生产构建 | `XHS_NEXT_DIST_DIR=.codex_artifacts/account-copy-sampling-build npm run build` 通过；生成的临时类型路径已从项目配置恢复 |
| 新账号策略单元测试与盲评 DTO 测试 | 14 项通过 |
| `RUN_POSTGRES_E2E=1 node --test server/tests/account-copy-sampling-postgres.test.mjs` | 独立临时 PostgreSQL 18 + 真实中心 HTTP，主测试及 5 个子测试通过 |
| `RUN_ACCOUNT_SAMPLING_BROWSER=1 node --test tests/account-copy-sampling-browser.test.mjs` | Edge 无头浏览器真实交互通过 |

数据库验收覆盖：迁移重复执行、旧账号继承、旧客户端省略字段保留值、显式零和清空、审计操作者取已验证会话、非法输入、非管理员拒绝、版本冲突、登录凭据不变、同批账号 50% 与默认 20% 分别冻结、冻结历史不变、未冻结稿采用新值、跨比例余数继承、0% 尾批与超时保底、删除账号后的全局兜底、管理员策略追溯、盲评隐藏及全局关闭时仍强制复检。

浏览器验收覆盖：继承 → 单独 0% → 恢复继承、全局关闭状态、旧中心无法编辑比例且普通资料保存不发送新字段、版本冲突保留弹窗、390px 手机布局以及页面无 JavaScript 异常。

全部测试使用假文案或本地临时数据库，不调用模型、不消耗模型额度；未部署、未迁移生产数据库。

## 已确认的既有失败

额外执行 `RUN_POSTGRES_E2E=1 node --test server/tests/copy-quality-flow.test.mjs` 时，其第 286 行的旧图片版本继承场景抛出 `invalid copy-QA revision inheritance`（SQLSTATE 23514）。将未修改的 HEAD 源码提取到独立目录后复跑，得到相同位置和错误，确认不是账号比例升级引入。该场景涉及 0078/0079 的版本继承触发器，本次没有修改这些迁移或放宽门禁。

工作区存在其他并行修改，本次保留其改动；上述构建和全量测试基于运行时工作区状态。
