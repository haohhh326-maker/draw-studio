import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../components/ui";
import { useStore } from "../stores/store";
import { libraryAssetNameParts } from "./library-details";
import { libraryAssets, isAssetInLibrary } from "./library-membership";
import { saveLibraryAsset } from "./library-entry";
import "./library-entry.css";

export function LibraryEntryDialog({ projectId, assetId, onClose }: { projectId: string; assetId: string; onClose: () => void }) {
  const project = useStore(state => state.project);
  const projectOpen = useStore(state => state.projectOpen);
  const navigating = useStore(state => state.navigating);
  const [source] = useState(() => {
    const state = useStore.getState(), asset = state.project.assets[assetId];
    return state.project.id === projectId && asset ? { asset, editing: isAssetInLibrary(asset, state.project) } : null;
  });
  // New entries are named by the user; remote output filenames are only format metadata.
  const [name, setName] = useState(() => source?.editing ? libraryAssetNameParts(source.asset).title : "");
  const [category, setCategory] = useState(source?.asset.libraryCategory ?? "");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const categoryListId = useId(), errorId = useId();
  const close = useRef(onClose); close.current = onClose;
  const current = project.id === projectId && projectOpen && !navigating ? project.assets[assetId] : undefined;
  useEffect(() => { if (!source || !current) close.current(); }, [!!source, !!current]);
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus(); input.current?.select();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  if (!source || !current) return null;
  const parts = libraryAssetNameParts(source.asset);
  const categories = [...new Set(libraryAssets(project).map(asset => asset.libraryCategory?.trim()).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return createPortal(<div ref={layer} className="library-entry-layer nodrag nopan nowheel"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onPaste={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(layer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <Modal title={source.editing ? "编辑资产信息" : "添加到资产库"} onClose={onClose}>
      <form className="library-entry-form" onSubmit={event => {
        event.preventDefault();
        try {
          saveLibraryAsset(projectId, assetId, name, category, source.asset);
          useStore.getState().notify(source.editing ? "资产信息已保存。" : "已添加到资产库。");
          onClose();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
      }}>
        <label><span>名称</span><div className="library-entry-name">
          <input ref={input} aria-label="素材名称" placeholder="输入素材名称" value={name} maxLength={255} aria-describedby={error ? errorId : undefined}
            onChange={event => { setName(event.target.value); setError(""); }}
            onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
          {parts.extension && <span aria-label={"文件类型 " + parts.extension}>{parts.extension}</span>}
        </div></label>
        <label><span>分类</span><input aria-label="素材分类" list={categoryListId} value={category} placeholder="输入或选择分类" maxLength={50}
          onChange={event => { setCategory(event.target.value); setError(""); }} /></label>
        <datalist id={categoryListId}>{categories.map(value => <option value={value} key={value} />)}</datalist>
        {error && <p className="library-entry-error" id={errorId} role="alert">{error}</p>}
        <div className="library-entry-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">保存</button></div>
      </form>
    </Modal>
  </div>, document.body);
}
