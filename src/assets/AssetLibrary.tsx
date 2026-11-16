import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderOpen, Pencil, Plus, Trash2, Upload, LoaderCircle } from "lucide-react";
import { Modal } from "../components/ui";
import { useStore, activeCanvas } from "../stores/store";
import { getBlob, download } from "../projects/storage";
import { getMediaNodeSize } from "../nodes/media-layout";
import { importAsset } from "./assets";
import { AssetPreview } from "./AssetPreview";
import { generatedAssetIds, libraryAssets } from "./library-membership";
import { rememberLibraryAssetDimensions } from "./library-details";
import { removeLibraryAsset } from "./library-entry";
import { LibraryEntryDialog } from "./LibraryEntryDialog";
import type { Asset, MediaKind } from "../types";
import "./asset-library.css";

const kindNames: Record<MediaKind, string> = { image: "图像", video: "视频", audio: "音频", text: "文本", file: "文件" };
const categoryPrefix = "category:";
const assetCategory = (asset: Asset) => typeof asset.libraryCategory === "string" ? asset.libraryCategory.trim() : "";

export function AssetLibrary() {
  const project = useStore(state => state.project);
  const [kind, setKind] = useState<MediaKind | "all">("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [editingEntry, setEditingEntry] = useState<{ projectId: string; assetId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const generated = useMemo(() => generatedAssetIds(project), [project.history, project.tasks]);
  const members = useMemo(() => libraryAssets(project), [project.assets, project.history, project.tasks]);
  const categories = useMemo(() => [...new Set(members.map(assetCategory).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })), [members]);
  useEffect(() => { setCategory("all"); setEditingEntry(null); }, [project.id]);
  useEffect(() => {
    // Removing or recategorizing the final member must not leave an invalid select value.
    if (category.startsWith(categoryPrefix) && !categories.includes(category.slice(categoryPrefix.length))) setCategory("all");
  }, [category, categories]);
  const assets = members.filter(asset => (kind === "all" || asset.kind === kind)
    && (category === "all" || (category === "uncategorized" ? !assetCategory(asset) : category === categoryPrefix + assetCategory(asset)))
    && asset.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  async function upload(files: File[]) {
    if (!files.length || busyRef.current) return;
    const projectId = useStore.getState().project.id;
    busyRef.current = true; setBusy(true);
    try {
      for (const file of files) {
        if (!mounted.current || useStore.getState().project.id !== projectId || !useStore.getState().projectOpen) break;
        try {
          const asset = { ...await importAsset(file, file.name), inLibrary: true };
          const state = useStore.getState();
          // An import started in this project must never land in another project.
          if (state.project.id !== projectId || !state.projectOpen) break;
          state.editProject(current => ({ ...current, assets: { ...current.assets, [asset.id]: asset } }));
        } catch (error) { useStore.getState().notify(String(error)); }
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function addToCanvas(asset: Asset) {
    const state = useStore.getState();
    if (!state.projectOpen || state.project.id !== project.id || !state.project.assets[asset.id]) return;
    const canvas = activeCanvas(state);
    const bounds = document.querySelector(".canvas-shell")?.getBoundingClientRect();
    const size = getMediaNodeSize(asset.width, asset.height);
    const offset = canvas.nodes.length % 5 * 28;
    const position = bounds ? { x: (bounds.width / 2 - canvas.viewport.x) / canvas.viewport.zoom - size.width / 2 + offset,
      y: (bounds.height / 2 - canvas.viewport.y) / canvas.viewport.zoom - size.height / 2 + offset } : { x: 240 + offset, y: 170 + offset };
    state.addAsset(asset, position);
    state.notify("已添加到当前画布。");
  }

  return <><Modal title="资产库" wide onClose={() => useStore.setState({ modal: null })}>
    <div className="asset-library" onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); void upload(Array.from(event.dataTransfer.files)); }}
      onPaste={event => { event.stopPropagation(); if (event.clipboardData.files.length) { event.preventDefault(); void upload(Array.from(event.clipboardData.files)); } }}>
      <div className="asset-library-header">
        <input type="search" aria-label="搜索素材" placeholder="搜索素材名称" value={search} onChange={event => setSearch(event.target.value)} />
        <select className="asset-library-category-filter" aria-label="资产分类" value={category} onChange={event => setCategory(event.target.value)}>
          <option value="all">全部分类</option><option value="uncategorized">未分类</option>
          {categories.map(name => <option key={name} value={categoryPrefix + name}>{["全部分类", "未分类"].includes(name) ? name + "（自定义）" : name}</option>)}
        </select>
        <button type="button" className="asset-library-import" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <LoaderCircle size={16} className="asset-library-spin" /> : <Upload size={16} />}{busy ? "导入中…" : "导入素材"}
        </button>
        <input ref={fileRef} hidden type="file" multiple aria-label="选择素材文件" onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files);
        }} />
      </div>
      <div className="asset-library-filters" role="group" aria-label="素材类型">
        {(["all", "image", "video", "audio", "text", "file"] as const).map(value => <button type="button" key={value}
          aria-pressed={value === kind} onClick={() => setKind(value)}>{value === "all" ? "全部" : kindNames[value]}</button>)}
        <span>{assets.length} 项</span>
      </div>
      {assets.length ? <div className="asset-library-grid">{assets.map(asset => <AssetLibraryCard key={project.id + ":" + asset.id}
        asset={asset} projectId={project.id} generated={generated.has(asset.id)} onAddToCanvas={addToCanvas}
        onEdit={() => setEditingEntry({ projectId: project.id, assetId: asset.id })} />)}</div> : <div className="empty-state"><FolderOpen size={32} /><h3>{members.length ? "没有匹配的素材" : "资产库还是空的"}</h3>
        <p>{members.length ? "可以切换素材类型、资产分类或修改搜索词。" : "导入素材，或右键生成结果添加到资产库。"}</p></div>}
    </div>
  </Modal>
    {editingEntry && <LibraryEntryDialog projectId={editingEntry.projectId} assetId={editingEntry.assetId} onClose={() => setEditingEntry(null)} />}
  </>;
}

