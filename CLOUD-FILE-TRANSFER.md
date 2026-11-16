# 云端文件传输

“算力设置 → 云端 ComfyUI → 文件传输”提供画布内的本地/云端双栏文件管理、目录选择、递归上传、进度队列和取消操作。当前传输协议为 SFTP，使用 FileZilla 项目的真实 **fzssh 1.4.0** 与 **libfilezilla 0.57.0** C++ 源码组件。

传输界面和队列在画布内完成。内部原生桥接程序调用与 FileZilla Client 相同的 SSH/SFTP 库，不需要安装或打开 FileZilla 桌面客户端，也不通过其他 SSH 库替代该组件。本功能属于云端 ComfyUI 设置，不改变 RunningHub 的工作流或执行接口。

## 本地文件夹与云端目录

默认本地根目录：`E:\123\DFCine\DFCine0.26\workflows`。

| 本地文件夹 | 用途 | 常用云端目标 |
| --- | --- | --- |
| `comfyui_nodes` | ComfyUI 自定义节点包 | `<ComfyUI>/custom_nodes` |
| `loras` | LoRA 模型 | `<ComfyUI>/models/loras` |
| `cloud_upload` | 通用上传暂存区 | 用户选择的云端可写目录 |

这三个本地目录是文件暂存区。文件放入后不会自动同步或挂载到云端；需要在左栏选择文件或文件夹，在右栏打开并确认云端目标目录，然后点击上传。第三个目录可以把文件上传到登录账号具备写入权限的任意现有云端目录。

云端 ComfyUI 安装位置由实际环境决定。修改“云端 ComfyUI 根目录”后，可使用节点和 LoRA 快捷入口，也可以直接填写其他绝对目录。上传自定义节点后，依赖安装与 ComfyUI 重启仍需在云端执行。

## 连接与操作

1. 使用云端控制台提供的 SSH/SFTP 主机、端口和用户名。ComfyUI 网页地址或网页访问令牌不能代替 SSH/SFTP 连接信息。
2. 在画布内输入本次连接的 SSH 密码，或选择私钥文件并填写其口令。
3. 首次连接会显示 SSH 主机指纹。与云端控制台或服务器管理员提供的指纹核对后，再点击确认连接。原生组件在主机指纹确认前不会进行身份验证。
4. 选择本地分类和文件，在右栏打开云端目录，再点击上传。上传队列显示文件数、传输字节与结果，正在传输或排队的任务可以取消。

目录列表保留符号链接，不会自动逐个访问链接目标。点击标为“链接”的条目后才检查并打开，避免未就绪的云盘挂载拖住整个目录。面板打开时定期检查 SFTP 会话，真实断线后恢复连接表单；目录不存在、无权限和断线分别提示。

关闭设置后，已建立的本地会话和上传任务继续运行；重新打开设置可查看进度。本地不按空闲时长自动断开连接，也不因操作耗时而终止传输。用户可手动取消任务或断开连接；真实网络断开时会提示重新连接。

已有同名文件不会被静默覆盖，当前版本也不自动续传。取消或普通写入失败会尝试清理本次新建的部分文件；网络完全中断时可能无法完成清理，需要重新连接后检查云端目标目录。已完成的其他文件会保留。

## 内部架构与运行条件

操作请求由画布面板进入本地 Node 服务，再通过私有标准输入/输出交给 fzssh/libfilezilla。Windows 本地服务负责连接云端 TCP 地址，并通过一次性本机回环通道传递加密字节；SSH 握手、主机指纹校验、认证、加密与 SFTP 操作仍由真实 fzssh 组件完成。

当前 Windows 环境使用已安装的 **WSL Ubuntu-22.04** 运行编译后的无界面桥接组件。该发行版、原生可执行文件及其共享库必须可用。WSL 只连接本机回环地址，由 Windows 网络连接云端 SSH 主机，避免镜像 VPN 虚拟网卡与假 IP 路由干扰文件传输；不会修改全局 VPN、DNS 或网络配置。它不通过云端 ComfyUI 的 HTTP 地址传输文件。

| 文件或目录 | 作用 |
| --- | --- |
| `src/settings/CloudFileTransferPanel.tsx` | 画布内文件管理与传输界面 |
| `scripts/cloud-file-transfer.ts` | 本地目录限制、会话与上传队列 |
| `scripts/filezilla-native.ts` | 原生进程调用、进度、真实断线识别与手动取消 |
| `scripts/filezilla-native-transport.ts` | Windows 单次本机回环通道与加密 TCP 字节转发 |
| `native/cloud-transfer/bridge.cpp` | 调用真实 fzssh API 的原生适配层 |
| `native/cloud-transfer/vendor` | 完整上游源码、原始许可证与来源校验记录 |
| `.cache/native-cloud-transfer/build/cloud-transfer-bridge` | 当前编译出的内部桥接程序 |
| `.cache/native-cloud-transfer/prefix` | 此构建使用的原生共享库与头文件 |

本地服务仅允许回环地址上的同源画布访问。网页请求不能指定任意本地根目录或可执行程序。上传前，Node 服务与原生桥接会分别校验源文件及所属分类目录；不允许通过符号链接逃出所选文件夹。云端可访问范围仍由 SSH 账号权限决定。

