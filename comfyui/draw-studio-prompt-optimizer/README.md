# Draw studio 提示词优化工作流与接口

这个扩展提供一个独立的 **Draw studio AI 提示词优化** ComfyUI 节点，以及画布直接调用的优化接口。它复用 ComfyUI Python 环境中的 `llama_cpp`，执行 GGUF 文本/视觉推理。不会排入图片或视频生成图，不加载扩散模型，也不会卸载当前 ComfyUI 中的生成模型。

源代码为本项目实现。参考工作流的部署方式来自 [Goohai MiniMax H3 Integration](https://github.com/goohai/Goohai-MiniMax-H3_Integration)；没有复制该项目的 H3 专属优化模板或实现。

2026-10-16 兼容修复：`llama-cpp-python 0.4.2+cu130` 的 `create_chat_completion()` 不接受 `stopping_criteria`。扩展现在使用每项请求独立的 `Llama` 子类，将取消条件加入底层 `create_completion()`，并保留处理器已有的停止条件；聊天接口只传受支持参数。Qwen35 与 Qwen3VL 的视觉处理器也经过该底层接口。模型发现的完整过程（含首次运行库/处理器导入）移入后台线程，避免阻塞 HTTP 状态查询。严格聊天签名、采样期间取消、已有停止条件、资源释放、冷导入期间响应性及 CUDA 加载失败检查均通过：云端 Linux 57 项全部通过，本地 Windows 55 项通过、2 项平台相关检查跳过。真实推理及当前连接状态见文末，不能以这些回归测试代替 GPU 验收。

## 云端需要准备什么

1. 把整个 `draw-studio-prompt-optimizer` 文件夹放进实际 ComfyUI 的 `custom_nodes` 目录，重启 **ComfyUI**。
2. 把优化模型 GGUF 放进实际 `ComfyUI/models/LLM` 目录或其子目录。模型列表读取实际 GGUF `general.architecture` 元数据；不按文件名假定视觉能力。默认只读取该目录内的普通文件，以及最终仍解析到该目录内的叶子链接。
3. 若要理解参考图片，还需与模型匹配的视觉投影文件 `mmproj`，同样放进 `models/LLM`。画布中的“视觉优化模型（mmproj）”直接选择这个文件，可用“读取 mmproj”刷新真实清单，不另选第二个 GGUF。目前确认的调用处理器为 `Qwen35ChatHandler`、`Qwen3VLChatHandler`。模型接口会按 GGUF `general.name` / `general.basename` / `clip.vision.*` 元数据和保守的 Qwen 型号、参数量规则，逐模型列出 `mmprojCandidates`、匹配依据和唯一的 `recommendedMmproj`；不是“文件夹里有任意 mmproj 就能用”。候选项仍是待真实推理验证的推荐，不能替代实际兼容性验证。
4. 使用原 H3 工作流能成功优化的 **同一个 Python 环境与 `llama_cpp` 安装**。该安装必须支持对应 GGUF 架构、视觉处理器和云端 CUDA 版本。这个扩展不自动安装或更换依赖。没有 `llama_cpp` 或处理器时，模型读取/优化会明确报错。
5. 云端进程需要设置优化器认证令牌，并保留现有云端网关认证；本扩展不会关闭或绕过它。画布优化直接沿用顶部小云朵连接，每次请求复用该连接的地址、认证头、前缀和令牌，不在 AI 优化设置中重复展示连接或另存令牌。若内部服务凭证不同，由网关在认证后转发正确凭证。

### CUDA 与 C++ 运行库

选择 CUDA 时，扩展会在加载模型前检查 CUDA 插件与 GPU offload 支持；检查失败会报告原因，不会静默退回 CPU。当前 AutoDL 曾加载 Conda 中的旧 `/root/miniconda3/lib/libstdc++.so.6`，使 `libggml-cuda.so` 因缺少 `GLIBCXX_3.4.30` 加载失败。该实例的系统库 `/usr/lib/x86_64-linux-gnu/libstdc++.so.6` 已通过 Torch 与 llama_cpp 联合加载检查。

项目及云端的 `deploy/autodl/start-stack.sh` 已在启动 ComfyUI 前加入系统库预加载，可用 `COMFY_STDCXX_PRELOAD` 指定其他经验证兼容的库路径。该修复必须在 **ComfyUI Python 进程启动前** 生效；仅刷新画布无效。手动启动当前已验证的 AutoDL 环境时，可先运行：

```sh
export LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libstdc++.so.6${LD_PRELOAD:+:$LD_PRELOAD}"
```

其他 Linux 环境应先确认该文件存在且满足 CUDA 插件和现有 Torch 的 ABI 要求，不要照搬不存在或未经验证的路径。交付扩展 ZIP 不包含启动脚本；首次安装到其他实例时还需按其实际环境处理 CUDA 运行库。

Linux 在启动现有 ComfyUI 命令之前设置环境变量：

```sh
export DRAW_STUDIO_OPTIMIZER_TOKEN='替换为自己的随机令牌'
```

也可通过 `DRAW_STUDIO_OPTIMIZER_TOKEN_FILE` 指定私有令牌文件。当前 AutoDL 启动脚本指向 `/root/draw-studio/.optimizer-token`。文件必须是当前服务用户所有的普通文件，权限设为 `0600`，内容为单行令牌且不能带末尾换行；不能使用符号链接。扩展不会自动生成令牌。若同时设置了非空 `DRAW_STUDIO_OPTIMIZER_TOKEN`，优先使用环境变量中的令牌。修改启动环境后需要重启 ComfyUI。

画布顶部小云朵 → 连接设置 → 访问令牌，填写同一令牌。默认认证头为 `Authorization`，前缀为 `Bearer `（包含末尾空格）。连接地址、令牌、认证头和前缀独立保存到本机连接配置，刷新或重启后自动恢复，不依赖打开或保存项目。浏览器版使用当前站点的 IndexedDB，桌面版使用本机记录文件；不同浏览器或站点地址的存储各自独立。令牌不随项目导出，也不写入工作流或优化设置文件。模型读取与优化请求均复用这项连接配置。

AutoDL 的只读模型缓存可以保持为 `LLM` 目录中的**叶子 GGUF 链接**，无需复制数十 GB 权重。例如链接名称保持 `.gguf`，而目标文件即使是缓存中的分片/hash 名称也可被识别；实际 GGUF 元数据仍会校验。管理员须在启动 ComfyUI 的同一环境中显式允许缓存根：

```sh
export DRAW_STUDIO_OPTIMIZER_ALLOWED_MODEL_ROOTS='/.autodl-model/data'
```

多个可信缓存根可用 Linux 的 `:` 分隔。该变量只能由服务管理员设置，不能在画布或请求中配置。扩展不会递归扫描该缓存；它只接受 `models/LLM` 下已经存在、最终解析到允许根内的普通文件目标。`LLM` 根链接、目录链接、断链、越界链接和 `/` 这样的文件系统根仍会被拒绝。

默认请求头为 `Authorization: Bearer <令牌>`。若现有网关使用其他请求头，可让扩展和画布设置采用一致的名称与前缀：

```sh
export DRAW_STUDIO_OPTIMIZER_AUTH_HEADER='X-Optimizer-Key'
export DRAW_STUDIO_OPTIMIZER_AUTH_PREFIX=''
```

令牌留在自己的服务环境和现有画布连接里，不放进工作流文件、AI 优化设置文件或代码。默认连接的令牌只随当前请求传递，不由优化器另存；未配置令牌时，只接受 Host/连接来源均为本机的请求，且校验浏览器 Origin。浏览器不能直接读取任意服务器模型文件；模型只从 `models/LLM` 内扫描。默认跳过外部符号链接；只有服务启动环境明确允许的缓存根内的叶子 GGUF 链接可被读取，越界路径和超出限制的文件仍会跳过。

如果网关需要独立的认证，同时把不同令牌留给优化器，应通过网关配置把已认证的请求转发到本机接口，或使用网关允许的请求头；先确认网关的转发规则，不要去掉已有认证。

## 独立工作流怎么用

扩展加载后，把同级的 `Draw studio - AI 提示词优化工作流.json` 拖入 ComfyUI。示例只有一个优化节点；运行后节点的 UI 显示优化提示词，`optimized_prompt` 输出为 STRING，可手动接到已有工作流的提示词输入。

示例采用用户 V3 工作流保存的选择：`Qwen3.8-27B-UD-Q2_K_XL.gguf`、`mmproj-Qwen3.8-27B-F16.gguf`、CUDA、中文、读取素材和 `4096` 最大输出长度。它只是便于复现 V3 设置，**不表示该模型或投影已部署、已加载或已通过真实视觉推理验证**。加载后仍需从实际模型下拉列表重新选择，并给节点接入 IMAGE 批次才能读取素材。如果是图像生成任务，将 `task_context_json` 改为对应的图像工作流信息，不能继续使用示例中的视频信息。

节点输入：

- `prompt`：原始正向提示词。
- `model` / `device`：实际 GGUF 模型，以及 CUDA 或 CPU。选择 CPU 时，主模型使用 `n_gpu_layers=0`，视觉处理器也必须支持 `use_gpu=False`；旧版处理器无法确认该选项时会在加载前明确报错，不会偷偷占用 GPU。
- `language`：中文或 English。
- `template_rules`：所选生成任务的模板规则，不会覆盖用户意图。独立节点不会读取任意本地路径；画布侧负责扫描、匹配自己的模板目录后，通过接口传入规则。
- `max_tokens`：最大输出长度，默认 `4096`，只能使用 `512`–`8192` 的整数。为兼容已有工作流，示例将它放在原有控件值之后；旧工作流未保存该值时使用默认值。
- `images`：可选 IMAGE 批次。图片转换成实际 JPEG 字节发送给视觉处理器，最多 16 张，缩小到 1600 像素以内。ComfyUI 可以用原有的 Load Image / Image Batch 节点构成批次，无需新的加载依赖。
- `mmproj`：视觉输入时必须选择存在且与模型兼容的投影文件。
- `image_roles_json`：与批次顺序一致的角色数组，例如 `[{"role":"firstFrame","label":"首帧"},{"role":"lastFrame","label":"尾帧"}]`。默认图片为普通参考，不当成首帧。
- `task_context_json`：例如 `{"model":"MiniMax H3","workflow":"多图参考视频","kind":"video","mode":"multi-reference"}`。生成模型与 GGUF 优化模型是不同字段。

连接视频时，画布采样代表性帧并携带时间顺序，再调用优化接口；独立节点可接对应的视频帧 IMAGE 批次，并在角色对象中提供 `timeSeconds`。这个扩展没有声称直接理解原始视频或音轨。

## 画布接口

地址相对于 ComfyUI（或保留 ComfyUI 路径的代理地址）：

- `GET /draw-studio/optimization/models`：真实模型、视觉处理器/依赖状态及全局 `mmprojModels`。每个模型还包含可直接填入设置的 `mmprojCandidates`（ID 数组）、可审阅的 `mmprojCandidateDetails`（`id`、`match`、`confidence`）和仅在最高匹配唯一时给出的 `recommendedMmproj`。只有已识别的视觉处理器、实际运行依赖和该模型的候选投影同时满足时，`capability` 才会是 `vision`；这表示适配器可构造该组合，**不是**一次已经成功完成的视觉 AI 推理。`handlerEvidence: "model-name"` 表示来自明确 Qwen 型号名的受限回退，仍必须用实际图片推理确认。
- `POST /draw-studio/optimization/start`：传入与下述 `/optimize` 相同的请求体，立即返回 HTTP 202 `{"request_id":"对应 ID","status":"running"}`，后台执行实际推理。
- `GET /draw-studio/optimization/status?request_id=对应ID`：返回 `running`；完成时返回 `{"status":"success","result":ChatCompletions响应}`；失败返回 `{"status":"error","error":"具体原因"}`，取消完成后返回 `cancelled`。查询接口同样校验认证。
- `POST /draw-studio/optimization/optimize`：`model`、`mmproj`、`device`、`request_id`、`max_tokens`（默认 `4096`，限 `512`–`8192`）及两条 `messages`（system/user）。用户消息可包含文本和 PNG/JPEG/WebP 的真实 base64 图片。
- `POST /draw-studio/optimization/cancel`：`{"request_id":"对应优化请求 ID"}`，只取消自己的优化请求，不调用 ComfyUI 全局 interrupt。

画布使用这些接口直接优化提示词，不需要提交 `/prompt` 图，也不会自动执行工作流下游图片/视频生成节点。默认会读取当前目标节点直接连接的图片，以及视频的有序代表帧；只有用户明确选择“仅基于文本优化”时才不会传送视觉像素。请求上限 30 MiB，视觉输入总量上限 20 MiB，同时只执行一个优化请求。节点切换、文本修改和撤销由画布侧保护。

云端优先使用 `/start` + `/status`，避免一次推理长请求被反向代理超时中断。开始或轮询连接断开不会自动取消已接受的后台任务；画布在用户取消、节点切换或总等待超时后显式调用 `/cancel`。取消后，直到推理线程实际退出才释放任务容量，不会在原任务仍占用模型时启动第二项。保留 `/optimize` 用于兼容直接请求，它在自身连接断开时申请取消。结束任务最多保留 8 条记录，保留期 30 分钟；达到记录数量上限时淘汰最早结束的任务，活动任务不会被清理。

任务状态只保存在一个 ComfyUI Python 进程的内存中。因此 `/start`、`/status` 和 `/cancel` 必须到达同一进程：部署单进程服务，或让反向代理按会话/请求 ID 使用粘性路由。多副本间没有共享任务存储；未配置粘性路由时，另一副本会返回“任务不存在”，并且画布会保留原提示词。

## 验证状态

截至 2026-10-16 本轮最后检查，原 AutoDL 的 ComfyUI 与 Jupyter 公网地址再次返回 HTTP 404。此前已完成认证、读取模型、部署兼容修复和重启；这些历史成功不表示公网目前可访问。需要恢复实例或更新连接后，继续验证修复后的真实 GPU 优化及画布完整操作。

本轮实际完成：

- 私有令牌文件和本地小云朵共享认证已配置。刷新本地画布后无需重填令牌，曾实际读取到 5 个主模型、3 个 mmproj，原 403 提示消失。
- `Qwen3.8-27B-Q3_K_M.gguf` 与 `mmproj-Qwen3.8-27B-Q8_0.gguf` 实际接收了一张 128×128 的白底红圆参考图，真实视觉优化在 **CPU 上耗时 436 秒**，返回“简洁红色圆形图标，白色背景”。这是一次真实推理成功；但超过画布整体 240 秒等待上限，不能作为 CUDA 或超时修复通过的证据。
- 已定位 CUDA 插件被旧 Conda C++ 库阻止加载的具体错误，完成上述启动脚本预加载修复。Torch 与 llama_cpp 联合加载检查通过，ComfyUI 重启后曾报告本机 HTTP 就绪；随后公网恢复为 404，尚未完成修复后的真实 GPU 推理。
- 云端 Linux 57 项适配器测试全部通过；本地 Windows 55 项通过、2 项平台相关检查跳过。画布优化服务 28 项测试通过。回归测试中的模型运行时使用受控替身，覆盖图片编码、角色、元数据、认证、取消、锁释放、响应性和 CUDA 失败处理，不代表真实 GPU 速度或视觉质量。

真实库存读取到 5 个 `qwen35` 主模型及 3 个 `clip` mmproj，无元数据读取警告；三个投影均列为候选，没有唯一自动推荐。仅上述 Q3 + Q8 投影组合做过本次 CPU 视觉测试，不能推定所有组合已验证。

历史依赖记录：2026-10-05 在 `/root/miniconda3/bin/python`（Python 3.12.3）安装 `llama-cpp-python 0.4.2+cu130`、`diskcache 5.6.3`，按 wheel 约束使用 NumPy 2.3.2，保留 Torch 2.12.1+cu130；两种 Qwen 处理器导入、Torch/NumPy 往返及 `pip check` 均通过。当时的 43/51 项测试以及“未执行推理”“待配置认证”等状态已由本节后续检查取代，详见依赖检查报告。

连接恢复后的验收顺序：确认读取实际模型和投影；验证 CUDA 真实推理耗时及显存；再测试画布无图片、一张/多张图片、首尾帧、English、撤销与切换节点保护。扩展不会主动卸载现有生成模型。

开发者可在项目根目录运行：

```powershell
python -m unittest discover -s tests -p test_comfy_optimizer_adapter.py -v
```
