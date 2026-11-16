type Data = Record<string, unknown>;
type Kind = "image" | "video" | "audio" | "text";
type Edge = { id: string; field: string };
type Node = {
  id: string;
  type: string;
  raw: Data;
  values: Data;
  deps: Edge[];
  kinds: Kind[];
  outputKind?: Kind;
  enabled: boolean;
};
type Family = { label: string; kind: Kind };

const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const compact = (value: string) => value.toLowerCase().replace(/[\s_.\-/\\]+/g, "");
const modelFile = (value: unknown): value is string => typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value);
const modelField = (field: string) => /^(?:model|model_name|model_path|model_file|unet|unet_name|unet_path|gguf_name|ckpt_name|checkpoint|checkpoint_name|diffusion_model|diffusion_model_name|dit|dit_name|transformer|transformer_name|weight|weights|weight_name)$/i.test(field);
const auxiliary = (type: string) => /clip|textencoder|textencode|vae|lora|controlnet|vision|whisper|embedding|ipadapter|samloader|sammodel|ultralytics|segmentation|detection|prompt(?:loader|reader|input|text|string)|(?:text|string)(?:loader|reader|input|box|literal)/i.test(type) && !/checkpoint/i.test(type);
const loader = (type: string) => /load|checkpoint|unet|diffusionmodel|transformer/i.test(type);
const helper = (type: string) => /^(?:Note|MarkdownNote|PrimitiveNode|PrimitiveNodeValue|CR Prompt Text)$/.test(type) || /(?:Groups? (?:Muter|Bypasser)|Groups?(?:Muter|Bypasser))/.test(type);
const mediaTool = (value: string) => /upscale|superresolution|seedvr|flashvsr|realesrgan|esrgan|swinir/i.test(value);

function family(value: string): Family | undefined {
  const key = compact(value);
  const image = (label: string): Family => ({ label, kind: "image" });
  const video = (label: string): Family => ({ label, kind: "video" });
  if (/minimaxmusic|music3/.test(key)) return { label: "MiniMax Music", kind: "audio" };
  if (/voxcpm/.test(key)) return { label: "VoxCPM", kind: "audio" };
  if (/minimaxh3|^h3(?:fl2|ref2|t2|i2|turbo|image|video|audio)/.test(key)) return video("MiniMax H3 标准");
  if (/bernini/.test(key)) return video("Bernini");
  if (/ltx.*msr|msr.*ltx/.test(key)) return video("LTX MSR");
  if (/ltx.*2[.]?3/.test(value.toLowerCase().replace(/[\s_\-]+/g, ""))) return video("LTX2.3");
  if (/ltx.*2[.]?5/.test(value.toLowerCase().replace(/[\s_\-]+/g, ""))) return video("LTX2.5");
  if (/ltx/.test(key)) return video("LTX");
  if (/scail/.test(key)) return video("Scail");
  if (/remix/.test(key)) return video("Remix");
  if (/flashvsr/.test(key)) return video("视频超分工具");
  if (/wan(?:2|video|image|first|last)/.test(key)) return video("Wan");
  if (/hunyuanvideo/.test(key)) return video("Hunyuan Video");
  if (/qwenimage|imageqwen/.test(key)) return image("Qwen 图像");
  if (/klein/.test(key)) return image("Klein 系列");
  if (/krea2/.test(key)) return image("Krea2");
  if (/zimage|zimg/.test(key)) return image("Zimage");
  return undefined;
}

function mediaType(value: unknown): Kind | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.toUpperCase();
  return key === "IMAGE" || key === "MASK" ? "image" : key === "VIDEO" ? "video" : key === "AUDIO" ? "audio" : key === "STRING" ? "text" : undefined;
}

function savedKind(type: string): Kind | undefined {
  if (/SaveVideo|VideoCombine|VideoWriter|PreviewVideo/i.test(type)) return "video";
  if (/SaveAudio|PreviewAudio|AudioWriter/i.test(type)) return "audio";
  if (/SaveImage|PreviewImage|ImageWriter/i.test(type)) return "image";
  if (/TextWriter|WriteText|SaveText|ShowText|showAnything/i.test(type)) return "text";
  return undefined;
}

function kindFromType(type: string): Kind | undefined {
  if (/video|frames|animation/i.test(type)) return "video";
  if (/audio|speech|voice|music|tts/i.test(type)) return "audio";
  if (/image|img2img|inpaint/i.test(type)) return "image";
  return undefined;
}

function schemaFor(raw: Data, type: string, graph: Data): Data {
  const properties = record(raw.properties) ? raw.properties : {};
  const extra = record(graph.extra) ? graph.extra : {};
  for (const candidate of [raw.node_def, properties.node_def, properties.node_definition,
    record(graph.object_info) ? graph.object_info[type] : undefined,
    record(extra.object_info) ? extra.object_info[type] : undefined]) {
    if (record(candidate)) return candidate;
  }
  return {};
}

