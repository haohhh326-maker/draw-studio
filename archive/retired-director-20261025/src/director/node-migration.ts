import { busyPhases, type CanvasNode, type Project, type TaskState } from "../types";
import { stripDirectorPrompts } from "./media-bridge";

export const DIRECTOR_NODE_SIZE = { width: 880, height: 620 };
export const DIRECTOR_INLINE_LAYOUT_VERSION = 1;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A copied director shares imported assets and settings, never ownership of an accepted task. */
export function copyDirectorData(data?: Record<string, unknown>): Record<string, unknown> {
  const copy = stripDirectorPrompts(structuredClone(data ?? {}));
  delete copy.run;
  return copy;
}

export function directorNodeTask(node?: CanvasNode): TaskState | undefined {
  if (node?.data.kind !== "director") return;
  const run = node.data.director?.run;
  if (!record(run) || typeof run.status !== "string" || ![...busyPhases, "idle", "completed", "failed", "cancelled", "interrupted"].includes(run.status)) return { status: "idle" };
  return { status: run.status as TaskState["status"],
    ...(["failed", "interrupted"].includes(run.status) && typeof run.message === "string" ? { error: run.message } : {}) };
}

function restoreDirectorData(data: Record<string, unknown>, restoreInterrupted: boolean) {
  const clean = stripDirectorPrompts(structuredClone(data));
  if (restoreInterrupted && record(clean.run) && busyPhases.includes(clean.run.status as TaskState["status"])) {
    clean.run = { ...clean.run, status: clean.run.taskId ? "interrupted" : "failed",
      message: clean.run.taskId ? "应用已重新打开，请恢复查询原任务。" : "应用在任务确认前关闭，请先检查 RunningHub 任务记录。" };
  }
  return clean;
}

function restoreDirectorNode(node: CanvasNode, restoreInterrupted: boolean): CanvasNode {
  const director = restoreDirectorData(node.data.director ?? {}, restoreInterrupted);
  const width = Number(node.width ?? node.style?.width) || DIRECTOR_NODE_SIZE.width;
  const height = Number(node.height ?? node.style?.height) || DIRECTOR_NODE_SIZE.height;
  // Mark the transition once so a later user resize is never mistaken for an old card.
  const needsInlineSize = director.inlineLayoutVersion !== DIRECTOR_INLINE_LAYOUT_VERSION
    && (width < DIRECTOR_NODE_SIZE.width || height < DIRECTOR_NODE_SIZE.height);
  const size = needsInlineSize ? DIRECTOR_NODE_SIZE : { width, height };
  return { ...node, type: "director", ...size, style: { ...node.style, ...size },
    data: { ...node.data, director: { ...director, inlineLayoutVersion: DIRECTOR_INLINE_LAYOUT_VERSION } } };
}

/** Preserve each old director tab as a normal canvas containing its director node. */
export function migrateDirectorCanvases(project: Project, restoreInterrupted = true): Project {
  return { ...project, canvases: project.canvases.map(canvas => {
    const { director: legacyData, ...rest } = canvas;
    const nodes = canvas.nodes.map(node => node.data.kind === "director" ? restoreDirectorNode(node, restoreInterrupted) : node);
    if (canvas.kind === "director" || record(legacyData)) {
      let id = `director-${canvas.id}`, suffix = 1;
      while (nodes.some(node => node.id === id)) id = `director-${canvas.id}-${suffix++}`;
      const node: CanvasNode = {
        id, type: "director", position: { x: nodes.length ? Math.max(...nodes.map(item => item.position.x)) + 420 : 180, y: 160 },
        ...DIRECTOR_NODE_SIZE, style: { ...DIRECTOR_NODE_SIZE },
        data: { kind: "director", title: canvas.name.startsWith("导演台") ? canvas.name : "导演台 1",
          director: { ...restoreDirectorData(record(legacyData) ? legacyData : {}, restoreInterrupted), inlineLayoutVersion: DIRECTOR_INLINE_LAYOUT_VERSION } },
      };
      nodes.push(node);
    }
    return { ...rest, ...(canvas.kind === "director" ? { kind: "standard" as const } : {}), nodes };
  }) };
}
