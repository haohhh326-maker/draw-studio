import { isRunningHubProvider, nodeComputeState } from "../compute/providers";
import { refreshMuseSession } from "../muse/session";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  ArrowLeft,
  Save,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  History,
  ListTodo,
  Activity as ActivityIcon,
  Settings as SettingsIcon,
  Monitor,
  Check,
} from "lucide-react";
import { ProjectHome } from "../projects/ProjectHome";
import { CanvasView } from "../canvas/CanvasView";
import { useStore, activeCanvas, taskForNode } from "../stores/store";
import { ComputeSettings } from "../settings/ComputeSettings";
import { ComputeSwitcher } from "../settings/ComputeSwitcher";
import { computeSwitcherAnchor, computeSwitcherTarget } from "../settings/compute-switcher-trigger";
import { WorkflowCredentialsDialog } from "../workflow/WorkflowCredentialsDialog";
import { workflowCredentialKey } from "../stores/store";
import { WorkflowLibraryDialog } from "../workflow/WorkflowLibraryDialog";
import { WorkflowImportDialog } from "../workflow/WorkflowImportDialog";
import { IconButton, Modal } from "../components/ui";
import { busyPhases, type ComputeProvider } from "../types";
import { importProject } from "../projects/storage";
import { AssetLibrary } from "../assets/AssetLibrary";
import { ExecutionPanel } from "../comfyui/ExecutionPanel";
import { OptimizationSettingsDock } from "../prompt-optimization/OptimizationControls";
import type { CanvasService } from "../services/NativeCanvasServicePanel";
import { MemoryCleanupButton } from "../comfyui/MemoryCleanupButton";
import { SoftwareUpdates } from "../updates/SoftwareUpdates";
import { softwareUpdateOpenEvent } from "../updates/software-update-client";
import {
  hasActiveTasks,
  recoverTasks,
} from "../generation/pipeline";

const RunningHubRemoteWorkflowDialog = lazy(() => import("../runninghub/RunningHubRemoteWorkflowDialog").then(module => ({ default: module.RunningHubRemoteWorkflowDialog })));
const Activity = lazy(() => import("./Activity").then(module => ({ default: module.Activity })));
const RunningHubWorkflowDialog = lazy(() => import("../runninghub/RunningHubWorkflowDialog").then(module => ({ default: module.RunningHubWorkflowDialog })));

