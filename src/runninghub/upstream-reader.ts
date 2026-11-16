import type { ApiWorkflow, MediaKind, Parameter, WorkflowDefinition } from "../types";
import type { ImportAnalysis, ImportMediaBinding, ImportOutputBinding } from "../workflow/import-analyzer";
import { isRunningHubAppCredentialField } from "./client";
import { declaredWorkflowCategory } from "./classification";
import type { AifisherRawParameterBinding, AifisherParameterBindingDto, AifisherWorkflowReadResult } from "../workflow/aifisher-reader-client";
import { aifisherCanvasBindingCandidates, assertAifisherVariableAssetsSupported } from "../workflow/aifisher-variable-assets";
import { aifisherExternalAssetCandidate, aifisherOutputBindingAllowed, aifisherPublishedOutputCandidates } from "../workflow/aifisher-io-contracts";

type Candidate = { nodeId: string; fieldName: string; nodeTitle?: string; value: unknown; control?: string; valueType?: string; mediaKind?: string | null; required?: boolean; options?: unknown[] | null; minimum?: number | null; maximum?: number | null; step?: number | null; modelKind?: string | null };
type PlannedOutput = { nodeId: string; title?: string; classType?: string; outputTypes?: string[] };
/** The upstream server is the source of field, capability and category evidence. */
export type RunningHubReaderResult = {
  environment: "comfyui" | "runninghub-workflow" | "runninghub-webapp";
  upstream: { repository: string; revision: string };
  workflow: ApiWorkflow | null;
  format: string;
  analysis: { compileStatus?: string; candidateOutputs?: PlannedOutput[]; warnings?: { code: string; nodeId?: string; fieldName?: string }[] };
  bindingCandidates: Candidate[];
  parameterBindings?: AifisherRawParameterBinding[];
  parameterBindingDto?: AifisherParameterBindingDto;
  credentialTargets?: { nodeId: string; fieldName: string }[];
  canvasBlueprint?: Record<string, unknown>;
  nodeDefinitions?: Record<string, unknown>;
  nodeDefinitionEvidence?: Record<string, { outputNode?: boolean }>;
  category?: "image" | "video" | "audio" | "motion";
  projection?: { snapshot: { appName: string; categoryId: string; fields: { nodeId: string; fieldName: string; kind: string; label: string }[] } };
};

const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const kind = (value: string | null | undefined): "image" | "video" | "audio" | undefined => value === "mask" ? "image" : value === "image" || value === "video" || value === "audio" ? value : undefined;
const fieldLabel = (candidate: Candidate, reader: RunningHubReaderResult) => reader.projection?.snapshot.fields
  .find(field => field.nodeId === candidate.nodeId && field.fieldName === candidate.fieldName)?.label
  || [candidate.nodeTitle, candidate.fieldName].filter(Boolean).join(" · ");
const secret = (candidate: Candidate, reader: RunningHubReaderResult) => reader.credentialTargets?.some(target => target.nodeId === candidate.nodeId && target.fieldName === candidate.fieldName)
  || isRunningHubAppCredentialField({ fieldName: candidate.fieldName, description: fieldLabel(candidate, reader) });

