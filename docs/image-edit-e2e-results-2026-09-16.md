# 图片编辑真实端到端测试结果（2026-09-16）

## 结论

当前实现已通过真实图片模型、真实视觉模型、真实 PostgreSQL、远程执行机协议和浏览器交互验证。测试未触发发布。

实体替换不是把参考图直接贴到原图上。图片模型接收源图、真实产品参考图和目标蒙版，生成符合原图透视、光照、支撑关系的替换结果；程序随后逐像素恢复蒙版外内容。多物品场景依靠“目标文字描述 + 人工框选 + 视觉预检”选定唯一物品，不会按物品类别批量替换。

自然语言局部修改会先由视觉模型定位唯一目标并生成运行时蒙版，再进行模型编辑和像素保护。文字标识固定使用白色无衬线文字、`#111827` 实心圆角底框和右下安全区，以避免不同页面出现不同文字类型或底框颜色。

## 真实输入与操作

| 操作 | 真实输入 | 指令 | 结果 |
| --- | --- | --- | --- |
| 人工生成标识 | 1086×1448 页面图 | 添加“AI生成”到右下角 | 1 次图片生成成功；白字、深色圆角底；其他区域保持不变 |
| 多物品实体替换 | 三栏咖啡收纳页面 + CC0 红色马克杯实拍参考 | 替换前景木杯垫上的唯一米白色大马克杯 | 1 次图片生成成功；只替换目标杯，同图其他杯子和文字不变 |
| 自然语言修改 | 上一步实体替换结果 | 只把中间栏黑色手冲壶壶身改为浅鼠尾草绿 | 1 次图片生成成功；壶盖、壶嘴、手柄、周围器具和文字不变 |

## 像素与视觉证据

| 阶段 | 实际变化像素 | 实际变化边界 | 蒙版外变化 | 视觉模型结论 |
| --- | ---: | --- | ---: | --- |
| 文字标识 | 18,357 | `x=834, y=1322, w=215, h=88` | 0 | 文字、位置、样式通过 |
| 实体替换 | 38,985 | `x=420, y=1280, w=235, h=168` | 0 | 唯一目标、参考身份、部件拓扑、位置和非目标保真全部通过 |
| 自然语言改色 | 4,847 | `x=558, y=716, w=91, h=82` | 0 | 唯一目标、说明具体、目标完整、文字排除全部通过 |

真实产物：

- 文字：[结果](../output/live-e2e/1789497020088/attempt-1/text-edited.png)
- 多物品源图：[源图](../output/live-e2e/1789499213209/attempt-1/real-multi-object-source.png)
- 实体替换：[结果](../output/live-e2e/1789499213209/attempt-1/real-multi-object-entity-edited.png)
- 自然语言修改：[结果](../output/live-e2e/1789499213209/attempt-1/real-multi-object-prompt-edited.png)
- 结构化证据：[report.json](../output/live-e2e/1789499213209/attempt-1/report.json)

## 问题覆盖矩阵

| 风险 | 验证方式 | 预期行为 |
| --- | --- | --- |
| 同图有多个同类物品 | 多杯子真实页面 | 只修改描述和框选共同指向的一个目标 |
| 缺少目标描述或未框选 | 浏览器交互测试 | 前端禁止提交，服务端也拒绝非法请求 |
| 描述含糊或多个候选 | 假视觉回归 | 图片模型调用前失败，不消耗本次图片生成尝试 |
| 框切断目标或包含竞争物体/文字 | 视觉预检 | 图片模型调用前失败并返回可操作原因 |
| 参考图不可用 | 视觉预检 | 图片模型调用前失败 |
| 模型误改其他物品或文字 | 硬蒙版合成 + 精确像素断言 | 蒙版外变化必须为 0 |
| 替换物不像参考产品 | 生成后独立视觉复核 | 身份、颜色、外形和关键部件不一致则不可采用 |
| 自然语言目标不唯一 | 自动定位预检 | 非付费失败，要求补充位置和外观特征 |
| 自然语言编辑产生全图漂移 | 运行时蒙版 + 变化像素过滤 | 仅保留目标框内有意义的变化，框外恢复原图 |
| 不同页面标识字体/底框漂移 | 固定样式契约 + 视觉检查 | 统一白色无衬线文字和深炭色实心圆角底框 |
| 低对比度光晕或背景漂移 | 变化像素阈值回归 | 丢弃低幅漂移，只保留实际文字和底框 |
| 执行机重复领取、取消后迟到回传、租约过期 | PostgreSQL 生命周期测试 | 单次领取、迟到回传隔离、显式重试且不自动重复收费 |

## 可复测命令

```powershell
$env:RUN_LIVE_WORKFLOW_PAID_E2E='1'
$env:LIVE_E2E_MULTI_OBJECT_SOURCE='C:\path\to\1086x1448-source.png'
$env:LIVE_E2E_PRODUCT_REFERENCE='C:\path\to\real-product-reference.jpg'
node --env-file-if-exists=.env --env-file-if-exists=.env.local --test server/tests/live-workflow-paid.manual.test.mjs
```

无额度测试：

```powershell
node --test tests/current-image-editing.test.mjs tests/executor-agent.test.mjs tests/control-plane-client.test.mjs
$env:RUN_IMAGE_EDIT_BROWSER='1'; node --test tests/current-image-editor-browser.test.mjs
$env:RUN_POSTGRES_E2E='1'; node --test server/tests/image-editing-postgres.test.mjs server/tests/postgres-repository.test.mjs
npm run typecheck
npm test
npm --prefix server test
```

本次结果：核心定向回归 88/88、浏览器 1/1、PostgreSQL 53/53、根项目 1189 通过/3 跳过/0 失败、服务端 587 通过/19 跳过/0 失败、类型检查通过。
