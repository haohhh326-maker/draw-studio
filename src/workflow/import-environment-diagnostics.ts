import type { AifisherBindingCandidate, AifisherWorkflowReadResult } from "./aifisher-reader-client";
import { isWorkflowCredentialFieldName } from "./credentials";
import { isSampleMediaValueDiagnostic } from "./sample-media-diagnostics";
import { remainingUnsupportedAifisherAssetGroups } from "./aifisher-variable-assets";
import { comfyArtifactRoot } from "./comfy-artifact";

type Data = Record<string, unknown>;
type Scalar = string | number | boolean | null;
export type ImportEnvironmentCapabilities = "live" | "cached" | "unavailable" | "platform";
export type ImportEnvironmentDiagnosticCategory = "missing-node" | "model-unavailable" | "asset-unavailable" | "option-mismatch" | "schema-mismatch" | "unsupported" | "other";
/** Extends the code/message/node/field contract used by WorkflowImportDiagnostic. */
export type ImportEnvironmentDiagnostic = {
  id: string; code: string; category: ImportEnvironmentDiagnosticCategory; severity: "error" | "warning";
  title: string; message: string; action: string;
  nodeId?: string; nodeTitle?: string; classType?: string; field?: string;
  actualValue?: Scalar; valueStatus: "available" | "redacted" | "unavailable";
  allowedValues?: Scalar[]; allowedValueCount?: number; expectedType?: string; minimum?: number; maximum?: number;
};
export type ImportEnvironmentReport = {
  version: 1;
  capabilities: ImportEnvironmentCapabilities;
  /** Compilation alone never verifies that the selected cloud environment can execute. */
  status: "needs-attention" | "not-verified"; summary: string;
  issues: ImportEnvironmentDiagnostic[];
  groups: { category: ImportEnvironmentDiagnosticCategory; title: string; issues: ImportEnvironmentDiagnostic[] }[];
  /** Counts are diagnostic occurrences, not unique model files or plugin packages. */
  counts: { total: number; blocking: number; warning: number; byCategory: Record<ImportEnvironmentDiagnosticCategory, number> };
  hasBlockingIssues: boolean;
};
export type ImportEnvironmentDiagnosticContext = { source?: unknown; objectInfo?: Record<string, unknown>; capabilities?: ImportEnvironmentCapabilities };

