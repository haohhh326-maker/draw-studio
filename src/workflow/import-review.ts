import type { PreparedWorkflowImport } from "./import-pipeline";
import type { ImportOutputKind } from "./import-analyzer";
import { isWorkflowCredentialFieldName } from "./credentials";

type Target = { nodeId: string; field: string; classType: string };
export type ImportBindingReview = {
  version: 1;
  prompt: Target | null;
  outputs: (Target & { kind: ImportOutputKind })[];
};
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (nodeId: string, field: string) => JSON.stringify([nodeId, field]);
const kinds = ["image", "video", "audio", "text", "file"];

export function importPromptChoices(prepared: PreparedWorkflowImport) {
  const media = new Set(prepared.analysis.inputs.map(input => identity(input.nodeId, input.field)));
  const parameters = Array.isArray(prepared.config.parameters) ? prepared.config.parameters.filter(record) : [];
  return prepared.analysis.fields.filter(field => typeof field.value === "string"
    && !media.has(identity(field.nodeId, field.field)) && !isWorkflowCredentialFieldName(field.field)
    && !parameters.some(parameter => parameter.binding?.nodeId === field.nodeId && parameter.binding?.path === "inputs." + field.field
      && (parameter.secret || parameter.model || parameter.type === "enum")));
}

export function initialImportReview(prepared: PreparedWorkflowImport): ImportBindingReview {
  const graph = prepared.graph ?? {};
  const prompt = record(prepared.config.prompt) && record(prepared.config.prompt.binding) ? prepared.config.prompt.binding : undefined;
  const execution = record(prepared.config.execution) ? prepared.config.execution : {};
  const outputs = Array.isArray(execution.outputs) ? execution.outputs : execution.output ? [execution.output] : [];
  return { version: 1,
    prompt: prompt && typeof prompt.path === "string" ? { nodeId: prompt.nodeId, field: prompt.path.slice(7), classType: graph[prompt.nodeId]?.class_type ?? "" } : null,
    outputs: outputs.filter(record).map(output => ({ nodeId: output.nodeId, field: output.field, kind: output.kind, classType: graph[output.nodeId]?.class_type ?? "" })),
  };
}

/** Apply explicit canvas bindings only; the upstream execution graph stays intact. */
export function applyImportReview(prepared: PreparedWorkflowImport, review: ImportBindingReview): PreparedWorkflowImport {
  if (!prepared.graph || prepared.importState.status !== "ready") throw new Error("请先完成工作流转换，再确认提示词和输出。");
  if (review?.version !== 1 || !Array.isArray(review.outputs) || !review.outputs.length) throw new Error("至少需要一个输出绑定。");
  const graph = prepared.graph;
  const validTarget = (target: Target) => record(target) && typeof target.nodeId === "string"
    && typeof target.field === "string" && Object.hasOwn(graph, target.nodeId) && graph[target.nodeId].class_type === target.classType;
  if (review.prompt !== null && (!validTarget(review.prompt) || !importPromptChoices(prepared).some(field =>
    field.nodeId === review.prompt!.nodeId && field.field === review.prompt!.field))) throw new Error("提示词绑定已失效，请重新选择。");
  const candidates = new Set(prepared.analysis.outputs.map(output => output.nodeId));
  const seen = new Set<string>();
  for (const output of review.outputs) {
    if (!validTarget(output)) throw new Error("输出绑定已失效，请重新确认。");
    const key = identity(output.nodeId, output.field);
    if (!candidates.has(output.nodeId) || !kinds.includes(output.kind)
      || !output.field.trim() || /[\u0000-\u001f]/.test(output.field) || seen.has(key)) throw new Error("输出绑定已失效或重复，请重新确认。");
    seen.add(key);
  }
  if (new Set(review.outputs.map(output => output.nodeId)).size !== candidates.size) throw new Error("请保留并确认全部输出候选。");
  const config = structuredClone(prepared.config);
  const parameters = (Array.isArray(config.parameters) ? config.parameters : []).filter(record);
  const previous = initialImportReview(prepared).prompt;
  if (previous && (!review.prompt || identity(previous.nodeId, previous.field) !== identity(review.prompt.nodeId, review.prompt.field))
    && !parameters.some(parameter => parameter.binding?.nodeId === previous.nodeId && parameter.binding?.path === "inputs." + previous.field)) {
    const base = "input:" + previous.nodeId + ":" + previous.field;
    let key = base;
    for (let suffix = 2; parameters.some(parameter => parameter.id === key); suffix++) key = base + ":" + suffix;
    parameters.push({ id: key, type: "string", label: (graph[previous.nodeId]._meta?.title ?? previous.nodeId) + " · " + previous.field,
      defaultValue: graph[previous.nodeId].inputs[previous.field], ui: { placement: "advanced", multiline: true },
      binding: { target: "comfyui", nodeId: previous.nodeId, path: "inputs." + previous.field } });
  }
  config.parameters = parameters.filter(parameter => !review.prompt || parameter.binding?.nodeId !== review.prompt.nodeId || parameter.binding?.path !== "inputs." + review.prompt.field);
  if (review.prompt) config.prompt = { required: false, binding: { target: "comfyui", nodeId: review.prompt.nodeId, path: "inputs." + review.prompt.field } };
  else delete config.prompt;
  const outputs = review.outputs.map(({ nodeId, field, kind }) => ({ nodeId, field, kind }));
  config.execution = { ...(record(config.execution) ? config.execution : {}), output: outputs[0], outputs };
  config.nodeKind = outputs[0].kind;
  config.primaryCategoryLabel = { image: "图像工具", video: "视频工具", audio: "音频工具", text: "文本工具", file: "其他工具" }[outputs[0].kind];
  config.importBindingReview = structuredClone(review);
  return { ...prepared, config, analysis: { ...prepared.analysis, outputs: outputs.map(output => ({ ...output,
    label: prepared.analysis.outputs.find(candidate => candidate.nodeId === output.nodeId)?.label ?? output.nodeId, needsBinding: false })) } };
}

export function importReadiness(prepared: PreparedWorkflowImport, liveSchema = false) {
  const report = prepared.importState.environmentReport;
  return {
    read: prepared.importState.status === "ready" ? "已读取并转换" : "原文件已保留，转换待完成",
    bindings: prepared.importState.status !== "ready" ? "等待转换" : prepared.config.importBindingReview ? "使用已保存的自定义绑定"
      : prepared.config.prompt ? "提示词已自动绑定；输出按运行结果识别" : "已保留独立文本参数；输出按运行结果识别",
    execution: liveSchema ? report?.hasBlockingIssues ? "发现待处理的环境或执行兼容问题，详见下方清单" : "已读取当前节点定义；模型、插件运行和生成尚未验证" : "当前云端能力未确认；缓存仅供读取参考",
  };
}