/** A missing original read is an actionable failure, never permission to infer another schema. */
export function requireRunningHubReader(value: unknown): RunningHubReaderResult {
  const reader = value as RunningHubReaderResult | undefined;
  if (!reader || !["runninghub-workflow", "runninghub-webapp"].includes(reader.environment)
    || reader.upstream?.revision !== "bdcf3bec054594fcab591952a8c5acef858d6de4"
    || !reader.workflow || !reader.analysis || !Array.isArray(reader.bindingCandidates)
    || !Array.isArray(reader.parameterBindings) || !Array.isArray(reader.parameterBindingDto?.bindings)
    || !reader.canvasBlueprint || typeof reader.canvasBlueprint !== "object" || Array.isArray(reader.canvasBlueprint)
    || !reader.nodeDefinitions || typeof reader.nodeDefinitions !== "object" || Array.isArray(reader.nodeDefinitions)
    || reader.environment === "runninghub-webapp" && !Array.isArray(reader.projection?.snapshot?.fields))
    throw new Error("请先使用完整的 AIFISHER 原版读取结果重新读取 RunningHub 工作流。");
  // Reuse only loader slots that the original group schema proves are already
  // connected. Expanding a group would require changing the remote template.
  if (reader.environment === "runninghub-workflow") assertAifisherVariableAssetsSupported(reader as unknown as AifisherWorkflowReadResult);
  const bindings = reader.parameterBindings!, published = reader.parameterBindingDto!.bindings;
  if (bindings.length !== published.length || new Set(bindings.map(binding => binding.key)).size !== bindings.length
    || new Set(published.map(binding => binding.id)).size !== published.length
    || bindings.some(binding => !published.some(item => item.id === binding.id && item.control.kind === binding.control.kind)
      || !reader.workflow![binding.target.nodeId] || !Object.hasOwn(reader.workflow![binding.target.nodeId].inputs, binding.target.fieldName)
        && !(reader.environment === "runninghub-workflow" && binding.control.kind === "asset" && binding.variableAssetGroup)))
    throw new Error("AIFISHER 原版参数绑定与控件配置不完整，请重新读取。");
  return reader;
}

export function analyzeRunningHubUpstream(reader: RunningHubReaderResult, declaredAppOutputKind?: MediaKind): ImportAnalysis {
  requireRunningHubReader(reader);
  const candidates: Candidate[] = reader.environment === "runninghub-workflow"
    ? aifisherCanvasBindingCandidates(reader as unknown as AifisherWorkflowReadResult) : reader.bindingCandidates;
  const fields = candidates.filter(candidate => scalar(candidate.value)).map(candidate => ({ nodeId: candidate.nodeId, field: candidate.fieldName, label: fieldLabel(candidate, reader), value: candidate.value as string | number | boolean }));
  const inputs = candidates.flatMap(candidate => {
    const media = kind(candidate.mediaKind);
    return media && aifisherExternalAssetCandidate(reader, candidate) && !secret(candidate, reader) ? [{ nodeId: candidate.nodeId, field: candidate.fieldName, label: fieldLabel(candidate, reader), kind: media, required: candidate.required === true }] : [];
  });
  // All RH environments use CanvasWorkflowGenerator's primaryTextParameter order.
  const text = reader.parameterBindings!.filter(binding => ["text", "textarea", "string", "prompt", "multiline"].includes(binding.control.kind)
      && !secret({ nodeId: binding.target.nodeId, fieldName: binding.target.fieldName, value: binding.control.defaultValue }, reader));
  const primary = text.find(binding => /^prompt$/i.test(binding.key))
      ?? text.find(binding => /提示词/.test(binding.label))
      ?? text.find(binding => /^(text|description)$/i.test(binding.key) || /描述/.test(binding.label))
      ?? text[0];
  const orderedText = primary ? [primary, ...text.filter(binding => binding !== primary)] : [];
  const prompts = orderedText.map(binding => ({ nodeId: binding.target.nodeId, field: binding.target.fieldName, label: binding.label,
      value: typeof binding.control.defaultValue === "string" ? binding.control.defaultValue : "" }));
  const outputs: ImportAnalysis["outputs"] = aifisherPublishedOutputCandidates(reader, reader.analysis.candidateOutputs ?? []).map(output => {
    const contract = reader.environment === "runninghub-webapp" && declaredAppOutputKind
      ? { kind: declaredAppOutputKind, field: declaredAppOutputKind === "text" ? "text" : "files" }
      : undefined;
    return { nodeId: output.nodeId, label: output.title || output.classType || output.nodeId,
      ...(contract ?? { kind: "file" as const, field: "*", needsBinding: true }) };
  });
  const warnings = (reader.analysis.warnings ?? []).map(warning => [warning.code, warning.nodeId, warning.fieldName].filter(Boolean).join(" · "));
  if (reader.environment === "runninghub-workflow") for (const binding of reader.parameterBindings ?? []) {
    if (binding.control.kind !== "asset" && binding.control.kind !== "seed" && !scalar(binding.control.defaultValue))
      warnings.push("结构化内部字段保持原图值：" + binding.target.nodeId + "." + binding.target.fieldName + "；未转换为普通文本控件。");
  }
  if (reader.environment === "runninghub-webapp" && !declaredAppOutputKind) warnings.push("平台分类和标签仅供参考；请确认输出类型，工作流按已确认的输出归类。");
  else if (outputs.some(output => output.kind === "file")) warnings.push("AIFISHER 未声明这些输出的文件类型，请确认输出类型；完整远程工作流保持不变。");
  return { fields, inputs, prompts, outputs, warnings, errors: [] };
}

