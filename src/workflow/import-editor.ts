import type { ApiWorkflow } from "../types";

type RecordValue = Record<string, unknown>;
type Port = { name: string; type?: unknown; link?: unknown; widget?: unknown };
type EditorNode = RecordValue & {
  id: string | number;
  type: string;
  mode?: number;
  inputs?: Port[];
  outputs?: RecordValue[];
};
type Link = {
  id: string;
  origin: string;
  slot: number;
  target: string;
  targetSlot: number;
  type?: unknown;
};
type Spec = {
  name: string;
  type: unknown;
  options: RecordValue;
  required: boolean;
  hiddenCompatibility?: boolean;
};
type Context = {
  graph: RecordValue;
  prefix: string;
  nodes: Map<string, EditorNode>;
  links: Map<string, Link>;
  children: Map<string, Context>;
  overrides: Map<string, unknown>;
  parent?: Context;
  instance?: EditorNode;
  ancestry: string[];
};
type Resolved = { value: unknown; type?: unknown };

const primitiveTypes = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const outputClasses: Record<string, "image" | "video" | "audio" | "text"> = {
  SaveImage: "image",
  SaveImageAdvanced: "image",
  SaveVideo: "video",
  VHS_VideoCombine: "video",
  SaveAudio: "audio",
  SaveAudioMP3: "audio",
  SaveAudioAdvanced: "audio",
  "easy showAnything": "text",
  PreviewImage: "image",
};
export type EditorWorkflowOutput = {
  nodeId: string;
  label: string;
  kind: "image" | "video" | "audio" | "text" | "file";
  needsBinding?: true;
  field?: string;
};

function schemaOutputKind(schema: RecordValue): EditorWorkflowOutput["kind"] {
  const kinds: Record<string, "image" | "video" | "audio" | "text"> = {
    IMAGE: "image",
    VIDEO: "video",
    AUDIO: "audio",
    STRING: "text",
  };
  function infer(types: unknown[]): EditorWorkflowOutput["kind"] | undefined {
    const found = new Set(
      types
        .filter(
          (type): type is string =>
            typeof type === "string" && Object.hasOwn(kinds, type),
        )
        .map((type) => kinds[type]),
    );
    if (found.size === 1) return [...found][0];
    return found.size ? "file" : undefined;
  }
  const outputKind = infer(Array.isArray(schema.output) ? schema.output : []);
  if (outputKind) return outputKind;
  const input = record(schema.input) ? schema.input : {};
  const fields = {
    ...(record(input.required) ? input.required : {}),
    ...(record(input.optional) ? input.optional : {}),
  };
  const types = Object.values(fields).flatMap((value) =>
    Array.isArray(value) ? [value[0]] : [],
  );
  // Filename and option strings must not override an unambiguous media input.
  const media = infer(types.filter((type) => type !== "STRING"));
  return media ?? infer(types) ?? "file";
}
const virtualTypes = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "SetNode",
  "GetNode",
  "PrimitiveNode",
  "PrimitiveNodeValue",
  "Image Comparer (rgthree)",
  "Fast Groups Muter (rgthree)",
  "Fast Groups Bypasser (rgthree)",
  "FastGroupsBypasser",
  "FastGroupsMuter",
  "Power Puter (rgthree)",
]);
const everywhereTypes = new Set([
  "Anything Everywhere",
  "Anything Everywhere3",
  "Anything Everywhere?",
]);
const randomControls = new Set([
  "fixed",
  "increment",
  "decrement",
  "randomize",
]);
const missing = Symbol("missing");

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): RecordValue {
  if (!record(value)) throw new Error(`${label}必须为对象。`);
  return value;
}

function failureMessage(label: string): string {
  return `${label}。当前文件与可用节点定义不足以可靠还原此部分，请补齐节点定义或检查该节点的保存数据。`;
}

/** Distinguish an unavailable node contract from malformed or ambiguous saved data. */
export class MissingWorkflowNodeDefinitionError extends Error {
  readonly nodeId: string;
  readonly nodeType: string;

  constructor(nodeId: string | number, nodeType: string) {
    super(failureMessage(`节点 ${nodeId}（${nodeType}）没有云端节点定义，文件也未保存足够的具名控件信息，无法还原参数`));
    this.name = "MissingWorkflowNodeDefinitionError";
    this.nodeId = String(nodeId);
    this.nodeType = nodeType;
  }
}

function fail(label: string): never {
  throw new Error(failureMessage(label));
}

/** File names are not reliable: both ComfyUI formats use the .json extension. */
export function detectWorkflowFormat(value: unknown): "api" | "editor" {
  const root = object(value, "工作流");
  const graph = record(root.prompt) ? root.prompt : root;
  if (Array.isArray(graph.nodes)) return "editor";
  const metadata = new Set(["workflow", "extra_pnginfo", "extra_data", "metadata"]);
  const entries = Object.entries(graph)
    .filter(([key, node]) => !metadata.has(key) || (record(node) && (Object.hasOwn(node, "class_type") || Object.hasOwn(node, "inputs"))))
    .map(([, node]) => node);
  if (
    entries.length &&
    entries.every(
      (node) =>
        record(node) &&
        typeof node.class_type === "string" &&
        record(node.inputs),
    )
  ) {
    return "api";
  }
  throw new Error("文件不是有效的 ComfyUI API 工作流或编辑器工作流。");
}

export function editorWorkflowOutputs(
  value: unknown,
  info: Record<string, unknown> = {},
): EditorWorkflowOutput[] {
  if (detectWorkflowFormat(value) !== "editor")
    throw new Error("此文件不是编辑器工作流。");
  const root = object(value, "工作流");
  const source = record(root.prompt) ? root.prompt : root;
  const definitions = editorSubgraphs(source, editorWorkflowObjectInfo(value, info));
  const outputs: EditorWorkflowOutput[] = [];
  function collect(editor: RecordValue, prefix: string, ancestry: Set<string>) {
    if (!Array.isArray(editor.nodes)) fail(`子图 ${prefix || "根图"} 缺少节点列表`);
    for (const raw of editor.nodes) {
    if (
      !record(raw) ||
      raw.mode === 2 ||
      raw.mode === 4 ||
      typeof raw.type !== "string" ||
      virtualTypes.has(raw.type) ||
      everywhereTypes.has(raw.type)
    )
      continue;
    const definition = definitions.get(raw.type);
    if (definition) {
      if (ancestry.has(raw.type)) fail(`子图 ${prefix}${String(raw.id)} 存在递归定义`);
      collect(definition, prefix + String(raw.id) + ":", new Set(ancestry).add(raw.type));
      continue;
    }
    const schema = nodeSchema(raw as EditorNode, info, source);
    const knownKind = Object.hasOwn(outputClasses, raw.type)
      ? outputClasses[raw.type]
      : undefined;
    if (!knownKind && schema?.output_node !== true) continue;
    outputs.push({
        nodeId: prefix + String(raw.id),
        label: `${typeof raw.title === "string" ? raw.title : raw.type} · ${prefix}${String(raw.id)}`,
        kind: knownKind ?? schemaOutputKind(schema!),
        ...(!knownKind ? { field: "*" } : {}),
      });
    }
  }
  collect(source, "", new Set());
  if (new Set(outputs.map(output => output.nodeId)).size !== outputs.length) fail("展开后的保存输出节点编号不唯一");
  return outputs;
}

function formalSubgraphs(root: RecordValue): Map<string, RecordValue> {
  const result = new Map<string, RecordValue>();
  const list = record(root.definitions) ? root.definitions.subgraphs : undefined;
  if (list !== undefined && !Array.isArray(list)) fail("子图定义格式不受支持");
  for (const raw of (list ?? []) as unknown[]) {
    const definition = object(raw, "子图定义");
    if (typeof definition.id !== "string" || result.has(definition.id)) fail("子图定义缺少唯一编号");
    result.set(definition.id, definition);
  }
  return result;
}

