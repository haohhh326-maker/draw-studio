import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteWorkflowLibraryFolder } from "../scripts/workflow-library-delete";
import { workflowLibraryHandler } from "../scripts/workflow-library-plugin";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";

const failures = vi.hoisted(() => ({ remove: false }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (target: string, options: Parameters<typeof actual.rm>[1]) => {
    if (failures.remove && path.basename(target).startsWith(".canvas-delete-")) throw new Error("simulated locked file");
    return actual.rm(target, options);
  } };
});
const roots: string[] = [];
afterEach(async () => {
  failures.remove = false;
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("canvas-delete-test-")) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-delete-test-")); roots.push(root); return root;
}
async function packageAt(root: string, folder = "Qwen-Image-2.1") {
  const target = path.join(root, folder); await mkdir(target);
  const workflowId = "vendor.qwen-image";
  const config = JSON.stringify({ id: workflowId, nameLabel: "My Qwen", nodeKind: "image", primaryCategoryLabel: "Qwen 图像", version: "1.0.0", inputs: [], parameters: [], runnerType: "comfyui", execution: { file: "execution.api.json", modelRequirementsFile: "model.requirements.json" } });
  await writeFile(path.join(target, "workflow.config.json"), config);
  await writeFile(path.join(target, "execution.api.json"), JSON.stringify({ "1": { class_type: "SaveImage", inputs: {} } }));
  await writeFile(path.join(target, "model.requirements.json"), JSON.stringify({ items: [] }));
  await mkdir(path.join(target, "docs")); await writeFile(path.join(target, "docs", "README.txt"), "workflow documentation");
  return { workflowId, folder, configSha256: createHash("sha256").update(config).digest("hex") };
}
describe("deleting a workflow's verified directory", () => {
  it("deletes the selected entire package while preserving its neighbor", async () => {
    const root = await fixture(), request = await packageAt(root);
    const neighbor = await packageAt(root, "Neighbor");
    expect(await deleteWorkflowLibraryFolder(root, request)).toEqual({ workflowId: request.workflowId, folder: request.folder, deleted: true });
    expect(await readdir(root)).toEqual([neighbor.folder]);
    expect(await readFile(path.join(root, neighbor.folder, "docs", "README.txt"), "utf8")).toBe("workflow documentation");
  });
  it("rejects stale snapshots and mismatched identities without removing files", async () => {
    const root = await fixture(), request = await packageAt(root);
    await expect(deleteWorkflowLibraryFolder(root, { ...request, workflowId: "other" })).rejects.toMatchObject({ status: 409 });
    await expect(deleteWorkflowLibraryFolder(root, { ...request, configSha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(await readdir(root)).toEqual([request.folder]);
  });
  it("rejects absolute paths, traversal, root deletion, staging and Windows device names", async () => {
    const root = await fixture(), request = await packageAt(root);
    for (const folder of ["..", ".", "../Qwen-Image-2.1", "..\\Qwen-Image-2.1", root, "C:\\", ".canvas-delete-123", "CON", "NUL.txt", "bad.", "bad "]) {
      await expect(deleteWorkflowLibraryFolder(root, { ...request, folder })).rejects.toMatchObject({ status: 400 });
    }
    expect(await readdir(root)).toEqual([request.folder]);
  });
  it("rejects a linked package and linked contents without affecting their targets", async () => {
    const root = await fixture(), outside = await fixture(), request = await packageAt(outside);
    await symlink(path.join(outside, request.folder), path.join(root, request.folder), "junction");
    await expect(deleteWorkflowLibraryFolder(root, request)).rejects.toMatchObject({ status: 409 });
    const normal = await packageAt(root, "Normal");
    await symlink(path.join(outside, request.folder), path.join(root, normal.folder, "linked-models"), "junction");
    await expect(deleteWorkflowLibraryFolder(root, normal)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(outside, request.folder, "docs", "README.txt"), "utf8")).toBe("workflow documentation");
  });
  it("restores the original directory when removal fails before deleting any files", async () => {
    const root = await fixture(), request = await packageAt(root);
    const before = await readFile(path.join(root, request.folder, "workflow.config.json"));
    failures.remove = true;
    await expect(deleteWorkflowLibraryFolder(root, request)).rejects.toMatchObject({ status: 500, message: expect.stringContaining("locked file") });
    expect(await readdir(root)).toEqual([request.folder]);
    expect(await readFile(path.join(root, request.folder, "workflow.config.json"))).toEqual(before);
  });
  it("serializes concurrent deletes so only one can remove the same package", async () => {
    const root = await fixture(), request = await packageAt(root);
    const results = await Promise.allSettled([deleteWorkflowLibraryFolder(root, request), deleteWorkflowLibraryFolder(root, request)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });
  it("omits a staged deletion directory from catalogue scans", async () => {
    const root = await fixture(); await packageAt(root, ".canvas-delete-1234");
    expect((await readWorkflowLibrary(root)).scanned).toBe(0);
  });
  it("only accepts same-origin POST deletion of a snapshot in the configured root", async () => {
    const root = await fixture(), outside = await fixture(), request = await packageAt(root);
    await packageAt(outside);
    const handle = workflowLibraryHandler(root, { sourcePath: root });
    const server = createServer((req, res) => void handle(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No server port");
    const base = "http://127.0.0.1:" + address.port, url = base + "/__canvas/workflow-library/delete";
    const post = (endpoint = url, extraHeaders = {}, body: unknown = request) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
    try {
      expect((await fetch(url)).status).toBe(405);
      expect((await post(url, { Origin: "https://untrusted.example" })).status).toBe(403);
      expect((await post(url + "?path=" + encodeURIComponent(outside))).status).toBe(405);
      expect((await post(url, { "Content-Type": "text/plain" })).status).toBe(415);
      const deleted = await post(url, { Origin: base }, { ...request, sourcePath: outside });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ workflowId: request.workflowId, folder: request.folder, deleted: true });
      expect(await readdir(root)).toEqual([]);
      expect((await lstat(path.join(outside, request.folder))).isDirectory()).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
