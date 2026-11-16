# AI 提示词优化：接入与验收

本地画布的生成面板已接入真实模型调用。点击 **AI 优化**，读取当前节点、生成工作流、模板及直接连接的素材；完成后只替换当前正向提示词，并提供撤销。优化不会自动运行图片或视频生成。

当前交付包括画布代码、ComfyUI 优化扩展与独立优化工作流。10 月 16 日已实际验证共享认证、读取到 5 个主模型与 3 个 mmproj，并完成一次 CPU 真实视觉优化；该请求耗时 436 秒，超过画布 240 秒整体等待上限。已定位并部署 CUDA C++ 运行库加载修复，但本轮最后检查时 ComfyUI 与 Jupyter 公网均再次返回 404，修复后的 GPU 推理和画布完整操作尚未验证。不能据此声称超时问题已解决，也不能用自动化替身测试证明真实模型效果。

## 启动本地画布

双击项目根目录的 `Start-Canvas.cmd`，打开 `http://127.0.0.1:1420/`。本地服务由独立监督进程运行，支持恢复其自身的预览服务。若代码刚更新，先构建，再刷新浏览器。

开发命令：

```powershell
npm run build
npm run dev
```

已有本地服务占用 1420 时，不需要同时再运行 dev。服务恢复说明见项目现有启动文档。

## 对照用户 V3 工作流的结果

