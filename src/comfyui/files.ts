import type { RemoteFile, UploadedInput } from "../types";

// Paths are relative to ComfyUI input/output, never to the server filesystem.
export function relativePath(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!value && !allowEmpty) ||
    /[\\:\x00-\x1f]/.test(value) ||
    (value !== "" &&
      value.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("服务器文件路径无效，只允许目录内的相对路径。");
  return value;
}

export function fileName(value: unknown): string {
  const name = relativePath(value);
  if (name.includes("/")) throw new Error("服务器文件名不能包含目录。");
  return name;
}

export function taskDirectories(taskId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("任务标识无效。");
  return {
    inputSubfolder: "infinite-canvas/" + taskId,
    outputPrefix: "infinite-canvas/" + taskId + "/result",
    uploads: {} as Record<string, UploadedInput>,
  };
}

export function uploadName(original: string) {
  return (
    crypto.randomUUID() +
    "-" +
    original.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-120)
  );
}

export function checkedOutput(value: RemoteFile): RemoteFile {
  if (!value || typeof value !== "object")
    throw new Error("输出文件描述无效。");
  const type = value.type ?? "output";
  if (type !== "output" && type !== "temp")
    throw new Error("生成结果必须来自 output 或 temp 目录。");
  let url: string | undefined;
  if (value.url !== undefined) {
    const parsed = new URL(value.url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error("结果下载地址无效。");
    url = parsed.href;
  }
  return {
    filename: fileName(value.filename),
    subfolder: relativePath(value.subfolder ?? "", true),
    type,
    ...(url ? { url } : {}),
    ...(typeof value.sourceNodeId === "string" && value.sourceNodeId ? { sourceNodeId: value.sourceNodeId } : {}),
    ...(typeof value.sourceField === "string" && value.sourceField ? { sourceField: value.sourceField } : {}),
    ...(typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0 ? { width: value.width } : {}),
    ...(typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0 ? { height: value.height } : {}),
  };
}

export function outputKey(file: RemoteFile) {
  const { filename, subfolder, type, url } = checkedOutput(file);
  return JSON.stringify({ filename, subfolder, type, ...(url ? { url } : {}) });
}