function AssetLibraryCard({ asset, projectId, generated, onAddToCanvas, onEdit }: {
  asset: Asset; projectId: string; generated: boolean; onAddToCanvas: (asset: Asset) => void; onEdit: () => void;
}) {
  const [error, setError] = useState("");
  const visual = asset.kind === "image" || asset.kind === "video", category = assetCategory(asset);
  const remove = () => {
    try { removeLibraryAsset(projectId, asset.id); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "从资产库移除失败。"); }
  };
  return <article>
    <div className={"asset-library-preview" + (visual ? " asset-library-visual-preview" : "")}>
      <AssetPreview asset={asset} onDimensions={visual ? (width, height) => rememberLibraryAssetDimensions(projectId, asset.id, width, height) : undefined} />
    </div>
    <div className="asset-library-info">
      <div className="asset-library-name"><strong title={asset.name}>{asset.name}</strong>
        <button type="button" aria-label={"编辑名称和分类 " + asset.name} title="编辑名称和分类" onClick={onEdit}><Pencil size={14} /></button>
        <button type="button" className="asset-library-remove" aria-label={"从资产库移除 " + asset.name} title="从资产库移除" onClick={remove}><Trash2 size={14} /></button></div>
      {error && <p className="asset-library-name-error" role="alert">{error}</p>}
      <small className="asset-library-category" title={"分类：" + (category || "未分类")}>分类：{category || "未分类"}</small>
      <small>{kindNames[asset.kind]} · {generated ? "生成" : "导入"} · {(asset.size / 1024 / 1024).toFixed(1)} MB</small>
      <div className="asset-library-actions">
        <button type="button" onClick={() => onAddToCanvas(asset)}><Plus size={14} />添加到画布</button>
        <button type="button" aria-label={"下载 " + asset.name} title="下载素材" onClick={() => {
          void getBlob(asset.id, asset.mime).then(blob => download(blob, asset.name)).catch(cause => useStore.getState().notify(String(cause)));
        }}><Download size={15} /></button>
      </div>
    </div>
  </article>;
}
