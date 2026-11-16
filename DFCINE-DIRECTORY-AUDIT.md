# DFCine 目录重建与来源核对（2026-09-28）

以用户确认清单为唯一目录：音乐 2 系列 / 3 入口，图像 5 系列 / 22 入口，视频 9 系列 / 40 入口。

旧 142 项混合目录已从应用运行入口移除；不再导入插件示例、旧版批处理、训练或自行扩展配方。

## 找到的真实来源

`E:\mimi\DFCine\workflows\library`

65 个目录入口中，64 个匹配到配置，来自 63 个独立配置文件。Klein 高清放大保留两个分类入口并共享来源。

名称差异明确记录：目录「Krea2 文生图」对应源配置「Krea2文生图 Turbo」；目录「Zimage 日本风格」对应源配置原拼写「Ziamge日本风格」。其余按去空白、忽略大小写后的名称精确匹配，不使用模糊匹配。

导入真实输入要求、参数默认值/范围/选项、原绑定元数据与 70 个不同的模型文件名。模型需求不等于云端已安装。

原始执行文件为 execution.comfyui.dfenc。现已按本机原客户端的容器读取方式载入 64 个入口的 API 执行图，并完成素材、参数和输出绑定；原始文件保持不变。FlashVSR 未在此本地工作流包中找到。执行图导入脚本为 scripts/import-dfcine-execution.mjs。

生成按钮已为 64 项恢复。当前云端依赖静态核对：37 项通过，27 项存在节点或模型选项缺失；缺失详情和测试交付见 [DFCINE-CLOUD-CHECK.md](DFCINE-CLOUD-CHECK.md)。没有进行云端生成试跑。

查找时仅对镜像进行文件只读扫描，没有修改任何远端文件、模型、节点或服务，没有提交生成任务。客户端源目录亦只读。

原项目的节点、连线、素材和任务执行快照保持不变。旧目录中的节点保留原配置值，需手动选择新目录条目，不按相似名称强制迁移。

旧公开示例文件归档到 `archive/retired-catalog-20260927/mirror`，不随新版本网页发布。

## FlashVSR 查找结果

官方说明：https://www.digitfold.com/5464.html 。页面下载区要求登录，本机版本 0.3.2（build 2026082701）中未找到此工作流；未取得原始配置或执行 JSON。当前服务也没有注册该本地插件节点，不能以外部收费 API 节点替代。

页面列出 models/FlashVSR-v1.1 下的 4 个模型：diffusion_pytorch_model_streaming_dmd.safetensors、Wan2.1_VAE.pth、LQ_proj_in.ckpt、TCDecoder.ckpt。界面单独标注为官方说明来源，不计入上述从配置导入的 70 个模型名，也不推断参数或执行图。

## 逐项对应

