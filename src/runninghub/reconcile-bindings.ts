import type { ComputeProvider, Generation, Project, WorkflowDefinition } from "../types";
import { runningHubSite, isRunningHubProvider } from "../compute/providers";
import { detectWorkflowCredentials } from "../workflow/credentials";
import { validateRunningHubParameterValue } from "./parameter-contract";

type Values = Generation["params"];

function sameDeployment(previous: WorkflowDefinition, next: WorkflowDefinition): boolean {
  const before = previous.runninghub, after = next.runninghub;
  if (!before || !after || after.bindingMode !== "selected" || previous.id !== next.id
    || before.workflowId !== after.workflowId || (before.kind ?? "workflow") !== (after.kind ?? "workflow")
    || (before.apiVersion ?? "v1") !== (after.apiVersion ?? "v1")) return false;
  try { return runningHubSite(before.baseUrl.trim()) === runningHubSite(after.baseUrl.trim()); }
  catch { return false; }
}

/** A control is the entire set of concrete writes, independent from its display/key order. */
function bindingIdentity(workflow: WorkflowDefinition, key: string): string | undefined {
  const mappings = workflow.mapping.filter(mapping => mapping.semantic === key);
  if (!mappings.length) return;
  const targets: string[] = [];
  for (const mapping of mappings) {
    const node = workflow.template?.[mapping.nodeId];
    if (!node || !Object.hasOwn(node.inputs, mapping.field)) return;
    // WebApp node classes are adapter implementation details; its public wire
    // identity is nodeId + field, with the new original control validating type.
    targets.push(JSON.stringify([mapping.nodeId, workflow.runninghub?.kind === "app" ? null : node.class_type, mapping.field,
      mapping.index ?? null, mapping.pathMode ?? null, mapping.serialization ?? null, mapping.maxItems ?? null]));
  }
  return JSON.stringify(targets.sort());
}

const secretKeys = (workflow: WorkflowDefinition) => new Set([
  ...workflow.parameters.filter(parameter => parameter.secret).map(parameter => parameter.key),
  ...detectWorkflowCredentials(workflow).flatMap(field => field.parameterKey ? [field.parameterKey] : []),
]);
const equalValues = (left: Values, right: Values) => Object.keys(left).length === Object.keys(right).length
  && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && Object.is(right[key], value));

/** Rebind current editable nodes only; accepted task snapshots keep their original values. */
export function reconcileRunningHubProjectBindings(
  project: Project,
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
  activeProvider: ComputeProvider,
): Project {
  if (!sameDeployment(previous, next)) return project;
  const oldSecrets = secretKeys(previous), newSecrets = secretKeys(next);
  const oldByTarget = new Map<string, string[]>();
  for (const parameter of previous.parameters) {
    if (oldSecrets.has(parameter.key)) continue;
    const identity = bindingIdentity(previous, parameter.key);
    if (identity) oldByTarget.set(identity, [...(oldByTarget.get(identity) ?? []), parameter.key]);
  }
  const bindings = next.parameters.filter(parameter => !newSecrets.has(parameter.key)).flatMap(parameter => {
    const identity = bindingIdentity(next, parameter.key);
    return identity ? [{ parameter, oldKeys: oldByTarget.get(identity) ?? [] }] : [];
  });
  const previousSchema = (previous.runninghub as { parameterSchemaVersion?: number } | undefined)?.parameterSchemaVersion;
  const nextSchema = (next.runninghub as { parameterSchemaVersion?: number } | undefined)?.parameterSchemaVersion;
  const upgradeSchema = previousSchema !== 2 && nextSchema === 2;
  const promptIdentity = upgradeSchema && !previous.mapping.some(mapping => mapping.semantic === "prompt")
    ? bindingIdentity(next, "prompt") : undefined;
  const oldPromptKeys = promptIdentity ? oldByTarget.get(promptIdentity) ?? [] : [];
  const oldPromptParameter = oldPromptKeys.length === 1 ? previous.parameters.find(parameter => parameter.key === oldPromptKeys[0]
    && parameter.type === "text" && !parameter.inputText) : undefined;
  const reconcile = (current: Values): Values => {
    const values: Values = Object.fromEntries(bindings.map(({ parameter, oldKeys }) => {
      // Ambiguous aliases cannot establish which prior control supplied a value.
      const oldKey = oldKeys.length === 1 ? oldKeys[0] : undefined;
      let value = oldKey && Object.hasOwn(current, oldKey) ? current[oldKey] : parameter.default;
      try { validateRunningHubParameterValue(parameter, value); }
      catch { value = parameter.default; }
      return [parameter.key, value];
    }));
    return equalValues(current, values) ? current : values;
  };
  let projectChanged = false;
  const canvases = project.canvases.map(canvas => {
    let canvasChanged = false;
    const nodes = canvas.nodes.map(node => {
      const generation = node.data.generation;
      if (!generation) return node;
      const active = isRunningHubProvider(generation.computeProvider ?? activeProvider) && generation.workflowId === next.id;
      const params = active ? reconcile(generation.params) : generation.params;
      let providerSelections = generation.providerSelections;
      for (const provider of ["runninghub", "runninghub-workflow"] as const) {
        const remembered = generation.providerSelections?.[provider];
        const savedParams = remembered?.workflowId === next.id ? reconcile(remembered.params) : remembered?.params;
        if (remembered && savedParams !== remembered.params)
          providerSelections = { ...providerSelections, [provider]: { ...remembered, params: savedParams! } };
      }
      const oldPromptValue = active && oldPromptParameter && Object.hasOwn(generation.params, oldPromptParameter.key)
        ? generation.params[oldPromptParameter.key] : undefined;
      const prompt = active && !generation.prompt.trim() && typeof oldPromptValue === "string" && oldPromptValue.trim()
        && !Object.is(oldPromptValue, oldPromptParameter?.default) ? oldPromptValue : generation.prompt;
      if (params === generation.params && providerSelections === generation.providerSelections && prompt === generation.prompt) return node;
      canvasChanged = projectChanged = true;
      return { ...node, data: { ...node.data, generation: { ...generation, params, prompt,
        ...(providerSelections !== generation.providerSelections ? { providerSelections } : {}),
      } } };
    });
    return canvasChanged ? { ...canvas, nodes } : canvas;
  });
  return projectChanged ? { ...project, canvases } : project;
}
