# 云端提示词优化依赖安装记录

记录始于 2026-10-05，最近续查为 2026-10-16。已直接在 AutoDL 环境安装并检查，未发布云端画布界面。下方早期状态保留为历史；当前结论以本节和文末最新续查为准。

2026-10-16 最新状态：已修复聊天调用参数、后台模型读取和 CUDA 加载诊断，部署了系统 C++ 运行库预加载，并完成 ComfyUI 重启。本轮最后检查时 ComfyUI 与 Jupyter 公网地址再次返回 HTTP 404，因此 **GPU 真实推理和画布超时修复尚未验收**。此前真实 CPU 视觉优化成功，耗时 436 秒；认证和模型读取也曾真实成功，这些结果不能当作公网当前正常或 GPU 正常的证明。

## 2026-10-05 已完成（历史）

| 项目 | 实际结果 |
| --- | --- |
| ComfyUI 使用的 Python | `/root/miniconda3/bin/python`，3.12.3，Linux x86_64 |
| llama-cpp-python | 安装 0.4.2+cu130，cp312 Linux wheel |
| diskcache | 新安装 5.6.3 |
| NumPy | 根据 wheel 要求从 2.4.6 调整到 2.3.2 |
| Torch | 保留 2.12.1+cu130，CUDA 版本 13.0 |
| Pillow / aiohttp / Jinja2 / typing_extensions | 已存在且满足依赖；版本分别为 12.2.0 / 3.14.3 / 3.1.6 / 4.15.0 |
| Qwen35ChatHandler、Qwen3VLChatHandler | 实际导入成功 |
| Torch 与 NumPy | 张量/数组数据往返检查通过 |
| pip check | 退出码 0，No broken requirements found |
| 云端 Linux 适配器检查 | 最终 51 项全部通过，包含符号链接边界及私有令牌文件检查 |
| 真实文件元数据 | 5 个 qwen35 主模型、3 个 clip 投影，无读取警告 |
| GPU / ComfyUI | 10 月 5 日后续已确认 RTX 5090、CUDA 可用，本机模型接口 HTTP 200；未执行真实 AI 推理 |

