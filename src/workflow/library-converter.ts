import type { ApiWorkflow, Mapping, MediaInputPolicy, MediaKind, Mode, Parameter, WorkflowDefinition } from "../types";
import { validateDefinition } from "../workflow-adapter/adapter";
import { resolveWorkflowImportFamily } from "./import-category";
import { readImportEnvironmentReport } from "./import-environment-diagnostics";

type ObjectData = Record<string, unknown>;
export function workflowReaderProvenance(config: ObjectData): WorkflowDefinition["importReader"] {
  const raw = config.importReader;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = raw as ObjectData;
  if (value.repository !== "https://github.com/Work-Fisher/AIFISHER" || value.revision !== "bdcf3bec054594fcab591952a8c5acef858d6de4"
    || !["comfyui", "runninghub-workflow", "runninghub-webapp"].includes(String(value.environment))
    || typeof value.format !== "string" || typeof value.compileStatus !== "string") return;
  return { environment: value.environment as NonNullable<WorkflowDefinition["importReader"]>["environment"], repository: value.repository,
    revision: value.revision, format: value.format, compileStatus: value.compileStatus,
    ...(["image", "video", "audio", "motion"].includes(String(value.category)) ? { category: value.category as NonNullable<WorkflowDefinition["importReader"]>["category"] } : {}) };
}
function importedState(config: ObjectData): Pick<NonNullable<WorkflowDefinition["library"]>, "importStatus" | "diagnostics" | "environmentReport"> {
  const raw = config.importState && typeof config.importState === "object" && !Array.isArray(config.importState) ? config.importState as ObjectData : {};
  if (raw.status !== "pending" && raw.status !== "ready") return {};
  const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics.filter((value): value is ObjectData => !!value && typeof value === "object" && !Array.isArray(value)).filter(value => typeof value.message === "string").map(value => ({ code: typeof value.code === "string" ? value.code : "conversion-incomplete", message: String(value.message), ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}), ...(typeof value.classType === "string" ? { classType: value.classType } : {}), ...(typeof value.field === "string" ? { field: value.field } : {}) })) : [];
  const environmentReport = readImportEnvironmentReport(raw.environmentReport);
  return { importStatus: raw.status, diagnostics, ...(environmentReport ? { environmentReport } : {}) } as const;
}
const object = (value: unknown, label: string): ObjectData => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " 必须是对象。");
  return value as ObjectData;
};
const list = (value: unknown, label: string): ObjectData[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(label + " 必须是数组。");
  return value.map(item => object(item, label));
};
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " 缺失。");
  return value;
};
export function localized(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const labels = value as ObjectData;
    if (typeof labels["zh-CN"] === "string") return labels["zh-CN"];
    if (typeof labels["en-US"] === "string") return labels["en-US"];
  }
  return fallback;
}

export function apiGraph(value: unknown): ApiWorkflow {
  const raw = object(value, "执行文件");
  if ("nodes" in raw) throw new Error("执行文件为编辑器格式，需要 ComfyUI API 格式。");
  const nested = raw.prompt;
  const envelope = nested && typeof nested === "object" && !Array.isArray(nested) && !("class_type" in nested) && !("inputs" in nested);
  const graph = object(envelope ? nested : raw, "API 工作流");
  if (!Object.keys(graph).length) throw new Error("API 工作流为空。");
  for (const [id, value] of Object.entries(graph)) {
    const node = object(value, "API 节点 " + id);
    string(node.class_type, "节点类型 " + id);
    object(node.inputs, "节点输入 " + id);
  }
  return structuredClone(graph) as ApiWorkflow;
}

export type LibraryConversionSource = {
  sourcePath: string;
  folder: string;
  configSha256: string;
  executionSha256: string;
  executionStatus: "plain" | "encrypted" | "missing";
};