export function buildRunningHubUpstream(reader: RunningHubReaderResult, options: {
  id: string; workflowId: string; baseUrl: string; name: string; promptKey?: string; mediaInputs?: ImportMediaBinding[]; outputs?: ImportOutputBinding[]; canvasParameterKeys?: string[]; declaredAppOutputKind?: MediaKind;
}): WorkflowDefinition {
  requireRunningHubReader(reader);
  if (!reader.workflow || !reader.parameterBindings || !reader.parameterBindingDto) throw new Error("AIFISHER 读取结果不完整。");
  const analysis = analyzeRunningHubUpstream(reader, options.declaredAppOutputKind), media = options.mediaInputs ?? analysis.inputs, outputs = options.outputs ?? analysis.outputs;
  if (!outputs.length) throw new Error("AIFISHER 未识别到输出，请确认平台工作流的输出节点。");
  const graph = structuredClone(reader.workflow), mapping: WorkflowDefinition["mapping"] = [], parameters: Parameter[] = [], slots: NonNullable<WorkflowDefinition["inputSlots"]> = [];
  if (outputs.some(output => !aifisherOutputBindingAllowed(reader, output.nodeId) || !["image", "video", "audio", "text", "file"].includes(output.kind) || !output.field.trim()))
    throw new Error("输出绑定必须指向原版读取图中的节点，并填写输出字段和类型：" + outputs.map(output => output.nodeId).join("、"));
  if (media.some(input => !analysis.inputs.some(candidate => candidate.nodeId === input.nodeId && candidate.field === input.field && candidate.kind === input.kind)))
    throw new Error("素材输入必须来自 AIFISHER 公开的外部素材输入合同。");
  const used = new Set<string>();
  const target = (nodeId: string, field: string) => JSON.stringify([nodeId, field]);
  const promptKey = options.promptKey ?? (analysis.prompts[0] ? analysis.prompts[0].nodeId + "." + analysis.prompts[0].field : "");
  if (promptKey && !analysis.prompts.some(prompt => prompt.nodeId + "." + prompt.field === promptKey))
    throw new Error("主提示词必须绑定 AIFISHER 公开的文本参数。");
  for (const candidate of reader.bindingCandidates) if (promptKey && candidate.nodeId + "." + candidate.fieldName === promptKey) {
    mapping.push({ semantic: "prompt", nodeId: candidate.nodeId, field: candidate.fieldName }); used.add(target(candidate.nodeId, candidate.fieldName));
  }
  media.forEach((input, index) => {
    if (used.has(target(input.nodeId, input.field))) throw new Error("主提示词与素材输入存在重复绑定。");
    const semantic = "slot:input" + (index + 1); used.add(target(input.nodeId, input.field));
    mapping.push({ semantic, nodeId: input.nodeId, field: input.field });
    slots.push({ semantic, label: input.label || input.field, kind: input.kind, required: input.required === true });
  });
  for (const binding of [...reader.parameterBindings].sort((a, b) => a.presentation.order - b.presentation.order)) {
    const { nodeId, fieldName, expectedValueType } = binding.target;
    if (used.has(target(nodeId, fieldName)) || binding.control.kind === "asset") continue;
    const published = reader.parameterBindingDto.bindings.find(item => item.id === binding.id);
    if (!published) throw new Error("AIFISHER 参数控件缺少显示配置：" + fieldName);
    const control = binding.control, key = binding.key;
    const candidate = reader.bindingCandidates.find(item => item.nodeId === nodeId && item.fieldName === fieldName);
    const isSecret = secret(candidate ?? { nodeId, fieldName, value: control.defaultValue }, reader);
    const defaultValue = control.kind === "seed" && control.defaultValue && typeof control.defaultValue === "object"
      ? (control.defaultValue as { value?: unknown }).value : control.defaultValue;
    if (!scalar(defaultValue) && !isSecret) {
      if (reader.environment === "runninghub-workflow") continue;
      throw new Error("AIFISHER 参数默认值不能映射为普通控件：" + binding.label);
    }
    const parameter: Parameter = { key, label: binding.label, description: binding.description,
      type: isSecret ? "text" : control.kind === "select" ? "select" : control.kind === "toggle" ? "boolean"
        : ["number", "slider", "seed"].includes(control.kind) ? "number" : "text",
      default: isSecret ? "" : defaultValue as string | number | boolean, required: control.required,
      group: binding.presentation.section, advanced: binding.presentation.advanced,
      sourceControl: { kind: control.kind, valueType: expectedValueType, order: binding.presentation.order } };
    if (isSecret) parameter.secret = true;
    if (!isSecret && control.kind === "select") {
      parameter.options = published.control.options.map(option => option.id);
      parameter.optionLabels = Object.fromEntries(published.control.options.map(option => [option.id, option.label]));
      parameter.optionValues = Object.fromEntries(published.control.options.map((option, index) => [option.id, control.options![index]]));
    }
    for (const [source, dest] of [["minimum", "min"], ["maximum", "max"], ["step", "step"]] as const)
      if (typeof control[source] === "number" && Number.isFinite(control[source])) parameter[dest] = control[source];
    if (control.kind === "textarea") parameter.multiline = true;
    if (candidate?.modelKind) parameter.model = true;
    parameters.push(parameter); mapping.push({ semantic: key, nodeId, field: fieldName });
  }
  const output = outputs[0], kinds = slots.map(slot => slot.kind);
  const mode: WorkflowDefinition["mode"] = output.kind === "file" ? "dataset" : output.kind === "text" ? "text-tool" : output.kind === "audio" ? "text-to-audio" : output.kind === "video" ? kinds.includes("image") ? "image-to-video" : "text-to-video" : kinds.includes("image") ? "image-to-image" : "text-to-image";
  const category = declaredWorkflowCategory({ output, additionalOutputs: outputs.slice(1) });
  return {
    id: options.id, name: options.name, family: category === "video" ? "视频工具" : category === "audio" ? "音频工具" : category === "image" ? "图像工具" : category === "text" ? "文本工具" : "待确认输出",
    importReader: { environment: reader.environment, repository: reader.upstream.repository, revision: reader.upstream.revision, format: reader.format, compileStatus: reader.analysis.compileStatus ?? "ready", ...(reader.category ? { category: reader.category } : {}) },
    description: "RunningHub · AIFISHER 读取", mode, promptRequired: mapping.some(item => item.semantic === "prompt"),
    requiredInputs: slots.filter(slot => slot.required).map(slot => slot.semantic), optionalInputs: slots.filter(slot => !slot.required).map(slot => slot.semantic), inputSlots: slots, mediaInputMode: "explicit",
    parameters, mapping, output: { nodeId: output.nodeId, field: output.field, kind: output.kind }, ...(outputs.length > 1 ? { additionalOutputs: outputs.slice(1) } : {}), template: graph,
    runninghub: { workflowId: options.workflowId, baseUrl: options.baseUrl, parameterSchemaVersion: 2,
      sourceBindings: structuredClone(reader.parameterBindings), sourceBindingDto: structuredClone(reader.parameterBindingDto),
      ...(reader.canvasBlueprint ? { sourceBlueprint: structuredClone(reader.canvasBlueprint) } : {}),
      ...(reader.environment === "runninghub-webapp" ? { kind: "app", sourceFormat: "app-inputs" } : { sourceFormat: "api-workflow" }), ...(options.canvasParameterKeys ? { canvasParameterKeys: options.canvasParameterKeys } : {}) },
  };
}
