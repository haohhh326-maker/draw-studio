# 当前 ComfyUI 缺失项与测试交付清单

核对时间：2026-09-27T23:22:00.366Z。证据来自当前在线实例的 /object_info，以及 /root/ComfyUI/models（包括符号链接）的只读目录扫描；没有安装、下载、重启或生成任务。

当前服务注册 2154 种节点，模型目录扫描到 66 个不同权重文件名。65 个入口中，64 个已接入原始执行图，37 个通过默认执行分支的节点/模型选项静态检查，27 个存在依赖问题，FlashVSR 1 个仍缺原始执行配置。静态检查通过不代表生成成功或显存足够。

“模型目录未找到”按原配置的模型文件名核对；“模型选项未提供”按执行图实际加载器检查。两者分开记录，避免将历史清单或同名文件夹误当作正在执行的依赖。没有配置额外模型路径，/root/autodl-fs 为空。

## 已修复的本地问题

- 接入 64 个目录入口的原始执行图，恢复生成按钮；不会套用旧混合目录的配方。
- 按原始绑定传入素材、提示词和参数；专用歌词/声音描述/参考音色文字/分段提示词可直接输入或连接文本。
- H3 多参考按实际连接展开图片、视频、音频加载器，移除未使用的占位素材。
- 修复原配置中 4 个种子默认值超出自身 UI 上限，以及千问角色三视图的 text/prompt 字段不一致。
- 输出统一写入任务目录；上传前核对当前服务的节点与模型选项，只规范同一文件名的路径，不替换其他模型。
- 88 项本地检查通过，未调用云端生成。

## LTX、Scail、Remix 的具体缺失项

### LTX MSR

当前服务未注册的节点：

- `LTXAddVideoICLoRAGuide`
- `LTXICLoRALoaderModelOnly`
- `LiconMSR`

原配置要求、当前模型目录未找到的权重：

- `gemma_3_12B_it_fp8_scaled.safetensors` — `models\clip\gemma_3_12B_it_fp8_scaled.safetensors`
- `ltx-2.3_text_projection_bf16.safetensors` — `models\text_encoders\ltx-2.3_text_projection_bf16.safetensors`
- `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` — `models\diffusion_models\ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`
- `LTX-2.3-Licon-MSR-V2.safetensors` — `models\loras\LTX-2.3-Licon-MSR-V2.safetensors`
- `LTX23_audio_vae_bf16.safetensors` — `models\vae\LTX23_audio_vae_bf16.safetensors`
- `LTX23_video_vae_bf16.safetensors` — `models\vae\LTX23_video_vae_bf16.safetensors`

### LTX2.3

当前服务未注册的节点：

- `DepthAnythingPreprocessor`
- `Image To Mask`
- `JWIntegerToString`
- `LTXAddVideoICLoRAGuide`
- `LTXICLoRALoaderModelOnly`
- `LTXVImgToVideoConditionOnly`
- `LayerUtility: ColorImage`
- `LayerUtility: ImageScaleByAspectRatio V2`
- `PromptRelayEncode`
- `ReservedVRAMSetter`
- `SimpleMath+`

原配置要求、当前模型目录未找到的权重：

- `gemma_3_12B_it_fp8_scaled.safetensors` — `models\\clip\\gemma_3_12B_it_fp8_scaled.safetensors`
- `ltx-2-19b-ic-lora-detailer.safetensors` — `models\loras\ltx-2-19b-ic-lora-detailer.safetensors`
- `ltx-2.3_text_projection_bf16.safetensors` — `models\text_encoders\\ltx-2.3_text_projection_bf16.safetensors`
- `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` — `models\diffusion_models\ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`
- `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors` — `models\loras\ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors`
- `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` — `models\latent_upscale_models\ltx-2.3-spatial-upscaler-x2-1.1.safetensors`
- `ltx2.3-ic-subtitles-remove-general.safetensors` — `models\loras\ltx2.3-ic-subtitles-remove-general.safetensors`
- `ltx2.3-ic-watermark-remove-general.safetensors` — `models\loras\ltx2.3-ic-watermark-remove-general.safetensors`
- `Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors` — `models\loras\Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`
- `LTX23_audio_vae_bf16.safetensors` — `models\vae\LTX23_audio_vae_bf16.safetensors`
- `LTX23_video_vae_bf16.safetensors` — `models\vae\LTX23_video_vae_bf16.safetensors`
- `taeltx2_3.safetensors` — `models\vae\taeltx2_3.safetensors`

