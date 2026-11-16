import type { Generation, WorkflowDefinition } from "../types";
import { cleanWorkflowCredentials } from "../workflow/credentials";
import { attachRunningHubExecutionContract, validateRunningHubExecutionGraph } from "./execution-contract";
import { selectedRunningHubParameterValues, selectRunningHubBindings } from "./selected-bindings";
import type { AifisherRawParameterBinding } from "../workflow/aifisher-reader-client";
import { runningHubRemoteCanvasParameterKeys } from "../generation/parameter-actions";

const revision = "bdcf3bec054594fcab591952a8c5acef858d6de4";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Group controls refer to the original connected loaders, never to a scalar
 * group field. The read adapter has checked the full node-definition schema;
 * verify that every retained slot still addresses that same frozen graph. */
function originalAssetGroupTargets(definition: WorkflowDefinition, binding: AifisherRawParameterBinding): boolean {
  const group = binding.variableAssetGroup, target = definition.template?.[binding.target.nodeId];
  if (binding.control.kind !== "asset" || !record(group) || group.schemaVersion !== 1 || group.strategy !== "optional-autogrow-direct-loaders"
    || !target || target.class_type !== group.targetClassType || group.targetNodeId !== binding.target.nodeId
    || group.groupName !== binding.target.fieldName || !Array.isArray(group.branches)
    || !Number.isInteger(group.capacity) || group.capacity !== group.branches.length) return false;
  if (!group.branches.length) {
    const template = group.syntheticTemplate;
    return group.minimumItems === 0 && record(template) && Array.isArray(template.connections) && template.connections.length > 0
      && template.connections.every(connection => record(connection) && typeof connection.groupName === "string" && typeof connection.prefix === "string"
        && !Object.keys(target.inputs).some(field => field.startsWith(connection.groupName + "." + connection.prefix)));
  }
  return group.branches.every(branch => {
    if (!record(branch) || typeof branch.sourceNodeId !== "string" || typeof branch.assetFieldName !== "string"
      || !Array.isArray(branch.connections) || !branch.connections.length) return false;
    const loader = definition.template?.[branch.sourceNodeId];
    return !!loader && loader.class_type === branch.sourceClassType && typeof loader.inputs[branch.assetFieldName] === "string"
      && definition.mapping.some(mapping => mapping.nodeId === branch.sourceNodeId && mapping.field === branch.assetFieldName
        && definition.inputSlots?.some(slot => slot.semantic === mapping.semantic))
      && branch.connections.every(connection => {
        if (!record(connection) || typeof connection.targetFieldName !== "string") return false;
        const link = target.inputs[connection.targetFieldName];
        return Array.isArray(link) && link.length === 2 && link[0] === branch.sourceNodeId && link[1] === connection.outputIndex;
      });
  });
}
function requireOriginalSource(definition: WorkflowDefinition) {
  const source = definition.runninghub;
  const bindings = source?.sourceBindings, dto = source?.sourceBindingDto;
  const fail = () => { throw Object.assign(new Error("此 RunningHub 工作流缺少完整的 AIFISHER 原版读取合同，请重新读取后再运行。"), { code: "RUNNINGHUB_READ_REQUIRED" }); };
  if (!source || source.parameterSchemaVersion !== 2 || source.bindingMode !== "selected"
    || definition.importReader?.revision !== revision || !definition.importReader.environment.startsWith("runninghub-")
    || !Array.isArray(bindings) || !Array.isArray(dto?.bindings) || !record(source.sourceBlueprint)
    || bindings.length !== dto.bindings.length || new Set(bindings.map(binding => binding.key)).size !== bindings.length
    || new Set(dto.bindings.map(binding => binding.id)).size !== dto.bindings.length) fail();
  for (const binding of bindings!) {
    const target = definition.template?.[binding.target.nodeId];
    if (!target || !Object.hasOwn(target.inputs, binding.target.fieldName) && !originalAssetGroupTargets(definition, binding)
      || !dto!.bindings.some(published => published.id === binding.id && published.control.kind === binding.control.kind)) fail();
  }
  for (const parameter of definition.parameters) {
    const binding = bindings!.find(binding => binding.key === parameter.key);
    const control = parameter.sourceControl;
    if (!binding || !control || control.kind !== binding.control.kind || control.valueType !== binding.target.expectedValueType
      || control.order !== binding.presentation.order
      || !definition.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === binding.target.nodeId && mapping.field === binding.target.fieldName)) fail();
  }
}

/** Prepare a new run only from a complete original read. Accepted-task recovery does not call this. */
export async function prepareRunningHubRun(definition: WorkflowDefinition, params: Generation["params"]) {
  requireOriginalSource(definition);
  await validateRunningHubExecutionGraph(definition);
  let workflow = cleanWorkflowCredentials(definition);
  if (workflow.runninghub?.billingMode === "consumer" && workflow.runninghub.kind !== "app") {
    // Validate the saved graph and old contract before narrowing this run.
    // Stale node values must not turn removed internal controls into overrides.
    workflow = await attachRunningHubExecutionContract(selectRunningHubBindings(workflow, runningHubRemoteCanvasParameterKeys(workflow)));
  }
  return { workflow, params: selectedRunningHubParameterValues(workflow, params) };
}