function WorkspaceApp() {
  const project = useStore((s) => s.project),
    ready = useStore((s) => s.ready),
    projectOpen = useStore((s) => s.projectOpen),
    navigating = useStore((s) => s.navigating),
    saveState = useStore((s) => s.saveState),
    modal = useStore((s) => s.modal),
    credentialWorkflow = useStore(s => s.credentialWorkflow),
    toast = useStore((s) => s.toast),
    computeProvider = useStore(s => s.computeProvider);
  useEffect(() => {
    if (computeProvider !== "muse") return;
    const refresh = () => { void refreshMuseSession(); };
    refresh();
    const timer = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [computeProvider]);
  const canvas = useStore(activeCanvas),
    [display, setDisplay] = useState(false),
    [servicePanel, setServicePanel] = useState<CanvasService | null>(null);
  const [canvasToRename, setCanvasToRename] = useState<{ id: string; name: string } | null>(null);
  const [settingsProvider, setSettingsProvider] = useState<ComputeProvider>();
  useEffect(() => {
    const closePanels = () => { setServicePanel(null); setDisplay(false); useStore.setState({ modal: null }); };
    window.addEventListener(softwareUpdateOpenEvent, closePanels);
    return () => window.removeEventListener(softwareUpdateOpenEvent, closePanels);
  }, []);
  useEffect(() => { if (modal !== "settings") setSettingsProvider(undefined); }, [modal]);
  useEffect(() => { setServicePanel(null); setDisplay(false); }, [canvas.id]);
  useEffect(() => { setCanvasToRename(null); }, [projectOpen, project.id]);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasTabsRef = useRef<HTMLElement>(null);
  const [canvasTabScroll, setCanvasTabScroll] = useState({ left: false, right: false });
  const canvasTabContent = JSON.stringify(project.canvases.map(item => [item.id, item.name]));
  const executionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void useStore.getState().hydrate();
    const unload = (e: BeforeUnloadEvent) => {
      if (hasActiveTasks()) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  useEffect(() => {
    if (!window.drawStudioHost) return;
    const saveBeforeExit = async () => {
      while (useStore.getState().navigating) {
        await new Promise<void>(resolve => {
          const unsubscribe = useStore.subscribe(state => {
            if (!state.navigating) { unsubscribe(); resolve(); }
          });
          if (!useStore.getState().navigating) { unsubscribe(); resolve(); }
        });
      }
      const state = useStore.getState();
      if (state.ready && state.projectOpen) await state.save(true);
    };
    window.drawStudioSaveBeforeExit = saveBeforeExit;
    return () => {
      if (window.drawStudioSaveBeforeExit === saveBeforeExit) delete window.drawStudioSaveBeforeExit;
    };
  }, []);
  useEffect(() => {
    if (ready && projectOpen && !navigating) void recoverTasks();
  }, [ready, projectOpen, navigating, project.id]);
  useEffect(() => {
    const element = canvasTabsRef.current;
    if (!element) return;
    const update = () => setCanvasTabScroll({
      left: element.scrollLeft > 1,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      const activeTab = element.querySelector<HTMLElement>(".canvas-tab.active");
      if (activeTab) activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
      update();
    });
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [projectOpen, canvasTabContent]);
  useEffect(() => {
    const activeTab = canvasTabsRef.current?.querySelector<HTMLElement>(
      `[data-canvas-id="${canvas.id}"]`,
    );
    if (!activeTab) return;
    const frame = requestAnimationFrame(() => {
      const tabs = canvasTabsRef.current;
      if (!tabs) return;
      activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectOpen, canvas.id, canvasTabContent]);
  const openFile = async (file?: File) => {
    if (!file) return;
    try {
      if (hasActiveTasks()) throw new Error("请等待生成任务结束后再切换项目。");
      const result = await importProject(file);
      await useStore
        .getState()
        .enterProject(
          { ...result.project, id: crypto.randomUUID() },
          result.workflows.length
            ? result.workflows
            : useStore.getState().workflows,
        );
      useStore.getState().notify("项目与素材已恢复。");
    } catch (e) {
      useStore.getState().notify(String(e));
    }
  };
  const addCanvas = (sceneId = canvas.sceneId) => {
    const id = crypto.randomUUID();
    useStore.getState().editProject((p) => ({
      ...p,
      activeCanvasId: id,
      canvases: [
        ...p.canvases,
        {
          id,
          sceneId,
          name: "画布 " + (p.canvases.length + 1),
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      ],
    }));
    useStore.setState({ selectedId: null, past: [], future: [] });
  };
  const closeCanvas = (id: string) => {
    if (project.canvases.length === 1) {
      useStore.getState().notify("项目至少保留一张画布。");
      return;
    }
    const c = project.canvases.find((c) => c.id === id)!;
    if (
      c.nodes.some((n) => busyPhases.includes(taskForNode(project, n).status))
    ) {
      useStore.getState().notify("该画布有正在生成的任务。");
      return;
    }
    if (
      c.nodes.length &&
      !confirm("关闭并删除「" + c.name + "」？素材和生成历史仍保留。")
    )
      return;
    useStore.getState().editProject((p) => ({
      ...p,
      canvases: p.canvases.filter((c) => c.id !== id),
      activeCanvasId:
        p.activeCanvasId === id
          ? p.canvases.find((c) => c.id !== id)!.id
          : p.activeCanvasId,
    }));
    useStore.setState({ selectedId: null, past: [], future: [] });
  };
  const scrollCanvasTabs = (direction: number) => {
    canvasTabsRef.current?.scrollBy({ left: direction * 180, behavior: "smooth" });
  };
  const selectCanvas = (id: string) => {
    useStore.getState().editProject((p) => ({ ...p, activeCanvasId: id }));
    useStore.setState({ selectedId: null, selectedEdgeId: null });
    const tabs = canvasTabsRef.current;
    const tab = tabs?.querySelector<HTMLElement>(`[data-canvas-id="${id}"]`);
    if (tabs && tab) tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  };
  if (!ready)
    return (
      <div className="startup">
        <div className="brand-symbol">∞</div>
        <p>正在打开你的创作空间…</p>
      </div>
    );
  if (!projectOpen) return <>
    <ProjectHome onImport={openFile} />
    {modal === "settings" && <ComputeSettings onClose={() => useStore.setState({ modal: null })} />}
    {modal === "workflow-library" && <WorkflowLibraryDialog />}
    {modal === "workflow-import" && <WorkflowImportDialog />}
    {modal === "runninghub-remote-workflows" && <Suspense fallback={null}><RunningHubRemoteWorkflowDialog onClose={() => useStore.setState({ modal: null })} /></Suspense>}
    {modal === "runninghub-workflows" && <Suspense fallback={null}><RunningHubWorkflowDialog onClose={() => useStore.setState({ modal: null })} /></Suspense>}
    {credentialWorkflow && <WorkflowCredentialsDialog key={workflowCredentialKey(credentialWorkflow)} workflow={credentialWorkflow} onClose={() => useStore.getState().setCredentialWorkflow(null)} />}
  </>;
  return (
    <div className="app">
      <header className="topbar">
        <div className="project-section">
          <IconButton
            title="返回项目列表"
            onClick={() => {
              if (hasActiveTasks()) {
                useStore.getState().notify("请等待生成任务结束后再退出项目。");
                return;
              }
              setDisplay(false);
              void useStore
                .getState()
                .leaveProject()
                .catch((e) => useStore.getState().notify(String(e)));
            }}
          >
            <ArrowLeft size={18} />
          </IconButton>
          <div className="project-title">
            <span className="project-title-measure" aria-hidden="true">
              {project.name || " "}
            </span>
            <input
              aria-label="项目名称"
              title={project.name}
              value={project.name}
              onChange={(e) =>
                useStore
                  .getState()
                  .editProject((p) => ({ ...p, name: e.target.value }))
              }
            />
          </div>
          <IconButton
            title={`保存项目 · ${saveState}`}
            aria-label="保存项目"
            onClick={() => void useStore.getState().save()}
          >
            <Save size={16} />
          </IconButton>
          <div className="canvas-tab-group">
            <IconButton
              className="canvas-tab-scroll"
              title="查看前面的画布"
              aria-label="查看前面的画布"
              disabled={!canvasTabScroll.left}
              onClick={() => scrollCanvasTabs(-1)}
            >
              <ChevronLeft size={16} />
            </IconButton>
            <nav ref={canvasTabsRef} className="canvas-tabs" aria-label="画布标签">
              {project.canvases.map((c) => (
                <div
                  className={"canvas-tab " + (c.id === canvas.id ? "active" : "")}
                  key={c.id}
                  data-canvas-id={c.id}
                >
                  <button
                    onClick={() => selectCanvas(c.id)}
                    onDoubleClick={() => {
                      setServicePanel(null);
                      setDisplay(false);
                      setCanvasToRename({ id: c.id, name: c.name });
                    }}
                  >
                    {c.id === canvas.id && <i />}
                    <span className="canvas-tab-label" title={c.name}>{c.name}</span>
                    <ChevronRight className="canvas-tab-next" size={18} aria-hidden="true" />
                  </button>
                  <button
                    className="tab-close"
                    title={"关闭 " + c.name}
                    onClick={() => closeCanvas(c.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </nav>
            <IconButton className="canvas-tab-add" title="新建画布" onClick={() => addCanvas()}>
              <Plus size={20} />
            </IconButton>
            <IconButton
              className="canvas-tab-scroll"
              title="查看后面的画布"
              aria-label="查看后面的画布"
              disabled={!canvasTabScroll.right}
              onClick={() => scrollCanvasTabs(1)}
            >
              <ChevronRight size={16} />
            </IconButton>
          </div>
        </div>
        <div className="top-actions">
          <IconButton
            title="历史"
            onClick={() => useStore.setState({ modal: "history" })}
          >
            <History size={18} />
          </IconButton>
          <IconButton
            title="任务"
            onClick={() => useStore.setState({ modal: "tasks" })}
          >
            <ListTodo size={18} />
          </IconButton>
          <div ref={executionRef} className="execution-control">
          <IconButton title={computeProvider === "muse" ? "Muse 执行任务" : isRunningHubProvider(computeProvider) ? "RunningHub 执行任务" : "ComfyUI 执行与日志"} aria-expanded={modal === "execution" || modal === "tasks"} aria-controls={computeProvider === "comfyui" ? "execution-panel" : undefined} onClick={() => useStore.setState({ modal: computeProvider !== "comfyui" ? (modal === "tasks" ? null : "tasks") : (modal === "execution" ? null : "execution") })}>
            <ActivityIcon size={18} />
          </IconButton>
          </div>
          <MemoryCleanupButton />
          <IconButton
            title="设置"
            onClick={() => useStore.setState({ modal: "settings" })}
          >
            <SettingsIcon size={18} />
          </IconButton>
          <IconButton title="网页服务" aria-label="网页服务" aria-expanded={display} aria-controls="canvas-service-launcher" onClick={() => { setServicePanel(null); setDisplay(!display); }}>
            <Monitor size={18} />
          </IconButton>
        </div>
      </header>
      {display && (
        <div id="canvas-service-launcher" className="display-menu floating-menu" role="menu" aria-label="网页服务">
          <button type="button" role="menuitem" onClick={() => { setServicePanel(current => current === "muse" ? null : "muse"); setDisplay(false); }}>
            <img className="service-brand-icon" src="/brands/muse.svg" alt="" aria-hidden="true" />
            Muse
          </button>
          <button type="button" role="menuitem" onClick={() => { setServicePanel(current => current === "deepseek" ? null : "deepseek"); setDisplay(false); }}>
            <img className="service-brand-icon" src="/brands/deepseek.ico" alt="" aria-hidden="true" />
            DeepSeek
          </button>
        </div>
      )}
      <input
        hidden
        ref={fileRef}
        type="file"
        accept=".aicanvas,.zip"
        onChange={(e) => {
          void openFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <ReactFlowProvider key={canvas.id}>
        <CanvasView servicePanel={servicePanel} onServicePanelChange={setServicePanel} />
      </ReactFlowProvider>
      <OptimizationSettingsDock />
      {canvasToRename && (
        <Modal title="重命名画布" onClose={() => setCanvasToRename(null)}>
          <form className="canvas-rename-form" onSubmit={event => {
            event.preventDefault();
            const name = canvasToRename.name.trim();
            if (!name) return;
            useStore.getState().editProject(project => ({
              ...project,
              canvases: project.canvases.map(canvas => canvas.id === canvasToRename.id ? { ...canvas, name } : canvas),
            }));
            setCanvasToRename(null);
          }} onKeyDown={event => {
            if (event.key === "Escape") setCanvasToRename(null);
          }}>
            <label>画布名称
              <input autoFocus required value={canvasToRename.name}
                onFocus={event => event.target.select()}
                onChange={event => setCanvasToRename({ ...canvasToRename, name: event.target.value })} />
            </label>
            <div className="row">
              <button type="button" onClick={() => setCanvasToRename(null)}>取消</button>
              <button type="submit" className="primary" disabled={!canvasToRename.name.trim()}>保存</button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "settings" && <ComputeSettings initialProvider={settingsProvider} onClose={() => useStore.setState({ modal: null })} />}
      {modal === "compute-switcher" && <ComputeSwitcher anchorRef={computeSwitcherAnchor} target={computeSwitcherTarget.current} onClose={() => useStore.setState({ modal: null })}
        onOpenSettings={() => {
          const state = useStore.getState(), target = computeSwitcherTarget.current;
          setSettingsProvider(target?.nodeId ? nodeComputeState(state, target.canvasId, target.nodeId).computeProvider : state.computeProvider);
          useStore.setState({ modal: "settings" });
        }} onManageRunningHubWorkflows={() => useStore.setState({ modal: "runninghub-workflows" })} />}
      {modal === "runninghub-remote-workflows" && <Suspense fallback={null}><RunningHubRemoteWorkflowDialog onClose={() => useStore.setState({ modal: null })} /></Suspense>}
    {modal === "runninghub-workflows" && <Suspense fallback={null}><RunningHubWorkflowDialog onClose={() => useStore.setState({ modal: null })} /></Suspense>}
      {credentialWorkflow && <WorkflowCredentialsDialog key={workflowCredentialKey(credentialWorkflow)} workflow={credentialWorkflow} onClose={() => useStore.getState().setCredentialWorkflow(null)} />}
      {modal === "execution" && <ExecutionPanel anchorRef={executionRef} onClose={() => useStore.setState({ modal: null })} />}
      {modal === "assets" && <AssetLibrary />}
      {modal === "workflow-library" && <WorkflowLibraryDialog />}
      {modal === "workflow-import" && <WorkflowImportDialog />}
      {(modal === "history" || modal === "tasks") && <Suspense fallback={null}><Activity mode={modal} /></Suspense>}
      {modal === "help" && (
        <Modal
          title="创作，从一个节点开始"
          onClose={() => useStore.setState({ modal: null })}
        >
          <div className="help-content">
            <span className="eyebrow">Draw studio · 0.1.0</span>
            <h3>你的素材，你的镜头，你的无限画布。</h3>
            <ol>
              <li>右键画布空白处添加节点，也可直接拖入图片或视频。</li>
              <li>把素材右侧圆点连接到生成节点左侧。</li>
              <li>点击生成节点，在下方输入提示词并选择工作流。</li>
              <li>
                首次使用：在设置中连接工作站，在生成面板选择已配置的生成能力。
              </li>
              <li>点击生成，结果直接返回当前节点，可继续连接下一镜头。</li>
            </ol>
            <p>
              文生图和文生视频可直接输入提示词，也可连接文本节点；多个文本按连接顺序拼接，再追加面板中的补充描述。首尾帧可交换或手动指定角色。
            </p>
            <div className="shortcut-grid">
              <span>平移</span>
              <kbd>空白处左键 / 中键拖动</kbd>
              <span>多选</span>
              <kbd>Shift + 单击 / 拖动框选</kbd>
              <span>撤销 / 重做</span>
              <kbd>Ctrl Z / Ctrl Y</kbd>
              <span>复制 / 粘贴</span>
              <kbd>Ctrl C / Ctrl V</kbd>
              <span>编组 / 取消编组</span>
              <kbd>Ctrl G / Ctrl Shift G</kbd>
              <span>保存</span>
              <kbd>Ctrl S</kbd>
            </div>
            <p>
              本版本包含真实 API 管线，不附带模型或云端额度。项目与素材保存在本机。导出 .aicanvas
              文件可完整迁移项目。
            </p>
          </div>
        </Modal>
      )}
      {navigating && (
        <div className="project-transition" role="status">
          正在保存项目…
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={15} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <><WorkspaceApp /><SoftwareUpdates /></>;
}
