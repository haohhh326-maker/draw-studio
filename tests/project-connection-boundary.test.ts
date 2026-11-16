import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Connection, GenerationTask, Project, WorkflowDefinition } from "../src/types";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("idb", () => ({ openDB: async () => ({ get: async () => undefined, put: async () => {} }) }));
import { projectArchive, importProject } from "../src/projects/storage";
import { migrateProject } from "../src/projects/migrate";
import { taskConnectionSnapshot } from "../src/projects/connection-snapshot";

const cloud: Connection = { name: "My cloud", baseUrl: "https://cloud.example/comfy", token: "cloud-private-fixture", authHeader: "X-Engine-Key", authPrefix: "Token ", timeoutMinutes: 23 };
const native: Connection = { name: "Native", baseUrl: "https://www.runninghub.cn/proxy-plus/native-private-fixture", token: "different-legacy-private-fixture", authHeader: "X-Legacy", authPrefix: "Old ", timeoutMinutes: 60 };
const workflow: WorkflowDefinition = { id: "custom-workflow", name: "Custom workflow", family: "Custom", description: "preserve user workflow", mode: "text-to-image", requiredInputs: [], optionalInputs: [], promptRequired: false,
  parameters: [], mapping: [], template: { "1": { class_type: "CustomNode", inputs: { apiKey: "keep-workflow-fixture", token_count: 123, reference: "https://cloud.example/proxy/art-reference" } } }, output: { nodeId: "1", field: "images", kind: "image" } };
