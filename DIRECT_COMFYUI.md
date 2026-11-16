# ComfyUI 直连架构决策

日期：2026-09-20。以本轮用户明确修订为准：正式取消必须经过 AutoDL Bridge 的架构。保留上一轮的右键添加节点和无工作流管理界面。

## 产品、界面与画布

素材节点和连线表达输入关系；提示词、能力选择和参数属于节点下方的 Generation Panel。生成节点同时显示结果，不创建 Result Node，不显示技术节点，不强制 Text Node 连线。画布引擎继续使用 React Flow；本轮不重写画布引擎。

## 执行分层

Canvas → Semantic Input Resolver → Workflow Adapter → Execution Snapshot / GenerationTask → ComfyUIClient → 云端标准 ComfyUI。

桌面网络通过 Tauri HTTP / WebSocket 插件直达配置的 ComfyUI 地址；网页预览使用浏览器网络。同一套客户端支持本地服务、AutoDL 端口代理及其他云服务器；AutoDL 只是部署位置，不写入工作流逻辑。没有 Bridge 服务、Bridge Endpoint 或额外任务 API 的必需依赖。

## 数据与状态

Project 保存 canvases、assets、tasks、history。Node 保存工作流引用、参数和 taskId；Edge 保存 source、target、role、order。Semantic Resolver 仅处理素材类型、角色和顺序，不操作 ComfyUI JSON。

GenerationTask 继续持久化 taskId、promptId、executorType、status。创建时固定提示词、参数（包括实际随机种子）、输入素材和工作流快照、无凭据连接快照。新增 staging 输入目录、已上传文件清单、实际提交 executionWorkflow、远端输出文件清单和已下载素材清单。旧任务缺失新增字段时仍可按原 promptId 恢复。

## 远端目录和传输

每次生成使用 input/infinite-canvas/<taskId>/。仅上传本次解析到的输入，同一素材只上传一次。图片、视频和音频均通过标准 POST /upload/image 的 multipart image 文件字段、type=input、subfolder、overwrite=false 上传。这个路由名不表示视频或音频会被转码；工作流必须使用能读取对应文件格式和相对路径的加载节点。

以上传响应中的 name/subfolder 为准注入工作流。禁止服务器绝对路径或目录穿越。支持的输出节点通过 filename_prefix 或后台指定的前缀字段写入 output/infinite-canvas/<taskId>/；不支持前缀的节点使用其既有 output 目录。结果定位始终以 history 返回的文件描述为准，不推测文件名。

## 提交、恢复与本地保存

本地预检 → 创建并保存任务 → system_stats / object_info 检查 → 素材上传和清单落盘 → 克隆模板并注入相对输入名、参数、输出前缀 → 保存实际执行图 → POST /prompt → 保存 promptId → ws / history / queue → 保存输出清单 → GET /view → 本地资产落盘 → 更新原节点、历史和 completed。

恢复只查询原任务或继续下载，不重新上传、不重新 POST /prompt。提交响应丢失时按原 requestId/clientId 查询，不能假定标准 ComfyUI 提供 Bridge 式幂等重试。已下载文件逐项保存，可跳过已成功下载的素材。恢复时节点已引用其他任务，则仅保留资产和历史，不覆盖新结果。

## 存储、安全与错误

桌面任务存 workspace.sqlite，媒体存本地 assets；浏览器测试预览使用 IndexedDB。Token 不进入项目或执行快照；现阶段仅会话保存，系统凭据库尚未实现。统一错误保留可恢复状态；下载失败不能导致 GPU 再次执行。所有远端文件仅通过已配置端点的标准接口访问。

## 实现目录及验收

comfyui/ 管理标准传输及文件路径，semantic/ 管理语义解析，workflow-adapter/ 负责模板注入，generation/ 管理持久任务，projects/ 管理本地资产和记录。settings/ 仅提供工作站连接。

本轮以任务目录隔离、混合媒体上传、不可变模板、提交前持久化、断线恢复、部分下载恢复及原节点回写为验收范围。协议测试与真实模型验收分开记录；没有实际服务器和工作流时不得声称真实生成已验证。Tauri 安装包仍需 Rust/MSVC 编译环境。

## 标准接口依据

- [ComfyUI 官方路由文档](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI server.py](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)：upload/image 的 multipart 文件保存、subfolder 和 type 返回、history/view，以及可选原生单任务取消。

可选原生 /api/jobs/{id}/cancel 是 ComfyUI 自身路由，不是 Bridge 依赖；旧版本没有此路由时退回标准 queue 删除，运行中的任务不会通过全局 interrupt 误停其他任务。