安装包来自 [JamePeng CUDA 13.0 官方仓库发布页](https://github.com/JamePeng/llama-cpp-python/releases/tag/v0.4.2-cu130-linux-20261003)，文件名为 `llama_cpp_python-0.4.2+cu130-cp312-cp312-linux_x86_64.whl`。下载文件大小 182088017 字节，云端与本地 SHA256 均匹配发布资产：`50058d3f72e45dda6c24fd3b5502b018c8a8d65790a5491eb09347eefa3e81fe`。没有修改 Torch，也没有执行其他插件的整套依赖重装。

## 模型列表修复

8 个模型入口是 AutoDL 缓存的符号链接，实际文件位于 `/.autodl-model/data`，并非损坏的 50 字节权重。原扫描跳过这些链接，已改为只接受 `models/LLM` 内的叶子 GGUF 链接，严格验证其解析后的文件位于服务端明确允许的缓存根。目录链接、断链和越界文件仍会被拒绝。

云端 `/root/draw-studio/deploy/autodl/start-stack.sh` 已加入该精确缓存根，原有启动行为保留；以后通过 `/root/start-comfyui.sh` 启动即可带入配置。手动绕过这个入口运行 `main.py` 时，需要先设置：

```bash
export DRAW_STUDIO_OPTIMIZER_ALLOWED_MODEL_ROOTS='/.autodl-model/data'
```

实际主模型：

- `Qwen3.8-27B-Q3_K_M.gguf`
- `Qwen3.8-27B-Q4_K_M.gguf`
- `Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf`
- `Qwen3.8-27B-Uncensored-Q4_K_M.gguf`
- `Qwen3.8-27B-Uncensored-Q8_0.gguf`

实际 mmproj：

- `Qweb3.8-mmproj-BF16.gguf`（保留服务器现有名称）
- `mmproj-Qwen3.8-27B-Q8_0.gguf`
- `mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf`

三个投影的 GGUF 身份元数据都匹配当前系列，因此均列为候选，没有唯一自动推荐。候选匹配与处理器可导入不代表已通过真实图片推理。

## 备份与检查记录

云端更新了 `/root/ComfyUI/custom_nodes/draw-studio-prompt-optimizer/__init__.py`、同目录 README，以及现有启动脚本的一项模型缓存环境变量。

原文件备份：`/root/draw-studio/optimizer-backup-20261005-1791134092136152274`。

云端检查记录：

- `/root/draw-studio/dependency-audit-before-20261005.json`
- `/root/draw-studio/dependency-audit-after-20261005.json`
- `/root/draw-studio/optimizer-audit-20261005/deployment.json`
- `/root/draw-studio/optimizer-audit-20261005/tests.log`
- `/root/draw-studio/optimizer-audit-20261005/model-inventory.json`

Python 测试使用运行时替身检查图片编码、角色、认证、任务管理及推理参数；真实库存检查只替代 ComfyUI 注册对象，使用实际 aiohttp、llama_cpp 和真实文件元数据，不加载模型。

## 你接下来如何测试

1. 开启有足够显存的 GPU 实例，启动或重启 ComfyUI。如果平台没有自动启动，在 Jupyter 终端运行 `bash /root/start-comfyui.sh`。
2. 在本地画布顶部小云朵确认现有连接能检测到 ComfyUI。
3. 打开目标图像/视频节点的 AI 优化设置，点击读取模型，选择上述实际主模型及 mmproj；设备选择 CUDA，保存设置。示例工作流原来保存的 Q2_K_XL / F16 文件名不在当前库存里，需要改选实际文件。
4. 先测试不连接图片的中文提示词优化与撤销，再连接一张、多张参考图片测试视觉效果，最后测试 English、首尾帧角色及切换节点保护。

此处的待验收状态为 10 月 5 日历史记录。10 月 16 日已完成远程认证和一次真实 CPU 视觉优化，见下方最新续查；GPU 显存、速度及画布完整流程仍待验收。远程优化沿用小云朵连接，不会自动放开匿名访问。

## 2026-10-16 续查

### 首次恢复与认证验证（早于下方推理修复）

用户恢复云端操作并授权助手配置令牌后，原 ComfyUI 与 Jupyter 地址均恢复 HTTP 200。运行中的 ComfyUI 已带入私有令牌文件配置，无需重启；检查时生成队列为 0/0。已创建随机令牌并写入 `/root/draw-studio/.optimizer-token`（普通文件、0600 权限），同一令牌已填入本地画布小云朵当前连接。令牌未输出到报告、代码或工作流。

画布连接检测成功，AI 优化设置实际读取到 5 个主模型与 3 个 mmproj，原 403 提示消失。这是远程认证和模型读取的真实验证，不是模型推理验证。随后修复了本机保存与恢复连接时清空令牌的问题：连接认证独立持久保存，不再依赖项目保存，也不会被较早的项目保存覆盖。云端继续使用原私有令牌文件。下方的 404 与暂停状态为恢复之前的历史记录。

持久保存修复后的实际验证：在 Edge 的 `http://127.0.0.1:1420/` 保存原云端令牌后重新加载页面，没有再次输入令牌，重新打开 AI 优化设置仍成功读取 5 个 GGUF 与 3 个 mmproj，页面显示“已读取 5 个可用模型”。新增 6 项回归测试覆盖无项目时保存、启动恢复、连续修改及清空、旧项目保存不覆盖新认证、存储失败提示与重试、旧配置兼容和导出不包含令牌；与连接、客户端、服务和项目测试合计 46 项通过。TypeScript 与 Vite 构建通过。未执行模型推理。

恢复前历史记录：当时本地画布 `http://127.0.0.1:1420/` 返回 HTTP 200，原 AutoDL 的 ComfyUI 与 Jupyter 公网地址均返回 HTTP 404；用户要求暂不测试云端，因此暂停操作。该阶段尚未生成、配置或验证令牌。用户后来恢复授权，已经完成前述令牌配置和验证；此历史段落不是要求重新配置令牌。

本轮本地回归：连接设置、优化客户端、优化服务的 33 项 Vitest 测试全部通过。系统默认 Python 3.12 缺少 Pillow，改用已有 Anaconda Python 环境运行适配器测试：共 51 项，49 项通过、2 项平台相关检查跳过。TypeScript 类型检查和 Vite 生产构建通过，仅有现存的大文件分块提示。这些测试验证认证和接口契约，不代表真实模型推理通过。

私有令牌文件支持已写入适配器，启动脚本指定 `DRAW_STUDIO_OPTIMIZER_TOKEN_FILE=/root/draw-studio/.optimizer-token`。要求普通文件、服务用户所有、权限 `0600`，内容不带末尾换行；非空 `DRAW_STUDIO_OPTIMIZER_TOKEN` 环境变量优先。小云朵的“连接设置”提供访问令牌、认证头与前缀，模型读取和优化均复用它。画布令牌现已保存到本机连接记录，刷新后自动恢复。具体配置见扩展 README。

### 最新续查：聊天兼容、CPU 超时与 CUDA 运行库

用户继续报告 `Llama.create_chat_completion() got an unexpected keyword argument 'stopping_criteria'` 与画布 AI 调用超时。实际检查得出以下结果：

1. 当前 `llama-cpp-python 0.4.2+cu130` 聊天接口不接受该参数。适配器改用每项请求独立的 `Llama` 子类，在底层 `create_completion()` 合并取消条件并保留已有停止条件；文本与 Qwen 视觉处理器都经过该底层接口。聊天调用本身只传受支持的参数。
2. 模型读取曾在 aiohttp 事件循环中首次导入运行库与视觉处理器。完整清单构造现已移入工作线程，使 HTTP 状态查询可继续响应。画布首次读取模型最多等待 60 秒；已受理任务的单次状态查询超时会重试，整体仍受 240 秒等待上限和用户取消控制。
3. 实际向 `Qwen3.8-27B-Q3_K_M.gguf` + `mmproj-Qwen3.8-27B-Q8_0.gguf` 提交了一张 128×128 的白底红圆参考图。模型在 **CPU 上耗时 436 秒**，最终返回“简洁红色圆形图标，白色背景”，正常停止。这是真实像素输入和真实模型推理，但超过画布等待上限，不能作为 CUDA 或超时修复已通过的证据。没有启动图片或视频生成任务。
4. 进程实际未加载 CUDA 后端。显式加载 `/root/miniconda3/lib/python3.12/site-packages/llama_cpp/lib/libggml-cuda.so` 后得到具体错误：`/root/miniconda3/lib/libstdc++.so.6: version 'GLIBCXX_3.4.30' not found`。CUDA 依赖已存在，冲突来自 ComfyUI 进程加载的旧 Conda C++ 运行库。
5. 该实例使用 `/usr/lib/x86_64-linux-gnu/libstdc++.so.6` 预加载的 Torch + llama_cpp CUDA 联合检查通过。项目和云端的 `deploy/autodl/start-stack.sh` 已持久加入启动前预加载配置，并通过 shell 语法检查；保留了原私有令牌、模型缓存允许根和其他启动行为。ComfyUI 重启至 PID 5411 后曾报告本机 HTTP 就绪。
6. 在修复后的 GPU 真实推理开始前，ComfyUI 与 Jupyter 公网地址再次返回 HTTP 404。因此尚未得到修复后 GPU 推理耗时、显存用量或画布完整优化结果，不能宣称用户的超时问题已经解决。

选择 CUDA 时，适配器现会先验证插件加载与 GPU offload 支持，失败即给出具体原因，避免静默退回 CPU 长时间运行。该预检查及取消行为有回归覆盖：云端 Linux **57 项适配器测试全部通过**；本地 Windows **55 项通过、2 项平台相关检查跳过**；画布优化服务 **28 项测试通过**。TypeScript 检查与 Vite 生产构建通过。自动化推理部分使用受控运行时替身，不用于替代上述真实模型测试。

当前已验证的 AutoDL 可通过原入口 `bash /root/start-comfyui.sh` 带入 C++ 预加载。手动启动同一环境时，必须在 ComfyUI Python 启动前设置：

```bash
export LD_PRELOAD="/usr/lib/x86_64-linux-gnu/libstdc++.so.6${LD_PRELOAD:+:$LD_PRELOAD}"
```

启动脚本允许使用 `COMFY_STDCXX_PRELOAD` 指向其他兼容库。其他实例不能直接假定该系统路径可用，应先验证文件存在以及 Torch、CUDA 插件所需的 ABI；无需更换模型或重新创建当前令牌。单独安装交付 ZIP 不会修改服务器启动脚本，需参考其 README 处理所在环境。

连接恢复后，应先确认当前实例和共享认证仍可读取模型，再使用上述 Q3 + Q8 投影组合执行真实 CUDA 测试，检查 GPU 使用及整体耗时；最后复验本地画布的优化、撤销、素材角色和过期结果保护。其他主模型/投影组合尚未逐一执行真实推理。
