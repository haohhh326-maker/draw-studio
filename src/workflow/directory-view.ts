import type { WorkflowDefinition } from "../types";
import type { CanvasCategory } from "./dfcine-directory";
import { runningHubWorkflowCategory } from "../runninghub/classification";

export type DirectorySeriesView = { id: string; name: string; workflows: number };
export type DirectoryCanvasView = {
  id: CanvasCategory;
  name: string;
  workflows: WorkflowDefinition[];
  series: DirectorySeriesView[];
};

const canonicalSeriesNames = [
  "MiniMax Music", "VoxCPM", "Klein 系列", "Krea2", "Qwen 图像", "Zimage",
  "Bernini", "LTX MSR", "LTX2.3", "LTX2.5", "LTX", "Remix", "Scail",
  "MiniMax H3 标准", "MiniMax H3 加速", "MiniMax H3 极速", "Wan", "Hunyuan Video",
  "图像工具", "图像生成", "图像编辑", "视频工具", "视频生成", "视频超分工具",
  "音频工具", "音频生成", "文本工具", "通用工具", "其他工作流",
];
const compactSeriesName = (name: string) => name.replace(/\s+/g, "").toLowerCase();
const canonicalSeries = new Map(canonicalSeriesNames.map(name => [compactSeriesName(name), name]));
canonicalSeries.set("qwenimage", "Qwen 图像");
// These labels are the localized names in the source library configs. Imported
// graphs use the canonical inference labels, so both spellings share one group.
for (const [alias, name] of [
  ["Klein图像", "Klein 系列"], ["Klein Image", "Klein 系列"],
  ["视频超分", "视频超分工具"], ["Video Upscale", "视频超分工具"],
  ["MiniMax H3 Standard", "MiniMax H3 标准"],
  ["MiniMax H3 Accelerated", "MiniMax H3 加速"],
  ["MiniMax H3 Turbo", "MiniMax H3 极速"],
]) canonicalSeries.set(compactSeriesName(alias), name);

/** Normalize presentation only; source series IDs and manually named categories stay intact. */
export function workflowSeriesName(workflow: WorkflowDefinition): string {
  let name = workflow.family.normalize("NFKC").trim().replace(/\s+/g, " ") || "其他工作流";
  const category = workflow.runninghub ? runningHubWorkflowCategory(workflow) : workflow.importReader?.category;
  if (workflow.runninghub && !category) return "待确认输出";
  if (["图像工具", "视频工具", "音频工具", "文本工具", "待确认输出", "通用工具", "其他工作流"].includes(name)) {
    if (category === "video" || category === "motion") name = "视频工具";
    else if (category === "audio") name = "音频工具";
    else if (category === "image") name = "图像工具";
    else if (category === "text") name = "文本工具";
  }
  return canonicalSeries.get(compactSeriesName(name)) ?? name;
}

function seriesNameKey(workflow: WorkflowDefinition): string {
  return workflowSeriesName(workflow).toLowerCase()
    .replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fffA-Za-z0-9])/g, "$1")
    .replace(/([A-Za-z0-9]) +(?=[\u3400-\u9fff])/g, "$1");
}

export function categoryForWorkflow(workflow: WorkflowDefinition): CanvasCategory {
  const category = workflow.runninghub ? runningHubWorkflowCategory(workflow) : workflow.importReader?.category;
  if (workflow.runninghub && !category) return "pending";
  if (category === "video" || category === "motion") return "video";
  if (category === "audio") return "music";
  if (category === "image") return "image";
  if (category === "text") return "text";
  // A preview image is not the main media type of a workflow that also returns video.
  if ([workflow.output, ...(workflow.additionalOutputs ?? [])].some(output => output.kind === "video")) return "video";
  // Older snapshots classified text outputs under image; output type owns this category.
  if (workflow.output.kind === "text") return "text";
  if (workflow.directory) return workflow.directory.canvas;
  if (workflow.output.kind === "audio") return "music";
  if (workflow.output.kind === "video") return "video";
  return "image";
}

export function workflowSeriesId(workflow: WorkflowDefinition): string {
  // Imported and bundled workflows can have different technical IDs for one visible series.
  return JSON.stringify([categoryForWorkflow(workflow), seriesNameKey(workflow)]);
}

export function buildDirectoryView(workflows: WorkflowDefinition[]): DirectoryCanvasView[] {
  const canvases: DirectoryCanvasView[] = [
    { id: "music", name: "音乐画布", workflows: [], series: [] },
    { id: "image", name: "图像画布", workflows: [], series: [] },
    { id: "video", name: "视频画布", workflows: [], series: [] },
    { id: "text", name: "文本画布", workflows: [], series: [] },
  ];
  if (workflows.some(workflow => categoryForWorkflow(workflow) === "pending"))
    canvases.push({ id: "pending", name: "待确认输出", workflows: [], series: [] });
  for (const workflow of workflows) {
    const canvas = canvases.find((item) => item.id === categoryForWorkflow(workflow))!;
    canvas.workflows.push(workflow);
    const id = workflowSeriesId(workflow);
    const series = canvas.series.find((item) => item.id === id);
    if (series) series.workflows += 1;
    else canvas.series.push({ id, name: workflowSeriesName(workflow), workflows: 1 });
  }
  return canvases;
}

export function availableSeriesId(canvas: DirectoryCanvasView, seriesId: string): string {
  return canvas.series.some((series) => series.id === seriesId) ? seriesId : "";
}

export function filterDirectoryWorkflows(canvas: DirectoryCanvasView, seriesId: string, query: string): WorkflowDefinition[] {
  const activeSeries = availableSeriesId(canvas, seriesId);
  const needle = query.trim().toLocaleLowerCase();
  return canvas.workflows.filter((workflow) =>
    (!activeSeries || workflowSeriesId(workflow) === activeSeries) &&
    (!needle || `${workflow.name} ${workflow.family} ${workflowSeriesName(workflow)}`.toLocaleLowerCase().includes(needle)),
  );
}

export function workflowExecutionStatus(workflow: WorkflowDefinition): string {
  if (workflow.library?.importStatus === "pending") return "待完成转换";
  if (workflow.library?.executionIssue) return "执行待接入";
  if (workflow.library?.runnerType && workflow.library.runnerType !== "comfyui") return "执行待接入";
  if (workflow.template) return "已读取并接入标准 ComfyUI 执行";
  if (workflow.original?.executionStatus === "encrypted") return "封装文件，尚未接入执行";
  if (workflow.original?.executionStatus === "plain") return "API 执行文件，尚未接入执行";
  return workflow.original?.executionStatus === "missing" ? "文件缺失" : "执行图待接入";
}