画布只持久保存主机、端口、用户名、常用目录及已确认的主机指纹。密码、私钥内容和口令只用于内存中的本次身份验证，连接成功后清除表单内容；这些凭据通过进程的私有标准输入传递，不写入命令行参数、配置文件或日志。

服务环境变量：

- `CANVAS_TRANSFER_ROOT`：本地暂存根目录；三个分类子目录名称固定。
- `CANVAS_TRANSFER_WSL_DISTRO`：Windows 下运行原生桥接的 WSL 发行版，默认 `Ubuntu-22.04`。

## 从源码构建

构建使用已保留的 fzssh 1.4.0、libfilezilla 0.57.0 与 Nettle 3.10.2 源码。来源地址、SHA-512 摘要及是否与上游公布摘要核对，记录在 `native/cloud-transfer/vendor/SOURCES.json`。其中 fzssh 与 libfilezilla 归档摘要均与官方网站一致。

Linux/WSL 构建依赖包括 C/C++ 编译器、GNU make、CMake、Ninja、pkg-config、gettext、Python 3、Meson 1.3 以上，以及 GnuTLS、GMP、libargon2 和 nlohmann-json 开发头文件。当前环境已经配置这些依赖；Meson 1.3.2 的校验后本地副本位于 `.cache/native-cloud-transfer/python`。

从项目根目录执行：

```powershell
wsl -d Ubuntu-22.04 -- bash native/cloud-transfer/build-native.sh
```

构建脚本将 Nettle、libfilezilla、fzssh 与原生桥接编译到项目的 `.cache/native-cloud-transfer`，不会启动桌面程序。构建完成后可查询实际链接版本：

```powershell
wsl -d Ubuntu-22.04 --exec .cache/native-cloud-transfer/build/cloud-transfer-bridge --version
```

预期版本信息包含 `fzssh: 1.4.0`、`libfilezilla: 0.57.0` 和 `protocol: ndjson-v1`。原生组件按本机 Linux ABI 编译；移动项目、清空构建缓存或更换 WSL 环境后，需要重新构建。

本次构建已通过 fzssh 上游私钥格式测试，以及 Nettle 的 123 项上游测试。另以 Windows `127.0.0.1` 上临时启动的 SFTP 测试服务器，验证实际 Windows → WSL → FileZilla fzSSH 原生客户端链路。覆盖未知及变更指纹在认证前拒绝、错误及正确密码验证、初始目录、目录读取/查询/创建、Unicode 文件名、200003 字节文件逐字节一致、连续进度、拒绝覆盖，以及 1 MiB 文件取消后清理本任务新建的部分文件、保留既有文件并继续使用会话。测试仅使用临时生成的密钥和随机测试密码；`ssh2` 只作为 `.cache` 下的本机测试服务器依赖，客户端始终使用已编译的真实原生组件。

上述测试保存在 `tests/native/filezilla-native.integration.test.ts`，默认不运行，需要已编译的原生组件与缓存中的测试服务器依赖。可显式运行：

```powershell
npm install --prefix .cache/native-transfer-testdeps --no-save --package-lock=false --ignore-scripts ssh2@1.17.0
$env:CANVAS_NATIVE_TRANSFER_TEST = '1'
npx vitest run tests/native/filezilla-native.integration.test.ts
Remove-Item Env:CANVAS_NATIVE_TRANSFER_TEST
```

实际云端已由用户在画布面板完成 SSH 登录，凭据不从聊天获取，也不保存在本地。2026-10-21 已通过 Windows 网络通道在画布实际读取 `/root` 33 项、`/root/ComfyUI` 55 项、`/root/ComfyUI/custom_nodes` 26 项及 `/root/ComfyUI/models/loras` 18 项，并确认刷新完成且没有错误提示；计数包含隐藏条目，不含 `.` 和 `..`。独立 Jupyter 与云端只读 SFTP 协议探测也确认这些目录正常。云端的写入权限和实际上传效果仍需用用户选择的目标目录与文件确认；本次诊断未向实际云端上传文件。

## 上游组件与许可说明

This software incorporates components from fzssh, copyright (c) 2025-2026 Tim Kosse and Business Follows Srl.

fzssh 使用 AGPL-3.0-or-later，并在其 `README` 中列明额外版权归属展示条款；完整许可证为 `vendor/fzssh-1.4.0/agpl3.txt`。libfilezilla 使用 GPL-2.0-or-later，其版权声明及 `COPYING` 随源码保留。Nettle 的适用许可证说明与 `COPYING*` 文件也随源码保存。分发此集成时应一并保留这些源码、版权说明、构建说明和界面中的开源组件归属展示。

组件架构与适配层协议见 [原生集成说明](native/cloud-transfer/README.md)。上游来源：[fzssh 官方网站](https://fzssh.filezilla-project.org/)、[libfilezilla 官方网站](https://lib.filezilla-project.org/)、[FileZilla 官方源码说明](https://filezilla-project.org/sourcecode.php)。
