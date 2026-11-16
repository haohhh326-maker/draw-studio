import { outputKey } from "../comfyui/files";
import type { RemoteFile } from "../types";

type DownloadResult = { ok: true; blob: Blob } | { ok: false; error: unknown };
export type OutputDownloads = {
  /** Consume each needed file once, in the supplied output order. */
  take(file: RemoteFile): Promise<Blob>;
  close(): void;
};

/**
 * RH-only prefetch window. Callers supply only files missing from local storage.
 * Construction is lazy; at most two unconsumed results are retained. Importing
 * and saving remain the caller's ordered, durable operations after each take.
 */
export function createOutputDownloads(
  files: readonly RemoteFile[],
  fetchFile: (file: RemoteFile, signal: AbortSignal) => Promise<Blob>,
  parentSignal: AbortSignal,
  limit = 2,
): OutputDownloads {
  if (!Number.isFinite(limit) || limit <= 0) throw new RangeError("结果下载并发数必须大于零。");
  const capacity = Math.max(1, Math.min(2, Math.floor(limit)));
  const unique = new Map<string, RemoteFile>();
  for (const file of files) {
    const key = outputKey(file);
    if (!unique.has(key)) unique.set(key, { ...file });
  }
  const needed = [...unique].map(([key, file]) => ({ key, file }));
  const controller = new AbortController();
  const window = new Map<string, Promise<DownloadResult>>();
  let nextStart = 0, nextTake = 0, taking = false, closed = false;
  let stop!: (result: DownloadResult) => void;
  const stopped = new Promise<DownloadResult>(resolve => { stop = resolve; });
  const abortError = () => new DOMException("结果下载已中断。", "AbortError");

  function close() {
    if (closed) return;
    closed = true;
    parentSignal.removeEventListener("abort", close);
    controller.abort();
    stop({ ok: false, error: abortError() });
    window.clear();
  }

  function fill() {
    while (!closed && window.size < capacity && nextStart < needed.length) {
      const { key, file } = needed[nextStart++];
      let download: Promise<Blob>;
      try { download = Promise.resolve(fetchFile(file, controller.signal)); }
      catch (error) { download = Promise.reject(error); }
      // Attach rejection handling immediately, including failures in a successor
      // that the consumer has not reached yet. Completed blobs still occupy slots.
      const settled = download.then<DownloadResult, DownloadResult>(
        blob => ({ ok: true, blob }),
        error => ({ ok: false, error }),
      );
      if (!closed) window.set(key, settled);
    }
  }

  parentSignal.addEventListener("abort", close, { once: true });
  if (parentSignal.aborted) close();

  return {
    async take(file) {
      if (closed) throw abortError();
      let key: string;
      try { key = outputKey(file); }
      catch (error) { close(); throw error; }
      if (taking || needed[nextTake]?.key !== key) {
        close();
        throw new Error("请按输出顺序逐个读取需要下载的结果，每个文件只读取一次。");
      }
      taking = true;
      try {
        fill();
        const result = await Promise.race([window.get(key)!, stopped]);
        if (closed) throw abortError();
        if (!result.ok) { close(); throw result.error; }
        window.delete(key);
        nextTake++;
        fill();
        if (nextTake === needed.length) parentSignal.removeEventListener("abort", close);
        return result.blob;
      } finally { taking = false; }
    },
    close,
  };
}
