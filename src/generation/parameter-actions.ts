import type { Mapping, Parameter, WorkflowDefinition } from "../types";
import { isWorkflowCredentialFieldName } from "../workflow/credentials";
import { identifyLoraParameter } from "../workflow/lora-parameters";

export type ParameterAction =
  | { kind: "seed"; title: string }
  | { kind: "increment"; amount: number; title: string };

export function parameterAction(
  parameter: Parameter,
  workflow?: WorkflowDefinition,
): ParameterAction | undefined {
  if (parameter.type !== "number") return undefined;
  if (workflow?.runninghub?.parameterSchemaVersion === 2 && parameter.sourceControl)
    return parameter.sourceControl.kind === "seed" ? { kind: "seed", title: "随机新种子" } : undefined;
  if (
    /^(?:noise[_-]?)?seed\d*$/i.test(parameter.key) ||
    /^(?:随机)?种子$|^seed$/i.test(parameter.label.trim())
  )
    return { kind: "seed", title: "随机新种子" };
  const isH3 =
    /^h3\./i.test(workflow?.original?.id ?? "") ||
    /^(?:MiniMax\s+)?H3(?:\s|$)/i.test(workflow?.family ?? "");
  if (!isH3) return undefined;
  if (
    /^megapixels\d*$/i.test(parameter.key) ||
    parameter.label.trim() === "百万像素"
  )
    return { kind: "increment", amount: 0.1, title: "百万像素增加 0.1" };
  if (
    /^(?:duration|seconds)\d*$/i.test(parameter.key) ||
    /^(?:视频)?时长$/.test(parameter.label.trim())
  )
    return { kind: "increment", amount: 1, title: "时长增加 1 秒" };
  return undefined;
}

function seedRange(parameter: Parameter) {
  const minimum = Math.max(
    0,
    Math.ceil(Number.isFinite(parameter.min) ? parameter.min! : 0),
  );
  const maximum = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(
      Number.isFinite(parameter.max) ? parameter.max! : Number.MAX_SAFE_INTEGER,
    ),
  );
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum
  )
    throw new RangeError("种子没有可用的安全整数范围。");
  return { minimum, maximum };
}
function secureInteger53(): bigint {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (BigInt(words[0] & 0x1fffff) << 32n) | BigInt(words[1]);
}

/** Samples without rounding an integer outside the declared range or repeating the current seed. */
export function randomSeed(
  parameter: Parameter,
  current: number,
  sample53 = secureInteger53,
): number {
  const { minimum, maximum } = seedRange(parameter);
  const avoidCurrent =
    Number.isSafeInteger(current) && current >= minimum && current <= maximum;
  const available =
    BigInt(maximum) - BigInt(minimum) + 1n - (avoidCurrent ? 1n : 0n);
  if (available < 1n) return minimum;
  const space = 1n << 53n;
  const limit = space - (space % available);
  let sample: bigint;
  do {
    sample = sample53();
  } while (sample >= limit);
  let result = BigInt(minimum) + (sample % available);
  if (avoidCurrent && result >= BigInt(current)) result += 1n;
  return Number(result);
}

function decimals(value: number) {
  const [base, exponent = "0"] = String(value).toLowerCase().split("e");
  return Math.max(0, (base.split(".")[1]?.length ?? 0) - Number(exponent));
}
export function incrementParameter(
  parameter: Parameter,
  current: number,
  amount: number,
): number {
  const fallback =
    typeof parameter.default === "number" ? parameter.default : 0;
  const value = Number.isFinite(current) ? current : fallback;
  const precision = Math.min(
    12,
    Math.max(
      decimals(amount),
      decimals(value),
      decimals(parameter.min ?? 0),
      decimals(parameter.max ?? 0),
    ),
  );
  const next = Number((value + amount).toFixed(precision));
  return Math.min(
    parameter.max ?? Infinity,
    Math.max(parameter.min ?? -Infinity, next),
  );
}

export function parameterActionAvailable(
  parameter: Parameter,
  current: number,
  action: ParameterAction,
): boolean {
  if (action.kind === "increment")
    return incrementParameter(parameter, current, action.amount) !== current;
  try {
    const { minimum, maximum } = seedRange(parameter);
    return minimum < maximum || current !== minimum;
  } catch {
    return false;
  }
}

export function applyParameterAction(
  parameter: Parameter,
  current: number,
  action: ParameterAction,
): number {
  return action.kind === "seed"
    ? randomSeed(parameter, current)
    : incrementParameter(parameter, current, action.amount);
}

/** Numeric values remain numbers in saved params; only their display loses floating-point noise. */
export function parameterDisplay(value: string | number | boolean): string {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    !Number.isInteger(value)
    ? String(Number(value.toPrecision(12)))
    : String(value);
}

