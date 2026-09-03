# 远端控制服务

该目录是可独立安装和部署的 Koa 服务，负责 PostgreSQL 中的任务、执行记录、审核、提示词、知识库和生产配置，以及服务器本地图片文件。它不运行 OpenClaw，也不保存执行机模型凭据。

## 安装与启动

要求 Node.js 24.19.x 和 PostgreSQL。先创建数据库与账号，再执行：

```powershell
cd server
npm install
Copy-Item .env.example .env
# 编辑 .env 中的 DATABASE_URL
npm run init
npm start
```

Linux/macOS 将 `Copy-Item` 换成 `cp .env.example .env`。`npm run init` 可重复执行，首次运行会建表并安装默认生产配置和提示词。

默认监听 `127.0.0.1:4310`。需要局域网执行机访问时，把 `CONTROL_PLANE_HOST` 改为 `0.0.0.0`，并用防火墙仅允许可信内网网段。当前版本没有 TLS 和节点身份认证，不能直接暴露到公网。

## 验证

```powershell
npm test
Invoke-RestMethod http://127.0.0.1:4310/health
```

业务代码、数据库 schema、默认提示词、测试和依赖锁文件均在本目录内；部署中心服务时不需要安装根目录执行机依赖。
