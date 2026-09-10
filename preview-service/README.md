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

## 存储原则

- D1 只保存标题、正文、标签、状态、内容哈希和原图元数据。
- R2 保存上传文件的原始字节；上传链路不压缩、不缩放、不转码。
- 原图对象位于 `previews/{previewId}/originals/`，对象名包含 SHA-256。
- 浏览器读取图片时先检查预览状态。链接撤销后立即停止公开读取，但不删除原图母版。
- 未来如增加缩略图或 Web 优化图，应作为派生缓存单独保存，不能覆盖原图对象。

目前接受 PNG、JPEG、WebP、GIF 和 AVIF。单图不超过 20 MB，单条预览最多 18 张。批量创建一次最多 10 条、合计最多 60 张，整批原图合计不超过 60 MB。

## 对接接口（v1）

创建预览：

```bash
curl -X POST http://localhost:3100/api/v1/previews \
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
- `images`：必填且可重复，必须传文件字节，不能传主系统文件路径、内部资源 ID 或临时 URL。

返回值包含完整 `preview` 记录和 `previewUrl`。主系统后续只需要维护一个很薄的 multipart 上传客户端。

批量创建预览：

```bash
curl -X POST http://localhost:3100/api/v1/previews/batch \
  -F 'manifest={"items":[{"clientId":"item-a","title":"标题 A","body":"正文 A","tags":"标签一,标签二"},{"clientId":"item-b","title":"标题 B","body":"正文 B","tags":"标签三"}]}' \
  -F "images.item-a=@/absolute/path/a.png" \
  -F "images.item-b=@/absolute/path/b-1.png" \
  -F "images.item-b=@/absolute/path/b-2.png"
```

`manifest.items[].clientId` 用于把图片字段关联到对应内容；同一条目的图片字段可重复。服务会先校验整批请求、保存原图，再用一次数据库批处理写入全部元数据。任一条失败时不会生成部分预览记录，并会清理本次已经上传的对象。

查询管理列表：

```text
GET /api/v1/previews
```

撤销公开访问：

```text
POST /api/v1/previews/{previewId}/revoke
```

## 验证

服务运行后执行：

```bash
npm run lint
npm run build
npm run smoke
npm run smoke:batch
```

单条冒烟测试会创建一条“本地闭环验证”记录，逐字节比对上传前后的 SHA-256，然后撤销链接并确认原图接口返回 404。批量冒烟测试还会验证两条内容统一创建、各自公开访问，以及无效批次不会留下部分元数据。

## 上线前边界

当前版本按“仅绑定本机”的阶段实现，没有加入账号系统。部署到公网前必须补充管理端登录和服务到服务的发布令牌；公开预览页保持匿名访问。对象存储桶不应直接公开，图片始终通过状态校验路由读取。

项目已声明独立的 D1 和 R2 绑定（`.openai/hosting.json`），后续部署时替换为正式资源并执行迁移即可，无需改动主系统的数据结构。
