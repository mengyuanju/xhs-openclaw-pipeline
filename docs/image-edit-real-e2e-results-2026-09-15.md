# 图片生成与图片编辑真实端到端测试结果

日期：2026-09-15<br>
测试任务：`264` / `IMAGE_EDIT_FULL_E2E_20260915`<br>
最终图片运行：`e3908e4f-3e4f-4f85-8680-dc01e259c5c6`<br>
结论：核心真实链路通过；发现并修复 1 个跨页标识兼容缺陷，发现 3 个仍需处理的质量/运维问题。任务停留在 `MANUAL_ARCHIVE`，未发布。

## 1. 本次真实覆盖

| 用例 | 结果 | 真实证据 |
| --- | --- | --- |
| E2E-01 启动、迁移、执行机能力 | 部分通过 | 0057 迁移校验恢复；`haimo1`、`haimo2` 均心跳并声明图片编辑版本 1；`haimo2` 的 Codex 刷新令牌已撤销，详见问题 P0 |
| E2E-02 文案生成 | 通过但有内容缺陷 | `haimo1` 使用 `openai/gpt-5.6-sol` 完成文案、长度修复和 5 页计划；正文虚构第一人称场景，详见问题 P1 |
| E2E-03 五页真实生图 | 通过 | 1 次 `IMAGE`、4 次 `IMAGE_EDIT`，模型均为 `openai/gpt-image-2`；5 页均为 1086×1448 PNG，OCR 和整组质检通过 |
| E2E-04 字体一致性 | 通过 | 独立多图视觉审计：标题字体类别 1，正文字体类别 1，均为 `SANS_SQUARE`；字重体系一致 |
| E2E-05 文字框颜色一致性 | 通过 | 五页主文字框估计为 `#F4ECE2`～`#F5EEE5`；最大 RGB 欧氏距离 3.74，小于预警阈值 40 |
| E2E-06 人工生成标识 | 通过 | 第 1 页资产 443；“该人物形象由AI生成”只出现 1 次，OCR 置信度 0.99，右下角定位通过，原文字全部保留 |
| E2E-07 跨页标识隔离 | 修复后通过 | 初次真实复现第 2 页被错误要求包含“AI生成”；增加页级结果和旧执行器设置兼容后，同一源图通过预检并完成编辑 |
| E2E-08 真实产品融合 | 通过，自动校验有漏检 | 使用 CC0 红色马克杯实拍图。第一次替换对象错误、第二次生成双把手，均人工拒绝；第三次资产 447 的位置、单左把手、白色内壁、颜色、比例和光影通过 |
| E2E-09 自然语言局部修改 | 通过 | 第 3 页资产 448，`localization.mode=PROMPT`；仅右上吊灯灯罩变为鼠尾草绿，全部文字逐字保留 |
| E2E-10 多页重基和采用 | 通过 | 最终资产依次为 443、447、448、441、442；第 4/5 页哈希与初始图一致；第 1 页标识未回退 |
| E2E-11 预览、拒绝、采用、审计 | 通过 | 真实走过 QUEUED、RUNNING、PREVIEW_READY、REJECTED、ACCEPTED；所有 CREATE、EXECUTE、FAILED、retry、PREVIEW_READY、accept/reject 事件可追溯 |
| E2E-12 失败与恢复 | 通过 | 真实令牌故障在图片生成前失败且标记 `billedImageGeneration=false`；两次质量不合格预览均未污染当前图集；取消、非法引用、租约、幂等和上限由 PostgreSQL/浏览器回归覆盖 |

## 2. 最终交付图

稳定副本目录：`output/live-e2e/production-task-264/final-e3908e4f/`

| 页 | 文件 | SHA-256 | 最终变化 |
| --- | --- | --- | --- |
| 1 | `01-hero-ai-label.png` | `7b6922a5a841ef0f9420ea250a0bc1dcd9e6c2ed6dfa2afbd656467c60640bbe` | 右下角人工生成标识 |
| 2 | `02-steps-real-red-mug.png` | `84be1590ea46454c2bc000688820c9803103d6bdb00483128ac102932e71a3ff` | 咖啡机下方真实红杯替换 |
| 3 | `03-comparison-sage-lamp.png` | `9d4deec8ce01e5da3b90adfe24d080266db6a08ae43cbe89d9d12e18b4530f68` | 右上吊灯灯罩鼠尾草绿 |
| 4 | `04-checklist-unchanged.png` | `0fe40e8d6ca6136f08889b3d7bb8bb84fca1363cae0a8b8602f8333c24f19ea7` | 未变化 |
| 5 | `05-summary-unchanged.png` | `4f800c451dd0f571a388494f5797ea444c8bb4771de921ab1ed61022e99a4a75` | 未变化 |