/** Rebuild the legacy group-node contract from its saved graph and exact node schemas. */
function editorSubgraphs(root: RecordValue, info: Record<string, unknown> = {}): Map<string, RecordValue> {
  const result = formalSubgraphs(root);
  const legacy = record(root.extra) ? root.extra.groupNodes : undefined;
  if (legacy === undefined) return result;
  if (!record(legacy)) fail("旧版组节点定义格式不受支持");
  const groups: RecordValue = legacy;
  const building = new Set<string>();
  const groupName = (type: string) => /^workflow[>/]/.test(type) ? type.slice(9) : undefined;
  function build(type: string): RecordValue | undefined {
    if (result.has(type)) return result.get(type);
    const name = groupName(type);
    if (name === undefined) return undefined;
    const raw = groups[name];
    if (!record(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.links)) fail(`旧版组节点 ${type} 缺少内部节点或连线`);
    if (building.has(type)) fail(`旧版组节点 ${type} 存在递归定义`);
    building.add(type);
    const nodes: EditorNode[] = raw.nodes.map((entry, index) => {
      if (!record(entry) || typeof entry.type !== "string") fail(`旧版组节点 ${type} 内部节点 ${index} 无效`);
      const copy = structuredClone(entry) as EditorNode;
      copy.id = index;
      copy.inputs = ports(copy).map(port => ({ ...port, link: null }));
      return copy;
    });
    const links: unknown[][] = [], connected = new Set<string>(), internallyUsed = new Set<string>();
    function addLink(origin: number, slot: number, target: number, targetSlot: number, portType: unknown) {
      const id = links.length + 1;
      links.push([id, origin, slot, target, targetSlot, portType]);
      if (target >= 0) {
        const port = nodes[target]?.inputs?.[targetSlot];
        if (!port || connected.has(`${target}\0${targetSlot}`)) fail(`旧版组节点 ${type} 内部输入 ${target}:${targetSlot} 缺失或重复连线`);
        port.link = id;
        connected.add(`${target}\0${targetSlot}`);
      }
    }
    for (const entry of raw.links) {
      if (!Array.isArray(entry) || entry.length < 5) fail(`旧版组节点 ${type} 的连线记录无效`);
      const [origin, slot, target, targetSlot, , portType] = entry;
      if (origin === null) continue; // Original outside-node ids are not links of this instance.
      if (![origin, slot, target, targetSlot].every(value => Number.isInteger(value) && Number(value) >= 0) || !nodes[Number(origin)] || !nodes[Number(target)]) fail(`旧版组节点 ${type} 的连线索引超出内部节点范围`);
      addLink(Number(origin), Number(slot), Number(target), Number(targetSlot), portType);
      internallyUsed.add(`${origin}\0${slot}`);
    }
    const external = new Set<string>();
    if (raw.external !== undefined && !Array.isArray(raw.external)) fail(`旧版组节点 ${type} 的外部输出记录无效`);
    for (const entry of (raw.external ?? []) as unknown[]) {
      if (!Array.isArray(entry) || entry.length < 3 || !Number.isInteger(Number(entry[0])) || !Number.isInteger(Number(entry[1])) || !nodes[Number(entry[0])] || Number(entry[1]) < 0) fail(`旧版组节点 ${type} 的外部输出索引无效`);
      external.add(`${Number(entry[0])}\0${Number(entry[1])}`);
    }
    const inputs: RecordValue[] = [], outputs: RecordValue[] = [], proxyWidgets: unknown[][] = [];
    const required: RecordValue = Object.create(null), seen = new Map<string, number>(), deferred: (() => void)[] = [];
    const config = raw.config === undefined ? {} : object(raw.config, `旧版组节点 ${type} 可见性配置`);
    function inputName(node: EditorNode, spec: Spec): { name: string; config: RecordValue } {
      const nodeConfig = record(config[String(node.id)]) ? config[String(node.id)] as RecordValue : {};
      const fields = record(nodeConfig.input) ? nodeConfig.input : {};
      const custom = record(fields[spec.name]) ? fields[spec.name] as RecordValue : {};
      const port = ports(node).find(port => port.name === spec.name) as (Port & { label?: unknown }) | undefined;
      let name = typeof custom.name === "string" ? custom.name : typeof port?.label === "string" ? port.label : spec.name;
      const key = node.type === "PrimitiveNode" && typeof node.title === "string" || seen.has(name) ? `${node.title ?? node.type} ${spec.name}` : name;
      name = key;
      if (seen.has(key)) name = `${node.title ?? node.type} ${seen.get(key)} ${spec.name}`;
      seen.set(key, (seen.get(key) ?? 1) + 1);
      if (Object.hasOwn(required, name)) fail(`旧版组节点 ${type} 的外部输入名称 ${name} 存在歧义`);
      return { name, config: custom };
    }
    function widget(node: EditorNode, spec: Spec, socket: boolean) {
      const named = inputName(node, spec);
      if (named.config.visible === false) return;
      const options = { ...spec.options, ...(!Object.hasOwn(spec.options, "control_after_generate") && (["seed", "noise_seed"].includes(spec.name) || node.type === "PrimitiveNode") ? { control_after_generate: true } : {}) };
      required[named.name] = [spec.type, options];
      proxyWidgets.push([node.id, spec.name, named.name]);
      if (socket) inputSocket(node, spec, named);
    }
    function inputSocket(node: EditorNode, spec: Spec, supplied?: { name: string; config: RecordValue }) {
      const named = supplied ?? inputName(node, spec);
      if (named.config.visible === false && !supplied) return;
      if (!supplied) required[named.name] = [spec.type, { ...spec.options, forceInput: true }];
      let slot = ports(node).findIndex(port => port.name === spec.name);
      if (slot < 0) { slot = ports(node).length; node.inputs!.push({ name: spec.name, type: spec.type, link: null }); }
      const inputIndex = inputs.length;
      inputs.push({ name: named.name, type: spec.type });
      addLink(-10, inputIndex, Number(node.id), slot, spec.type);
    }
    for (const node of nodes) {
      if (node.mode === 2) continue;
      const nested = node.mode === 4 ? undefined : build(node.type);
      let schema = node.mode === 4 ? undefined : nested ? nested.__canvas_legacy_schema : nodeSchema(node, info, root);
      if (node.mode === 4) {
        const fields: RecordValue = Object.create(null);
        for (const port of ports(node)) {
          if (port.type === undefined) fail(`旧版组节点 ${type} 的旁路节点 ${node.id} 缺少输入类型`);
          fields[port.name] = [port.type, { forceInput: true }];
        }
        schema = { input: { required: fields }, output: node.outputs?.map(port => port.type) ?? [] };
      } else if (node.type === "PrimitiveNode" || node.type === "PrimitiveNodeValue") {
        const outputType = node.outputs?.[0]?.type ?? links.find(link => link[1] === node.id)?.[5];
        if (outputType === undefined) { if (!internallyUsed.has(`${node.id}\0${0}`)) continue; fail(`旧版组节点 ${type} 的 Primitive ${node.id} 缺少类型`); }
        schema = { input: { required: { value: [outputType, {}] } }, output: [outputType] };
      } else if (node.type === "Reroute") {
        const port = ports(node)[0];
        if (!port) node.inputs!.push({ name: "", type: node.outputs?.[0]?.type ?? "*", link: null });
        const type = ports(node)[0].type ?? node.outputs?.[0]?.type ?? "*";
        schema = { input: { required: { [String(type)]: [type, { forceInput: true }] } }, output: [node.outputs?.[0]?.type ?? type] };
      } else if (isVirtual(node)) continue;
      if (!record(schema) || !record(schema.input)) fail(`旧版组节点 ${type} 的内部节点 ${node.id}（${node.type}）缺少可还原的控件与端口定义`);
      const specs = inputSpecs(node, { ...info, [node.type]: schema });
      if (specs.some(spec => typeof spec.type === "string" && spec.type.startsWith("COMFY_"))) fail(`旧版组节点 ${type} 的内部节点 ${node.id} 使用无法从组元数据还原的动态控件`);
      for (const spec of specs) {
        const port = ports(node).find(port => port.name === spec.name);
        const converted = record(port?.widget) && port.widget.name === spec.name;
        if (isWidget(spec)) {
          if (converted) { if (port?.link == null) deferred.push(() => widget(node, spec, true)); }
          else widget(node, spec, false);
        } else if (port?.link == null) inputSocket(node, spec);
      }
      const outputTypes = Array.isArray(schema.output) ? schema.output : node.outputs?.map(port => port.type);
      if (!outputTypes) fail(`旧版组节点 ${type} 的内部节点 ${node.id} 缺少输出定义`);
      for (let slot = 0; slot < outputTypes.length; slot++) {
        const nodeConfig = record(config[String(node.id)]) ? config[String(node.id)] as RecordValue : {};
        const outputConfig = record(nodeConfig.output) ? nodeConfig.output : {};
        const custom = record(outputConfig[String(slot)]) ? outputConfig[String(slot)] as RecordValue : {};
        if (custom.visible === false || (custom.visible !== true && internallyUsed.has(`${node.id}\0${slot}`) && !external.has(`${node.id}\0${slot}`))) continue;
        const outputIndex = outputs.length;
        outputs.push({ name: typeof custom.name === "string" ? custom.name : `output_${outputIndex}`, type: outputTypes[slot] });
        addLink(Number(node.id), slot, -20, outputIndex, outputTypes[slot]);
      }
    }
    for (const finish of deferred) finish();
    const definition: RecordValue = { id: type, nodes, links, inputs, outputs, inputNode: { id: -10 }, outputNode: { id: -20 }, __canvas_legacy_proxies: proxyWidgets, __canvas_legacy_schema: { input: { required }, output: outputs.map(output => output.type) } };
    result.set(type, definition);
    building.delete(type);
    return definition;
  }
  for (const editor of [root, ...result.values()]) if (Array.isArray(editor.nodes)) for (const node of editor.nodes) if (record(node) && typeof node.type === "string" && node.mode !== 2 && node.mode !== 4) build(node.type);
  return result;
}

