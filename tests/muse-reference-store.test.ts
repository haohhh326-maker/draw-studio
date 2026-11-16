import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { Readable, PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { MuseReferenceStore } from "../scripts/muse-reference-store";
import { sniffMuseMedia } from "../scripts/muse-browser-service";

let root: string;
const job = "muse-upload-job-001";
const otherJob = "muse-upload-job-002";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const video = () => ({ mime: "video/mp4", ext: "mp4" });
function request(chunks: Buffer[]): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers: {}, aborted: false }) as unknown as IncomingMessage;
}
function unfinished(): IncomingMessage & PassThrough {
  return Object.assign(new PassThrough(), { headers: {}, aborted: false }) as unknown as IncomingMessage & PassThrough;
}
async function files(directory = root): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "draw-muse-reference-test-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved).toLowerCase() === (await fs.realpath(os.tmpdir())).toLowerCase() && path.basename(resolved).startsWith("draw-muse-reference-test-")) await fs.rm(resolved, { recursive: true, force: true });
});

describe("streamed Muse reference storage", () => {
  it.each([
    { name: "clip.mp4", mime: "video/mp4", header: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(12)]) },
    { name: "clip.mov", mime: "video/quicktime", header: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  "), Buffer.alloc(12)]) },
    { name: "clip.webm", mime: "video/webm", header: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm"), Buffer.alloc(12)]) },
  ])("recognizes $name container headers and retains the original uploaded bytes", async ({ name, mime, header }) => {
    const store = new MuseReferenceStore(root, sniffMuseMedia);
    const saved = await store.save(job, request([header]), name, mime);
    const resolved = await store.resolve(job, saved.uploadId);
    expect(saved.mime).toBe(mime);
    expect(path.extname(saved.name)).toBe(path.extname(name));
    expect(await fs.readFile(resolved.path)).toEqual(header);
    await store.cleanup(job);
  });
  it("streams all chunks but gives sniffing only the first 64 KiB", async () => {
    const chunks = [Buffer.alloc(35_000, 1), Buffer.alloc(35_000, 2), Buffer.alloc(35_000, 3)];
    const expected = Buffer.concat(chunks);
    const sniff = vi.fn((_header: Buffer, _mime: string) => video());
    const store = new MuseReferenceStore(root, sniff);
    const saved = await store.save(job, request(chunks), "clip.mp4", "video/mp4");
    const resolved = await store.resolve(job, saved.uploadId);
    expect(await fs.readFile(resolved.path)).toEqual(expected);
    expect(sniff).toHaveBeenCalledTimes(1);
    expect(sniff.mock.calls[0][0]).toEqual(expected.subarray(0, 65_536));
    expect(sniff.mock.calls[0][1]).toBe("video/mp4");
    expect(resolved.mime).toBe("video/mp4");
  });
  it("uses UUID tokens and canonical safe filenames regardless of the incoming name", async () => {
    const store = new MuseReferenceStore(root, video);
    const saved = await store.save(job, request([Buffer.from("video")]), "../../outside\\private:clip.mp4", "video/mp4");
    expect(saved.uploadId).toMatch(uuid);
    expect(saved.name).toBe(`reference-${saved.uploadId}.mp4`);
    const resolved = await store.resolve(job, saved.uploadId);
    expect(resolved.name).toBe(saved.name);
    expect(path.basename(resolved.path)).toBe(saved.name);
    const relative = path.relative(root, resolved.path);
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative.split(path.sep)).toContain(job);
  });
  it("binds each upload to one job and one manifest instance", async () => {
    const store = new MuseReferenceStore(root, video);
    const saved = await store.save(job, request([Buffer.from("video")]), "clip.mp4", "video/mp4");
    await expect(Promise.resolve().then(() => store.resolve(otherJob, saved.uploadId))).rejects.toThrow();
    await expect(Promise.resolve().then(() => store.resolve(job, "00000000-0000-0000-0000-000000000000"))).rejects.toThrow();
    await expect(Promise.resolve().then(() => store.resolve(job, "../../secrets"))).rejects.toThrow();
    const newInstance = new MuseReferenceStore(root, video);
    await expect(Promise.resolve().then(() => newInstance.resolve(job, saved.uploadId))).rejects.toThrow();
    expect((await store.resolve(job, saved.uploadId)).mime).toBe("video/mp4");
  });
  it("accepts matching image, audio and video categories", async () => {
    for (const media of [{ mime: "image/png", ext: "png" }, { mime: "audio/wav", ext: "wav" }, { mime: "video/mp4", ext: "mp4" }]) {
      const store = new MuseReferenceStore(root, () => media);
      const saved = await store.save(job, request([Buffer.from("known header")]), "input", media.mime);
      expect(saved.mime).toBe(media.mime);
      expect((await store.resolve(job, saved.uploadId)).name.endsWith(`.${media.ext}`)).toBe(true);
    }
  });
  it("rejects unsafe job ids before writing outside the owned root", async () => {
    const store = new MuseReferenceStore(root, video);
    for (const id of ["short", "../other-job", "a".repeat(101), "job /id invalid", "C:\\outside"]) await expect(store.save(id, request([Buffer.from("video")]), "clip.mp4", "video/mp4")).rejects.toThrow();
    expect(await files()).toEqual([]);
  });
  it("removes empty, unrecognized, category-mismatched and unsupported inputs", async () => {
    for (const test of [
      { content: [], mime: "video/mp4", sniff: video },
      { content: [Buffer.from("<html>not media</html>")], mime: "video/mp4", sniff: () => undefined },
      { content: [Buffer.from("audio header")], mime: "image/png", sniff: () => ({ mime: "audio/wav", ext: "wav" }) },
      { content: [Buffer.from("other")], mime: "application/octet-stream", sniff: video },
    ]) {
      const store = new MuseReferenceStore(root, test.sniff);
      await expect(store.save(job, request(test.content), "input", test.mime)).rejects.toThrow();
      expect(await files()).toEqual([]);
    }
  });
  it.each(["error", "aborted"])("removes partial files after request %s", async event => {
    const store = new MuseReferenceStore(root, video);
    const source = unfinished();
    const rejected = expect(store.save(job, source, "clip.mp4", "video/mp4")).rejects.toThrow();
    await expect.poll(() => source.listenerCount("error")).toBeGreaterThan(0);
    source.write(Buffer.alloc(512, 1));
    if (event === "error") source.destroy(new Error("synthetic stream error"));
    else { source.aborted = true; source.emit("aborted"); }
    await rejected;
    expect(await files()).toEqual([]);
    source.destroy();
  });
  it("handles an immediate asynchronous request error while opening the destination", async () => {
    const store = new MuseReferenceStore(root, video);
    const source = unfinished();
    const saving = store.save(job, source, "clip.mp4", "video/mp4");
    const rejected = expect(saving).rejects.toThrow("early synthetic stream error");
    expect(source.listenerCount("error")).toBeGreaterThan(0);
    // Runs before mkdir/realpath complete, before pipeline can install stream listeners.
    queueMicrotask(() => source.destroy(new Error("early synthetic stream error")));
    await rejected;
    expect(await files()).toEqual([]);
  });
  it("retains an error listener until an already-destroyed request finishes closing", async () => {
    const store = new MuseReferenceStore(root, video);
    const source = unfinished();
    // destroy schedules its error for the next tick; save rejects before that tick.
    source.destroy(new Error("scheduled before save"));
    const saving = store.save(job, source, "clip.mp4", "video/mp4");
    const rejected = expect(saving).rejects.toThrow();
    const guardedBeforeErrorEvent = source.listenerCount("error") > 0;
    await rejected;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(guardedBeforeErrorEvent).toBe(true);
    expect(source.closed).toBe(true);
    expect(source.listenerCount("error")).toBe(0);
    expect(await files()).toEqual([]);
  });
  it("cleanup cancels an in-progress save and invalidates completed tokens", async () => {
    const store = new MuseReferenceStore(root, video);
    const saved = await store.save(job, request([Buffer.from("complete")]), "complete.mp4", "video/mp4");
    const source = unfinished();
    const rejected = expect(store.save(job, source, "partial.mp4", "video/mp4")).rejects.toThrow();
    await expect.poll(() => source.listenerCount("error")).toBeGreaterThan(0);
    source.write(Buffer.alloc(512, 1));
    await store.cleanup(job);
    await rejected;
    await expect(Promise.resolve().then(() => store.resolve(job, saved.uploadId))).rejects.toThrow();
    expect(await files()).toEqual([]);
    source.destroy();
  });
});