页级标识血缘：第 1 页为 `{type: AI_GENERATED, text: 该人物形象由AI生成}`；第 2～5 页均为 `null`。

真实产品参考图：Wikimedia Commons `My Red magic mug.JPG`，CC0。原始 JPEG SHA-256 为 `daf12988e496d65c66e4b33e836420d634587c8afd9b01dad486e741e34c4346`；上传规范化 PNG 资产 444 的 SHA-256 为 `f02ef8d527223dadda258af7e7ad891d37be441d993dec33054e49d72ed6e318`。参考资产角色为 `REFERENCE`，未进入交付图集。

## 3. 模型调用

任务 264 的数据库追踪：

- `openai/gpt-image-2`：1 次首图 `IMAGE` + 9 次 `IMAGE_EDIT`，全部成功。9 次编辑包含后续 4 页、人工标识 1 次、产品融合 3 次、自然语言局部编辑 1 次。
- `openai/gpt-5.6-sol`：23 次成功视觉检查、1 次失败视觉检查；3 次成功文字调用、1 次失败文字调用。
- `deepseek-v4-pro`：2 次研究检索成功。
- 两次额外套图样式审计均使用真实 `openai/gpt-5.6-sol`，不属于任务 264 的 `model_call_traces`。
- 另行运行的付费基线用例完成 3 次真实图片编辑和 7 次真实视觉校验。

## 4. 发现并处理的问题

### P0：`haimo2` Codex 刷新令牌被撤销（未修复远端凭据）

真实文案调用和真实实体编辑源图预检均复现：`Your access token could not be refreshed because your refresh token was revoked`。图片编辑失败发生在模型生成前，系统正确记录 `SOURCE_SERVICE`、`retryable=true`、`billedImageGeneration=false`，没有产生图片费用。必须在 `haimo2` 主机重新登录 Codex 并重启执行机；修复前应从图片/文案调度池摘除，避免继续领取任务。

### P0：页级人工生成标识被旧执行器扩散到其他页（已修复）

第 1 页采用标识后，第 2 页 `AI_FUSION` 源图被错误要求包含全局默认“AI生成”，导致两次 OCR 假失败。修复包括：

1. 当前渲染器只从目标页不可变血缘继承标识，不再把生产默认值当成源图存在证据。
2. 控制面为版本 1 旧执行器按目标页裁剪 run-level 标识，并在无页级标识时关闭旧的全局推断。
3. 恢复历史图集时也按每页血缘验证标识。

单元测试和 PostgreSQL 全生命周期测试均新增覆盖，真实 `haimo1` 重试通过。

### P1：实体一致性自动校验漏检目标位置和部件拓扑（代码已增强，旧执行器待升级）

第一张产品预览替换了错误的杯子，第二张预览生成了双把手，但旧自动校验均返回 `passed=true`。人工预览门禁正确阻止采用。新代码要求参考图、源图、结果图三方对比，并要求 `referenceIdentity`、`targetLocation`、`singleReplacement`、`partTopology`、`unrelatedContentPreserved` 五项全部为真；远端执行器更新代码后生效。

### P1：生成文案虚构第一人称经历（未修复）

输入没有提供个人经历，但正文生成了“早上我准备冲咖啡时，马克杯、咖啡豆和滤纸散满台面……”以及后续多处“我会”。模型同时错误声明 `fabricatedExperience=false`，现有托管文字审核也判定通过。需要把高置信第一人称场景声明纳入独立复核或要求来源证据，不能只信模型自报字段。

## 5. 回归结果与限制

- 图片编辑核心单元测试：19/19 通过。
- 页级标识单元测试：3/3 通过。
- PostgreSQL 图片编辑全生命周期：12/12 通过。
- 生产链路 PostgreSQL E2E：12/12 通过。
- 图片编辑与图片质检浏览器 E2E：2/2 通过。
- 根项目完整测试：1180 通过、0 失败、3 跳过。
- 控制面完整测试：582 通过、0 失败、19 跳过。
- 生产工作台没有可用登录会话，因此本次生产数据变更由服务层创建，远端执行机通过真实控制面 HTTP 接口领取、心跳、取图、回传校验和结果；表单交互由浏览器自动化用例覆盖，没有声称完成生产 UI 人工点击。
- 测试任务保留在 `MANUAL_ARCHIVE` 供复核；未创建发布记录，未进入发布或排期。

原始和最终套图审计分别保存在：

- `output/live-e2e/production-task-264/style-audit-original.json`
- `output/live-e2e/production-task-264/style-audit-final.json`