const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown): value is Scalar => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const categoryTitles: Record<ImportEnvironmentDiagnosticCategory, string> = {
  unsupported: "当前应用尚不支持", "missing-node": "云端未加载的节点", "model-unavailable": "云端列表未匹配的模型",
  "asset-unavailable": "待准备的素材", "option-mismatch": "选项或参数值不匹配", "schema-mismatch": "节点版本或输入结构不兼容", other: "其他读取提示",
};
const categoryOrder: ImportEnvironmentDiagnosticCategory[] = ["unsupported", "missing-node", "model-unavailable", "asset-unavailable", "option-mismatch", "schema-mismatch", "other"];
const MAX_ALLOWED_VALUES = 200;
const sensitiveField = (field: string) => isWorkflowCredentialFieldName(field) || /(?:^|[_.:\s-])(?:password|passwd|secret|credential)(?:$|[_.:\s-])/i.test(field);
const promptField = (field: string) => /(?:^|[_.:\s-])(?:prompt|positive|negative|positive_text|negative_text|text|text_g|text_l|instruction|user_prompt)(?:$|[_.:\s-])/i.test(field);
const modelField = (field: string) => /(?:model|weight|lora|vae|clip|checkpoint|ckpt|unet|encoder)/i.test(field);
const modelFile = (value: unknown) => typeof value === "string" && /\.(?:safetensors|gguf|pt|pth|ckpt|bin|onnx)(?:$|[?#])/i.test(value);
const optionSentinel = (value: unknown) => typeof value === "string" && /^(?:none|null|disabled?|enabled?|auto|default|pixel_space|taesd|taesdxl)$/i.test(value);

function sourceNodes(source: unknown): Map<string, Data> {
  if (typeof source === "string") { try { source = JSON.parse(source); } catch { return new Map(); } }
  if (!object(source)) return new Map();
  const root = comfyArtifactRoot(source);
  if (Array.isArray(root.nodes)) return new Map(root.nodes.filter(object).map(node => [String(node.id), node]));
  return new Map(Object.entries(root).filter(([, node]) => object(node) && (typeof node.class_type === "string" || object(node.inputs))) as [string, Data][]);
}

function directSpec(definition: Data | undefined, field: string): unknown[] | undefined {
  const input = object(definition?.input) ? definition.input : {};
  const required = object(input.required) ? input.required : {}, optional = object(input.optional) ? input.optional : {};
  const spec = required[field] ?? optional[field];
  return Array.isArray(spec) ? spec : undefined;
}

function acceptsDeclaredValue(spec: unknown[], value: unknown): boolean {
  const declared = spec[0], settings = object(spec[1]) ? spec[1] : {};
  if (Array.isArray(declared)) return declared.some(option => Object.is(option, value));
  if (/^COMFY_DYNAMICCOMBO/i.test(String(declared))) return Array.isArray(settings.options)
    && settings.options.some(option => object(option) && option.key === value);
  if (declared === "COMBO") return Array.isArray(settings.options) && settings.options.some(option => Object.is(option, value));
  if (declared === "STRING") return typeof value === "string";
  if (declared === "BOOLEAN") return typeof value === "boolean";
  if (["INT", "FLOAT", "NUMBER", "DOUBLE"].includes(String(declared))) return typeof value === "number" && Number.isFinite(value)
    && (declared !== "INT" || Number.isInteger(value)) && (typeof settings.min !== "number" || value >= settings.min)
    && (typeof settings.max !== "number" || value <= settings.max);
  return false;
}

/** Establish only declared dynamic paths; an unknown branch must remain an ordinary mismatch. */
function declaredDynamicSpec(definition: Data | undefined, field: string, inputs: Data): unknown[] | undefined {
  const path = field.split(".");
  let spec = directSpec(definition, path[0]);
  if (!spec || !/^COMFY_DYNAMICCOMBO/i.test(String(spec[0]))) return undefined;
  let selectorPath = path[0];
  for (let index = 1; index < path.length; index++) {
    if (!/^COMFY_DYNAMICCOMBO/i.test(String(spec[0]))) return undefined;
    const settings = object(spec[1]) ? spec[1] : {}, options = settings.options;
    const selected = Array.isArray(options) ? options.find(option => object(option) && option.key === inputs[selectorPath]) : undefined;
    if (!object(selected) || !object(selected.inputs)) return undefined;
    spec = directSpec({ input: selected.inputs }, path[index]);
    if (!spec) return undefined;
    selectorPath += "." + path[index];
  }
  return spec;
}

/** Read declared choices for display only. This never compiles widgets or rewrites inputs. */
function fieldSpec(definition: Data | undefined, field: string, inputs: Data): unknown[] | undefined {
  const direct = directSpec(definition, field);
  if (direct) return direct;
  for (const [selector, selected] of Object.entries(inputs)) {
    if (typeof selected !== "string") continue;
    const options = directSpec(definition, selector)?.[1];
    const formats = object(options) && object(options.formats) ? options.formats : {};
    const entries = formats[selected];
    if (!Array.isArray(entries)) continue;
    const entry = entries.find(item => Array.isArray(item) && item[0] === field);
    if (Array.isArray(entry)) return [entry[1], object(entry[2]) ? entry[2] : {}];
  }
  return undefined;
}

/** Translate reader evidence into a safe display report; never change or repair the source. */
export function buildImportEnvironmentDiagnostics(read: AifisherWorkflowReadResult, context: ImportEnvironmentDiagnosticContext = {}): ImportEnvironmentReport {
  const originals = sourceNodes(context.source);
  const analyzedNodes = new Map((Array.isArray(read.analysis.nodes) ? read.analysis.nodes : []).filter(object).map(node => [String(node.id), node]));
  const candidates = new Map(read.bindingCandidates.map(candidate => [candidate.nodeId + "\0" + candidate.fieldName, candidate]));
  const credentialTargets = new Set((read.credentialTargets ?? []).map(target => target.nodeId + "\0" + target.fieldName));
  const secrets = new Set<string>();
  function collectSecret(value: unknown) {
    if (typeof value === "string" && value) secrets.add(value);
    else if (Array.isArray(value) && typeof value[0] === "string") {
      const linked = read.workflow?.[value[0]];
      if (linked && /^PrimitiveString(?:Multiline)?$/.test(linked.class_type) && typeof linked.inputs.value === "string") {
        credentialTargets.add(value[0] + "\0value"); secrets.add(linked.inputs.value);
      }
    }
  }
  const secretNodes: [string, Data][] = [...originals, ...Object.entries(read.workflow ?? {})];
  for (const [id, node] of secretNodes) {
    const inputs = object(node.inputs) ? node.inputs : object(node.widgets_values) ? node.widgets_values : {};
    for (const [field, value] of Object.entries(inputs)) {
      if (sensitiveField(field) || credentialTargets.has(id + "\0" + field)) collectSecret(value);
      if (promptField(field) && Array.isArray(value) && typeof value[0] === "string") {
        const linked = read.workflow?.[value[0]];
        if (linked && /^PrimitiveString(?:Multiline)?$/.test(linked.class_type)) credentialTargets.add(value[0] + "\0value");
      }
    }
  }
  for (const candidate of read.bindingCandidates) if (sensitiveField(candidate.fieldName) || candidate.secret === true || candidate.sensitive === true || credentialTargets.has(candidate.nodeId + "\0" + candidate.fieldName)) {
    credentialTargets.add(candidate.nodeId + "\0" + candidate.fieldName); collectSecret(candidate.value);
  }
  const secretValues = [...secrets].sort((a, b) => b.length - a.length);
  function safeText(value: string): string {
    let result = value;
    for (const secret of secretValues) for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) result = result.split(variant).join("[已隐藏敏感值]");
    return result;
  }
  function safeValue(value: Scalar): Scalar { return typeof value === "string" ? safeText(value) : value; }
  const issues: ImportEnvironmentDiagnostic[] = [], seen = new Set<string>();

  function add(code: string, nodeId?: string, field?: string, suppliedClass?: string, suppliedCandidate?: AifisherBindingCandidate) {
    const key = code + "\0" + (nodeId ?? "") + "\0" + (field ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    const candidate = suppliedCandidate ?? candidates.get((nodeId ?? "") + "\0" + (field ?? ""));
    const node = nodeId ? read.workflow?.[nodeId] : undefined, original = nodeId ? originals.get(nodeId) : undefined, analyzed = nodeId ? analyzedNodes.get(nodeId) : undefined;
    const classType = suppliedClass ?? node?.class_type ?? candidate?.classType ?? string(analyzed?.classType) ?? string(original?.class_type) ?? string(original?.type);
    const definitionValue = classType ? read.nodeDefinitions?.[classType] ?? context.objectInfo?.[classType] : undefined;
    const definition = object(definitionValue) ? definitionValue : undefined;
    const nodeTitle = string(node?._meta?.title) ?? candidate?.nodeTitle ?? string(analyzed?.title) ?? string(original?.title)
      ?? (object(original?._meta) ? string(original._meta.title) : undefined) ?? string(definition?.display_name) ?? classType;
    const namedInputs = object(node?.inputs) ? node.inputs : object(original?.inputs) ? original.inputs : object(original?.widgets_values) ? original.widgets_values : {};
    const actual = field && object(node?.inputs) && Object.hasOwn(node.inputs, field) ? node.inputs[field]
      : candidate?.value !== undefined ? candidate.value : field && Object.hasOwn(namedInputs, field) ? namedInputs[field] : undefined;
    const dynamicSpec = field ? declaredDynamicSpec(definition, field, namedInputs) : undefined;
    const spec = field ? fieldSpec(definition, field, namedInputs) ?? dynamicSpec : undefined;
    const settings = object(spec?.[1]) ? spec[1] : {};
    const declared = spec?.[0];
    const choices = candidate?.options ?? (Array.isArray(declared) ? declared : Array.isArray(settings.options) ? settings.options : undefined);
    const allowed = Array.isArray(choices) ? choices.flatMap(value => scalar(value) ? [value] : object(value) && scalar(value.key) ? [value.key] : []) : undefined;
    const hidden = !!field && (sensitiveField(field) || promptField(field) || credentialTargets.has((nodeId ?? "") + "\0" + field));
    const media = candidate?.mediaKind ?? (/^(?:image|mask|video|audio)(?:_path|_file|_filename)?$/i.test(field ?? "") && /Load/i.test(classType ?? "") ? (field ?? "").split("_")[0] : undefined);
    const model = !!field && !optionSentinel(actual) && (!!candidate?.modelKind || modelField(field) && modelFile(actual));
    let category: ImportEnvironmentDiagnosticCategory = "other", severity: "error" | "warning" = "error";
    let title = "读取结果需要检查", message = "AIFISHER 返回了读取提示，需要结合原工作流检查。", action = "在 ComfyUI 中检查该节点，再重新导出工作流。";
    if (["INVALID_INPUT_VALUE", "UNKNOWN_NODE_INPUT"].includes(code) && dynamicSpec && acceptsDeclaredValue(dynamicSpec, actual)) {
      category = "unsupported"; title = "读取器尚未兼容此动态选项定义";
      message = "所读节点定义包含此动态选项及合法输入，但 AIFISHER 读取器尚未完整支持该输入结构；此提示不代表缺少模型或参数值有误。";
      action = "需补齐读取器对该动态选项定义的兼容。保留原参数及原始警告，可先在原 ComfyUI 中执行验证。";
    } else if (code === "aifisher-variable-asset-runtime-required") {
      category = "unsupported"; title = "动态素材组尚不能在当前应用执行";
      message = "AIFISHER 已识别动态素材组，但当前画布尚未接入对应的动态素材执行方式。";
      action = "需接入 AIFISHER 动态素材执行方式后才能在当前应用运行；补模型或安装节点不能解决此项。可先在原 ComfyUI 中执行。";
    } else if (code === "MISSING_NODE_TYPE") {
      category = "missing-node"; title = "所读定义未包含此节点";
      message = "所读节点定义中没有" + (classType ? "「" + safeText(classType) + "」" : "此节点类型") + "；可能未安装、未加载，或节点名称/插件版本不同。是否为当前云端缺项需结合定义来源确认。";
      action = "在云端安装或启用提供此节点类型的原插件，确认节点已加载后重新读取。";
      if (classType === "忽略多组孤海") action = "此节点由 Goohaitools-comfyui（孤海工具箱）提供。核对目标云端是否已安装并加载原插件，再重新读取节点定义。";
    } else if (code === "INVALID_INPUT_VALUE") {
      if (media) {
        category = "asset-unavailable"; title = "引用素材未匹配云端输入";
        message = allowed ? "工作流引用的素材不在所读素材列表中，可能尚未上传或文件名不同；当前云端情况需结合列表来源确认。" : "素材输入值未通过所读节点定义检查。";
        action = "将原素材上传到当前云端，核对文件名和子目录；也可在执行前重新选择对应素材。";
      } else if (model) {
        category = "model-unavailable"; title = "模型名称未匹配云端列表";
        message = allowed ? "工作流指定的模型不在所读模型列表中，可能缺少该模型或文件名/目录不同；当前云端情况需结合列表来源确认。" : "工作流指定的模型未通过所读节点定义检查，可能缺少该模型或文件名/目录不同。";
        action = "核对并准备原模型，确认云端列表中的完整文件名和目录；保持原工作流模型选择，勿自动替换。";
      } else {
        category = "option-mismatch"; title = "选项或参数值与所读定义不一致";
        message = "工作流使用的值与所读节点定义允许的选项、类型或范围不一致。";
        action = "对照允许值确认原插件版本和参数设置，在 ComfyUI 中核对后重新导出。";
      }
    } else if (code === "UNKNOWN_NODE_INPUT") {
      category = "schema-mismatch"; title = "所读节点定义不识别此输入字段";
      message = "所读节点定义没有此输入字段，可能是插件版本不同，或动态分支/输入结构与读取器不兼容；不能据此认定缺少模型。";
      action = "核对原工作流与云端插件版本，以及动态输入结构；保留原参数，在 ComfyUI 中验证后重新导出。";
    } else if (["MISSING_REQUIRED_INPUT", "UNCONNECTED_REQUIRED_INPUT"].includes(code)) {
      category = "schema-mismatch"; title = "缺少必需的输入或连接";
      message = "所读节点定义要求此输入，但原工作流没有可确认的值或连接。";
      action = "在原 ComfyUI 中检查该输入及其连接，再重新导出。";
    } else if (code === "RUNTIME_SLOT_UNVERIFIED") {
      category = "schema-mismatch"; severity = "warning"; title = "连接类型尚未验证";
      message = "尚未取得连接两端完整的节点定义，不能据此认定连线类型错误。原连接已保留。";
      action = "取得对应节点定义后重新检查；以目标 ComfyUI 的实际校验结果为准。";
    } else if (code === "GUI_EXECUTION_SEMANTICS_UNSUPPORTED") {
      category = "unsupported"; title = "普通工作流包含尚未转换的前端执行状态";
      message = "此普通工作流含静音、旁路或前端专用节点，当前无法确认转换后的执行语义。此项不是服务端缺插件。";
      action = "在原 ComfyUI 中导出 API Format 再导入，以保留前端实际转换的参数和连线；无需安装这些前端节点。";
    } else if (["RUNTIME_SLOT_MISMATCH", "INCONSISTENT_UI_LINK_SLOT"].includes(code)) {
      category = "schema-mismatch"; title = "节点连接与云端定义不一致";
      message = "工作流的输入/输出插槽或连线类型与当前节点定义不匹配。";
      action = "核对连接两端的节点版本和端口，使用对应版本在 ComfyUI 中验证连接。";
    } else if (["AMBIGUOUS_WIDGET_MAPPING", "AMBIGUOUS_WIDGET_COUNT", "POSITIONAL_WIDGET_MAPPING_REQUIRES_CONFIRMATION", "PRIMITIVE_VALUE_MISMATCH"].includes(code)) {
      category = "schema-mismatch"; title = "控件参数映射尚未确认";
      message = "普通工作流的控件顺序或参数映射无法准确确认，当前不会猜测其实际值。";
      action = "从对应版本的 ComfyUI 导出 API Format，或补全可确认的节点定义后重新读取。";
    } else if (code === "OBJECT_INFO_REQUIRED") {
      category = "schema-mismatch"; title = "尚未取得云端节点定义";
      message = "缺少当前云端节点定义，无法确认普通工作流的参数及环境兼容性。";
      action = "连接目标 ComfyUI，取得节点定义后重新读取。";
    } else if (code === "UNKNOWN_UI_VERSION") {
      category = "unsupported"; title = "工作流格式版本尚不受支持";
      message = "AIFISHER 无法转换此普通工作流格式版本。";
      action = "使用原 ComfyUI 导出 API Format 后重新导入。";
    } else if (code === "AIFISHER_COMPILE_INCOMPLETE") {
      category = "schema-mismatch"; title = "工作流转换尚未完成";
      message = "AIFISHER 尚未生成可确认的执行图，当前不能确认环境就绪。";
      action = "补全对应节点定义，或使用原 ComfyUI 导出 API Format。";
    } else if (code === "UNREFERENCED_INCOMPLETE_API_NODE") {
      severity = "warning"; title = "不完整的孤立节点未参与执行";
      message = "原文件中此节点缺少执行类型，且没有其他节点依赖它；AIFISHER 未将它加入执行图。";
      action = "如需执行此节点，请在原 ComfyUI 中恢复节点后重新导出。";
    } else if (/^(?:REROUTE_|UNRESOLVED_UI_)/.test(code)) {
      category = "schema-mismatch"; title = "工作流连线尚未解析完整";
      message = "AIFISHER 无法确认该节点的转接或目标连接。";
    } else severity = "warning";
    const item: ImportEnvironmentDiagnostic = { id: safeText(key), code: safeText(code), category, severity, title, message, action,
      ...(nodeId ? { nodeId: safeText(nodeId) } : {}), ...(classType ? { classType: safeText(classType) } : {}), ...(nodeTitle ? { nodeTitle: safeText(nodeTitle) } : {}), ...(field ? { field: safeText(field) } : {}),
      valueStatus: hidden ? "redacted" : scalar(actual) ? "available" : "unavailable",
      ...(!hidden && scalar(actual) ? { actualValue: safeValue(actual) } : {}),
      ...(!hidden && allowed ? { allowedValues: allowed.slice(0, MAX_ALLOWED_VALUES).map(safeValue), allowedValueCount: allowed.length } : {}),
    };
    if (!hidden) {
      const expectedType = candidate?.valueType ?? (typeof declared === "string" ? declared : Array.isArray(declared) ? "COMBO" : undefined);
      if (expectedType) item.expectedType = safeText(expectedType);
      const minimum = candidate?.minimum ?? settings.min, maximum = candidate?.maximum ?? settings.max;
      if (typeof minimum === "number" && Number.isFinite(minimum)) item.minimum = minimum;
      if (typeof maximum === "number" && Number.isFinite(maximum)) item.maximum = maximum;
    }
    issues.push(item);
  }

  for (const warning of read.analysis.warnings) if (!isSampleMediaValueDiagnostic(read, warning))
    add(warning.code, warning.nodeId ?? string(warning.targetNodeId), warning.fieldName, warning.classType);
  for (const candidate of remainingUnsupportedAifisherAssetGroups(read))
    add("aifisher-variable-asset-runtime-required", candidate.nodeId, candidate.fieldName, candidate.classType, candidate);
  if (read.analysis.compileStatus !== "ready" && !issues.some(issue => issue.severity === "error")) add("AIFISHER_COMPILE_INCOMPLETE");
  return reportFor(issues, context.capabilities ?? "unavailable");
}

function reportFor(allIssues: ImportEnvironmentDiagnostic[], capabilities: ImportEnvironmentCapabilities): ImportEnvironmentReport {
  const issues = allIssues.filter(issue => issue.category !== "asset-unavailable").map(issue => {
    // Only inventory absence is uncertain on the shared platform. A malformed
    // model field (wrong scalar type, blank name or numeric range) is still an
    // actual input error even if its field name contains "model" or "weight".
    const modelInventoryAbsence = issue.category === "model-unavailable" && issue.code === "INVALID_INPUT_VALUE"
      && issue.expectedType === "COMBO" && typeof issue.actualValue === "string" && !!issue.actualValue.trim()
      && Array.isArray(issue.allowedValues) && issue.allowedValues.every(value => typeof value === "string")
      && !issue.allowedValues.includes(issue.actualValue);
    const nodeInventoryAbsence = issue.category === "missing-node" && issue.code === "MISSING_NODE_TYPE";
    if (capabilities !== "platform" || !modelInventoryAbsence && !nodeInventoryAbsence) return issue;
    const model = issue.category === "model-unavailable";
    return { ...issue, severity: "warning" as const,
      title: model ? "平台通用列表未列出原模型" : "平台通用列表未列出此节点",
      message: "RunningHub 原生接口返回的是平台通用节点定义，不能据此判定实际执行环境缺少" + (model ? "模型。" : "节点。"),
      action: "已保留工作流原有" + (model ? "模型名称" : "节点") + "；由 RunningHub 实际执行环境校验。只有平台明确返回缺失时，才按该执行错误处理。" };
  });
  const byCategory = Object.fromEntries(categoryOrder.map(category => [category, issues.filter(issue => issue.category === category).length])) as Record<ImportEnvironmentDiagnosticCategory, number>;
  const blocking = issues.filter(issue => issue.severity === "error").length;
  const counts = { total: issues.length, blocking, warning: issues.length - blocking, byCategory };
  const hasBlockingIssues = blocking > 0;
  const findings = hasBlockingIssues ? "发现 " + blocking + " 项需要处理的问题" + (byCategory.unsupported ? "，其中 " + byCategory.unsupported + " 项属于当前应用尚不支持的能力" : "") + "。工作流读取完成不代表云端环境已就绪。"
    : "读取检查" + (issues.length ? "包含 " + issues.length + " 项提示" : "未报告兼容性问题") + "；模型和执行能力仍需在目标云端实际验证。";
  const summary = (capabilities === "platform" ? "已读取 RunningHub 平台通用节点定义；该列表不代表实际任务的节点和模型库存。" : capabilities === "cached" ? "依据此前缓存的节点定义整理，仅供补齐参考，当前云端是否缺项仍需重新读取实时定义。" : capabilities === "unavailable" ? "尚未确认当前云端实时节点定义；以下仅供补齐参考，不能据此认定当前云端缺项。" : "已读取目标云端实时节点定义。") + findings;
  return { version: 1, capabilities, status: hasBlockingIssues ? "needs-attention" : "not-verified", summary, issues,
    groups: categoryOrder.filter(category => byCategory[category] > 0).map(category => ({ category, title: categoryTitles[category], issues: issues.filter(issue => issue.category === category) })),
    counts, hasBlockingIssues };
}

/** Refresh provenance and derived text when automatic import resolves live vs cached data. */
export function withImportEnvironmentCapabilities(report: ImportEnvironmentReport, capabilities: ImportEnvironmentCapabilities): ImportEnvironmentReport {
  return reportFor(report.issues, capabilities);
}

/** Validate persisted presentation data without re-analyzing or trusting stored summaries. */
export function readImportEnvironmentReport(value: unknown): ImportEnvironmentReport | undefined {
  if (!object(value) || value.version !== 1 || !["live", "cached", "unavailable", "platform"].includes(String(value.capabilities)) || !Array.isArray(value.issues) || value.issues.length > 1000) return undefined;
  const limitedText = (raw: unknown, maximum = 8192): raw is string => typeof raw === "string" && raw.length <= maximum;
  const limitedScalar = (raw: unknown): raw is Scalar => scalar(raw) && (typeof raw !== "string" || raw.length <= 8192);
  const issues: ImportEnvironmentDiagnostic[] = [], seen = new Set<string>();
  for (const raw of value.issues) {
    // Older reports may contain sample file availability findings. Do not restore them.
    if (object(raw) && raw.category === "asset-unavailable") continue;
    if (!object(raw) || !limitedText(raw.code, 120) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(raw.code)
      || !categoryOrder.includes(raw.category as ImportEnvironmentDiagnosticCategory) || raw.severity !== "error" && raw.severity !== "warning"
      || !limitedText(raw.title, 240) || !limitedText(raw.message) || !limitedText(raw.action)
      || raw.valueStatus !== "available" && raw.valueStatus !== "redacted" && raw.valueStatus !== "unavailable") return undefined;
    for (const field of ["nodeId", "classType", "field", "nodeTitle", "expectedType"]) if (raw[field] !== undefined && !limitedText(raw[field], field === "nodeTitle" ? 1000 : 240)) return undefined;
    if (Object.hasOwn(raw, "actualValue") && !limitedScalar(raw.actualValue)) return undefined;
    if (raw.allowedValues !== undefined && (!Array.isArray(raw.allowedValues) || raw.allowedValues.length > MAX_ALLOWED_VALUES || !raw.allowedValues.every(limitedScalar))) return undefined;
    if (raw.allowedValueCount !== undefined && (!Number.isSafeInteger(raw.allowedValueCount) || Number(raw.allowedValueCount) < 0 || Number(raw.allowedValueCount) < (Array.isArray(raw.allowedValues) ? raw.allowedValues.length : 0))) return undefined;
    if ([raw.minimum, raw.maximum].some(number => number !== undefined && (typeof number !== "number" || !Number.isFinite(number)))) return undefined;
    const nodeId = string(raw.nodeId), field = string(raw.field), id = raw.code + "\0" + (nodeId ?? "") + "\0" + (field ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const hidden = !!field && (sensitiveField(field) || promptField(field)) || raw.valueStatus === "redacted";
    const issue: ImportEnvironmentDiagnostic = {
      id, code: raw.code, category: raw.category as ImportEnvironmentDiagnosticCategory, severity: raw.severity as "error" | "warning",
      title: raw.title, message: raw.message, action: raw.action,
      valueStatus: hidden ? "redacted" : raw.valueStatus as ImportEnvironmentDiagnostic["valueStatus"],
      ...(nodeId ? { nodeId } : {}), ...(field ? { field } : {}),
    };
    for (const key of ["classType", "nodeTitle", "expectedType"] as const) if (typeof raw[key] === "string") issue[key] = raw[key];
    if (!hidden) {
      if (Object.hasOwn(raw, "actualValue")) issue.actualValue = raw.actualValue as Scalar;
      if (Array.isArray(raw.allowedValues)) issue.allowedValues = [...raw.allowedValues] as Scalar[];
      if (typeof raw.allowedValueCount === "number") issue.allowedValueCount = raw.allowedValueCount;
      if (typeof raw.minimum === "number") issue.minimum = raw.minimum;
      if (typeof raw.maximum === "number") issue.maximum = raw.maximum;
    }
    issues.push(issue);
  }
  return reportFor(issues, value.capabilities as ImportEnvironmentCapabilities);
}
