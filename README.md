# Draw studio

Windows x64 安装包与版本说明见 [GitHub Releases](https://github.com/haohhh326-maker/draw-studio/releases)。

可运行的无限画布：素材节点 → 节点下方生成面板 → 选择云端 ComfyUI、RunningHub 工作流、RunningHub AI 应用或 Muse → 生成结果保存为画布素材并回写原节点。下文的 ComfyUI 传输与任务目录章节只描述云端 ComfyUI 执行链。

桌面版内置本机服务，按设置连接 ComfyUI、RunningHub、Muse 和 DeepSeek。ComfyUI 的连接设计见 [DIRECT_COMFYUI.md](DIRECT_COMFYUI.md)。完整提示词的已实现和未完成项目见 [REVIEW.md](REVIEW.md)。

**本地工作流目录的 2026-10-02 接入记录见 [LOCAL-WORKFLOW-LIBRARY.md](LOCAL-WORKFLOW-LIBRARY.md)。当前可在画布中读取本地 ComfyUI 工作流，并分别管理 RunningHub 原生工作流与 AI 应用；目录数量和适配数量以界面实时结果为准。读取成功不代表目标工作站已安装全部节点和模型。**

## 启动

需要 Node.js 22.12+。Windows 在项目目录执行：

```powershell
npm ci
npm run dev
```

访问 http://127.0.0.1:1420 。日常使用双击根目录 `Start-Canvas.cmd`：Windows 独立启动后台守护服务并打开浏览器，服务退出后自动恢复，登录 Windows 时自动启动。服务不再依赖 Codex 的终端进程组；更新或关闭 Codex 不会主动停止画布。已有服务直接复用，重复启动不会创建多个守护实例。注册使用当前用户普通权限，不保存密码；Windows 拒绝计划任务注册时使用当前用户启动快捷方式和 Windows 独立进程启动器。首次缺少构建产物时自动构建，修改代码后运行 `scripts/start.ps1 -Rebuild` 更新构建。

双击 `Stop-Canvas.cmd` 可停止并禁用自动启动，再双击 `Start-Canvas.cmd` 恢复。`powershell -NoProfile -File scripts/local-service.ps1 -Action Status` 查看状态，`-Action Remove` 移除本项目自动启动注册，不删除项目或素材。后台日志位于 `.cache/local-service.log`、`.cache/preview.stdout.log` 和 `.cache/preview.stderr.log`。登录启动行为采用 [Windows 当前用户计划任务](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)，恢复机制使用固定 1420 端口，不会关闭占用端口的无关程序。

```powershell
npm run build
npm run preview
```

Windows 桌面版使用 Electron，附带本机服务、Chromium、FFmpeg、FFprobe，以及工作流与 Skill 目录。开发目录首次启动前执行：

```powershell
npm run build
npm run desktop:prepare
npm run desktop
npm run desktop:build
```

安装程序生成在 `release/Draw-studio-0.1.2-Windows-x64-Setup.exe`。构建前安装 Playwright Chromium（`npx playwright install chromium`），将 FFmpeg、FFprobe 加入 PATH，并按照 [原生组件构建说明](native/cloud-transfer/README.md) 准备 WSL 文件传输组件。

可通过 `DRAW_STUDIO_WORKFLOW_SOURCE` 指定附带的工作流目录。本机兼容默认目录为 `E:/123/DFCine/DFCine0.26/workflows`，该目录不存在时构建标准空目录。首次启动会把资源复制到应用用户数据目录下的 `workspace`，后续启动补充缺少的文件，并保留用户编辑。工作流源相邻的 `resources/app.asar` 存在时一并附带，用于读取旧 `.dfenc` 工作流。

桌面版在画布内显示 Muse / DeepSeek 实时网页。网页项目可使用原有 `.aicanvas` 导出和导入入口迁移到桌面版。FileZilla 文件传输组件使用 Windows 上的 WSL、Ubuntu-22.04 及其 Linux 运行库，本机测试会实际检查引擎版本。

桌面版启动后检查新版，在“软件更新”中查看版本说明、下载安装包及安装。下载支持进度显示和失败重试，关闭面板后仍可继续查看。安装前校验文件 SHA-256 并保存当前项目。

默认更新源由 `build/desktop/software-update.json` 配置并随安装包附带。应用用户数据目录的 `software-update.json` 可用非空 `feedUrl` 覆盖默认源。HTTPS 清单包含 `version`、可选的 `notes`，以及 `windows` 内的 `url`、`sha256` 和可选的 `size`。使用 `npm run desktop:release:manifest -- --installer-url <HTTPS安装包地址> --notes <更新说明>` 从实际安装包生成 `release/latest.json`，将安装包和清单上传到同一 GitHub Release 后发布。

## 许可证

Draw studio 原创代码采用 [MIT](LICENSE)。AIFISHER 组件带有非商业使用条款，原生传输组件包含 GPL / AGPL 许可。各组件的适用范围和来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 已实现

- 深色点阵无限画布，10%–400% 缩放、平移、吸附、框选、多选、移动、缩放节点、复制粘贴、删除、Undo / Redo、编组 / 取消编组、Bezier 连线、Mini Map、Fit View。
- 右键菜单统一为“参考、视频、文本、音频、图像”。图片和视频读取原始尺寸、自动适配节点比例并完整显示；批量上传按实际宽度留出间距。悬停时右下角双箭头打开预览，双击不会预览或缩放画布。可右键更换素材并保留连线；旧素材恢复时补齐尺寸。
- 视频、图像和音频在原节点展示生成结果；视频只保留“视频”一个添加入口。视频素材通过参考上传并连入生成节点。
- 图片、视频节点和放大预览支持滚轮局部缩放；预览只显示画面和图标，右下角可全屏。视频采用深色自定义播放与三点菜单，左上角 S / N 将视频首帧 / 尾帧保存为 PNG 图片节点并连接原视频；重复点击复用，提取帧和连线随项目保存，操作支持撤销。
- 节点下方的生成面板；点击空白关闭；普通 Prompt 无需连线。文本节点也可连接视频、图像或音频生成节点，多个文本按连接顺序拼接，再追加面板补充描述；只有连接文本时面板可留空。文本内容进入任务快照，不作为媒体上传。
- 空白处左键 / 中键拖动平移；Shift + 拖动框选，节点保持左键移动。
- 生成节点右上角显示用时，从点击生成到结果保存；完成、失败或取消后停止，刷新和任务恢复沿用原始时间。
- 工作流分为音乐、图像、视频、文本四类；Qwen3.5 提示词反推归入文本。文本节点支持选择工作流，结果回写原文本并继续作为下游提示词。按定义渲染参数；种子旁交叉箭头随机新值；MiniMax H3 百万像素每次增加 0.1、时长每次增加 1 秒；比例菜单采用深色样式。
- 画布空白处右键添加节点，按点击位置落点。后台适配器处理语义映射和输出配置；工作流读取、绑定与管理可从设置和画布中的相应入口打开。
- ComfyUI HTTP / WebSocket 客户端、延迟上传、任务队列、真实进度事件、HTTP 恢复查询、输出下载、错误解释。
- 项目首页 → 新建或打开项目 → 空白画布；退出时保存并回到项目列表，原项目长期保留，各项目的画布、素材、任务和工作流配置独立。支持多画布和包含原始素材的 .aicanvas 导入 / 导出。原单项目存档自动迁移到列表。
- 独立持久任务表、不可变提交快照、生成历史与原节点版本恢复。
- 图片缩略图缓存、可见节点渲染、视频悬停预览、Object URL 引用释放。

顶部语言入口目前说明中文界面 / 中英文提示词；没有完整英文界面。星光按钮可调用 DeepSeek 优化提示词，具体可用性取决于账号连接。SSH / FRP / Cloudflare 使用你已经建立的 HTTP 隧道地址，软件不会代建隧道。

## 接入真实工作站

1. 设置中填写 ComfyUI 服务地址、Token 和鉴权头。测试并保存，无需部署 Bridge。实时连接地址根据服务地址自动推导，不再提供单独设置项。
2. 右键画布空白处添加图像、视频或音频节点，拖入并连接素材。
3. 点击生成节点，在下方面板选择已配置的生成能力、输入提示词并生成。

可在设置的“工作流目录”读取并核对云端 ComfyUI 工作流；RunningHub 工作流与 AI 应用有各自的导入和管理入口。工作流读取会保留原始定义，执行前仍需确认目标服务支持所需节点、模型和参数。

本机服务现在按 `workflow-library.settings.json` 读取本地库，转换配置绑定并与内置目录合并。设置中的“本地工作流目录”显示来源、接入数量和逐目录问题，支持手动刷新。原始配置 ID 用于保持旧节点引用，不按相似名称替换执行图。此前的配方和运行记录保留为历史资料。**模型清单是工作流声明的需求，不代表云端已安装。**

图生视频 / 图生图：AUTO 图像 → image。首尾帧：按连接顺序分配 firstFrame / lastFrame，可交换。多参考：按定义支持 images / referenceImages、videos / referenceVideos、audios / referenceAudios；同类素材按连线顺序排列；角色 / 场景 / 风格参考可手动指定。未知或超出映射容量的输入会被拒绝，不会静默丢弃。

多张参考图可映射 referenceImages 的索引 0 / 1 / 2 到不同加载器；留空表示整个数组。不要把语义字段绑定到 ComfyUI 的节点链接数组，否则会破坏工作流，适配器会拒绝提交。

## 直连传输与任务目录

- 图片、视频、音频统一 POST /upload/image，multipart 字段为 image，type=input，overwrite=false，subfolder=infinite-canvas/<taskId>。实际文件位于服务器 input/infinite-canvas/<taskId>/。
- 上传成功立即持久化服务器返回的 name、subfolder、inputName；以返回路径注入模板。同一任务内重复引用同一资产只上传一次。
- 常见输出节点的 filename_prefix 自动注入 infinite-canvas/<taskId>/result；其他前缀字段可由后台 WorkflowDefinition.output.prefix 指定。没有前缀参数的节点沿用自身输出路径；所有输出都以 history 文件描述为准。
- 保存实际 executionWorkflow 后 POST /prompt；保存 promptId 后监听 ws，断线时通过 history/queue 查询。
- history 的输出清单先落盘，再逐个 GET /view；每个文件下载并存入本地后保存 downloadedOutputs。下载中断后仅补下缺失文件，即使 history 已清理也可以用已保存的描述继续下载（远端文件仍须存在）。
- 视频、音频是否可运行取决于目标工作流的加载节点是否支持相对 input 路径和该文件格式；客户端不假定上传即代表模型可用。未内置远端文件清理接口，任务目录由服务器维护。

## 新任务逻辑：只有一套执行链

节点的 `generation` 只引用 `taskId`，不再保存旧 `task` 对象或 `phase` 状态。所有当前状态来自 `Project.tasks[taskId]`：

| 字段                          | 含义                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| taskId                        | 每次生成的本地 UUID，提交前创建并持久化                                                                        |
| promptId                      | ComfyUI 返回的服务器任务 ID；提交确认前为 null                                                                 |
| executorType                  | comfyui、runninghub 或 muse；按所选服务执行，不回退到其他服务                                                   |
| status                        | uploading / submitting / queued / loading / generating / saving / completed / failed / cancelled / interrupted |
| requestId / clientId          | 处理提交响应丢失、隔离服务器事件                                                                               |
| workflow / input / connection | 原始工作流、提示词、实际随机种子、素材角色和端点快照                                                           |
| outputs                       | 已持久化的本地结果素材 ID                                                                                      |

- 提交前强制落盘。拿到 promptId 后再次强制落盘。保存失败不会开始新的远端生成。
- 随机种子 -1 保留为界面选择，每次任务记录实际 seed，重启恢复时不重新随机。
- 恢复只查询原 promptId；不会再次 POST /prompt，也不会依赖后来修改的节点参数或工作流。
- 提交响应丢失时保留 interrupted：使用 requestId、唯一 clientId 在队列 / 最近历史中查询，找不到也不自动重提。
- 原任务未解决时阻止同节点再次生成，避免意外双重费用。
- 旧任务完成后只有在节点仍引用该 taskId 时才更新预览；否则只保存结果与历史。
- 应用重新打开会恢复已知 promptId 的未完成任务。鉴权 Token 不落盘，需再次在设置中填写，然后在任务面板恢复查询。
- 服务端明确执行错误标记 failed；网络断开或下载失败保留 interrupted；不会把网络断开伪装为取消。
- 取消优先使用按 job ID 的接口。旧服务器只安全删除排队中的指定任务；无法安全取消正在执行的任务时提示用户，绝不无条件调用全局 interrupt。
- `projects/migrate.ts` 仅用于一次性读入旧 v1 存档并转成 v2；迁移后删除旧字段，不存在旧执行链或双写路径。

## 存储与连接边界

桌面版在 Electron 用户数据目录的本地 IndexedDB 中保存项目、任务、工作流、原始素材和缩略图。配套工作流与 Skill 文件展开到同一用户数据目录下的 `workspace`。程序安装目录与用户数据目录分别由安装程序和 Electron 管理，升级后继续打开已有桌面项目。

浏览器：IndexedDB 的 project-library 保存各项目与能力配置，媒体单独保存为 Blob；当前打开项目仅在本标签页 sessionStorage 记录 ID，刷新可继续，退出或新标签页回到首页。不会把 Blob URL 写入项目。

导出 .aicanvas 是包含 project.json、workflows.json、assets/ 的 ZIP，便于备份和迁移。素材缩略图可以重新构建，原始媒体不丢失。大量高清视频项目的导出目前在内存中打包，建议分项目管理。

ComfyUI / 反向代理需要允许画布页面的跨域来源。网页 WebSocket 无法附加自定义鉴权头，设置 Token 时使用带鉴权 HTTP 查询。网络错误显示实际连接状态，进度百分比采用服务器节点上报的数据。

## 验证

```powershell
npm test
npm run build
npm run test:e2e
```

Windows 浏览器测试使用已安装的 Edge。其他平台先安装 Playwright Chromium：`npx playwright install chromium`。

测试包含工作流语义 / 首尾帧 / 模板不可变、持久任务恢复、同节点回填、失败场景、浏览器交互、素材导入与项目恢复、500 节点虚拟渲染。API 测试使用独立测试环境的协议夹具，不代表 AutoDL 真实模型验收。

详细设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，验收结果见 [VERIFICATION.md](VERIFICATION.md)。

## 协议参考

- [ComfyUI Server Routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI WebSocket Messages](https://docs.comfy.org/development/comfyui-server/comms_messages)
- [ComfyUI server.py：任务取消接口](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)
- [Tauri WebSocket 插件](https://v2.tauri.app/plugin/websocket/)
- [React Flow API](https://reactflow.dev/api-reference)

文本节点上方的图标条用于移动节点，下方区域用于编辑。生成面板默认使用图标表示连接输入，悬停显示来源和就绪状态，图标点击不展开任何内容。图片或视频结果就绪后，原位置自动替换为内容缩略图，文本保留笔记本图标。鼠标悬停时显示图标右上角的叉号，可断开该输入连接，保留源节点与素材，支持撤销；生成期间暂停移除。需要指定首帧、尾帧等用途时，在“高级参数”中调整素材角色。项目首页为完全不透明的独立页面，退出项目后卸载画布。

项目卡片提供“删除”和“存放路径”。删除前会确认，确认后直接从项目列表永久删除，画布内没有回收站；不会删除独立导出的文件。项目库仅保留删除 ID 标记，防止旧标签页的待保存数据把项目重新创建。存放路径是在本机项目库之外保存含媒体的 .aicanvas 副本：选择目录时立即保存，退出项目时同步。浏览器使用 File System Access API 并保存目录句柄；权限失效时需从路径设置重新授权，不支持此 API 的浏览器可导出项目。浏览器只能显示所选文件夹名称；桌面版可显示完整路径。取消目录同步不会删除旧文件。

## DFCine 目录与参数

本地 DFCine 工作流选择器按“音乐画布 / 图像画布 / 视频画布 → 模型或工具系列 → 工作流”排列。导入的云端与 RunningHub 工作流按实际输出分类；当前数量取决于用户选择的目录与已导入的工作流。Klein 高清放大在两个系列各保留一个入口，共享同一份原始配置。

选择工作流后可查看素材要求、节点、模型和参数的读取结果；实际可运行性由当前工作站与工作流绑定决定。提交前会对目标服务器核对输入及所需能力，并明确提示缺失。打开旧项目时保留已有节点、素材、连线和任务快照；旧节点可能需要重新选择当前目录中的工作流。

逐项来源与缺失情况见 [DFCINE-DIRECTORY-AUDIT.md](DFCINE-DIRECTORY-AUDIT.md)。配置导入脚本为 `scripts/import-dfcine-directory.py`，执行图导入脚本为 `scripts/import-dfcine-execution.mjs`，只读访问客户端文件。旧插件示例的公开文件移入 `archive/retired-catalog-20260927/mirror`，不再随应用发布。旧 [MIRROR-COVERAGE.md](MIRROR-COVERAGE.md) 和 [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md) 仅供历史追溯。
