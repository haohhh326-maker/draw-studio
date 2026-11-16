import type { ApiWorkflow, WorkflowDefinition } from "../types";
import type { ImportAnalysis, ImportMediaBinding, ImportOutputBinding } from "../workflow/import-analyzer";
import { savedOutputContracts } from "../workflow/output-contracts";

const targetKey = (nodeId: string, field: string) => JSON.stringify([nodeId, field]);
const finalMediaContract = (classType: string) => {
  const contract = savedOutputContracts[classType];
  return classType !== "PreviewImage" && contract?.kind !== "text" ? contract : undefined;
};

/** Legacy definitions have no output-selection flag. Only a complete, ordinary
 * set of previous saved-media ports proves that no branch was excluded. */
function keepsEveryPreviousPublisher(saved: WorkflowDefinition, outputs: ImportOutputBinding[]) {
  const publishers = Object.entries(saved.template ?? {}).flatMap(([nodeId, node]) => {
    const contract = finalMediaContract(node.class_type);
    return contract ? [{ nodeId, ...contract }] : [];
  });
  return publishers.length > 0 && publishers.length === outputs.length && publishers.every(publisher => outputs.some(output =>
    output.nodeId === publisher.nodeId && (output.field === "*" || output.field === publisher.field)
    && (output.kind === "file" || output.kind === publisher.kind)));
}
type PreviousMedia = { kind?: ImportMediaBinding["kind"]; required?: boolean };
function previousMediaInputs(saved: WorkflowDefinition, app: boolean) {
  const inputs = new Map<string, PreviousMedia>(), publicMedia = new Set<string>();
  // The saved public schema also records media that the user intentionally did
  // not expose on the canvas. Such fields must not be mistaken for new inputs.
  for (const field of app ? saved.runninghub?.executionContract?.publicSchema?.fields ?? [] : []) {
    const type = field.type.toLowerCase(), kind = type === "mask" ? "image" : type;
    if (!field.secret && ["image", "video", "audio"].includes(kind)) {
      const key = targetKey(field.nodeId, field.fieldName);
      inputs.set(key, { kind: kind as ImportMediaBinding["kind"], required: field.required });
      publicMedia.add(key);
    }
  }
  for (const field of saved.runninghub?.mediaInputs ?? []) {
    const key = targetKey(field.nodeId, field.field);
    inputs.set(key, { ...inputs.get(key), required: field.required });
  }
  for (const slot of saved.inputSlots ?? []) {
    const target = saved.mapping.find(mapping => mapping.semantic === slot.semantic);
    if (!target) continue;
    const key = targetKey(target.nodeId, target.field), previous = inputs.get(key);
    inputs.set(key, { kind: slot.kind, required: slot.required, ...previous });
  }
  return { inputs, publicMedia };
}