检查了 `E:\123\DFCine\MiniMax - H3 智能一体化视频创作 V3.json` 中 `MiniMaxH3IntegrationGH` 的优化器状态，并对照 [Goohai 优化器源码](https://github.com/goohai/Goohai-MiniMax-H3_Integration/blob/main/prompt_optimizer.py)。

V3 当前启用 `mode=local`，保存的配置为：

| 设置 | 保存值 |
| --- | --- |
| GGUF 模型 | `Qwen3.8-27B-UD-Q2_K_XL.gguf` |
| 视觉投影 | `mmproj-Qwen3.8-27B-F16.gguf` |
| 设备 | `cuda` |
| 读取素材 | `true` |
| 输出语言 | 中文 |
| 最大输出长度 | 4096 |
| 自动优化 | `false` |

同一保存状态中的 RunningHub/Gemini 设置属于未启用的 API 配置。历史模型清单和 `H:` 路径不能证明这些文件在当前云端可用。画布默认模型留空，从服务器实际清单选择。

保留了用户要求的一次点击优化，不自动优化每次输入。优化器由 ComfyUI 的 GGUF 推理环境执行，生成图片/视频的模型与优化提示词的模型分别配置。

## 设置与模型连接

1. 在画布原有连接设置中填写实际 ComfyUI 地址和认证。
2. 打开生成面板中 **AI 优化** 旁的设置图标。
3. ComfyUI 优化直接沿用顶部小云朵的地址和认证，设置中不再重复显示连接选项或地址。切换小云朵连接后，优化也使用新的连接；旧的独立 ComfyUI 配置会自动迁移。
4. 点“读取模型”，选择服务实际返回的 GGUF。
5. 在“视觉优化模型（mmproj）”中选择文件，“读取 mmproj”会读取服务器的真实文件清单。与当前优化 GGUF 不匹配的文件会标注并禁选；唯一推荐会填入设置草稿，点击“保存设置”后生效。不再提供重复的“配套 mmproj”栏，也不为 ComfyUI 另选第二个 GGUF。
6. 设置中文或 English、CUDA 或 CPU、素材读取开关及最大输出长度（512–8192）。

可选的 OpenAI 兼容接口用于已有 Chat Completions 服务，其地址单独设置；ComfyUI GGUF 始终使用画布小云朵连接。

画布连接按请求传入本地后端，优化器不会另存它的令牌。小云朵共享连接的令牌、地址、认证头和前缀独立持久保存到本机连接记录，刷新或重启后恢复，不依赖项目自动保存，也不随项目导出。浏览器版使用当前站点的 IndexedDB，桌面版使用本机记录文件。可选 OpenAI 接口的令牌仍只保存在本地服务进程内存，重启后需重新输入；不写入优化设置文件或工作流。模型能力由服务返回的架构、处理器和投影检查确定。未知能力不会声称已分析图像。

## 云端需要补齐的内容

将交付的 `comfyui/draw-studio-prompt-optimizer` 文件夹放入实际 ComfyUI 的 `custom_nodes`，在原工作流可以成功优化的 Python 环境中使用，并重启 ComfyUI。详细安装、认证与接口说明见该文件夹的 `README.md`。

需要具备：

- `ComfyUI/models/LLM` 下的实际 GGUF，以及视觉任务对应的 mmproj。
- 支持该 GGUF 架构、视觉处理器和 CUDA 的 `llama_cpp`；扩展不自动安装或更换依赖。
- 已认证的网关转发，以及与画布连接对应的优化器认证环境变量。优化与生成共用小云朵连接；若内部服务凭证不同，由网关在认证后转发正确凭证。
- `/start` 和 `/status` 访问同一 ComfyUI 进程（单进程或粘性路由）。任务状态保存在该进程内存。

未安装扩展、缺模型、缺运行依赖、错误认证、投影不匹配、超时或模型执行失败，都会显示具体原因并保留原提示词。

目前支持 GGUF 路径。V3 保存清单中还出现了 Florence 与 Qwen3-VL 的 Transformers 目录；当前交付不会把这些目录伪装为可运行 GGUF，也未新增 Transformers 推理支持。

## 模板与匹配

实际扫描了 `E:\123\DFCine\DFCine0.26\workflows\prompt`。当前五个模板为 UTF-8 TXT：LTX 首尾帧、LTX 图生视频、LTX MSR、Krea2 风格迁移及 MiniMax H3 提示词文档。H3 文档含资料链接，未直接下载链接内容充当完整模板；设置会展示相关加载提示。该目录没有 Qwen 专属模板，Qwen 会明确使用通用规则。

目录可修改、保存与重新扫描。支持 TXT、Markdown、JSON；索引限制文件大小、总量、递归深度，跳过越界路径与链接。

匹配顺序：精确生成模型 + 工作流 → 模型系列 + 任务类型 → 通用任务类型 → 通用优化规则。专属图像模板不能替代多图视频模板。模板和素材中的文字作为任务数据，不能覆盖系统规则、用户意图或选定输出语言。

## 实际素材传递

只收集当前目标节点直接连接的输入。复用已有输入角色与工作流映射，传递主图、人物、场景、风格、参考视频、首帧和尾帧等语义；不把任意图片统一改成首帧，也不按图片数量改变工作流类型。

从画布素材存储读取原始 Blob。图片解码、缩放后编码为真实 JPEG 字节；视频取首、中、尾代表帧并带时间戳。接口接收实际 base64 像素，GGUF 视觉处理器真正获取图像，而不是只获取文件名或 URL。最多 16 张图片/视频帧，视觉请求总量受限；音频没有声音理解，视频也没有完整运动/音轨分析，会明确提示。

关闭“读取已连接图片与视频画面”或明确选择“仅基于文本优化”，会只传文本、模板及角色信息。图片缺失或视觉模型不可用时不会静默退回文本后声称读过图。

原有 `@` 素材引用通过受保护标记传入，结果校验后恢复；删除、重复或伪造引用的结果不写回。负向提示词与独立文本字段只提供上下文，不覆盖其原值。

## 运行与验收

2026-10-16 最新检查：云端 Linux 57 项适配器测试全部通过，本地 Windows 55 项通过、2 项平台相关检查跳过；优化服务 28 项测试通过；TypeScript 检查与 Vite 生产构建通过。本地预览服务已重启并确认优化设置接口 HTTP 200。

真实推理使用 `Qwen3.8-27B-Q3_K_M.gguf` 与 `mmproj-Qwen3.8-27B-Q8_0.gguf`，发送一张 128×128 的白底红圆图，最终返回“简洁红色圆形图标，白色背景”。该请求实际使用 CPU，耗时 436 秒，证明了该组合能接收像素并返回结果，也解释了它为何超过画布等待上限；不证明 CUDA 已正常工作或其他模型组合可用。

CUDA 插件的实际加载错误是 Conda 的 `/root/miniconda3/lib/libstdc++.so.6` 缺少 `GLIBCXX_3.4.30`。该实例使用系统 `/usr/lib/x86_64-linux-gnu/libstdc++.so.6` 的 Torch + llama_cpp 联合加载检查通过。项目及云端 `deploy/autodl/start-stack.sh` 已在 ComfyUI 启动前设置预加载，允许通过 `COMFY_STDCXX_PRELOAD` 指定兼容库路径；其他环境必须先验证路径和 ABI。重启后的服务曾报告本机 HTTP 就绪，但公网随后再次返回 404，尚未完成修复后的 GPU 真实推理及画布超时复验。完整记录见 `COMFY-OPTIMIZER-DEPENDENCIES-20261005.md`。

历史基线（非当前验收状态）：2026-10-04 TypeScript 与 Vite 构建通过；Vitest 65 个测试文件、872 项通过、2 项跳过；Python 38 项检查、37 项通过、1 项平台跳过。当时云端接口 404、本地读到 5 个模板，缺模型时原有 `@` 提示词未改动。后续已部署扩展、配置认证并执行上述真实 CPU 推理。

本地验证覆盖模板扫描/匹配、像素编码与传输、首尾帧角色、视频时间顺序、模型选择、语言设置、认证、异步任务、超时取消、输出校验、撤销保护和切换节点/文本/连接后的过期结果保护。Python 测试检查适配器的 GGUF 元数据、投影匹配、图片验证、推理调用参数与任务管理；推理运行时采用受控替身。

验证命令：

```powershell
npm test
npm run build
python -m unittest discover -s tests -p test_comfy_optimizer_adapter.py -v
```

恢复云端访问后，继续以下真实效果验收：

1. 读取真实模型和配套投影，保存设置。
2. 无图片输入中文提示词并优化，检查原意、输出及撤销。
3. 连接一张真实图片，再连接多张人物/场景参考，检查输出是否准确描述它们。
4. 首尾帧分别指定角色；视频参考检查代表帧提示与动作合理性。
5. 切换生成工作流、优化模型、English、设备与最大长度，检查调用与结果。
6. 执行期间切换节点、改提示词、换连接或取消，确认结果不会覆盖新输入。
7. 故意使用错误认证或不匹配投影，确认错误具体且原文保留。

2026-10-05 已更新云端优化适配器并安装运行依赖：Python 3.12.3、llama-cpp-python 0.4.2+cu130、diskcache 5.6.3、NumPy 2.3.2，保留原 Torch 2.12.1+cu130。两种 Qwen 视觉处理器导入、Torch/NumPy 数据往返、`pip check` 和 43 项 Linux 适配器测试通过。实际扫描到 5 个 qwen35 主模型与 3 个 clip mmproj，无元数据读取警告；修复了 AutoDL 缓存叶子链接被跳过的问题，并在现有启动脚本中限定允许实际缓存根 `/.autodl-model/data`。修改前的云端文件已备份。

历史续查：10 月 5 日已确认 RTX 5090、Torch CUDA 与本机模型接口可用，加入私有令牌文件支持后云端 Linux 51 项适配器测试通过。小云朵提供共享令牌入口，优化器支持 `DRAW_STUDIO_OPTIMIZER_TOKEN_FILE`。10 月 16 日先出现公网 404，恢复后已完成令牌配置与远程认证；之后出现并定位上述实际推理与 CUDA 加载问题。早期“令牌待配置”“尚未执行推理”的记录已被后续结果取代。当前待验收的是修复后的 GPU 真实流程及质量，不是重新创建令牌。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `src/generation/GenerationPanel.tsx` | 原按钮替换、优化入口与反馈 |
| `src/prompt-optimization/OptimizationControls.tsx`、`optimization.css` | 轻量模型/连接/模板设置与撤销控件 |
| `src/prompt-optimization/use-prompt-optimization.ts`、`operation-guard.ts` | 执行、状态同步、撤销及过期结果保护 |
| `src/prompt-optimization/context.ts`、`media.ts` | 当前节点素材/角色/模型信息与真实像素读取 |
| `src/prompt-optimization/client.ts`、`types.ts` | 本地接口、当前画布连接与共享类型 |
| `scripts/prompt-template-loader.ts` | 受限本地扫描与模板匹配 |
| `scripts/prompt-optimization-service.ts` | 设置、实际模型发现、多模态请求、异步查询与结果校验 |
| `scripts/prompt-optimization-plugin.ts`、`vite.config.ts` | 本地 dev/preview 后端接入 |
| `comfyui/draw-studio-prompt-optimizer/__init__.py`、`web/result.js`、`README.md` | GGUF 推理接口、独立节点、结果显示与部署说明 |
| `comfyui/Draw studio - AI 提示词优化工作流.json` | 独立优化工作流示例 |
| `tests/prompt-optimization-*.test.ts`、`tests/prompt-template-loader.test.ts`、`tests/test_comfy_optimizer_adapter.py` | 验证上述行为 |

本次没有修改用户原始 V3 工作流，也没有发布云端画布。

最新交付压缩包 `comfyui/Draw-studio-prompt-optimizer-20261016.zip` 包含扩展源码、结果显示脚本、部署说明、独立工作流、本文档与依赖检查报告，不包含模型、令牌、缓存或启动脚本。2026-10-16 已修复聊天接口不接受 `stopping_criteria` 的错误，并更新当前 AutoDL 扩展：取消条件改由请求独立的 `Llama` 子类传入底层 `create_completion()`，不改变文本/视觉消息或返回结构；模型扫描及运行库导入整体移入后台线程。严格接口、取消、HTTP 响应性及 CUDA 失败处理回归在云端 Linux 共 57 项全部通过。画布首次读取模型最多等待 60 秒，已受理任务的单次状态查询超时会重试，仍受整体 240 秒时限及用户取消控制；对应 28 项服务测试通过。新安装时解压并将完整扩展文件夹放入 ComfyUI 的 `custom_nodes`，按扩展 README 检查实际 CUDA 运行库后重启 ComfyUI。现有 AutoDL 的启动预加载修复已单独持久保存，尚待公网恢复后验证 GPU 实际耗时。