function nodeSchema(
  node: EditorNode,
  info: Record<string, unknown>,
  source?: RecordValue,
): RecordValue | undefined {
  if (record(info[node.type])) return info[node.type] as RecordValue;
  const properties = record(node.properties) ? node.properties : {};
  const snapshots = source ? [source.object_info, record(source.extra) ? source.extra.object_info : undefined] : [];
  for (const snapshot of snapshots) if (record(snapshot) && record(snapshot[node.type])) return snapshot[node.type] as RecordValue;
  for (const candidate of [node.node_def, node.input_schema, properties.node_def, properties.node_definition, properties.input_schema]) {
    if (!record(candidate)) continue;
    if (typeof candidate.name === "string" && candidate.name !== node.type) fail(`节点 ${node.id} 的内嵌定义属于其他节点类型`);
    if (record(candidate.input)) return candidate;
    if (record(candidate.required) || record(candidate.optional)) return { input: candidate, output: node.outputs?.map(port => port.type) ?? [] };
  }
  if (node.type === "CR Prompt Text") {
    const values = savedWidgetValues(node);
    const valid = Array.isArray(values)
      ? values.length === 1 && typeof values[0] === "string"
      : record(values) &&
        Object.keys(values).length === 1 &&
        typeof values.prompt === "string";
    if (
      valid &&
      ports(node).every(
        (port) => port.name === "prompt" && port.type === "STRING",
      )
    ) {
      return {
        input: { required: { prompt: ["STRING", {}] } },
        output: ["STRING", "STRING"],
      };
    }
  }
  return serializedNodeSchema(node);
}

/** Some exporters preserve a complete named snapshot beside the widget array.
 * Use those explicit names only when every saved value is accounted for; never
 * recover anonymous order from labels or from an incomplete/stale snapshot. */
function savedWidgetValues(node: EditorNode): unknown {
  const saved = node.widgets_values;
  const named = node.widgets_values_named;
  if (!record(named)) return saved;
  if (saved === undefined) return named;
  if (record(saved)) {
    if (Object.keys(named).length !== Object.keys(saved).length || Object.entries(named).some(([name, value]) => !Object.hasOwn(saved, name) || JSON.stringify(saved[name]) !== JSON.stringify(value)))
      fail(`节点 ${node.id} 的具名控件快照与保存值不一致`);
    return named;
  }
  if (!Array.isArray(saved) || Object.keys(named).length !== saved.length)
    fail(`节点 ${node.id} 的具名控件快照不完整，无法还原全部保存值`);
  const unmatched = saved.map(value => JSON.stringify(value));
  for (const value of Object.values(named)) {
    const index = unmatched.indexOf(JSON.stringify(value));
    if (index < 0) fail(`节点 ${node.id} 的具名控件快照与保存值不一致`);
    unmatched.splice(index, 1);
  }
  return named;
}

/** Anonymous widget arrays do not carry field names; use only names explicitly serialized by the file. */
function serializedNodeSchema(node: EditorNode): RecordValue | undefined {
  const values = savedWidgetValues(node) ?? [];
  const named = record(values) ? values : undefined;
  const declarations = Array.isArray(node.widgets) ? node.widgets : undefined;
  const inputPorts = ports(node);
  let widgetNames: string[];
  if (named) widgetNames = Object.keys(named);
  else if (declarations && declarations.every(widget => record(widget) && typeof widget.name === "string" && widget.name)) widgetNames = declarations.map(widget => (widget as RecordValue).name as string);
  else if (Array.isArray(values) && values.length === 1 && inputPorts.filter(port => record(port.widget) && port.widget.name === port.name).length === 1) widgetNames = [inputPorts.find(port => record(port.widget) && port.widget.name === port.name)!.name];
  else if (Array.isArray(values) && values.length === 0) widgetNames = [];
  else return undefined;
  if (new Set(widgetNames).size !== widgetNames.length) fail(`节点 ${node.id} 的具名控件重复`);
  const required: RecordValue = Object.create(null), optional: RecordValue = Object.create(null);
  const order: { required: string[]; optional: string[] } = { required: [], optional: [] };
  function add(name: string, type: unknown, options: RecordValue, requiredField = true) {
    if (name in required || name in optional) return;
    (requiredField ? required : optional)[name] = [type, options]; order[requiredField ? "required" : "optional"].push(name);
  }
  for (const name of widgetNames) {
    const declaration = declarations?.find(widget => record(widget) && widget.name === name);
    const port = inputPorts.find(input => input.name === name);
    const options = record(declaration) && record(declaration.options) ? { ...declaration.options } : record(port?.widget) && record(port.widget.options) ? { ...port.widget.options } : {};
    let type = port?.type ?? (record(declaration) ? declaration.type : undefined);
    const types: Record<string, string> = { text: "STRING", string: "STRING", number: "FLOAT", integer: "INT", boolean: "BOOLEAN", toggle: "BOOLEAN", combo: "COMBO" };
    if (typeof type === "string" && Object.hasOwn(types, type)) type = types[type];
    const literal = named?.[name];
    if (type === undefined && named) type = typeof literal === "string" ? "STRING" : typeof literal === "boolean" ? "BOOLEAN" : typeof literal === "number" ? "FLOAT" : "JSON";
    // A named snapshot already includes the selected branch's fully qualified
    // fields (for example mode and mode.scale). Without a server branch table,
    // retain exactly that saved selector and those named fields as a flat API
    // contract; do not fabricate other branches or discard the child values.
    if (type === "COMFY_DYNAMICCOMBO_V3" && named && ["string", "number", "boolean"].includes(typeof literal) && !Array.isArray(options.options))
      type = [literal];
    if (type === undefined) return undefined;
    if (type === "COMBO" && Array.isArray(options.values)) type = options.values;
    if (!Array.isArray(type) && !primitiveTypes.has(String(type))) options.__canvas_literal = true;
    add(name, type, options);
  }
  for (const port of inputPorts) {
    if (port.name in required || port.name in optional) continue;
    if (port.type === undefined) return undefined;
    const declared = port as Port & { optional?: unknown; required?: unknown };
    add(port.name, port.type, { forceInput: true }, declared.required === true || (declared.optional !== true && port.link != null));
  }
  const properties = record(node.properties) ? node.properties : {};
  return { input: { required, optional }, input_order: order, output: node.outputs?.map(port => port.type) ?? [], ...(node.output_node === true || properties.output_node === true ? { output_node: true } : {}), __canvas_from_editor: true };
}

/** A live or cached contract wins over file metadata; conflicting per-node fallbacks are not merged. */
export function editorWorkflowObjectInfo(value: unknown, info: Record<string, unknown> = {}): Record<string, unknown> {
  if (detectWorkflowFormat(value) !== "editor") return { ...info };
  const raw = object(value, "工作流"), root = record(raw.prompt) ? raw.prompt : raw;
  const snapshots = [root.object_info, record(root.extra) ? root.extra.object_info : undefined].filter(record);
  const result = Object.assign(Object.create(null), ...snapshots, info) as Record<string, unknown>;
  const authoritative = new Set(Object.keys(result)), conflicting = new Set<string>();
  const oldGroups = record(root.extra) && record(root.extra.groupNodes) ? Object.values(root.extra.groupNodes).filter(record) : [];
  for (const editor of [root, ...formalSubgraphs(root).values(), ...oldGroups]) {
    if (!Array.isArray(editor.nodes)) continue;
    for (const rawNode of editor.nodes) {
      if (!record(rawNode) || typeof rawNode.type !== "string" || !isLive(rawNode as EditorNode) || isVirtual(rawNode as EditorNode) || authoritative.has(rawNode.type) || conflicting.has(rawNode.type)) continue;
      const schema = nodeSchema(rawNode as EditorNode, {});
      if (!schema) continue;
      if (result[rawNode.type] && JSON.stringify(result[rawNode.type]) !== JSON.stringify(schema)) { delete result[rawNode.type]; conflicting.add(rawNode.type); }
      else result[rawNode.type] = schema;
    }
  }
  return result;
}