function mediaInputContract(config: ObjectData, id: string): Pick<WorkflowDefinition, "mediaInputMode" | "mediaInputPolicy"> {
  if (config.mediaInputMode !== undefined && config.mediaInputMode !== "schema" && config.mediaInputMode !== "explicit") throw new Error("素材输入模式无效。");
  // Earlier custom imports marked every loader required, including optional consumers.
  // Vendor configs keep their own contract unless they explicitly opt into schema inference.
  const mediaInputMode = config.mediaInputMode ?? (id.startsWith("custom.") ? "schema" : undefined);
  if (!mediaInputMode) return {};
  if (mediaInputMode === "explicit" || config.mediaInputPolicy === undefined) return { mediaInputMode };
  const raw = object(config.mediaInputPolicy, "素材输入规则");
  const strings = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(label + " 必须是文本数组。");
    return [...new Set(value as string[])];
  };
  const optionalSemantics = strings(raw.optionalSemantics, "可选素材");
  const removals = list(raw.removals, "可选素材连接").map(item => ({ semantic: string(item.semantic, "可选素材标识"), nodeId: string(item.nodeId, "可选素材目标"), field: string(item.field, "可选素材端口") }));
  const groups = list(raw.groups, "动态素材组").map(item => {
    if (!Number.isInteger(item.minimum) || Number(item.minimum) < 0) throw new Error("动态素材最少数量无效。");
    return { nodeId: string(item.nodeId, "动态素材目标"), label: string(item.label, "动态素材名称"), minimum: Number(item.minimum), fields: strings(item.fields, "动态素材端口"), ...(item.targets !== undefined ? { targets: strings(item.targets, "动态素材标识") } : {}) };
  });
  const mediaInputPolicy: MediaInputPolicy = { optionalSemantics, removals, groups };
  return { mediaInputMode, mediaInputPolicy };
}

