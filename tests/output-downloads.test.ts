import { describe, expect, it, vi } from "vitest";
import { createOutputDownloads } from "../src/generation/output-downloads";
import type { RemoteFile } from "../src/types";

const files: RemoteFile[] = Array.from({ length: 6 }, (_, index) => ({ filename: index + ".png", subfolder: "", type: "output", url: "https://cdn.example/" + index + ".png" }));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const pending = files.map(() => deferred<Blob>());
  const fetchFile = vi.fn((file: RemoteFile, _signal: AbortSignal) => pending[Number(file.filename.split(".")[0])].promise);
  const parent = new AbortController();
  return { pending, fetchFile, parent };
}

describe("bounded RunningHub output downloads", () => {
  it("starts lazily and requests the first two files together on the first take", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    expect(fetchFile).not.toHaveBeenCalled();
    const first = downloads.take(files[0]);
    expect(fetchFile.mock.calls.map(call => call[0])).toEqual(files.slice(0, 2));
    pending[0].resolve(new Blob(["first"]));
    expect(await (await first).text()).toBe("first");
    expect(fetchFile.mock.calls.map(call => call[0])).toEqual(files.slice(0, 3));
    downloads.close();
  });
  it("keeps output order when the second request completes before the first", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files.slice(0, 2), fetchFile, parent.signal);
    const first = downloads.take(files[0]);
    let firstReturned = false;
    void first.then(() => { firstReturned = true; });
    pending[1].resolve(new Blob(["second"]));
    await Promise.resolve(); await Promise.resolve();
    expect(firstReturned).toBe(false);
    pending[0].resolve(new Blob(["first"]));
    expect(await (await first).text()).toBe("first");
    expect(await (await downloads.take(files[1])).text()).toBe("second");
    expect(fetchFile).toHaveBeenCalledTimes(2);
    downloads.close();
  });
  it("counts completed but unconsumed blobs against the window instead of eagerly fetching every successor", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    const first = downloads.take(files[0]);
    pending[1].resolve(new Blob(["second"]));
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFile).toHaveBeenCalledTimes(2);
    pending[0].resolve(new Blob(["first"])); await first;
    pending[2].resolve(new Blob(["third"]));
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFile).toHaveBeenCalledTimes(3); // only second and third remain buffered
    expect(await (await downloads.take(files[1])).text()).toBe("second");
    expect(fetchFile).toHaveBeenCalledTimes(4);
    downloads.close();
  });
  it("captures an early successor failure without losing a successfully consumed predecessor", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    const first = downloads.take(files[0]);
    const error = new Error("second download failed");
    pending[1].reject(error);
    // An event-loop turn gives unhandled rejection detection time to run.
    await new Promise(resolve => setTimeout(resolve, 0));
    pending[0].resolve(new Blob(["already downloaded"]));
    const saved = await first;
    expect(await saved.text()).toBe("already downloaded");
    await expect(downloads.take(files[1])).rejects.toBe(error);
    expect(await saved.text()).toBe("already downloaded");
    expect(fetchFile.mock.calls[2][1].aborted).toBe(true);
    pending[2].reject(new Error("late rejection after close"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("accepts a filtered list of missing files and never requests already restored outputs", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads([files[1], files[4]], fetchFile, parent.signal);
    const second = downloads.take(files[1]);
    expect(fetchFile.mock.calls.map(call => call[0])).toEqual([files[1], files[4]]);
    pending[1].resolve(new Blob(["second"])); await second;
    pending[4].resolve(new Blob(["fifth"])); await downloads.take(files[4]);
    expect(fetchFile).toHaveBeenCalledTimes(2);
    downloads.close();
  });
  it("deduplicates outputKey and refuses a second consumption without downloading again", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads([files[0], { ...files[0] }, files[1], files[0]], fetchFile, parent.signal);
    const first = downloads.take(files[0]); pending[0].resolve(new Blob(["first"])); await first;
    pending[1].resolve(new Blob(["second"])); await downloads.take(files[1]);
    await expect(downloads.take(files[0])).rejects.toThrow(/一次/);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
  it("honors a one-slot limit and clamps larger limits to two", async () => {
    for (const limit of [1, 99]) {
      const { pending, fetchFile, parent } = fixture();
      const downloads = createOutputDownloads(files, fetchFile, parent.signal, limit);
      const first = downloads.take(files[0]);
      expect(fetchFile).toHaveBeenCalledTimes(limit === 1 ? 1 : 2);
      pending[0].resolve(new Blob(["first"])); await first;
      expect(fetchFile).toHaveBeenCalledTimes(limit === 1 ? 2 : 3);
      downloads.close();
    }
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid limit before downloading: %s", limit => {
    const { fetchFile, parent } = fixture();
    expect(() => createOutputDownloads(files, fetchFile, parent.signal, limit)).toThrow(RangeError);
    expect(fetchFile).not.toHaveBeenCalled();
  });
  it("parent abort cancels all requests and promptly rejects take even if a transport ignores abort", async () => {
    const { pending, fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    const first = downloads.take(files[0]);
    parent.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFile.mock.calls.every(call => call[1].aborted)).toBe(true);
    pending[0].resolve(new Blob(["too late"])); pending[1].reject(new Error("late failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(downloads.take(files[1])).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
  it("does not start work for an already aborted parent or a window closed before its first take", async () => {
    for (const parentAborted of [false, true]) {
      const { fetchFile, parent } = fixture();
      if (parentAborted) parent.abort();
      const downloads = createOutputDownloads(files, fetchFile, parent.signal);
      if (!parentAborted) { downloads.close(); downloads.close(); }
      await expect(downloads.take(files[0])).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchFile).not.toHaveBeenCalled();
    }
  });
  it("does not start a successor if the parent is aborted synchronously while starting a download", async () => {
    const parent = new AbortController(), pending = deferred<Blob>();
    const fetchFile = vi.fn((_file: RemoteFile, _signal: AbortSignal) => { parent.abort(); return pending.promise; });
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    await expect(downloads.take(files[0])).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile.mock.calls[0][1].aborted).toBe(true);
    pending.reject(new Error("late failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("close cancels outstanding requests, releases the parent listener and stops further prefetch", async () => {
    const { pending, fetchFile, parent } = fixture();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    const first = downloads.take(files[0]);
    downloads.close();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(fetchFile.mock.calls.every(call => call[1].aborted)).toBe(true);
    pending[0].resolve(new Blob(["late"])); pending[1].resolve(new Blob(["late"]));
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
  it("settles synchronous transport errors and cancels its prefetched sibling", async () => {
    const parent = new AbortController(), failure = new Error("synchronous failure");
    const fetchFile = vi.fn((_file: RemoteFile, _signal: AbortSignal): Promise<Blob> => { throw failure; });
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    await expect(downloads.take(files[0])).rejects.toBe(failure);
    expect(fetchFile.mock.calls.every(call => call[1].aborted)).toBe(true);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
  it("rejects out-of-order or overlapping take calls rather than duplicating consumption", async () => {
    const { fetchFile, parent } = fixture();
    const downloads = createOutputDownloads(files, fetchFile, parent.signal);
    await expect(downloads.take(files[1])).rejects.toThrow(/顺序/);
    expect(fetchFile).not.toHaveBeenCalled();
    const other = createOutputDownloads(files, fetchFile, parent.signal);
    const first = other.take(files[0]);
    await expect(other.take(files[0])).rejects.toThrow(/顺序/);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
});
