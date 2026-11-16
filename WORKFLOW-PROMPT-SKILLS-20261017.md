# 工作流模型与 GitHub 提示词 Skill 对照

核查日期：2026-10-17（北京时间）。

已读取当前配置指定的 `E:/123/DFCine/DFCine0.26/workflows/library`，核对工作流配置、模型需求文件及项目现有读取器解析的执行图；随后检查 GitHub 实际 `SKILL.md`、配套规则文件和官方模型资料。这里的模型清单表示工作流配置依赖，不代表本次重新检测了云端所有权重是否安装。

## 本地模型清单

共 78 条工作流：71 条 ComfyUI 执行模板可解析；另外 7 条 API 配置已注册，但当前画布执行器未支持 `runnerType=api`。

| 模型家族 | 工作流数 | 已核实的实际版本与任务 |
|---|---:|---|
| MiniMax H3 | 15 | FL2VA / Ref2VA；标准、加速、极速；文生、图生、首尾帧、多参考、数字人；含用户导入 V3 |
| LTX 2.3 | 13 | 22B distilled 1.1；MSR 四条使用 LTX-2.3-Licon-MSR-V2；另含关键帧、音频驱动、转绘、去字幕 |
| Qwen Image | 10 | Edit 2511、Image 2512、Image 2.1；含单/双/三图编辑、多角度及导入的 2.1 BF16 |
| FLUX.2 Klein | 4 | 9B FP8；文生图、单/双图编辑、放大 |
| Krea2 | 4 | Krea2 Turbo FP8；HQ 同时依赖 Krea2 Raw，不是 FLUX Krea1 |
| Z-Image | 4 | Turbo 及 LoRA、写实、日系变体 |
| Bernini | 6 | Wan2.2 Bernini HIGH/LOW，含 LightX2V 加速 |
| Remix | 2 | Wan2.2 Remix I2V 14B v3.0；图生、首尾帧 |
| SCAIL | 3 | Wan2.1 14B SCAIL2；动作迁移、角色替换、多参考迁移 |
| VoxCPM | 2 | 实际执行节点选择 VoxCPM2；声音克隆、声音设计 |
| MiniMax Music | 1 | Music3；专用 DiT、文本编码器、DAV |
| Qwen 文本反推 | 1 | Qwen3.5-9B GGUF 及配套 mmproj |
| 其他工具 | 6 | 拼图、FlashVSR、SeedVR2 图/视频超分、视频转换 |
| API 配置 | 7 | GPT Image2 两条、Grok 两条、Nano Banana Pro、Wan2.7 图像与视频 |

完整配置和模型文件名见 [.cache/workflow-model-inventory-20261017.json](.cache/workflow-model-inventory-20261017.json)，执行模板核对见 [.cache/workflow-model-verified-20261017.json](.cache/workflow-model-verified-20261017.json)。

## 优先采用的来源

