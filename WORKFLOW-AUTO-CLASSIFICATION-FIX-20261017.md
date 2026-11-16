# 新导入工作流自动分类修复 · 2026-10-17

用户反馈：导入新工作流后没有自动归入模型系列。

已确认两个直接原因：分类器只读取直接 model 端口，漏掉真实工作流中的 guider→model、sampler_inputs→settings→model 等模型载体；保存阶段又把先前自动生成的“视频生成／图像生成”等粗分类当作手动分类保留，之后无法升级。

现已补齐这些主模型证据路径和 GGUF 模型字段。不会把提示词、文件标题、条件图、latent 或 image_embeds 当成主模型证据。新导入与旧自动粗分类的重新读取使用相同判断，明确的自定义系列和厂商分类仍保留。另统一 Klein图像／Klein 系列、视频超分／视频超分工具等已确认的同义名称。

修改文件：

- src/workflow/import-classification.ts
- src/workflow/import-category.ts
- src/workflow/automatic-import-client.ts
- src/workflow/directory-view.ts
- tests/workflow-import-classification.test.ts
- tests/workflow-import-category-cache.test.ts
- tests/workflow-library-reader.test.ts
- tests/directory-view.test.ts

验证：

- 用户原始 H3 V3 编辑器 JSON 经过准备导入→临时目录保存→重新读取，三阶段均归为 MiniMax H3 标准。
- 真实 Klein 文生图、LTX MSR、Scail 动作迁移的 API 图经过相同链路，分别归入 Klein 系列、LTX2.3、Scail；均保存成功且执行图可读。这里验证导入和分类，不是运行生成任务。
- 原始 JSON、真实库文件、节点连接和权重保持原样；原始 H3 V3 SHA256 前后相同。临时目录已清理。
- 实际本地服务扫描 78 项并注册 78 项，V3 已从“视频生成”归入“MiniMax H3 标准”。浏览器实际列表已确认并截图。
- TypeScript、生产构建通过；全量测试 81 个文件通过，1239 项通过、3 项原条件跳过。

详细核验：.cache/workflow-auto-classification-verification-20261017.json。
本地画布服务已更新，仍使用 http://127.0.0.1:1420/。已有自动粗分类在读取目录时重新判断，不需要为这次修复重新配置云端。未运行图像/视频生成，未修改画布中当前选中节点的工作流或提示词。

![V3 已归入 H3 标准](.cache/workflow-auto-classification-fixed-20261017.png)
