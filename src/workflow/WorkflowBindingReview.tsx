import { useEffect, useState } from "react";
import type { PreparedWorkflowImport } from "./import-pipeline";
import { applyImportReview, importPromptChoices, initialImportReview, type ImportBindingReview } from "./import-review";
import "./workflow-import.css";

export function WorkflowBindingReview({ prepared, busy, onSave }: {
  prepared: PreparedWorkflowImport; busy: boolean; onSave: (next: PreparedWorkflowImport) => Promise<void>;
}) {
  const [review, setReview] = useState(() => initialImportReview(prepared));
  const [error, setError] = useState("");
  useEffect(() => { setReview(initialImportReview(prepared)); setError(""); }, [prepared]);
  if (!prepared.graph || prepared.importState.status !== "ready") return null;
  const prompts = importPromptChoices(prepared);
  const promptKey = review.prompt ? JSON.stringify([review.prompt.nodeId, review.prompt.field]) : "";
  return <details className="workflow-import-bindings" aria-label="高级绑定调整">
    <summary>识别不符合预期？调整绑定</summary>
    <label>画布主提示词写入
      <select aria-label="画布主提示词写入" disabled={busy} value={promptKey} onChange={event => {
        const choice = prompts.find(field => JSON.stringify([field.nodeId, field.field]) === event.target.value);
        setReview({ ...review, prompt: choice ? { nodeId: choice.nodeId, field: choice.field, classType: prepared.graph![choice.nodeId].class_type } : null });
      }}>
        <option value="">不绑定主提示词（保留各文本参数）</option>
        {prompts.map(field => <option key={JSON.stringify([field.nodeId, field.field])} value={JSON.stringify([field.nodeId, field.field])}>{field.label} · 节点 {field.nodeId} / {field.field}</option>)}
      </select>
    </label>
    <p>只设置画布文字写入哪个字段；新节点的提示词仍为空。其他文本字段保留为独立参数。</p>
    {review.outputs.map((output, index) => <div className="workflow-import-binding-row workflow-import-output-review" key={output.nodeId + ":" + index}>
      <label>输出节点
        <span>{prepared.analysis.outputs.find(candidate => candidate.nodeId === output.nodeId)?.label ?? output.nodeId} · {output.nodeId}</span>
        <button type="button" disabled={busy || index === 0} onClick={() => setReview({ ...review, outputs: [output, ...review.outputs.filter((_, i) => i !== index)] })}>{index === 0 ? "主输出" : "设为主输出"}</button>
      </label>
      <label>结果类型
        <select aria-label={"输出类型 " + output.nodeId} disabled={busy} value={output.kind} onChange={event => setReview({ ...review,
          outputs: review.outputs.map((item, i) => i === index ? { ...item, kind: event.target.value as ImportBindingReview["outputs"][number]["kind"] } : item) })}>
          <option value="file">其他文件 / 自动识别</option><option value="image">图像</option><option value="video">视频</option><option value="audio">音频</option><option value="text">文本</option>
        </select>
      </label>
      <label>返回字段
        <input aria-label={"输出返回字段 " + output.nodeId} disabled={busy} value={output.field} onChange={event => setReview({ ...review,
          outputs: review.outputs.map((item, i) => i === index ? { ...item, field: event.target.value } : item) })} />
      </label>
    </div>)}
    <p>主输出决定工作流分类。返回字段填 * 可自动读取该节点的结果；已知字段也可填写 images、gifs、audio 或 text。确认绑定不代表已验证云端执行。</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="primary" disabled={busy} onClick={async () => {
      setError("");
      try { await onSave(applyImportReview(prepared, review)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }}>{busy ? "保存中…" : "保存绑定"}</button>
  </details>;
}
