type Data = Record<string, any>;
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const MATCH = "COMFY_MATCHTYPE_V3";
const wire = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2
  && typeof value[0] === "string" && Number.isInteger(value[1]) && value[1] >= 0;
const sections = (definition: Data | undefined): Data => ({
  ...(record(definition?.input?.required) ? definition.input.required : {}),
  ...(record(definition?.input?.optional) ? definition.input.optional : {}),
});
const concrete = (type: unknown): type is string => typeof type === "string" && !!type.trim()
  && !type.split(",").some(value => value.trim() === "*" || value.trim().startsWith("COMFY_"));
const parts = (type: string) => type.split(",").map(value => value.trim()).filter(Boolean);
const accepts = (wanted: string, actual: string): boolean => parts(wanted).includes("*")
  || parts(actual).every(type => parts(wanted).includes(type));
const templateOf = (spec: unknown): Data | undefined => Array.isArray(spec) && spec[0] === MATCH
  && record(spec[1]?.template) && typeof spec[1].template.template_id === "string" ? spec[1].template : undefined;

/** Older platform snapshots omit output_matchtypes for these core switch nodes.
 * Their official execute contract returns one of on_true/on_false unchanged.
 * Do not infer a missing output template for arbitrary custom MatchType nodes.
 */
function coreSwitchOutputTemplate(node: Data, definition: Data, slot: number): string | undefined {
  if (!["ComfySwitchNode", "ComfySoftSwitchNode"].includes(node.class_type) || slot !== 0
    || !Array.isArray(definition.output) || definition.output.length !== 1 || definition.output[0] !== MATCH) return;
  const fields = sections(definition), yes = templateOf(fields.on_true), no = templateOf(fields.on_false);
  if (Array.isArray(fields.switch) && fields.switch[0] === "BOOLEAN" && yes && no
    && yes.template_id === no.template_id && typeof yes.allowed_types === "string" && yes.allowed_types === no.allowed_types)
    return yes.template_id;
}

/** This is a serialized display widget, not a ComfyUI backend input. Never load its URLs.
 * rgthree-comfy/web/comfyui/image_comparer.js onSerialize and RgthreeImageComparerWidget.value.
 */
export function isWorkflowPresentationInput(node: unknown, field: string, definition: unknown): boolean {
  if (!record(node) || node.class_type !== "Image Comparer (rgthree)" || field !== "rgthree_comparer"
    || !record(node.inputs) || !record(definition) || definition.output_node !== true) return false;
  const fields = sections(definition);
  if (Object.hasOwn(fields, field) || !["image_a", "image_b"].every(name => Array.isArray(fields[name]) && fields[name][0] === "IMAGE")) return false;
  const value = node.inputs[field];
  const images = Array.isArray(value) ? value : record(value) && Object.keys(value).length === 1 ? value.images : undefined;
  return Array.isArray(images) && images.every(image => typeof image === "string" || image === null
    || record(image) && typeof image.name === "string" && typeof image.selected === "boolean" && typeof image.url === "string"
      && Object.keys(image).every(key => ["name", "selected", "url"].includes(key)));
}

/** Recheck only contracts the pinned reader cannot interpret. Source and vendor stay untouched.
 * MatchType templates are defined by ComfyUI comfy_api/latest/_io.py, including allowed_types
 * and output_matchtypes. Missing definitions, conflicting branches and cycles remain unresolved.
 */