export const commonAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
type ParameterRole = "width" | "height" | "ratio" | "steps" | undefined;
const roleForField = (field: string): ParameterRole => {
  const last = field.split(".").at(-1)!.replace(/[_-]/g, "").toLowerCase();
  if (/^(?:image|output|target|resolution)?width(?:px)?$/.test(last)) return "width";
  if (/^(?:image|output|target|resolution)?height(?:px)?$/.test(last)) return "height";
  if (/^(?:aspect)?ratio$/.test(last)) return "ratio";
  if (/^(?:(?:num|sampling|inference|sample|denoising|denoise|total))*steps(?:\d+|stage\d+)?$|^stepcount$/.test(last)) return "steps";
  return undefined;
};

/** Resolve primitive controls through their actual consumer ports, rather than saved node IDs. */
function parameterDestinations(parameter: Parameter, workflow: WorkflowDefinition): Mapping[] {
  const result: Mapping[] = [];
  const mappings = workflow.mapping.filter(mapping => mapping.semantic === parameter.key);
  const bindings = workflow.original?.parameterBindings[parameter.key];
  if (!mappings.length && bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const binding = bindings as Record<string, unknown>;
    if (typeof binding.nodeId === "string" && typeof binding.path === "string" && binding.path.startsWith("inputs.")) mappings.push({ semantic: parameter.key, nodeId: binding.nodeId, field: binding.path.slice(7) });
  }
  const visit = (mapping: Mapping, ancestry: Set<string>) => {
    if (!workflow.template || ancestry.has(mapping.nodeId) || !/^(?:value|int|integer|float|number)$/i.test(mapping.field)) { result.push(mapping); return; }
    const seen = new Set(ancestry).add(mapping.nodeId);
    let forwarded = false;
    for (const [nodeId, node] of Object.entries(workflow.template)) for (const [field, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && value[0] === mapping.nodeId) { forwarded = true; visit({ ...mapping, nodeId, field }, seen); }
    }
    if (!forwarded) result.push(mapping);
  };
  mappings.forEach(mapping => visit(mapping, new Set()));
  return result;
}

function parameterTargets(parameter: Parameter, workflow: WorkflowDefinition): { nodeId: string; role: ParameterRole }[] {
  return parameterDestinations(parameter, workflow).map(mapping => ({ nodeId: mapping.nodeId, role: roleForField(mapping.field) }));
}

function runningHubDimensionLabelRole(label: string): "width" | "height" | undefined {
  return /^(?:宽|宽度|width)$/i.test(label) ? "width" : /^(?:高|高度|height)$/i.test(label) ? "height" : undefined;
}

export function parameterRole(parameter: Parameter, workflow?: WorkflowDefinition): ParameterRole {
  const roles = workflow ? new Set(parameterTargets(parameter, workflow).map(target => target.role).filter(Boolean)) : new Set<ParameterRole>();
  if (roles.size === 1) return [...roles][0];
  if (roles.size > 1) return undefined;
  const direct = roleForField(parameter.key.replace(/\d+$/, ""));
  if (direct) return direct;
  const label = parameter.label.split(" · ")[0].trim();
  if (workflow?.runninghub) {
    const dimension = runningHubDimensionLabelRole(label);
    if (dimension) return dimension;
  }
  return /^(?:采样)?步数$|^(?:(?:sampling|inference)\s+)?steps(?:\s+count)?$/i.test(label) ? "steps" : /^(?:比例|画幅|宽高比)$/.test(label) ? "ratio" : /^宽度$/.test(label) ? "width" : /^高度$/.test(label) ? "height" : undefined;
}

