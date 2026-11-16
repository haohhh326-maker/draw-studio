# Product & implementation architecture

本轮直连架构决策及与新提示词的覆盖关系见 [DIRECT_COMFYUI.md](DIRECT_COMFYUI.md)。

## 1. Product architecture

Project → Scene → Canvas → 素材 / 创作节点。生成节点也是结果节点；提示词可来自生成面板或连接的文本节点；模型和工作流不成为画布节点。

## 2. Technical architecture

React 19 + TypeScript + Vite 7；React Flow 12；Zustand 5；Lucide；原生 CSS 与轻量 CSS 动画。浏览器实现使用 IndexedDB。开发用的 `desktop:live` 通过 Electron WebContentsView 在画布内显示 Muse / DeepSeek 实时网页；Tauri 2 桌面构建另提供 HTTP / WebSocket 插件、Rust SQLite / 本地文件命令。没有额外的常驻 Python 中间服务。

## 3. UI architecture

顶部画布标签栏、悬浮左工具栏、低对比点阵画布、右下 Mini Map。生成面板锚定选中节点，面板不会成为画布图节点。面板内操作不传播到空白选择事件。设置包含云端 ComfyUI、RunningHub 工作流、RunningHub AI 应用和 Muse 入口；工作流目录、远端工作流及 AI 应用可在各自界面读取和管理。Muse / DeepSeek 网页窗口由桌面开发壳内的真实浏览器视图承载。

## 4. State architecture

Project 持久数据：scenes、canvases、assets、tasks、history。
Canvas 独立保存 nodes、edges、viewport。
瞬时 UI：selectedId、selectedEdgeId、modal、toast。
运行资源：AbortController 和客户端连接仅存在会话表，不作为任务真相来源。
生成期间暂停 Undo / Redo，避免回滚远端执行；任务记录不随节点删除而消失。

## 5. Node data model

CanvasNode = React Flow Node<NodeData>。
NodeData：title、kind、assetId、text、generation。
Generation：prompt、negativePrompt、workflowId、params、taskId。
结果写回 assetId；绝无 result 节点类型。

## 6. Edge data model

CanvasEdge = source、target、data.role、data.order。
单个左输入 / 右输出 handle；角色由独立 SemanticInputResolver 解释。
默认 AUTO，支持主图、参考图、首尾帧、角色 / 场景 / 风格参考、视频、蒙版、音频。拒绝循环和重复源-目标连线。

## 7. Workflow definition

id、family、name、description、mode、requiredInputs、optionalInputs、parameters、mapping、output、template。output.prefix 可指定输出前缀字段。
模板保存原始 API 图；参数支持 number / text / select / boolean。
每个映射包含 semantic、nodeId、field，可选 index。output 保存 nodeId、field、kind。

## 8. Workflow adapter

按连线顺序收集素材，先保留显式角色槽位，再自动分配。文本由 semantic/prompt.ts 单独解析并保存来源快照，不进入媒体上传；合并顺序为连接文本，再追加面板提示词。
验证必需输入、媒体类型、重复角色、映射容量、参数范围、目标字段。
深拷贝模板后写入语义值，禁止覆盖 ComfyUI 图连接；不修改原模板。
seed=-1 仅在新任务创建时解析；恢复使用固定实际种子。

## 9. ComfyUI client

集中负责 system_stats、object_info、upload/image、prompt、queue、history、view、任务取消、ws。图片、视频、音频统一使用标准 upload/image 文件上传协议；已删除自定义视频上传路径和字段配置。没有必需的 AutoDL Bridge。
HTTP 超时 / 状态错误在客户端统一处理。上传采用 UUID 文件名与 input/infinite-canvas/<taskId>/ 目录隔离；上传清单和实际执行图持久化。
任务事件严格按 prompt_id 过滤；事件缓存处理 HTTP 排队响应与快速 WebSocket 执行之间的竞态。
WebSocket 不可用时轮询历史和队列；输出只根据指定节点的文件描述下载，不加载未知外部链接。

## 10. Generation lifecycle

创建 durable task → 强制保存 → 连接和节点预检 → 按需上传并保存清单 → 克隆模板注入输入和输出路径 → 保存 executionWorkflow → queuePrompt → promptId 并保存 → 监听 / 查询 → 保存 remoteOutputs → 逐文件下载、写本地素材并保存 downloadedOutputs → 原节点更新 + 历史 + completed → 保存。

任务执行器由 executorType 路由，支持 comfyui、runninghub 和 muse；RunningHub 工作流与 AI 应用在界面和绑定上分别管理。未知类型拒绝执行。

恢复使用完整任务快照及下载清单；不得再次调用 queuePrompt。提交结果不明确时查询原 requestId / clientId，等待用户核查，不盲目重提。所有关键状态可在任务详情查看。

## 11. Directory

```text
src/
  app/                  主界面与样式
  assets/               文件导入、缩略图、引用计数 URL
  canvas/               React Flow 与画布编辑操作
  nodes/                素材和创作节点
  generation/           面板、任务生命周期与执行器
  workflow/             分类入口、API 格式解析
  semantic/             独立输入语义解析与媒体分类
  workflow-adapter/     模板克隆、字段映射与输出前缀注入
  comfyui/              HTTP / WebSocket
  projects/             IndexedDB、Tauri 存储、打包与迁移
  stores/               Zustand / Undo / 持久任务表
  settings/             算力连接设置与各服务入口
  runninghub/           RunningHub 工作流 / AI 应用读取、绑定与客户端
  muse/                 Muse 会话与客户端
  services/             Muse / DeepSeek 画布内实时网页窗口
  components/           通用模态框与按钮
  types/                共用数据类型
src-tauri/              桌面配置、Rust SQLite / 本地文件
tests/                  单元、生命周期、浏览器自动化
scripts/start.ps1       Windows 启动入口
```

## 12. MVP plan and acceptance boundary

前端项目、画布、节点、选择、面板、工作流库、映射、客户端、连接设置、持久化与软件层测试已实现。
真实生成连接口必须经用户实际工作站验收：文生图、图生图、文生视频、图生视频、首尾帧、参考视频、多参考。
Tauri 工程尚待具备 Rust/MSVC 的环境编译。
不把缺少服务器的集成条件写成已完成模型验收。

## 项目入口更新

首页是本地项目列表，新建项目才创建空白画布。project-library 按项目 ID 保存 Project 和 WorkflowDefinition 快照；媒体仍使用独立资产存储。保存串行执行，并在支持 Web Locks 的浏览器中锁定项目库的读取合并写入，避免另一标签页的新项目被旧列表覆盖。项目切换前严格保存并清空选择与撤销状态；正在生成时暂不允许退出。sessionStorage 只保存当前标签页打开的项目 ID，刷新继续当前项目，退出后清除 ID。旧 project 记录只在尚无项目库时迁移；场景选择 UI 已移除，历史场景字段仍可导入，画布标签不再按场景过滤。

项目卡片确认删除后，项目库只保留项目 ID 和 deletedAt 标记；画布内没有回收站或恢复入口。该标记用于拒绝旧标签页的待保存写入，避免项目复活；独立导出的文件不会随项目库删除。目录选择单独保存在 project-directory:<id>，不会随项目归档导出授权句柄。选择目录/主动保存/退出时写入完整 .aicanvas 文件，节点频繁自动保存仍写本机项目库；后台同步只查询权限，不弹出授权对话框。浏览器写入失败调用 abort，桌面先写临时文件再 rename。
