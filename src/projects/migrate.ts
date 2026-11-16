import type {
  Project,
  WorkflowDefinition,
  Connection,
  GenerationTask,
  Generation,
} from "../types";
import { busyPhases } from "../types";
import { catalog, defaultConnection, defaults } from "../workflow/catalog";
import { retireDirectorProject } from "./retired-tools";
import { taskConnectionSnapshot } from "./connection-snapshot";

export function defaultTextWorkflow(workflows: WorkflowDefinition[]) {
  const entries = workflows.filter((workflow) => workflow.output.kind === "text");
  return entries.find((workflow) => workflow.mode === "text-tool" && workflow.template) ??
    entries.find((workflow) => workflow.template) ?? entries.find((workflow) => workflow.mode === "text-tool") ?? entries[0];
}
export function restoreTextGeneration(project: Project, workflows: WorkflowDefinition[]): Project {
  const workflow = defaultTextWorkflow(workflows);
  const generation: Generation = { prompt: "", negativePrompt: "", workflowId: workflow?.id ?? "", params: workflow ? defaults(workflow) : {}, taskId: null };
  return { ...project, canvases: project.canvases.map((canvas) => ({ ...canvas, nodes: canvas.nodes.map((node) =>
    node.data.kind === "text" && !node.data.generation
      ? { ...node, data: { ...node.data, generation: structuredClone(generation) } } : node,
  ) })) };
}
export function migrateProject(
  raw: unknown,
  workflows: WorkflowDefinition[] = catalog,
  connection: Connection = defaultConnection,
): Project {
  const cloned = structuredClone(raw) as Project & { version: number };
  if (!cloned || ![1, 2].includes(cloned.version) || !Array.isArray(cloned.canvases))
    throw new Error("不支持的项目格式。");
  const p = retireDirectorProject(cloned);
  // Restored projects must provide a canvas before activeCanvas selectors run.
  if (!p.canvases.length) {
    const scenes = Array.isArray(p.scenes) ? p.scenes : [];
    let scene = scenes.find(scene => typeof scene?.id === "string" && scene.id.trim());
    if (!scene) {
      scene = { id: "scene-1", name: "场景 01" };
      p.scenes = [...scenes, scene];
    }
    p.canvases = [{
      id: crypto.randomUUID(),
      sceneId: scene.id,
      name: "画布 1",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }];
  }
  if (!p.canvases.some(canvas => canvas.id === p.activeCanvasId)) p.activeCanvasId = p.canvases[0].id;
  p.tasks ??= {};
  for (const canvas of p.canvases)
    for (const node of canvas.nodes) {
      // Old image-material nodes become universal references without changing IDs or edges.
      const oldKind = node.data.kind as string;
      if (oldKind === "image") node.data.kind = "reference";
      const oldTitles: Record<string, RegExp> = {
        reference: /^(?:图像|图像素材|参考) (\d+)$/,
        video: /^(?:视频节点|视频生成) (\d+)$/,
        text: /^(?:笔记|文字笔记) (\d+)$/,
        audio: /^音频素材 (\d+)$/,
        "image-generation": /^图像生成 (\d+)$/,
      };
      const labels: Record<string, string> = {
        reference: "参考",
        video: "视频",
        text: "文本",
        audio: "音频",
        "image-generation": "图像",
      };
      const match = node.data.title.match(oldTitles[node.data.kind] ?? /$^/);
      if (match) node.data.title = labels[node.data.kind] + " " + match[1];
      if (node.data.kind === "audio" && !node.data.generation) {
        const audioWorkflow = workflows.find((w) => w.output.kind === "audio" && w.template);
        if (audioWorkflow) node.data.generation = {
          workflowId: audioWorkflow.id, prompt: "", negativePrompt: "",
          params: defaults(audioWorkflow), taskId: null,
        };
      }
      const gen = node.data.generation;
      if (!gen) continue;
      const legacy = gen as typeof gen & {
        task?: {
          phase: string;
          promptId?: string;
          clientId?: string;
          startedAt?: number;
          error?: string;
        };
      };
      if (legacy.task) {
        const old = legacy.task;
        if (old.phase !== "idle") {
          const taskId = crypto.randomUUID(),
            w = workflows.find((w) => w.id === gen.workflowId);
          if (w) {
            const endpoint = taskConnectionSnapshot(connection);
            const task: GenerationTask = {
              taskId,
              promptId: old.promptId ?? null,
              executorType: "comfyui",
              requestId: old.promptId ?? crypto.randomUUID(),
              clientId: old.clientId ?? crypto.randomUUID(),
              canvasId: canvas.id,
              nodeId: node.id,
              nodeTitle: node.data.title,
              status: old.phase as GenerationTask["status"],
              createdAt: old.startedAt ?? Date.now(),
              updatedAt: Date.now(),
              connection: endpoint,
              workflow: structuredClone(w),
              input: {
                prompt: gen.prompt,
                negativePrompt: gen.negativePrompt,
                params: { ...gen.params },
                assets: [],
              },
              outputs: node.data.assetId ? [node.data.assetId] : [],
              error: old.error,
            };
            p.tasks[taskId] = task;
            gen.taskId = taskId;
          }
        }
        delete legacy.task;
      }
      gen.taskId ??= null;
    }
  // Uploads formerly replaced the reference title with the asset filename.
  // Repair only that exact match, retaining filenames on assets and custom titles.
  for (const canvas of p.canvases) {
    const used = new Set(canvas.nodes.filter(node => node.data.kind === "reference").map(node => node.data.title));
    let index = 1;
    for (const node of canvas.nodes) {
      const asset = node.data.assetId ? p.assets?.[node.data.assetId] : undefined;
      if (node.data.kind !== "reference" || !asset || node.data.videoFrame ||
        node.data.title !== asset.name || /^参考 \d+$/.test(node.data.title)) continue;
      while (used.has("参考 " + index)) index++;
      node.data.title = "参考 " + index++;
      used.add(node.data.title);
    }
  }
  for (const task of Object.values(p.tasks)) {
    task.connection = taskConnectionSnapshot(task.connection);
    if (!task.taskId || !["comfyui", "runninghub", "muse"].includes(task.executorType) || !task.status)
      throw new Error("任务记录无效或执行器尚不支持。");
    if (task.status === "uploading" && !task.promptId) {
      task.status = "failed";
      task.progress = undefined;
      task.error = "应用在任务提交前关闭，请重新生成。";
    } else if (busyPhases.includes(task.status)) {
      task.status = "interrupted";
      task.progress = undefined;
      task.details = "应用已重新打开，请恢复查询原任务。";
    }
  }
  p.version = 2;
  return restoreTextGeneration(p, workflows);
}