/** Reusing a binding requires the same target, not merely a matching node ID. */
export function reviewRunningHubImportBindings(graph: ApiWorkflow, analysis: ImportAnalysis, saved?: WorkflowDefinition) {
  const warnings: string[] = [];
  const defaults = {
    promptKey: analysis.prompts[0] ? analysis.prompts[0].nodeId + "." + analysis.prompts[0].field : "",
    media: analysis.inputs.map(input => ({ ...input })) as ImportMediaBinding[],
    outputs: analysis.outputs.map(({ nodeId, field, kind }) => ({ nodeId, field, kind })) as ImportOutputBinding[],
  };
  if (!saved) return { ...defaults, changed: false, warnings };
  const app = saved.runninghub?.kind === "app";
  const sameNode = (nodeId: string) => !!graph[nodeId] && (!saved.template?.[nodeId] || app || saved.template[nodeId].class_type === graph[nodeId].class_type);
  const validInput = (nodeId: string, field: string) => sameNode(nodeId) && Object.hasOwn(graph[nodeId].inputs, field)
    && (typeof graph[nodeId].inputs[field] === "string" || graph[nodeId].inputs[field] === null);
  const prompt = saved.mapping.find(mapping => mapping.semantic === "prompt");
  const previousSchemaVersion = (saved.runninghub as { parameterSchemaVersion?: number } | undefined)?.parameterSchemaVersion;
  const upgradeSchema = previousSchemaVersion !== 2;
  const mainPrompt = analysis.prompts[0];
  const upgradedPrompt = !prompt && upgradeSchema && mainPrompt && validInput(mainPrompt.nodeId, mainPrompt.field)
    && typeof graph[mainPrompt.nodeId].inputs[mainPrompt.field] === "string" ? mainPrompt : undefined;
  const promptKey = prompt && validInput(prompt.nodeId, prompt.field) && analysis.prompts.some(field => field.nodeId === prompt.nodeId && field.field === prompt.field)
    && typeof graph[prompt.nodeId].inputs[prompt.field] === "string"
    ? prompt.nodeId + "." + prompt.field : upgradedPrompt ? upgradedPrompt.nodeId + "." + upgradedPrompt.field : "";
  if (prompt && !promptKey) warnings.push("原主提示词的节点类型或字段已变化，请重新选择主提示词。");
  if (upgradedPrompt) warnings.push("已按新应用输入声明选中主提示词，请确认更新后的提示词绑定。");
  const media: ImportMediaBinding[] = [];
  const previous = previousMediaInputs(saved, app), invalidTargets = new Set<string>();
  const freshInputs = new Map(analysis.inputs.map(input => [targetKey(input.nodeId, input.field), input]));
  let mediaChanged = false;
  for (const slot of saved.inputSlots ?? []) {
    const target = saved.mapping.find(mapping => mapping.semantic === slot.semantic);
    const key = target && targetKey(target.nodeId, target.field), declared = key ? freshInputs.get(key) : undefined;
    if (!target || !validInput(target.nodeId, target.field) || declared && declared.kind !== slot.kind ||
      app && key && previous.publicMedia.has(key) && !declared) {
      mediaChanged = true;
      if (key) invalidTargets.add(key);
      continue;
    }
    const declaredRequired = typeof declared?.required === "boolean" ? declared.required : undefined;
    const previousRequired = key ? previous.inputs.get(key)?.required : undefined;
    const requiredChanged = declaredRequired !== undefined && (declaredRequired !== slot.required
      || typeof previousRequired === "boolean" && previousRequired !== declaredRequired);
    if (requiredChanged) mediaChanged = true;
    media.push({ nodeId: target.nodeId, field: target.field, kind: slot.kind, label: slot.label,
      required: declaredRequired !== undefined ? declaredRequired : slot.required });
  }
  for (const input of analysis.inputs) {
    const key = targetKey(input.nodeId, input.field), before = previous.inputs.get(key);
    if (media.some(binding => targetKey(binding.nodeId, binding.field) === key)) continue;
    if (!before || before.kind && before.kind !== input.kind || invalidTargets.has(key) ||
      app && before.required === false && input.required === true) {
      media.push({ ...input });
      mediaChanged = true;
    }
  }
  if (mediaChanged) warnings.push("素材输入已新增，或原绑定的节点、字段、媒体类型及必填要求已变化，请确认更新后的素材绑定。");
  const oldOutputs = [saved.output, ...(saved.additionalOutputs ?? [])];
  // Replacing an app adapter's virtual result node does not revoke the user's
  // confirmed output type. The upstream ANY port does not declare a new type.
  const virtualAppMigration = app && oldOutputs.length === 1 && defaults.outputs.length === 1
    && defaults.outputs[0].nodeId === "fisherai_webapp_output" && defaults.outputs[0].kind === "file" && defaults.outputs[0].field === "*";
  const reviewedOutputs = virtualAppMigration ? [{ ...oldOutputs[0], nodeId: defaults.outputs[0].nodeId }] : oldOutputs;
  const outputChanged = !virtualAppMigration && oldOutputs.some(output => !graph[output.nodeId] || saved.template?.[output.nodeId] &&
    saved.template[output.nodeId].class_type !== graph[output.nodeId].class_type);
  if (outputChanged) warnings.push("原输出的节点类型或输出契约已变化，请确认重新识别的输出绑定。");
  let outputs = outputChanged ? defaults.outputs : reviewedOutputs.map(({ nodeId, field, kind }) => ({ nodeId, field, kind }));
  if (!app && !outputChanged && keepsEveryPreviousPublisher(saved, oldOutputs)) {
    const added = defaults.outputs.filter(output => !saved.template?.[output.nodeId]
      && !!finalMediaContract(graph[output.nodeId]?.class_type)
      && !outputs.some(previous => previous.nodeId === output.nodeId));
    if (added.length) {
      outputs = [...outputs, ...added];
      warnings.push("已读取新增的保存输出，请确认更新后的输出绑定。");
    }
  }
  const changed = warnings.length > 0;
  return { promptKey, media, outputs, changed, warnings };
}
