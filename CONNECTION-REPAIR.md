# 本地画布启动与连接修复

## 2026-10-03 Codex 重启后本地页面拒绝连接

- 截图错误为 `ERR_CONNECTION_REFUSED`，发生在本机 `127.0.0.1:1420`。复查时旧 preview PID 40788 仍在 Windows Job 中；此前 detached/unref 启动没有独立守护和登录启动，Codex 退出后可能一起结束。
- `Start-Canvas.cmd` 改为启动 Windows 独立进程拥有的后台守护；当前用户计划任务注册失败时回退到用户 Startup 快捷方式和 WMI 启动器。无需管理员权限，不保存密码，不改变安全策略。
- 守护检查页面与入口 JavaScript，离线时启动固定 1420 端口的生产预览。只结束自身启动的异常子进程；其他程序占用端口时保留并记录。独占命名管道防止重复守护。
- 停止入口为 `Stop-Canvas.cmd`，重新双击 `Start-Canvas.cmd` 可恢复；状态和日志在 `.cache/local-service-status.json` 和 `.cache/local-service.log`。
- 本机已成功注册当前用户普通权限的 `Draw studio Local Canvas` 计划任务。独立 PowerShell 由计划任务服务启动，Node 守护 PID 38100；停止旧 Codex preview PID 40788 后 4051ms 恢复为 PID 31956，再停止新 preview 后 5797ms 恢复为 PID 37672，页面及入口脚本正常。重复启动保留同一守护实例。
- 21 项针对性测试通过，覆盖退出恢复、单实例、无关端口服务保留、停止标记、入口资源丢失和持续流式响应超时。未主动关闭/更新 Codex 或重启电脑；登录触发和每分钟补启动已检查注册配置。

## 2026-09-27 启动与镜像连接修复

- 本地 1420 端口原先没有监听进程，已重新启动生产预览。
- 新增 `Start-Canvas.cmd` / `scripts/start.cjs`：后台运行、启动后检查页面、重复启动复用现有服务、端口冲突明确报错。关闭启动窗口不会结束服务；电脑重启后需重新双击启动。
- 已检查启动脚本语法，完成从服务停止状态启动，以及重复启动复用的验证。
- 云端 `/root/start-comfyui.sh` 恢复成原镜像脚本，实际进程缺少跨域参数。公网 GET 返回 200 但没有 CORS 响应头，本机服务对跨源请求返回 403。
- 备份为 `/root/start-comfyui.sh.canvas-backup-20260927`，原启动行加入 `exec`、`--enable-cors-header "*"` 和 `--cache-none`。保留原有 Hugging Face 镜像和 PATH 配置，没有改动 `server.py`。
- 确认队列为空后结束旧进程。实例的 supervisor 控制接口报告运行，但实际进程已退出，start/restart 未拉起服务；当前通过 `nohup bash /root/start-comfyui.sh` 恢复，日志在 `/root/autodl-tmp/canvas-connection-20260927.log`。
- 内网与公网 `/system_stats` 返回 200 和 `Access-Control-Allow-Origin: *`。另一来源 `http://localhost:3000` 的 POST 预检也返回 200，允许 Content-Type 和 Authorization；不再限制单一画布地址。
- 本轮只检查启动和连接，没有提交生成任务。
- 在原 `mimimax` 项目中点击“测试并保存”，界面确认“已连接 / 实时进度已连接 · 0.37.0 · 排队 0”。已保存的服务地址无需更改。

重建或重新部署原始第三方镜像可能覆盖本次启动脚本。固化自己的镜像时应保留修复后的脚本；仓库已有 `deploy/autodl/start-comfyui.sh` 可作为部署启动入口。当前未进行整机重启验收。

## 2026-10-02 再次连接检查与恢复

- 当前画布保存的地址仍为 `https://u1159393-7896c7f82fde.westd.seetacloud.com:8443`。本轮复查时首页及 `/system_stats`、`/object_info`、`/queue` 均已返回 200；浏览器跨域响应头缺失，POST 预检也没有允许跨域的响应头。
- 通过既有 SSH 连接只读确认：ComfyUI 进程在 `/root/ComfyUI` 使用 6006 端口、仅监听 `127.0.0.1`，未带 `--enable-cors-header`；当前 `/root/start-comfyui.sh` 同样没有该参数，也没有上次备份文件。当前环境未保留之前的启动修复。
- 两次确认正在运行与等待队列均为空后，将启动脚本备份为 `/root/start-comfyui.sh.canvas-backup-20261001T211249Z`，在原启动行补充 `exec` 和 `--enable-cors-header "*"`。保留原监听地址、端口、其他环境配置，不修改工作流、插件或权重。
- 原进程通过 SIGTERM 正常退出，未强制终止。等待后未发现自动重启，通过原启动脚本恢复服务；日志在 `/root/autodl-tmp/canvas-connection-20261001T211249Z.log`。
- 内网与公网标准接口返回 200，且 `Access-Control-Allow-Origin: *`。`http://localhost:3000` 的 POST 预检返回 200，允许 Content-Type 与 Authorization，支持不同画布地址。
- 实际 `mimimax` 画布点击“测试并保存”后显示“已连接 / 实时进度已连接 · 0.37.0 · 排队 0”。当前 `/object_info` 返回 2218 个节点类型。
- 没有提交生成任务。原服务地址无需修改；本轮没有整机重启或镜像重新部署验收。
