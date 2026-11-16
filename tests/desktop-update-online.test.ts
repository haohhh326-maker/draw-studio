import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSoftwareUpdates } = require("../scripts/desktop-updates.cjs");
const folders: string[] = [];
const defaultFeedUrl = "https://release.example.test/draw/manifest.json";
const overrideFeedUrl = "https://custom.example.test/releases/latest.json";
const downloadUrl = "https://release.example.test/draw/Draw-studio-Setup.exe";
const bytes = Buffer.from("MZsynthetic-online-installer-fixture-only");
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const manifest = (body = bytes) => ({ version: "0.2.0", notes: "Online fixture notes", windows: { url: downloadUrl, sha256: sha256(body), size: body.length } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(options: { defaultFeed?: string; overrideFeed?: string } = { defaultFeed: defaultFeedUrl }) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "canvas-online-update-test-"));
  folders.push(userData);
  if (options.overrideFeed) await writeFile(path.join(userData, "software-update.json"), JSON.stringify({ feedUrl: options.overrideFeed }));
  const app = { getVersion: vi.fn(() => "0.1.0"), quit: vi.fn() };
  const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) };
  const beforeInstall = vi.fn(async () => {});
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const fetcher = vi.fn(async (url: URL | string) => String(url) === downloadUrl
    ? new Response(bytes, { headers: { "content-length": String(bytes.length) } }) : Response.json(manifest()));
  const updates = createSoftwareUpdates({ app, dialog, userData, owner: () => ({}), beforeInstall, fetcher, launch, defaultFeedUrl: options.defaultFeed });
  const directory = path.join(userData, "updates", "0.2.0");
  const file = path.join(directory, "Draw-studio-Setup.exe");
  return { userData, directory, file, updates, app, dialog, beforeInstall, fetcher, launch,
    downloads: () => fetcher.mock.calls.filter(([url]) => String(url) === downloadUrl) };
}
afterEach(async () => {
  await settle();
  for (const folder of folders.splice(0)) {
    const resolved = path.resolve(folder);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("canvas-online-update-test-"))
      throw new Error("Refusing to remove an unrelated test directory.");
    await rm(resolved, { recursive: true, force: true });
  }
});

