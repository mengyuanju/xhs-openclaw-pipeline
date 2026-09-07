# 页面控件组件化

本轮检查覆盖 `app/**/*.tsx`。将 73 个页面及展示文件中直接使用的 13 个下拉框、83 个输入控件、33 个多行输入框、198 个按钮、39 个折叠详情和 3 个进度条接入共享组件。现有 Radix 下拉框和确认弹窗继续复用。

## 组件与行为

| 场景 | 组件 | 保留或增加的行为 |
| --- | --- | --- |
| 下拉选择 | `components/ui/select.tsx` | Radix 菜单、方向键、禁用项、表单字段、重置、弹窗内选择；统计筛选的“全部”仍映射为空筛选值 |
| 文本、数字、密码、文件输入 | `Input`、`Textarea` | 统一样式，保留字段名称、校验、自动填充、只读与禁用状态 |
| 搜索 | `SearchInput` | 搜索图标、清除按钮、清除后恢复焦点；受控筛选和 GET 表单均可使用 |
| 复选、单选、开关、滑杆 | `Checkbox`、`Radio`、`Switch`、`Slider` | 组件绘制外观，保留键盘、标签、FormData 和 fieldset 禁用语义 |
| 日期 | `DatePicker` | 日期输入、组件日历、月份切换、方向键选日、日期校验、清除、今天、Escape 关闭 |
| 颜色 | `ColorPicker` | 常用色与十六进制输入；不完整颜色只留在输入草稿，不覆盖当前有效颜色 |
| 折叠详情 | `Disclosure`、`DisclosureTrigger`、`DisclosureContent` | 展开状态、键盘操作、嵌套详情、折叠保留编辑内容；模型链路仍在展开后才请求数据 |
| 进度 | `Progress` | 实际完成值与不确定进度，向辅助技术提供进度语义 |
| 按钮 | `Button` | 共用属性透传与 Slot；已有页面用 `unstyled` 保留原有按钮、标签页和图标按钮样式 |

样式集中在 `components/ui/controls.css`，使用项目已有主题变量。原有页面 CSS 的下拉框、折叠触发器及展开状态选择器已同步调整。

表单基础组件保留语义 HTML。Radix 用于表单提交的隐藏 select，以及文件上传调用的系统文件选择器，属于底层表单和系统能力；页面不再展示浏览器原生下拉、日期或颜色弹出界面。

## 后续页面开发

- 表单从 `components/ui/input` 导入相应控件；搜索从 `components/ui/search-input` 导入，并使用 `onValueChange`。
- 选择框使用现有 Select 组合，显式提供初始值。Radix 选项不能使用空字符串；“全部”应使用明确标记，在回调中恢复业务筛选值。
- 折叠区域组合 Trigger 和 Content；受控展开用 `open` / `onOpenChange`，初次默认展开用 `defaultOpen`。
- 不在 `app` 页面重新添加原生 select、details、progress 或浏览器 alert / confirm / prompt。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- `node scripts/test-ui-controls.mjs`

浏览器脚本复制真实控件、提示词工作台、用户编辑器和模型链路组件到隔离的 Next 测试站点。API 返回固定数据，不连接生产后台，也不调用模型。检查搜索、表单提交与重置、禁用状态、键盘导航、日期和颜色、嵌套详情、弹窗选择、提示词联动、按需加载、进度、320 / 768 / 1024 / 1440 像素视口与运行时错误。

脚本默认使用本机 Playwright；Windows 使用 Edge。可用 `PLAYWRIGHT_MODULE` 指定 Playwright 的模块路径。结果与截图保存在 `.codex_artifacts/ui-controls-regression/`，`--serve` 可保持隔离预览站点运行。
