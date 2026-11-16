# 云端插件与画布入口检查（2026-10-02）

云端画布已部署在 6008，当前直接入口为 [6008 画布](https://uu1159393-7896c7f82fde.westd.seetacloud.com:8443/)，同时保留 [6006 转发入口](https://u1159393-7896c7f82fde.westd.seetacloud.com:8443/canvas/)。6008 根地址会自动跳转到 `/canvas/`；6006 根路径仍为 ComfyUI。

## 插件安装与注册

| 官方插件 | 安装版本（Git commit） | 当前已注册的所需节点 |
| --- | --- | --- |
| ComfyUI_Comfyroll_CustomNodes | d78b780ae43fcf8c6b7c6505e6ffb4584281ceca | CR Prompt Text |
| ComfyUI_LayerStyle | a3459a7638c4c2839878089c105c73af0eb2edd2 | LayerUtility: ImageReel；LayerUtility: ImageReelComposit |

使用实例既有 `/etc/network_turbo` 加速 GitHub。Comfyroll Git 下载约 1.2 MiB/s；LayerStyle 稀疏读取必要源码、字体和前端文件，并补齐初始化文件，没有下载模型。只补装 `blend_modes==2.2.0` 的 9,533 字节官方 wheel，没有升级 PyTorch 等已有核心环境。

Node 24.13.1 官方 Linux 包为 31,008,136 字节，7.61 秒下载，平均 3.89 MiB/s，通过官方 SHA256 校验；画布部署包上传平均 2.47 MiB/s，上传后校验一致。部署目录为 `/root/autodl-tmp/clearframe-canvas`。

## 实际公网检查

- ComfyUI 根页面、画布页面及页面引用的 JavaScript / CSS / 图标资源均返回 HTTP 200。
- 工作流目录返回 76 项，69 项已解析执行模板，7 项仍有适配提示；没有据此宣称所有工作流均已生成跑通。
- `/canvas/comfy/system_stats`、`/queue`、`/object_info` 返回 HTTP 200；ComfyUI 版本 0.37.0。
- `/object_info` 当前有 2,588 个节点类，本次所需三个节点全部注册成功。
- 公网 `wss://…/canvas/comfy/ws` 收到 ComfyUI `status` 消息，队列余量 0。
- 重启前后生成队列为空，没有提交生成任务。
- 已在用户 Edge 浏览器中刷新 6008 直接入口，正常显示“我的项目”首页，并保存 `CLOUD-6008-FIX-20261002.png`。两个入口的页面、引用资源、目录、ComfyUI 接口和带准确 Origin 的 WebSocket 均通过实际公网请求检查。

## 按要求未下载的模型

以下文件仍未出现在对应 ComfyUI 加载器的模型列表中：

| 文件 | 对应加载器 |
| --- | --- |
| qwen_image_2.1_bf16.safetensors | UNETLoader.unet_name |
| qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors | CLIPLoader.clip_name |

这是模型列表检查结果，不等于确认整个云机所有存储位置都不存在这些文件。本次只安装插件，不移动、不替换、不下载模型，未验收该 Qwen 工作流的实际生成。

## 软件验证与恢复

最终全套测试 33 个文件、426 项通过，TypeScript 检查及桌面／云端构建通过。转发插件另有 7 项模拟集成检查通过。

6008 直接入口修复：原配置只有 `u1159393` 的 6006 地址，实际 6008 使用 `uu1159393`，因此被来源校验拒绝。已追加其准确 origin，仅重启 Node 6008；未重启 ComfyUI。新补的双入口回归覆盖页面、目录、POST 导入、HTTP / WebSocket 代理及交叉来源拒绝；云端服务 10 项测试和 TypeScript 检查通过。配置备份为 `/root/autodl-tmp/clearframe-canvas/canvas.env.before-6008-20261001T221139Z`。

原启动脚本备份：`/root/start-comfyui.sh.canvas-deploy-backup-20261001T215923Z`。入口配置和手动启动方法见 [部署说明](deploy/autodl/README.md)。当前是实例部署，尚未在 AutoDL 控制台另存为新镜像。

云端工作流为部署副本；本机 E 盘目录、原有项目和素材没有被上传或替换。云端项目继续保存在访问该入口的浏览器中。
