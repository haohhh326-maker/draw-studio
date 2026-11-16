import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  BackgroundVariant,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useStoreApi,
  SelectionMode,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type OnConnect,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import {
  FolderOpen,
  History,
  Download,
  Plus,
  Clapperboard,
  StickyNote,
  Music2,
  Sparkles,
  Undo2,
  Redo2,
  Group,
  Ungroup,
  Focus,
  MousePointer2,
  Hand,
  RefreshCw,
  X,
} from "lucide-react";
import { MediaNode } from "../nodes/MediaNode";
import { GenerationPanel } from "../generation/GenerationPanel";
import { openGenerationPanelTarget, syncGenerationPanelTarget } from "../generation/generation-panel-state";
import { useStore, activeCanvas, taskForNode, createNode } from "../stores/store";
import { allWorkflows } from "../compute/providers";
import { importAsset, setCanvasAssetInteraction } from "../assets/assets";
import { getMediaNodeSize } from "../nodes/media-layout";
import { selectWorkflowOutput } from "../workflow/execution";
import { workflowInputRoleOptions } from "../semantic/resolver";
import { remapPromptMentions } from "../semantic/mentions";
import { exportProject } from "../projects/storage";
import {
  busyPhases,
  roleLabels,
  type Role,
  type Kind,
  type CanvasNode,
  type CanvasEdge,
} from "../types";
import { IconButton } from "../components/ui";
import { CanvasFlowSelection, FlowEdge } from "./FlowEdge";
import { flowNodeSelectionKey } from "./flow-edge-selection";
import { canvasContextMenuDismissEvent, dismissCanvasContextMenus } from "./context-menu-events";
import { NativeCanvasServicePanel, type CanvasService } from "../services/NativeCanvasServicePanel";
import { openSoftwareUpdate } from "../updates/software-update-client";
import { workflowForCanvasEdge } from "./edge-workflow";
import { CanvasPositionDraft, registerCanvasPositionFlush } from "./position-draft";
const nodeTypes: NodeTypes = { media: MediaNode };
const edgeTypes: EdgeTypes = { default: FlowEdge, straight: FlowEdge, step: FlowEdge, smoothstep: FlowEdge, simplebezier: FlowEdge };
const snapGrid: [number, number] = [10, 10];
const connectionLineStyle = { stroke: "var(--canvas-edge-base)", strokeWidth: 2 };
const defaultEdgeOptions = { type: "default", style: connectionLineStyle };
const proOptions = { hideAttribution: true };
let clipboard: {
  projectId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} | null = null;