function inputSpecs(node: EditorNode, info: Record<string, unknown>): Spec[] {
  const schema = nodeSchema(node, info);
  if (!record(schema) || !record(schema.input))
    throw new MissingWorkflowNodeDefinitionError(node.id, node.type);
  const specs: Spec[] = [];
  const names = new Set<string>();
  for (const section of ["required", "optional"] as const) {
    const fields =
      schema.input[section] === undefined
        ? {}
        : object(schema.input[section], `${node.type} ${section}`);
    const declaredOrder = record(schema.input_order)
      ? schema.input_order[section]
      : undefined;
    if (
      declaredOrder !== undefined &&
      (!Array.isArray(declaredOrder) ||
        declaredOrder.some((name) => typeof name !== "string"))
    ) {
      fail(`节点 ${node.id}（${node.type}）的 input_order 不受支持`);
    }
    const order =
      (declaredOrder as string[] | undefined) ?? Object.keys(fields);
    if (
      new Set(order).size !== order.length ||
      Object.keys(fields).some((name) => !order.includes(name))
    ) {
      fail(`节点 ${node.id}（${node.type}）的 input_order 与输入定义不一致`);
    }
    for (const name of order) {
      if (!(name in fields))
        fail(`节点 ${node.id}（${node.type}）的输入定义缺少 ${name}`);
      if (names.has(name))
        fail(`节点 ${node.id}（${node.type}）重复定义输入 ${name}`);
      names.add(name);
      const raw = fields[name];
      if (!Array.isArray(raw) || !raw.length)
        fail(`节点 ${node.id}（${node.type}）输入 ${name} 的定义不受支持`);
      specs.push({
        name,
        type: raw[0],
        options: record(raw[1]) ? raw[1] : {},
        required: section === "required",
      });
    }
  }
  // Primitive hidden compatibility widgets can be serialized by extensions.
  // Restore only an explicit saved name, or one corroborated single property;
  // server-owned PROMPT/UNIQUE_ID/EXTRA_PNGINFO fields remain server-owned.
  if (record(schema.input.hidden)) for (const [name, raw] of Object.entries(schema.input.hidden)) {
    if (names.has(name)) continue;
    const type = Array.isArray(raw) ? raw[0] : raw;
    if (!primitiveTypes.has(String(type))) continue;
    const values = savedWidgetValues(node);
    const explicit = record(values) && Object.hasOwn(values, name);
    const property = record(node.properties) ? node.properties : {};
    const corroborated = Array.isArray(values) && values.length === 1 && Object.hasOwn(property, name) && property[name] === values[0];
    if (!explicit && !corroborated) continue;
    names.add(name);
    specs.push({ name, type, options: Array.isArray(raw) && record(raw[1]) ? raw[1] : {}, required: false, hiddenCompatibility: true });
  }
  return specs.flatMap((spec) => {
    if (spec.type !== "COMFY_AUTOGROW_V3") return [spec];
    const template = object(
      spec.options.template,
      `节点 ${node.id} 自动扩展输入 ${spec.name} 的模板`,
    );
    const templateInput = object(
      template.input,
      `节点 ${node.id} 自动扩展输入模板 input`,
    );
    const atoms = {
      ...object(templateInput.required ?? {}, "模板 required"),
      ...object(templateInput.optional ?? {}, "模板 optional"),
    };
    const entries = Object.entries(atoms);
    if (entries.length !== 1 || !Array.isArray(entries[0][1]))
      fail(`节点 ${node.id} 自动扩展输入 ${spec.name} 的复合模板不受支持`);
    const raw = entries[0][1] as unknown[];
    const names = Array.isArray(template.names) ? template.names : undefined;
    const prefix =
      typeof template.prefix === "string" ? template.prefix : undefined;
    if (!names && !prefix)
      fail(`节点 ${node.id} 自动扩展输入 ${spec.name} 缺少名称规则`);
    const minimum = typeof template.min === "number" ? template.min : 0;
    const candidates = ports(node).filter((port) =>
      port.name.startsWith(spec.name + "."),
    );
    const expanded: Spec[] = [];
    for (const port of candidates) {
      const suffix = port.name.slice(spec.name.length + 1);
      const index = names
        ? names.indexOf(suffix)
        : suffix.startsWith(prefix!) &&
            /^\d+$/.test(suffix.slice(prefix!.length))
          ? Number(suffix.slice(prefix!.length))
          : -1;
      if (
        index < 0 ||
        (typeof template.max === "number" && index >= template.max)
      )
        fail(`节点 ${node.id} 自动扩展输入 ${port.name} 超出模板规则`);
      expanded.push({
        name: port.name,
        type: raw[0],
        options: record(raw[1]) ? raw[1] : {},
        required: index < minimum,
      });
    }
    if (candidates.filter((port) => port.link != null).length < minimum)
      fail(
        `节点 ${node.id} 自动扩展输入 ${spec.name} 至少需要 ${minimum} 项连接`,
      );
    return expanded;
  });
}

/** Expand only schema-declared V3 templates against literal API keys. */
export function workflowImportInputSchema(
  node: ApiWorkflow[string],
  schema: unknown,
  onMissingRequiredSelector?: (name: string, definition: unknown[]) => void,
): { required: RecordValue; optional: RecordValue } {
  if (!record(schema) || !record(schema.input))
    return { required: {}, optional: {} };
  const pseudo: EditorNode = {
    id: "API",
    type: node.class_type,
    inputs: Object.entries(node.inputs).map(([name, value]) => ({
      name,
      link:
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string"
          ? 1
          : null,
    })),
  };
  const specs = inputSpecs(pseudo, { [node.class_type]: schema });
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    if (spec.type !== "COMFY_DYNAMICCOMBO_V3") {
      insertFormatWidgets(specs, index, node.inputs[spec.name]);
      continue;
    }
    if (!Object.hasOwn(node.inputs, spec.name)) {
      // An omitted optional selector has no selected branch. In particular,
      // SaveVideo's optional encoding mode must not be mistaken for bad data.
      if (!spec.required) {
        if (Object.keys(node.inputs).some(name => name.startsWith(spec.name + ".")))
          fail(`节点 ${node.class_type} 动态选项 ${spec.name} 缺少选择值，无法还原已保存的子参数`);
        continue;
      }
      if (legacySaveVideoCodec(node.class_type, spec, specs, node.inputs)) {
        // ComfyUI retains the hidden root codec for old API exports and uses it
        // when format.codec is absent. Keep that saved input unchanged rather
        // than inventing a nested codec or choosing a default branch.
        specs.splice(index--, 1);
        continue;
      }
      onMissingRequiredSelector?.(spec.name, [spec.type, spec.options]);
    }
    const options = spec.options.options;
    if (!Array.isArray(options))
      fail(`节点 ${node.class_type} 动态选项 ${spec.name} 缺少分支定义`);
    const matches = options.filter(
      (entry) => record(entry) && entry.key === node.inputs[spec.name],
    );
    if (matches.length !== 1)
      fail(`节点 ${node.class_type} 动态选项 ${spec.name} 没有唯一分支`);
    const option = matches[0] as RecordValue;
    const input = object(option.inputs, `动态选项 ${spec.name} 分支 inputs`);
    const child: EditorNode = {
      ...pseudo,
      type: "__dynamic__",
      inputs: ports(pseudo)
        .filter((port) => port.name.startsWith(spec.name + "."))
        .map((port) => ({
          ...port,
          name: port.name.slice(spec.name.length + 1),
        })),
    };
    const children = inputSpecs(child, {
      __dynamic__: { input, input_order: option.input_order },
    }).map((entry) => ({ ...entry, name: spec.name + "." + entry.name }));
    specs.splice(index + 1, 0, ...children);
  }
  const result: { required: RecordValue; optional: RecordValue } = {
    required: {},
    optional: {},
  };
  for (const spec of specs)
    result[spec.required ? "required" : "optional"][spec.name] = [
      spec.type,
      spec.options,
    ];
  return result;
}

/** VHS advertises format-specific widgets in object_info instead of V3 branches.
 * Their names, types and order are explicit; preset dictionaries on loaders are
 * a different contract and must not be mistaken for additional input widgets. */
