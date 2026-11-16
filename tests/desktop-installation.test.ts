import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { copyMissing, prepareWorkspace } = require("../scripts/desktop-workspace.cjs") as {
  copyMissing(source: string, destination: string): Promise<void>;
  prepareWorkspace(resources: string, userData: string): Promise<string>;
};
const { createSoftwareUpdates, newer } = require("../scripts/desktop-updates.cjs");
const folders: string[] = [];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const installerBytes = Buffer.from("MZsynthetic-installer-for-tests-only");
const feedUrl = "https://updates.example.test/draw/manifest.json";
const downloadUrl = "https://updates.example.test/draw/releases/Draw-studio-0.2.0.exe";
const manifest = () => ({ version: "0.2.0", notes: "Fixture release notes", windows: { url: "releases/Draw-studio-0.2.0.exe", sha256: sha256(installerBytes) } });
afterEach(async () => {
  await settle();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function temporary() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "canvas-installation-test-")); folders.push(folder); return folder;
}
async function workspaceFixture() {
  const folder = await temporary(), resources = path.join(folder, "resources"), userData = path.join(folder, "user-data");
  for (const name of ["library", "prompt", "skills", "comfyui_nodes", "loras", "cloud_upload", "nested/empty"])
    await mkdir(path.join(resources, "seed", "workflows", name), { recursive: true });
  await writeFile(path.join(resources, "seed", "workflows", "prompt", "SKILL.md"), "original skill fixture");
  await writeFile(path.join(resources, "prompt-optimization.defaults.json"), JSON.stringify({ language: "zh", maxTokens: 10_000, contextTokens: 100_000 }));
  await mkdir(path.join(resources, "seed", ".cache", "native-filezilla-official", "bridge"), { recursive: true });
  await writeFile(path.join(resources, "seed", ".cache", "native-filezilla-official", "bridge", "cloud-transfer-bridge"), "synthetic-engine-resource");
  return { folder, resources, userData };
}
async function updateFixture(configured = true) {
  const userData = await temporary(), owner = {};
  if (configured) await writeFile(path.join(userData, "software-update.json"), JSON.stringify({ feedUrl }));
  const app = { getVersion: vi.fn(() => "0.1.0"), quit: vi.fn() };
  const dialog = { showOpenDialog: vi.fn(async (_owner: unknown, _options: unknown) => ({ canceled: true, filePaths: [] as string[] })) };
  const beforeInstall = vi.fn(async () => undefined);
  const launch = vi.fn((_file: string, _args: string[], _options: unknown) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn")); return child;
  });
  const fetcher = vi.fn(async (input: URL | string) => String(input) === feedUrl
    ? Response.json(manifest()) : new Response(installerBytes));
  const updates = createSoftwareUpdates({ app, dialog, userData, owner: () => owner, beforeInstall, fetcher, launch });
  return { userData, owner, app, dialog, beforeInstall, launch, fetcher, updates };
}
async function localInstaller(userData: string, name = "fixture.exe", bytes = installerBytes) {
  const file = path.join(userData, name); await writeFile(file, bytes); return file;
}

