import {
  attachDirectorTransport,
  detachDirectorTransport,
  directorExtension,
  upstreamApp,
  type DirectorTransport,
} from "./upstream-runtime";
// @ts-expect-error Upstream distributes plain JavaScript without declarations.
import { resolveTaskKey } from "../../vendor/minimax-director/web/js/minimax_gen_timeline.js";

export type DirectorSnapshot = {
  values: Record<string, unknown>;
  timeline: Record<string, any>;
};
export type DirectorHostOptions = DirectorTransport & {
  nodeId?: string;
  signal?: AbortSignal;
  values?: Record<string, unknown>;
  timeline?: Record<string, unknown>;
  onChange?(snapshot: DirectorSnapshot): void;
};
export type DirectorHost = {
  node: any;
  editor: any;
  read(): DirectorSnapshot;
  setValues(patch: Record<string, unknown>): void;
  setProgress(detail: Record<string, unknown>): void;
  setError(message: string): void;
  destroy(): void;
};

export const DIRECTOR_TASK_OPTIONS = [
  "t2v — 文生视频(Text to Video)",
  "i2v — 图生视频(Image to Video)",
  "fl2v — 首尾帧生视频(First-Last Frame)",
  "r2v — 参考主体生视频(Reference to Video)",
  "v2v — 视频转视频(Video to Video)",
  "rv2v — 参考素材改视频(Reference Video Edit)",
  "mixed — 混合模式(Mixed Segments)",
];

function directorTaskOption(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const key = resolveTaskKey(value);
  return DIRECTOR_TASK_OPTIONS.find(option => resolveTaskKey(option) === key);
}

function timelineTask(timeline: unknown): unknown {
  if (!timeline || typeof timeline !== "object") return;
  const global = (timeline as Record<string, unknown>).global;
  return global && typeof global === "object" ? (global as Record<string, unknown>).taskType : undefined;
}

const adaptedModeEditors = new WeakSet<object>();

/** Preserve upstream mode logic while adapting its fixed ComfyUI slot to our content-sized host. */
export function enableDirectorModeCompatibility(editor: any): void {
  if (adaptedModeEditors.has(editor)) return;
  adaptedModeEditors.add(editor);
  const releaseBatchFlex = () => {
    // Upstream clears the other batch sizing styles when leaving batch mode,
    // but leaves main.style.flex = "1 1 0". With no LiteGraph slot height that
    // zero basis collapses fl2v and source-video controls in our auto-height host.
    if (!editor.isImageBatch?.()) editor.mainBody?.style.removeProperty("flex");
  };
  const layout = editor.applyTaskLayout;
  if (typeof layout === "function") editor.applyTaskLayout = function (...args: unknown[]) {
    const result = layout.apply(this, args);
    releaseBatchFlex();
    return result;
  };
  const globalField = editor.onGlobalField;
  if (typeof globalField === "function") editor.onGlobalField = function (field: string, value: unknown) {
    return globalField.call(this, field, field === "taskType" ? directorTaskOption(value) ?? value : value);
  };
  const populate = editor.populateTaskSelect;
  if (typeof populate === "function") editor.populateTaskSelect = function (element: HTMLSelectElement, selected: unknown) {
    return populate.call(this, element, directorTaskOption(selected) ?? selected);
  };
  const imported = editor.applyImportedTimeline;
  if (typeof imported === "function") editor.applyImportedTimeline = function (timeline: unknown, widgets: Record<string, unknown> = {}) {
    // Director packs can use bare keys or labels from another locale/version.
    // Match the original key; assigning a foreign label directly to <select>
    // clears its selection and can make UI/workspace modes disagree.
    const task = directorTaskOption(widgets.task_type || widgets.taskType || timelineTask(timeline));
    return imported.call(this, timeline, task ? { ...widgets, task_type: task } : widgets);
  };
  releaseBatchFlex();
}