function insertFormatWidgets(specs: Spec[], index: number, value: unknown): void {
  const selector = specs[index];
  if (!record(selector.options.formats) || typeof value !== "string") return;
  const definitions = selector.options.formats[value];
  if (!Array.isArray(definitions)) return;
  const children: Spec[] = [];
  for (const definition of definitions) {
    if (!Array.isArray(definition) || typeof definition[0] !== "string" || !definition[0] || definition.length < 2)
      fail(`格式 ${value} 的动态控件定义无效`);
    const name = definition[0];
    if (specs.some(spec => spec.name === name) || children.some(spec => spec.name === name))
      fail(`格式 ${value} 的动态控件 ${name} 重复定义`);
    children.push({ name, type: definition[1], options: record(definition[2]) ? definition[2] : {}, required: true });
  }
  specs.splice(index + 1, 0, ...children);
}

function legacySaveVideoCodec(
  nodeType: string,
  spec: Spec,
  specs: Spec[],
  inputs: RecordValue,
): boolean {
  if (nodeType !== "SaveVideo" || spec.name !== "format.codec" ||
      Object.hasOwn(inputs, spec.name) || !Object.hasOwn(inputs, "codec") ||
      Object.keys(inputs).some(name => name.startsWith(spec.name + "."))) return false;
  const legacy = specs.find(entry => entry.name === "codec" &&
    entry.type === "COMFY_DYNAMICCOMBO_V3" && !entry.required && entry.options.hidden === true);
  const uniquelyAccepts = (entry: Spec) => Array.isArray(entry.options.options) &&
    entry.options.options.filter(option => record(option) && option.key === inputs.codec).length === 1;
  // Both the explicit compatibility input and the selected container must
  // support the author's saved codec. A similarly named plugin is not enough.
  return !!legacy && uniquelyAccepts(legacy) && uniquelyAccepts(spec);
}

function isWidget(spec: Spec): boolean {
  return (
    (Array.isArray(spec.type) ||
      primitiveTypes.has(String(spec.type)) ||
      spec.type === "COMFY_DYNAMICCOMBO_V3" || spec.type === "JSON" || spec.options.__canvas_literal === true) &&
    !spec.options.forceInput
  );
}

function apiLiteral(value: unknown): unknown {
  // As in ComfyUI's graphToPrompt, literal arrays must not look like node links.
  return Array.isArray(value)
    ? { __value__: structuredClone(value) }
    : structuredClone(value);
}

function validateWidget(node: EditorNode, spec: Spec, value: unknown): void {
  const connected = node.inputs?.some(
    (port) => port.name === spec.name && port.link != null,
  );
  if (value == null && connected) return;
  if (spec.type === "JSON" || spec.options.__canvas_literal === true) {
    if (value === undefined) fail(`节点 ${node.id}（${node.type}）具名控件 ${spec.name} 缺少保存值`);
    return;
  }
  const type =
    Array.isArray(spec.type) || spec.type === "COMFY_DYNAMICCOMBO_V3"
      ? "COMBO"
      : spec.type;
  const valid =
    type === "INT"
      ? typeof value === "number" && Number.isInteger(value)
      : type === "FLOAT"
        ? typeof value === "number" && Number.isFinite(value)
        : type === "BOOLEAN"
          ? typeof value === "boolean"
          : type === "STRING"
            ? typeof value === "string"
            : type === "COMBO"
              ? ["string", "number", "boolean"].includes(typeof value)
              : false;
  if (!valid)
    fail(
      `节点 ${node.id}（${node.type}）控件 ${spec.name} 的值与 ${String(type)} 定义不符，无法可靠还原控件顺序`,
    );
}

function frontendWidget(node: EditorNode, name: string): boolean {
  const mediaNode =
    /^(LoadImage|LoadVideo|LoadAudio|SaveVideo|VHS_LoadVideo|VHS_LoadVideoPath|VHS_LoadAudio|VHS_VideoCombine)$/.test(
      node.type,
    );
  if (
    mediaNode &&
    [
      "image_upload",
      "video_upload",
      "audio_upload",
      "videopreview",
      "image_preview",
      "choose video to upload",
      "choose audio to upload",
      "choose file to upload",
    ].includes(name)
  )
    return true;
  return false;
}

function widgets(
  node: EditorNode,
  specs: Spec[],
  overrides: Map<string, unknown>,
  verifyNamedArrayOrder = false,
): RecordValue {
  const originalSpecs = [...specs];
  let values = savedWidgetValues(node) ?? [];
  // Match VHS's own onConfigure migration for old named LoadVideo saves. The
  // current backend ignores force_size, so simply forwarding it loses resizing.
  if (/^VHS_LoadVideo(?:Path|FFmpeg|FFmpegPath)?$/.test(node.type) && record(values) && typeof values.force_size === "string" &&
      !specs.some(spec => spec.name === "force_size" && !spec.hiddenCompatibility) &&
      ["custom_width", "custom_height"].every(name => specs.some(spec => spec.name === name && spec.type === "INT"))) {
    const migrated = { ...values };
    const size = /^(\d+|\?)x(\d+|\?)$/.exec(values.force_size);
    if (!size && !["Disabled", "Custom Height", "Custom Width"].includes(values.force_size))
      fail(`节点 ${node.id} 的旧尺寸模式 force_size 无法可靠迁移`);
    if (size) {
      migrated.custom_width = size[1] === "?" ? 0 : Number(size[1]);
      migrated.custom_height = size[2] === "?" ? 0 : Number(size[2]);
    } else {
      if (["Disabled", "Custom Height"].includes(values.force_size)) migrated.custom_width = 0;
      if (["Disabled", "Custom Width"].includes(values.force_size)) migrated.custom_height = 0;
    }
    delete migrated.force_size;
    values = migrated;
  }
  if (node.type === "VHS_VideoCombine" && record(values) && Object.hasOwn(values, "save_image") && specs.some(spec => spec.name === "save_output")) {
    const migrated: RecordValue = { ...values, save_output: Object.hasOwn(values, "save_output") ? values.save_output : values.save_image };
    delete migrated.save_image;
    values = migrated;
  }
  const result: RecordValue = {};
  function expandCombo(index: number, value: unknown): void {
    const spec = specs[index];
    if (spec.type !== "COMFY_DYNAMICCOMBO_V3") {
      insertFormatWidgets(specs, index, value);
      return;
    }
    const options = spec.options.options;
    if (!Array.isArray(options))
      fail(`节点 ${node.id} 动态选项 ${spec.name} 缺少分支定义`);
    const choices = options.filter(
      (entry) => record(entry) && entry.key === value,
    );
    if (choices.length !== 1)
      fail(
        `节点 ${node.id} 动态选项 ${spec.name} 没有唯一分支 ${String(value)}`,
      );
    const branch = choices[0] as RecordValue;
    const input = object(
      branch.inputs,
      `节点 ${node.id} 动态选项 ${spec.name} 分支 inputs`,
    );
    const tempNode: EditorNode = {
      ...node,
      type: "__dynamic__",
      inputs: ports(node)
        .filter((port) => port.name.startsWith(spec.name + "."))
        .map((port) => ({
          ...port,
          name: port.name.slice(spec.name.length + 1),
        })),
    };
    const children = inputSpecs(tempNode, {
      __dynamic__: { input, input_order: branch.input_order },
    }).map((child) => ({ ...child, name: spec.name + "." + child.name }));
    if (
      children.some((child) =>
        specs.some((existing) => existing.name === child.name),
      )
    )
      fail(`节点 ${node.id} 动态选项 ${spec.name} 重复子参数`);
    specs.splice(index + 1, 0, ...children);
  }
  if (record(values)) {
    for (let index = 0; index < specs.length; index++)
      if (specs[index].type === "COMFY_DYNAMICCOMBO_V3") {
        const spec = specs[index];
        if (!Object.hasOwn(values, spec.name)) {
          if (!spec.required) {
            if (Object.keys(values).some(name => name.startsWith(spec.name + ".")))
              fail(`节点 ${node.id} 动态选项 ${spec.name} 缺少选择值，无法还原已保存的子参数`);
            continue;
          }
          if (legacySaveVideoCodec(node.type, spec, specs, values)) {
            specs.splice(index--, 1);
            continue;
          }
        }
        expandCombo(index, values[spec.name]);
      } else if (Object.hasOwn(values, specs[index].name)) expandCombo(index, values[specs[index].name]);
    for (const [name, value] of Object.entries(values)) {
      const spec = specs.find((entry) => entry.name === name);
      if (!spec) {
        if (frontendWidget(node, name)) continue;
        if (name === "control_after_generate" && typeof value === "string" && randomControls.has(value) &&
            specs.some(entry => entry.options.control_after_generate === true ||
              (typeof entry.options.control_after_generate === "string" && randomControls.has(entry.options.control_after_generate)) ||
              (!Object.hasOwn(entry.options, "control_after_generate") && ["seed", "noise_seed"].includes(entry.name.split(".").at(-1)!)))) continue;
        fail(`节点 ${node.id}（${node.type}）包含未声明的动态控件 ${name}`);
      }
      if (!isWidget(spec))
        fail(
          `节点 ${node.id}（${node.type}）控件 ${name} 不是可序列化的标量控件`,
        );
      validateWidget(node, spec, value);
      if (value != null || spec.type === "JSON" || spec.options.__canvas_literal === true) result[name] = apiLiteral(value);
    }
  } else if (Array.isArray(values)) {
    let cursor = 0;
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      if (!isWidget(spec)) continue;
      const overrideKey = `${node.id}\0${spec.name}`;
      if (cursor >= values.length) {
        if (overrides.has(overrideKey)) continue;
        // Converted widget inputs may omit their value and are supplied by a link.
        if (
          node.inputs?.some(
            (port) =>
              port.name === spec.name && port.link != null && port.widget,
          )
        )
          continue;
        if (!spec.required) continue;
        fail(`节点 ${node.id}（${node.type}）缺少控件 ${spec.name} 的保存值`);
      }
      const value = values[cursor++];
      validateWidget(node, spec, value);
      if (value != null || spec.type === "JSON" || spec.options.__canvas_literal === true) result[spec.name] = apiLiteral(value);
      expandCombo(index, value);
      if (
        (spec.options.control_after_generate === true ||
          (typeof spec.options.control_after_generate === "string" && randomControls.has(spec.options.control_after_generate)) ||
          (!Object.hasOwn(spec.options, "control_after_generate") && ["seed", "noise_seed"].includes(spec.name.split(".").at(-1)!) &&
            !specs.slice(index + 1).some(entry => entry.type === "COMFY_DYNAMICCOMBO_V3" || record(entry.options.formats)) &&
            values.length - cursor > specs.slice(index + 1).filter(isWidget).length)) &&
        typeof values[cursor] === "string" &&
        randomControls.has(values[cursor] as string)
      )
        cursor++;
    }
    const extras = values.slice(cursor);
    // LoadImage adds a frontend-only upload selector after its image widget.
    if (
      extras.length &&
      !(
        node.type === "LoadImage" &&
        extras.length === 1 &&
        ["image", "choose file to upload"].includes(String(extras[0]))
      )
    ) {
      fail(
        `节点 ${node.id}（${node.type}）有 ${extras.length} 个无法识别的额外控件，可能使用了动态插件控件`,
      );
    }
  } else {
    fail(`节点 ${node.id}（${node.type}）的 widgets_values 格式不受支持`);
  }
  for (const spec of specs) {
    const key = `${node.id}\0${spec.name}`;
    if (overrides.has(key)) {
      if (!isWidget(spec))
        fail(
          `节点 ${node.id}（${node.type}）子图代理 ${spec.name} 不是普通控件`,
        );
      const value = overrides.get(key);
      validateWidget(node, spec, value);
      result[spec.name] = apiLiteral(value);
    }
  }
  // Object-valued widgets can omit optional fields, but may not lose required ones.
  for (const spec of specs.filter(
    (entry) => isWidget(entry) && entry.required,
  )) {
    if (
      !(spec.name in result) &&
      !node.inputs?.some((port) => port.name === spec.name && port.link != null)
    ) {
      fail(`节点 ${node.id}（${node.type}）缺少必填控件 ${spec.name}`);
    }
  }
  if (verifyNamedArrayOrder && Array.isArray(node.widgets_values) && record(node.widgets_values_named)) {
    const anonymous = widgets({ ...node, widgets_values_named: undefined }, originalSpecs, overrides);
    if (Object.keys(anonymous).length !== Object.keys(result).length || Object.entries(result).some(([name, value]) =>
        !Object.hasOwn(anonymous, name) || JSON.stringify(anonymous[name]) !== JSON.stringify(value)))
      fail(`节点 ${node.id} 的具名控件快照与当前节点定义的控件顺序不一致`);
  }
  return result;
}