| 画布 | 系列 | 工作流入口 | 状态 | 原始文件夹 |
|---|---|---|---|---|
| 音乐画布 | MiniMax Music | MiniMax Music 3 | 配置已核对 / 执行文件加密 | MiniMax-Music3 |
| 音乐画布 | VoxCPM | Vox 声音克隆 | 配置已核对 / 执行文件加密 | Vox-AudioClone |
| 音乐画布 | VoxCPM | Vox 声音设计 | 配置已核对 / 执行文件加密 | Vox-AudioDes |
| 图像画布 | 图像工具 | Klein 高清放大 | 配置已核对 / 执行文件加密 | klein-Image-upscale |
| 图像画布 | 图像工具 | 图像拼接 | 配置已核对 / 执行文件加密 | Image-stitching |
| 图像画布 | 图像工具 | 多视角相机 | 配置已核对 / 执行文件加密 | Multi-angle |
| 图像画布 | 图像工具 | Seed 高清放大 | 配置已核对 / 执行文件加密 | Seed-Image-Upscale |
| 图像画布 | Klein 系列 | Klein 单图编辑 | 配置已核对 / 执行文件加密 | Klein-1Image-Edit |
| 图像画布 | Klein 系列 | Klein 双图编辑 | 配置已核对 / 执行文件加密 | Klein-2Image-Edit |
| 图像画布 | Klein 系列 | Klein 文生图 | 配置已核对 / 执行文件加密 | Klein-t2i |
| 图像画布 | Klein 系列 | Klein 高清放大 | 配置已核对 / 执行文件加密 | klein-Image-upscale |
| 图像画布 | Krea2 | Krea2 双 LoRA | 配置已核对 / 执行文件加密 | Krea2-Double-LoRA |
| 图像画布 | Krea2 | Krea2 文生图高质量 | 配置已核对 / 执行文件加密 | Krea2-HQ-t2i |
| 图像画布 | Krea2 | Krea2 自定义 LoRA | 配置已核对 / 执行文件加密 | Krea2-LoRA-T2I |
| 图像画布 | Krea2 | Krea2 文生图 | 配置已核对 / 执行文件加密 | Krea2-Turbo-t2i |
| 图像画布 | Qwen 图像 | 千问单图自定义 | 配置已核对 / 执行文件加密 | Qwen-1Image-Custom |
| 图像画布 | Qwen 图像 | 千问单图编辑 | 配置已核对 / 执行文件加密 | Qwen-1Image-Edit |
| 图像画布 | Qwen 图像 | 千问双图编辑 | 配置已核对 / 执行文件加密 | Qwen-2Image-Edit |
| 图像画布 | Qwen 图像 | 千问三图编辑 | 配置已核对 / 执行文件加密 | Qwen-3Image-Edit |
| 图像画布 | Qwen 图像 | 千问电影艺术照片 | 配置已核对 / 执行文件加密 | Qwen-ArtFilm-style |
| 图像画布 | Qwen 图像 | 千问角色三视图 | 配置已核对 / 执行文件加密 | Qwen-Character-Turnaround |
| 图像画布 | Zimage | Zimage 文生图 | 配置已核对 / 执行文件加密 | Zimage-Bace |
| 图像画布 | Zimage | Zimage 日本风格 | 配置已核对 / 执行文件加密 | Zimage-JPStyle |
| 图像画布 | Zimage | Zimage LoRA | 配置已核对 / 执行文件加密 | Zimage-Lora |
| 图像画布 | Zimage | Zimage 写实光影 | 配置已核对 / 执行文件加密 | Zimage-realism |
| 视频画布 | Bernini | Bernini 双图视频编辑（AutoDL） | 配置已核对 / 执行文件加密 | Bernini-2iv2v-official |
| 视频画布 | Bernini | Bernini 图生视频 | 配置已核对 / 执行文件加密 | Bernini-i2v |
| 视频画布 | Bernini | Bernini 单图视频编辑（AutoDL） | 配置已核对 / 执行文件加密 | Bernini-iv2v-official |
| 视频画布 | Bernini | Bernini 图像视频编辑 | 配置已核对 / 执行文件加密 | Bernini-rv2v |
| 视频画布 | Bernini | Bernini 纯视频编辑（AutoDL） | 配置已核对 / 执行文件加密 | Bernini-tv2v-official |
| 视频画布 | Bernini | Bernini 视频编辑 | 配置已核对 / 执行文件加密 | Bernini-v2v |
| 视频画布 | 视频超分工具 | FlashVSR 视频超分 | 未找到配置 | — |
| 视频画布 | 视频超分工具 | SEEDVR2 视频超分（标准 7B） | 配置已核对 / 执行文件加密 | SEEDVR2-Video-Upscale |
| 视频画布 | 视频超分工具 | SEEDVR2 视频超分（简化 3B） | 配置已核对 / 执行文件加密 | SEEDVR2-Video-Upscale-3B |
| 视频画布 | LTX MSR | LTX MSR 多参双图 | 配置已核对 / 执行文件加密 | LTX-MSR-2-Ref |
| 视频画布 | LTX MSR | LTX MSR 声音 3 图多参 | 配置已核对 / 执行文件加密 | LTX-MSR-3-ARef |
| 视频画布 | LTX MSR | LTX MSR 多参 3 图 | 配置已核对 / 执行文件加密 | LTX-MSR-3-Ref |
| 视频画布 | LTX MSR | LTX MSR 多参 4 图 | 配置已核对 / 执行文件加密 | LTX-MSR-4-Ref |
| 视频画布 | LTX2.3 | LTX2.3 首中尾帧 | 配置已核对 / 执行文件加密 | LTX2.3-3Keyframe |
| 视频画布 | LTX2.3 | LTX2.3 多参 4 图 | 配置已核对 / 执行文件加密 | LTX2.3-4xRef |
| 视频画布 | LTX2.3 | LTX2.3 视频转绘 | 配置已核对 / 执行文件加密 | Ltx2.3-DI2V |
| 视频画布 | LTX2.3 | LTX2.3 图生视频基础 | 配置已核对 / 执行文件加密 | Ltx2.3-I2V-Base |
| 视频画布 | LTX2.3 | LTX2.3 单人音频驱动 | 配置已核对 / 执行文件加密 | LTX2.3-IA2V-single |
| 视频画布 | LTX2.3 | LTX2.3 去字幕 | 配置已核对 / 执行文件加密 | LTX2.3-RemoveSubt |
| 视频画布 | LTX2.3 | LTX2.3 首尾帧 + 音频 | 配置已核对 / 执行文件加密 | LTX2.3-SEF-IA2V |
| 视频画布 | LTX2.3 | LTX2.3 首尾帧 | 配置已核对 / 执行文件加密 | LTX2.3-StarEndFrame |
| 视频画布 | Remix | Remix 图生视频 | 配置已核对 / 执行文件加密 | Remix-i2v |
| 视频画布 | Remix | Remix 首尾帧 | 配置已核对 / 执行文件加密 | Remix-StarEndFrame |
| 视频画布 | Scail | Scail 三图迁移 | 配置已核对 / 执行文件加密 | Scail-3-Ref-Transfer |
| 视频画布 | Scail | Scail 角色替换 | 配置已核对 / 执行文件加密 | Scail-Char-Replace |
| 视频画布 | Scail | Scail 动作迁移 | 配置已核对 / 执行文件加密 | Scail-Motion-Transfer |
| 视频画布 | MiniMax H3 标准 | H3 图生视频（标准） | 配置已核对 / 执行文件加密 | MiniMax-H3-I2V-Cloud |
| 视频画布 | MiniMax H3 标准 | H3 多参视频（标准） | 配置已核对 / 执行文件加密 | MiniMax-H3-RefV-Cloud |
| 视频画布 | MiniMax H3 标准 | H3 首尾帧视频（标准） | 配置已核对 / 执行文件加密 | MiniMax-H3-StarEndFrame-Cloud |
| 视频画布 | MiniMax H3 标准 | H3 文生视频（标准） | 配置已核对 / 执行文件加密 | MiniMax-H3-T2V-Cloud |
| 视频画布 | MiniMax H3 标准 | H3 数字人（双人） | 配置已核对 / 执行文件加密 | MinimaxH3-DigitalHuman-Double |
| 视频画布 | MiniMax H3 标准 | H3 数字人（单人） | 配置已核对 / 执行文件加密 | MinimaxH3-DigitalHuman-Single |
| 视频画布 | MiniMax H3 加速 | H3 图生视频（加速） | 配置已核对 / 执行文件加密 | MiniMax-H3-I2V-CloudAccelerate |
| 视频画布 | MiniMax H3 加速 | H3 多参视频（加速） | 配置已核对 / 执行文件加密 | MiniMax-H3-RefV-CloudAccelerate |
| 视频画布 | MiniMax H3 加速 | H3 首尾帧视频（加速） | 配置已核对 / 执行文件加密 | MiniMax-H3-StarEndFrame-CloudAccelerate |
| 视频画布 | MiniMax H3 加速 | H3 文生视频（加速） | 配置已核对 / 执行文件加密 | MiniMax-H3-T2V-CloudAccelerate |
| 视频画布 | MiniMax H3 极速 | H3 图生视频（8 步） | 配置已核对 / 执行文件加密 | MiniMax-H3-I2V-CloudTurbo |
| 视频画布 | MiniMax H3 极速 | H3 多参视频（4 步） | 配置已核对 / 执行文件加密 | MiniMax-H3-RefV-CloudTurbo |
| 视频画布 | MiniMax H3 极速 | H3 首尾帧视频（8 步） | 配置已核对 / 执行文件加密 | MiniMax-H3-StarEndFrame-CloudTurbo |
| 视频画布 | MiniMax H3 极速 | H3 文生视频（8 步） | 配置已核对 / 执行文件加密 | MiniMax-H3-T2V-CloudTurbo |