const defaults: Record<string, unknown> = {
  task_type: DIRECTOR_TASK_OPTIONS[3], global_prompt: "", cfg: 1, seed: 0,
  frame_rate: 24, width: 864, height: 480, ref_max_size: 864,
  total_frames: 124, timeline_data: "", bd_grp_sample: "采样设置",
  bd_grp_advanced: "高级采样", steps: 25, sampler: "res_multistep", scheduler: "simple",
  shift_video: 12, shift_audio: 3, bd_grp_perf: "性能",
  clear_vram_between_segments: true, clear_vram_before_refine: false,
  clear_vram_before_face_refine: false, cache_frames_codec: "raw",
  export_source_images: false, export_pre_face_refine: false, cache_name: "",
};

/** Update real scalar widgets through their original callbacks, then publish one flushed edit. */
export function setDirectorWidgetValues(node: any, patch: Record<string, unknown>, changed: () => void): boolean {
  const edits: { widget: any; previous: unknown; value: unknown }[] = [];
  for (const [name, supplied] of Object.entries(patch)) {
    // These are the original editor's own state, not native sampling controls.
    if (name === "timeline_data" || name === "global_prompt" || name.startsWith("bd_grp_")) continue;
    const widget = node?.widgets?.find((candidate: any) => candidate.name === name
      && candidate.type !== "director" && candidate.serialize !== false);
    if (!widget) continue;
    const value = name === "task_type" ? directorTaskOption(supplied) : supplied;
    if (!["string", "number", "boolean"].includes(typeof value) || typeof value !== typeof widget.value
      || typeof value === "number" && !Number.isFinite(value)) continue;
    if (name === "cache_frames_codec" && !["raw", "ffv1"].includes(String(value))) continue;
    const choices = widget.options?.values;
    if (Array.isArray(choices) && !choices.includes(value)) continue;
    if (!Object.is(value, widget.value)) edits.push({ widget, previous: widget.value, value });
  }
  if (!edits.length) return false;
  // All callbacks see the complete patch, as they would after a native widget
  // store commit. The existing host onChange microtask coalesces notifications.
  for (const { widget, value } of edits) widget.value = value;
  for (const { widget, previous } of edits) {
    widget.callback?.call(widget, widget.value);
    node.onWidgetChanged?.(widget.name, widget.value, previous, widget);
  }
  node._minimaxEditor?.flushTimelineSync?.();
  changed();
  return true;
}

let load: Promise<unknown> | undefined;
let closeOriginalLoraPicker: (() => void) | undefined;
let loraPickerOwner: object | undefined;
function loadOriginalEditor() {
  return load ??= (async () => {
    // The imported JavaScript is copied verbatim from the pinned upstream commit.
    // @ts-expect-error Upstream distributes plain JavaScript without declarations.
    await import("../../vendor/minimax-director/web/js/minimax_timeline.js");
    // @ts-expect-error Upstream distributes plain JavaScript without declarations.
    const loras = await import("../../vendor/minimax-director/web/js/minimax_segment_loras.js");
    closeOriginalLoraPicker = loras.closeLoraPicker;
  })();
}

/** Own only upstream's body pickers created by an interaction inside this host. */
export function guardDirectorFilePickers(container: HTMLElement): () => void {
  const doc = container.ownerDocument;
  const pickers = new Set<HTMLInputElement>();
  let disposed = false, interactions = 0;
  const collect = (records: MutationRecord[]) => {
    for (const record of records) for (const added of record.addedNodes) {
      if (!(added instanceof HTMLInputElement) || added.type !== "file" || added.parentNode !== doc.body) continue;
      // Both upstream body picker helpers use this exact off-screen style. Do not
      // claim the application's unrelated file inputs or inputs inside dialogs.
      if (added.style.position !== "fixed" || added.style.left !== "-9999px"
        || added.style.opacity !== "0" || added.style.pointerEvents !== "none") continue;
      const change = added.onchange;
      added.onchange = function (event) { if (!disposed) return change?.call(this, event); };
      pickers.add(added);
    }
  };
  const observer = new MutationObserver(records => { if (interactions) collect(records); });
  observer.observe(doc.body, { childList: true });
  const begin = () => {
    if (disposed) return;
    // Discard changes made before this Director interaction.
    if (!interactions) observer.takeRecords();
    interactions++;
    queueMicrotask(() => {
      if (disposed) return;
      collect(observer.takeRecords());
      interactions--;
    });
  };
  const eventTypes = ["click", "dblclick", "keydown"] as const;
  for (const type of eventTypes) container.addEventListener(type, begin, true);
  return () => {
    if (disposed) return;
    if (interactions) collect(observer.takeRecords());
    disposed = true;
    observer.disconnect();
    for (const type of eventTypes) container.removeEventListener(type, begin, true);
    for (const input of pickers) {
      input.onchange = null;
      input.value = "";
      // Resolve upstream pickLocalFile's pending promise with null before its
      // input is removed. A later native dialog result cannot reach a new host.
      input.dispatchEvent(new Event("cancel"));
      input.remove();
    }
    pickers.clear();
  };
}

