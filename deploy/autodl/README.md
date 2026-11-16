# AutoDL 6008 画布入口

当前实例的 ComfyUI 保持运行在 6006，画布服务单独运行在 6008。ComfyUI 中的 `CanvasEntry` 插件将现有公网地址的 `/canvas/` 转发到 6008；画布使用 `/canvas/comfy/` 访问标准 ComfyUI HTTP / WebSocket 接口。

当前公网入口：

- 6008 直接入口： https://uu1159393-7896c7f82fde.westd.seetacloud.com:8443/
- 6006 转发入口： https://u1159393-7896c7f82fde.westd.seetacloud.com:8443/canvas/

6008 根地址会自动跳转到 `/canvas/`。两个地址已同时登记到 `canvas.env` 的 `CANVAS_ALLOWED_ORIGINS`。镜像启用 `CANVAS_AUTODL_ORIGINS=true`，允许本机网关转发的当前 AutoDL Art 域名使用同源 HTTPS；新实例域名无需修改固定白名单。自定义域名仍需显式登记精确 origin。

## 已部署文件

- 画布：`/root/draw-studio`
- 独立服务：`server.mjs`
- 页面：`dist/`
- 工作流：`workflows/library/`
- 配置：`canvas.env`
- 启动：`deploy/autodl/start-canvas.sh`
- 启动入口：`deploy/autodl/start-stack.sh`
- 启动守护检查：`deploy/autodl/ensure-canvas.py`
- 画布守护：`deploy/autodl/canvas-supervisor.py`
- Node：`/root/draw-studio/runtime/node-v24.13.1-linux-x64/bin/node`
- ComfyUI 转发插件：`/root/ComfyUI/custom_nodes/CanvasEntry/__init__.py`
- 日志：`canvas.log` 和 `comfy-start-*.log`

开机命令为 `bash /root/draw-studio/deploy/autodl/start-stack.sh`。`/root/start-comfyui.sh` 同时保留兼容入口，原脚本备份于 `backups/start-comfyui-before-image.sh`。启动先确认画布健康再启动 ComfyUI；画布崩溃会自动恢复，flock 防止多个启动检查重复创建服务。6006、监听地址和 CORS 参数保持原实例配置。

2026-10-03 已将当天本地最新版前端及云端服务部署到上述目录。现场 ComfyUI 为 0.38.1、前端 1.53.6、Node 24.13.1；66 个模型链接均存在，依赖 AutoDL Art 的公共模型挂载，没有将模型权重复制进镜像。版本、插件和模型目标保存在 `image-runtime.json`，部署文件校验与启动命令保存在 `image-release.json`。

私有镜像名称：`Draw studio 2026.10.03`，UUID：`image-822868bbe8`，控制台大小 4.83GB（状态“就绪”）。保存状态及验证记录见 `cloud-image-20261003.json`。新实例开机启动命令应为上面的 `start-stack.sh`；镜像列表已保留该命令。

## 构建

使用项目依赖中的 esbuild 将 `scripts/cloud-server.ts` 打包为 `server.mjs`，格式 ESM、平台 node。前端构建需设置 `VITE_CANVAS_CLOUD=true`，Vite base 为 `/canvas/`。本地桌面构建不设置该变量，继续使用原有连接配置。

`canvas.env` 中 `CANVAS_ALLOWED_ORIGINS` 可配置多个逗号分隔的准确 HTTP/HTTPS origin。AutoDL 自适应仅认可 loopback 网关的严格 `u/uu + 用户ID + 实例ID + seetacloud.com` Host，不读取 `x-forwarded-host`，拒绝其他实例来源、HTTP 和跨端口来源。请求不能通过参数指定任意上游服务，也不能通过 `/canvas/comfy/canvas/` 循环进入画布。

## 工作流与项目

当前云端库保留云端已有的 76 项、223 个文件，7 项保留适配提示；更新前后文件校验一致。这些数量不代表已完成全部生成验收。云端删除接口现已完整转发，不再返回静态资源 405。

云端“添加工作流”写入云端目录。本地 1420 版继续读取电脑的 E 盘目录；之后新增的本地文件不会自动同步到云端，可在云端入口重新导入。项目与素材仍由当前浏览器保存，电脑原有项目没有上传；访问另一个 origin 时不会自动出现原电脑项目。

已验证两个入口的完整前端资源与本次云构建逐字节一致，工作流读取、无效删除校验、`system_stats`、`queue`、`object_info` 与带正确 Origin 的 WebSocket 均可用。已验证三个并发启动检查及 Node 进程退出后的自动恢复。本次没有下载模型，也没有提交生成任务。

镜像保存就绪后，原实例已重新开机，画布与 ComfyUI 自动启动。两个入口的全部前端文件、上述接口与 WebSocket 再次通过检查；重启后 Qwen 2.1 模型和文本编码器可用，标准 LoRA 列表含 17 项。未另外租用新实例加载此镜像，尚未做全部工作流的真实生成验收。
