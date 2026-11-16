import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, GenerationTask, WorkflowDefinition } from "../src/types";

const db = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("idb", () => ({ openDB: async () => ({
  get: async (_store: string, key: string) => structuredClone(db.records.get(key)),
  put: async (_store: string, value: unknown, key: string) => { db.records.set(key, structuredClone(value)); },
}) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline fixture"); } }));

import { useStore } from "../src/stores/store";
import { safeConnection } from "../src/projects/storage";
import { COMFY_CONNECTION_PROFILES_RECORD, defaultNativeComfyConnection } from "../src/compute/comfy-connections";
import { defaultRunningHubConnections } from "../src/compute/providers";
import { defaultConnection } from "../src/workflow/catalog";

const cloud: Connection = { name: "Saved AutoDL", baseUrl: "https://cloud.example/comfy", token: "cloud-fixture-key", authHeader: "X-Cloud-Key", authPrefix: "", timeoutMinutes: 60 };
const native: Connection = { ...defaultNativeComfyConnection, baseUrl: "https://www.runninghub.cn/proxy-plus", token: "native-fixture-key" };
beforeEach(() => {
  useStore.setState({ ready: false, projectOpen: false });
  db.records.clear();
  useStore.setState({ connection: { ...cloud }, comfyConnectionProfiles: { cloud: { ...cloud }, native: defaultNativeComfyConnection },
    runningHubConnections: { ...defaultRunningHubConnections, cn: { ...defaultRunningHubConnections.cn, token: "cn-account-fixture-key" } },
    runningHubConnection: defaultRunningHubConnections.cn, computeProvider: "comfyui", connectionState: "offline", connectionInfo: "" });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
});
afterEach(() => { useStore.setState({ ready: false, projectOpen: false }); vi.unstubAllGlobals(); });

describe("cloud selection after retiring the native RunningHub entry", () => {
  it("keeps native profiles for recovery but rejects selecting the retired entry", async () => {
    const before = useStore.getState(), project = before.project, rh = before.runningHubConnections;
    useStore.setState({ comfyConnectionProfiles: { cloud, native } });
    useStore.setState({ ready: true });
    useStore.getState().setComfyConnectionMode("native");
    expect(useStore.getState().connection).toEqual(cloud);
    useStore.setState({ connection: native });
    useStore.getState().setComfyConnectionMode("cloud");
    expect(useStore.getState().connection).toEqual(cloud);
    const editedCloud = { ...cloud, name: "Edited cloud", token: "edited-cloud-fixture" };
    useStore.setState({ connection: editedCloud });
    useStore.getState().setComfyConnectionMode("native");
    expect(useStore.getState().connection).toEqual(editedCloud);
    useStore.getState().setComfyConnectionMode("cloud");
    expect(useStore.getState().connection).toEqual(editedCloud);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().runningHubConnections).toBe(rh);
    expect(useStore.getState().computeProvider).toBe("comfyui");
    await vi.waitFor(() => expect(db.records.get(COMFY_CONNECTION_PROFILES_RECORD)).toEqual({ cloud: editedCloud, native }));
    await vi.waitFor(() => expect(db.records.get("connection")).toEqual(editedCloud));
  });
  it("rejects pasted retired endpoints without overwriting saved recovery credentials", async () => {
    useStore.setState({ comfyConnectionProfiles: { cloud, native }, ready: true });
    useStore.setState({ connection: { ...native, baseUrl: native.baseUrl + "/new-unwanted-key", token: "replacement-key" } });
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
    expect(useStore.getState().connectionInfo).toContain("入口已停用");
    await vi.waitFor(() => expect(db.records.get(COMFY_CONNECTION_PROFILES_RECORD)).toEqual({ cloud, native }));
    expect(JSON.stringify([...db.records.values()])).not.toContain("new-unwanted-key");
    expect(JSON.stringify([...db.records.values()])).not.toContain("replacement-key");
  });

  it("upgrades a legacy cloud connection without replacing it and seeds only the new native profile from the saved CN account", async () => {
    db.records.set("connection", cloud);
    db.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: { ...defaultRunningHubConnections.cn, token: "legacy-cn-fixture" } });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().comfyConnectionProfiles.native.token).toBe("legacy-cn-fixture");
    expect(useStore.getState().computeProvider).toBe("runninghub");
    useStore.getState().setComfyConnectionMode("native");
    useStore.getState().setComfyConnectionMode("cloud");
    expect(useStore.getState().connection).toEqual(cloud);
    await vi.waitFor(() => expect(db.records.get("connection")).toEqual(cloud));
  });

  it("takes the latest active connection over a stale profile record while preserving the inactive profile", async () => {
    db.records.set("connection", { ...cloud, name: "Newest cloud" });
    db.records.set(COMFY_CONNECTION_PROFILES_RECORD, { cloud, native });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection.name).toBe("Newest cloud");
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
    useStore.getState().setComfyConnectionMode("native");
    useStore.getState().setComfyConnectionMode("cloud");
    expect(useStore.getState().connection.name).toBe("Newest cloud");
    await vi.waitFor(() => expect(db.records.get(COMFY_CONNECTION_PROFILES_RECORD)).toEqual({ cloud: { ...cloud, name: "Newest cloud" }, native }));
  });

  it("keeps intentionally cleared recovery credentials empty without changing the cloud selection", async () => {
    db.records.set("connection", cloud);
    db.records.set(COMFY_CONNECTION_PROFILES_RECORD, { cloud, native: { ...native, token: "" } });
    db.records.set("compute-preferences", { runningHubConnection: { ...defaultRunningHubConnections.cn, token: "must-not-reseed" } });
    await useStore.getState().hydrate();
    useStore.getState().setComfyConnectionMode("native");
    expect(useStore.getState().comfyConnectionProfiles.native.token).toBe("");
    expect(useStore.getState().connection).toEqual(cloud);
    useStore.getState().setComfyConnectionMode("cloud");
    useStore.getState().setComfyConnectionMode("native");
    expect(useStore.getState().comfyConnectionProfiles.native.token).toBe("");
    await vi.waitFor(() => expect(db.records.get("connection")).toEqual(cloud));
  });

  it("migrates an active native endpoint to the saved cloud profile and retains normalized recovery credentials", async () => {
    db.records.set("connection", { ...native, baseUrl: "https://www.runninghub.cn/proxy-plus/pasted-fixture-key", token: "" });
    db.records.set(COMFY_CONNECTION_PROFILES_RECORD, { cloud, native });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().comfyConnectionProfiles.cloud).toEqual(cloud);
    await vi.waitFor(() => expect(db.records.get(COMFY_CONNECTION_PROFILES_RECORD)).toEqual({ cloud, native: { ...native, token: "pasted-fixture-key" } }));
    expect(safeConnection(cloud)).toEqual(cloud);
    expect(db.records.get("connection")).toEqual(cloud);
  });
  it("uses the default cloud endpoint when only the retired native connection was saved", async () => {
    db.records.set("connection", native);
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(defaultConnection);
    expect(useStore.getState().connection.name).not.toContain("RunningHub");
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
    expect(db.records.get("connection")).toEqual(defaultConnection);
    await vi.waitFor(() => expect(db.records.get(COMFY_CONNECTION_PROFILES_RECORD)).toEqual({ cloud: defaultConnection, native }));
  });
  it("selects the saved cloud even if ComfyUI was already selected with a retired endpoint", () => {
    const original = useStore.getState().project;
    useStore.setState({ connection: native, comfyConnectionProfiles: { cloud, native }, computeProvider: "comfyui" });
    useStore.getState().setComputeProvider("comfyui");
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
    expect(useStore.getState().project).toBe(original);
  });
  it("does not use a misplaced native endpoint as the cloud profile", async () => {
    db.records.set("connection", native);
    db.records.set(COMFY_CONNECTION_PROFILES_RECORD, { cloud: native, native });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(defaultConnection);
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
  });
  it("keeps an accepted native task snapshot recoverable while hydration activates the cloud profile", async () => {
    const project = structuredClone(useStore.getState().project), canvas = project.canvases[0];
    const workflow: WorkflowDefinition = { id: "accepted-native-workflow", name: "Accepted native", family: "Test", mode: "text-to-image",
      requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], output: { nodeId: "1", field: "images", kind: "image" },
      template: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "original" } } } };
    const { token: _, ...endpoint } = native;
    const task: GenerationTask = { taskId: "accepted-native", promptId: "platform-accepted-id", requestId: "accepted-request", clientId: "accepted-client",
      executorType: "comfyui", canvasId: canvas.id, nodeId: "original-node", nodeTitle: "Image", status: "generating", createdAt: 1, updatedAt: 1,
      connection: endpoint, workflow, input: { prompt: "Own prompt", negativePrompt: "", params: {}, assets: [] }, outputs: [] };
    project.tasks = { [task.taskId]: task };
    db.records.set("connection", native);
    db.records.set(COMFY_CONNECTION_PROFILES_RECORD, { cloud, native });
    db.records.set("project-library", { [project.id]: { project, workflows: [workflow] } });
    vi.stubGlobal("sessionStorage", { getItem: () => project.id });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().comfyConnectionProfiles.native).toEqual(native);
    expect(useStore.getState().project.tasks[task.taskId]).toMatchObject({ executorType: "comfyui", status: "interrupted", promptId: "platform-accepted-id", connection: endpoint, workflow });
    expect(useStore.getState().project.tasks[task.taskId].connection).not.toHaveProperty("token");
  });
});
