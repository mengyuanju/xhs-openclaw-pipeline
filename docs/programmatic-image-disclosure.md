# 程序生成 AI 标识

程序标识使用受控 SVG 与 Sharp，把人工生成标识放在 1086×1448 图片右下角。任务图片编辑、批量标识、草稿提交、人工重试和独立上传图片编辑使用同一条中心程序处理通道。

## 独立队列与执行

请求仍保存在 `image_edit_requests`，`operation=SVG_DISCLOSURE` 构成独立逻辑队列。中心程序领取器只领取这一类请求，图片执行机领取器排除它。程序处理不占用 `IMAGE` 模型容量、Codex 许可或执行机名额，新的程序执行记录保持 `execution_id=NULL`。

创建、批量提交、提交草稿或重试的事务提交成功后立即唤醒程序领取器。默认运行方式是中心 `serve` 自动启动一个独立 Node.js 子进程，图片合成和逐像素校验在子进程中执行，中心 API 继续响应请求。程序进程同时处理 **2 张图片**，每张图片使用 `sharp.concurrency(1)`。

队列保留持久化和故障恢复能力。程序通道有空闲名额时立即开始；同时提交超过 2 张时在程序队列内短暂等待。模型队列的容量和同任务中较早的模型修复不影响程序领取。任务暂停仍阻止领取。

中心通过 IPC 直接唤醒默认子进程，同时发出 PostgreSQL `NOTIFY`；外置进程通过 `LISTEN` 接收同一通知。进程启动时和轻量扫描时会补领遗漏请求。旧的 `QUEUED` 程序请求由新通道接管；已经被远端领取的 `RUNNING` 请求继续原执行，不重复领取。

状态仍使用 `DRAFT → QUEUED → RUNNING → PREVIEW_READY → ACCEPTED / REJECTED`。程序编辑历史将 `QUEUED` 显示为“准备处理”，`RUNNING` 显示为“程序处理中”。预览生成后仍需人工采用，采用流程保留源版本检查和操作审计。

领取采用数据库锁和独立租约，保留取消、源版本和迟到结果保护。程序租约过期后标记 `FAILED`，由用户检查原因后明确重试；不会自动重复执行。程序重试显示“重试程序标识”，无需模型费用确认，也不显示“AI 可能再次收费”。

页面的图片模型费用确认和重试提醒按请求是否调用图片编辑模型判断：`TEXT` 和 `AI_*` 继续使用费用确认，`SVG_DISCLOSURE` 以及历史 `COMPOSITE`、`RESTORE` 重试不显示图片模型计费提示。

## 描边与实心样式

`overlay.badgeVariant` 仅用于程序标识，允许以下值：

| 值 | 页面选项 | 文字与边框 | 底色 |
| --- | --- | --- | --- |
| `outline-pill` | 描边徽章，默认 | 主题色 | 透明 |
| `solid-pill` | 实心徽章，可选 | 黑字或白字；边框为主题色 | 不透明主题色 |

旧请求没有 `badgeVariant` 时使用描边。自动生产图片继续使用原有描边默认。两种样式都保留 20px 字号、600 字重、36px 高、1.5px 边框以及右侧和下侧 24px 边距；宽度根据合规文字长度确定。

主题色按下列顺序选取，每一步都验证为六位十六进制颜色：

1. 本次程序标识请求中的 `overlay.badgeColor`，来源记为 `USER_SELECTED`，颜色用途记为 `custom`。
2. 当前页面已保存的 `aiDisclosureStyle.color`，来源记为 `STORED_IMAGE_STYLE`。
3. 视觉方案中的 `visualStyle.disclosureColor`，或 `visualStyle.colors.disclosure`。
4. 视觉方案有效调色板中的末个强调色。
5. 固定回退色 `#68744A`。