### Scail

当前服务未注册的节点：

- `Float-🔬`
- `SCAIL2ColoredMaskV2`
- `WanAnimatePlus BlockSwap`
- `WanAnimatePlus ClipVisionEncode V2`
- `WanAnimatePlus Decode`
- `WanAnimatePlus LoraSelectMulti`
- `WanAnimatePlus ModelLoader`
- `WanAnimatePlus SCAIL_2 Embeds`
- `WanAnimatePlus Sampler`
- `WanAnimatePlus SamplerFromSettings`
- `WanAnimatePlus SamplerSettings`
- `WanAnimatePlus SetBlockSwap`
- `WanAnimatePlus SetLoRAs`
- `WanAnimatePlus TextEncodeCached`
- `WanAnimatePlus VAELoader`
- `WanVideoTextEncodeCached`

原配置要求、当前模型目录未找到的权重：

- `bounce_test_LowNoise-000005.safetensors` — `models\loras\bounce_test_LowNoise-000005.safetensors`
- `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` — `models\clip_vision\CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`
- `lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` — `models\loras\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors`
- `sam3.1_multiplex_fp16.safetensors` — `models\checkpoints\sam3.1_multiplex_fp16.safetensors`
- `umt5-xxl-enc-fp8_e4m3fn.safetensors` — `models\text_encoders\umt5-xxl-enc-fp8_e4m3fn.safetensors`
- `Wan2.1 - T2V - 14B_lightx2v_cfg_step_distill_v2_lora_rank64_bf16.safetensors` — `models\loras\Wan2.1 - T2V - 14B_lightx2v_cfg_step_distill_v2_lora_rank64_bf16.safetensors`
- `wan2.1_14B_SCAIL_2_fp8_scaled.safetensors` — `models\diffusion_models\wan2.1_14B_SCAIL_2_fp8_scaled.safetensors`
- `wan2.1_SCAIL_2_DPO_lora_bf16.safetensors` — `models\loras\wan2.1_SCAIL_2_DPO_lora_bf16.safetensors`
- `Wan2.1_VAE.safetensors` — `models\vae\Wan2.1_VAE.safetensors`

### Remix

当前服务未注册的节点：

- `ClipLoaderGGUF`
- `PainterI2VAdvanced`
- `PainterVRAM`
- `SimpleMath+`
- `image_scale_pixel_v2`

原配置要求、当前模型目录未找到的权重：

- `comfy-wan_2.1_vae.safetensors` — `models\vae\comfy-wan_2.1_vae.safetensors`
- `nsfw_wan_umt5-xxl_fp8_scaled.safetensors` — `models\text_encoders\nsfw_wan_umt5-xxl_fp8_scaled.safetensors`
- `Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors` — `models\diffusion_models\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors`
- `Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors` — `models\diffusion_models\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors`

## 全部 65 项状态

