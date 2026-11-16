import type { ApiWorkflow, UploadedInput } from "../types";
import { relativePath } from "../comfyui/files";

const videoLoaders: Record<string, string> = {
  VHS_LoadVideoPath: "VHS_LoadVideo",
  VHS_LoadVideoFFmpegPath: "VHS_LoadVideoFFmpeg",
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function prepareUploadSizing(inputs: Record<string, unknown>, required: Record<string, unknown>, id: string): void {
  const definition = required.force_size;
  if (definition === undefined) return;
  const choices: unknown = Array.isArray(definition) ? definition[0] : undefined;
  if (!Object.hasOwn(inputs, "force_size")) {
    // RH can expose a newer Path loader alongside the legacy upload schema.
    // The legacy selector controls whether custom_width/custom_height apply;
    // choosing Disabled unconditionally would silently discard authored sizing.
    const width = inputs.custom_width, height = inputs.custom_height;
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)
      || width < 0 || height < 0) {
      throw new Error("RunningHub 视频加载节点 " + id + " 无法从动态或缺失的宽高确定上传尺寸模式，未提交任务。");
    }
    const mode = width > 0 ? height > 0 ? "Custom" : "Custom Width" : height > 0 ? "Custom Height" : "Disabled";
    if (!Array.isArray(choices) || !choices.includes(mode)) {
      throw new Error("RunningHub 视频加载节点 " + id + " 的上传节点不支持对应的尺寸模式（force_size），未提交任务。");
    }
    inputs.force_size = mode;
  } else if (Array.isArray(choices) && !Array.isArray(inputs.force_size) && !choices.includes(inputs.force_size)) {
    throw new Error("RunningHub 视频加载节点 " + id + " 的原尺寸模式不在上传节点支持范围内（force_size），未提交任务。");
  }
}

/** RH schedules a different filesystem per job. Uploaded handles must go through
 * the upload loader, never a guessed relative filesystem path. Only this job's
 * uploaded video inputs are adapted; the saved workflow stays unchanged. */
export async function prepareNativeRunningHubMedia(
  graph: ApiWorkflow, uploads: UploadedInput[],
  loadNode: (classType: string) => Promise<Record<string, unknown>>,
  loadCatalog?: () => Promise<Record<string, unknown>>,
): Promise<ApiWorkflow> {
  const handles = new Map(uploads.flatMap(file => {
    const name = relativePath(file.inputName);
    return [[name, name], ["input/" + name, name]];
  }));
  const targets = Object.entries(graph).filter(([, node]) =>
    videoLoaders[node.class_type] && typeof node.inputs.video === "string" && handles.has(node.inputs.video));
  if (!targets.length) return graph;
  const contracts = new Map<string, Record<string, unknown>>();
  let catalog: Promise<Record<string, unknown>> | undefined;
  for (const type of new Set(targets.flatMap(([, node]) => [node.class_type, videoLoaders[node.class_type]]))) {
    let value: unknown;
    try {
      const response: unknown = await loadNode(type);
      value = record(response) ? response[type] : undefined;
    }
    catch (reason) {
      // Some RH native routes implement the full catalog but not the per-class
      // endpoint. Authentication, cancellation and transport failures still surface.
      const status = record(reason) ? reason.status : undefined;
      if (reason instanceof Error && reason.name === "AbortError" || !loadCatalog || ![404, 405, 501].includes(Number(status))) throw reason;
    }
    if ((!record(value) || !record(value.input)) && loadCatalog) {
      catalog ??= loadCatalog();
      const response: unknown = await catalog;
      value = record(response) ? response[type] : undefined;
    }
    if (!record(value) || !record(value.input)) throw new Error("RunningHub 未提供视频上传加载节点定义：" + type + "，未提交任务。");
    contracts.set(type, value);
  }
  const adapted = structuredClone(graph);
  for (const [id, node] of targets) {
    const replacement = videoLoaders[node.class_type], from = contracts.get(node.class_type)!, to = contracts.get(replacement)!;
    const input = to.input as Record<string, unknown>;
    const required = record(input.required) ? input.required : {}, optional = record(input.optional) ? input.optional : {}, hidden = record(input.hidden) ? input.hidden : {};
    if (!Array.isArray(from.output) || JSON.stringify(from.output) !== JSON.stringify(to.output)
      || !Object.hasOwn(required, "video")) {
      throw new Error("RunningHub 视频上传加载节点与原节点端口不兼容：" + id + "，未提交任务。");
    }
    const inputs = adapted[id].inputs;
    prepareUploadSizing(inputs, required, id);
    const missing = Object.keys(required).filter(field => !Object.hasOwn(inputs, field));
    const unknown = Object.keys(inputs).filter(field => !Object.hasOwn(required, field) && !Object.hasOwn(optional, field) && !Object.hasOwn(hidden, field));
    if (missing.length || unknown.length) {
      const detail = [missing.length ? "缺少必填参数 " + missing.join("、") : "", unknown.length ? "未识别参数 " + unknown.join("、") : ""].filter(Boolean).join("；");
      throw new Error("RunningHub 视频加载节点 " + id + " 的上传参数不兼容：" + detail + "，未提交任务。");
    }
    adapted[id].class_type = replacement;
    inputs.video = handles.get(node.inputs.video as string)!;
  }
  return adapted;
}
