import type { ApiWorkflow } from "../types";

export type DirectorModelFamily = "ref2va" | "fl2va";
const familyForMode: Readonly<Record<string, DirectorModelFamily>> = {
  t2v: "fl2va",
  i2v: "fl2va",
  fl2v: "fl2va",
  r2v: "ref2va",
  v2v: "ref2va",
  rv2v: "ref2va",
};
const mixedModes = new Set(["t2v", "i2v", "fl2v", "r2v"]);

// Confirmed filenames for these specific published director workflows only.
// An arbitrary workflow ID never inherits this catalog or an invented model name.
const publishedModels: Readonly<
  Record<string, Readonly<Record<DirectorModelFamily, string>>>
> = {
  "2113664133047603202": {
    ref2va: "minimax_h3_ref2va_bf16.safetensors",
    fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  },
  "2113192715495235585": {
    ref2va: "minimax_h3_ref2va_bf16.safetensors",
    fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  },
};

/** Same label normalization as upstream lib/task_prompts.py:resolve_task_key. */
function taskKey(value: unknown): string {
  let text = String(value ?? "")
    .split(",[object Object]", 1)[0]
    .trim();
  if (text.includes(" · ")) text = text.split(" · ", 1)[0].trim();
  for (const separator of [" — ", " —— ", " - ", " – "]) {
    if (text.includes(separator)) return text.split(separator, 1)[0].trim();
  }
  return text;
}

/** Selected groups are sampled; unselected groups remain in the timeline for cache/export. */
export function directorRunSelection(
  timeline: Record<string, any>,
  segmentCount: number,
): number[] | undefined {
  if (!(timeline.runSelectEnabled || timeline.run_select_enabled)) return;
  const raw = timeline.runSelection ?? timeline.run_selection;
  const selected = Array.isArray(raw)
    ? [
        ...new Set(
          raw
            .filter(
              (value) =>
                (typeof value === "number" ||
                  (typeof value === "string" && value.trim() !== "")) &&
                Number.isInteger(Number(value)) &&
                Number(value) >= 0 &&
                Number(value) < segmentCount,
            )
            .map(Number),
        ),
      ]
    : [];
  if (!selected.length) throw new Error("请选择至少一个有效素材组后再运行。");
  return selected;
}

/** Mixed segments mirror upstream gen_timeline.py:_resolve_segment_task. */
export function directorExecutionModes(
  widgetTask: unknown,
  timeline: Record<string, any>,
): string[] {
  const task = taskKey(timeline.global?.taskType || widgetTask);
  // plan.py dispatches on this root field before validating the task in fl2v_timeline.py.
  // Normal applyTaskLayout/buildTimelinePayload overwrite it when leaving fl2v;
  // cached workspaces and legacy payloads without timelineMode must remain valid.
  if (
    String(timeline.timelineMode || "").toLowerCase() === "fl2v" &&
    task !== "fl2v"
  )
    throw new Error(
      "时间线还保留首尾帧模式，与当前运行模式不一致。请重新选择运行模式后再运行。",
    );
  if (task !== "mixed") {
    if (!Object.hasOwn(familyForMode, task))
      throw new Error("导演台任务模式无效，请重新选择运行模式。");
    return [task];
  }
  const segments =
    Array.isArray(timeline.segments) && timeline.segments.length
      ? timeline.segments
      : [{}];
  const selected = directorRunSelection(
    timeline,
    Array.isArray(timeline.segments) ? timeline.segments.length : 0,
  );
  const sampled = selected
    ? selected.map((index) => segments[index])
    : segments;
  return sampled.map((segment) => {
    const key = taskKey(segment?.taskType || segment?.task_type || "");
    return mixedModes.has(key) ? key : "t2v";
  });
}

function modelLink(value: unknown): [string, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !["string", "number"].includes(typeof value[0]) ||
    !Number.isInteger(value[1]) ||
    value[1] < 0
  )
    return;
  return [String(value[0]), value[1]];
}

/** Walk the actual MODEL input, not unrelated/refinement loaders elsewhere in the graph. */
export function directorModelLoader(
  graph: ApiWorkflow,
  directorNodeId: string,
): string {
  let link = modelLink(graph[directorNodeId]?.inputs.model);
  const visited = new Set<string>();
  while (link) {
    const [id, slot] = link;
    const node = graph[id];
    if (!node || visited.has(id) || slot !== 0) break;
    visited.add(id);
    if (node.class_type === "UNETLoader") {
      if (slot === 0 && typeof node.inputs.unet_name === "string") return id;
      break;
    }
    // A blend/selector with multiple model branches cannot be inferred from an API graph.
    const models = Object.entries(node.inputs).filter(
      ([name, value]) =>
        /^model(?:_?[a-z0-9]+)*$/i.test(name) && modelLink(value),
    );
    if (models.length !== 1 || models[0][0] !== "model") break;
    link = modelLink(node.inputs.model);
  }
  throw new Error(
    "无法确认导演台实际连接的 UNET 底模，请检查 model 连线；尚未提交任务。",
  );
}

export function prepareDirectorModeModel(
  graph: ApiWorkflow,
  directorNodeId: string,
  workflowId: string,
  widgetTask: unknown,
  timeline: Record<string, any>,
) {
  const modes = directorExecutionModes(widgetTask, timeline);
  const families = new Set(modes.map((mode) => familyForMode[mode]));
  if (families.size !== 1)
    throw new Error(
      "当前混合模式同时包含需要 fl2va 和 ref2va 的素材组。原导演台一次运行共用一个底模，请将两类素材组分别放到不同导演台运行。",
    );
  const family = [...families][0],
    loaderNodeId = directorModelLoader(graph, directorNodeId);
  const filename = String(graph[loaderNodeId].inputs.unet_name);
  const currentFamily = /(?:^|[\/_ .-])ref2va(?:[\/_ .-]|$)/i.test(filename)
    ? "ref2va"
    : /(?:^|[\/_ .-])fl2va(?:[\/_ .-]|$)/i.test(filename)
      ? "fl2va"
      : undefined;
  if (!currentFamily)
    throw new Error(
      "无法确认当前 UNET 是否为 fl2va 或 ref2va，请检查底模后再运行。",
    );
  const template = structuredClone(graph);
  if (currentFamily !== family) {
    const confirmed = Object.hasOwn(publishedModels, workflowId)
      ? publishedModels[workflowId][family]
      : undefined;
    if (!confirmed)
      throw new Error(
        `当前导演台连接 ${currentFamily}，所选模式需要 ${family}。此工作流尚未确认对应底模，请先在原工作流连接正确模型。`,
      );
    // A workflow ID is not a guarantee that its graph still uses the published model.
    // Preserve custom revisions and paths rather than silently replacing their base model.
    if (filename !== publishedModels[workflowId][currentFamily])
      throw new Error(
        "当前底模不是此工作流已确认的原始模型，不能自动替换自定义底模。请先在原工作流连接适合所选模式的模型。",
      );
    template[loaderNodeId].inputs.unet_name = confirmed;
  }
  return { template, loaderNodeId, family, modes };
}
