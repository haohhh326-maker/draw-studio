# DFCine 配方接入

2026-09-21：从远端镜像已生成 MP4 的 API 元数据提取四份配方，分别为标准 20 步 / 加速 4 步、单图 / 双图参考。原始证据保存在工作区 autodl-audit-2026-09-21。这里只保留节点类型、输入和连接；已移除原提示词、元数据和个人任务路径。

保留 WAS Image Load、ResolutionSelector、24 FPS 帧数表达式、标准版注意力/缓存分支、加速版 LoRA/SigmaShift、音视频 VAE 以及原生 CreateVideo/SaveVideo。不会将参考生成冒充为首尾帧或纯文生视频。当前四个配方沿用原来的竖屏 9:16；两图配方要求恰好两张图片。

画布选择 MiniMax H3 标准或加速，再选单图/双图参考。连接对应数量的参考图片，输入提示词或连接文本，配置 ComfyUI 地址后生成。旧项目内未绑定的四个内置条目会自动补上配方，用户自定义配方和历史任务快照保留。

执行链：上传至 input/infinite-canvas/<taskId> → WAS image_path 写入 input/ 前缀 → POST /prompt → WS 进度和 GET /history/<promptId> → outputs["92"].images 读取 MP4 → GET /view → 保存本地并回写原画布节点。输出前缀为 infinite-canvas/<taskId>/result。使用自己的任务目录避免混用 DFCine 既有素材。

本地没有复制 DFCine 外部客户端的源码、鉴权系统或品牌界面；本次复现的是有成片证据的 ComfyUI 生成图及文件协议。无需 AutoDL Bridge。

2026-09-24 更新：网页跨域已配置为可接受多个来源，真实画布生成、下载、本地回写和离线刷新已通过多个配方，见 LIVE-ACCEPTANCE.md。新增原生 H3 文生视频/首尾帧/视频参考/音频模式，以及 Music3、Krea2、VoxCPM2 适配。全镜像依赖和工作流覆盖尚未完成；LoRA 训练已按用户要求取消。AutoDL 镜像尚未保存发布，仍需最终冷启动验收。