/** Keep the top-bar control discoverable without changing upstream selection eligibility. */
export function keepDirectorRunSelectionDiscoverable(editor: any): void {
  const update = editor.updateRunSelectUI;
  if (typeof editor.supportsRunSelect !== "function" || typeof update !== "function") return;
  let originalTitle = editor.btnRunSelectToggle?.title ?? "";
  let disabledTitle: string | undefined;
  editor.updateRunSelectUI = function (...args: unknown[]) {
    const result = update.apply(this, args);
    const button = this.btnRunSelectToggle;
    if (button) {
      // applyLocale can replace the title; restore that latest upstream title
      // when eligible again, rather than keeping our disabled explanation.
      if (disabledTitle === undefined || button.title !== disabledTitle) originalTitle = button.title;
      const supported = this.supportsRunSelect();
      disabledTitle = supported ? undefined : this.getRunnableSegmentCount() < 2
        ? "至少需要 2 个分组才能选择运行。"
        : "当前模式不支持选择运行。";
      button.classList.remove("hidden");
      button.disabled = !supported;
      button.title = disabledTitle ?? originalTitle;
    }
    return result;
  };
  editor.updateRunSelectUI();
}

/** Mount the original ComfyUI DOM widget without patching the application's canvas. */
export async function mountUpstreamDirector(container: HTMLElement, options: DirectorHostOptions): Promise<DirectorHost> {
  options.signal?.throwIfAborted();
  await loadOriginalEditor();
  options.signal?.throwIfAborted();
  const key = {};
  const requests = new AbortController();
  let disposed = false, muted = false, queued = false, lastSnapshot = "";
  let node: any;
  let activePackInput: HTMLInputElement | null = null;
  let pendingPackPicker: (() => void) | null = null;
  const graph: any = {
    _nodes: [], links: {},
    getNodeById(id: string | number) { return this._nodes.find((item: any) => String(item.id) === String(id)) ?? null; },
    setDirtyCanvas() {}, change() {},
  };
  const snapshot = (flush: boolean): DirectorSnapshot => {
    muted = true;
    try {
      if (flush) node?._minimaxEditor?.flushTimelineSync();
      const values = Object.fromEntries((node?.widgets ?? [])
        .filter((widget: any) => widget.name && widget.type !== "director" && widget.serialize !== false)
        .map((widget: any) => [widget.name, widget.value]));
      const raw = values.timeline_data;
      const timeline = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
      return { values, timeline };
    } finally { muted = false; }
  };
  const changed = () => {
    if (disposed || muted || queued || !node?._minimaxEditor) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || muted || !node?._minimaxEditor) return;
      const current = snapshot(false), signature = JSON.stringify(current.values);
      if (signature === lastSnapshot) return;
      lastSnapshot = signature;
      options.onChange?.(current);
    });
  };

  class CanvasDirectorNode {
    static comfyClass = "MiniMaxH3Director";
    [name: string]: any;
    id = options.nodeId ?? crypto.randomUUID();
    type = "MiniMaxH3Director";
    comfyClass = "MiniMaxH3Director";
    size = [Math.max(900, container.clientWidth), 1100];
    pos = [0, 0];
    graph = graph;
    inputs = ["model", "video_vae", "audio_vae", "clip", "i2v_groups", "r2v_groups"]
      .map(name => ({ name, link: null }));
    outputs = ["images", "audio", "fps", "frame_count", "source_images", "report", "images_pre_refine", "images_pre_face_refine"]
      .map((name, slot_index) => ({ name, slot_index, links: null }));
    widgets: any[];
    constructor() {
      const initialValues = { ...options.values };
      if (!initialValues.task_type) {
        const task = directorTaskOption(timelineTask(options.timeline));
        if (task) initialValues.task_type = task;
      }
      const values = { ...normalizeDirectorWidgetValues(initialValues),
        ...(options.timeline ? { timeline_data: JSON.stringify(options.timeline) } : {}) };
      this.widgets = Object.entries(values).map(([name, value]) => ({
        name, value, type: name.startsWith("bd_grp_") ? "BDGROUP" : typeof value,
        options: name === "task_type" ? { values: DIRECTOR_TASK_OPTIONS } : {},
        callback: () => changed(),
      }));
    }
    setSize(value: number[]) { this.size = value; }
    computeSize() {
      const widget = this._minimaxDomWidget;
      return [Math.max(900, container.clientWidth), Math.max(680, widget?.options?.getMinHeight?.() ?? 680)];
    }
    setDirtyCanvas() { changed(); }
    removeOutput(index: number) { this.outputs.splice(index, 1); }
    addDOMWidget(name: string, type: string, element: HTMLElement, widgetOptions: Record<string, any>) {
      const widget = { name, type, element, value: "", serialize: false,
        options: widgetOptions, computedHeight: 0, computedWidth: container.clientWidth };
      this.widgets.push(widget);
      container.appendChild(element);
      return widget;
    }
  }

  attachDirectorTransport(key, {
    apiURL: options.apiURL,
    // Shared project transport outlives any individual inline editor. A host
    // abort must not interrupt another node's media upload or revoke its URLs.
    fetchApi: options.fetchApi,
  }, graph);

  const interactions = new AbortController();
  const disposeFilePickers = guardDirectorFilePickers(container);
  const resizePointers = new Set<number>();
  container.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (button?.matches('.bd-seg-lora-pick,[data-r="seg-loras-add"]')
      || button?.matches(".bd-r2v-pick-existing") && button.closest(".bd-seg-loras-wrap")) loraPickerOwner = key;
  }, { capture: true, signal: interactions.signal });
  container.addEventListener("pointerdown", event => {
    if (event.target instanceof Element && event.target.closest(".bd-token-resize-handle")) resizePointers.add(event.pointerId);
  }, { capture: true, signal: interactions.signal });
  const released = (event: PointerEvent) => resizePointers.delete(event.pointerId);
  window.addEventListener("pointerup", released, { capture: true, signal: interactions.signal });
  window.addEventListener("pointercancel", released, { capture: true, signal: interactions.signal });
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    requests.abort();
    disposeFilePickers();
    pendingPackPicker?.();
    activePackInput?.remove();
    options.signal?.removeEventListener('abort', destroy);
    const ownsResize = resizePointers.size > 0;
    for (const pointerId of [...resizePointers]) {
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
    }
    interactions.abort();
    if (ownsResize) document.body.classList.remove("bd-token-resizing");
    if (loraPickerOwner === key) { closeOriginalLoraPicker?.(); loraPickerOwner = undefined; }
    const editor = node?._minimaxEditor;
    try { node?.onRemoved?.(); }
    finally {
      // Deferred layout callbacks in upstream may settle after this node was removed.
      if (editor) for (const name of ["scheduleRender", "scheduleSettleRender", "_observeViewportResize", "onNodeResize"]) editor[name] = () => {};
      for (const element of container.querySelectorAll("video,audio")) {
        const media = element as HTMLMediaElement;
        try { media.pause(); media.removeAttribute("src"); media.load(); } catch { /* already detached */ }
      }
      if (node) { node.widgets = []; node._minimaxDomWidget = null; }
      graph._nodes = [];
      container.replaceChildren();
      detachDirectorTransport(key);
    }
  };
  options.signal?.addEventListener("abort", destroy, { once: true });
  try {
    const extension = directorExtension();
    await extension.beforeRegisterNodeDef?.(CanvasDirectorNode, { name: "MiniMaxH3Director", output: [] });
    options.signal?.throwIfAborted();
    node = new CanvasDirectorNode();
    if (upstreamApp.graph?.getNodeById(node.id)) throw new Error("导演台节点 ID 重复，无法独立绑定编辑器。");
    graph._nodes.push(node);
    node.onNodeCreated?.();
    // loadedGraphNode mounts synchronously; the original deferred callback then reuses it.
    await extension.loadedGraphNode?.(node);
    options.signal?.throwIfAborted();
    const editor = node._minimaxEditor;
    if (!editor?.root) throw new Error("导演台原版界面加载失败，请重新打开。");
    enableDirectorModeCompatibility(editor);
    keepDirectorRunSelectionDiscoverable(editor);

    // Older upstream pickers keep detached inputs. Their callbacks enter these
    // editor methods rather than the body picker helper, so guard that boundary.
    for (const name of ["loadReferenceVideoFile", "loadVideoFile", "appendVideoFile", "addRefAudioFromFile", "addR2vCommonVideoFromFile", "addRefFromFile"]) {
      const method = editor[name];
      if (typeof method === "function") editor[name] = (...args: unknown[]) => {
        if (!disposed) return method.apply(editor, args);
      };
    }

    const packImport = editor.root.querySelector('[data-a="pack-import"]') as HTMLButtonElement | null;
    if (packImport) packImport.onclick = async (event: MouseEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (disposed || packImport.disabled) return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,.mmxpack.zip,application/zip";
      input.hidden = true;
      container.appendChild(input);
      activePackInput = input;
      const file = await new Promise<File | undefined>(resolve => {
        const finish = () => {
          const selected = input.files?.[0];
          input.remove();
          if (activePackInput === input) activePackInput = null;
          pendingPackPicker = null;
          resolve(selected);
        };
        pendingPackPicker = finish;
        input.addEventListener("change", finish, { once: true });
        input.addEventListener("cancel", finish, { once: true });
        input.click();
      });
      if (!file || disposed) return;
      packImport.disabled = true;
      const label = packImport.textContent;
      packImport.textContent = "正在导入…";
      try {
        const body = new FormData(); body.append("file", file, file.name);
        const response = await options.fetchApi("/minimax/director/import_pack", {
          method: "POST", body, signal: requests.signal,
        });
        if (!response.ok) throw new Error(await response.text() || "导演包导入失败。");
        const data = await response.json();
        if (!data?.timeline || typeof data.timeline !== "object") throw new Error("导演包缺少有效时间轴。");
        if (!disposed) editor.applyImportedTimeline(data.timeline, data.widgets ?? {});
      } catch (reason) {
        if (!disposed) {
          const message = reason instanceof Error ? reason.message : "导演包导入失败。";
          if (editor.showBdMessage) await editor.showBdMessage("导演包导入失败", message);
          else editor.setRunError(message);
        }
      } finally {
        if (!disposed) { packImport.disabled = false; packImport.textContent = label; }
      }
    };
    changed();
    return {
      node, editor,
      read: () => snapshot(true),
      setValues: patch => { if (!disposed) setDirectorWidgetValues(node, patch, changed); },
      setProgress: detail => { if (!disposed) editor.setRunProgress(detail); },
      setError: message => { if (!disposed) editor.setRunError(message); },
      destroy,
    };
  } catch (reason) { destroy(); throw reason; }
}


/** Discard graph links and reject misaligned ComfyUI widget exports at the host boundary. */
export function normalizeDirectorWidgetValues(input: Record<string, unknown> = {}): Record<string, unknown> {
  const values = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key];
    if (typeof value === typeof fallback && (typeof value !== "number" || Number.isFinite(value))) values[key] = value;
  }
  for (const key of ["bd_grp_sample", "bd_grp_advanced", "bd_grp_perf"]) {
    if (!String(values[key]).trim()) values[key] = defaults[key];
  }
  if (!["raw", "ffv1"].includes(String(values.cache_frames_codec))) values.cache_frames_codec = "raw";
  values.task_type = directorTaskOption(values.task_type) ?? defaults.task_type;
  return values;
}