export function revalidateWorkflowContracts<T extends Data>(workflow: Data, objectInfo: Data | undefined, warnings: T[]): T[] {
  if (!objectInfo) return warnings;
  const outputCache = new Map<string, string | undefined>();
  const definitionFor = (nodeId: string): Data | undefined => {
    const node = workflow[nodeId];
    return record(node) && typeof node.class_type === "string" && record(objectInfo[node.class_type]) ? objectInfo[node.class_type] : undefined;
  };
  function inputType(nodeId: string, field: string, stack: Set<string>): string | undefined {
    const node = workflow[nodeId];
    if (!record(node?.inputs)) return;
    const value = node.inputs[field];
    if (wire(value)) return outputType(value[0], value[1], stack);
    if (typeof value === "string") return "STRING";
    if (typeof value === "boolean") return "BOOLEAN";
    if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? "INT" : "FLOAT";
  }
  function matchType(nodeId: string, group: string, stack: Set<string>): string | undefined {
    const node = workflow[nodeId], fields = sections(definitionFor(nodeId));
    if (!record(node?.inputs)) return;
    const matches = Object.entries(fields).filter(([, spec]) => templateOf(spec)?.template_id === group);
    if (!matches.length) return;
    let resolved: string | undefined;
    for (const [field, spec] of matches) {
      if (!Object.hasOwn(node.inputs, field)) continue;
      const template = templateOf(spec)!;
      const type = inputType(nodeId, field, stack);
      if (!concrete(type) || typeof template.allowed_types !== "string" || !accepts(template.allowed_types, type)) return;
      // Matching ports share one concrete type, not an arbitrary union of conflicting inputs.
      if (resolved !== undefined && (parts(resolved).length !== parts(type).length || !accepts(resolved, type))) return;
      resolved = type;
    }
    return resolved;
  }
  function outputType(nodeId: string, slot: number, stack: Set<string>): string | undefined {
    const key = nodeId + "\0" + slot;
    if (stack.has(key)) return;
    if (outputCache.has(key)) return outputCache.get(key);
    const definition = definitionFor(nodeId);
    if (!definition || !Array.isArray(definition.output) || slot >= definition.output.length) return;
    const type = definition.output[slot];
    if (type !== MATCH) return concrete(type) ? type : undefined;
    const declaredGroup = Array.isArray(definition.output_matchtypes) ? definition.output_matchtypes[slot] : undefined;
    const group = typeof declaredGroup === "string" ? declaredGroup
      : definition.output_matchtypes == null ? coreSwitchOutputTemplate(workflow[nodeId], definition, slot) : undefined;
    if (typeof group !== "string") return;
    const result = matchType(nodeId, group, new Set(stack).add(key));
    outputCache.set(key, result);
    return result;
  }
  return warnings.map(warning => {
    if (warning.code !== "RUNTIME_SLOT_MISMATCH") return warning;
    const node = workflow[warning.nodeId], value = node?.inputs?.[warning.fieldName];
    // A missing definition cannot prove a type mismatch. Keep dangling/malformed
    // links and known out-of-range slots as errors; only incomplete evidence changes category.
    if (!wire(value) || !record(workflow[value[0]])) return warning;
    const source = definitionFor(value[0]), target = definitionFor(warning.nodeId);
    if (source && Array.isArray(source.output) && value[1] >= source.output.length) return warning;
    if (!source || !target || !Array.isArray(source.output))
      return { ...warning, code: "RUNTIME_SLOT_UNVERIFIED" };
    return warning;
  }).filter(warning => {
    const id = typeof warning.nodeId === "string" ? warning.nodeId : undefined;
    const field = typeof warning.fieldName === "string" ? warning.fieldName : undefined;
    if (!id || !field) return true;
    const node = workflow[id], definition = definitionFor(id);
    if (warning.code === "UNKNOWN_NODE_INPUT" && isWorkflowPresentationInput(node, field, definition)) return false;
    if (warning.code !== "RUNTIME_SLOT_MISMATCH" || !record(node?.inputs) || !definition) return true;
    const value = node.inputs[field], spec = sections(definition)[field];
    if (!wire(value) || !Array.isArray(spec) || typeof spec[0] !== "string") return true;
    const sourceDefinition = definitionFor(value[0]);
    const sourceType = Array.isArray(sourceDefinition?.output) ? sourceDefinition.output[value[1]] : undefined;
    // Ordinary contracts remain the upstream reader's responsibility.
    if (spec[0] !== MATCH && sourceType !== MATCH) return true;
    const actual = outputType(value[0], value[1], new Set());
    if (!concrete(actual)) return true;
    const template = templateOf(spec);
    const expected = spec[0] === MATCH && template
      ? matchType(id, template.template_id, new Set()) : spec[0];
    return typeof expected !== "string" || !accepts(expected, actual);
  });
}
