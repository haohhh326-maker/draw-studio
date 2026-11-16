# 画布提示词 Skill 切换交付记录 · 2026-10-17

已把 GitHub Skill 包下载到原目录 `E:/123/DFCine/DFCine0.26/workflows/prompt`，并将画布的 AI 提示词优化改为真实 `SKILL.md` + 按需参考文件。旧的独立提示词模板加载器、匹配器及旧接口已移除。根目录原有 5 个 TXT 未删除，运行时不读取。

## 下载与来源

共 17 个 Skill 包：10 个下载包、7 个针对实际工作流的本地适配包。下载包共 1205 个文件、约 10.4 MB；包括 H3 的 Base/Ref2VA 两套规则、Music3 的 18 个风格索引与 1000 个完整参考。不是所有包都由模型厂商发布，来源如下。

| Skill 包 | GitHub 来源 | 固定提交 |
| --- | --- | --- |
| `h3-prompt-writing` | [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) | `d21241f0a4b3` |
| `music-caption-rewriter` | [MiniMax-AI/MiniMax-Music3](https://github.com/MiniMax-AI/MiniMax-Music3) | `945655064d59` |
| `flux-image-best-practices` | [black-forest-labs/skills](https://github.com/black-forest-labs/skills) | `8907d515b0ac` |
| `qwen-image-2-1-prompter` | [iamyoki/qwen-image-2.1-skill](https://github.com/iamyoki/qwen-image-2.1-skill) | `32b8100e7029` |
| `ltx-2-3-prompt-director` | [AI-KSK/ltx-2-3-prompt-director](https://github.com/AI-KSK/ltx-2-3-prompt-director) | `c9487b13178c` |
| `bernini-prompt` | [ruashots/bernini-skill](https://github.com/ruashots/bernini-skill) | `755a2f150a5a` |
| `scail2-prompt` | [ruashots/scail2-skill](https://github.com/ruashots/scail2-skill) | `91a79f518fc4` |
| `voxcpm` | [openlark/skills](https://github.com/openlark/skills) | `ebb5a7d909d0` |
| `gpt-image-prompting` | [RBYHNDRDS/gpt-image-prompting-skill](https://github.com/RBYHNDRDS/gpt-image-prompting-skill) | `6fc237847f30` |
| `nano-banana-prompting` | [Emily2040/nano-banana-image-skill](https://github.com/Emily2040/nano-banana-image-skill) | `1f1360cc267a` |

本地适配包为 `canvas-prompt-editing`、`krea2-prompt-editing`、`zimage-prompt-editing`、`qwen-image-legacy-prompt`、`wan22-remix-prompt`、`camera-angle-prompt`、`qwen-character-turnaround`。Krea2 和 Wan2.2 使用其官方静态规则作为 Skill 配套参考；其余依据已安装的真实工作流、模型要求和输入职责制作，来源写在各包内。Remix 使用明确标识的 Wan2.2 家族规则，不冒充 Remix 专用官方 Skill。LTX MSR 增加当前画布角色与音频边界的本地补充。

目录内 `skill-sources.lock.json` 记录下载来源、提交和文件 SHA256；`skill-adapters.lock.json` 记录本地适配及补充文件；`README-SKILLS.md` 提供使用说明。

## 运行机制

`skill-index.json` 当前有 89 条映射，实际核对了全部 78 个工作流。匹配优先级为精确工作流、模型/家族与任务、通用任务 Skill。一个工作流内部可按当前真实任务选择不同规则。生成模型与优化用 GGUF 模型仍分开处理；优化复用顶部小云朵的地址和认证、既有 GGUF/mmproj 与真实模型调用。

- 按绑定端口识别 H3 首尾帧，加载 Base 规则；多参考加载 Ref2VA 规则。GH V3 依据真实 `main_mode` 与 `gh_state_json` 恢复语义切换，遵从当前上游实际执行逻辑。
- Qwen 2.1 动态编辑按 TextEncodeQwenImage21 的实际图像端口识别，加载编辑规则，不再误用文生图规则。2511、2512 与 2.1 隔离。
- 角色三视图区分角色图和姿势参考；多视角相机保持 `<sks>` 固定控制词；去字幕工具不会进入 LTX 创作 Skill。
- Music3 读取主 Skill → router → 单个风格索引 → 最多 3 条兼容参考。完整读取选中的索引用于筛选，只把选中卡片与引用发给 AI；不把一千条示例全部加载进上下文。
- Skill 文件及图片只作为任务数据，不执行其中的脚本、MCP、命令、下载或链接。限制配置目录内的静态读取，拒绝路径越界与符号链接。修改时间缓存与强制重新扫描均可用。
- 原文/优化稿切换、文本节点编辑、固定设置面板、中英文、真实连接素材及其角色、取消和过期结果防护继续沿用。仅替换当前正向提示词，负向词、歌词及独立字段不被覆盖。

目前使用通用 Skill 的 13 项：Grok视频官方、Grok1.5（APIMart）、FlashVSR 视频超分、图像拼接、Klein高清放大、LTX2.3去字幕、Qwen3.5提示词反推、Seed高清放大、SEEDVR2 视频超分（标准 7B）、SEEDVR2 视频超分（简化 3B）、视频转深度、Wan2.7文生图、wan2.7图生视频。这是明确的通用适配，不能理解为已经找到对应模型的专用 Skill。

## 验证

- `tsc -b` 通过；Vite 生产构建通过，只有已有的大包体积提示。
- 全量 Vitest：81 个文件通过，1221 项通过、3 项按原条件跳过。新增 Skill 加载/引用/隔离、版本和任务匹配、实际包读取、路径边界、缓存、Music3 按需选择及设置迁移测试。原模板测试随旧加载器退役，改为真实 Skill 目录与任务验证。
- 已在运行中的本地服务检查 `/skills`：Qwen 2.1 编辑精确匹配 `SKILL.md` + `references/edit_rules.md`，无加载警告。
- 浏览器设置读到云端 5 个实际模型及 mmproj；保持原来的 CUDA、English、4096 输出配置，路径保存为新 `skillDirectory`，未更换认证或模型。
- 图像 6 在一张已连接图像的上下文下完成真实优化调用；AI 返回与原提示词相同内容。版本切换正常，并已切回原稿，未触发图像生成。
- 临时文本节点真实调用完成：原文“一个年轻男生站在雨后的街道上，手持红色雨伞，暖色路灯，安静的感觉。”返回英文改写，包含清晰主体、湿路反射与构图描述。原文切换恢复完整。该临时节点已经删除，图像 6 原稿保留。
- 此次没有逐一执行 78 个图像/视频生成工作流，也没有对所有 Skill 做真实模型质量评分；目录匹配验证与真实生成效果应区分。云端优化器本次未安装新依赖、未修改服务代码。

真实文本输出：

> A young man stands on a rain-soaked street after rainfall, holding a red umbrella, under warm streetlights, with soft reflections on the wet pavement, quiet and calm atmosphere, medium shot, clear subject focus.

## 修改文件

新增 `scripts/prompt-skill-loader.ts`、`tests/prompt-skill-loader.test.ts`。修改 `scripts/prompt-optimization-service.ts`、`scripts/prompt-optimization-plugin.ts`、`src/prompt-optimization/types.ts`、`client.ts`、`context.ts`、`use-prompt-optimization.ts`、`OptimizationControls.tsx`、`optimization.css` 及对应 service/client/context 测试。删除旧 `scripts/prompt-template-loader.ts` 与对应测试。设置文件迁移为 `skillDirectory`；模型、语言和连接保持原值。

外部目录新增上述 17 个包、`skill-index.json`、两份来源记录及说明。具体工作流映射核验见 `.cache/prompt-skill-coverage-20261017.json`。

## 启动与使用

本地服务已由现有监督进程恢复到新版，地址仍为 `http://127.0.0.1:1420/`。手动从项目启动可运行 `npm run build` 后 `npm run preview`；需要开发热更新时使用 `npm run dev`，同一端口不要同时启动第二份。

选择节点、原始提示词、生成工作流及参考素材，点击星光图标。设置下部显示 Skill 目录和当前匹配项，可强制重新扫描；修改目录后保存。当前保留用户原有 English 输出，如需中文，在设置中选择中文并保存。原文/优化稿按钮用于切换、修改原文、再次优化。

![Skill 配置与匹配结果](.cache/prompt-skill-settings-20261017.png)
