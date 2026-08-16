# Implementation Plan: 小红书内容生产管理后台 v0.2

## Overview

把现有单条 CLI 管线扩展为本机管理后台，按“领域数据 -> Excel 批次 -> 审核修订 -> Web 页面 -> Worker 集成”的依赖顺序纵向交付。每个切片都必须保持旧 CLI 与 Mock 冒烟可用。

## Architecture Decisions

- 第一版采用 Next.js BFF + SQLite + 本地文件存储，默认只监听 `127.0.0.1`。
- Web 请求只创建或修改任务，不同步等待 OpenClaw；Worker 独立领取任务。
- 提示词发布版本不可变，任务固定版本与哈希；修订内容和图片永不覆盖原件。
- Excel 先进入 staging 批次，预览后显式提交；提交幂等。
- 图片能力通过适配器暴露 `generateImage` 与 `editImage`，保留以后切换 API/ComfyUI 的边界。

## Dependency Graph

```text
管理数据库/契约
  ├─ 提示词版本
  ├─ Excel staging/提交
  ├─ 任务审核与素材谱系
  │    └─ Worker 提示词/参考图集成
  └─ REST Route Handlers
       └─ Next.js 管理页面
            └─ 浏览器端到端验证
```

## Task List

### Phase 1: Foundation

- [ ] Task 1: 管理数据库、提示词版本与统一领域契约。
- [ ] Task 2: Excel 解析、预览和幂等提交。

### Checkpoint: Foundation

- [ ] 新领域测试与全部旧测试通过；1000 行导入测试通过。

### Phase 2: Review and Assets

- [ ] Task 3: 文本修订、审核状态和审计记录。
- [ ] Task 4: 参考图上传、图片谱系和确定性图片修订。

### Checkpoint: Review

- [ ] 一个任务可经历导入、生成、修改、退回和通过，历史不丢失。

### Phase 3: Web Console

- [ ] Task 5: Next.js 外壳、导航、仪表盘和任务分页。
- [ ] Task 6: Excel 导入页与提示词工作台。
- [ ] Task 7: 任务审核页、参考图和图片编辑操作。

### Checkpoint: Web

- [ ] 构建通过，后台在 320/768/1440 宽度可用，控制台无错误。

### Phase 4: Worker Integration

- [ ] Task 8: 提示词快照、图片数量和参考图进入生产管线。
- [ ] Task 9: OpenClaw 图生图/编辑适配与连续消费命令。

### Checkpoint: Complete

- [ ] 全量测试、构建、Mock Excel 到审核流程和浏览器验证通过。
- [ ] 安全扫描、秘密扫描和五轴代码审查无阻断问题。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Next.js 与同步 `node:sqlite` 打包边界 | 高 | 数据访问保留在 Node runtime server modules，先做最小构建冒烟 |
| Excel 恶意或超大压缩包 | 高 | 5 MiB/5000 行/首表限制，超限立即拒绝 |
| Web 与 Worker 并发写 SQLite | 中 | WAL、短事务、5 秒 busy timeout、幂等状态更新 |
| 提示词改动污染在途任务 | 高 | 任务固定版本 ID、内容和 SHA-256 快照 |
| 图片上传伪造 MIME 或路径穿越 | 高 | 随机/数据库 ID 文件名、Sharp 解码、尺寸/大小限制 |
| OAuth 无法承担目标规模 | 高 | Mock 完成产品验收；真实生产切换 API 凭据并加预算熔断 |

## Open Questions

- 无阻断问题；v0.3 再确认多用户认证、远程部署和自动发布。
