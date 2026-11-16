> 历史资料：本文件对应已停用的旧混合目录，不能用作当前 DFCine 目录或运行状态。当前清单见 [DFCINE-DIRECTORY-AUDIT.md](DFCINE-DIRECTORY-AUDIT.md)。

# 镜像目录补全记录

更新：2026-09-24。本轮遵照用户要求不执行生成或自动化测试，只做目录核对、代码适配与编译。

镜像内 96 份 VRGDG 工作流，加 11 份插件示例，共 107 份源文件；8 份训练文件按用户决定排除，1 份原文件为空或无效。其余 99 项（含无效文件的问题条目）均保留在画布选择器中。另有 43 个画布专用配方。

模型文件清单共 59 项，另记录 91 个源工作流引用但当前未安装的模型名称。已有文件、缺失依赖、未转换子图与未试跑状态分别展示，不代表全部可以执行。

使用方式：选择节点 → 打开底部工作流选择器 → 工作流 / 模型与 LoRA；搜索或勾选全部节点类型。高级参数按原节点分组，可搜索模型名和字段。多个结果可在输出结果菜单切换。

默认输出可导出 API 图 92 项，尚需适配 50 项。前者仍可能缺少模型或节点；此数字不代表试跑通过数。

## 默认输出仍需适配的条目

