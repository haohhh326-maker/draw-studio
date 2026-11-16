import { promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

export type MuseReferenceFormat = { mime: string; ext: string };
export type MuseReferenceSniffer = (header: Buffer, declaredMime: string) => MuseReferenceFormat | undefined;
export type MuseReferenceUpload = { uploadId: string; name: string; mime: string };
export type MuseStoredReference = { path: string; name: string; mime: string };

export class MuseReferenceStoreError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "MuseReferenceStoreError"; }
}

type UploadOperation = { abort: AbortController; done: Promise<void> };
type JobReferences = {
  directory?: string;
  files: Map<string, MuseStoredReference>;
  paths: Set<string>;
  active: Set<UploadOperation>;
  closing: boolean;
  cleanup?: Promise<void>;
};
const jobPattern = /^[a-zA-Z0-9_-]{8,100}$/;
const uploadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const headerBytes = 64 * 1024;
function validateJobId(jobId: string) {
  if (typeof jobId !== "string" || !jobPattern.test(jobId)) throw new MuseReferenceStoreError("Muse 上传任务编号无效。");
}
function mediaMime(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return /^(image|video|audio)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : undefined;
}
function category(mime: string) { return mime.slice(0, mime.indexOf("/")); }

/** Streams uploads into server-owned files; only opaque, job-scoped IDs cross the API. */
export class MuseReferenceStore {
  public readonly root: string;
  private rootReady?: Promise<string>;
  private jobs = new Map<string, JobReferences>();
  constructor(root: string, private readonly sniff: MuseReferenceSniffer) { this.root = path.resolve(root); }

  private getRoot() {
    return this.rootReady ??= fs.mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => fs.realpath(this.root));
  }
  private async getDirectory(jobId: string, entry: JobReferences) {
    const root = await this.getRoot();
    const directory = path.join(root, jobId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await fs.realpath(directory);
    const relative = path.relative(root, resolved);
    if ((process.platform === "win32" ? relative.toLowerCase() !== jobId.toLowerCase() : relative !== jobId))
      throw new MuseReferenceStoreError("Muse 上传目录不在本机任务目录中。", 500);
    entry.directory = resolved;
    return resolved;
  }
  private async removeOwned(entry: JobReferences, filename: string) {
    if (!entry.paths.has(filename)) return;
    try { await fs.unlink(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    entry.paths.delete(filename);
  }

  async save(jobId: string, req: IncomingMessage, _name: string, declaredMime: string): Promise<MuseReferenceUpload> {
    validateJobId(jobId);
    const mime = mediaMime(declaredMime);
    if (!mime) throw new MuseReferenceStoreError("Muse 参考素材仅支持图片、视频和音频。");
    let entry = this.jobs.get(jobId);
    if (!entry) {
      entry = { files: new Map(), paths: new Set(), active: new Set(), closing: false };
      this.jobs.set(jobId, entry);
    }
    if (entry.closing) throw new MuseReferenceStoreError("Muse 参考素材正在清理，请重新上传。", 409);
    let finish!: () => void;
    const operation: UploadOperation = { abort: new AbortController(), done: new Promise<void>(resolve => { finish = resolve; }) };
    entry.active.add(operation);
    const aborted = () => operation.abort.abort(new Error("Muse 参考素材上传已中断。"));
    const failed = (error: Error) => operation.abort.abort(error);
    req.once("aborted", aborted);
    // The HTTP stream can fail while its destination directory is being opened.
    req.once("error", failed);
    if (req.aborted || (req.destroyed && !req.complete)) aborted();
    let ownedPath: string | undefined;
    try {
      operation.abort.signal.throwIfAborted();
      const directory = await this.getDirectory(jobId, entry);
      operation.abort.signal.throwIfAborted();
      const uploadId = randomUUID();
      const partial = path.join(directory, `reference-${uploadId}.partial`);
      // Exclusive creation means failure cleanup can only remove a file we own.
      const writer = await fs.open(partial, "wx", 0o600);
      ownedPath = partial;
      entry.paths.add(partial);
      try {
        await pipeline(req, writer.createWriteStream(), { signal: operation.abort.signal });
      } finally { await writer.close().catch(() => {}); }
      operation.abort.signal.throwIfAborted();
      const reader = await fs.open(partial, "r");
      const header = Buffer.alloc(headerBytes);
      let length = 0;
      try {
        while (length < header.length) {
          const read = await reader.read(header, length, header.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
      } finally { await reader.close(); }
      operation.abort.signal.throwIfAborted();
      const format = length ? this.sniff(header.subarray(0, length), mime) : undefined;
      const actualMime = format && mediaMime(format.mime);
      if (!format || !actualMime || category(actualMime) !== category(mime) || typeof format.ext !== "string" || !/^[a-zA-Z0-9]+$/.test(format.ext))
        throw new MuseReferenceStoreError("参考素材为空、格式无效，或文件内容与素材类型不符。");
      const name = `reference-${uploadId}.${format.ext.toLowerCase()}`;
      const filename = path.join(directory, name);
      operation.abort.signal.throwIfAborted();
      await fs.rename(partial, filename);
      entry.paths.delete(partial);
      entry.paths.add(filename);
      ownedPath = filename;
      operation.abort.signal.throwIfAborted();
      entry.files.set(uploadId, { path: filename, name, mime: actualMime });
      return { uploadId, name, mime: actualMime };
    } catch (error) {
      if (ownedPath) await this.removeOwned(entry, ownedPath).catch(() => {});
      throw error;
    } finally {
      req.removeListener("aborted", aborted);
      // destroy(error) schedules its error event; early rejection must still consume it.
      if (req.destroyed || req.aborted)
        req.once("close", () => req.removeListener("error", failed));
      else req.removeListener("error", failed);
      entry.active.delete(operation);
      finish();
    }
  }

  async resolve(jobId: string, uploadId: string): Promise<MuseStoredReference> {
    validateJobId(jobId);
    const entry = this.jobs.get(jobId);
    const file = typeof uploadId === "string" && uploadPattern.test(uploadId) && !entry?.closing ? entry?.files.get(uploadId) : undefined;
    if (!file) throw new MuseReferenceStoreError("本机未找到该任务的参考素材，请重新上传。", 404);
    return { ...file };
  }

  async cleanup(jobId: string): Promise<void> {
    validateJobId(jobId);
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    if (entry.cleanup) return entry.cleanup;
    entry.closing = true;
    entry.cleanup = (async () => {
      for (const operation of entry.active) operation.abort.abort(new Error("Muse 参考素材上传已停止。"));
      await Promise.all([...entry.active].map(operation => operation.done));
      for (const filename of [...entry.paths]) await this.removeOwned(entry, filename);
      entry.files.clear();
      if (entry.directory) {
        // Do not recursively remove a directory: other processes may own files in it.
        try { await fs.rmdir(entry.directory); }
        catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
      if (this.jobs.get(jobId) === entry) this.jobs.delete(jobId);
    })();
    try { await entry.cleanup; } finally { entry.cleanup = undefined; }
  }
}
