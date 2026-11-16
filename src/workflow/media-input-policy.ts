import type { ApiWorkflow, MediaInputPolicy } from "../types";
export type { MediaInputPolicy } from "../types";
type Data = Record<string, unknown>;
type Binding = { semantic: string; nodeId: string; field: string };
type Group = MediaInputPolicy["groups"][number];
type Port = { optional: boolean; group?: Group };
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const data = (value: unknown): Data => object(value) ? value : {};
const link = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);

function ancestors(graph: ApiWorkflow, outputs: string[]): Set<string> {
  const keep = new Set<string>();
  const pending = [...outputs];
  while (pending.length) {
    const id = pending.pop()!;
    if (keep.has(id) || !Object.hasOwn(graph, id)) continue;
    keep.add(id);
    for (const value of Object.values(graph[id].inputs)) if (link(value)) pending.push(value[0]);
  }
  return keep;
}

/** Read only the selected, schema-declared ports. Unsupported contracts remain mandatory. */
function nodePorts(nodeId: string, node: ApiWorkflow[string], schema: unknown): Map<string, Port> {
  const ports = new Map<string, Port>();
  if (!object(schema) || !object(schema.input)) return ports;
  const label = typeof schema.display_name === "string" ? schema.display_name : node._meta?.title ?? node.class_type;
  function visit(rawInput: unknown, prefix = "", depth = 0) {
    if (!object(rawInput) || depth > 20) throw new Error("Unsupported input contract");
    for (const section of ["required", "optional"] as const) {
      const fields = rawInput[section] ?? {};
      if (!object(fields)) throw new Error("Unsupported input section");
      for (const [name, raw] of Object.entries(fields)) {
        if (!Array.isArray(raw) || !raw.length) throw new Error("Unsupported input specification");
        const field = prefix + name, options = data(raw[1]);
        if (ports.has(field)) throw new Error("Duplicate input contract");
        if (raw[0] === "COMFY_AUTOGROW_V3") {
          const template = data(options.template), input = data(template.input);
          const required = data(input.required), optional = data(input.optional);
          const atoms = Object.entries({ ...required, ...optional });
          if (atoms.length !== 1 || !Array.isArray(atoms[0][1])) throw new Error("Unsupported expansion template");
          const minimum = template.min ?? 0;
          if (!Number.isSafeInteger(minimum) || Number(minimum) < 0) throw new Error("Invalid expansion minimum");
          const maximum = template.max;
          if (maximum !== undefined && (!Number.isSafeInteger(maximum) || Number(maximum) < Number(minimum))) throw new Error("Invalid expansion maximum");
          const names = template.names;
          const suffixPrefix = template.prefix;
          if (names !== undefined && (!Array.isArray(names) || !names.length || names.some(value => typeof value !== "string" || !value) || new Set(names).size !== names.length)) throw new Error("Invalid expansion names");
          if (!Array.isArray(names) && (typeof suffixPrefix !== "string" || !suffixPrefix)) throw new Error("Missing expansion naming rule");
          const indexOf = (key: string): number => {
            const suffix = key.slice(field.length + 1);
            if (Array.isArray(names)) return names.indexOf(suffix);
            if (!suffix.startsWith(suffixPrefix as string)) return -1;
            const digits = suffix.slice((suffixPrefix as string).length);
            return /^\d+$/.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : -1;
          };
          const expanded = Object.keys(node.inputs).filter(key => key.startsWith(field + "."));
          if (expanded.some(key => indexOf(key) < 0 || (maximum !== undefined && indexOf(key) >= Number(maximum)))) throw new Error("Invalid expanded input");
          expanded.sort((a, b) => indexOf(a) - indexOf(b));
          const targets = expanded.map((_, index) => field + "." + (Array.isArray(names) ? names[index] : String(suffixPrefix) + index));
          const group: Group = { nodeId, label: label + " · " + nodeId + "." + field, minimum: Number(minimum), fields: expanded, targets };
          for (const key of expanded) ports.set(key, { optional: true, group });
          continue;
        }
        ports.set(field, { optional: section === "optional" });
        if (raw[0] === "COMFY_DYNAMICCOMBO_V3") {
          if (!Array.isArray(options.options)) throw new Error("Unsupported dynamic branches");
          const selected = options.options.filter(branch => object(branch) && branch.key === node.inputs[field]);
          if (selected.length !== 1 || !object(selected[0])) throw new Error("Ambiguous dynamic branch");
          visit(selected[0].inputs, field + ".", depth + 1);
        }
      }
    }
  }
  try { visit(schema.input); } catch { return new Map(); }
  return ports;
}