function node(raw: Data, id: string, type: string, graph: Data): Node {
  const enabled = raw.mode !== 2 && raw.mode !== 4 && !helper(type);
  const schema = schemaFor(raw, type, graph);
  const ports = [...(Array.isArray(raw.inputs) ? raw.inputs : []), ...(Array.isArray(raw.outputs) ? raw.outputs : [])];
  const input = record(schema.input) ? schema.input : {};
  const specs = { ...(record(input.required) ? input.required : {}), ...(record(input.optional) ? input.optional : {}) };
  const kinds = [...new Set([...ports.filter(record).map(port => mediaType(port.type)),
    ...(Array.isArray(schema.output) ? schema.output.map(mediaType) : []),
    ...Object.values(specs).map(spec => mediaType(Array.isArray(spec) ? spec[0] : undefined))].filter((kind): kind is Kind => !!kind))];
  const mediaKinds = kinds.filter(kind => kind !== "text");
  const outputKind = enabled ? savedKind(type) ?? (schema.output_node === true ? (mediaKinds.length === 1 ? mediaKinds[0] : kinds.length === 1 ? kinds[0] : undefined) : undefined) : undefined;
  const values = record(raw.inputs) ? raw.inputs : record(raw.widgets_values) ? raw.widgets_values : {};
  return { id, type, raw, values, deps: [], kinds, outputKind, enabled };
}

/** Read execution nodes only; prompt text, titles and unused subgraph definitions are not model evidence. */
function nodesFrom(source: unknown): Map<string, Node> {
  const nodes = new Map<string, Node>();
  if (!record(source)) return nodes;
  let graph = record(source.prompt) && typeof source.prompt.class_type !== "string" ? source.prompt : source;
  const api = Object.entries(graph).filter((entry): entry is [string, Data] => record(entry[1]) && typeof entry[1].class_type === "string" && record(entry[1].inputs));
  if (api.length) {
    for (const [id, raw] of api) nodes.set(id, node(raw, id, String(raw.class_type), source));
    const connections = (value: unknown, field: string, deps: Edge[]) => {
      if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && Number.isInteger(value[1]) && nodes.has(String(value[0]))) deps.push({ id: String(value[0]), field });
      else if (Array.isArray(value)) value.forEach(item => connections(item, field, deps));
      else if (record(value)) Object.values(value).forEach(item => connections(item, field, deps));
    };
    for (const item of nodes.values()) for (const [field, value] of Object.entries(item.values)) connections(value, field, item.deps);
    return nodes;
  }
  if (!Array.isArray(graph.nodes) && record(graph.workflow)) graph = graph.workflow;
  const definitions = new Map<string, Data>();
  function definitionsFrom(editor: Data) {
    if (record(editor.definitions) && Array.isArray(editor.definitions.subgraphs)) for (const definition of editor.definitions.subgraphs.filter(record)) definitions.set(String(definition.id), definition);
    const groups = record(editor.extra) && record(editor.extra.groupNodes) ? editor.extra.groupNodes : {};
    for (const [name, definition] of Object.entries(groups)) if (record(definition)) { definitions.set("workflow>" + name, definition); definitions.set("workflow/" + name, definition); }
  }
  definitionsFrom(graph);
  function collect(editor: Data, prefix: string, ancestry: Set<Data>, parent?: Node, legacy = false): string[] {
    if (!Array.isArray(editor.nodes) || ancestry.has(editor)) return [];
    definitionsFrom(editor);
    const chain = new Set(ancestry).add(editor);
    const ids = new Set<string>();
    for (const [index, raw] of editor.nodes.entries()) {
      if (!record(raw) || typeof raw.type !== "string" || raw.mode === 2) continue;
      const id = prefix + String(legacy ? index : raw.id ?? index);
      ids.add(id);
      nodes.set(id, node(raw, id, raw.type, editor));
    }
    for (const link of Array.isArray(editor.links) ? editor.links : []) {
      const parts = Array.isArray(link) ? (legacy ? [undefined, link[0], link[1], link[2], link[3]] : link) : record(link) ? [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot] : [];
      if (parts.length < 5) continue;
      const origin = prefix + String(parts[1]), target = prefix + String(parts[3]);
      const destination = nodes.get(target);
      const inputId = String(record(editor.inputNode) ? editor.inputNode.id : -10);
      const outputId = String(record(editor.outputNode) ? editor.outputNode.id : -20);
      if (parent && String(parts[3]) === outputId && nodes.has(origin)) parent.deps.push({ id: origin, field: "subgraph" });
      if (!destination) continue;
      const ports = Array.isArray(destination.raw.inputs) ? destination.raw.inputs : [];
      const port = ports[Number(parts[4])];
      const field = record(port) && typeof port.name === "string" ? port.name : "input";
      if (nodes.has(origin)) destination.deps.push({ id: origin, field });
      else if (parent && String(parts[1]) === inputId) destination.deps.push(...parent.deps.map(edge => ({ ...edge, field })));
    }
    for (const id of ids) {
      const instance = nodes.get(id)!;
      if (!instance.enabled) continue;
      const inline = record(instance.raw.subgraph) ? instance.raw.subgraph : undefined;
      const definition = definitions.get(instance.type) ?? inline;
      if (!definition) continue;
      const children = collect(definition, id + ":", chain, instance, /^workflow[>/]/.test(instance.type));
      if (!instance.deps.some(edge => edge.field === "subgraph")) {
        // Legacy groups lack formal output nodes. Keep their actual terminal nodes as evidence.
        const used = new Set(children.flatMap(child => nodes.get(child)?.deps.map(edge => edge.id) ?? []));
        instance.deps.push(...children.filter(child => !used.has(child)).map(child => ({ id: child, field: "subgraph" })));
      }
      instance.type = "";
    }
    return [...ids];
  }
  collect(graph, "", new Set());
  // Named Set/Get nodes establish an explicit editor connection, even without a visible wire.
  const alias = (item: Node): string | undefined => {
    const value = Array.isArray(item.raw.widgets_values) ? item.raw.widgets_values[0] : item.values.name ?? item.values.key ?? item.values.value;
    return typeof value === "string" ? value : undefined;
  };
  for (const item of nodes.values()) if (item.type === "GetNode" && item.enabled) {
    const name = alias(item);
    const setters = [...nodes.values()].filter(candidate => candidate.type === "SetNode" && candidate.enabled && name !== undefined && alias(candidate) === name);
    if (setters.length === 1) item.deps.push({ id: setters[0].id, field: "named connection" });
  }
  return nodes;
}