| 系列 | 工作流 | 当前静态状态 | 未注册节点数 | 未提供模型选项数 |
|---|---|---|---:|---:|
| MiniMax Music | MiniMax Music 3 | 可交给用户试跑 | 0 | 0 |
| VoxCPM | Vox 声音克隆 | 可交给用户试跑 | 0 | 0 |
| VoxCPM | Vox 声音设计 | 可交给用户试跑 | 0 | 0 |
| 图像工具 | Klein 高清放大 | 可交给用户试跑 | 0 | 0 |
| 图像工具 | 图像拼接 | 可交给用户试跑 | 0 | 0 |
| 图像工具 | 多视角相机 | 依赖待补齐 | 0 | 1 |
| 图像工具 | Seed 高清放大 | 依赖待补齐 | 4 | 0 |
| Klein 系列 | Klein 单图编辑 | 可交给用户试跑 | 0 | 0 |
| Klein 系列 | Klein 双图编辑 | 可交给用户试跑 | 0 | 0 |
| Klein 系列 | Klein 文生图 | 可交给用户试跑 | 0 | 0 |
| Klein 系列 | Klein 高清放大 | 可交给用户试跑 | 0 | 0 |
| Krea2 | Krea2 双 LoRA | 依赖待补齐 | 1 | 0 |
| Krea2 | Krea2 文生图高质量 | 依赖待补齐 | 0 | 1 |
| Krea2 | Krea2 自定义 LoRA | 可交给用户试跑 | 0 | 0 |
| Krea2 | Krea2 文生图 | 可交给用户试跑 | 0 | 0 |
| Qwen 图像 | 千问单图自定义 | 可交给用户试跑 | 0 | 0 |
| Qwen 图像 | 千问单图编辑 | 可交给用户试跑 | 0 | 0 |
| Qwen 图像 | 千问双图编辑 | 可交给用户试跑 | 0 | 0 |
| Qwen 图像 | 千问三图编辑 | 可交给用户试跑 | 0 | 0 |
| Qwen 图像 | 千问电影艺术照片 | 依赖待补齐 | 0 | 3 |
| Qwen 图像 | 千问角色三视图 | 依赖待补齐 | 2 | 0 |
| Zimage | Zimage 文生图 | 可交给用户试跑 | 0 | 0 |
| Zimage | Zimage 日本风格 | 依赖待补齐 | 0 | 2 |
| Zimage | Zimage LoRA | 可交给用户试跑 | 0 | 0 |
| Zimage | Zimage 写实光影 | 可交给用户试跑 | 0 | 0 |
| Bernini | Bernini 双图视频编辑（AutoDL） | 可交给用户试跑 | 0 | 0 |
| Bernini | Bernini 图生视频 | 依赖待补齐 | 1 | 1 |
| Bernini | Bernini 单图视频编辑（AutoDL） | 可交给用户试跑 | 0 | 0 |
| Bernini | Bernini 图像视频编辑 | 依赖待补齐 | 1 | 1 |
| Bernini | Bernini 纯视频编辑（AutoDL） | 可交给用户试跑 | 0 | 0 |
| Bernini | Bernini 视频编辑 | 依赖待补齐 | 1 | 1 |
| 视频超分工具 | FlashVSR 视频超分 | 执行文件待补齐 | 0 | 0 |
| 视频超分工具 | SEEDVR2 视频超分（标准 7B） | 可交给用户试跑 | 0 | 0 |
| 视频超分工具 | SEEDVR2 视频超分（简化 3B） | 可交给用户试跑 | 0 | 0 |
| LTX MSR | LTX MSR 多参双图 | 依赖待补齐 | 3 | 5 |
| LTX MSR | LTX MSR 声音 3 图多参 | 依赖待补齐 | 3 | 5 |
| LTX MSR | LTX MSR 多参 3 图 | 依赖待补齐 | 3 | 5 |
| LTX MSR | LTX MSR 多参 4 图 | 依赖待补齐 | 3 | 5 |
| LTX2.3 | LTX2.3 首中尾帧 | 依赖待补齐 | 2 | 8 |
| LTX2.3 | LTX2.3 多参 4 图 | 依赖待补齐 | 2 | 9 |
| LTX2.3 | LTX2.3 视频转绘 | 依赖待补齐 | 5 | 5 |
| LTX2.3 | LTX2.3 图生视频基础 | 依赖待补齐 | 1 | 6 |
| LTX2.3 | LTX2.3 单人音频驱动 | 依赖待补齐 | 1 | 8 |
| LTX2.3 | LTX2.3 去字幕 | 依赖待补齐 | 7 | 5 |
| LTX2.3 | LTX2.3 首尾帧 + 音频 | 依赖待补齐 | 2 | 8 |
| LTX2.3 | LTX2.3 首尾帧 | 依赖待补齐 | 2 | 8 |
| Remix | Remix 图生视频 | 依赖待补齐 | 5 | 3 |
| Remix | Remix 首尾帧 | 依赖待补齐 | 4 | 3 |
| Scail | Scail 三图迁移 | 依赖待补齐 | 10 | 1 |
| Scail | Scail 角色替换 | 依赖待补齐 | 14 | 2 |
| Scail | Scail 动作迁移 | 依赖待补齐 | 14 | 2 |
| MiniMax H3 标准 | H3 图生视频（标准） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 标准 | H3 多参视频（标准） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 标准 | H3 首尾帧视频（标准） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 标准 | H3 文生视频（标准） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 标准 | H3 数字人（双人） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 标准 | H3 数字人（单人） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 加速 | H3 图生视频（加速） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 加速 | H3 多参视频（加速） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 加速 | H3 首尾帧视频（加速） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 加速 | H3 文生视频（加速） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 极速 | H3 图生视频（8 步） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 极速 | H3 多参视频（4 步） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 极速 | H3 首尾帧视频（8 步） | 可交给用户试跑 | 0 | 0 |
| MiniMax H3 极速 | H3 文生视频（8 步） | 可交给用户试跑 | 0 | 0 |

