# 本地工作流目录接入

本机网页默认读取 `E:/123/DFCine/DFCine0.26/workflows/library`。路径配置在项目根目录的 `workflow-library.settings.json`；修改这个文件后，在工作空间设置中点击“刷新目录”即可重新读取。源目录、配置、执行文件及云端镜像均只读。

## 已实现

- Vite dev 和 preview 均提供固定的同源本机接口 `GET /__canvas/workflow-library`，不接受任意路径或查询参数，也不开放源目录的静态文件访问。
- 扫描每个工作流子目录的 `workflow.config.json`；有效配置即注册入口，执行适配独立处理。支持普通 API JSON，以及本机已识别默认容器格式的 `.dfenc`。不支持的执行器或执行文件也保留入口，并显示具体原因。
- `.dfenc` 默认读取器只取自源客户端 `resources/app.asar` 中已识别的读取格式，不读取账户、私钥或私钥环境变量。其他容器格式会报错。
- 输入素材的旧机器路径被清空；生成时通过标准上传接口将任务路径填回绑定字段。最终输出前缀按任务隔离。
- 分类、系列和数量根据实际工作流定义计算。“视频转换”由源配置 `primaryCategoryLabel` 提供；“视频转深度”由 `nameLabel` 提供。
- 启动、进入项目、打开工作流选择器和手动刷新均重新读取目录。保存完整库快照；目录不可读时明确显示离线缓存状态。删除文件夹后入口、系列、分类数量随下一次成功读取更新，旧项目不能恢复已删除的入口；成功读取空目录也保持为空。
- 取消固定目录自动补回，旧定义仅用于原始 `id` 与旧节点 ID 的兼容映射。同一来源只显示一条入口，旧别名解析到这一条；任务记录仍使用提交时的不可变工作流快照。没有完整目录缓存且读取失败时，只保留独立导入的自定义工作流。

## 当前源目录核对

2026-10-02 本地核对：87 个目录全部注册，68 个 ComfyUI 工作流成功转换；19 个 `runnerType=api` 入口显示执行器尚未支持。实际数量以刷新结果为准。`VideoDeep` 文件夹已由用户删除，本次扫描不再包含对应入口。

`Qwen-Image21-Edit` 和 `Qwen-Image21-T2I` 使用节点 461 的 `SaveImageAdvanced`，结果读取 history 的 `images`。`Qwen-Prompt-Reverse` 使用唯一节点 2 的 `easy showAnything`，读取 history 的 `text` 并回写工具节点；提交时仅保留该输出的上游分支，不执行额外的 `Save Text File` 文件写入分支，原始源文件保持不变。输出契约参考 [ComfyUI 保存节点源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_images.py) 和 [Easy Use 文本显示节点源码](https://github.com/yolain/ComfyUI-Easy-Use/blob/main/py/nodes/logic.py)。

此前 `VideoDeep` 的执行绑定如下（删除后不会作为当前入口显示）：

| 项目 | 绑定 |
|---|---|
| 输入视频 | 节点 1，`inputs.video`，使用 ComfyUI input 相对任务路径 |
| 分辨率 | 节点 3，`inputs.resolution`，默认 704 |
| 处理 | `DepthAnythingPreprocessor`，声明 `depth_anything_vitl14.pth` |
| 输出 | 节点 4，`VHS_VideoCombine`，history 的 `gifs` 字段 |

该接入核对没有提交云端生成任务。点击生成前仍会查询目标 ComfyUI 的节点和模型选项；本地能读取执行图不代表云端依赖已经满足。

## 添加自己的工作流

在库中创建一个独立文件夹，放入 `workflow.config.json` 和配置声明的 `workflow.api.json`。编辑器 JSON 可另存作源文件，执行文件必须为 API 格式。

配置需声明稳定且唯一的 ID、输出类型、显示名称及系列。有效配置读到后即加入画布；执行文件、绑定或输出尚未支持时也会显示，并保存适配原因。要通过当前 ComfyUI 执行器生成，还需 `runnerType: "comfyui"`、API 执行图和准确的输入及参数绑定。素材绑定和参数绑定使用 `nodeId` 与 `inputs.<字段名>`；不允许覆盖节点连接。多输出、特殊输出和未支持的绑定不会随意挑选结果。模型与插件仍由所连接的 ComfyUI 提供。

添加、修改或删除文件夹后，打开工作流选择器或点击“刷新目录”即可同步。当前没有将单独的任意 JSON 自动猜测为完整生成能力。

## 运行边界

目录接口在本机 Node/Vite 服务中运行，覆盖当前 `http://127.0.0.1:1420` 以及 Vite 开发服务。打包后的 Tauri 不运行 Vite，需要另行提供原生目录读取命令；桌面正式安装包尚未构建。本轮没有把未实现的原生命令算作已交付功能。
