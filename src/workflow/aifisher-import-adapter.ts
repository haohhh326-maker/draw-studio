import type { ApiWorkflow, WorkflowDefinition } from "../types";
import type { AifisherBindingCandidate, AifisherWorkflowReadResult } from "./aifisher-reader-client";
import type { ImportAnalysis, ImportOutputBinding } from "./import-analyzer";
import { isWorkflowCredentialFieldName } from "./credentials";
import { aifisherCanvasBindingCandidates, assertAifisherVariableAssetsSupported } from "./aifisher-variable-assets";
import { automaticPromptCandidate } from "./automatic-prompt-binding";
import { isSampleMediaValueDiagnostic } from "./sample-media-diagnostics";
import { aifisherOutputPresentation } from "./aifisher-output-presentation";
import { aifisherExternalAssetCandidate } from "./aifisher-io-contracts";

type Data = Record<string, unknown>;
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const target = (candidate: AifisherBindingCandidate) => ({ target: "comfyui", nodeId: candidate.nodeId, path: "inputs." + candidate.fieldName });

export function aifisherReaderProvenance(read: AifisherWorkflowReadResult): NonNullable<WorkflowDefinition["importReader"]> {
  return { environment: read.environment, repository: read.upstream.repository, revision: read.upstream.revision,
    format: read.format, compileStatus: read.analysis.compileStatus, ...(read.category ? { category: read.category } : {}) };
}

/** Adapt upstream DTO names to our controls; do not analyze or rewrite its graph. */
export function aifisherImportAnalysis(read: AifisherWorkflowReadResult): ImportAnalysis {
  const candidates = aifisherCanvasBindingCandidates(read);
  const fields = candidates.filter(candidate => scalar(candidate.value)).map(candidate => ({
    nodeId: candidate.nodeId, field: candidate.fieldName,
    label: candidate.nodeTitle + " · " + candidate.fieldName, value: candidate.value as string | number | boolean,
  }));
  const inputs: ImportAnalysis["inputs"] = candidates.filter(candidate => aifisherExternalAssetCandidate(read, candidate))
    .map(candidate => ({ nodeId: candidate.nodeId, field: candidate.fieldName, label: candidate.nodeTitle + " · " + candidate.fieldName,
      kind: (candidate.mediaKind === "mask" ? "image" : candidate.mediaKind) as "image" | "video" | "audio", required: candidate.required }));
  const media = new Set(inputs.map(input => input.nodeId + "\0" + input.field));
  const prompts = fields.filter(field => typeof field.value === "string" && !isWorkflowCredentialFieldName(field.field)
    && !media.has(field.nodeId + "\0" + field.field) && /^(?:prompt|positive_prompt|positive_text|text|text_g|instruction|user_prompt)$/i.test(field.field))
    .map(field => ({ ...field, value: String(field.value) }));
  const { outputs } = aifisherOutputPresentation(read);
  const warnings = read.analysis.warnings.filter(warning => !isSampleMediaValueDiagnostic(read, warning)).map(warning => warning.code + (warning.nodeId ? " · " + warning.nodeId : "")
    + (warning.classType ? " · " + warning.classType : "") + (warning.fieldName ? " · " + warning.fieldName : ""));
  if (outputs.length) warnings.push("AIFISHER 已读取输出候选；媒体类型与结果字段以实际执行结果为准。");
  return { fields, inputs, prompts, outputs, warnings, errors: [] };
}

