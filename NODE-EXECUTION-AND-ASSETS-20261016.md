# 节点执行状态、报错与资产库

## 行为

- 点击生成后，卡片依次显示素材上传、提交、排队、实际 ComfyUI 执行节点及结果保存状态。执行时显示海水流动动画；动画只表示正在工作，进度数值只来自服务器。
- 节点名称和类名取自实际提交的执行图及 ComfyUI 事件，保留节点 ID。支持 `executing`、`progress`、`progress_state`、`execution_cached`、`executed`，按 prompt_id 隔离任务。
- ComfyUI 原始执行异常和输入校验错误显示在卡片内，详情保留原始错误数据及 traceback。生成面板里原先重复的 `Aborted / 高级详情` 错误块已移除。主动取消显示普通取消状态。
- 浏览器配置了优化器令牌时仍尝试标准 ComfyUI WebSocket，不把令牌放入 URL 或子协议。服务端要求 WebSocket 额外认证而拒绝时，仍以已有认证 HTTP 查询队列和历史；没有实时节点数据时不编造步骤。
- 更换种子会清除相应节点的旧图、文本和旧任务展示；开始新任务也会清空旧展示。旧结果仍保存在任务历史中；执行中或等待恢复的任务保持原关联。
- 生成结果保留在项目内供预览、连线、历史和导出使用，但不自动出现在资产库。右键结果选择“添加到资产库”后入库。旧项目的生成结果兼容此规则；导入素材仍默认入库，裁切继承来源归属。
- 节点和空白画布的右键菜单支持点击外部、Escape、切换画布关闭，多个菜单互斥。

## 验证

实际云端以 `EmptyImage(16×16) → PreviewImage` 完成两次 CPU 流程验证，收到了真正的执行节点事件；无生成模型推理。故意提交 width=0 的独立请求被 ComfyUI 原样拒绝，保留了错误类型、节点和原始 JSON；没有改动用户项目或取消其他任务。

结果文件：`.cache/node-execution-live-result-20261016.json`。

最终测试：78 个测试文件全部通过，1,135 项通过，3 项因本地样本缺失跳过。TypeScript 与 Vite 生产构建通过，保留现有分块大小提示。

真实画布已验证：空提示词错误出现在节点内，生成面板不再重复显示错误；视频结果右键包含“添加到资产库”；节点菜单和空白画布菜单都能点击外部关闭，Escape 也可关闭。截图为 `.cache/node-card-errors-20261016.png`。空提示词测试反馈已清理，未改变原有提示词与种子。

浏览器小云朵实际检测结果为“支持实时进度 · 0.38.1 · 排队 0”，确认配置了现有优化器认证后仍能使用 ComfyUI 实时通道。交互验收记录：`.cache/node-ui-verification-20261016.json`。

## 主要文件

- `src/comfyui/client.ts`、`src/types/index.ts`：真实事件、原始错误和执行状态。
- `src/generation/pipeline.ts`、`GenerationPanel.tsx`：提交图映射、卡片反馈、移除重复错误块。
- `src/nodes/MediaNode.tsx`、`NodeExecutionView.tsx`、`media-node.css`：卡片、海水动画、素材菜单。
- `src/canvas/CanvasView.tsx`、`context-menu-events.ts`：菜单关闭与互斥。
- `src/stores/store.ts`、`generation-result.ts`：种子变化和任务切换清理。
- `src/assets/AssetLibrary.tsx`、`library-membership.ts`、`src/nodes/image-crop-actions.ts`：手动入库和归属。
- 对应执行事件、任务生命周期、节点显示、资产归属和裁切回归测试。

## 使用

本地页面为 http://127.0.0.1:1420/ 。需要手动启动时，在项目目录运行 `node scripts/start.cjs --no-open`。

选择工作流并点击生成，观察节点卡片上的当前 ComfyUI 节点和步数。修改种子后旧结果应立即离开卡片。生成完成后右键结果，选择“添加到资产库”；点击空白处应关闭菜单。

按 [ComfyUI 执行事件源码](https://github.com/comfyanonymous/ComfyUI/blob/master/execution.py) 与 [进度事件源码](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_execution/progress.py) 对接。界面不能显示服务端没有发送的数据；认证服务拒绝实时通道时，HTTP 回退只显示真实可确认的队列和历史状态。