/** A loader is optional only when every live consumer explicitly permits omission. */
export function inferMediaInputPolicy(
  graph: ApiWorkflow,
  bindings: Binding[],
  info: Record<string, unknown>,
  outputIds: string[],
): MediaInputPolicy {
  const result: MediaInputPolicy = { optionalSemantics: [], removals: [], groups: [] };
  if (!outputIds.length || outputIds.some(id => !Object.hasOwn(graph, id))) return result;
  const keep = ancestors(graph, outputIds), outputs = new Set(outputIds);
  const ports = new Map([...keep].map(id => [id, nodePorts(id, graph[id], info[graph[id].class_type])]));
  const nodeCounts = new Map<string, number>(), semanticCounts = new Map<string, number>();
  for (const binding of bindings) {
    nodeCounts.set(binding.nodeId, (nodeCounts.get(binding.nodeId) ?? 0) + 1);
    semanticCounts.set(binding.semantic, (semanticCounts.get(binding.semantic) ?? 0) + 1);
  }
  const groups = new Set<Group>();
  for (const binding of bindings) {
    if (!keep.has(binding.nodeId) || outputs.has(binding.nodeId) || nodeCounts.get(binding.nodeId) !== 1 || semanticCounts.get(binding.semantic) !== 1 || !(binding.field in graph[binding.nodeId].inputs)) continue;
    const consumers: { nodeId: string; field: string; port?: Port }[] = [];
    for (const id of keep) for (const [field, value] of Object.entries(graph[id].inputs)) {
      if (link(value) && value[0] === binding.nodeId) consumers.push({ nodeId: id, field, port: ports.get(id)?.get(field) });
    }
    if (!consumers.length || consumers.some(consumer => !consumer.port?.optional)) continue;
    result.optionalSemantics.push(binding.semantic);
    for (const consumer of consumers) {
      result.removals.push({ semantic: binding.semantic, nodeId: consumer.nodeId, field: consumer.field });
      if (consumer.port?.group) groups.add(consumer.port.group);
    }
  }
  result.groups = [...groups].map(group => ({ ...group, fields: [...group.fields], targets: group.targets && [...group.targets] }));
  return result;
}

/** Remove optional example branches from an execution copy, then enforce live group floors. */
export function omitUnconnectedMedia(
  graph: ApiWorkflow,
  policy: MediaInputPolicy,
  provided: Set<string>,
  outputIds: string[],
): ApiWorkflow {
  if (!outputIds.length || outputIds.some(id => !Object.hasOwn(graph, id))) throw new Error("工作流输出节点不存在。");
  const copy = structuredClone(graph), optional = new Set(policy.optionalSemantics);
  for (const removal of policy.removals) {
    if (optional.has(removal.semantic) && !provided.has(removal.semantic) && copy[removal.nodeId]) delete copy[removal.nodeId].inputs[removal.field];
  }
  let keep = ancestors(copy, outputIds);
  for (const group of policy.groups) {
    if (!keep.has(group.nodeId)) continue;
    const inputs = copy[group.nodeId].inputs;
    const values = group.fields.filter(field => Object.hasOwn(inputs, field) && inputs[field] !== undefined && inputs[field] !== null).map(field => inputs[field]);
    if (values.length < group.minimum) throw new Error("请连接素材：" + group.label + " 至少需要 " + group.minimum + " 项，目前 " + values.length + " 项。");
    if (group.targets) {
      if (new Set(group.targets).size !== group.targets.length || group.targets.length < values.length) throw new Error("可变素材输入的名称规则无效。");
      for (const field of group.fields) delete inputs[field];
      values.forEach((value, index) => { inputs[group.targets![index]] = value; });
    }
  }
  keep = ancestors(copy, outputIds);
  return Object.fromEntries(Object.entries(copy).filter(([id]) => keep.has(id)));
}