| 实际模型 | 已核实的 GitHub 来源 | 类型、匹配程度与接入边界 |
|---|---|---|
| MiniMax H3 | [官方 h3-prompt-writing](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md) | 官方纯提示词 Skill，覆盖文字、首帧、尾帧、首尾帧、Ref2VA。配套 [Base](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt) 与 [Ref2VA](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt) 是不同规则，必须按实际工作流路由。权重量化及加速变体不需要另套不相关模型的规则。 |
| MiniMax Music3 | [官方 music-caption-rewriter](https://github.com/MiniMax-AI/MiniMax-Music3/blob/main/skills/music-caption-rewriter/SKILL.md) | 官方纯文本 Skill。将音乐描述组织为全局风格、人声、编曲三部分，按风格索引选择少量模板；歌词保留在独立输入，不把歌词改写混入描述。需要一并处理配套 references/templates，不能只复制主文件。 |
| FLUX.2 Klein 9B | [BFL 官方 flux-image-best-practices](https://github.com/black-forest-labs/skills/blob/master/skills/flux-image-best-practices/SKILL.md) | 官方提示词 Skill，明确包含 Klein 4B/9B。使用 [FLUX.2 模型规则](https://github.com/black-forest-labs/skills/blob/master/skills/flux-image-best-practices/rules/flux2-models.md)、文生图及多参考编辑规则。只采用提示词部分，现有 ComfyUI 连接及采样配置继续由工作流控制。 |
| Qwen Image 2.1 | [iamyoki/qwen-image-2-1-prompter](https://github.com/iamyoki/qwen-image-2.1-skill/blob/main/skills/qwen-image-2-1-prompter/SKILL.md) | 真正的社区提示词 Skill，版本匹配。文生图与编辑规则分开；编辑规则强调保留/修改范围、画布图与素材图的角色。原 Skill 的默认英文、长文本和解释/JSON 输出需要适配画布的语言设置与纯提示词输出。不能用“有图片”替代已有工作流类型判断。 |
| Qwen Image 2.1 备选 | [kjranyone/qwen-image-prompt-en](https://github.com/kjranyone/qwen-image-2.1-prompt-guide/blob/main/skills/qwen-image-prompt-en/SKILL.md) | 真正的社区 Skill，规则分层清楚。其英文输出要求及部分多图数量说明与本地配置不一致，应采用写作方法并服从实际节点能力。旧 Edit 2511/2512 工作流不应直接继承 2.1 专属限制。 |
| LTX2.3 | [AI-KSK/ltx-2-3-prompt-director](https://github.com/AI-KSK/ltx-2-3-prompt-director/blob/main/SKILL.md) | 真正的社区 Skill，覆盖图生、音频、转绘、关键帧、对白、运镜。适合 LTX2.3 通用层；MSR V2 的素材角色另按 [Licon 作者的 V2 工作流](https://github.com/liconstudio/ComfyUI-Licon-MSR/blob/main/LTX-2.3_MSR_sample_workflow_V2.json) 校准。本次未在 Skill 仓库核实到 LICENSE 文件，不能自行标为 MIT。 |
| Krea2 Raw/Turbo | [Krea 官方 expansion.txt](https://github.com/krea-ai/krea-2/blob/main/docs/expansion.txt)；[社区 prompt-krea2](https://github.com/charliecpeterson/comfyui_mcp/blob/main/skills/prompt-krea2/SKILL.md) | 官方文件是直接的扩写系统规则，不是 Agent Skill；社区文件是真正 Skill。建议以官方规则为基础，文生图和已有风格迁移任务分开匹配。社区仓库许可证未明确，适合研究参考，不能默认其为可直接复制分发的 MIT 包。 |
| Wan2.2 Bernini | [ruashots/bernini-skill](https://github.com/ruashots/bernini-skill/blob/master/SKILL.md)；[Bernini 官方扩写实现](https://github.com/bytedance/Bernini/blob/main/bernini/prompt_enhancer.py) | 社区 Skill 对应 Bernini-R 双专家模型，含执行脚本；可提取按任务区分的写作规则，以官方扩写实现校准。不能让外部脚本接管已有画布连接和任务流程。 |
| Wan2.1 SCAIL2 | [ruashots/scail2-skill](https://github.com/ruashots/scail2-skill/blob/master/SKILL.md) | 真正的社区工作流 Skill，匹配 SCAIL2。人物检测短语与生成画面描述分开，角色替换和动作迁移分别处理；包含脚本，不能当成单个静态提示词模板直接运行。 |

## 有候选，但不能按精确提示词优化器直接接入

| 模型 | 来源 | 判断 |
|---|---|---|
| Z-Image | [prompt-zimage](https://github.com/charliecpeterson/comfyui_mcp/blob/main/skills/prompt-zimage/SKILL.md)，并对照 [官方模型库](https://github.com/Tongyi-MAI/Z-Image) | 真正社区 Skill，但有强制补充人物属性、额外物件等可能改变原意的规则，部分版本状态还需校准。仅提取与实际 Turbo/Base 任务一致的受约束规则。 |
| VoxCPM2 | [openlark/voxcpm Skill](https://github.com/openlark/skills/blob/main/skills/voxcpm/SKILL.md)，对照 [OpenBMB 官方仓库](https://github.com/OpenBMB/VoxCPM) | 版本匹配，但主要是部署、API、克隆和声音设计使用指南。可参考语音风格控制；不应把要朗读的正文当普通图像提示词扩写。 |
| GPT Image2 | [gpt-image-prompting](https://github.com/RBYHNDRDS/gpt-image-prompting-skill/blob/main/SKILL.md) | 真正的社区纯提示词 Skill，覆盖编辑约束、文字和参考图。可作为后续 API 工作流的规则来源；默认排除项不能覆盖用户明确要求。 |
| Nano Banana Pro | [nano-banana-image-skill](https://github.com/Emily2040/nano-banana-image-skill/blob/master/SKILL.md) | 真正的社区 Skill，包含参考、一致性、文字和编辑规则；默认访谈/JSON 流程不适合原样放入一键优化操作。 |
| Wan2.7 | [Wan 官方 image Skill](https://github.com/Wan-Video/Wan-skills/blob/main/skills/wan2.7-image-skill/SKILL.md) | 官方 Skill，版本匹配，但重点为 API 调用、上传和异步任务，不等于专门的提示词优化规则库。 |
| Remix v3.0 | [Wan2.2 官方 system_prompt.py](https://github.com/Wan-Video/Wan2.2/blob/main/wan/utils/system_prompt.py) | 本次未找到已核实的精确 Remix v3.0 提示词 Skill。可将官方 Wan2.2 扩写规则作为同家族降级，明确它不是 Remix 专属。 |
| Qwen3.5 提示词反推 | 现有反推工作流及目标生成模型的规则 | 本次未核实到与该具体 ComfyUI 反推工作流精确对应的专用 Skill。若输出要交给 H3、Qwen Image 等模型，规则应按输出目标和任务选择，而不能仅凭 GGUF 文件名选择。 |
| 超分、拼接、深度等工具 | 已有工作流参数与素材角色 | 多数属于参数或素材转换任务，不需要强行追加创作型扩写 Skill。 |

原先参考的 [Goohai prompt_optimizer.py](https://github.com/goohai/Goohai-MiniMax-H3_Integration/blob/main/prompt_optimizer.py) 是 ComfyUI 优化器源码，不是 Agent Skill。它适合核对 H3 的任务路由和素材处理；H3 写作规则优先回到官方 Skill。

## 本地提示词文件的实际情况

库中 62 个工作流目录自带 `prompts`，合计 115 个文件、109 种不同内容。它们可以补充规则，但不能仅凭数量判断已覆盖所有模型。新导入的 H3 V3、Qwen2.1 BF16 等部分工作流没有自己的专用 prompts。

根 `workflows/prompt` 目前有 5 份 UTF-8 文件：Krea2 风格迁移、LTX MSR、LTX 首尾帧、LTX 图生视频包含规则正文；`minimaxH3提示词文档.txt` 只有资料链接与任务分流说明，没有 Base/Ref2VA 全文。

因此，H3 优先需要补齐官方参考文件，而不是把本地链接索引误当完整优化模板。文件索引见 [.cache/workflow-prompt-file-index-20261017.json](.cache/workflow-prompt-file-index-20261017.json)。

## 与画布接入的关系

本轮已完成读取与来源核查，尚未安装或接入这些 Skill。

安装到 Codex 的 Skill 不会自动被画布后端的提示词优化器加载。后续接入应将对应规则及依赖纳入本地模板选择，按生成模型、任务和素材角色路由，同时保留当前中文/English 配置、原文切换、负向字段边界和结果过期保护。

优先顺序：H3 官方 → Music3 官方 → FLUX.2 Klein 官方 → Qwen2.1 → LTX2.3/MSR → Krea2 → Bernini/SCAIL2。社区规则中与当前工作流不一致的语言、图片数量、输出包装和参数假设，需要逐项适配。
