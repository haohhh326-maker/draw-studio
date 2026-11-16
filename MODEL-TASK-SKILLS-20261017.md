# 音频面板与模型 Skill 调整

已部署到当前本地画布与 `E:/123/DFCine/DFCine0.26/workflows/prompt`，日期 2026-10-17。

音频生成面板移除主提示词下的附加输入框，保留主提示词、原有参数值与执行映射。没有触发音频、图像或视频生成；验证用临时音频节点已删除，可撤销。

## Skill 结构

从 89 条按工作流展开的映射改为 **1 层通用规则 → 14 个模型组 → 28 个任务分支**。实际权重和 API 模型标识决定生成模型，执行图及输入语义决定文生图、编辑、图生视频、关键帧或多参考等任务。工作流名字、ID 和目录名不参与 Skill 选择。量化版本、H3 标准/加速/极速等无需各复制一份 Skill。

- `common/prompt-editing/`：文本、图像、视频、音乐、朗读和工具字段的共享写作边界。
- `models/`：MiniMax H3/Music3、FLUX、Qwen 2.1/Qwen 2511/2512、Krea、Z-Image、LTX、Bernini、SCAIL2、Wan 2.2、VoxCPM、GPT Image、Nano Banana。
- `skill-index.json`：模型与任务索引。模型版本、实际 LoRA 和节点特性只增加相应条件参考；例如 Qwen 2512 的 ArtFilm 不进入 2511。
- `metadata/`：GitHub 来源、版本和本地适配文件校验。官方资料、社区 Skill、本地适配有区分。
- `archive/before-model-task-20261017/`：调整前的 17 个目录、索引和来源记录，保留备份，不参与扫描。

组织方式核对了 [MiniMax 官方 H3 Skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)、[BFL 官方 FLUX Skill](https://github.com/black-forest-labs/skills/blob/master/skills/flux-image-best-practices/SKILL.md)、[社区 Qwen Image 2.1 Skill](https://github.com/iamyoki/qwen-image-2.1-skill/blob/main/skills/qwen-image-2-1-prompter/SKILL.md) 等实际内容。第三方资料只作为写作数据读取，未执行其脚本。

新导入或改名的工作流使用相同模型与任务时会复用同一 Skill。没有专属资料的 Grok/Wan 2.7 等回退到共享任务规则，不借用其他模型的专属规则。朗读正文要求逐字保留；独立文本编辑不继承其关联生成器的朗读或工具控制约束。

## 主要修改文件

- `src/generation/GenerationPanel.tsx`：移除音频附加编辑区。
- `src/prompt-optimization/model-target.ts`（新增）、`context.ts`：模型、任务、特性和字段契约收集。
- `src/prompt-optimization/types.ts`、`src/types/index.ts`、`src/workflow/library-converter.ts`：保留实际 API 模型身份和目标类型。
- `src/prompt-optimization/target-labels.ts`（新增）、`use-prompt-optimization.ts`、`settings-panel-state.ts`、`OptimizationControls.tsx`：展示模型/任务，跟随当前编辑字段。
- `scripts/default-prompt-skills.ts`（新增）、`prompt-skill-loader.ts`：schema2 索引、共享层和模型任务条件加载。
- `scripts/prompt-optimization-service.ts`：目标校验与朗读正文保护，保留现有模型、mmproj、认证和调用方式。
- `tests/prompt-optimization-model-target.test.ts`（新增）、`prompt-skill-loader.test.ts`、`prompt-optimization-service.test.ts`、`workflow-library-reader.test.ts`：回归与实际目录审计。

## 验证与限制

- 生产构建通过（原有大包体积警告仍存在）。
- 部署后完整测试：82 个测试文件通过，1276 项通过，3 项按原条件跳过。
- 实际 78 个工作流、9 个补充场景的 353 项路由断言全部通过，覆盖改名、新 ID、H3 Base/Ref、API 有图/无图、工具、朗读和相机控制。审计文件：`.cache/model-skill-catalog-audit-20261017.json`。
- 对部署后的真实目录严格验证 74 种模型/任务组合、8 类共享规则及全部条件引用；loader/service 共 81 项测试通过。只加载 common/models，不读取 archive 或旧 TXT 模板。
- 浏览器实测音频仅剩主提示词，附加 textarea 数量为 0。效果：`.cache/audio-model-skill-panel-20261017.png`。
- 已尝试从临时音频节点发起真实 AI 优化，当前云端连接返回“该 ComfyUI 尚未安装当前版本的 Draw studio 提示词优化适配器”。原文完整保留，未触发音频生成。**因此这次没有完成真实模型输出效果验证**；目录/路由检查不等同于 AI 推理验证。本次未更改云端或认证配置。

## 自测

刷新 `http://127.0.0.1:1420/`。音频节点只显示主提示词；AI 优化设置应显示生成模型、任务和匹配 Skill。任选同模型同任务的两份不同名称工作流，匹配的 Skill 应一致；切换文生图/编辑时应选择对应任务。Skill 目录仍为原路径，修改文件后使用“重新扫描 Skill”。本地服务沿用当前自动守护启动方式；开发时可在项目目录执行 `npm run dev`，避免同时占用 1420 端口。
