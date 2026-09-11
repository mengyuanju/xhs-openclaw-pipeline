# 浮光 · 独立预览服务

一个与主业务系统隔离的图片文案预览服务。上传原始图片和文案后，服务会生成 `/preview?noteId={publicId}` 形式的可分享页面；旧的 `/p/{publicId}` 地址继续兼容已有链接。

## 本地运行

```bash
npm install
npm run db:local
npm run dev -- --host 127.0.0.1 --port 3100
```

打开 `http://localhost:3100/`。本地数据保存在项目自身的 `.wrangler/` 目录中，不访问上级项目的数据库、任务目录或凭据。

首次拉取代码或新增数据库迁移后运行一次 `npm run db:local`。日常启动只需运行 `npm run dev -- --host 127.0.0.1 --port 3100`。

### 管理员登录

运行 `npm run auth:generate -- admin` 生成管理员账号、一次性密码和密码哈希。将账号和密码哈希写入本地 `.dev.vars`：

```dotenv
ADMIN_USERNAME="admin"
ADMIN_PASSWORD_HASH="pbkdf2_sha256$..."
```

`.dev.vars` 已被忽略，不能提交到 Git。正式部署时把这两个值配置为运行环境 Secret，不要把明文密码或密码哈希写入源码。

## 存储原则

- D1 只保存标题、正文、标签、状态、内容哈希和原图元数据。
- R2 保存上传文件的原始字节；上传链路不压缩、不缩放、不转码。
- 业务代码通过统一对象存储接口执行上传、读取和删除；当前适配器连接 R2，后续接入 OSS 时可保留对象键和业务流程，只替换适配器实现。
- 原图对象位于 `previews/{previewId}/originals/`，对象名包含 SHA-256。
- 浏览器读取图片时先检查预览状态。链接撤销后立即停止公开读取，但不删除原图母版。
- 未来如增加缩略图或 Web 优化图，应作为派生缓存单独保存，不能覆盖原图对象。

目前接受 PNG、JPEG、WebP、GIF 和 AVIF。单图不超过 20 MB，单条预览最多 18 张。批量创建一次最多 10 条、合计最多 60 张，整批原图合计不超过 60 MB。

## 对接接口（v1）

创建预览：

```bash
curl -X POST http://localhost:3100/api/v1/previews \
  -H "Authorization: Bearer $PREVIEW_API_KEY" \
  -F "sourceRef=xhs:delivery:123" \
  -F "title=标题" \
  -F "body=正文" \
  -F "tags=标签一,标签二" \
  -F "images=@/absolute/path/image-1.png" \
  -F "images=@/absolute/path/image-2.png"
```

字段约定：

- `title`：必填，最多 100 个字符。
- `body`：可选，最多 30,000 个字符，按纯文本展示并保留换行。
- `tags`：可选，以逗号、换行或 `#` 分隔。
- `sourceRef`：可选的调用方幂等键，最多 200 个字符，可使用字母、数字及 `:._-`。同一个 `sourceRef` 重传完全相同的文案和原图时返回已有预览并标记 `reused: true`；内容不同或已有预览已撤销时返回 `409`，不会覆盖原记录。
- `images`：必填且可重复，必须传文件字节，不能传主系统文件路径、内部资源 ID 或临时 URL。

返回值包含完整 `preview` 记录和 `previewUrl`。主系统后续只需要维护一个很薄的 multipart 上传客户端。

批量创建预览：

```bash
curl -X POST http://localhost:3100/api/v1/previews/batch \
  -H "Authorization: Bearer $PREVIEW_API_KEY" \
  -F 'manifest={"items":[{"clientId":"item-a","sourceRef":"xhs:delivery:123","title":"标题 A","body":"正文 A","tags":"标签一,标签二"},{"clientId":"item-b","sourceRef":"xhs:delivery:124","title":"标题 B","body":"正文 B","tags":"标签三"}]}' \
  -F "images.item-a=@/absolute/path/a.png" \
  -F "images.item-b=@/absolute/path/b-1.png" \
  -F "images.item-b=@/absolute/path/b-2.png"
```

`manifest.items[].clientId` 用于把图片字段关联到对应内容；同一条目的图片字段可重复。`manifest.items[].sourceRef` 为可选幂等键，同一批内不能重复。服务会先校验整批请求、保存原图，再用一次数据库批处理写入全部元数据。任一条失败时不会生成部分预览记录，并会清理本次已经上传的对象。返回的每一项都包含 `reused`。主交付系统持久化 `preview.id`、`preview.publicId`（即 noteId）和 `preview.contentHash`，公开链接由当前预览服务域名与 noteId 动态生成；不要要求两套数据库使用同一个主键。

查询管理列表：

```text
GET /api/v1/previews
Authorization: Bearer <API_KEY>
```

撤销公开访问：

```text
POST /api/v1/previews/{previewId}/revoke
Authorization: Bearer <API_KEY>
```

登录管理端后可在“接口密钥”中创建密钥并选择创建、读取和撤销权限。密钥只显示一次，服务端仅保存其 SHA-256 哈希；主系统应把明文密钥放在自己的服务器 Secret 中。管理页面使用登录 Session，不会把 API 密钥发送到浏览器上传代码中。

## 验证

服务运行后执行：

```bash
npm run lint
npm run build
npm run smoke
npm run smoke:batch
```

单条冒烟测试会创建一条“本地闭环验证”记录，逐字节比对上传前后的 SHA-256，然后撤销链接并确认原图接口返回 404。批量冒烟测试还会验证两条内容统一创建、相同 `sourceRef` 重试复用原记录、各自公开访问，以及无效批次不会留下部分元数据。

## 安全边界

- 首页及管理接口需要管理员登录，Session 使用 HttpOnly、SameSite Cookie；HTTPS 部署时同时启用 Secure。
- `/api/v1/*` 只接受带有相应权限的 Bearer API Key，并按密钥限流。
- 登录失败会记录并触发临时锁定，登录、密钥和预览写操作会留下审计记录。
- 公开预览页保持匿名访问；对象存储桶不直接公开，图片始终通过状态校验路由读取。

项目已声明独立的 D1 和 R2 绑定（`.openai/hosting.json`），后续部署时替换为正式资源并执行迁移即可。与主交付系统的绑定通过主系统独立的增量迁移完成，预览服务不会直接访问主系统数据库。
