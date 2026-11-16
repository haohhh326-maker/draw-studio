# 工作流自动解析与直接运行

已修复实际解析兼容问题。导入时自动还原已有参数和连接；点击生成不再重新读取节点定义、重新转换文件或请求系统状态探测。服务器仍会在接收执行图时验证自身所需输入。

## 自动修复

- 保存的具名控件快照：核对完整性与可信控件顺序后，恢复参数名、隐藏输入及当前选中的动态分支。
- VideoHelperSuite：按实际格式定义展开 pix_fmt、crf 等参数；迁移明确的旧 force_size 与 save_image 字段。
- 种子后的 fixed 等界面状态与真实输入区分；合法的后继文本不会被吞掉。
- 多层动态选项：逐层使用节点明确声明的默认值；不猜模型、文件、歧义分支或改写作者已有值。
- 同一文件的编辑器元数据：恢复 API 缺失的明确控件值和可选连线，优先保留保存的种子、布尔值与模型名。
- 完整 API 可保留自定义插件及命名输入，画布无需逐个硬编码插件。

不能还原的源文件完整保留。确认缺少插件定义时显示具体节点，不伪造参数；插件提示来自导入时的快照，不作为每次运行的前置检查。

## 实际文件验证

对照旧定义快照及当前云端实际返回的 2598 个节点定义，完整导入以下原文件成功。所有原文件字节保持不变：

| 原文件 | 解析节点数 |
| --- | --- |
| MiniMax - H3 智能一体化视频创作 V3.json | 22 |
| MiniMaxH3-双时钟采样加速Lora.json | 6 |
| 海螺H3视频编辑-人物替换V1+.json | 28 |
| 两份 Qwen Image 2.1 普通工作流 | 各 25 |

另外一份 Qwen API 同样可以导入。解析成功表示已还原执行图，不表示云端已安装所有插件或模型。

V3 已通过运行中的本地画布导入接口实际写入工作流库。保存的 22 节点执行图、原始 source.json 均与转换结果一致，原输入文件未改动。现有目录新增一个 V3 工作流，未修改其他工作流。本次没有提交图片或视频生成。

## 真实依赖与源文件问题

- V3：导入快照未注册 9 类插件（涉及 10 个节点）：ColorCorrect、GoohaiAnyExists、GoohaiMinimaxH3LatentUpscalerGH、GoohaiMinimaxH3TiledSampler、GoohaiUniversalSlider、MiniMaxH3AVDecodeT8GH、MiniMaxH3DualClockT8GH、MiniMaxH3IntegrationAdapterGH、MiniMaxH3IntegrationGH。已保存为独立插件提示，工作流、参数与编码保持原样。
- MiniMaxH3-双采超清.json：当前云端未注册 MiniMaxH3DualClockSamplerT8、MiniMaxH3AudioConditioningT8，文件没有足够的具名参数信息，对应源码快照也没有这些实现；未按匿名数字猜测。
- 分镜 API：KSampler 保存的 scheduler 为 FlowMatchEulerDiscreteScheduler，不在当前核心节点允许的选项中；未擅自替换调度器。
- 原工作流库另有 7 项 runnerType=api 外部执行器尚未接入，属于执行器范围，与本次节点解析修复不同。

云端检查期间存在用户正在执行的生成任务；本次没有修改云端插件、重启 ComfyUI 或影响这些任务。

## 验证结果

- 最终全量 Vitest：70 个测试文件通过，939 项通过，3 项因缺少本地样本跳过。
- TypeScript 与 Vite 生产构建通过，仅有已有的大文件分块提示。
- 运行路径测试主动让节点定义与系统状态接口失败，确认仍使用保存的执行图、当前提示词、参数和实际上传素材提交；不进行节点重解析或模型路径替换。
- 已覆盖重复点击、取消、恢复、多输出、可选素材、服务端错误详情保留，以及参数冲突不被静默修复。
- 浏览器扩展未开放本地文件选择权限，浏览器自动上传未通过；实际落盘验收改用画布同一个本地导入 HTTP 接口，并验证写入文件。

明细保存在 `.cache/import-compatibility-audit-20261016.json` 与 `.cache/v3-local-import-result-20261016.json`。

## 修改文件

- `src/workflow/import-editor.ts`、`import-api.ts`、`import-repair.ts`：实际解析与恢复。
- `src/workflow/import-pipeline.ts`、`import-pending.ts`、`import-analyzer.ts`、`import-schema.ts`：导入与依赖记录。
- `scripts/workflow-library-writer.ts`：保存原始文件、执行图和插件诊断。
- `src/generation/pipeline.ts`：直接提交，移除运行时节点与系统探测，保留服务端错误详情。
- `src/generation/GenerationPanel.tsx`、`src/workflow/WorkflowImportDialog.tsx`、`WorkflowLibraryStatus.tsx`、`WorkflowPicker.tsx`、`directory-view.ts`：运行状态、自动转换与实际插件提示。
- 对应导入、兼容性、生成、LoRA 和待完善工作流测试。

## 使用

项目已构建并启动，打开 http://127.0.0.1:1420/ 即可。导入普通 JSON 或 API JSON，自动转换完成后选择该工作流，连接素材并运行。已有 V3 记录可直接在工作流列表中选择；云端需先具备该工作流实际使用的插件及模型。
