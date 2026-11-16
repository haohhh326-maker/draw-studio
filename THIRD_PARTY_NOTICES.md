# 第三方组件

Draw studio 原创代码适用根目录的 [MIT 许可证](LICENSE)。带有独立版权或许可证声明的文件适用各自条款。

- AIFISHER 工作流读取与 RunningHub 服务源码位于 [vendor/aifisher](vendor/aifisher/README.md)，适用 [AIFISHER Noncommercial Source License 1.0](vendor/aifisher/LICENSE)，包含非商业使用限制。来源版本和逐文件校验记录见 [SOURCE.json](vendor/aifisher/SOURCE.json)。应用的集成边界见该目录 README。
- 原生文件传输集成及完整上游源码位于 [native/cloud-transfer](native/cloud-transfer/README.md)。FileZilla、fzSSH、libfilezilla、Nettle、Boost 及 IPC 适配器的许可和归属声明随源码保留，其中包含 GPL 和 AGPL 条款。
- Muse 集成的上游 MIT 声明位于 [licenses/muse2api-MIT.txt](licenses/muse2api-MIT.txt)。
- AutoDL 自定义节点的 MIT 声明位于 [deploy/autodl/custom_nodes/canvas_flowmatch/LICENSE.TXT](deploy/autodl/custom_nodes/canvas_flowmatch/LICENSE.TXT)。
- 历史导演模块保留于 archive，其上游声明位于 [archive/retired-director-20261025/vendor/minimax-director/LICENSE](archive/retired-director-20261025/vendor/minimax-director/LICENSE)。
- 首页图片来源记录位于 [public/home/SOURCES.md](public/home/SOURCES.md)。服务品牌素材用于标识对应服务。
- npm 依赖、Electron、Chromium、FFmpeg 等组件适用各自许可证。桌面安装包的 licenses 目录保留构建使用的声明和原生组件对应源码。

构建时通过 `DRAW_STUDIO_WORKFLOW_SOURCE` 提供的工作流和旧客户端资源，适用其提供者的许可。