function task(id: string, connection: Connection, status: GenerationTask["status"] = "completed"): GenerationTask {
  return { taskId: id, promptId: "prompt-" + id, executorType: "comfyui", requestId: "request-" + id, clientId: "client-" + id, canvasId: "canvas", nodeId: "node", nodeTitle: "Keep title", status,
    createdAt: 10, updatedAt: 20, completedAt: status === "completed" ? 20 : undefined, progress: status === "generating" ? 37 : undefined,
    connection, workflow, input: { prompt: "Keep this prompt", negativePrompt: "Keep negative", params: { token_count: 456, apiKey: "keep-input-fixture" }, assets: [] }, outputs: [], details: "Keep receipt details" };
}
function project(tasks: Record<string, GenerationTask> = { cloud: task("cloud", cloud), native: task("native", native) }): Project {
  return { version: 2, id: "project", name: "Archive fixture", canvases: [{ id: "canvas", sceneId: "scene", name: "Canvas", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], activeCanvasId: "canvas",
    scenes: [{ id: "scene", name: "Scene" }], assets: {}, tasks, history: [], updatedAt: 20 };
}
async function unpack(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return { project: JSON.parse(strFromU8(files["project.json"])) as Project, workflows: JSON.parse(strFromU8(files["workflows.json"])) as WorkflowDefinition[], text: Object.values(files).map(file => strFromU8(file)).join("\n") };
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network is forbidden in archive tests"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("task connection credential boundaries", () => {
  it("exports key-free native and cloud receipts without changing status, inputs or the live project", async () => {
    const source = project({ cloud: task("cloud", cloud, "queued"), native: task("native", native, "generating") });
    const before = structuredClone(source);
    const archive = await unpack(await projectArchive(source, [workflow]));
    expect(source).toEqual(before);
    expect(archive.project.tasks.cloud.connection).toEqual({ name: cloud.name, baseUrl: cloud.baseUrl, authHeader: cloud.authHeader, authPrefix: cloud.authPrefix, timeoutMinutes: cloud.timeoutMinutes });
    expect(archive.project.tasks.native.connection).toEqual({ name: native.name, baseUrl: "https://www.runninghub.cn/proxy-plus", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 });
    expect(archive.project.tasks.cloud.status).toBe("queued");
    expect(archive.project.tasks.native.status).toBe("generating");
    expect(archive.project.tasks.native.progress).toBe(37);
    expect(archive.project.tasks.native.input).toEqual(before.tasks.native.input);
    expect(archive.project.tasks.native.workflow).toEqual(workflow);
    expect(archive.workflows).toEqual([workflow]);
    for (const secret of ["cloud-private-fixture", "native-private-fixture", "different-legacy-private-fixture"]) expect(archive.text).not.toContain(secret);
    expect(archive.text).toContain("keep-workflow-fixture");
    expect(archive.text).toContain("keep-input-fixture");
  });

  it("round-trips a completed project with safe connection metadata and unchanged receipts", async () => {
    const source = project(), exported = await projectArchive(source, [workflow]);
    const saved = (await unpack(exported)).project;
    const restored = await importProject(new File([exported], "fixture.aicanvas"));
    expect(restored.project).toEqual(saved);
    expect(restored.workflows).toEqual([workflow]);
    expect(restored.project.tasks.native.status).toBe("completed");
    expect(restored.project.tasks.native.details).toBe("Keep receipt details");
    expect(restored.project.tasks.native.connection).not.toHaveProperty("token");
  });

  it("strips legacy snapshot credentials on import without mutating the input project", () => {
    const source = project();
    Object.assign(source.tasks.native.connection, { wsUrl: "wss://www.runninghub.cn/proxy/ws-private-fixture/ws", videoUploadPath: "/old", videoUploadField: "old-field" });
    const before = structuredClone(source), migrated = migrateProject(source, [workflow]);
    expect(source).toEqual(before);
    expect(migrated.tasks.native.connection).toEqual(taskConnectionSnapshot(native));
    expect(migrated.tasks.cloud.connection).toEqual(taskConnectionSnapshot(cloud));
    expect(migrated.tasks.native.input).toEqual(source.tasks.native.input);
    expect(migrated.tasks.native.status).toBe("completed");
    expect(JSON.stringify(migrated.tasks.native.connection)).not.toContain("private-fixture");
  });

  it("normalizes connections when creating task receipts from version-one generation records", () => {
    const source = project({});
    source.canvases[0].nodes.push({ id: "node", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "Keep title", generation: {
      workflowId: workflow.id, prompt: "Keep this prompt", negativePrompt: "", params: {}, taskId: null,
      ...{ task: { phase: "completed", promptId: "legacy-prompt", startedAt: 3 } },
    } } });
    const migrated = migrateProject({ ...source, version: 1 }, [workflow], native);
    const receipts = Object.values(migrated.tasks);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].connection).toEqual(taskConnectionSnapshot(native));
    expect(receipts[0].status).toBe("completed");
    expect(receipts[0].promptId).toBe("legacy-prompt");
  });

  it.each([
    "https://www.runninghub.cn/proxy/unsafe-private-fixture?unexpected=1",
    "https://www.runninghub.cn/proxy/unsafe-private-fixture/extra",
    "https://www.runninghub.cn/%70roxy/unsafe-private-fixture",
    "https://www.runninghub.cn//proxy/unsafe-private-fixture",
    "https://www.runninghub.ai/proxy/unsafe-private-fixture",
    "https://www.runninghub.cn./proxy/unsafe-private-fixture",
    "www.runninghub.cn/proxy/unsafe-private-fixture",
  ])("fails safely for malformed native snapshot %s", async baseUrl => {
    const source = project({ invalid: task("invalid", { ...native, baseUrl }) });
    let failure: unknown;
    try { await projectArchive(source, [workflow]); } catch (reason) { failure = reason; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("无法安全保存或导出");
    expect(String(failure)).not.toContain("unsafe-private-fixture");
    expect(() => migrateProject(source, [workflow])).toThrow("无法安全保存或导出");
  });

  it("rejects an unsafe imported native receipt before saving project assets", async () => {
    const source = project({ invalid: task("invalid", { ...native, baseUrl: "https://www.runninghub.cn/proxy/unsafe-import-fixture#fragment" }) });
    const bytes = zipSync({ "project.json": strToU8(JSON.stringify(source)), "workflows.json": strToU8(JSON.stringify([workflow])) });
    await expect(importProject(new File([bytes as Uint8Array<ArrayBuffer>], "unsafe.aicanvas"))).rejects.toThrow("无法安全保存或导出");
  });
});
