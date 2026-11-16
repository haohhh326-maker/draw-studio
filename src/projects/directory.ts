import { invoke, isTauri } from "@tauri-apps/api/core";
import { projectArchive, readRecord, writeRecord } from "./storage";
import type { Project, WorkflowDefinition } from "../types";

type DirectoryHandle = {
  name: string;
  queryPermission(options: { mode: "readwrite" }): Promise<string>;
  requestPermission(options: { mode: "readwrite" }): Promise<string>;
  getFileHandle(
    name: string,
    options: { create: true },
  ): Promise<{
    createWritable(): Promise<{
      write(blob: Blob): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
};
export type ProjectDirectory =
  | { mode: "desktop"; label: string }
  | { mode: "browser"; label: string; handle: DirectoryHandle };
type DirectoryWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: "readwrite";
    id: string;
  }) => Promise<DirectoryHandle>;
};
const key = (id: string) => "project-directory:" + id;
export const readDirectory = (id: string) =>
  readRecord<ProjectDirectory | null>(key(id));
export const canChooseDirectory = () =>
  isTauri() ||
  typeof (window as DirectoryWindow).showDirectoryPicker === "function";
export async function chooseDirectory(
  id: string,
): Promise<ProjectDirectory | null> {
  let directory: ProjectDirectory;
  if (isTauri()) {
    const path = await invoke<string | null>("choose_project_directory");
    if (!path) return null;
    directory = { mode: "desktop", label: path };
  } else {
    const picker = (window as DirectoryWindow).showDirectoryPicker;
    if (!picker)
      throw new Error(
        "当前浏览器不支持选择文件夹，请使用导出项目，或在 Edge / Chrome 中打开此网址后设置目录。",
      );
    const handle = await picker.call(window, {
      mode: "readwrite",
      id: "clearframe-projects",
    });
    directory = { mode: "browser", label: handle.name, handle };
  }
  await writeRecord(key(id), directory);
  return directory;
}
export async function authorizeDirectory(directory: ProjectDirectory) {
  if (
    directory.mode === "browser" &&
    (await directory.handle.requestPermission({ mode: "readwrite" })) !==
      "granted"
  )
    throw new Error("未获得文件夹写入权限，项目仍保存在本机项目库。");
}
export const clearDirectory = (id: string) => writeRecord(key(id), null);
export async function syncProjectDirectory(
  project: Project,
  workflows: WorkflowDefinition[],
) {
  const directory = await readDirectory(project.id);
  if (!directory) return;
  // IDs originate in local projects or imported archives; never use them as paths unchecked.
  if (!/^[a-zA-Z0-9-]+$/.test(project.id))
    throw new Error("项目标识不能用于文件名，请重新导入项目。");
  if (
    directory.mode === "browser" &&
    (await directory.handle.queryPermission({ mode: "readwrite" })) !==
      "granted"
  )
    throw new Error(
      "文件夹需要重新授权，请在项目的“存放路径”中点击“授权并保存”。",
    );
  const archive = await projectArchive(project, workflows);
  const filename = "project-" + project.id + ".aicanvas";
  if (directory.mode === "desktop") {
    await invoke("save_project_archive", {
      directory: directory.label,
      projectId: project.id,
      bytes: Array.from(new Uint8Array(await archive.arrayBuffer())),
    });
  } else {
    const file = await directory.handle.getFileHandle(filename, {
      create: true,
    });
    const stream = await file.createWritable();
    try {
      await stream.write(archive);
      await stream.close();
    } catch (e) {
      await stream.abort().catch(() => {});
      throw e;
    }
  }
}