function parseLink(value: unknown): Link {
  let id: unknown,
    origin: unknown,
    slot: unknown,
    target: unknown,
    targetSlot: unknown,
    type: unknown;
  if (Array.isArray(value) && value.length >= 5)
    [id, origin, slot, target, targetSlot, type] = value;
  else if (record(value))
    ({
      id,
      origin_id: origin,
      origin_slot: slot,
      target_id: target,
      target_slot: targetSlot,
      type,
    } = value);
  else fail("工作流存在无效连线记录");
  if (
    ![id, origin, target].every(
      (v) => typeof v === "number" || typeof v === "string",
    ) ||
    !Number.isInteger(slot) ||
    Number(slot) < 0 ||
    !Number.isInteger(targetSlot) ||
    Number(targetSlot) < 0
  ) {
    fail("工作流存在无效的连线编号或插槽");
  }
  return {
    id: String(id),
    origin: String(origin),
    slot: Number(slot),
    target: String(target),
    targetSlot: Number(targetSlot),
    type,
  };
}

function ports(node: EditorNode): Port[] {
  if (node.inputs === undefined) return [];
  if (
    !Array.isArray(node.inputs) ||
    node.inputs.some((p) => !record(p) || typeof p.name !== "string")
  )
    fail(`节点 ${node.id}（${node.type}）输入端口格式不受支持`);
  return node.inputs;
}

function nodeKey(context: Context, node: EditorNode): string {
  return context.prefix + node.id;
}
function isVirtual(node: EditorNode): boolean {
  return virtualTypes.has(node.type) || everywhereTypes.has(node.type);
}
function isLive(node: EditorNode): boolean {
  return node.mode !== 2 && node.mode !== 4;
}
function namedValue(node: EditorNode): unknown {
  if (Array.isArray(node.widgets_values)) return node.widgets_values[0];
  if (record(node.widgets_values))
    return node.widgets_values.name ?? node.widgets_values.value;
  return undefined;
}