/** Directory membership is determined by config, independently of execution support. */
export function createLibraryRegistration(
  rawConfig: unknown,
  rawRequirements: unknown,
  source: LibraryConversionSource,
  rawImportSource?: unknown,
): WorkflowDefinition {
  const config = object(rawConfig, "工作流配置");
  const id = string(config.id, "工作流 ID");
  if (!["image", "video", "audio", "text", "file"].includes(String(config.nodeKind))) throw new Error("不支持的输出类型：" + String(config.nodeKind));
  const kind = config.nodeKind as MediaKind;
  const records = (value: unknown): ObjectData[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
  const asObject = (value: unknown): ObjectData => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : {};
  const inputs = records(config.inputs);
  const inputSlots = inputs.filter(input => typeof input.id === "string" && ["image","video","audio"].includes(String(input.dataType))).map(input => ({semantic:"slot:" + input.id,label:localized(input.description,localized(input.name,String(input.id))),kind:input.dataType as "image" | "video" | "audio",required:input.required===true}));
  const parameters: Parameter[] = [];
  const parameterBindings: Record<string,unknown> = {};
  for (const item of records(config.parameters)) {
    if (typeof item.id !== "string") continue;
    if (item.binding !== undefined) parameterBindings[item.id] = item.binding;
    const types: Record<string,Parameter["type"]> = {integer:"number",float:"number",seed:"number",enum:"select",string:"text",boolean:"boolean"};
    const type = types[String(item.type)];
    if (!type || !scalar(item.defaultValue)) continue;
    const parameter: Parameter = {key:item.id,label:localized(item.label,item.id),type,default:item.defaultValue};
    if (item.type === "integer" || item.type === "float") parameter.numericType = item.type;
    for (const range of ["min","max","step"] as const) if (typeof item[range] === "number" && Number.isFinite(item[range])) parameter[range] = item[range];
    if (type === "select") {
      const options = records(item.options).filter(option => scalar(option.value));
      parameter.options = options.map(option => String(option.value));
      parameter.optionLabels = Object.fromEntries(options.map(option => [String(option.value),localized(option.label,String(option.value))]));
      parameter.optionValues = Object.fromEntries(options.map(option => [String(option.value),option.value as string | number | boolean]));
    }
    const ui = asObject(item.ui);
    parameter.secret = item.secret === true || ui.password === true;
    parameter.advanced = ui.placement === "advanced";
    parameter.multiline = type === "text" && ui.multiline === true;
    parameter.required = item.required === true;
    parameter.model = item.model === true;
    parameters.push(parameter);
  }
  const execution = asObject(config.execution);
  const prompt = asObject(config.prompt);
  const docsUrls = asObject(asObject(config.docs).localizedUrls);
  const requirements = asObject(rawRequirements);
  const models = records(requirements.items).filter(item => typeof item.name === "string" && item.name.trim()).map(item => ({name:String(item.name),...(typeof item.relativePath === "string" ? {relativePath:item.relativePath} : {}),...(typeof item.required === "boolean" ? {required:item.required} : {})}));
  const family = resolveWorkflowImportFamily(localized(config.primaryCategoryLabel, localized(config.primaryCategory)), id, rawImportSource,
    { name: localized(config.nameLabel, localized(config.name, id)), kind, models });
  const canvas = kind === "text" ? "text" : kind === "audio" ? "music" : kind === "video" ? "video" : "image";
  return {
    id:"library-" + encodeURIComponent(id),name:localized(config.nameLabel,localized(config.name,id)),family,description:localized(config.description),
    ...(workflowReaderProvenance(config) ? { importReader: workflowReaderProvenance(config) } : {}),
    ...(config.runnerType === "api" && typeof execution.model === "string" && execution.model.trim() ? { generationModels: [execution.model] } : {}),
    mode:inferMode(kind,inputs,asObject(config.dynamicInput).enabled===true),promptRequired:Boolean(prompt.binding) && prompt.required !== false,parameters,mapping:[],inputSlots,
    ...mediaInputContract(config,id),
    requiredInputs:inputSlots.filter(slot => slot.required).map(slot => slot.semantic),optionalInputs:inputSlots.filter(slot => !slot.required).map(slot => slot.semantic),
    output:{nodeId:"",field:"",kind},verification:"not-run",
    directory:{version:2,canvas,seriesId:"library-" + encodeURIComponent(family),bindingKey:id,bindingStatus:"pending"},
    library:{sourcePath:source.sourcePath,folder:source.folder,runnerType:typeof config.runnerType === "string" ? config.runnerType : "unknown",...importedState(config)},
    original:{id,version:localized(config.version),folder:source.folder,configFile:source.folder + "/workflow.config.json",configSha256:source.configSha256,
      executionFile:typeof execution.file === "string" ? execution.file : "",executionStatus:source.executionStatus,executionSha256:source.executionSha256,
      inputs:inputs.map(input => ({id:String(input.id ?? ""),name:localized(input.name,String(input.id ?? "")),dataType:String(input.dataType ?? ""),required:input.required===true,description:localized(input.description),binding:input.binding})),
      models,docsUrl:localized(docsUrls["zh-CN"],localized(docsUrls["en-US"])),promptPlaceholder:localized(config.promptPlaceholder),promptBinding:prompt.binding,parameterBindings},
  };
}

/** Config bindings are the contract. Labels never supply missing API connections. */
export function convertLibraryWorkflow(
  rawConfig: unknown,
  rawGraph: unknown,
  rawRequirements: unknown,
  source: LibraryConversionSource,
): WorkflowDefinition {
  const config = object(rawConfig, "工作流配置");
  if (importedState(config).importStatus === "pending") throw new Error("此普通工作流缺少完整的节点定义或参数，不能作为 API 工作流执行。");
  if (config.runnerType !== "comfyui") throw new Error("暂不支持 runnerType=" + String(config.runnerType) + "，此目录不会作为 ComfyUI 工作流执行。");
  const id = string(config.id, "工作流 ID");
  if (!["image", "video", "audio", "text", "file"].includes(String(config.nodeKind))) throw new Error("不支持的输出类型：" + String(config.nodeKind));
  const kind = config.nodeKind as MediaKind;
  const graph = apiGraph(rawGraph);
  const importReader = workflowReaderProvenance(config);
  const mapping: Mapping[] = [];
  const inputSlots: NonNullable<WorkflowDefinition["inputSlots"]> = [];
  const parameters: Parameter[] = [];
  const inputs = list(config.inputs, "素材输入");
  const parameterBindings: Record<string, unknown> = {};
  function bind(semantic: string, raw: unknown, media = false) {
    const binding = object(raw, "绑定 " + semantic);
    if (binding.target !== "comfyui" || typeof binding.path !== "string" || !/^inputs\..+$/.test(binding.path)) throw new Error("不支持的绑定路径：" + semantic);
    const nodeId = string(binding.nodeId, "绑定节点 " + semantic);
    const node = Object.hasOwn(graph, nodeId) ? graph[nodeId] : undefined;
    let field = binding.path.slice(7);
    // The source Qwen turnaround config declares text, but the actual API port is prompt.
    if (node?.class_type === "TextEncodeQwenImageEditPlus" && field === "text" && !(field in node.inputs) && "prompt" in node.inputs) field = "prompt";
    if (!node || !(field in node.inputs) || Array.isArray(node.inputs[field])) throw new Error("绑定目标不存在或覆盖节点连接：" + semantic + " → " + nodeId + "." + field);
    const item: Mapping = { semantic, nodeId, field };
    if (media && typeof node.inputs[field] !== "string") throw new Error("素材绑定必须指向文本文件字段：" + semantic);
    if (binding.pathMode !== undefined && (!media || binding.pathMode !== "comfy-input")) throw new Error("素材路径模式无效：" + semantic);
    if (media && ["Image Load", "VHS_LoadImagePath", "VHS_LoadVideoPath", "VHS_LoadAudio"].includes(node.class_type)) item.pathMode = "comfy-input";
    if (media && binding.pathMode === "comfy-input") item.pathMode = "comfy-input";
    mapping.push(item);
    return item;
  }
  const prompt = config.prompt === undefined ? undefined : object(config.prompt, "提示词配置");
  if (prompt?.binding) bind("prompt", prompt.binding);
  const seenParameters = new Set<string>();
  for (const item of list(config.parameters, "参数")) {
    const key = string(item.id, "参数 ID");
    if (seenParameters.has(key)) throw new Error("重复参数 ID：" + key);
    seenParameters.add(key);
    const types: Record<string, Parameter["type"]> = { integer: "number", float: "number", seed: "number", enum: "select", string: "text", boolean: "boolean" };
    const type = types[String(item.type)];
    if (!type || !scalar(item.defaultValue)) throw new Error("参数类型或默认值无效：" + key);
    if ((type === "number" && typeof item.defaultValue !== "number") || (type === "boolean" && typeof item.defaultValue !== "boolean") || (type === "text" && typeof item.defaultValue !== "string")) throw new Error("参数默认值类型不符：" + key);
    const ui = item.ui === undefined ? {} : object(item.ui, "参数界面");
    const parameter: Parameter = { key, label: localized(item.label, key), type, default: item.defaultValue, advanced: ui.placement === "advanced", ...(typeof item.required === "boolean" ? { required: item.required } : {}), secret: item.secret === true || ui.password === true, model: item.model === true };
    if (item.type === "integer" || item.type === "float") parameter.numericType = item.type;
    for (const range of ["min", "max", "step"] as const) {
      if (item[range] !== undefined) {
        if (typeof item[range] !== "number" || !Number.isFinite(item[range])) throw new Error("参数范围无效：" + key);
        parameter[range] = item[range];
      }
    }
    if (item.type === "seed" && typeof item.defaultValue === "number" && Number.isSafeInteger(item.defaultValue) && item.defaultValue >= 0) parameter.max = Math.max(parameter.max ?? item.defaultValue, item.defaultValue);
    if (type === "text") parameter.multiline = ui.multiline === true;
    if (type === "select") {
      const options = list(item.options, "枚举选项");
      if (!options.length || options.some(option => !scalar(option.value))) throw new Error("枚举选项无效：" + key);
      parameter.options = options.map(option => String(option.value));
      parameter.optionLabels = Object.fromEntries(options.map(option => [String(option.value), localized(option.label, String(option.value))]));
      parameter.optionValues = Object.fromEntries(options.map(option => [String(option.value), option.value as string | number | boolean]));
      if (!parameter.options.includes(String(item.defaultValue))) throw new Error("默认值不在枚举选项中：" + key);
    }
    bind(key, item.binding);
    parameterBindings[key] = item.binding;
    parameters.push(parameter);
  }
  const dynamic = config.dynamicInput === undefined ? undefined : object(config.dynamicInput, "动态输入");
  const dynamicReferences = dynamic?.enabled ? validateDynamic(dynamic, graph) : undefined;
  const inputIds = new Set<string>();
  for (const input of inputs) {
    const inputId = string(input.id, "素材 ID");
    if (inputIds.has(inputId)) throw new Error("重复素材 ID：" + inputId);
    inputIds.add(inputId);
    if (dynamicReferences) continue;
    const semantic = "slot:" + inputId;
    if (input.dataType === "text") {
      bind(semantic, input.binding);
      parameters.push({ key: semantic, label: localized(input.description, localized(input.name, inputId)), type: "text", default: "", multiline: true, required: input.required === true, inputText: true });
    } else {
      if (!["image", "video", "audio"].includes(String(input.dataType))) throw new Error("不支持的素材类型：" + String(input.dataType));
      const target = bind(semantic, input.binding, true);
      if (input.required === true && !importReader) graph[target.nodeId].inputs[target.field] = "";
      inputSlots.push({ semantic, label: localized(input.description, localized(input.name, inputId)), kind: input.dataType as "image" | "video" | "audio", required: input.required === true });
    }
  }
  const outputClasses: Record<string, { field: string; kind: string }> = {
    SaveImage: {field: "images", kind: "image"}, SaveVideo: {field: "images", kind: "video"},
    SaveImageAdvanced: {field: "images", kind: "image"},
    SaveAudio: {field: "audio", kind: "audio"}, SaveAudioMP3: {field: "audio", kind: "audio"}, SaveAudioAdvanced: {field: "audio", kind: "audio"},
    VHS_VideoCombine: {field: "gifs", kind: "video"},
  };
  if (kind === "text") outputClasses["easy showAnything"] = {field:"text",kind:"text"};
  const execution = object(config.execution, "执行配置");
  const automaticOutputs = Object.entries(graph).filter(([, node]) => outputClasses[node.class_type]);
  let outputBindings: WorkflowDefinition["output"][];
  const normalizeOutput = (raw: unknown): WorkflowDefinition["output"] => {
    const explicit = object(raw, "输出绑定");
    const nodeId = string(explicit.nodeId, "输出节点"), field = string(explicit.field, "输出 history 字段");
    const node = Object.hasOwn(graph, nodeId) ? graph[nodeId] : undefined;
    if (!node) throw new Error("输出绑定节点不存在：" + nodeId);
    if (!["image", "video", "audio", "text", "file"].includes(String(explicit.kind))) throw new Error("输出绑定类型无效：" + nodeId);
    if (node.class_type === "VHS_VideoCombine" && !importReader) node.inputs.save_output = true;
    return { nodeId, field, kind: explicit.kind as MediaKind, ...(!importReader && typeof node.inputs.filename_prefix === "string" ? { prefix: { nodeId, field: "filename_prefix" } } : {}) };
  };
  if (execution.outputs !== undefined) {
    outputBindings = list(execution.outputs, "输出绑定列表").map(normalizeOutput);
    if (!outputBindings.length) throw new Error("输出绑定列表不能为空。");
    if (execution.output !== undefined) {
      const main = normalizeOutput(execution.output), first = outputBindings[0];
      if (main.nodeId !== first.nodeId || main.field !== first.field || main.kind !== first.kind) throw new Error("主输出绑定必须与输出列表第一项一致。");
    }
  } else if (execution.output !== undefined) outputBindings = [normalizeOutput(execution.output)];
  else {
    if (automaticOutputs.length !== 1) throw new Error(automaticOutputs.length ? "存在多个保存输出节点，需要明确输出绑定，暂不自动选择。" : "未找到支持的保存输出节点，需要补齐输出绑定。");
    const [nodeId, node] = automaticOutputs[0];
    outputBindings = [normalizeOutput({ nodeId, ...outputClasses[node.class_type] })];
  }
  const seenOutputs = new Set<string>();
  for (const output of outputBindings) {
    const key = output.nodeId + "\0" + output.field;
    if (seenOutputs.has(key)) throw new Error("重复输出绑定：" + output.nodeId + "." + output.field);
    seenOutputs.add(key);
  }
  if (outputBindings[0].kind !== kind) throw new Error("配置输出类型与主输出绑定不符。");
  validateConnections(graph);
  const requirements = rawRequirements === undefined ? undefined : object(rawRequirements, "模型需求");
  const models = list(requirements?.items, "模型需求列表").map(item => ({ name: string(item.name, "模型名称"), ...(typeof item.relativePath === "string" ? { relativePath: item.relativePath } : {}), ...(typeof item.required === "boolean" ? { required: item.required } : {}) }));
  if (!requirements) {
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
      if (typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value) && !models.some(model => model.name === value)) models.push({name:value});
    }
  }
  const family = resolveWorkflowImportFamily(localized(config.primaryCategoryLabel, localized(config.primaryCategory)), id, graph,
    { name: localized(config.nameLabel, localized(config.name, id)), kind, models });
  const docs = config.docs === undefined ? {} : object(config.docs, "文档配置");
  const localizedUrls = docs.localizedUrls === undefined ? {} : object(docs.localizedUrls, "文档地址");
  const canvas = kind === "text" ? "text" : kind === "audio" ? "music" : kind === "video" ? "video" : "image";
  const promptMapping = mapping.find(item => item.semantic === "prompt");
  const defaultPrompt = promptMapping ? graph[promptMapping.nodeId].inputs[promptMapping.field] : undefined;
  const definition: WorkflowDefinition = {
    id: "library-" + encodeURIComponent(id), name: localized(config.nameLabel, localized(config.name, id)), family,
    ...(importReader ? { importReader } : {}),
    description: localized(config.description), mode: inferMode(kind, inputs, Boolean(dynamicReferences)), promptRequired: Boolean(prompt?.binding) && prompt?.required !== false,
    ...(typeof defaultPrompt === "string" ? { defaultPrompt } : {}),
    verification: "not-run", template: graph, parameters, mapping, inputSlots, dynamicReferences,
    ...mediaInputContract(config,id),
    requiredInputs: inputSlots.filter(slot => slot.required).map(slot => slot.semantic), optionalInputs: inputSlots.filter(slot => !slot.required).map(slot => slot.semantic),
    output: outputBindings[0], ...(outputBindings.length > 1 ? { additionalOutputs: outputBindings.slice(1) } : {}),
    directory: {version:2, canvas, seriesId:"library-" + encodeURIComponent(family), bindingKey:id, bindingStatus:"bound"},
    library: {sourcePath: source.sourcePath, folder: source.folder, runnerType:"comfyui",...importedState(config)},
    original: {
      id, version: localized(config.version), folder: source.folder, configFile:source.folder + "/workflow.config.json", configSha256:source.configSha256,
      executionFile:string(execution.file,"执行文件"), executionStatus:source.executionStatus, executionSha256:source.executionSha256,
      inputs: inputs.map(input => ({id:String(input.id),name:localized(input.name,String(input.id)),dataType:String(input.dataType),required:input.required===true,description:localized(input.description),binding:input.binding})),
      models, docsUrl:localized(localizedUrls["zh-CN"], localized(localizedUrls["en-US"])), promptPlaceholder:localized(config.promptPlaceholder), promptBinding:prompt?.binding, parameterBindings,
    },
  };
  validateDefinition(definition);
  return definition;
}