- VRGDG_FaceFix_Workflow：子图输入未提供：cond_image_strength；子图输入未提供：guiding_strength；子图输入未提供：temporal_overlap_cond_strength；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：LTXVLoopingSampler；缺少节点定义，无法转换控件：UnetLoaderGGUF
- VRGDG_TextToVideov1：控件版本需要核对：LTXVEmptyLatentAudio；缺少节点定义，无法转换控件：CM_FloatToInt；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：LTXVSpatioTemporalTiledVAEDecode；缺少节点定义，无法转换控件：UnetLoaderGGUF
- VRGDG_TextToVideov2：控件版本需要核对：LTXVEmptyLatentAudio；缺少节点定义，无法转换控件：CM_FloatToInt；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：LTXVSpatioTemporalTiledVAEDecode；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_I2V_V5.2：子图输入未提供：clip_name1；子图输入未提供：clip_name2；子图输入未提供：unet_name；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_I2V_V5.2_remake mode：子图输入未提供：clip_name1；子图输入未提供：clip_name2；子图输入未提供：unet_name；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_T2V_V5.2：子图输入未提供：clip_name1；子图输入未提供：clip_name2；子图输入未提供：unet_name；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_T2V_V5.2_BackgroundLLM：子图输入未提供：clip_name1；子图输入未提供：clip_name2；子图输入未提供：unet_name；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_I2V_V5.1：控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- LTX2.3_Music_Video_Creator_T2V_V5.1：控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- Lora_DataSetCreationHelper：原始目录保存节点需要适配到任务 output 目录：SaveImageKJ
- Lora DataSet creator V1：原始目录保存节点需要适配到任务 output 目录：SaveImageKJ
- Lora DataSet creator V2：原始目录保存节点需要适配到任务 output 目录：SaveImageKJ
- NanoB_LTX-2_V1：子图输出连接不唯一；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：CM_IntToFloat；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF
- Nano_Banana_LTX-2.3_MVC_V3：控件版本需要核对：ResizeImageMaskNode；控件版本需要核对：VRGDG_NanoBananaPro；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- Nano_Banana_Pro_LTX-2_MVC_V2：子图输出连接不唯一；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：CM_IntToFloat；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF
- PromptCreator_Nano_Banana_Pro_LTX-2_V2.1：缺少节点定义，无法转换控件：ShowText|pysssss
- PromptCreator_Nano_Banana_Pro_LTX-2_V2：缺少节点定义，无法转换控件：ShowText|pysssss
- PromptCreator_NanoB_LTX-2_V1：缺少节点定义，无法转换控件：ShowText|pysssss；连接目标不存在：35；找不到连接节点：35
- PromptCreator_Z-image_LTX-2_V3：缺少节点定义，无法转换控件：ShowText|pysssss
- Z-image_LTX-2.3_MVC_V4：控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：UnetLoaderGGUF
- Z-image_LTX-2_MVC_V2：子图输出连接不唯一；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：CM_IntToFloat；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF
- PromptCreatorV1.5(Zimage_LTX_SRT_V2)：缺少节点定义，无法转换控件：ShowText|pysssss；连接目标不存在：35；找不到连接节点：35
- PromptCreatorV1.5(Zimage_LTX_SRT_V2.1)：缺少节点定义，无法转换控件：ShowText|pysssss；连接目标不存在：35；找不到连接节点：35
- zimage_LTX-2-SRT_Mode：子图输出连接不唯一；控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：CM_IntToFloat；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF
- MiniMaxH3_2Pass_LatentUpscale_Shareable：缺少节点定义，无法转换控件：TESpeedMiniMaxH3
- minimax_ref2video_2pass_audio_driven_api：连接目标不存在：245；找不到连接节点：245
- FirstLastPromptCreatorV1.3：缺少节点定义，无法转换控件：ShowText|pysssss
- LyricExtractionForManualWF：缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：ShowText|pysssss
- WanHumoMVC_V8.1：控件版本需要核对：easy showAnything；旁路连接不唯一：WanVideoBlockSwap；旁路连接不唯一：WanVideoLoraSelect；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- WanHumoMVC_V9：控件版本需要核对：ImageResizeKJv2；控件版本需要核对：easy showAnything；旁路连接不唯一：WanVideoBlockSwap；旁路连接不唯一：WanVideoLoraSelect；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- Wan_HumoMVC_ManualMode_V1.1：控件版本需要核对：ImageResizeKJv2；控件版本需要核对：easy showAnything；旁路连接不唯一：WanVideoLoraSelect；无法解析命名连接：prompts；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoBlockSwap；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- Z-Image_Wan2.2 FL & Humo_MVC_V2.1：镜像中的源文件为空或不是有效 JSON
- WanHumo_ImageEdit_Workflow_V1：旁路连接不唯一：LoadImage；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：WanVideoBlockSwap；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncodeSingle；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- AnyImageZImageUpscaleWithCN：缺少节点定义，无法转换控件：AIO_Preprocessor
- Wan2.22ziamge：缺少节点定义，无法转换控件：Int；缺少节点定义，无法转换控件：MathExpression|pysssss；缺少节点定义，无法转换控件：Seed Everywhere
- ZImageUSD：缺少节点定义，无法转换控件：UltimateSDUpscaleNoUpscale
- chroma2zimage (1)：缺少节点定义，无法转换控件：UnetLoaderGGUF
- FirstLastPromptCreatorV1.5(LTX)：缺少节点定义，无法转换控件：ShowText|pysssss
- PromptCreator_NanoB_LTX-2_V1：缺少节点定义，无法转换控件：ShowText|pysssss；连接目标不存在：35；找不到连接节点：35
- WanHumoMVC_V6：旁路连接不唯一：WanVideoBlockSwap；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- WanHumoMVC_V7.1：控件版本需要核对：easy showAnything；旁路连接不唯一：WanVideoLoraSelect；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoBlockSwap；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- WanHumoMVC_V7：控件版本需要核对：ImageResizeKJv2；控件版本需要核对：easy showAnything；旁路连接不唯一：WanVideoLoraSelect；缺少节点定义，无法转换控件：HuMoEmbeds；缺少节点定义，无法转换控件：LoadWanVideoT5TextEncoder；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：RemBGSession+；缺少节点定义，无法转换控件：WanVideoBlockSwap；缺少节点定义，无法转换控件：WanVideoDecode；缺少节点定义，无法转换控件：WanVideoLoraSelect；缺少节点定义，无法转换控件：WanVideoModelLoader；缺少节点定义，无法转换控件：WanVideoSampler；缺少节点定义，无法转换控件：WanVideoTextEncode；缺少节点定义，无法转换控件：WanVideoTorchCompileSettings；缺少节点定义，无法转换控件：WanVideoVAELoader；缺少节点定义，无法转换控件：WhisperModelLoader
- Z-image_LTX-2 Music Video Creator V1.1：控件版本需要核对：ResizeImageMaskNode；缺少节点定义，无法转换控件：CM_IntToFloat；缺少节点定义，无法转换控件：DualCLIPLoaderGGUF；缺少节点定义，无法转换控件：MelBandRoFormerModelLoader；缺少节点定义，无法转换控件：UnetLoaderGGUF
- 1-FaceDetailer：缺少节点定义，无法转换控件：UltralyticsDetectorProvider
- 2-MaskDetailer：缺少节点定义，无法转换控件：workflow>Impact::MAKE_BASIC_PIPE
- 4-MakeTileSEGS-Upscale：缺少节点定义，无法转换控件：UltralyticsDetectorProvider；缺少节点定义，无法转换控件：workflow>MAKE_BASIC_PIPE
- 5-PreviewDetailerHookProvider：缺少节点定义，无法转换控件：UltralyticsDetectorProvider；缺少节点定义，无法转换控件：workflow>MAKE_BASIC_PIPE
- 5-prompt-per-tile：控件版本需要核对：WildcardPromptFromString；缺少节点定义，无法转换控件：WD14Tagger|pysssss
- 6-DetailerWildcard：缺少节点定义，无法转换控件：UltralyticsDetectorProvider；缺少节点定义，无法转换控件：workflow>MAKE_BASIC_PIPE
- leapfusion_hunyuuanvideo_i2v_native_testing：控件版本需要核对：ImageResizeKJ

完整逐文件来源、哈希、模型和依赖见 deploy/autodl/mirror-inventory.json；原始 JSON 随网页与桌面资源一起打包。源文件经过凭据字段清理，SHA-256 记录审计原件。
