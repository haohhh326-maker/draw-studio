# 图片裁切与放大画面拖动

2026-10-02 已完成，并更新本地 1420 和云端 6008 静态界面。

## 操作

- 图片、视频经过滚轮放大后，可按住鼠标左键拖动画面；节点内和展开预览使用同一套交互。
- 放大时显示抓手，移动只影响媒体偏移。缩回原尺寸后恢复原来的节点拖动。
- 图片节点右上角有裁切按钮，展开图片的右上角也有相同入口。
- 裁切默认选择完整原图，支持自由比例选框、移动、八点调整、重置、取消和应用。
- 应用按原图像素生成新的 PNG 素材并回写原节点，保留原素材、节点标题、连线、提示词和生成历史。Ctrl+Z / Ctrl+Shift+Z 可撤销/重做裁切。

## 检查

- TypeScript 构建通过。
- 35 个测试文件、468 项单元测试通过，含裁切像素坐标、PNG 编码、保存恢复、生成节点裁切撤销与后续生成结果保护。
- 本地与云端生产构建通过。
- 新界面的 HTML、JS、CSS 在 1420、6006 的 /canvas/ 入口和 6008 的 /canvas/ 入口均返回 200，内容与对应构建逐字节匹配。
- 用户选择自行测试后，停止真实画布交互验证；裁切 UI 未进行真实点击验收。
- 此前已通过实际鼠标验证图片/视频节点内拖动，节点和画布位置不变；展开视频可拖动，拖动不切换播放，轻点仍播放，点击画面可关闭菜单。

## 发布

- 云端仅更新静态文件，先写新资源再原子切换 index.html；Node 和 ComfyUI 未重启。
- 云端索引备份：`/root/autodl-tmp/clearframe-canvas/backups/index-before-media-controls-20261001T230229Z.html`。
- 增量包：`.cache/canvas-static-media-controls-update-20261002.zip`。
- 完整发布包：`.cache/cloud-release-20261002.zip`。
- 入口内容校验结果：`.cache/media-controls-entry-verification.json`。
- 所有原工作流和模型保持原有文件内容。

## 修改位置

- `src/assets/MediaViewer.tsx`、`media-zoom.ts`、`media-viewer.css`：指针拖动、尺寸变化夹持、播放点击保护与预览裁切入口。
- `src/assets/ImageCropper.tsx`、`image-crop.ts`、`image-cropper.css`：原图裁切、选框和事件隔离。
- `src/nodes/MediaNode.tsx`、`media-node.css`、`image-crop-actions.ts`：节点入口和源素材冲突检查、原节点回写。
- `src/stores/store.ts`、`src/types/index.ts`：明确区分本地素材编辑与新生成结果，确保裁切可撤销且生成任务和历史保持当前状态。