export function buildAifisherImportPackage(read: AifisherWorkflowReadResult, id: string, name: string) {
  if (!read.workflow || read.analysis.compileStatus !== "ready")
    throw new Error("AIFISHER 未完成工作流转换（" + read.analysis.compileStatus + "）；需要对应 ComfyUI 节点定义或 API Format。");
  assertAifisherVariableAssetsSupported(read);
  const graph: ApiWorkflow = structuredClone(read.workflow);
  const analysis = aifisherImportAnalysis(read);
  if (!analysis.outputs.length) throw new Error("AIFISHER 未识别到输出候选，请检查工作流保存节点。");
  const chosenPrompt = automaticPromptCandidate(read);
  const mainPrompt = chosenPrompt ? { nodeId: chosenPrompt.nodeId, field: chosenPrompt.fieldName } : undefined;
  const mediaKeys = new Set(analysis.inputs.map(input => input.nodeId + "\0" + input.field));
  const used = new Set<string>();
  const parameters: Data[] = [];
  for (const candidate of read.bindingCandidates) {
    if (!scalar(candidate.value) || candidate.control === "asset" || mediaKeys.has(candidate.nodeId + "\0" + candidate.fieldName)
      || mainPrompt?.nodeId === candidate.nodeId && mainPrompt.field === candidate.fieldName) continue;
    let key = candidate.fieldName;
    if (used.has(key) || ["prompt", "negativePrompt"].includes(key)) key = "input:" + candidate.nodeId + ":" + candidate.fieldName;
    const base = key;
    for (let index = 2; used.has(key); index++) key = base + ":" + index;
    used.add(key);
    const options = Array.isArray(candidate.options) ? candidate.options.filter(scalar) : undefined;
    // An unavailable model remains the authored selection, never a replacement.
    // This is a display option; the upstream warning and graph stay unchanged.
    if (options?.length && !options.some(value => Object.is(value, candidate.value))) options.push(candidate.value);
    const seed = candidate.control === "seed" && typeof candidate.value === "number";
    const type = options?.length ? "enum" : seed ? "seed" : typeof candidate.value === "boolean" ? "boolean"
      : typeof candidate.value === "number" ? candidate.valueType === "INT" ? "integer"
        : /^(FLOAT|DOUBLE|NUMBER)$/.test(candidate.valueType) ? "float" : Number.isInteger(candidate.value) ? "integer" : "float" : "string";
    const parameter: Data = { id: key, type, label: candidate.nodeTitle + " · " + candidate.fieldName,
      defaultValue: candidate.value, binding: target(candidate), ui: { placement: seed || /^(width|height|aspect_ratio|megapixels|duration)$/.test(candidate.fieldName) ? "primary" : "advanced",
        ...(candidate.control === "textarea" ? { multiline: true } : {}) } };
    if (options?.length) parameter.options = options.map(value => ({ value, label: String(value) }));
    for (const [source, destination] of [["minimum", "min"], ["maximum", "max"], ["step", "step"]] as const)
      if (typeof candidate[source] === "number" && Number.isFinite(candidate[source])) parameter[destination] = candidate[source];
    if (candidate.modelKind) parameter.model = true;
    if (isWorkflowCredentialFieldName(candidate.fieldName)) { parameter.secret = true; parameter.required = candidate.required; }
    parameters.push(parameter);
  }
  const presentation = aifisherOutputPresentation(read);
  const primary = presentation.primary ?? analysis.outputs[0];
  // The package contract requires its first binding to match nodeKind. For a
  // genuinely mixed workflow this remains a generic wildcard; no route is lost.
  const primaryOutput: ImportOutputBinding = { nodeId: primary.nodeId, field: primary.field, kind: presentation.kind };
  const outputs: ImportOutputBinding[] = [primaryOutput, ...analysis.outputs.filter(output => output.nodeId !== primary.nodeId)
    .map(({ nodeId, kind, field }) => ({ nodeId, kind, field }))];
  const inputs = analysis.inputs.map((input, index) => ({ id: "input" + (index + 1), name: input.label, dataType: input.kind,
    required: input.required, binding: { target: "comfyui", nodeId: input.nodeId, path: "inputs." + input.field } }));
  const config: Data = { schemaVersion: 1, id, version: "1.0.0", nameLabel: name, primaryCategoryLabel: presentation.categoryLabel,
    nodeKind: presentation.kind, runnerType: "comfyui", mediaInputMode: "explicit", inputs, parameters,
    importReader: aifisherReaderProvenance(read),
    ...(mainPrompt ? { prompt: { required: false, binding: { target: "comfyui", nodeId: mainPrompt.nodeId, path: "inputs." + mainPrompt.field } } } : {}),
    execution: { file: "execution.api.json", modelRequirementsFile: "model.requirements.json", output: primaryOutput, ...(outputs.length > 1 ? { outputs } : {}) } };
  const requirements = { schemaVersion: 1, items: read.analysis.requirements.models.map(model => ({ name: model.name, required: true })) };
  return { graph, config, requirements, analysis, warnings: analysis.warnings };
}