describe("desktop installation workspace seeding", () => {
  it("creates the packaged directory tree and writable local settings on the first launch", async () => {
    const { resources, userData } = await workspaceFixture();
    const workspace = await prepareWorkspace(resources, userData);
    expect(workspace).toBe(path.join(userData, "workspace"));
    for (const name of ["library", "prompt", "skills", "comfyui_nodes", "loras", "cloud_upload", "nested/empty"])
      expect((await stat(path.join(workspace, "workflows", name))).isDirectory()).toBe(true);
    expect(await readdir(path.join(workspace, "workflows", "nested", "empty"))).toEqual([]);
    expect(await readFile(path.join(workspace, ".cache", "native-filezilla-official", "bridge", "cloud-transfer-bridge"), "utf8")).toBe("synthetic-engine-resource");
    expect(JSON.parse(await readFile(path.join(workspace, "workflow-library.settings.json"), "utf8"))).toEqual({ sourcePath: path.join(workspace, "workflows", "library") });
    expect(JSON.parse(await readFile(path.join(workspace, "prompt-optimization.settings.json"), "utf8"))).toEqual({ language: "zh", maxTokens: 10_000, contextTokens: 100_000, skillDirectory: path.join(workspace, "workflows", "prompt") });
  });
  it("preserves user edits and custom settings on repeat launches while adding missing resources", async () => {
    const { resources, userData } = await workspaceFixture();
    const workspace = await prepareWorkspace(resources, userData), skill = path.join(workspace, "workflows", "prompt", "SKILL.md");
    const custom = { language: "en", skillDirectory: path.join(workspace, "custom-skills"), maxTokens: 9000 };
    await writeFile(skill, "user-edited skill");
    await writeFile(path.join(workspace, "prompt-optimization.settings.json"), JSON.stringify(custom));
    await writeFile(path.join(workspace, "workflow-library.settings.json"), JSON.stringify({ sourcePath: "custom-workflow-path" }));
    await writeFile(path.join(resources, "seed", "workflows", "prompt", "SKILL.md"), "new bundled default");
    await mkdir(path.join(resources, "seed", "workflows", "new-empty"));
    await writeFile(path.join(resources, "seed", "workflows", "new-workflow.json"), '{"fixture":true}');
    await Promise.all([prepareWorkspace(resources, userData), prepareWorkspace(resources, userData)]);
    expect(await readFile(skill, "utf8")).toBe("user-edited skill");
    expect(JSON.parse(await readFile(path.join(workspace, "prompt-optimization.settings.json"), "utf8"))).toEqual(custom);
    expect(JSON.parse(await readFile(path.join(workspace, "workflow-library.settings.json"), "utf8"))).toEqual({ sourcePath: "custom-workflow-path" });
    expect(await readdir(path.join(workspace, "workflows", "new-empty"))).toEqual([]);
    expect(await readFile(path.join(workspace, "workflows", "new-workflow.json"), "utf8")).toBe('{"fixture":true}');
  });
  it("creates the standard writable folders when the installer omits empty seed directories", async () => {
    const { resources, userData } = await workspaceFixture();
    for (const name of ["library", "skills", "comfyui_nodes", "loras", "cloud_upload"])
      await rm(path.join(resources, "seed", "workflows", name), { recursive: true, force: true });
    const workspace = await prepareWorkspace(resources, userData);
    for (const name of ["library", "prompt", "skills", "comfyui_nodes", "loras", "cloud_upload"])
      expect((await stat(path.join(workspace, "workflows", name))).isDirectory()).toBe(true);
  });
  it("rejects a linked seed directory instead of following it into unrelated files", async () => {
    const { folder, resources, userData } = await workspaceFixture();
    const outside = path.join(folder, "outside"); await mkdir(outside); await writeFile(path.join(outside, "private.txt"), "fixture private data");
    await symlink(outside, path.join(resources, "seed", "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyMissing(path.join(resources, "seed"), userData)).rejects.toThrow("文件链接");
    await expect(access(path.join(userData, "linked", "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Windows software update preparation", () => {
  it("compares numeric versions and rejects malformed version strings", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true); expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false); expect(newer("0.0.9", "0.1.0")).toBe(false);
    expect(() => newer("0.2.0-beta", "0.1.0")).toThrow(); expect(() => newer("../../1", "0.1.0")).toThrow();
  });
  it("reports an unconfigured update feed and leaves a canceled local selection untouched", async () => {
    const context = await updateFixture(false);
    expect(await context.updates.check()).toMatchObject({ currentVersion: "0.1.0", available: false, configured: false });
    expect(await context.updates.install()).toEqual({ canceled: true });
    await settle();
    expect(context.dialog.showOpenDialog).toHaveBeenCalledWith(context.owner, expect.objectContaining({ properties: ["openFile"] }));
    expect(context.fetcher).not.toHaveBeenCalled(); expect(context.beforeInstall).not.toHaveBeenCalled(); expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("checks a valid manifest without starting installation and resolves its relative installer URL", async () => {
    const context = await updateFixture();
    expect(await context.updates.check()).toMatchObject({ currentVersion: "0.1.0", latestVersion: "0.2.0", available: true, configured: true, releaseNotes: "Fixture release notes", phase: "idle", message: "发现新版本，可下载安装更新。" });
    expect(String(context.fetcher.mock.calls[0][0])).toBe(feedUrl); expect(context.launch).not.toHaveBeenCalled(); expect(context.beforeInstall).not.toHaveBeenCalled();
    await context.updates.downloadAndInstall(); await settle();
    expect(String(context.fetcher.mock.calls[1][0])).toBe(downloadUrl);
    expect(context.launch).toHaveBeenCalledWith(path.join(context.userData, "updates", "0.2.0", "Draw-studio-Setup.exe"), [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    expect(context.beforeInstall).toHaveBeenCalledTimes(1); expect(context.app.quit).toHaveBeenCalledTimes(1);
  });
  it.each([
    { version: "0.2.0", windows: { sha256: sha256(installerBytes) } },
    { version: "0.2.0", windows: { url: "", sha256: sha256(installerBytes) } },
    { version: "0.2.0", windows: { url: "http://updates.example.test/setup.exe", sha256: sha256(installerBytes) } },
    { version: "0.2.0", windows: { url: "https://user:password@updates.example.test/setup.exe", sha256: sha256(installerBytes) } },
    { version: "0.2.0", windows: { url: downloadUrl, sha256: "invalid-hash" } },
    { version: "../malformed", windows: { url: downloadUrl, sha256: sha256(installerBytes) } },
  ])("rejects malformed update manifest %# before download or final save", async invalid => {
    const context = await updateFixture(); context.fetcher.mockResolvedValueOnce(Response.json(invalid));
    await expect(context.updates.check()).rejects.toThrow();
    expect(context.fetcher).toHaveBeenCalledTimes(1); expect(context.beforeInstall).not.toHaveBeenCalled(); expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("rejects a non-HTTPS feed before making a request", async () => {
    const context = await updateFixture();
    await writeFile(path.join(context.userData, "software-update.json"), JSON.stringify({ feedUrl: "http://updates.example.test/manifest.json" }));
    await expect(context.updates.check()).rejects.toThrow("HTTPS"); expect(context.fetcher).not.toHaveBeenCalled();
  });
  it("never downloads an older or equal release", async () => {
    const context = await updateFixture(); context.fetcher.mockImplementation(async () => Response.json({ ...manifest(), version: "0.1.0" }));
    expect(await context.updates.check()).toMatchObject({ available: false });
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("没有可下载");
    expect(context.fetcher.mock.calls.every(([url]) => String(url) === feedUrl)).toBe(true); expect(context.launch).not.toHaveBeenCalled();
  });
  it("clears a previously available release when the latest feed check fails", async () => {
    const context = await updateFixture(); await context.updates.check();
    context.fetcher.mockRejectedValue(new Error("synthetic offline feed"));
    await expect(context.updates.check()).rejects.toThrow("offline");
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("offline");
    expect(String(context.fetcher.mock.calls.at(-1)![0])).toBe(feedUrl);
    expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("validates SHA-256 before final save or installer execution and removes the partial download", async () => {
    const context = await updateFixture();
    context.fetcher.mockImplementation(async input => String(input) === feedUrl ? Response.json({ ...manifest(), windows: { url: downloadUrl, sha256: sha256(Buffer.from("different fixture")) } }) : new Response(installerBytes));
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("校验失败");
    expect(await readdir(path.join(context.userData, "updates", "0.2.0"))).toEqual([]);
    expect(context.beforeInstall).not.toHaveBeenCalled(); expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("rejects downloaded bytes without an MZ header even when their hash matches", async () => {
    const context = await updateFixture(), invalid = Buffer.from("synthetic HTML error response");
    context.fetcher.mockImplementation(async input => String(input) === feedUrl ? Response.json({ ...manifest(), windows: { url: downloadUrl, sha256: sha256(invalid) } }) : new Response(invalid));
    await expect(context.updates.downloadAndInstall()).rejects.toThrow("安装程序");
    expect(context.beforeInstall).not.toHaveBeenCalled(); expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it.each([["fixture.txt", installerBytes], ["fixture.exe", Buffer.from("invalid executable")]] as const)("checks local installer format for %s before flushing", async (name, bytes) => {
    const context = await updateFixture(false), file = await localInstaller(context.userData, name, bytes);
    context.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    await expect(context.updates.install()).rejects.toThrow("安装程序");
    expect(context.beforeInstall).not.toHaveBeenCalled(); expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("waits for the final project flush before launch and quits only after the installer starts", async () => {
    const context = await updateFixture(false), file = await localInstaller(context.userData), order: string[] = [];
    context.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), flushed = new Promise<void>(resolve => { release = resolve; });
    context.beforeInstall.mockImplementation(async () => { order.push("flush-start"); entered(); await flushed; order.push("flush-end"); });
    context.launch.mockImplementation(() => {
      order.push("launch"); const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => { order.push("spawn"); child.emit("spawn"); }); return child;
    });
    context.app.quit.mockImplementation(() => { order.push("quit"); });
    const installation = context.updates.install(); await began;
    expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
    release(); await installation; await settle();
    expect(order).toEqual(["flush-start", "flush-end", "launch", "spawn", "quit"]);
    expect(context.launch.mock.results[0].value.unref).toHaveBeenCalledTimes(1);
  });
  it("leaves the application running when final project persistence fails", async () => {
    const context = await updateFixture(false), file = await localInstaller(context.userData);
    context.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] }); context.beforeInstall.mockRejectedValueOnce(new Error("fixture final save failed"));
    await expect(context.updates.install()).rejects.toThrow("final save failed"); await settle();
    expect(context.launch).not.toHaveBeenCalled(); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("leaves the application running when installer process launch fails", async () => {
    const context = await updateFixture(false), file = await localInstaller(context.userData);
    context.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    context.launch.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => child.emit("error", new Error("fixture spawn failure"))); return child; });
    await expect(context.updates.install()).rejects.toThrow("spawn failure"); await settle();
    expect(context.beforeInstall).toHaveBeenCalledTimes(1); expect(context.app.quit).not.toHaveBeenCalled();
  });
  it("shares a concurrent download and launches a verified release only once", async () => {
    const context = await updateFixture(); await context.updates.check();
    let entered!: () => void, release!: (response: Response) => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), download = new Promise<Response>(resolve => { release = resolve; });
    context.fetcher.mockImplementation(async () => { entered(); return download; });
    const first = context.updates.downloadAndInstall(), second = context.updates.downloadAndInstall(); await began;
    expect(context.fetcher).toHaveBeenCalledTimes(2); expect(context.launch).not.toHaveBeenCalled();
    release(new Response(installerBytes)); await Promise.all([first, second]); await settle();
    expect(context.beforeInstall).toHaveBeenCalledTimes(1); expect(context.launch).toHaveBeenCalledTimes(1); expect(context.app.quit).toHaveBeenCalledTimes(1);
  });
});