/** Convert one editor file using exact live/cached schemas or its named saved metadata. */
export function convertEditorWorkflow(
  value: unknown,
  info: Record<string, unknown> = {},
  outputNodeId?: string | string[],
): { graph: ApiWorkflow; warnings: string[]; objectInfo: Record<string, unknown> } {
  if (detectWorkflowFormat(value) !== "editor")
    throw new Error("此文件已经是 API 格式，无需编辑器转换。");
  const raw = object(value, "工作流");
  const root = record(raw.prompt) ? raw.prompt : raw;
  const suppliedInfo = info;
  info = editorWorkflowObjectInfo(value, info);
  const warnings: string[] = [];
  const definitions = editorSubgraphs(root, info);
  const pending: { context: Context; node: EditorNode }[] = [];
  const graph: ApiWorkflow = {};
  const contracts = new Map<string, Spec[]>();
  const owners = new Map<string, { context: Context; node: EditorNode }>();
  const executionVirtual = (node: EditorNode) =>
    isVirtual(node) &&
    !(
      record(info[node.type]) &&
      (info[node.type] as RecordValue).output_node === true
    );

  function expand(
    editor: RecordValue,
    prefix: string,
    parent?: Context,
    instance?: EditorNode,
    ancestry: string[] = [],
  ): Context {
    if (!Array.isArray(editor.nodes))
      fail(`子图 ${prefix || "根图"} 缺少节点列表`);
    const context: Context = {
      graph: editor,
      prefix,
      parent,
      instance,
      ancestry,
      nodes: new Map(),
      links: new Map(),
      children: new Map(),
      overrides: new Map(),
    };
    for (const rawNode of editor.nodes) {
      if (
        !record(rawNode) ||
        !["number", "string"].includes(typeof rawNode.id) ||
        typeof rawNode.type !== "string"
      )
        fail("工作流包含无效节点");
      const node = rawNode as EditorNode;
      if (context.nodes.has(String(node.id)))
        fail(`节点编号 ${prefix}${node.id} 重复`);
      context.nodes.set(String(node.id), node);
    }
    const links = editor.links ?? [];
    if (!Array.isArray(links))
      fail(`子图 ${prefix || "根图"} 连线列表格式不受支持`);
    for (const rawLink of links) {
      const link = parseLink(rawLink);
      if (context.links.has(link.id)) fail(`连线编号 ${prefix}${link.id} 重复`);
      context.links.set(link.id, link);
    }
    if (instance) {
      if (Array.isArray(editor.__canvas_legacy_proxies)) {
        const schema = object(editor.__canvas_legacy_schema, "旧版组节点输入定义");
        const specs = inputSpecs(instance, { [instance.type]: schema });
        const values = widgets(instance, specs, parent?.overrides ?? new Map());
        const declaredInputs = editor.inputs as RecordValue[];
        const instanceInputs = ports(instance);
        if (instanceInputs.length !== declaredInputs.length || instanceInputs.some((port, index) => port.name !== declaredInputs[index].name)) fail(`旧版组节点 ${prefix} 的外部插槽与保存的节点定义不一致`);
        for (const rawProxy of editor.__canvas_legacy_proxies) {
          const proxy = rawProxy as [number, string, string];
          if (Object.hasOwn(values, proxy[2])) context.overrides.set(`${proxy[0]}\0${proxy[1]}`, values[proxy[2]]);
        }
        return context;
      }
      const properties = record(instance.properties) ? instance.properties : {};
      const proxies = properties.proxyWidgets ?? [];
      const values = instance.widgets_values ?? [];
      if (
        !Array.isArray(proxies) ||
        !Array.isArray(values) ||
        proxies.length !== values.length
      )
        fail(`子图 ${nodeKey(parent!, instance)} 的代理控件无法对应`);
      const inherited = new Map<number, unknown>();
      for (const [key, value] of parent?.overrides ?? []) {
        const marker = `${instance.id}\0`;
        if (!key.startsWith(marker)) continue;
        const name = key.slice(marker.length);
        const declarations = Array.isArray(instance.widgets) ? instance.widgets : [];
        const matches = proxies.flatMap((proxy, index) => {
          const declaration = declarations[index];
          const declaredName = record(declaration) && typeof declaration.name === "string" ? declaration.name : Array.isArray(proxy) ? proxy[1] : undefined;
          return declaredName === name ? [index] : [];
        });
        if (matches.length !== 1) fail(`子图 ${prefix} 的父级代理控件 ${name} 无法唯一对应内部控件`);
        inherited.set(matches[0], value);
      }
      for (let index = 0; index < proxies.length; index++) {
        const proxy = proxies[index];
        if (
          !Array.isArray(proxy) ||
          proxy.length !== 2 ||
          !["string", "number"].includes(typeof proxy[0]) ||
          typeof proxy[1] !== "string"
        )
          fail(`子图 ${prefix} 包含不受支持的代理控件`);
        const key = `${proxy[0]}\0${proxy[1]}`;
        if (context.overrides.has(key))
          fail(`子图 ${prefix} 重复代理控件 ${proxy[1]}`);
        context.overrides.set(key, inherited.has(index) ? inherited.get(index) : values[index]);
      }
    }
    return context;
  }
  const top = expand(root, "");

  function childGraph(context: Context, node: EditorNode): Context | undefined {
    const definition = definitions.get(node.type);
    if (!definition) return undefined;
    const existing = context.children.get(String(node.id));
    if (existing) return existing;
    if (context.ancestry.includes(node.type))
      fail(`子图 ${nodeKey(context, node)} 存在递归定义`);
    const child = expand(
      definition,
      `${nodeKey(context, node)}:`,
      context,
      node,
      [...context.ancestry, node.type],
    );
    context.children.set(String(node.id), child);
    return child;
  }

  function prepare(context: Context, node: EditorNode): void {
    if (!isLive(node) || executionVirtual(node)) return;
    const key = nodeKey(context, node);
    const existing = owners.get(key);
    if (existing && (existing.context !== context || existing.node !== node)) fail(`展开后的节点编号 ${key} 不唯一`);
    if (existing) return;
    if (/Everywhere/i.test(node.type))
      fail(`节点 ${node.id}（${node.type}）的特殊隐式传播规则暂不受支持`);
    const specs = inputSpecs(node, info);
    const inputs = widgets(node, specs, context.overrides, !!suppliedInfo[node.type]);
    contracts.set(key, specs);
    owners.set(key, { context, node });
    graph[key] = {
      class_type: node.type,
      inputs,
      _meta: { title: typeof node.title === "string" ? node.title : node.type },
    };
    pending.push({ context, node });
    if (!suppliedInfo[node.type] && node.type === "CR Prompt Text")
      warnings.push(
        `节点 ${key} 的 CR Prompt Text 使用已知单提示词输入定义，云端仍需注册该节点。`,
      );
    else if (!suppliedInfo[node.type] && nodeSchema(node, info)?.__canvas_from_editor === true) warnings.push(`节点 ${key}（${node.type}）已按本文件保存的具名控件与端口还原执行参数；服务端仍需具备该节点。`);
  }

  function output(
    context: Context,
    id: string,
    slot: number,
    stack: Set<string>,
  ): Resolved {
    const key = `${context.prefix}${id}\0${slot}`;
    if (stack.has(key)) fail(`连线 ${context.prefix}${id} 存在循环或递归旁路`);
    const chain = new Set(stack).add(key);
    const inputNodeId = record(context.graph.inputNode)
      ? context.graph.inputNode.id
      : -10;
    if (context.parent && id === String(inputNodeId)) {
      const inputs = context.graph.inputs;
      const external = Array.isArray(inputs) ? inputs[slot] : undefined;
      if (!record(external) || typeof external.name !== "string")
        fail(`子图 ${context.prefix} 输入插槽 ${slot} 缺少定义`);
      const matches = ports(context.instance!).filter(
        (port) => port.name === external.name,
      );
      if (matches.length > 1)
        fail(`子图 ${context.prefix} 输入 ${external.name} 不唯一`);
      const port = matches[0];
      if (port?.link != null)
        return linked(context.parent, port.link, chain, context.instance, port);
      const override = context.overrides.get(`-1\0${external.name}`) ?? missing;
      if (override !== missing)
        return { value: apiLiteral(override), type: external.type };
      return { value: missing, type: external.type };
    }
    const node = context.nodes.get(id);
    if (!node) fail(`找不到连线源节点 ${context.prefix}${id}`);
    if (node.mode === 2) return { value: missing };
    const outputType = node.outputs?.[slot]?.type;
    if (node.type === "Reroute" || node.type === "SetNode" || node.mode === 4) {
      const candidates = ports(node).filter(
        (port) =>
          port.link != null &&
          (node.type === "Reroute" ||
            node.type === "SetNode" ||
            port.type === outputType),
      );
      if (candidates.length !== 1)
        fail(
          `节点 ${nodeKey(context, node)}（${node.type}）旁路插槽 ${slot} 没有唯一同类型输入`,
        );
      return linked(context, candidates[0].link, chain, node, candidates[0]);
    }
    if (node.type === "GetNode") {
      const name = namedValue(node);
      if (typeof name !== "string" || !name)
        fail(`节点 ${nodeKey(context, node)} 的命名连接缺少名称`);
      const setters = [...context.nodes.values()].filter(
        (candidate) =>
          candidate.type === "SetNode" &&
          candidate.mode !== 2 &&
          namedValue(candidate) === name,
      );
      if (setters.length !== 1) fail(`命名连接 ${name} 找不到唯一 SetNode`);
      return output(context, String(setters[0].id), 0, chain);
    }
    if (["PrimitiveNode", "PrimitiveNodeValue"].includes(node.type)) {
      const literal = context.overrides.has(`${node.id}\0value`) ? context.overrides.get(`${node.id}\0value`) : namedValue(node);
      if (literal === undefined)
        fail(`Primitive 节点 ${nodeKey(context, node)} 缺少保存值`);
      return { value: apiLiteral(literal), type: outputType };
    }
    const child = childGraph(context, node);
    if (child) {
      const outputNodeId = record(child.graph.outputNode)
        ? child.graph.outputNode.id
        : -20;
      const candidates = [...child.links.values()].filter(
        (link) =>
          link.target === String(outputNodeId) && link.targetSlot === slot,
      );
      const unique = new Map(
        candidates.map((link) => [`${link.origin}\0${link.slot}`, link]),
      );
      if (unique.size !== 1)
        fail(`子图 ${nodeKey(context, node)} 输出插槽 ${slot} 没有唯一连接`);
      return linked(child, [...unique.values()][0].id, chain);
    }
    if (executionVirtual(node))
      fail(
        `前端节点 ${nodeKey(context, node)}（${node.type}）不能提供执行输出`,
      );
    prepare(context, node);
    const schema = nodeSchema(node, info);
    const outputs =
      record(schema) && Array.isArray(schema.output)
        ? schema.output
        : undefined;
    if (outputs && slot >= outputs.length)
      fail(`节点 ${nodeKey(context, node)} 输出插槽 ${slot} 超出云端定义`);
    return {
      value: [nodeKey(context, node), slot],
      type:
        outputType && outputType !== "*"
          ? outputType
          : (outputs?.[slot] ?? outputType),
    };
  }

  function linked(
    context: Context,
    linkId: unknown,
    stack = new Set<string>(),
    targetNode?: EditorNode,
    port?: Port,
  ): Resolved {
    const link = context.links.get(String(linkId));
    if (!link) fail(`找不到连线 ${context.prefix}${String(linkId)}`);
    if (
      targetNode &&
      (link.target !== String(targetNode.id) ||
        (port && ports(targetNode)[link.targetSlot] !== port))
    )
      fail(`连线 ${context.prefix}${link.id} 与输入端口不一致`);
    const result = output(context, link.origin, link.slot, stack);
    return { ...result, type: result.type ?? link.type };
  }

  const broadcastCache = new Map<string, Map<string, Resolved>>();
  function broadcastsFor(
    context: Context,
    wanted: string,
  ): Map<string, Resolved> {
    const identity = context.prefix + "\0" + wanted;
    const cached = broadcastCache.get(identity);
    if (cached) return cached;
    const matches = new Map<string, Resolved>();
    for (const node of context.nodes.values()) {
      if (!isLive(node) || !/Everywhere/i.test(node.type)) continue;
      const candidates = ports(node).filter((port) => {
        if (port.link == null) return false;
        const link = context.links.get(String(port.link));
        if (!link)
          fail(`找不到隐式传播连线 ${context.prefix}${String(port.link)}`);
        const source = context.nodes.get(link.origin);
        const schema = source ? nodeSchema(source, info) : undefined;
        const outputs =
          schema && Array.isArray(schema.output) ? schema.output : [];
        const declared = source?.outputs?.[link.slot]?.type;
        const type =
          declared && declared !== "*"
            ? declared
            : (link.type ?? outputs[link.slot]);
        return type === wanted || type === "*" || type === undefined;
      });
      if (!candidates.length) continue;
      if (!everywhereTypes.has(node.type))
        fail(
          `节点 ${nodeKey(context, node)}（${node.type}）的特殊隐式传播规则暂不受支持`,
        );
      const properties = record(node.properties) ? node.properties : {};
      const ue = record(properties.ue_properties)
        ? properties.ue_properties
        : properties;
      const restriction = Object.entries(ue).find(
        ([name, v]) =>
          (/regex$/.test(name) && v != null && v !== "" && v !== ".*") ||
          ([
            "group_restricted",
            "color_restricted",
            "priority",
            "repeated_type_rule",
            "send_to_any",
            "string_to_combo",
          ].includes(name) &&
            Boolean(v)),
      );
      const restrictedWidgets =
        Array.isArray(node.widgets_values) &&
        node.widgets_values.some((v) => v != null && v !== "" && v !== ".*");
      if (restriction || restrictedWidgets)
        fail(
          `节点 ${nodeKey(context, node)}（${node.type}）使用了筛选或优先级传播规则，不能按唯一类型补线`,
        );
      for (const port of candidates) {
        const resolved = linked(context, port.link, new Set(), node, port);
        if (resolved.value === missing) continue;
        const type = resolved.type === "*" ? port.type : resolved.type;
        if (typeof type !== "string" || type === "*")
          fail(
            `节点 ${nodeKey(context, node)} 隐式传播输入 ${port.name} 缺少确定类型`,
          );
        if (type === wanted)
          matches.set(JSON.stringify(resolved.value), resolved);
      }
    }
    broadcastCache.set(identity, matches);
    return matches;
  }
  const outputs = editorWorkflowOutputs(value, info);
  const selected =
    outputNodeId === undefined
      ? outputs.length ? outputs.map(output => output.nodeId) : undefined
      : [
          ...new Set(
            Array.isArray(outputNodeId) ? outputNodeId : [outputNodeId],
          ),
        ];
  if (
    selected &&
    (!selected.length || selected.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("请选择至少一个工作流输出节点。");
  function selectedTargets(context: Context, selectedId: string): { context: Context; node: EditorNode }[] {
    const matches: { context: Context; node: EditorNode }[] = [];
    for (const node of context.nodes.values()) {
      if (!isLive(node)) continue;
      const key = nodeKey(context, node);
      if (key === selectedId) matches.push({ context, node });
      if (definitions.has(node.type) && selectedId.startsWith(key + ":")) {
        const child = childGraph(context, node);
        if (child) matches.push(...selectedTargets(child, selectedId));
      }
    }
    return matches;
  }
  if (selected) {
    for (const selectedId of selected) {
      const matches = selectedTargets(top, selectedId);
      if (matches.length > 1) fail(`展开后的输出编号 ${selectedId} 不唯一`);
      const chosen = matches[0], target = chosen?.node;
      if (!target || executionVirtual(target))
        throw new Error("所选输出节点不存在或已禁用。");
      if (definitions.has(target.type)) output(chosen.context, String(target.id), 0, new Set());
      else prepare(chosen.context, target);
    }
  } else {
    // No supported save node: retain structural conversion for diagnostics.
    for (const node of top.nodes.values()) {
      if (!isLive(node) || executionVirtual(node)) continue;
      if (definitions.has(node.type))
        output(top, String(node.id), 0, new Set());
      else prepare(top, node);
    }
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { context, node } = pending[cursor];
    const key = nodeKey(context, node);
    const target = graph[key];
    if (!target) continue;
    const specs = contracts.get(key)!;
    const inputPorts = ports(node);
    const seen = new Set<string>();
    for (const port of inputPorts) {
      if (seen.has(port.name))
        fail(`节点 ${key}（${node.type}）重复输入端口 ${port.name}`);
      seen.add(port.name);
      if (port.link == null) continue;
      const spec = specs.find((entry) => entry.name === port.name);
      if (!spec)
        fail(`节点 ${key}（${node.type}）动态输入 ${port.name} 没有云端定义`);
      const resolved = linked(context, port.link, new Set(), node, port);
      if (resolved.value !== missing)
        target.inputs[port.name] = structuredClone(resolved.value);
      else if (spec.required && !(port.name in target.inputs))
        fail(
          `节点 ${key}（${node.type}）必填输入 ${port.name} 依赖已禁用节点或未提供的子图输入`,
        );
      else if (!(port.name in target.inputs))
        warnings.push(
          `节点 ${key} 的可选输入 ${port.name} 连接已禁用节点，已省略。`,
        );
    }
    const properties = record(node.properties) ? node.properties : {};
    const ue = record(properties.ue_properties) ? properties.ue_properties : {};
    const blocked = record(ue.input_ue_unconnectable)
      ? ue.input_ue_unconnectable
      : {};
    for (const spec of specs) {
      if (spec.name in target.inputs) continue;
      const port = inputPorts.find((entry) => entry.name === spec.name);
      const type = typeof spec.type === "string" ? spec.type : port?.type;
      const connectable =
        !properties.rejects_ue_links && !blocked[spec.name] && !isWidget(spec);
      const candidates =
        connectable && typeof type === "string"
          ? broadcastsFor(context, type)
          : undefined;
      if (candidates?.size && port?.link == null) {
        if (candidates.size !== 1)
          fail(
            `节点 ${key}（${node.type}）输入 ${spec.name} 的 ${type} 隐式连接有 ${candidates.size} 个来源，存在歧义`,
          );
        const candidate = [...candidates.values()][0];
        if (Array.isArray(candidate.value) && candidate.value[0] === key)
          fail(`节点 ${key} 隐式连接 ${spec.name} 会连接到自身`);
        target.inputs[spec.name] = structuredClone(candidate.value);
        warnings.push(
          `已还原 ${key}.${spec.name} 的 ${String(type)} 隐式连接。`,
        );
      }
      if (spec.required && !(spec.name in target.inputs))
        fail(`节点 ${key}（${node.type}）缺少必填输入 ${spec.name}`);
    }
  }
  if (!Object.keys(graph).length)
    throw new Error("工作流没有启用的可执行节点。");
  const done = new Set<string>();
  function visit(id: string, path: Set<string>): void {
    if (path.has(id)) fail(`API 连线在节点 ${id} 构成循环`);
    if (done.has(id)) return;
    const current = graph[id];
    if (!current) fail(`转换后的连线指向不存在的节点 ${id}`);
    const next = new Set(path).add(id);
    for (const value of Object.values(current.inputs)) {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        Number.isInteger(value[1])
      )
        visit(value[0], next);
    }
    done.add(id);
  }
  Object.keys(graph).forEach((id) => visit(id, new Set()));
  return { graph, warnings: [...new Set(warnings)], objectInfo: info };
}