export const CanvasView = memo(function CanvasView({ servicePanel, onServicePanelChange }: {
  servicePanel: CanvasService | null;
  onServicePanelChange: (service: CanvasService | null) => void;
}) {
  const canvas = useStore(activeCanvas),
    projectId = useStore((s) => s.project.id),
    selectedId = useStore((s) => s.selectedId),
    selectedEdgeId = useStore((s) => s.selectedEdgeId),
    edgeDefinition = useStore(s => workflowForCanvasEdge(s, s.project.activeCanvasId, s.selectedEdgeId)),
    modal = useStore(s => s.modal),
    assets = useStore((s) => s.project.assets);
  const selectionKey = useMemo(() => flowNodeSelectionKey(canvas.nodes, selectedId), [canvas.nodes, selectedId]);
  const selectedFlowNodes = useMemo(() => new Set<string>(JSON.parse(selectionKey)), [selectionKey]);
  const [addMenu, setAddMenu] = useState<{
      left: number;
      top: number;
      position: { x: number; y: number };
    } | null>(null),
    [more, setMore] = useState(false),
    [pan, setPan] = useState(false),
    [showMap, setShowMap] = useState(true);
  useEffect(() => { if (modal) onServicePanelChange(null); }, [modal, onServicePanelChange]);
  useLayoutEffect(() => {
    // Only the selected editable node owns the visible panel. AI jobs persist
    // separately when a blank click clears this display target.
    syncGenerationPanelTarget(projectId, canvas, selectedId);
  }, [projectId, canvas.id, canvas.nodes, selectedId]);
  const flow = useReactFlow<CanvasNode, CanvasEdge>(),
    shellRef = useRef<HTMLDivElement>(null),
    menuRef = useRef<HTMLDivElement>(null),
    moreMenuRef = useRef<HTMLDivElement>(null);
  const flowStore = useStoreApi<CanvasNode, CanvasEdge>();
  const positionDraft = useRef<CanvasPositionDraft | null>(null);
  const movingViewport = useRef(false);
  const updateInteraction = useCallback(() => {
    const interacting = !!(positionDraft.current || movingViewport.current);
    setCanvasAssetInteraction(interacting);
    const shell = shellRef.current;
    if (!shell) return;
    if (interacting) {
      if (!shell.dataset.interacting) {
        shell.dataset.interacting = "true";
        shell.dispatchEvent(new Event("canvas-interaction-start"));
      }
    } else if (shell.dataset.interacting) {
      delete shell.dataset.interacting;
      shell.dispatchEvent(new Event("canvas-interaction-end"));
    }
  }, []);
  const flushPositions = useCallback((finish = false) => {
    const draft = positionDraft.current;
    if (finish) positionDraft.current = null;
    if (draft) {
      const state = useStore.getState();
      const current = state.project.id === draft.projectId
        ? state.project.canvases.find(item => item.id === draft.canvasId) : undefined;
      if (current) {
        const nodes = draft.merge(current.nodes, true);
        if (nodes !== current.nodes) state.editProject(project => ({ ...project,
          canvases: project.canvases.map(item => item.id === draft.canvasId ? { ...item, nodes } : item),
        }));
      }
    }
    updateInteraction();
  }, [updateInteraction]);
  const beginNodeDrag = useCallback(() => {
    if (positionDraft.current) return;
    const state = useStore.getState();
    if (state.project.id !== projectId || state.project.activeCanvasId !== canvas.id) return;
    positionDraft.current = new CanvasPositionDraft(state.project.id, state.project.activeCanvasId);
    state.checkpoint();
    updateInteraction();
  }, [projectId, canvas.id, updateInteraction]);
  // Concurrent task completion may replace the stored node array during a drag.
  // Overlay only transient coordinates onto that fresh data before React Flow sees it.
  const displayedNodes = useMemo(() => {
    const draft = positionDraft.current;
    return draft?.projectId === projectId && draft.canvasId === canvas.id ? draft.merge(canvas.nodes) : canvas.nodes;
  }, [projectId, canvas.id, canvas.nodes]);
  useLayoutEffect(() => {
    const unregister = registerCanvasPositionFlush(flushPositions);
    const finish = () => { movingViewport.current = false; flushPositions(true); };
    const beforeEdit = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && ["z", "y", "c", "v", "g"].includes(event.key.toLowerCase()))) finish();
    };
    window.addEventListener("blur", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", beforeEdit, true);
    return () => {
      unregister();
      window.removeEventListener("blur", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", beforeEdit, true);
      finish();
    };
  }, [projectId, canvas.id, flushPositions]);
  useLayoutEffect(() => {
    if (!addMenu || !menuRef.current || !shellRef.current) return;
    const menu = menuRef.current.getBoundingClientRect();
    const shell = shellRef.current.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(addMenu.left, shell.width - menu.width - 8),
    );
    const top = Math.max(
      8,
      Math.min(addMenu.top, shell.height - menu.height - 8),
    );
    if (left !== addMenu.left || top !== addMenu.top)
      setAddMenu({ ...addMenu, left, top });
  }, [addMenu]);
  useEffect(() => {
    if (!addMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setAddMenu(null);
    };
    const close = () => setAddMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener(canvasContextMenuDismissEvent, close);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener(canvasContextMenuDismissEvent, close);
    };
  }, [addMenu]);
  useEffect(() => {
    if (!more) return;
    const close = () => setMore(false);
    const dismiss = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener(canvasContextMenuDismissEvent, close);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener(canvasContextMenuDismissEvent, close);
    };
  }, [more]);
  useEffect(() => {
    setAddMenu(null);
    setMore(false);
    dismissCanvasContextMenus();
  }, [canvas.id]);
  const middle = () =>
    flow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight * 0.36,
    });
  const add = (kind: Kind) => {
    if (!addMenu) return;
    useStore.getState().addNode(kind, addMenu.position);
    setAddMenu(null);
  };
  const upload = useCallback(
    async (files: FileList | File[], pos?: { x: number; y: number }) => {
      const point = pos ?? middle();
      const original = useStore.getState();
      const projectId = original.project.id, canvasId = activeCanvas(original).id;
      let offset = 0;
      for (const file of Array.from(files)) {
        if (useStore.getState().project.id !== projectId || !useStore.getState().projectOpen) break;
        try {
          const asset = await importAsset(file, file.name);
          const state = useStore.getState();
          if (state.project.id !== projectId || !state.projectOpen) break;
          if (activeCanvas(state).id !== canvasId) {
            const destination = state.project.canvases.find(canvas => canvas.id === canvasId);
            if (destination) {
              const node = createNode("reference", destination.nodes.filter(item => item.data.kind === "reference").length + 1, point.x + offset, point.y);
              node.data.assetId = asset.id;
              state.editProject(project => ({ ...project, assets: { ...project.assets, [asset.id]: asset },
                canvases: project.canvases.map(canvas => canvas.id === canvasId ? { ...canvas, nodes: [...canvas.nodes, node] } : canvas),
              }));
              if (asset.width && asset.height) state.setAssetDimensions(asset.id, asset.width, asset.height);
              state.notify("参考素材已添加到原画布。");
            }
            break;
          }
          state.addAsset(asset, { x: point.x + offset, y: point.y });
          offset += getMediaNodeSize(asset.width, asset.height).width + 40;
        } catch (e) {
          useStore.getState().notify(String(e));
        }
      }
    },
    [flow],
  );
  const connect: OnConnect = useCallback((c: Connection) => {
    const s = useStore.getState(),
      cv = activeCanvas(s);
    if (!c.source || !c.target || c.source === c.target) return;
    const target = cv.nodes.find((n) => n.id === c.target),
      source = cv.nodes.find((n) => n.id === c.source);
    if (!target?.data.generation || source?.data.kind === "group") {
      s.notify("请将文本、图像、视频或音频连接到生成节点。");
      return;
    }
    if (busyPhases.includes(taskForNode(s.project, target).status)) {
      s.notify("生成期间不能修改输入连线。");
      return;
    }
    if (cv.edges.some((e) => e.source === c.source && e.target === c.target))
      return;
    const visited = new Set<string>(),
      visit = (id: string): boolean => {
        if (id === c.source) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        return cv.edges
          .filter((e) => e.source === id)
          .some((e) => visit(e.target));
      };
    if (visit(c.target)) {
      s.notify("连接会形成循环，请使用已有结果连接下一镜头。");
      return;
    }
    s.editCanvas(
      (cv) => ({
        ...cv,
        edges: [
          ...cv.edges,
          {
            ...c,
            id: crypto.randomUUID(),
            data: {
              role: source?.data.kind === "text" ? "prompt" : "auto",
              order: Date.now(),
            },
          },
        ],
      }),
      true,
    );
  }, []);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    if (!changes.length) return;
    const s = useStore.getState();
    if (s.project.id !== projectId || s.project.activeCanvasId !== canvas.id) return;
    const cv = activeCanvas(s);
    let filtered = changes.filter((change) => {
      if (change.type !== "remove") return true;
      const n = cv.nodes.find((n) => n.id === change.id);
      return !busyPhases.includes(taskForNode(s.project, n).status);
    });
    if (!filtered.length) return;
    const draft = positionDraft.current;
    let finishDrag = false;
    if (draft?.projectId === s.project.id && draft.canvasId === cv.id) {
      const positions = filtered.filter(change => change.type === "position");
      if (positions.length) {
        const state = flowStore.getState();
        draft.record(positions, state.nodes);
        state.setNodes(applyNodeChanges(positions, state.nodes));
        filtered = filtered.filter(change => change.type !== "position");
        // React Flow's aborted touch/deleted-node gesture emits a final position
        // change but deliberately skips onNodeDragStop.
        finishDrag = positions.some(change => change.dragging === false);
      }
      finishDrag ||= filtered.some(change => change.type === "remove");
    }
    if (!filtered.length) {
      if (finishDrag) flushPositions(true);
      return;
    }
    const removed = new Set(filtered.filter(change => change.type === "remove").map(change => change.id));
    s.editCanvas(
      (c) => ({
        ...c,
        nodes: applyNodeChanges(filtered, c.nodes),
        edges: removed.size ? c.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) : c.edges,
      }),
      filtered.some((x) => x.type === "remove"),
    );
    if (finishDrag) flushPositions(true);
  }, [projectId, canvas.id, flowStore, flushPositions]);
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    if (!changes.length) return;
    useStore.getState().editCanvas(
      (c) => ({
        ...c,
        edges: applyEdgeChanges(
          changes.filter(
            (x) =>
              x.type !== "remove" ||
              !busyPhases.includes(
                taskForNode(
                  useStore.getState().project,
                  c.nodes.find(
                    (n) => n.id === c.edges.find((e) => e.id === x.id)?.target,
                  ),
                ).status,
              ),
          ),
          c.edges,
        ),
      }),
      changes.some((x) => x.type === "remove"),
    );
  }, []);
  const group = () => {
    flushPositions(true);
    const s = useStore.getState(),
      c = activeCanvas(s),
      nodes = c.nodes.filter(
        (n) => n.selected && !n.parentId && n.data.kind !== "group",
      );
    if (nodes.length < 2) {
      s.notify("先选择至少两个节点。");
      return;
    }
    const x = Math.min(...nodes.map((n) => n.position.x)) - 30,
      y = Math.min(...nodes.map((n) => n.position.y)) - 50;
    const right =
        Math.max(
          ...nodes.map((n) => n.position.x + (n.measured?.width ?? 200)),
        ) + 30,
      bottom =
        Math.max(
          ...nodes.map((n) => n.position.y + (n.measured?.height ?? 180)),
        ) + 30;
    const id = crypto.randomUUID();
    s.editCanvas(
      (c) => ({
        ...c,
        nodes: [
          {
            id,
            type: "group",
            position: { x, y },
            style: { width: right - x, height: bottom - y },
            data: { kind: "group", title: "分组" },
          },
          ...c.nodes.map((n) =>
            nodes.some((x) => x.id === n.id)
              ? {
                  ...n,
                  parentId: id,
                  extent: "parent" as const,
                  position: { x: n.position.x - x, y: n.position.y - y },
                }
              : n,
          ),
        ],
      }),
      true,
    );
  };
  const ungroup = () => {
    flushPositions(true);
    const s = useStore.getState(),
      c = activeCanvas(s);
    const ids = new Set(
      c.nodes
        .filter((n) => n.selected)
        .map((n) => n.parentId ?? (n.data.kind === "group" ? n.id : "")),
    );
    s.editCanvas(
      (c) => ({
        ...c,
        nodes: c.nodes
          .filter((n) => !ids.has(n.id))
          .map((n) => {
            if (!n.parentId || !ids.has(n.parentId)) return n;
            const parent = c.nodes.find((p) => p.id === n.parentId)!;
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              position: {
                x: n.position.x + parent.position.x,
                y: n.position.y + parent.position.y,
              },
            };
          }),
      }),
      true,
    );
  };
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (
        useStore.getState().modal ||
        document.querySelector('[aria-modal="true"]') ||
        (e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")
      )
        return;
      const files = e.clipboardData?.files;
      if (files?.length) {
        e.preventDefault();
        void upload(files);
      } else if (clipboard?.projectId === useStore.getState().project.id) {
        e.preventDefault();
        const s = useStore.getState(),
          ids = new Map(
            clipboard.nodes.map((n) => [n.id, crypto.randomUUID()]),
          );
        s.editCanvas(
          (c) => ({
            ...c,
            nodes: [
              ...c.nodes.map((n) => ({ ...n, selected: false })),
              ...clipboard!.nodes.map((n) => ({
                ...structuredClone(n),
                id: ids.get(n.id)!,
                parentId: n.parentId ? ids.get(n.parentId) : undefined,
                extent:
                  n.parentId && ids.has(n.parentId) ? n.extent : undefined,
                position: { x: n.position.x + 40, y: n.position.y + 40 },
                selected: true,
                data: {
                  ...n.data,
                  ...(n.data.generation
                    ? { generation: { ...n.data.generation, prompt: remapPromptMentions(n.data.generation.prompt, ids), taskId: null } }
                    : {}),
                },
              })),
            ],
            edges: [
              ...c.edges,
              ...clipboard!.edges.map((e) => ({
                ...e,
                id: crypto.randomUUID(),
                source: ids.get(e.source)!,
                target: ids.get(e.target)!,
              })),
            ],
          }),
          true,
        );
      }
    };
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable]",
        ) ||
        useStore.getState().modal ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      const mod = e.ctrlKey || e.metaKey,
        s = useStore.getState();
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const c = activeCanvas(s),
          nodes = c.nodes.filter((n) => n.selected);
        clipboard = {
          projectId: s.project.id,
          nodes: structuredClone(nodes),
          edges: structuredClone(
            c.edges.filter(
              (e) =>
                nodes.some((n) => n.id === e.source) &&
                nodes.some((n) => n.id === e.target),
            ),
          ),
        };
        s.notify("已复制 " + nodes.length + " 个节点。");
      }
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.shiftKey ? ungroup() : group();
      }
      if (e.key === "Escape") {
        useStore.setState({ selectedId: null, selectedEdgeId: null });
        s.editCanvas(c => ({ ...c,
          nodes: c.nodes.map(node => node.selected ? { ...node, selected: false } : node),
          edges: c.edges.map(edge => edge.selected ? { ...edge, selected: false } : edge),
        }));
        setAddMenu(null);
        setMore(false);
      }
    };
    const saveKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void useStore.getState().save();
      }
    };
    document.addEventListener("paste", paste);
    document.addEventListener("keydown", saveKey, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("paste", paste);
      document.removeEventListener("keydown", saveKey, true);
      document.removeEventListener("keydown", key);
    };
  }, [upload]);
  const edge = selectedEdgeId ? canvas.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const edgeSource = edge ? canvas.nodes.find(node => node.id === edge.source) : undefined;
  const edgeTarget = edge ? canvas.nodes.find(node => node.id === edge.target) : undefined;
  const edgeWorkflow = edgeDefinition && edgeTarget?.data.generation
    ? selectWorkflowOutput(edgeDefinition, edgeTarget.data.generation.params) : edgeDefinition;
  const edgeAsset = edgeSource?.data.assetId ? assets[edgeSource.data.assetId] : undefined;
  const textEdge = edgeSource?.data.kind === "text" || (edgeSource?.data.kind === "tool" && edgeSource.data.text !== undefined);
  const edgeRoleOptions = !edge ? [] : textEdge ? Object.entries(roleLabels).filter(([role]) => ["auto", "prompt"].includes(role)).map(([value, label]) => ({ value, label }))
    : workflowInputRoleOptions(edgeWorkflow, edgeAsset?.kind, edge.data?.role ?? "auto");
  return (
    <div
      ref={shellRef}
      className="canvas-shell"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        void upload(
          e.dataTransfer.files,
          flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        );
      }}
    >
      <CanvasFlowSelection.Provider value={selectedFlowNodes}>
      <ReactFlow<CanvasNode, CanvasEdge>
        key={canvas.id}
        nodes={displayedNodes}
        edges={canvas.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onNodeDragStart={beginNodeDrag}
        onNodeDragStop={() => flushPositions(true)}
        onSelectionDragStart={beginNodeDrag}
        onSelectionDragStop={() => flushPositions(true)}
        onNodeClick={(_, n) => {
          if (n.data.generation || n.data.kind === "text") openGenerationPanelTarget({ projectId, canvasId: canvas.id, nodeId: n.id });
          useStore.setState({ selectedId: n.id, selectedEdgeId: null });
        }}
        onEdgeClick={(_, e) =>
          useStore.setState({ selectedId: null, selectedEdgeId: e.id })
        }
        onPaneContextMenu={(event) => {
          event.preventDefault();
          dismissCanvasContextMenus();
          const bounds = shellRef.current?.getBoundingClientRect();
          if (!bounds) return;
          useStore.setState({ selectedId: null, selectedEdgeId: null });
          setMore(false);
          setAddMenu({
            left: event.clientX - bounds.left,
            top: event.clientY - bounds.top,
            position: flow.screenToFlowPosition(
              { x: event.clientX, y: event.clientY },
              { snapToGrid: false },
            ),
          });
        }}
        onMoveStart={() => { movingViewport.current = true; updateInteraction(); setAddMenu(null); setMore(false); dismissCanvasContextMenus(); }}
        onPaneClick={() => {
          useStore.setState({ selectedId: null, selectedEdgeId: null });
          setAddMenu(null);
          setMore(false);
        }}
        onMoveEnd={(_, viewport) => {
          movingViewport.current = false;
          updateInteraction();
          const state = useStore.getState();
          if (state.project.id === projectId) state.editProject(project => ({ ...project,
            canvases: project.canvases.map(item => item.id === canvas.id ? { ...item, viewport } : item),
          }));
        }}
        defaultViewport={canvas.viewport}
        minZoom={0.1}
        maxZoom={4}
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={snapGrid}
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        nodesDraggable={!pan}
        nodesConnectable={!pan}
        selectionMode={SelectionMode.Partial}
        panOnDrag={[0, 1]}
        panActivationKeyCode="Space"
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        deleteKeyCode={["Backspace", "Delete"]}
        onBeforeDelete={async () => !document.querySelector('[aria-modal="true"]')}
        onlyRenderVisibleElements
        connectionLineStyle={connectionLineStyle}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={proOptions}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--canvas-grid)"
          gap={24}
          size={1.6}
        />
        {showMap && (
          <MiniMap
            pannable
            zoomable
            nodeColor="var(--minimap-node)"
            maskColor="var(--minimap-mask)"
            position="bottom-right"
          />
        )}
        <Controls position="bottom-right" showInteractive={false} />
        <GenerationPanel />
      </ReactFlow>
      </CanvasFlowSelection.Provider>
      <nav className="floating-toolbar" aria-label="画布工具栏">
        <IconButton title="资产库" onClick={() => useStore.setState({ modal: "assets" })}>
          <FolderOpen size={19} />
        </IconButton>
        <IconButton
          title="生成历史"
          onClick={() => useStore.setState({ modal: "history" })}
        >
          <History size={19} />
        </IconButton>
        <IconButton
          title="导出项目"
          onClick={() => {
            const s = useStore.getState();
            void exportProject(s.project, allWorkflows(s)).catch((e) =>
              s.notify(String(e)),
            );
          }}
        >
          <Download size={19} />
        </IconButton>
        <span className="toolbar-divider" />
        <IconButton title="添加画布工具" aria-expanded={more} onClick={() => { dismissCanvasContextMenus(); setMore(!more); }}>
          <Plus size={21} />
        </IconButton>
      </nav>
      {servicePanel && <NativeCanvasServicePanel key={servicePanel} service={servicePanel} onClose={() => onServicePanelChange(null)} />}
      {addMenu && (
        <div
          ref={menuRef}
          className="canvas-add-menu floating-menu"
          role="menu"
          aria-label="添加到画布"
          style={{ left: addMenu.left, top: addMenu.top }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            const buttons = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ??
                [],
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
              buttons[next]?.focus();
            }
            if (event.key === "Tab") setAddMenu(null);
          }}
        >
          <span className="eyebrow">添加到画布</span>
          {(
            [
              { kind: "reference", label: "参考", Icon: FolderOpen },
              { kind: "video", label: "视频", Icon: Clapperboard },
              { kind: "text", label: "文本", Icon: StickyNote },
              { kind: "audio", label: "音频", Icon: Music2 },
              { kind: "image-generation", label: "图像", Icon: Sparkles },
            ] as const
          ).map((item, i) => (
            <button role="menuitem" key={i} onClick={() => add(item.kind)}>
              <item.Icon size={17} />
              {item.label}
              <span>↗</span>
            </button>
          ))}
        </div>
      )}
      {more && (
        <div ref={moreMenuRef} className="more-menu floating-menu"
          onPointerDown={(event) => event.stopPropagation()}>
          <button onClick={() => useStore.getState().undo()}>
            <Undo2 size={16} />
            撤销 <kbd>Ctrl Z</kbd>
          </button>
          <button onClick={() => useStore.getState().redo()}>
            <Redo2 size={16} />
            重做 <kbd>Ctrl Y</kbd>
          </button>
          <button onClick={group}>
            <Group size={16} />
            编组
          </button>
          <button onClick={ungroup}>
            <Ungroup size={16} />
            取消编组
          </button>
          <button onClick={() => setShowMap(!showMap)}>切换缩略图</button>
        </div>
      )}
      {edge && (
        <div className="edge-editor">
          <div className="row between">
            <strong>素材角色</strong>
            <IconButton
              title="关闭角色编辑"
              onClick={() => useStore.setState({ selectedEdgeId: null })}
            >
              <X size={14} />
            </IconButton>
          </div>
          <select
            aria-label="连线角色"
            value={edge.data?.role ?? "auto"}
            disabled={busyPhases.includes(
              taskForNode(
                useStore.getState().project,
                canvas.nodes.find((n) => n.id === edge.target),
              ).status,
            )}
            onChange={(e) =>
              useStore.getState().editCanvas(
                (c) => ({
                  ...c,
                  edges: c.edges.map((x) =>
                    x.id === edge.id
                      ? {
                          ...x,
                          data: {
                            order: x.data?.order ?? 0,
                            role: e.target.value as Role,
                          },
                        }
                      : x,
                  ),
                }),
                true,
              )
            }
          >
            {edgeRoleOptions.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
          <small>{edgeWorkflow?.inputSlots && !textEdge ? "选择工作流输入；自动分配按连线顺序填入未指定的位置。" : "角色由所选工作流解释。"}</small>
        </div>
      )}
      <div className="canvas-bottom-left">
        <button onClick={() => useStore.setState({ modal: "help" })}>
          文档 <span>↗</span>
        </button>
        <button type="button" className="software-update-button" aria-label="软件更新"
          onClick={() => {
            setAddMenu(null); setMore(false);
            onServicePanelChange(null);
            openSoftwareUpdate();
          }}>
          <RefreshCw size={14} aria-hidden="true" />
          软件更新
        </button>
      </div>
      <div className="canvas-bottom-center">
        <button
          className={!pan ? "active" : ""}
          title="选择工具"
          onClick={() => setPan(false)}
        >
          <MousePointer2 size={17} />
        </button>
        <button
          className={pan ? "active" : ""}
          title="平移工具"
          onClick={() => setPan(true)}
        >
          <Hand size={17} />
        </button>
        <span />
        <button
          title="适应画布"
          onClick={() => void flow.fitView({ padding: 0.35, duration: 250 })}
        >
          <Focus size={17} />
        </button>
        <small>左键 / 中键平移 · Shift 框选</small>
      </div>
    </div>
  );
});