## 各工作流缺失明细

### 多视角相机 / 图像工具

节点已注册。

加载器未提供的模型选项：`qwen-image-edit-2511-multiple-angles-lora.safetensors`

### Seed 高清放大 / 图像工具

未注册节点：`ImageResize+`、`TTP_Image_Assy`、`TTP_Image_Tile_Batch`、`TTP_Tile_image_size`

已注册加载器的模型选项未发现不匹配；未注册节点的模型加载仍无法确认。

### Krea2 双 LoRA / Krea2

未注册节点：`Lora Loader Stack (rgthree)`

已注册加载器的模型选项未发现不匹配；未注册节点的模型加载仍无法确认。

### Krea2 文生图高质量 / Krea2

节点已注册。

加载器未提供的模型选项：`krea2_raw.safetensors`

### 千问电影艺术照片 / Qwen 图像

节点已注册。

加载器未提供的模型选项：`Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors`、`film_20.safetensors`、`qwen_image_2512_fp8_e4m3fn.safetensors`

### 千问角色三视图 / Qwen 图像

未注册节点：`LayerUtility: ImageScaleByAspectRatio V2`、`LoaderGGUF`

已注册加载器的模型选项未发现不匹配；未注册节点的模型加载仍无法确认。

### Zimage 日本风格 / Zimage

节点已注册。

加载器未提供的模型选项：`Z-Image-Turbo身材 _ 姿势 _ 动作控制 加强_臀围+胸围（3.0加强版）.safetensors`、`uwazumimixZIT_v20.safetensors`

### Bernini 图生视频 / Bernini

未注册节点：`SimpleMath+`

加载器未提供的模型选项：`Wan2.1_VAE.safetensors`

### Bernini 图像视频编辑 / Bernini

未注册节点：`SimpleMath+`

加载器未提供的模型选项：`Wan2.1_VAE.safetensors`

### Bernini 视频编辑 / Bernini

未注册节点：`SimpleMath+`

加载器未提供的模型选项：`Wan2.1_VAE.safetensors`

### LTX MSR 多参双图 / LTX MSR

未注册节点：`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LiconMSR`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX MSR 声音 3 图多参 / LTX MSR

未注册节点：`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LiconMSR`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX MSR 多参 3 图 / LTX MSR

未注册节点：`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LiconMSR`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX MSR 多参 4 图 / LTX MSR

未注册节点：`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LiconMSR`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 首中尾帧 / LTX2.3

未注册节点：`ReservedVRAMSetter`、`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2-19b-ic-lora-detailer.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 多参 4 图 / LTX2.3

未注册节点：`JWIntegerToString`、`PromptRelayEncode`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2-19b-ic-lora-detailer.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`、`taeltx2_3.safetensors`

### LTX2.3 视频转绘 / LTX2.3

未注册节点：`DepthAnythingPreprocessor`、`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LTXVImgToVideoConditionOnly`、`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 图生视频基础 / LTX2.3

未注册节点：`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 单人音频驱动 / LTX2.3

未注册节点：`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2-19b-ic-lora-detailer.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 去字幕 / LTX2.3

未注册节点：`Image To Mask`、`LTXAddVideoICLoRAGuide`、`LTXICLoRALoaderModelOnly`、`LTXVImgToVideoConditionOnly`、`LayerUtility: ColorImage`、`LayerUtility: ImageScaleByAspectRatio V2`、`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 首尾帧 + 音频 / LTX2.3

