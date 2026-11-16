import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeResizer, useStore as useFlowStore, type NodeProps } from "@xyflow/react";
import {
  ImageIcon,
  File as FileIcon,
  FolderOpen,
  Clapperboard,
  AudioLines,
  StickyNote,
  GripHorizontal,
  Play,
  Download,
  Copy,
  Link2,
  RefreshCw,
  Upload,
  Trash2,
  Wrench,
  Maximize2,
  Crop,
  FolderPlus,
  Check,
} from "lucide-react";
import type { CanvasNode } from "../types";
import { busyPhases, phaseLabels } from "../types";
import { useStore, activeCanvas } from "../stores/store";
import { AssetPreview } from "../assets/AssetPreview";
import { isAssetInLibrary } from "../assets/library-membership";
import { LibraryEntryDialog } from "../assets/LibraryEntryDialog";
import { MediaViewer } from "../assets/MediaViewer";
import { ImageCropper } from "../assets/ImageCropper";
import { applyImageCrop, getImageCropSource } from "./image-crop-actions";
import { addVideoFrameToCanvas } from "./video-frame-actions";
import { importAsset } from "../assets/assets";
import { download, getBlob } from "../projects/storage";
import { TaskTimer } from "../generation/TaskTimer";
import { Modal } from "../components/ui";
import { validMediaDimensions } from "./media-layout";
import { NodeExecutionView } from "./NodeExecutionView";
import { TextNodeOptimization } from "../prompt-optimization/TextNodeOptimization";
import { canvasContextMenuDismissEvent, dismissCanvasContextMenus } from "../canvas/context-menu-events";
import "./media-node.css";
export const MediaNode = memo(function MediaNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const asset = useStore((s) =>
    data.assetId ? s.project.assets[data.assetId] : undefined,
  );
  const previewQuality = useFlowStore(useCallback(state => {
    if (asset?.kind !== "image") return 0;
    const measured = state.nodeLookup.get(id)?.measured;
    const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const displayedPixels = Math.max(measured?.width ?? 360, measured?.height ?? 360) * state.transform[2] * pixelRatio;
    return displayedPixels > 1024 ? 2 : displayedPixels > 512 ? 1 : 0;
  }, [id, asset?.kind]));
  const [player, setPlayer] = useState(false),
    [menu, setMenu] = useState(false),
    [frameBusy, setFrameBusy] = useState(false);
  const [cropSource, setCropSource] = useState<ReturnType<typeof getImageCropSource> | null>(null);
  const [libraryTarget, setLibraryTarget] = useState<{ projectId: string; assetId: string } | null>(null);
  const closeCrop = useCallback(() => setCropSource(null), []);
  const extractingFrame = useRef(false);
  const task = useStore((s) => s.project.tasks[data.generation?.taskId ?? ""]);
  const editingText = useStore((s) => data.kind === "text" && s.selectedId === id);
  const inLibrary = useStore((s) => !!asset && isAssetInLibrary(asset, s.project));
  const displayTask = data.generationFeedback ?? task;
  const busy = !!task && busyPhases.includes(task.status);
  const showExecution = !!displayTask && (busy || ["failed", "cancelled", "interrupted"].includes(displayTask.status));
  const hasVisualAsset = asset?.kind === "image" || asset?.kind === "video";
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener(canvasContextMenuDismissEvent, close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener(canvasContextMenuDismissEvent, close);
    };
  }, [menu]);
  useEffect(() => {
    if (showExecution) setPlayer(false);
  }, [showExecution]);
  const onDimensions = useCallback((width:number,height:number) => {
    if (!asset || !validMediaDimensions(width,height)) return;
    if (asset.width === width && asset.height === height && data.mediaLayoutAssetId === asset.id) return;
    useStore.getState().setAssetDimensions(asset.id,width,height);
  },[asset?.id,asset?.width,asset?.height,data.mediaLayoutAssetId]);
  useEffect(() => {
    if (asset && validMediaDimensions(asset.width,asset.height)) onDimensions(asset.width!,asset.height!);
  },[asset?.id,asset?.width,asset?.height,onDimensions]);
  const displayKind = asset?.kind ?? data.kind;
  const mediaPlaceholder = data.kind === "image-generation" || data.kind === "video" || data.kind === "audio";
  const Icon =
    displayKind === "tool" ? Wrench : displayKind === "video"
      ? Clapperboard
      : displayKind === "audio"
        ? AudioLines
        : displayKind === "text"
          ? StickyNote
          : displayKind === "file"
            ? FileIcon
            : displayKind === "reference"
              ? FolderOpen
              : ImageIcon;
  const upload = async (file?: File) => {
    if (!file) return;
    try {
      const a = await importAsset(file, file.name);
      if (
        (data.kind === "video" && a.kind !== "video") ||
        (data.kind === "audio" && a.kind !== "audio")
      )
        throw new Error("素材类型与节点不符。");
      useStore.getState().checkpoint();
      useStore.getState().addAsset(a, { x: 0, y: 0 }, id);
    } catch (e) {
      useStore.getState().notify(String(e));
    }
  };
  const addFrame = async (frame: "first" | "last") => {
    if (busy || extractingFrame.current) return;
    extractingFrame.current = true;
    setFrameBusy(true);
    try {
      await addVideoFrameToCanvas(id, frame);
    } catch (error) {
      useStore.getState().notify(error instanceof Error ? error.message : String(error));
    } finally {
      extractingFrame.current = false;
      setFrameBusy(false);
    }
  };
  const startCrop = () => {
    try {
      const source = getImageCropSource(id);
      setPlayer(false);
      setMenu(false);
      setCropSource(source);
    } catch (error) {
      useStore.getState().notify(error instanceof Error ? error.message : String(error));
    }
  };
  const reference = () => {
    const s = useStore.getState(),
      c = activeCanvas(s),
      n = c.nodes.find((n) => n.id === id)!;
    const target = s.addNode("video", {
      x: n.position.x + 330,
      y: n.position.y,
    });
    s.editCanvas((c) => ({
      ...c,
      edges: [
        ...c.edges,
        {
          id: crypto.randomUUID(),
          source: id,
          target,
          data: { role: "auto", order: Date.now() },
        },
      ],
    }));
    setMenu(false);
  };
  return (
    <div
      className={
        "media-node " +
        (selected ? "is-selected " : "") +
        (asset ? "has-asset " : "") +
        (hasVisualAsset ? "has-visual-asset " : "") +
        (asset?.kind === "image" ? "has-image-asset " : "") +
        (busy ? "is-busy " : "") +
        (showExecution ? "has-execution" : "")
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissCanvasContextMenus();
        setMenu(true);
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={120}
        keepAspectRatio={hasVisualAsset}
        lineStyle={{ borderColor: "transparent" }}
        handleStyle={{ display: "none" }}
      />
      <div className="node-caption">
        <span>
          <Icon size={mediaPlaceholder || data.kind === "reference" ? 16 : 12} aria-hidden="true" />
          {data.title}
        </span>
        <span>
          {asset
            ? asset.kind.toUpperCase()
            : data.kind === "image-generation"
              ? "IMAGE / AI"
              : data.kind === "video"
                ? "VIDEO / AI"
                : ""}
        </span>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={!!data.generation}
      />
      <Handle type="source" position={Position.Right} />
      {(!data.generation || data.kind === "audio") && data.kind !== "text" && (
        <input
          ref={fileInput}
          type="file"
          hidden
          disabled={busy}
          aria-label="上传素材"
          accept={data.kind === "audio" ? "audio/*" : "image/*,video/*,audio/*"}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      )}
      {showExecution ? <NodeExecutionView task={displayTask!} /> : data.kind === "text" && (!asset || asset.kind === "text") ? (
        <div className="text-node-content">
          <div className="text-drag-bar" title="移动文本节点">
            <GripHorizontal size={16} />
            {editingText && <TextNodeOptimization nodeId={id} />}
          </div>
          <textarea
            aria-label="文本内容"
            className="note nodrag nowheel"
            placeholder="剧情、分镜、角色设定…"
            value={data.text ?? ""}
            onChange={(e) =>
              useStore.getState().patchNode(id, { text: e.target.value })
            }
          />
        </div>
      ) : asset ? (
        <>
          {hasVisualAsset ? (
            // Canvas media shares the canvas zoom and drag gesture. Independent
            // image zoom belongs to MediaViewer, otherwise crossing a node edge
            // switches coordinate systems halfway through a wheel gesture.
            <div className="media-viewport node-media-viewport">
              <div className="media-viewport-content">
                <AssetPreview asset={asset}
                  previewSize={previewQuality === 2 ? 2048 : previewQuality === 1 ? 1024 : 512} onDimensions={onDimensions} />
              </div>
            </div>
          ) : <AssetPreview asset={asset} onDimensions={onDimensions} />}
          {asset.kind === "video" && (
            <>
              <span className="play-overlay">
                <Play size={20} fill="currentColor" />
              </span>
              <div className="node-frame-actions nodrag nopan nowheel"
                onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" aria-label="添加首帧到画布" title="添加首帧到画布"
                  disabled={busy || frameBusy}
                  onClick={(event) => { event.stopPropagation(); void addFrame("first"); }}>S</button>
                <button type="button" aria-label="添加尾帧到画布" title="添加尾帧到画布"
                  disabled={busy || frameBusy}
                  onClick={(event) => { event.stopPropagation(); void addFrame("last"); }}>N</button>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="node-empty">
          {data.kind === "audio" ? (
              <button
                type="button"
                className="node-type-icon node-empty-upload nodrag nopan"
                aria-label="选择文件"
                title="选择文件"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <Icon size={36} strokeWidth={2} aria-hidden="true" />
              </button>
          ) : !data.generation ? (
            <button
              type="button"
              className={"node-empty-upload nodrag nopan" + (data.kind === "reference" ? " node-type-icon" : "")}
              aria-label="选择文件"
              title="选择文件"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon size={data.kind === "reference" ? 34 : 31} strokeWidth={data.kind === "reference" ? 2 : 1.2} aria-hidden="true" />
            </button>
          ) : mediaPlaceholder ? (
            <span className="node-type-icon" aria-hidden="true">
              <Icon size={34} strokeWidth={2} />
            </span>
          ) : <Icon size={31} strokeWidth={1.2} aria-hidden="true" />}
        </div>
      )}
      {asset && !showExecution && (
        <button type="button" className="node-expand-button nodrag nopan" title="放大预览" aria-label="放大预览"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setPlayer(true); }}>
          <Maximize2 size={16} />
        </button>
      )}
      {asset?.kind === "image" && !showExecution && (
        <button type="button" className="node-crop-button nodrag nopan nowheel" title="裁切图片" aria-label="裁切图片"
          disabled={busy}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); startCrop(); }}>
          <Crop size={16} />
        </button>
      )}
      {task && !data.generationFeedback && task.status !== "idle" && <TaskTimer task={task} />}
      {task && task.status !== "idle" && !showExecution && (
        <div className={"node-status " + task.status}>
          <i />
          {phaseLabels[task.status]}
          {task.progress !== undefined ? " · " + task.progress + "%" : ""}
        </div>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="node-context nodrag nopan"
          role="menu"
          aria-label="节点操作"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {asset && (
            <button type="button" role="menuitem" disabled={inLibrary}
              onClick={() => {
                setLibraryTarget({ projectId: useStore.getState().project.id, assetId: asset.id });
                setMenu(false);
              }}>
              {inLibrary ? <Check size={14} /> : <FolderPlus size={14} />}
              {inLibrary ? "已加入资产库" : "添加到资产库"}
            </button>
          )}
          {asset && (!data.generation || data.kind === "audio") && (
            <button
              disabled={busy}
              onClick={() => {
                fileInput.current?.click();
                setMenu(false);
              }}
            >
              <Upload size={14} />
              更换素材
            </button>
          )}
          {asset && (
            <button
              onClick={() => {
                void getBlob(asset.id, asset.mime).then((b) =>
                  download(b, asset.name),
                );
                setMenu(false);
              }}
            >
              <Download size={14} />
              下载 / 另存为
            </button>
          )}
          <button
            onClick={() => {
              const s = useStore.getState(),
                n = activeCanvas(s).nodes.find((n) => n.id === id)!;
              s.editCanvas(
                (c) => ({
                  ...c,
                  nodes: [
                    ...c.nodes,
                    {
                      ...structuredClone(n),
                      id: crypto.randomUUID(),
                      position: { x: n.position.x + 40, y: n.position.y + 40 },
                      selected: false,
                      data: {
                        ...n.data,
                        ...(data.generation
                          ? { generation: { ...data.generation, taskId: null } }
                          : {}),
                      },
                    },
                  ],
                }),
                true,
              );
              setMenu(false);
            }}
          >
            <Copy size={14} />
            复制节点
          </button>
          {asset && (
            <button onClick={reference}>
              <Link2 size={14} />
              用作参考 / 源素材
            </button>
          )}
          {data.generation && (
            <button
              onClick={() => {
                useStore.setState({ selectedId: id });
                setMenu(false);
              }}
            >
              <RefreshCw size={14} />
              调整并再次生成
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              useStore.getState().editCanvas(
                (c) => ({
                  ...c,
                  nodes: c.nodes.filter((n) => n.id !== id),
                  edges: c.edges.filter(
                    (e) => e.source !== id && e.target !== id,
                  ),
                }),
                true,
              );
              useStore.setState({ selectedId: null });
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      )}
      {player && asset && hasVisualAsset && (
        <MediaViewer asset={asset} onClose={() => setPlayer(false)}
          onCrop={asset.kind === "image" ? startCrop : undefined} cropDisabled={busy}
          onFrame={asset.kind === "video" ? (frame) => { void addFrame(frame); } : undefined}
          frameBusy={busy || frameBusy} />
      )}
      {cropSource && <ImageCropper asset={cropSource.asset} onClose={closeCrop}
        onApply={(cropped) => { applyImageCrop(cropSource, cropped); setCropSource(null); }} />}
      {libraryTarget && <LibraryEntryDialog key={libraryTarget.projectId + ":" + libraryTarget.assetId}
        {...libraryTarget} onClose={() => setLibraryTarget(null)} />}
      {player && asset && !hasVisualAsset && createPortal(
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan nowheel"
        >
          <Modal title={asset.name} onClose={() => setPlayer(false)} wide>
            <div className="player">
              <AssetPreview asset={asset} full />
            </div>
          </Modal>
        </div>,document.body
      )}
    </div>
  );
});
