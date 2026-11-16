import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../components/ui";
import { useStore, workflowCredentialValues } from "../stores/store";
import type { WorkflowDefinition } from "../types";
import { detectWorkflowCredentials } from "./credentials";
import "./workflow-credentials.css";

export function WorkflowCredentialsDialog({ workflow, onClose }: { workflow: WorkflowDefinition; onClose: () => void }) {
  const fields = detectWorkflowCredentials(workflow);
  const saved = useStore(state => workflowCredentialValues(state, workflow));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const layer = useRef<HTMLDivElement>(null), firstInput = useRef<HTMLInputElement>(null);
  const descriptionId = useId(), errorId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    firstInput.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const hasSaved = (id: string) => !!saved[id]?.trim() && !cleared.includes(id);
  return createPortal(<div className="workflow-credentials-layer nodrag nopan nowheel" ref={layer}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onPaste={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && !saving) { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = [...layer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <Modal title="工作流 API Key" onClose={() => { if (!saving) onClose(); }}>
      <form className="workflow-credentials-form" onSubmit={async event => {
        event.preventDefault();
        if (saving) return;
        const next = Object.fromEntries(fields.map(field => [field.id, cleared.includes(field.id) ? "" : drafts[field.id]?.trim() || saved[field.id] || ""]));
        setSaving(true); setError("");
        try {
          await useStore.getState().saveWorkflowCredentials(workflow, next);
          onClose();
        } catch { setError("密钥保存失败，请重试。"); setSaving(false); }
      }}>
        <p className="workflow-credentials-name">{workflow.name}</p>
        <p className="workflow-credentials-description" id={descriptionId}>已读取此工作流需要的密钥。单独保存在本机，仅在运行此工作流时使用。</p>
        {fields.length ? <div className="workflow-credentials-fields">{fields.map((field, index) => <label className="workflow-credentials-field" key={field.id}>
          <span>{field.label}{field.required && <span className="workflow-credentials-required" aria-label="必填"> *</span>}</span>
          <small>{workflow.template?.[field.nodeId]?._meta?.title || workflow.template?.[field.nodeId]?.class_type || "节点"} · {field.nodeId}.{field.field}</small>
          <div className="workflow-credentials-input">
            <input ref={index === 0 ? firstInput : undefined} type="password" autoComplete="off" spellCheck={false} disabled={saving}
              aria-label={field.label + " · " + field.nodeId + "." + field.field} aria-describedby={descriptionId + (error ? " " + errorId : "")}
              value={drafts[field.id] ?? ""} placeholder={hasSaved(field.id) ? "已保存，仅更换时输入新 Key" : cleared.includes(field.id) ? "保存后清除" : "输入 API Key"}
              onChange={event => { const value = event.target.value; setDrafts(current => ({ ...current, [field.id]: value })); setCleared(current => current.filter(id => id !== field.id)); setError(""); }} />
            {(hasSaved(field.id) || !!drafts[field.id]) && <button type="button" disabled={saving} aria-label={"清除 " + field.label + " · " + field.nodeId + "." + field.field}
              onClick={() => { setDrafts(current => ({ ...current, [field.id]: "" })); setCleared(current => [...current.filter(id => id !== field.id), field.id]); setError(""); }}>清除</button>}
          </div>
        </label>)}</div> : <p>此工作流不需要单独填写 API Key。</p>}
        {error && <p className="workflow-credentials-error" id={errorId} role="alert">{error}</p>}
        <div className="workflow-credentials-actions"><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
      </form>
    </Modal>
  </div>, document.body);
}
