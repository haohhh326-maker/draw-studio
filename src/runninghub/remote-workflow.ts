import type { ApiWorkflow, WorkflowDefinition } from "../types";
import type { ImportOutputBinding } from "../workflow/import-analyzer";
import { aifisherReadResultFor } from "../workflow/aifisher-reader-client";
import { automaticPromptCandidate } from "../workflow/automatic-prompt-binding";
import { savedOutputContracts } from "../workflow/output-contracts";
import { RunningHubClient, normalizeRunningHubBaseUrl } from "./client";
import { attachRunningHubExecutionContract } from "./execution-contract";
import { reviewRunningHubImportBindings, runningHubFieldKey } from "./import-review";
import { analyzeRunningHubUpstream, requireRunningHubReader, type RunningHubReaderResult } from "./upstream-reader";
import { parseRunningHubWorkflowReference, prepareRunningHubWorkflow } from "./workflows";
import { applyRunningHubWorkflowMetadata } from "./workflow-metadata";
import { runningHubRemoteCanvasParameterKeys } from "../generation/parameter-actions";
import { selectRunningHubBindings } from "./selected-bindings";

export type RemoteRunningHubDraft = {
  workflowId: string;
  baseUrl: string;
  sourceUrl: string;
  name: string;
  graph: ApiWorkflow;
  reader: RunningHubReaderResult;
  promptKey: string;
  outputs: ImportOutputBinding[];
  warnings: string[];
  metadata: Awaited<ReturnType<RunningHubClient["getWorkflowMetadata"]>>;
};

/** Only public text controls can be selected; model and credential fields never qualify. */
export function remoteWorkflowPromptChoices(reader: RunningHubReaderResult) {
  return analyzeRunningHubUpstream(reader).prompts.filter(field => {
    const candidate = reader.bindingCandidates.find(item => item.nodeId === field.nodeId && item.fieldName === field.field);
    return !candidate?.modelKind && !/(?:^|_)(?:model|ckpt|unet|vae|lora|clip)(?:_|$)|^(?:filename_prefix|file_name|filename)$/i.test(field.field)
      && !/\.(?:safetensors|ckpt|gguf|pt|pth|onnx|bin)$/i.test(field.value);
  });
}

/** Authored prompt examples are not defaults for newly created canvas controls. */
function clearCanvasPromptDefaults(workflow: WorkflowDefinition) {
  const textPromptField = (field: string, classType: string, label: string) =>
    /^(?:prompt|positive_prompt|negative_prompt|positivePrompt|negativePrompt|positive|negative|instruction|instructions|description)$/i.test(field)
    || field === "text" && /(?:TextEncode|Prompt|Text|String|Instruction|Description)/i.test(classType)
    || /(?:提示词|正向提示|负向提示|反向提示)/.test(label);
  return workflow.parameters.map(parameter => {
    const target = workflow.mapping.find(item => item.semantic === parameter.key);
    if (parameter.type !== "text" || parameter.secret || parameter.model || !target) return parameter;
    const node = workflow.template?.[target.nodeId];
    return node && textPromptField(target.field, node.class_type, parameter.label) ? { ...parameter, default: "" } : parameter;
  });
}

/** Read the existing platform template. No local directory or execution environment is involved. */
export async function readRunningHubRemoteWorkflow(
  client: Pick<RunningHubClient, "getWorkflow" | "getWorkflowMetadata">,
  reference: string, baseUrl: string, signal?: AbortSignal, saved?: WorkflowDefinition,
): Promise<RemoteRunningHubDraft> {
  signal?.throwIfAborted();
  const site = normalizeRunningHubBaseUrl(baseUrl);
  const workflowId = parseRunningHubWorkflowReference(reference, site);
  const graph = await client.getWorkflow(workflowId, signal);
  signal?.throwIfAborted();
  const read = aifisherReadResultFor(graph);
  const reader = requireRunningHubReader(read);
  if (reader.environment !== "runninghub-workflow") throw new Error("请使用 RunningHub ComfyUI 工作流链接读取，AI 应用请从独立入口添加。");
  const analysis = analyzeRunningHubUpstream(reader);
  const review = reviewRunningHubImportBindings(graph, analysis, saved);
  const promptChoices = remoteWorkflowPromptChoices(reader);
  const automaticPrompt = !saved && read ? automaticPromptCandidate(read) : undefined;
  const selectedPrompt = saved ? review.promptKey
    : automaticPrompt ? runningHubFieldKey(automaticPrompt.nodeId, automaticPrompt.fieldName) : "";
  const promptKey = promptChoices.some(field => runningHubFieldKey(field.nodeId, field.field) === selectedPrompt) ? selectedPrompt : "";
  const outputs = review.outputs.map(output => {
    if (saved && output.kind !== "file") return output;
    const exact = savedOutputContracts[graph[output.nodeId]?.class_type];
    return exact ? { ...output, ...exact } : output;
  });
  let metadata: RemoteRunningHubDraft["metadata"] = {};
  try { metadata = await client.getWorkflowMetadata(workflowId, "workflow", signal); }
  catch { signal?.throwIfAborted(); /* A public card is optional; the authenticated graph is authoritative. */ }
  signal?.throwIfAborted();
  const warnings = [...new Set([...analysis.warnings.filter(warning => !warning.includes("未声明这些输出")), ...review.warnings])];
  if (outputs.some(output => output.kind === "file" && output.field === "*")) warnings.push("部分输出未声明媒体类型，可在下方选择实际输出类型；原工作流结构保持完整。");
  return { workflowId, baseUrl: site, sourceUrl: site + "/workflow/" + workflowId,
    name: saved?.runninghub?.nameSource === "custom" ? saved.name : metadata.name?.trim().slice(0, 120) || saved?.name || "RunningHub 工作流 " + workflowId,
    graph, reader, promptKey, outputs, warnings, metadata };
}

/** The canvas stores a remote reference and binding snapshot, never a local workflow folder. */
export async function prepareRunningHubRemoteWorkflow(draft: RemoteRunningHubDraft): Promise<WorkflowDefinition> {
  const result = prepareRunningHubWorkflow(draft.graph, {
    workflowId: draft.workflowId, baseUrl: draft.baseUrl, name: draft.name,
    promptKey: draft.promptKey, outputs: draft.outputs, reader: draft.reader,
  });
  let workflow = applyRunningHubWorkflowMetadata(result.workflow, draft.metadata);
  workflow = { ...workflow, name: draft.name.trim(), defaultPrompt: undefined, parameters: clearCanvasPromptDefaults(workflow),
    runninghub: { ...workflow.runninghub!, kind: "workflow", billingMode: "consumer", bindingMode: "selected", includeWorkflowJson: false,
      nameSource: draft.name.trim() === draft.metadata.name?.trim() ? "platform" : "custom" } };
  return attachRunningHubExecutionContract(selectRunningHubBindings(workflow, runningHubRemoteCanvasParameterKeys(workflow)));
}
