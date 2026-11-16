import { projectDatabase as db } from "./database";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { migrateProject } from "./migrate";
import type { Project, WorkflowDefinition, Connection } from "../types";
import { isRunningHubNativeConnection, normalizeRunningHubNativeConnection } from "../runninghub/native-connection";
import { projectWithSafeConnectionSnapshots } from "./connection-snapshot";
export async function readRecord<T>(key: string): Promise<T | undefined> {
  if (isTauri()) {
    const raw = await invoke<string | null>("read_record", { key });
    return raw ? JSON.parse(raw) : undefined;
  }
  return (await db()).get("records", key);
}
export async function writeRecord(key: string, value: unknown) {
  if (isTauri())
    return invoke("write_record", { key, value: JSON.stringify(value) });
  return (await db()).put("records", value, key);
}
export async function putBlob(id: string, blob: Blob) {
  if (isTauri())
    return invoke("write_asset", {
      id,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    });
  return (await db()).put("assets", blob, id);
}
export async function getBlob(id: string, mime?: string): Promise<Blob> {
  if (isTauri()) {
    const bytes = await invoke<number[]>("read_asset", { id });
    return new Blob([new Uint8Array(bytes)], { type: mime });
  }
  const blob = await (await db()).get("assets", id);
  if (!blob) throw new Error("本地素材丢失，请重新导入。");
  return blob;
}
export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function projectArchive(
  project: Project,
  workflows: WorkflowDefinition[],
) {
  const files: Record<string, Uint8Array> = {
    "project.json": strToU8(JSON.stringify(projectWithSafeConnectionSnapshots(project))),
    "workflows.json": strToU8(JSON.stringify(workflows)),
  };
  for (const asset of Object.values(project.assets))
    files["assets/" + asset.id] = new Uint8Array(
      await (await getBlob(asset.id, asset.mime)).arrayBuffer(),
    );
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
export async function exportProject(
  project: Project,
  workflows: WorkflowDefinition[],
) {
  download(
    await projectArchive(project, workflows),
    project.name + ".aicanvas",
  );
}
export async function importProject(
  file: File,
): Promise<{ project: Project; workflows: WorkflowDefinition[] }> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!files["project.json"]) throw new Error("无效项目文件。");
  const workflows = files["workflows.json"]
    ? JSON.parse(strFromU8(files["workflows.json"]))
    : [];
  const project = migrateProject(
    JSON.parse(strFromU8(files["project.json"])),
    workflows,
  );
  if (
    project.version !== 2 ||
    !Array.isArray(project.canvases) ||
    !project.canvases.length ||
    !project.assets ||
    !Array.isArray(project.scenes) ||
    !project.scenes.length ||
    !Array.isArray(project.history)
  )
    throw new Error("不支持的项目格式。");
  const ids = new Set<string>();
  for (const c of project.canvases) {
    if (
      !c.id ||
      ids.has(c.id) ||
      !Array.isArray(c.nodes) ||
      !Array.isArray(c.edges) ||
      !c.viewport ||
      !Number.isFinite(c.viewport.zoom)
    )
      throw new Error("画布数据损坏。");
    ids.add(c.id);
    const nodes = new Set(c.nodes.map((n) => n.id));
    for (const n of c.nodes) {
      if (
        !n.data ||
        !n.position ||
        !Number.isFinite(n.position.x) ||
        !Number.isFinite(n.position.y)
      )
        throw new Error("节点数据损坏。");
      if (n.data.assetId && !project.assets[n.data.assetId])
        throw new Error("节点素材引用丢失。");
    }
    if (c.edges.some((e) => !nodes.has(e.source) || !nodes.has(e.target)))
      throw new Error("连线引用丢失。");
  }
  if (!ids.has(project.activeCanvasId))
    project.activeCanvasId = project.canvases[0].id;
  for (const a of Object.values(project.assets)) {
    if (!/^[a-zA-Z0-9-]+$/.test(a.id) || !files["assets/" + a.id])
      throw new Error("项目缺少素材文件。");
  }
  for (const a of Object.values(project.assets))
    await putBlob(
      a.id,
      new Blob([files["assets/" + a.id] as Uint8Array<ArrayBuffer>], {
        type: a.mime,
      }),
    );
  return { project, workflows };
}
export const safeConnection = (c: Connection): Connection => {
  const connection = {
    name: c.name,
    baseUrl: c.baseUrl,
    token: typeof c.token === "string" ? c.token : "",
    authHeader: c.authHeader,
    authPrefix: c.authPrefix,
    timeoutMinutes: c.timeoutMinutes,
  };
  return isRunningHubNativeConnection(connection) ? normalizeRunningHubNativeConnection(connection) : connection;
};