function modelValues(item: Node): string[] {
  if (!item.enabled || auxiliary(item.type)) return [];
  const result = Object.entries(item.values).filter(([field, value]) => modelField(field) && typeof value === "string").map(([, value]) => String(value));
  if (loader(item.type) && Array.isArray(item.raw.widgets_values)) result.push(...item.raw.widgets_values.filter(modelFile));
  const properties = record(item.raw.properties) ? item.raw.properties : {};
  if (Array.isArray(properties.models)) result.push(...properties.models.filter(record).map(model => model.name).filter((name): name is string => typeof name === "string"));
  return [...new Set(result)];
}

function generation(item: Node): boolean {
  if (!item.enabled || loader(item.type) || auxiliary(item.type) || savedKind(item.type) || mediaTool(item.type)) return false;
  return /sampler|generate|generator|textto(?:image|video|audio)|imageto(?:image|video)|referencetovideo|voxcpm|music.*encode/i.test(compact(item.type)) || modelValues(item).length > 0;
}

function ancestors(ids: string[], nodes: Map<string, Node>): Node[] {
  const found = new Set<string>(), queue = [...ids];
  for (let i = 0; i < queue.length; i++) {
    const item = nodes.get(queue[i]);
    if (!item || found.has(item.id)) continue;
    found.add(item.id); queue.push(...item.deps.map(edge => edge.id));
  }
  return [...found].map(id => nodes.get(id)!);
}

function nearestGenerators(start: Node, nodes: Map<string, Node>): Node[] {
  const found = new Set<string>(), queue = [start.id], result: Node[] = [];
  for (let i = 0; i < queue.length; i++) {
    const item = nodes.get(queue[i]);
    if (!item || found.has(item.id)) continue;
    found.add(item.id);
    if (generation(item)) result.push(item);
    else queue.push(...item.deps.map(edge => edge.id));
  }
  return result;
}

/** Samplers may receive a guider/settings bundle rather than a direct MODEL port. */
function generatorModelEvidence(start: Node, nodes: Map<string, Node>): Node[] {
  const evidence = new Map<string, Node>([[start.id, start]]), visited = new Set<string>();
  const carriers = [start];
  for (let index = 0; index < carriers.length; index++) {
    const item = carriers[index];
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    evidence.set(item.id, item);
    for (const edge of item.deps) {
      if (modelField(edge.field) || /model|unet|diffusion|transformer|checkpoint/i.test(edge.field)) {
        for (const ancestor of ancestors([edge.id], nodes)) evidence.set(ancestor.id, ancestor);
      } else if (/^(?:guider|sampler_inputs|sampler_settings|sampling_settings)$/i.test(edge.field)) {
        const carrier = nodes.get(edge.id);
        if (carrier?.enabled) carriers.push(carrier);
      }
    }
  }
  return [...evidence.values()];
}