function inferMode(kind: string, inputs: ObjectData[], dynamic: boolean): Mode {
  const types = inputs.map(input => input.dataType);
  if (kind === "file") return "dataset";
  if (kind === "audio") return types.includes("audio") ? "audio-to-audio" : "text-to-audio";
  if (kind === "image") return types.includes("image") || types.includes("video") ? "image-to-image" : "text-to-image";
  if (kind === "text") return types.includes("audio") ? "audio-to-text" : "text-tool";
  if (dynamic || types.filter(type => type === "image").length > 1) return "multi-reference";
  if (types.includes("video")) return "reference-video";
  return types.includes("image") ? "image-to-video" : "text-to-video";
}

function validateConnections(graph: ApiWorkflow) {
  const visiting = new Set<string>(), seen = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("工作流存在循环连接：" + id);
    if (seen.has(id)) return;
    if (!graph[id]) throw new Error("工作流连接引用不存在的节点：" + id);
    visiting.add(id);
    for (const value of Object.values(graph[id].inputs)) if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) {
      if (Number(value[1]) < 0) throw new Error("工作流连接输出索引无效：" + id);
      visit(value[0]);
    }
    visiting.delete(id); seen.add(id);
  }
  Object.keys(graph).forEach(visit);
}

function validateDynamic(raw: ObjectData, graph: ApiWorkflow): NonNullable<WorkflowDefinition["dynamicReferences"]> {
  if (raw.mode !== "ordered-media-collection" || raw.binding === undefined) throw new Error("不支持的动态输入配置。");
  const binding = object(raw.binding,"动态目标");
  if (binding.target !== "comfyui" || !graph[string(binding.targetNodeId,"动态目标节点")]) throw new Error("动态目标节点不存在。");
  const constraints = object(raw.constraints,"动态约束");
  if (!Number.isInteger(constraints.minTotal) || Number(constraints.minTotal) < 0) throw new Error("动态素材数量无效。");
  const routes = object(raw.routes,"动态素材路径");
  if (!Object.keys(routes).length) throw new Error("动态素材路径为空。");
  for (const [kind, value] of Object.entries(routes)) {
    if (!["image","video","audio"].includes(kind)) throw new Error("不支持的动态素材类型：" + kind);
    const route = object(value,"动态素材路径");
    if (!Number.isSafeInteger(route.maxItems) || Number(route.maxItems) < 1 || !Array.isArray(route.prototypeNodeIds) || !route.prototypeNodeIds.length || route.prototypeNodeIds.some(id => typeof id !== "string" || !graph[id])) throw new Error("动态加载器配置无效。");
    const start = route.targetInputStartIndex === undefined ? 0 : route.targetInputStartIndex;
    if (!Number.isSafeInteger(start) || Number(start) < 0 || !Number.isSafeInteger(Number(start) + (Number(route.maxItems) - 1))) throw new Error("动态输入起始索引无效。");
    const path = object(route.pathBinding,"动态加载绑定");
    const loader = graph[String(path.nodeId)];
    if (!route.prototypeNodeIds.includes(path.nodeId) || typeof path.path !== "string" || !/^inputs\.[^.]+$/.test(path.path) || !loader || !(path.path.slice(7) in loader.inputs) || Array.isArray(loader.inputs[path.path.slice(7)])) throw new Error("动态加载绑定无效。");
    const output = object(route.output ?? route.videoOutput,"动态输出");
    if (!route.prototypeNodeIds.includes(output.nodeId) || !Number.isInteger(output.index) || Number(output.index) < 0 || typeof route.targetInputPrefix !== "string" || !route.targetInputPrefix) throw new Error("动态输出配置无效。");
  }
  if (constraints.minimumByType !== undefined) for (const [kind, min] of Object.entries(object(constraints.minimumByType,"动态类型数量"))) if (!routes[kind] || !Number.isInteger(min) || Number(min) < 0 || Number(min) > Number(object(routes[kind],"动态路径").maxItems)) throw new Error("动态类型数量无效。");
  return structuredClone(raw) as NonNullable<WorkflowDefinition["dynamicReferences"]>;
}
