# 图文生成规则接入说明

## 来源

工作区文档 `../../图文生成统一系统提示词_原始文档溯源版.md` 保存三份原始 PDF 的逐条章节、页码和规则编号映射，是规则溯源来源。运行提示词只保留执行需要的规则正文，不携带 `[Rxxx]` 编号标签。

## 运行分层

- `prompts/post.md`：不可信 Query 包装和 JSON 输出契约。
- `prompts/text-system.md`：准入后的文本、来源、图文规划和安全规则。
- `prompts/image-system.md`：图片生成规则。
- `prompts/image-edit-system.md`：图片编辑规则。
- `src/post-contract.mjs`：零 emoji、标题长度、类型和字段契约。
- `src/qc.mjs`：可机械验证的质量门；语义、构图、版权和站内重复仍需人工终审。

## 版本行为

提示词以不可变版本发布，任务提交时固定版本 ID、内容和 SHA-256。运行 `npm run prompts:install-rules` 会安装或重新发布与仓库提示词内容哈希一致的版本；重复执行不会新增版本，也不会改变现有任务快照。