function recognized(items: Node[], kind?: Kind): string | undefined {
  const models = items.flatMap(modelValues);
  const known = models.map(family).filter((item): item is Family => !!item && (!kind || item.kind === kind));
  // Main diffusion/checkpoint choices override shared encoders, LoRAs and descriptive nodes.
  const evidence = known.length ? known : models.length ? [] : items.filter(item => item.enabled && !auxiliary(item.type)).map(item => family(item.type)).filter((item): item is Family => !!item && (!kind || item.kind === kind));
  const labels = new Set(evidence.map(item => item.label));
  if (labels.size !== 1) return undefined;
  let label = [...labels][0];
  if (label === "MiniMax H3 标准") {
    const types = items.filter(item => item.enabled).map(item => compact(item.type));
    if (types.some(type => /minimaxh3sigmashift/.test(type))) label = "MiniMax H3 加速";
    else if (models.some(value => /turbo|distill|lightx2v/i.test(value))) label = "MiniMax H3 极速";
  }
  return label;
}

/** Actual generation weights on the saved branch, sharing API/editor/subgraph evidence. */
export function inferWorkflowModelNames(source: unknown, options: { kind?: string; outputNodeIds?: string[] } = {}): string[] {
  const nodes = nodesFrom(source);
  const outputs = [...nodes.values()].filter(item => item.outputKind);
  const hinted = mediaType(options.kind);
  const matching = hinted ? outputs.filter(item => item.outputKind === hinted) : [];
  const explicit = options.outputNodeIds?.map(id => nodes.get(id)).filter((item): item is Node => !!item && item.enabled) ?? [];
  const selected = explicit.length ? explicit : matching.length ? matching : outputs;
  const active = selected.length ? ancestors(selected.map(item => item.id), nodes) : [...nodes.values()];
  const generators = selected.length ? selected.flatMap(item => nearestGenerators(item, nodes)) : active.filter(generation);
  const evidence = generators.length ? generators.flatMap(item => generatorModelEvidence(item, nodes)) : active;
  return [...new Set(evidence.flatMap(modelValues))];
}

/** Pure directory classification for both ready API graphs and unresolved ordinary JSON files. */
export function inferWorkflowFamily(source: unknown, options: { name?: string; kind?: string } = {}): string {
  const nodes = nodesFrom(source);
  const outputs = [...nodes.values()].filter(item => item.outputKind);
  const hinted = mediaType(options.kind);
  const matchingOutputs = hinted ? outputs.filter(item => item.outputKind === hinted) : [];
  const selectedOutputs = matchingOutputs.length ? matchingOutputs : outputs;
  const active = selectedOutputs.length ? ancestors(selectedOutputs.map(item => item.id), nodes) : [...nodes.values()];
  const kinds = new Set(selectedOutputs.map(item => item.outputKind!));
  let kind: Kind | undefined = matchingOutputs.length ? hinted : kinds.size === 1 ? [...kinds][0] : kinds.size ? undefined : hinted;
  if (!kind && !kinds.size) {
    const families = active.filter(item => item.enabled).flatMap(item => [family(item.type), ...modelValues(item).map(family)]).filter((item): item is Family => !!item);
    const found = new Set(families.map(item => item.kind));
    if (found.size === 1) kind = [...found][0];
    else {
      const media = new Set(active.filter(item => item.enabled).flatMap(item => [...item.kinds, kindFromType(item.type)]).filter((item): item is Kind => !!item && item !== "text"));
      if (media.size === 1) kind = [...media][0];
      else if (!media.size && active.some(item => item.enabled && (/text|string|prompt|llm/i.test(item.type) || item.kinds.includes("text")))) kind = "text";
    }
  }
  const generators = selectedOutputs.length ? selectedOutputs.flatMap(item => nearestGenerators(item, nodes)) : active.filter(generation);
  const labels = generators.map(item => recognized(generatorModelEvidence(item, nodes), kind));
  if (labels.length && labels.every(label => label && label === labels[0])) return labels[0]!;
  if (!labels.length) {
    const label = recognized(active, kind);
    if (label) return label;
  }
  if (!kind) return "通用工具";
  if (kind === "text") return "文本工具";
  const models = active.flatMap(modelValues);
  const onlyToolModels = models.length > 0 && models.every(mediaTool);
  if (kind === "video" && active.some(item => item.enabled && /seedvr|flashvsr/i.test(item.type))) return "视频超分工具";
  const hasGeneration = !onlyToolModels && (generators.length > 0 || active.some(item => modelValues(item).length > 0 && !mediaTool(item.type)));
  if (kind === "video") return hasGeneration ? "视频生成" : "视频工具";
  if (kind === "audio") return hasGeneration ? "音频生成" : "音频工具";
  if (!hasGeneration) return "图像工具";
  return active.some(item => item.enabled && /loadimage|imageinput|imageedit|inpaint|img2img/i.test(item.type)) ? "图像编辑" : "图像生成";
}