未注册节点：`ReservedVRAMSetter`、`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2-19b-ic-lora-detailer.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### LTX2.3 首尾帧 / LTX2.3

未注册节点：`ReservedVRAMSetter`、`SimpleMath+`

加载器未提供的模型选项：`LTX23_audio_vae_bf16.safetensors`、`LTX23_video_vae_bf16.safetensors`、`Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors`、`gemma_3_12B_it_fp8_scaled.safetensors`、`ltx-2-19b-ic-lora-detailer.safetensors`、`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`、`ltx-2.3-spatial-upscaler-x2-1.1.safetensors`、`ltx-2.3_text_projection_bf16.safetensors`

### Remix 图生视频 / Remix

未注册节点：`ClipLoaderGGUF`、`PainterI2VAdvanced`、`PainterVRAM`、`SimpleMath+`、`image_scale_pixel_v2`

加载器未提供的模型选项：`Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors`、`Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors`、`comfy-wan_2.1_vae.safetensors`

### Remix 首尾帧 / Remix

未注册节点：`ClipLoaderGGUF`、`PainterVRAM`、`SimpleMath+`、`image_scale_pixel_v2`

加载器未提供的模型选项：`Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors`、`Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors`、`comfy-wan_2.1_vae.safetensors`

### Scail 三图迁移 / Scail

未注册节点：`Float-🔬`、`WanAnimatePlus BlockSwap`、`WanAnimatePlus Decode`、`WanAnimatePlus LoraSelectMulti`、`WanAnimatePlus ModelLoader`、`WanAnimatePlus SCAIL_2 Embeds`、`WanAnimatePlus Sampler`、`WanAnimatePlus SetLoRAs`、`WanAnimatePlus TextEncodeCached`、`WanAnimatePlus VAELoader`

加载器未提供的模型选项：`sam3.1_multiplex_fp16.safetensors`

### Scail 角色替换 / Scail

未注册节点：`Float-🔬`、`SCAIL2ColoredMaskV2`、`WanAnimatePlus BlockSwap`、`WanAnimatePlus ClipVisionEncode V2`、`WanAnimatePlus Decode`、`WanAnimatePlus LoraSelectMulti`、`WanAnimatePlus ModelLoader`、`WanAnimatePlus SCAIL_2 Embeds`、`WanAnimatePlus SamplerFromSettings`、`WanAnimatePlus SamplerSettings`、`WanAnimatePlus SetBlockSwap`、`WanAnimatePlus SetLoRAs`、`WanAnimatePlus VAELoader`、`WanVideoTextEncodeCached`

加载器未提供的模型选项：`CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`、`sam3.1_multiplex_fp16.safetensors`

### Scail 动作迁移 / Scail

未注册节点：`Float-🔬`、`SCAIL2ColoredMaskV2`、`WanAnimatePlus BlockSwap`、`WanAnimatePlus ClipVisionEncode V2`、`WanAnimatePlus Decode`、`WanAnimatePlus LoraSelectMulti`、`WanAnimatePlus ModelLoader`、`WanAnimatePlus SCAIL_2 Embeds`、`WanAnimatePlus SamplerFromSettings`、`WanAnimatePlus SamplerSettings`、`WanAnimatePlus SetBlockSwap`、`WanAnimatePlus SetLoRAs`、`WanAnimatePlus VAELoader`、`WanVideoTextEncodeCached`

加载器未提供的模型选项：`CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`、`sam3.1_multiplex_fp16.safetensors`

## 测试入口

打开 http://127.0.0.1:1420/ 。旧节点需要选择新目录工作流；已有新目录节点刷新即可恢复生成按钮。建议先测试 Klein 文生图、Krea2 文生图、H3 文生视频、MiniMax Music 3 或 Vox 声音设计。音乐与声音工作流的专用文本输入带 * 号，须填写。

本次交付不包含云端安装操作。LTX、Scail、Remix 的上述依赖由用户另行决定如何处理；FlashVSR 未取得原始执行配置，且当前服务仅有需要外部 API 的 WavespeedFlashVSRNode，不能当作本地 FlashVSR 替代。
