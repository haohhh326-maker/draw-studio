# SaveVideo 节点 92 兼容修复

已修复本地画布中“节点 SaveVideo 动态选项 format.codec 没有唯一分支”的解析错误，生产构建已更新，页面已重新加载。

## 原因与修改

MiniMax H3 工作流的 SaveVideo 节点 92 保存的是独立的 `format: "auto"`、`codec: "auto"`。当前已保存的 ComfyUI 节点定义把编码选项放入 `format.codec`，同时保留隐藏的旧版 `codec` 兼容输入。此前解析器错误地强制要求嵌套字段，也会展开未填写的可选动态选项。

- `src/workflow/import-editor.ts`：只有实际节点定义明确保留隐藏兼容字段，且旧值在兼容字段和当前容器中都具有唯一分支时，才接受旧版 codec。不会猜测编码或改写工作流输入。
- `tests/workflow-import-save-video.test.ts`：19 项回归，涵盖旧版、嵌套格式、编码参数、优先级、编辑器转换和生成前校验。
- `tests/fixtures/save-video-dynamic.object-info.json`：已有云端节点定义快照。

未填写的可选动态选项不再强制展开。无效 codec、重复分支、不兼容容器及缺少选择值的子参数仍明确报错。

## 验证

- SaveVideo 19 项测试通过；包含原始执行、通用导入和生成前校验的本轮 4 个测试套件共 98 项全部通过。
- 更广的 12 个导入测试套件此前为 186 项通过、1 项跳过；这些数量存在重叠，不合计。
- 已保存的云端工作流副本中，24 个工作流、24 个 SaveVideo 节点均解析成功，没有缺失必填项或改写输入。
- TypeScript 与 Vite 生产构建通过，只有现有的大文件分块提示。
- 本地页面已加载新版。视频节点保留此前的失败记录及用户提示词；本次未再次执行视频生成。

## 当前运行限制

当前小云朵保存的 AutoDL ComfyUI 与对应 Jupyter 地址均返回 HTTP 404，因此没有进行在线视频生成或修复后 GPU 提示词优化验收。恢复实例后可直接重试；无需为此错误重新填写 codec 或更改节点连线。

此前优化超时的后续排查记录见 `COMFY-OPTIMIZER-DEPENDENCIES-20261005.md`。CPU 视觉推理曾真实成功但耗时 436 秒；已保存 CUDA 运行库预加载修复，GPU 实际耗时仍需在实例恢复后确认。
