# 工作流导入自动补齐插件

最新的独立在线搜索、云端恢复后的验证及安装状态见 [在线搜索验证记录](WORKFLOW-ONLINE-PLUGIN-SEARCH-20261016.md)。下方验证部分保留早期云端断开前的结果。

工作流上传后，画布自动读取当前小云朵连接的节点定义，通过该工作站的 ComfyUI Manager 查找缺失插件、安装或启用，并重新解析原始文件。已有导入记录可在「更新目录」中点击「自动补齐插件」或「自动补齐并转换」。点击生成不调用 Manager，也不重新检查节点定义。

## 等待与取消

自动补齐不设固定总时限；节点读取、Manager 查询、下载安装、重启等待以及原始文件读取和保存均没有客户端固定超时。下载慢不会因等待时间而被画布判为失败。HTTP 拒绝或网络明确报错仍会显示。

「停止等待」或关闭窗口会取消当前界面的等待；已被 Manager 接收的安装继续在工作站执行。没有清空 Manager 队列，也不会取消图片或视频生成任务。

## 自动处理规则

- 优先处理 Manager 本地目录的精确匹配，再从完整目录查询剩余节点，避免在线目录刷新阻塞已经找到的插件。
- 使用工作流中的 cnr_id、aux_id、版本和 Manager 节点映射区分同名插件；只提交 Manager 目录内的安装地址。
- 支持新装、启用、依赖修复，以及工作流明确要求的 Active 版本切换。不会用其他同名来源或未经确认的版本替代。
- 安装队列完成后重新读取目录与真实节点定义；只有类确实注册才视为可用。需要重启时，同时检查生成队列和 Manager 安装队列；两者空闲才自动重启。
- 不存在、映射歧义、版本不可安装、安装失败及待重启均保存为具体记录。离线缓存不能证明云端缺少插件，因此不会据此安装。
- 原始 JSON、来源 ID、原名称和分类保留；转换后的输入输出映射和插件诊断同步保存。来源读取限制在已验证的管理包中，拒绝任意路径、链接或篡改文件。

## 验证

- 全量 Vitest：74 个测试文件通过，1039 项通过，3 项因缺少本地样本跳过。
- 最后新增的 2 项回归确认：Manager 明确报告插件导入失败时停止该节点等待并显示原因；没有明确失败时继续无限等待。自动导入模块共 33 项通过。
- TypeScript 与 Vite 生产构建通过；现有大文件分块提示仍在。
- 覆盖长时间等待后成功与主动取消、版本冲突、目录缺失、安装队列保护、安装后重新解析、来源保留，以及运行时不查询节点定义。
- 实际云端读取 2598 个节点定义，用户 V3 原文件解析为 22 节点，原文件保持不变。
- 首次真实自动流程准确找到 ColorCorrect 所属的 comfyui-art-venture 1.1.4，并提交 Manager 安装。云端 Manager 的 Registry 下载请求出现 RemoteDisconnected，安装未被确认成功；随后只读复查该下载接口返回 HTTP 200。此结果没有冒充安装成功。
- 已通过运行中的画布保存导入结果与诊断。没有提交图片或视频生成，没有重启忙碌的云端工作站。
- 无时限版本已从真实画布的 V3「自动补齐插件」按钮启动复验，页面显示 Manager 安装进度（0/1）及「停止等待」。该云端安装仍在处理时，不将其报告为安装成功。截图：`.cache/workflow-manager-unlimited-20261016.png`。

## 主要文件

- `src/workflow/manager-plugins.ts`：Manager 匹配与自动安装流程。
- `src/workflow/automatic-import.ts`：节点收集、重新解析与安全重启。
- `src/workflow/automatic-import-client.ts`：已有工作流重试和保存。
- `src/workflow/WorkflowImportDialog.tsx`、`WorkflowLibraryStatus.tsx`：自动接入和等待控制。
- `src/workflow/import-schema.ts`、`import-client.ts`、`src/comfyui/client.ts`：可取消且无固定时限的导入请求。
- `scripts/workflow-library-writer.ts`、`workflow-library-plugin.ts`、`cloud-server.ts`：验证过的来源读取接口及路由。
- `src/generation/GenerationPanel.tsx`：展示导入阶段的插件处理结果。
- 对应 Manager、自动导入、来源接口、长等待和取消测试。

## 启动与使用

本地已构建，打开 http://127.0.0.1:1420/ 。需要手动启动时，在项目目录运行 `node scripts/start.cjs --no-open`。

先在小云朵中连接工作站，然后添加普通 JSON 或 API JSON。已有记录使用「更新目录」中的自动补齐按钮。无需人工搜索插件；确实无法补齐时查看对应记录。