function loraRole(parameter: Parameter, workflow: WorkflowDefinition): "model" | "strength" | undefined {
  const targets = identifyLoraParameter(parameter, workflow);
  const kinds = new Set(targets.map(target => target.kind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

const promptTextField = /^(?:(?:positive_|negative_|user_|system_)?(?:prompt|text)(?:_[gl]|_?\d+)?|instruction|prompt_text)$/i;
function isImportedTextParameter(parameter: Parameter, workflow: WorkflowDefinition) {
  if (parameter.type !== "text" || parameter.model || parameter.secret) return false;
  const targets = directParameterTargets(parameter, workflow);
  if (!targets.length || targets.some(({ field, node }) => isWorkflowCredentialFieldName(field) || typeof node?.inputs[field] !== "string")) return false;
  return !!parameter.multiline || resolvedParameterTargets(parameter, workflow).some(({ field }) => promptTextField.test(field));
}

/** Filter only the visible surface; the workflow retains every default and execution binding. */
export function generationParameterSurface(workflow: WorkflowDefinition, currentValues?: Record<string, string | number | boolean>) {
  const text: Parameter[] = [];
  if (workflow.runninghub) return { ...runningHubParameterSurface(workflow, currentValues), text };
  const basic: Parameter[] = [], advanced: Parameter[] = [];
  const importedComfy = workflow.importReader?.environment === "comfyui" && !workflow.muse;
  const loraTargets = (parameter: Parameter) => identifyLoraParameter(parameter, workflow);
  const owners = (parameter: Parameter) => [...new Set(loraTargets(parameter).map(target => JSON.stringify([target.nodeId, target.slot ?? ""])) )];
  const loraNodes = [...new Set(workflow.parameters.filter(parameter => loraRole(parameter, workflow)).flatMap(owners))];
  const stepParameters = workflow.parameters.filter(parameter => !parameter.inputText && parameter.type === "number" && parameterRole(parameter, workflow) === "steps" && !loraRole(parameter, workflow));
  for (const parameter of workflow.parameters) {
    if (parameter.inputText) continue;
    const role = parameterRole(parameter, workflow), lora = loraRole(parameter, workflow);
    if (lora) {
      const targets = loraTargets(parameter);
      const indices = owners(parameter).map(owner => loraNodes.indexOf(owner) + 1);
      const fields = targets.map(mapping => mapping.field);
      advanced.push({ ...parameter, advanced: true, group: loraNodes.length > 1 ? "LoRA " + indices.join("、") : "LoRA", label: lora === "model" ? "LoRA 模型" : fields.length && fields.every(field => /clip|text/i.test(field)) ? "LoRA 强度（文本）" : fields.length && fields.every(field => /model/i.test(field)) ? "LoRA 强度（模型）" : "LoRA 强度" });
    } else if (importedComfy && isImportedTextParameter(parameter, workflow)) text.push({ ...parameter, multiline: true });
    else if (role === "steps" && parameter.type === "number") basic.push({ ...parameter, advanced: false, group: "步数", label: stepParameters.length > 1 ? "步数 " + (stepParameters.indexOf(parameter) + 1) : "步数" });
    else if (!parameter.advanced || role === "width" || role === "height" || role === "ratio" || parameterDestinations(parameter, workflow).some(mapping => /^(?:seed|noise_seed|duration|seconds|megapixels)$/i.test(mapping.field))) basic.push(parameter);
  }
  return { ...(importedComfy ? importedFooterControls(basic, workflow) : { basic, other: [] as Parameter[] }), advanced, text };
}

type RunningHubCommonRole = "seed" | "ratio" | "width" | "height" | "megapixels" | "duration" | "steps" | "cfg" | "sampler" | "scheduler" | "denoise" | "fps";
type ParameterTarget = { nodeId: string; field: string; node?: NonNullable<WorkflowDefinition["template"]>[string] };
const scalarControlFields = /^(?:value|string|int|integer|float|number)$/i;
const runningHubPrimitive = /^(?:Primitive(?:Node|Int|Integer|Float|Number|String(?:Multiline)?|Boolean)?)$/i;
const resizeNode = /resize|rescale|upscal|image[ _-]?scale|scaleby|crop|thumbnail|letterbox|padding|image[ _-]?pad/i;
const languageNode = /ollama|\bllm\b|llm[_ -]|[_ -]llm|chat|caption|language|textgenerator|promptgenerator|qwen.*(?:vl|instruct)|translation/i;
const samplingNode = /ksampler|samplercustom|randomnoise|sampler|diffusion|denois/i;
const generationNode = /generat|text.?to.?(?:image|video|audio)|image.?to.?video|empty.*latent|latent.*(?:image|video)|resolution.?selector/i;

function directParameterTargets(parameter: Parameter, workflow: WorkflowDefinition): ParameterTarget[] {
  const mappings = workflow.mapping.filter(mapping => mapping.semantic === parameter.key);
  if (!mappings.length) {
    const binding = workflow.original?.parameterBindings[parameter.key];
    if (binding && typeof binding === "object" && !Array.isArray(binding)) {
      const source = binding as Record<string, unknown>;
      if (typeof source.nodeId === "string" && typeof source.path === "string" && source.path.startsWith("inputs."))
        mappings.push({ semantic: parameter.key, nodeId: source.nodeId, field: source.path.slice(7) });
    }
  }
  return mappings.map(mapping => ({ ...mapping, node: workflow.template?.[mapping.nodeId] }));
}

function resolvedParameterTargets(parameter: Parameter, workflow: WorkflowDefinition): ParameterTarget[] {
  const result: ParameterTarget[] = [];
  const visit = (target: ParameterTarget, ancestry: Set<string>) => {
    if (ancestry.has(target.nodeId) || !runningHubPrimitive.test(target.node?.class_type ?? "") || !scalarControlFields.test(target.field)) {
      result.push(target); return;
    }
    const seen = new Set(ancestry).add(target.nodeId);
    let forwarded = false;
    for (const [nodeId, node] of Object.entries(workflow.template ?? {})) for (const [field, input] of Object.entries(node.inputs)) {
      if (Array.isArray(input) && input.length === 2 && input[0] === target.nodeId && input[1] === 0) {
        forwarded = true; visit({ nodeId, field, node }, seen);
      }
    }
    if (!forwarded) result.push(target);
  };
  directParameterTargets(parameter, workflow).forEach(target => visit(target, new Set()));
  return result;
}

function runningHubFieldRole(field: string): RunningHubCommonRole | undefined {
  const normalized = field.split(".").at(-1)!.replace(/[_ -]/g, "").toLowerCase();
  const role = roleForField(field);
  if (role) return role;
  if (/^(?:noise|random|sampling)?seed\d*$/.test(normalized)) return "seed";
  if (/^(?:mega|million)pixels$/.test(normalized)) return "megapixels";
  if (/^(?:(?:video|audio|clip|total)?duration(?:seconds)?|seconds|durationsec)$/.test(normalized)) return "duration";
  if (/^(?:cfg|cfgscale|guidance|guidancescale)$/.test(normalized)) return "cfg";
  if (/^sampler(?:name)?$/.test(normalized)) return "sampler";
  if (normalized === "scheduler") return "scheduler";
  if (/^denois(?:e|ing)(?:strength)?$/.test(normalized)) return "denoise";
  if (/^(?:fps|framerate)$/.test(normalized)) return "fps";
  return undefined;
}

function runningHubCommonRole(parameter: Parameter, workflow: WorkflowDefinition): RunningHubCommonRole | undefined {
  const destinations = resolvedParameterTargets(parameter, workflow);
  const roles = new Set(destinations.map(target => runningHubFieldRole(target.field)).filter(Boolean));
  if (roles.size === 1) return [...roles][0];
  if (roles.size > 1) return;
  // Primitive nodes often have a neutral value port, but an authored title such
  // as "Float (duration)" still declares which public control that value is.
  const titles = directParameterTargets(parameter, workflow)
    .filter(target => scalarControlFields.test(target.field) && runningHubPrimitive.test(target.node?.class_type ?? ""))
    .map(target => target.node?._meta?.title ?? "");
  for (const title of titles) {
    if (/\bduration\b|\bseconds\b|时长|秒数/i.test(title)) return "duration";
    if (/\bmegapixels\b|百万像素/i.test(title)) return "megapixels";
    if (/\b(?:aspect[ _-]?)?ratio\b|宽高比|画幅比例/i.test(title)) return "ratio";
    if (/\b(?:noise[ _-]?)?seed\b|种子/i.test(title)) return "seed";
  }
  const role = runningHubFieldRole(parameter.key);
  if (role) return role;
  const label = parameter.label.split(" · ")[0].trim();
  const dimension = runningHubDimensionLabelRole(label);
  if (dimension) return dimension;
  return /^(?:随机)?种子$/.test(label) ? "seed" : /^(?:视频|音频)?时长$|^秒数$/.test(label) ? "duration"
    : /^百万像素$/.test(label) ? "megapixels" : /^(?:比例|画幅|宽高比)$/.test(label) ? "ratio"
      : /^(?:采样)?步数$/.test(label) ? "steps" : undefined;
}

function nodeText(target: ParameterTarget): string {
  return (target.node?.class_type ?? "") + " " + (target.node?._meta?.title ?? "");
}

/** Distances are presentation hints only; no deployed nodes or links are filtered. */
function primaryOutputDistances(workflow: WorkflowDefinition): Map<string, number> {
  const result = new Map<string, number>(), queue = [{ id: workflow.output.nodeId, distance: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const { id, distance } = queue[index];
    if ((result.get(id) ?? Infinity) <= distance) continue;
    result.set(id, distance);
    const node = workflow.template?.[id];
    if (!node) continue;
    for (const input of Object.values(node.inputs)) if (Array.isArray(input) && input.length === 2 && typeof input[0] === "string" && typeof input[1] === "number")
      queue.push({ id: input[0], distance: distance + 1 });
  }
  return result;
}

function commonParameterScore(parameter: Parameter, role: RunningHubCommonRole, workflow: WorkflowDefinition,
  distances: Map<string, number>, preferredNodes: Set<string> = new Set()): number {
  const targets = resolvedParameterTargets(parameter, workflow);
  const direct = directParameterTargets(parameter, workflow);
  return Math.max(0, ...[...targets, ...direct].map(target => {
    const description = nodeText(target);
    let score = runningHubFieldRole(target.field) === role ? 20 : 0;
    if (preferredNodes.has(target.nodeId)) score += 120;
    if (distances.has(target.nodeId)) score += 12 + Math.max(0, 8 - distances.get(target.nodeId)!);
    if (generationNode.test(description)) score += 45;
    if (role === "ratio" || role === "megapixels") {
      if (/resolution.?selector/i.test(description)) score += 100;
      if (/aspect.?ratio|resolution|画幅|分辨率/i.test(description)) score += 20;
    }
    if (role === "seed" && samplingNode.test(description)) score += 100;
    if ((role === "width" || role === "height") && /empty.*latent|latent.*(?:image|video)|text.?to.?(?:image|video)|image.?to.?video/i.test(description)) score += 70;
    if (role === "duration" && /duration|seconds|时长|秒数/i.test(description)) score += 60;
    if (resizeNode.test(description)) score -= 160;
    if (languageNode.test(description)) score -= 200;
    return score;
  })) + (!parameter.advanced ? 2 : 0);
}

const runningHubFieldLabels: Record<string, string> = {
  seed: "种子", noise_seed: "种子", random_seed: "种子", width: "宽度", height: "高度",
  target_width: "目标宽度", target_height: "目标高度", output_width: "输出宽度", output_height: "输出高度",
  image_width: "图像宽度", image_height: "图像高度", aspect_ratio: "比例", ratio: "比例", megapixels: "百万像素",
  duration: "时长", seconds: "时长", steps: "步数", cfg: "CFG", sampler_name: "采样器", scheduler: "调度器",
  denoise: "降噪强度", batch_size: "批次", frame_rate: "帧率", negative_prompt: "负面提示词",
  system_prompt: "系统提示词", prompt: "提示词", text: "文本",
};

function groupedRunningHubParameter(parameter: Parameter, workflow: WorkflowDefinition): Parameter {
  const targets = directParameterTargets(parameter, workflow);
  const groups = [...new Set(targets.map(target => (target.node?._meta?.title?.trim() || target.node?.class_type || "工作流参数") + " · 节点 " + target.nodeId))];
  const fields = [...new Set(targets.map(target => target.field))];
  const label = fields.length === 1 ? runningHubFieldLabels[fields[0]] : undefined;
  const nodeSuffix = targets.map(target => " · " + target.nodeId).find(suffix => parameter.label.endsWith(suffix));
  return { ...parameter, advanced: true, group: groups.join("、") || parameter.group || "工作流参数",
    label: label ?? (nodeSuffix ? parameter.label.slice(0, -nodeSuffix.length) : parameter.label) };
}

const runningHubCommonLabels: Record<RunningHubCommonRole, string> = {
  seed: "种子", ratio: "比例", width: "宽", height: "高", megapixels: "百万像素", duration: "时长",
  steps: "步数", cfg: "CFG", sampler: "采样器", scheduler: "调度器", denoise: "降噪强度", fps: "帧率",
};

/** Keep controls closest to the saved output in the footer and retain earlier stages in settings. */
function importedFooterControls(parameters: Parameter[], workflow: WorkflowDefinition) {
  const distances = primaryOutputDistances(workflow);
  const controls = parameters.map(parameter => {
    const targets = parameterDestinations(parameter, workflow);
    const roles = new Set(targets.map(target => runningHubFieldRole(target.field)).filter(Boolean));
    const role = roles.size === 1 ? [...roles][0] : undefined;
    return { parameter, role, distance: Math.min(...targets.map(target => distances.get(target.nodeId) ?? Infinity)) };
  });
  const byKey = new Map(controls.map(control => [control.parameter.key, control]));
  const closest = <T extends { distance: number }>(choices: T[]) => {
    const [first, second] = [...choices].sort((a, b) => a.distance - b.distance);
    return first && first.distance !== second?.distance ? first : undefined;
  };
  const ratios = controls.filter(control => control.role === "ratio")
    .map(control => ({ keys: [control.parameter.key], distance: control.distance }));
  const pairs = dimensionRatioControls({ ...workflow, parameters }).map(({ width, height }) => ({
    keys: [width.key, height.key],
    // Prefer the author's explicit ratio when both controls serve the same stage.
    distance: Math.max(byKey.get(width.key)!.distance, byKey.get(height.key)!.distance) + .5,
  }));
  const sizeGroups = [...ratios, ...pairs];
  const primarySize = closest(sizeGroups);
  const settings = new Set<string>();
  if (sizeGroups.length) for (const control of controls) {
    if ((control.role === "ratio" || control.role === "width" || control.role === "height")
      && !primarySize?.keys.includes(control.parameter.key)) settings.add(control.parameter.key);
  }
  for (const role of ["seed", "megapixels", "duration"] as const) {
    const matching = controls.filter(control => control.role === role);
    const primary = closest(matching);
    for (const control of matching) if (control !== primary) settings.add(control.parameter.key);
  }
  const basic: Parameter[] = [], other: Parameter[] = [];
  for (const { parameter, role } of controls) {
    if (settings.has(parameter.key)) {
      other.push({ ...groupedRunningHubParameter(parameter, workflow), label: role ? runningHubCommonLabels[role] : parameter.label });
    } else {
      const label = role && role !== "steps" ? runningHubCommonLabels[role] : parameter.label;
      basic.push(label === parameter.label ? parameter : { ...parameter, label });
    }
  }
  return { basic, other };
}

const runningHubBasicRoles = new Set<RunningHubCommonRole>(["seed", "ratio", "width", "height", "megapixels", "duration", "steps"]);
const runningHubSamplingControl = /sampl|randomnoise|diffusion|denois|scheduler|guider/i;
const numericRunningHubRoles = new Set<RunningHubCommonRole>(["seed", "width", "height", "megapixels", "duration", "steps", "cfg", "denoise", "fps"]);
const canvasParameters = (workflow: WorkflowDefinition) => workflow.parameters.filter(parameter => !parameter.inputText && !parameter.secret);

function runningHubLoraTargets(parameter: Parameter, workflow: WorkflowDefinition) {
  const resolved = resolvedParameterTargets(parameter, workflow);
  return identifyLoraParameter(parameter, workflow).filter(target => resolved.some(item => item.nodeId === target.nodeId && item.field === target.field));
}

function runningHubDefaultSelection(workflow: WorkflowDefinition, remoteCanvas = false) {
  const parameters = canvasParameters(workflow);
  const distances = primaryOutputDistances(workflow);
  const loras = new Set(parameters.filter(parameter => runningHubLoraTargets(parameter, workflow).some(target => distances.has(target.nodeId))).map(parameter => parameter.key));
  const candidates = parameters.filter(parameter => !loras.has(parameter.key));
  const chosen = new Map<RunningHubCommonRole, Parameter>();
  const safe = (parameter: Parameter, role: RunningHubCommonRole) => {
    if (remoteCanvas && (parameter.model || directParameterTargets(parameter, workflow).some(target =>
      /(?:^|[_.])(?:model|ckpt|unet|vae|lora|clip|device|dtype|precision|filename|save_output)(?:[_.]|$)/i.test(target.field)))) return false;
    if (numericRunningHubRoles.has(role) && parameter.type !== "number" && !(parameter.type === "select" && typeof parameter.default === "number")) return false;
    const primitiveTitle = directParameterTargets(parameter, workflow).some(target => runningHubPrimitive.test(target.node?.class_type ?? "")
      && scalarControlFields.test(target.field) && runningHubCommonRole(parameter, workflow) === role
      && /duration|seconds|megapixels|ratio|width|height|seed|steps|时长|秒数|百万像素|比例|宽度|高度|种子|步数/i.test(target.node?._meta?.title ?? ""));
    return resolvedParameterTargets(parameter, workflow).some(target => {
      const description = nodeText(target);
      if (!distances.has(target.nodeId) || resizeNode.test(description) || languageNode.test(description)) return false;
      if (remoteCanvas && /text.?generat.*prompt|prompt.*generat|caption|translat|load.?image|load.?video|load.?audio|image.?load|video.?load|audio.?load/i.test(description)) return false;
      if (runningHubPrimitive.test(target.node?.class_type ?? "") && scalarControlFields.test(target.field)) return false;
      if (runningHubFieldRole(target.field) !== role && !primitiveTitle) return false;
      const remoteGeneration = remoteCanvas && /(?:image|video|audio|latent|resolution)|reference.*to/i.test(description);
      if (role === "width" || role === "height" || role === "ratio" || role === "megapixels") return generationNode.test(description) || primitiveTitle || remoteGeneration;
      if (["steps", "cfg", "sampler", "scheduler", "denoise"].includes(role)) return runningHubSamplingControl.test(description) || generationNode.test(description) || remoteGeneration;
      return true;
    });
  };
  const choose = (role: RunningHubCommonRole, preferredNodes?: Set<string>) => {
    const configured = remoteCanvas ? workflow.runninghub?.canvasParameterKeys : undefined;
    const eligible = candidates.filter(parameter => (!configured || configured.includes(parameter.key)) && runningHubCommonRole(parameter, workflow) === role && safe(parameter, role));
    let best: Parameter | undefined, bestScore = -Infinity;
    for (const parameter of eligible) {
      const score = commonParameterScore(parameter, role, workflow, distances, preferredNodes);
      if (score > bestScore) { best = parameter; bestScore = score; }
    }
    if (best) chosen.set(role, best);
    return best;
  };
  const ratio = choose("ratio");
  const ratioNodes = new Set(ratio ? resolvedParameterTargets(ratio, workflow).map(target => target.nodeId) : []);
  choose("seed"); choose("megapixels", ratioNodes); choose("duration");
  for (const role of ["steps", "cfg", "sampler", "scheduler", "denoise", "fps"] as const) choose(role);
  if (!ratio) {
    let best: DimensionRatioControl | undefined, bestScore = -Infinity;
    const pairs = new Map<string, { width?: Parameter; height?: Parameter }>();
    for (const parameter of candidates) for (const target of resolvedParameterTargets(parameter, workflow)) {
      const role = runningHubFieldRole(target.field);
      if ((role === "width" || role === "height") && safe(parameter, role)
        && (!remoteCanvas || !workflow.runninghub?.canvasParameterKeys || workflow.runninghub.canvasParameterKeys.includes(parameter.key))) {
        const pair = pairs.get(target.nodeId) ?? {};
        pair[role] = parameter; pairs.set(target.nodeId, pair);
      }
    }
    for (const { width, height } of pairs.values()) {
      if (!width || !height || width.key === height.key) continue;
      const control = { key: width.key + "|" + height.key, label: "比例", width, height };
      const score = commonParameterScore(control.width, "width", workflow, distances) + commonParameterScore(control.height, "height", workflow, distances);
      if (score > bestScore) { best = control; bestScore = score; }
    }
    if (best) { chosen.set("width", best.width); chosen.set("height", best.height); }
  }
  return { common: new Map([...chosen].map(([role, parameter]) => [parameter.key, role])), loras };
}

/** Compact controls for remote templates. This key list also limits submitted overrides. */
export function runningHubRemoteCanvasParameterKeys(workflow: WorkflowDefinition): string[] {
  if (!workflow.runninghub || workflow.runninghub.kind === "app" || workflow.runninghub.billingMode !== "consumer") return [];
  const selection = runningHubDefaultSelection(workflow, true);
  const roleOrder: RunningHubCommonRole[] = ["seed", "ratio", "width", "height", "megapixels", "duration", "steps", "fps"];
  const entries = [...selection.common].filter(([, role]) => roleOrder.includes(role))
    .sort((a, b) => roleOrder.indexOf(a[1]) - roleOrder.indexOf(b[1]));
  // At most one control per role and one width/height pair are selected above.
  // Keep paired dimensions together if a future role is inserted before them.
  const selected = entries.slice(0, 7);
  const hasWidth = selected.some(([, role]) => role === "width"), hasHeight = selected.some(([, role]) => role === "height");
  return selected.filter(([, role]) => hasWidth === hasHeight || role !== "width" && role !== "height").map(([key]) => key);
}

/** Default checkbox choices only; saved explicit choices never influence this result. */
export function runningHubDefaultCanvasParameterKeys(workflow: WorkflowDefinition): string[] {
  const parameters = canvasParameters(workflow);
  if (workflow.runninghub?.billingMode === "consumer" && workflow.runninghub.kind !== "app") return runningHubRemoteCanvasParameterKeys(workflow);
  if (workflow.runninghub?.kind === "app" || workflow.runninghub?.parameterSchemaVersion === 2) return parameters.map(parameter => parameter.key);
  const selection = runningHubDefaultSelection(workflow);
  return parameters.filter(parameter => selection.common.has(parameter.key) || selection.loras.has(parameter.key)).map(parameter => parameter.key);
}

/** Project the canvas form without changing any source value, binding or contract. */
function runningHubParameterSurface(workflow: WorkflowDefinition, currentValues?: Record<string, string | number | boolean>) {
  const basic: Parameter[] = [], advanced: Parameter[] = [], other: Parameter[] = [];
  const parameters = canvasParameters(workflow), app = workflow.runninghub?.kind === "app";
  if (workflow.runninghub?.billingMode === "consumer" && !app) {
    const selected = new Set(runningHubRemoteCanvasParameterKeys(workflow));
    for (const parameter of parameters) {
      if (!selected.has(parameter.key)) continue;
      const role = runningHubCommonRole(parameter, workflow);
      basic.push({ ...parameter, advanced: false, label: role ? runningHubCommonLabels[role] : parameter.label });
    }
    return { basic, advanced, other };
  }
  if (workflow.runninghub?.parameterSchemaVersion === 2) {
    // Original source bindings own labels, ordering, and visibility defaults.
    const configured = workflow.runninghub.canvasParameterKeys;
    const visible = app || configured === undefined ? undefined : new Set(configured);
    for (const parameter of [...parameters].sort((a, b) => (a.sourceControl?.order ?? 0) - (b.sourceControl?.order ?? 0))) {
      if (visible && !visible.has(parameter.key) && !(currentValues && Object.hasOwn(currentValues, parameter.key) && !Object.is(currentValues[parameter.key], parameter.default))) continue;
      // The canvas shows the original public controls together beside run mode.
      basic.push(parameter);
    }
    return { basic, advanced, other };
  }
  const selection = runningHubDefaultSelection(workflow);
  const configured = workflow.runninghub?.canvasParameterKeys;
  const keys = configured === undefined ? runningHubDefaultCanvasParameterKeys(workflow) : Array.isArray(configured) ? configured : [];
  const visible = new Set(app ? parameters.map(parameter => parameter.key) : keys);
  const selectedLoras = parameters.filter(parameter => visible.has(parameter.key) && runningHubLoraTargets(parameter, workflow).length);
  const owners = (parameter: Parameter) => [...new Set(runningHubLoraTargets(parameter, workflow).map(target => JSON.stringify([target.nodeId, target.slot ?? ""])))];
  const loraNodes = [...new Set(selectedLoras.flatMap(owners))];
  for (const parameter of parameters) {
    if (!visible.has(parameter.key)) {
      if (currentValues && Object.hasOwn(currentValues, parameter.key) && !Object.is(currentValues[parameter.key], parameter.default))
        other.push({ ...groupedRunningHubParameter(parameter, workflow), group: "已调整参数" });
      continue;
    }
    const targets = runningHubLoraTargets(parameter, workflow), kinds = new Set(targets.map(target => target.kind));
    const lora = kinds.size === 1 ? [...kinds][0] : undefined;
    const boundRole = runningHubCommonRole(parameter, workflow);
    // Explicitly bound dimensions remain directly editable even when the
    // workflow also publishes a separate aspect-ratio control. This changes
    // presentation only: unselected dimensions never enter the visible set.
    const role = app || boundRole === "width" || boundRole === "height"
      ? boundRole : selection.common.get(parameter.key);
    if (lora) {
      const fields = targets.map(target => target.field);
      const indices = owners(parameter).map(owner => loraNodes.indexOf(owner) + 1);
      advanced.push({ ...parameter, advanced: true, group: loraNodes.length > 1 ? "LoRA " + indices.join("、") : "LoRA",
        label: lora === "model" ? "LoRA 模型" : fields.length && fields.every(field => /clip|text/i.test(field)) ? "LoRA 强度（文本）"
          : fields.length && fields.every(field => /model/i.test(field)) ? "LoRA 强度（模型）" : "LoRA 强度" });
    } else if (role && runningHubBasicRoles.has(role)) {
      basic.push({ ...parameter, advanced: false, ...(role === "steps" ? { group: "步数" } : {}), label: runningHubCommonLabels[role] });
    } else if (role) other.push({ ...groupedRunningHubParameter(parameter, workflow), group: "生成参数", label: runningHubCommonLabels[role] });
    else other.push({ ...groupedRunningHubParameter(parameter, workflow), ...(app ? { group: "参数设置" } : {}) });
  }
  return { basic, advanced, other };
}

export type DimensionRatioControl = { key: string; label: string; width: Parameter; height: Parameter };
const dimensionChoices = (parameter: Parameter): number[] | undefined => {
  if (parameter.type !== "select") return undefined;
  const values = (parameter.options ?? []).map(option => parameter.optionValues?.[option] ?? option);
  return values.length && values.every(value => typeof value === "number" && Number.isFinite(value) && value > 0) ? values as number[] : undefined;
};
export function dimensionRatioControls(workflow: WorkflowDefinition): DimensionRatioControl[] {
  const byNode = new Map<string, { width?: Parameter; height?: Parameter }>();
  for (const parameter of workflow.parameters) {
    if (parameter.type !== "number" && !(typeof parameter.default === "number" && dimensionChoices(parameter))) continue;
    for (const target of parameterTargets(parameter, workflow)) if (target.role === "width" || target.role === "height") {
      const pair = byNode.get(target.nodeId) ?? {};
      pair[target.role] = parameter; byNode.set(target.nodeId, pair);
    }
  }
  const controls = new Map<string, DimensionRatioControl>();
  for (const pair of byNode.values()) if (pair.width && pair.height && pair.width.key !== pair.height.key) {
    const key = pair.width.key + "|" + pair.height.key;
    controls.set(key, { key, label: "比例", width: pair.width, height: pair.height });
  }
  return [...controls.values()].map((control, index, all) => ({ ...control, label: all.length > 1 ? "比例 " + (index + 1) : "比例" }));
}

function ratioParts(ratio: string): [number, number] | undefined {
  const match = ratio.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return undefined;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 && Number.isFinite(width / height) ? [width, height] : undefined;
}

export function dimensionRatioValue(control: DimensionRatioControl, params: Record<string, string | number | boolean>): string {
  const width = Number(params[control.width.key] ?? control.width.default), height = Number(params[control.height.key] ?? control.height.default);
  const common = commonAspectRatios.find(ratio => { const [a, b] = ratioParts(ratio)!; return Math.abs(width / height - a / b) / (a / b) < .005; });
  return common ?? `${parameterDisplay(width)}:${parameterDisplay(height)}`;
}

/** Preserve the source pixel area where possible, with exact ratios and both dimensions' declared limits/steps. */
export function dimensionRatioPatch(control: DimensionRatioControl, ratio: string, params: Record<string, string | number | boolean>): Record<string, number> | undefined {
  const parts = ratioParts(ratio);
  if (!parts) return undefined;
  const [a, b] = parts;
  const width = Number(params[control.width.key] ?? control.width.default), height = Number(params[control.height.key] ?? control.height.default);
  if (!(width > 0 && height > 0)) return undefined;
  const widthChoices = dimensionChoices(control.width), heightChoices = dimensionChoices(control.height);
  const minimum = Math.ceil(Math.max((control.width.min ?? (widthChoices ? Math.min(...widthChoices) : 1)) / a, (control.height.min ?? (heightChoices ? Math.min(...heightChoices) : 1)) / b, 1));
  const maximum = Math.floor(Math.min((control.width.max ?? (widthChoices ? Math.max(...widthChoices) : Number.MAX_SAFE_INTEGER)) / a, (control.height.max ?? (heightChoices ? Math.max(...heightChoices) : Number.MAX_SAFE_INTEGER)) / b));
  if (minimum > maximum) return undefined;
  const ideal = Math.min(maximum, Math.max(minimum, Math.round(Math.sqrt(width * height / (a * b)))));
  const valid = (parameter: Parameter, value: number) => {
    if (!Number.isSafeInteger(value) || value < (parameter.min ?? 1) || value > (parameter.max ?? Number.MAX_SAFE_INTEGER)) return false;
    const choices = dimensionChoices(parameter);
    if (parameter.type === "select") return !!choices?.includes(value);
    const step = parameter.step ?? 1, offset = (value - (parameter.min ?? 0)) / step;
    return step > 0 && Math.abs(offset - Math.round(offset)) < 1e-8;
  };
  for (let distance = 0; distance <= 4096; distance++) for (const scale of distance ? [ideal - distance, ideal + distance] : [ideal]) {
    if (scale < minimum || scale > maximum) continue;
    const nextWidth = a * scale, nextHeight = b * scale;
    if (valid(control.width, nextWidth) && valid(control.height, nextHeight)) return { [control.width.key]: nextWidth, [control.height.key]: nextHeight };
  }
  return undefined;
}

export function dimensionRatioOptions(control: DimensionRatioControl, params: Record<string, string | number | boolean>): string[] {
  return commonAspectRatios.filter(ratio => !!dimensionRatioPatch(control, ratio, params));
}