描边的文字与边框使用同一个主题色。实心的底色与边框使用该主题色，文字从纯黑与纯白中选择对比度更高的一种。计算采用 [WCAG 2.2 的相对亮度与对比度公式](https://www.w3.org/TR/WCAG22/#dfn-relative-luminance)，选定组合满足至少 4.5:1 的文字对比度。例如底色 `#6F7D5F` 使用黑字，底色 `#68744A` 使用白字。

自动配色由保存的页面样式和视觉方案确定；用户也可为本次请求明确指定主题色。请求配置保存 `overlay.badgeColor`，合成结果在 `validation.renderer.style` 和 `validation.text.placement.style` 中记录 `variant`、`color`、`colorSource`、`colorRole`、`textColor`、`backgroundColor`、`borderColor`；实心样式额外记录 `contrastRatio`，便于追溯实际采用的配色。

## 自定义配色与取色器

任务图片编辑和独立上传图片编辑均提供“自动配色”和“自定义颜色”。默认保留自动配色；自定义颜色可以通过系统色板或输入 HEX 值选择。描边与实心共用一个主题色：描边修改文字和边框，实心修改底色和边框，实心文字仍自动选择对比度更高的黑色或白色。

`overlay.badgeColor` 仅适用于 `operation=SVG_DISCLOSURE`，是可选字段。自动配色不发送该字段；自定义配色发送严格的六位十六进制色值 `#RRGGBB`，服务端接受大小写并统一保存为大写，例如 `#d78a32` 保存为 `#D78A32`。空值、空串、三位 HEX、带透明度的 HEX、颜色名和任意 CSS 表达式均不允许，非法值在创建请求时即被拒绝，不能进入 SVG。模型标识 `TEXT` 不携带该字段，接口也会拒绝在非程序标识操作中指定它。

请求中的相关字段示例：

```json
{
  "operation": "SVG_DISCLOSURE",
  "overlay": {
    "text": "该人物形象由AI生成",
    "badgeVariant": "solid-pill",
    "badgeColor": "#D78A32"
  }
}
```

同一批次的图片使用相同的自定义主题色。草稿、提交草稿和人工重试继续使用请求中已保存的值；恢复自动配色后，新请求按上述自动配色顺序计算。旧请求不含 `badgeColor`，保持原有自动配色行为。

浏览器支持时还可使用“屏幕取色”，点击后从屏幕中选取一个颜色。根据 [EyeDropper API 规范](https://wicg.github.io/eyedropper-api/)，该功能要求安全上下文，并且 `open()` 必须直接响应用户点击等操作；取色结果为 `sRGBHex`，按相同的 HEX 规则归一化。页面先检查安全上下文及 `EyeDropper` 是否可用；普通非安全 HTTP 页面或不支持该 API 的浏览器仍可使用系统色板和 HEX 输入。用户按 Esc 取消取色时保持此前颜色，不提交请求、不显示失败提示。取色和配色均不调用图片或视觉模型。

## 运行配置

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PROGRAMMATIC_IMAGE_WORKER_MODE` | `process` | `process` 由中心自动启动子进程；`external` 由独立进程或容器运行 |
| `PROGRAMMATIC_IMAGE_CONCURRENCY` | `2` | 程序图片并发；当前允许 `1` 或 `2` |
| `XHS_PRODUCTION_DATABASE_URL` | 使用现有生产配置 | 正式环境数据库；中心与外置进程必须连接同一个库 |
| `XHS_PRODUCTION_STORAGE_ROOT` | 使用现有生产目录 | 正式图片目录；中心与外置进程必须访问同一组文件 |

### 默认独立子进程

在中心进程配置中设置以下值，然后沿用现有中心启动命令：

```dotenv
PROGRAMMATIC_IMAGE_WORKER_MODE=process
PROGRAMMATIC_IMAGE_CONCURRENCY=2
```

```powershell
npm --prefix server run start:production
```

中心负责启动、唤醒和关闭子进程；子进程异常退出时重新启动。无需另开模型执行机或手工运行程序 worker。

### 外置独立进程或容器

将中心配置改为以下值，使中心通过 PostgreSQL 通知外置程序进程：

```dotenv
PROGRAMMATIC_IMAGE_WORKER_MODE=external
PROGRAMMATIC_IMAGE_CONCURRENCY=2
```

在程序进程或容器内配置同一套生产数据库和图片目录，安装中心服务依赖，并执行：

```powershell
npm --prefix server run programmatic-worker:production
```

程序进程需要 Node.js `>=24.19.0 <25`、Sharp 的 SVG/PNG 支持，以及微软雅黑或 Noto Sans CJK SC 等中文字体。服务账号需要读取源图、写入临时目录和结果文件的权限。它不需要 GPU、Codex 登录、模型 API Key 或本地 OCR。

共享存储必须在两个进程中使用与数据库资产路径兼容的相同绝对路径。现有 `assets.storage_path` 保存绝对路径，单独把同一目录挂载到另一个路径不能直接读取旧资产；Windows 路径也不能直接用于 Linux 容器。容器部署前需先核对这一存储条件。本次代码提供外置 worker 启动方式，默认部署仍为独立 Node.js 子进程。

数据库连接信息使用现有未提交的环境配置或进程 Secret，不写入仓库。

## 更新与验证

本次变更更新并重启中心服务和 Web 即可；外置模式同时更新并重启程序 worker。默认子进程随中心更新与重启。不需要更新或重启图片执行机，也不需要新增数据库迁移。历史“程序标识要求执行机版本 8”的说明只适用于旧的远端执行路径。

验收包括：模型图片名额占满时程序请求仍可开始；同时程序执行最多 2 个；描边默认输出兼容；自定义颜色优先于已保存页面色，自动配色及旧请求保持兼容；实心底色与文字对比度正确；非法颜色被拒绝且模型请求不携带程序配色字段；取色取消与无 API 支持时仍可正常配置颜色；图片及视觉模型调用均为 0；标识区域外每个像素不变；取消、源版本变化、租约过期和旧远端运行任务不会产生重复有效结果。