describe("in-application online software updates", () => {
  it("checks the bundled feed without asking for a local installer", async () => {
    const context = await fixture();
    expect(context.updates.getStatus()).toMatchObject({ currentVersion: "0.1.0", phase: "idle", downloadedBytes: 0 });
    expect(await context.updates.check()).toMatchObject({ configured: true, available: true, currentVersion: "0.1.0", latestVersion: "0.2.0" });
    expect(String(context.fetcher.mock.calls[0][0])).toBe(defaultFeedUrl);
    expect(context.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(context.launch).not.toHaveBeenCalled();
  });

  it("preserves the user's configured feed over the bundled default", async () => {
    const context = await fixture({ defaultFeed: defaultFeedUrl, overrideFeed: overrideFeedUrl });
    await context.updates.check();
    expect(context.fetcher.mock.calls.map(([url]) => String(url))).toEqual([overrideFeedUrl]);
  });

  it.each([{}, { feedUrl: "  " }])("uses the bundled source when the saved override has no value %#", async configuration => {
    const context = await fixture();
    await writeFile(path.join(context.userData, "software-update.json"), JSON.stringify(configuration));
    expect(await context.updates.check()).toMatchObject({ configured: true, available: true });
    expect(context.fetcher.mock.calls.map(([url]) => String(url))).toEqual([defaultFeedUrl]);
  });

  it("reports a missing release source without offering a local installer or starting one", async () => {
    const context = await fixture({});
    const status = await context.updates.check();
    expect(status).toMatchObject({ configured: false, available: false });
    expect(status.message).not.toMatch(/选择.*安装包|本地安装包/);
    await expect(context.updates.downloadAndInstall()).rejects.toThrow();
    expect(context.fetcher).not.toHaveBeenCalled();
    expect(context.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(context.launch).not.toHaveBeenCalled();
  });

  it("shares a pending manifest check with another check and an install request", async () => {
    const context = await fixture();
    const response = deferred<Response>();
    context.fetcher.mockImplementation(async url => String(url) === downloadUrl ? new Response(bytes) : response.promise);
    const first = context.updates.check();
    await vi.waitFor(() => expect(context.fetcher).toHaveBeenCalledTimes(1));
    expect(context.updates.getStatus().phase).toBe("checking");
    const second = context.updates.check();
    const install = context.updates.downloadAndInstall();
    await settle();
    expect(context.fetcher).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(manifest()));
    await Promise.all([first, second, install]);
    await settle();
    expect(context.downloads()).toHaveLength(1);
    expect(context.beforeInstall).toHaveBeenCalledTimes(1);
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
  });

  it("exposes byte progress, keeps an active download through checking, then saves before installation", async () => {
    const context = await fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const saved = deferred<void>();
    context.beforeInstall.mockImplementation(async () => saved.promise);
    context.fetcher.mockImplementation(async url => String(url) === downloadUrl
      ? new Response(stream, { headers: { "content-length": String(bytes.length) } }) : Response.json(manifest()));
    await context.updates.check();
    const install = context.updates.downloadAndInstall();
    await vi.waitFor(() => expect(context.downloads()).toHaveLength(1));
    const split = 12;
    controller.enqueue(bytes.subarray(0, split));
    await vi.waitFor(() => expect(context.updates.getStatus()).toMatchObject({ phase: "downloading", downloadedBytes: split, totalBytes: bytes.length }));
    const partial = context.updates.getStatus();
    expect(partial.percent).toBeGreaterThan(0);
    expect(partial.percent).toBeLessThan(100);
    expect(await context.updates.check()).toMatchObject({ phase: "downloading", downloadedBytes: split });
    expect(context.fetcher).toHaveBeenCalledTimes(2);
    await expect(access(context.file)).rejects.toMatchObject({ code: "ENOENT" });
    controller.enqueue(bytes.subarray(split)); controller.close();
    await vi.waitFor(() => expect(context.beforeInstall).toHaveBeenCalledTimes(1));
    expect(context.updates.getStatus()).toMatchObject({ phase: "saving", downloadedBytes: bytes.length });
    expect(partial.downloadedBytes).toBe(split);
    expect(context.launch).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
    expect(await readFile(context.file)).toEqual(bytes);
    saved.resolve(undefined);
    await install; await settle();
    expect(context.updates.getStatus().phase).toBe("installing");
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
    expect(context.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("shows received bytes without an invented total when neither response nor manifest provides size", async () => {
    const context = await fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const data = manifest();
    const { size: _, ...windows } = data.windows;
    context.fetcher.mockImplementation(async url => String(url) === downloadUrl ? new Response(stream) : Response.json({ ...data, windows }));
    const install = context.updates.downloadAndInstall();
    await vi.waitFor(() => expect(context.downloads()).toHaveLength(1));
    controller.enqueue(bytes.subarray(0, 10));
    await vi.waitFor(() => expect(context.updates.getStatus().downloadedBytes).toBe(10));
    const state = context.updates.getStatus();
    expect(state.phase).toBe("downloading");
    expect(state.totalBytes).toBeUndefined();
    expect(state.percent).toBeUndefined();
    controller.enqueue(bytes.subarray(10)); controller.close();
    await install;
  });

  it("shares one active download with repeated online and legacy install requests", async () => {
    const context = await fixture();
    const response = deferred<Response>();
    await context.updates.check();
    context.fetcher.mockImplementation(async () => response.promise);
    const first = context.updates.downloadAndInstall();
    await vi.waitFor(() => expect(context.downloads()).toHaveLength(1));
    const second = context.updates.downloadAndInstall(), legacy = context.updates.install();
    await settle();
    expect(context.dialog.showOpenDialog).not.toHaveBeenCalled();
    response.resolve(new Response(bytes));
    await Promise.all([first, second, legacy]); await settle();
    expect(context.beforeInstall).toHaveBeenCalledTimes(1);
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
  });

  it("removes a hash-matching non-executable before publishing its final filename", async () => {
    const context = await fixture();
    const invalid = Buffer.from("not a Windows executable");
    context.fetcher.mockImplementation(async url => String(url) === downloadUrl ? new Response(invalid) : Response.json(manifest(invalid)));
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("安装程序");
    expect(context.updates.getStatus().phase).toBe("error");
    expect(await readdir(context.directory)).toEqual([]);
    expect(context.beforeInstall).not.toHaveBeenCalled();
    expect(context.launch).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
  });

  it.each(["checksum", "length"])("cleans the partial file and never installs after %s verification failure", async failure => {
    const context = await fixture();
    const data = manifest();
    if (failure === "checksum") data.windows.sha256 = sha256(Buffer.from("different bytes"));
    else data.windows.size += 10;
    context.fetcher.mockImplementation(async url => String(url) === downloadUrl ? new Response(bytes) : Response.json(data));
    await expect(context.updates.downloadAndInstall()).rejects.toThrow();
    expect(context.updates.getStatus()).toMatchObject({ phase: "error", available: true });
    expect(context.updates.getStatus().error).toBeTruthy();
    expect(await readdir(context.directory)).toEqual([]);
    expect(context.beforeInstall).not.toHaveBeenCalled();
    expect(context.launch).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
  });

  it.each(["save", "spawn"])("keeps the verified package and retries without downloading again after %s fails", async failure => {
    const context = await fixture();
    if (failure === "save") context.beforeInstall.mockRejectedValueOnce(new Error("fixture save failed"));
    else context.launch.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("error", new Error("fixture spawn failed")));
      return child;
    });
    await expect(context.updates.downloadAndInstall()).rejects.toThrow(`fixture ${failure} failed`);
    await settle();
    expect(context.updates.getStatus().phase).toBe("error");
    expect(context.app.quit).not.toHaveBeenCalled();
    expect(await readFile(context.file)).toEqual(bytes);
    expect(await readdir(context.directory)).toEqual(["Draw-studio-Setup.exe"]);
    await context.updates.downloadAndInstall(); await settle();
    expect(context.downloads()).toHaveLength(1);
    expect(context.beforeInstall).toHaveBeenCalledTimes(2);
    expect(context.launch).toHaveBeenCalledTimes(failure === "save" ? 1 : 2);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
  });

  it("cleans an interrupted stream, reports its error and allows a fresh download retry", async () => {
    const context = await fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    let first = true;
    context.fetcher.mockImplementation(async url => {
      if (String(url) !== downloadUrl) return Response.json(manifest());
      if (first) { first = false; return new Response(stream); }
      return new Response(bytes);
    });
    const installation = context.updates.downloadAndInstall();
    const rejected = expect(installation).rejects.toThrow("fixture connection interrupted");
    await vi.waitFor(() => expect(context.downloads()).toHaveLength(1));
    controller.enqueue(bytes.subarray(0, 8));
    await vi.waitFor(() => expect(context.updates.getStatus().downloadedBytes).toBe(8));
    controller.error(new Error("fixture connection interrupted"));
    await rejected;
    expect(context.updates.getStatus()).toMatchObject({ phase: "error", error: "fixture connection interrupted" });
    expect(await readdir(context.directory)).toEqual([]);
    expect(context.beforeInstall).not.toHaveBeenCalled();
    expect(context.app.quit).not.toHaveBeenCalled();
    await context.updates.downloadAndInstall(); await settle();
    expect(context.downloads()).toHaveLength(2);
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
  });

  it("revalidates a retained installer and redownloads a changed cache instead of launching it", async () => {
    const context = await fixture();
    context.beforeInstall.mockRejectedValueOnce(new Error("fixture save failed"));
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("fixture save failed");
    await writeFile(context.file, Buffer.from("MZtampered-cache"));
    await context.updates.downloadAndInstall(); await settle();
    expect(context.downloads()).toHaveLength(2);
    expect(await readFile(context.file)).toEqual(bytes);
    expect(context.launch).toHaveBeenCalledTimes(1);
    expect(context.app.quit).toHaveBeenCalledTimes(1);
  });
});
