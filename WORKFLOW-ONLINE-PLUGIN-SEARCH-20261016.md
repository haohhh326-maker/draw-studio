# 缺失节点的在线搜索与自动安装

原先的“当前目录未找到对应插件”指 Manager 插件索引没有匹配，不能说明网上不存在。现在导入流程在随附索引未匹配后直接在线搜索，查到并核验来源后交给当前小云朵连接的 Manager 自动下载安装。

## 搜索与安装

- 先处理 Manager 随附索引中的明确匹配，随后直接查询最新官方 Manager 插件索引与 Comfy Registry，跳过可能卡在刷新中的 Manager 缓存请求。
- Registry 搜索按节点类名进行，并核验具体插件版本实际包含该类；工作流明确保存的 cnr_id、aux_id 和版本不能被其他同名来源覆盖。
- 多个可用来源无法唯一确定时显示歧义。明确未收录、网络查询失败、版本不可安装、下载或加载失败分别记录，避免把查询失败当作没有插件。
- 部分候选核验失败时，不把另一个已经核验的候选当作唯一来源。Registry 拒绝的同仓库版本也不能通过 legacy/git 安装绕过。
- 真正找到的插件仍通过 Manager 安装队列处理，安装后读取实际节点定义；不以搜索成功或队列结束冒充节点已经可用。
- 保持无固定等待时限及主动取消；不清空他人安装队列，不重启正在生成的工作站。
- 仅在导入或已有工作流的自动补齐操作中执行搜索，点击生成不重复搜索和解析。

## 数据传输

官方在线查询只发送缺失节点类名及插件标识，不发送整份工作流、提示词、素材或工作站令牌。公开查询使用独立请求，禁止携带 Cookie 或 ComfyUI 认证头。安装继续复用已有工作站连接和认证。

## 使用

新文件导入时自动处理。已有工作流在“更新目录”中点击“自动补齐插件”或“自动补齐并转换”，即可重新在线搜索并替换上次处理记录。

本地服务已构建并刷新，访问 http://127.0.0.1:1420/ 。手动启动时，在项目目录运行 `node scripts/start.cjs --no-open`，然后在顶部小云朵选择工作站。

## 本次实际验证

- 真实公共在线查询确认 `ColorCorrect` 属于 `comfyui-art-venture` 的 `1.1.4` 发布版本；核验到具体版本的节点记录，未选择同名替代插件。结果保存于 `.cache/online-plugin-discovery-result-20261016.json`。
- 云端恢复后，`/object_info/ColorCorrect` 已返回实际节点定义，先前提交的安装现已加载；没有重复安装。
- 用户 V3 原文件经过完整自动流程：读取云端 2,682 个节点定义，保留 22 个执行节点，SHA-256 校验确认原始 JSON 未改动。结果保存于 `.cache/automatic-manager-import-result-20261016.json`。
- 剩余 8 种 GH/Goohai 类（共 9 个节点）已查询最新官方 Manager 索引及 Comfy Registry，未找到可核验的来源。本次没有声称这些插件已安装，也没有把其他网站或私有仓库是否存在当作已知事实。
- 更新结果已通过运行中的画布导入接口保存回原有管理包；保留原来源 ID 和分类。未提交图片或视频生成。
- 原工作流使用的 `minimax_h3_turbo_4STEPS_comfyui.safetensors` 不在当前云端选项中；这是模型文件准备问题，本次插件自动安装不自动下载该模型。
- 最终全量测试：75 个文件通过，1,077 项通过，3 项缺少本地样本而跳过；在线搜索专项 19 项，Manager 专项 62 项均通过。TypeScript 与 Vite 生产构建通过，保留现有分块大小提示。
- 最新构建已刷新到真实浏览器，从 V3“自动补齐插件”按钮完成一次实际操作。官方 Manager 两份最新索引与 Registry 查询均 HTTP 200，随后画布保存接口和目录刷新接口均 HTTP 200；界面回到可再次操作的完成状态。浏览器证据：`.cache/browser-online-search-proof-20261016.json`；截图：`.cache/workflow-online-plugin-search-20261016.png`。没有保留请求认证头。

## 修改文件

- `src/workflow/manager-online-discovery.ts`：独立的官方在线搜索、分页、精确来源和版本核验。
- `src/workflow/manager-plugins.ts`：接入在线结果、实际安装状态和 Manager 队列，跳过阻塞缓存。
- `src/workflow/automatic-import.ts`：将在线搜索接入真实导入链路。
- `src/workflow/WorkflowImportDialog.tsx`、`WorkflowLibraryStatus.tsx`、`src/generation/GenerationPanel.tsx`：自动处理入口与真实历史结果说明。
- `tests/workflow-manager-online-discovery.test.ts`、`workflow-manager-plugins.test.ts`、`workflow-automatic-import.test.ts`：对应回归测试。

## 依据

- [ComfyUI Manager 路由实现](https://github.com/Comfy-Org/ComfyUI-Manager/blob/572f363696b8df1b0d2ab57f73ad1c7f6e98ba0b/glob/manager_server.py)
- [Comfy 官方前端 Registry 服务](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/services/comfyRegistryService.ts)
- [Comfy Registry API](https://github.com/Comfy-Org/registry-backend/blob/main/openapi.yml)
