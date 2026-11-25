import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../src/types";

const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), write: vi.fn() }));
vi.mock("../src/projects/storage", () => ({ readRecord: async (key: string) => structuredClone(storage.records.get(key)), writeRecord: storage.write, safeConnection: (value: object) => value }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
import { useStore } from "../src/stores/store";
import { applyRunningHubWorkflowMetadata, isGenericRunningHubWorkflowName, preserveRunningHubWorkflowMetadata, renameRunningHubWorkflow, runningHubWorkflowCover, runningHubWorkflowCoverMediaType, safeRunningHubCoverUrl, runningHubWorkflowClassification } from "../src/runninghub/workflow-metadata";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";

const cover = "https://cdn.runninghub.cn/covers/workflow.jpg";
function workflow(patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id: "runninghub-cn-42", name: "RunningHub 42", family: "模型", description: "原描述", mode: "text-to-video",
    runninghub: { workflowId: "42", baseUrl: "https://www.runninghub.cn" },
    requiredInputs: [], optionalInputs: [], parameters: [{ key: "steps", label: "步数", type: "number", default: 40 }],
    mapping: [{ semantic: "steps", nodeId: "1", field: "steps" }], output: { nodeId: "2", field: "gifs", kind: "video" },
    template: { "1": { class_type: "Sampler", inputs: { steps: 40, prompt: "保留完整提示词" } }, "2": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0] } } }, ...patch };
}

beforeEach(() => {
  storage.records.clear(); storage.write.mockReset();
  storage.write.mockImplementation(async (key: string, value: unknown) => { storage.records.set(key, structuredClone(value)); });
  useStore.setState({ ready: false, projectOpen: false, runningHubWorkflows: [] });
});

it("preserves a reviewed image output's classification despite refreshed video tags and keeps its custom name", async () => {
  const existing = await attachRunningHubExecutionContract(workflow({ name: "自定义名", family: "图像工具", output: { nodeId: "2", field: "reviewed_files", kind: "image" } }));
  existing.runninghub = { ...existing.runninghub!, kind: "app", nameSource: "custom" };
  const result = applyRunningHubWorkflowMetadata(existing, { name: "平台视频名", platformCategory: "video", platformCategoryReader: { repository: "https://github.com/Work-Fisher/AIFISHER", revision: "bdcf3bec054594fcab591952a8c5acef858d6de4" } });
  expect(result.name).toBe("自定义名");
  expect(runningHubWorkflowClassification(result)).toEqual({ family: "图像工具", label: "图像" });
  expect(result.template).toEqual(existing.template);
  expect(result.mapping).toEqual(existing.mapping);
  expect(result.output).toEqual(existing.output);
  expect(result.mode).toBe(existing.mode);
  expect(result.runninghub?.executionContract).toEqual(existing.runninghub?.executionContract);
  const restored = preserveRunningHubWorkflowMetadata(workflow(), result);
  expect(restored.runninghub?.platformCategory).toBe("video");
});

describe("RunningHub canvas parameter selection persistence", () => {
  it("retains reviewed selections for an identical execution source while honoring an explicit empty selection", async () => {
    const original = await attachRunningHubExecutionContract(workflow());
    original.runninghub!.canvasParameterKeys = ["steps"];
    const restored = preserveRunningHubWorkflowMetadata(workflow(), original);
    expect(restored.runninghub?.canvasParameterKeys).toEqual(["steps"]);
    expect(restored.template).toEqual(original.template);
    expect(restored.mapping).toEqual(original.mapping);
    const empty = workflow(); empty.runninghub!.canvasParameterKeys = [];
    expect(preserveRunningHubWorkflowMetadata(empty, original).runninghub?.canvasParameterKeys).toEqual([]);
    expect(original.runninghub?.canvasParameterKeys).toEqual(["steps"]);
  });
  it("does not copy parameter selections to a changed execution source", () => {
    const original = workflow(); original.runninghub!.canvasParameterKeys = ["steps"];
    const changed = workflow(); changed.template!["1"].inputs.steps = 41;
    expect(preserveRunningHubWorkflowMetadata(changed, original).runninghub?.canvasParameterKeys).toBeUndefined();
    expect(changed.template!["1"].inputs.steps).toBe(41);
  });
});

describe("RunningHub selected catalog downgrade protection", () => {
  async function selected(keys = ["steps"]) {
    const source = workflow();
    source.runninghub = { ...source.runninghub!, bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: keys };
    source.parameters = source.parameters.filter(parameter => keys.includes(parameter.key));
    source.mapping = source.mapping.filter(binding => keys.includes(binding.semantic));
    return attachRunningHubExecutionContract(source);
  }

  it.each([{ keys: [] }, { keys: ["steps"] }])("preserves the current selected contract and $keys keys when an older graph returns", async ({ keys }) => {
    const existing = await selected(keys), before = structuredClone(existing);
    const incoming = workflow({ name: "项目内名称", runninghub: { ...workflow().runninghub!, coverUrl: cover, nameSource: "custom" } });
    incoming.template!["1"].inputs.steps = 5;
    incoming.parameters[0].default = 5;
    const result = preserveRunningHubWorkflowMetadata(incoming, existing);
    expect(result.name).toBe("项目内名称");
    expect(result.runninghub).toMatchObject({ bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: keys, coverUrl: cover });
    expect(result.template).toEqual(existing.template);
    expect(result.parameters).toEqual(existing.parameters);
    expect(result.mapping).toEqual(existing.mapping);
    expect(result.output).toEqual(existing.output);
    expect(result.runninghub?.executionContract).toEqual(existing.runninghub?.executionContract);
    expect(result.runninghub?.executionContract).not.toBe(existing.runninghub?.executionContract);
    expect(existing).toEqual(before);
    expect(incoming.template!["1"].inputs.steps).toBe(5);
  });

  it("recognizes equivalent platform sites and retains the current custom name for a generic legacy snapshot", async () => {
    const existing = await selected(); existing.name = "当前名称"; existing.runninghub!.nameSource = "custom";
    const incoming = workflow(); incoming.runninghub!.baseUrl = "https://runninghub.cn/";
    const result = preserveRunningHubWorkflowMetadata(incoming, existing);
    expect(result.name).toBe("当前名称");
    expect(result.runninghub?.bindingMode).toBe("selected");
    expect(result.runninghub?.baseUrl).toBe(existing.runninghub?.baseUrl);
  });

  it("retains an explicitly saved full JSON execution choice when a legacy project is merged", async () => {
    const source = await selected([]);
    source.runninghub!.includeWorkflowJson = true;
    const existing = await attachRunningHubExecutionContract(source);
    const result = preserveRunningHubWorkflowMetadata(workflow(), existing);
    expect(result.runninghub?.includeWorkflowJson).toBe(true);
    expect(result.runninghub?.executionContract).toEqual(existing.runninghub?.executionContract);
  });

  it.each(["site", "id", "kind", "protocol"] as const)("does not reuse an execution contract across a different %s", async changed => {
    const existing = await selected(), incoming = workflow();
    if (changed === "site") incoming.runninghub!.baseUrl = "https://www.runninghub.ai";
    if (changed === "id") incoming.runninghub!.workflowId = "43";
    if (changed === "kind") incoming.runninghub!.kind = "app";
    if (changed === "protocol") incoming.runninghub!.apiVersion = "v2";
    const result = preserveRunningHubWorkflowMetadata(incoming, existing);
    expect(result.runninghub?.bindingMode).toBeUndefined();
    expect(result.runninghub?.executionContract).toBeUndefined();
  });

  it("accepts a genuinely refreshed selected definition with an explicit empty binding selection", async () => {
    const existing = await selected(), refreshed = await selected([]);
    refreshed.template!["1"].inputs.steps = 25;
    const versioned = await attachRunningHubExecutionContract(refreshed);
    const result = preserveRunningHubWorkflowMetadata(versioned, existing);
    expect(result.parameters).toEqual([]);
    expect(result.mapping).toEqual([]);
    expect(result.runninghub?.canvasParameterKeys).toEqual([]);
    expect(result.template!["1"].inputs.steps).toBe(25);
    expect(result.runninghub?.executionContract).toEqual(versioned.runninghub?.executionContract);
    expect(result.runninghub?.executionContract).not.toEqual(existing.runninghub?.executionContract);
  });

  it("persists protected selected bindings without replacing the current project or its accepted task snapshot", async () => {
    const existing = await selected([]);
    await useStore.getState().saveRunningHubWorkflow(existing);
    const project = useStore.getState().project;
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const stored = useStore.getState().runningHubWorkflows[0];
    expect(stored.runninghub?.bindingMode).toBe("selected");
    expect(stored.runninghub?.canvasParameterKeys).toEqual([]);
    expect(stored.mapping).toEqual([]);
    expect(stored.runninghub?.executionContract).toEqual(existing.runninghub?.executionContract);
    expect(storage.records.get("runninghub-workflows")).toEqual([stored]);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().project.tasks).toBe(project.tasks);
  });
});

describe("RunningHub workflow presentation metadata", () => {
  it("keeps the persisted user name when a stale draft supplies a platform title", () => {
    const stored = renameRunningHubWorkflow(workflow(), "我的本地名称");
    const draft = applyRunningHubWorkflowMetadata(workflow(), { name: "官网更新名称" });
    const merged = preserveRunningHubWorkflowMetadata(draft, stored);
    expect(merged).toMatchObject({ name: stored.name,
      runninghub: { nameSource: "custom", platformName: "官网更新名称" } });
    const explicit = renameRunningHubWorkflow(draft, "另一个本地名称");
    expect(preserveRunningHubWorkflowMetadata(explicit, stored).name).toBe(explicit.name);
  });

  it("fills a generic imported name and cover without touching graph, bindings or parameters", () => {
    const source = workflow(), snapshot = structuredClone(source);
    const result = applyRunningHubWorkflowMetadata(source, { name: "  MiniMax H3 完整工作流  ", coverUrl: cover });
    expect(result).toMatchObject({ name: "MiniMax H3 完整工作流", runninghub: { platformName: "MiniMax H3 完整工作流", nameSource: "platform", coverUrl: cover } });
    expect(result.template).toBe(source.template); expect(result.mapping).toBe(source.mapping); expect(result.parameters).toBe(source.parameters);
    expect(result.output).toBe(source.output); expect(source).toEqual(snapshot);
  });
  it.each(["RunningHub 42", "RunningHub 工作流 42", "RunningHub AI 应用 42"])("recognizes only the same platform ID in %s", name => {
    expect(isGenericRunningHubWorkflowName(workflow({ name }))).toBe(true);
    expect(isGenericRunningHubWorkflowName(workflow({ name: name + "1" }))).toBe(false);
  });
  it("preserves a user name while refreshing platform metadata and the cover", () => {
    const source = workflow({ name: "我的角色视频" });
    const result = applyRunningHubWorkflowMetadata(source, { name: "平台的新标题", coverUrl: cover });
    expect(result.name).toBe("我的角色视频");
    expect(result.runninghub).toMatchObject({ nameSource: "custom", platformName: "平台的新标题", coverUrl: cover });
    const explicitlyCustom = workflow({ runninghub: { ...source.runninghub!, nameSource: "custom" } });
    expect(applyRunningHubWorkflowMetadata(explicitlyCustom, { name: "平台标题" }).name).toBe("RunningHub 42");
  });
  it("refreshes platform-owned names, including older names without attribution", () => {
    const source = workflow({ name: "原平台名", runninghub: { ...workflow().runninghub!, platformName: "原平台名" } });
    expect(applyRunningHubWorkflowMetadata(source, { name: "新平台名" }).name).toBe("新平台名");
    source.runninghub!.nameSource = "platform";
    expect(applyRunningHubWorkflowMetadata(source, { name: "新平台名" }).runninghub?.nameSource).toBe("platform");
  });
  it("merges partial valid metadata and ignores empty or invalid replacements", () => {
    const source = applyRunningHubWorkflowMetadata(workflow(), { name: "平台标题", coverUrl: cover });
    expect(applyRunningHubWorkflowMetadata(source, { name: " ", coverUrl: "http://localhost/a.png" })).toBe(source);
    expect(applyRunningHubWorkflowMetadata(source, { name: "\n更新\t标题\u0000" })).toMatchObject({ name: "更新 标题", runninghub: { coverUrl: cover } });
    expect(applyRunningHubWorkflowMetadata(source, { coverUrl: "https://cdn.runninghub.ai/new.png" })).toMatchObject({ name: "平台标题", runninghub: { platformName: "平台标题", coverUrl: "https://cdn.runninghub.ai/new.png" } });
    expect(applyRunningHubWorkflowMetadata(workflow({ runninghub: undefined }), { name: "ignored" }).runninghub).toBeUndefined();
  });
  it.each(["http://cdn.runninghub.cn/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAA", "file:///C:/a.png", "https://user:pass@cdn.runninghub.cn/a.jpg", "https://localhost/a.jpg", "https://a.localhost/a.jpg", "https://192.168.1.1/a.jpg", "https://127.1/a.jpg", "https://[::1]/a.jpg", "https://service.internal/a.jpg", "https://host.local/a.jpg", "https://host/a.jpg", "https://cdn.runninghub.cn:8443/a.jpg"])("rejects a nonpublic or credentialed cover %s", value => {
    expect(safeRunningHubCoverUrl(value)).toBeUndefined();
    expect(runningHubWorkflowCover(workflow({ runninghub: { ...workflow().runninghub!, coverUrl: value } }))).toBeUndefined();
  });
  it("sanitizes unsafe stored covers when merging and accepts public CDN query strings", () => {
    const source = workflow({ runninghub: { ...workflow().runninghub!, coverUrl: "https://127.0.0.1/private" } });
    expect(applyRunningHubWorkflowMetadata(source, {}).runninghub?.coverUrl).toBeUndefined();
    expect(safeRunningHubCoverUrl("https://cdn.runninghub.cn/a.jpg?v=2")).toBe("https://cdn.runninghub.cn/a.jpg?v=2");
  });
  it("preserves a platform video cover and infers media type from older cover URLs", () => {
    const videoCover = "https://cdn.runninghub.cn/covers/sample.MP4?version=2";
    const result = applyRunningHubWorkflowMetadata(workflow(), { coverUrl: videoCover, coverMediaType: "video" });
    expect(result.runninghub).toMatchObject({ coverUrl: videoCover, coverMediaType: "video" });
    expect(runningHubWorkflowCoverMediaType(result)).toBe("video");
    const oldVideo = workflow({ runninghub: { ...workflow().runninghub!, coverUrl: videoCover } });
    expect(runningHubWorkflowCoverMediaType(oldVideo)).toBe("video");
    expect(applyRunningHubWorkflowMetadata(oldVideo, {}).runninghub?.coverMediaType).toBe("video");
    expect(runningHubWorkflowCoverMediaType(workflow({ runninghub: { ...workflow().runninghub!, coverUrl: cover } }))).toBe("image");
    expect(runningHubWorkflowCoverMediaType(workflow())).toBeUndefined();
  });
  it("respects explicit media type and never applies an invalid cover's type to the existing cover", () => {
    const source = applyRunningHubWorkflowMetadata(workflow(), { coverUrl: cover });
    expect(source.runninghub?.coverMediaType).toBe("image");
    expect(applyRunningHubWorkflowMetadata(source, { coverMediaType: "video" }).runninghub?.coverMediaType).toBe("video");
    expect(applyRunningHubWorkflowMetadata(source, { coverUrl: "https://localhost/private.mp4", coverMediaType: "video" })).toBe(source);
    expect(applyRunningHubWorkflowMetadata(source, { coverUrl: "https://cdn.runninghub.cn/new.mp4" }).runninghub?.coverMediaType).toBe("video");
    expect(applyRunningHubWorkflowMetadata(source, { coverUrl: "https://cdn.runninghub.cn/no-extension", coverMediaType: "video" }).runninghub?.coverMediaType).toBe("video");
  });
});

describe("queued RunningHub metadata persistence", () => {
  it("persists a local rename across platform metadata refreshes without changing execution or card order", async () => {
    const original = applyRunningHubWorkflowMetadata(await attachRunningHubExecutionContract(workflow()), { name: "平台标题", coverUrl: cover });
    const other = workflow({ id: "runninghub-cn-43", runninghub: { ...workflow().runninghub!, workflowId: "43" } });
    await useStore.getState().saveRunningHubWorkflow(original);
    await useStore.getState().saveRunningHubWorkflow(other);
    const before = useStore.getState(), source = before.runningHubWorkflows[0];
    await useStore.getState().renameRunningHubWorkflow(source.id, "  我的小剧场  ");
    await useStore.getState().updateRunningHubWorkflowMetadata(source.id, { name: "官网更新标题", coverUrl: "https://cdn.runninghub.cn/new-cover.jpg" });
    const after = useStore.getState(), renamed = after.runningHubWorkflows[0];
    expect(renamed).toMatchObject({ name: "我的小剧场", runninghub: { nameSource: "custom", platformName: "官网更新标题", coverUrl: "https://cdn.runninghub.cn/new-cover.jpg" } });
    expect(renamed.template).toBe(source.template);
    expect(renamed.mapping).toBe(source.mapping);
    expect(renamed.parameters).toBe(source.parameters);
    expect(renamed.runninghub?.executionContract).toBe(source.runninghub?.executionContract);
    expect(after.runningHubWorkflows.map(item => item.id)).toEqual([source.id, other.id]);
    expect(storage.records.get("runninghub-workflows")).toEqual(after.runningHubWorkflows);
    expect(after.project).toBe(before.project);
    expect(after.workflows).toBe(before.workflows);
  });
  it("renames the latest queued graph instead of saving a stale card snapshot", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    let release!: () => void;
    storage.write.mockImplementationOnce(async (key: string, value: unknown) => { await new Promise<void>(resolve => { release = resolve; }); storage.records.set(key, structuredClone(value)); });
    const edited = workflow({ template: { latest: { class_type: "CurrentGraph", inputs: { steps: 55 } } } });
    const saving = useStore.getState().saveRunningHubWorkflow(edited);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const rename = useStore.getState().renameRunningHubWorkflow(edited.id, "新的本地名称");
    release(); await Promise.all([saving, rename]);
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: "新的本地名称", template: edited.template, runninghub: { nameSource: "custom" } });
  });
  it.each(["", " \n\t ", "x".repeat(121)])("rejects an invalid local title without changing durable state: %s", async name => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const before = useStore.getState().runningHubWorkflows, writes = storage.write.mock.calls.length;
    await expect(useStore.getState().renameRunningHubWorkflow(workflow().id, name)).rejects.toThrow("120");
    expect(useStore.getState().runningHubWorkflows).toBe(before);
    expect(storage.write).toHaveBeenCalledTimes(writes);
  });
  it("retains the old name if saving fails and accepts a later rename", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const before = useStore.getState().runningHubWorkflows;
    storage.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().renameRunningHubWorkflow(workflow().id, "第一次改名")).rejects.toThrow("disk full");
    expect(useStore.getState().runningHubWorkflows).toBe(before);
    await useStore.getState().renameRunningHubWorkflow(workflow().id, "第二次改名");
    expect(useStore.getState().runningHubWorkflows[0].name).toBe("第二次改名");
  });
  it("does not restore a removed workflow when a queued rename arrives", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const remove = useStore.getState().removeRunningHubWorkflow(workflow().id);
    const rename = useStore.getState().renameRunningHubWorkflow(workflow().id, "已经删除");
    await remove;
    await expect(rename).rejects.toThrow("移除");
    expect(useStore.getState().runningHubWorkflows).toEqual([]);
    expect(storage.records.get("runninghub-workflows")).toEqual([]);
  });
  it("can explicitly retain the current platform title as a custom local title", () => {
    const source = applyRunningHubWorkflowMetadata(workflow(), { name: "平台标题", coverUrl: cover });
    const renamed = renameRunningHubWorkflow(source, source.name);
    expect(applyRunningHubWorkflowMetadata(renamed, { name: "官网新标题" })).toMatchObject({ name: "平台标题", runninghub: { nameSource: "custom", platformName: "官网新标题", coverUrl: cover } });
  });
  it("retains the catalog read version when an identical older project has no snapshot", async () => {
    const versioned = await attachRunningHubExecutionContract(workflow());
    await useStore.getState().saveRunningHubWorkflow(versioned);
    await useStore.getState().saveRunningHubWorkflow(workflow({ name: "我的名称" }));
    const stored = useStore.getState().runningHubWorkflows[0];
    expect(stored.name).toBe("我的名称");
    expect(stored.runninghub?.executionContract).toEqual(versioned.runninghub?.executionContract);
    expect(stored.runninghub?.executionContract).not.toBe(versioned.runninghub?.executionContract);
  });
  it.each(["graph", "binding", "output"])("does not inherit a stale read version after the %s changes", async change => {
    await useStore.getState().saveRunningHubWorkflow(await attachRunningHubExecutionContract(workflow()));
    const incoming = workflow();
    if (change === "graph") incoming.template!["1"].inputs.steps = 12;
    if (change === "binding") incoming.mapping = [];
    if (change === "output") incoming.output = { nodeId: "2", field: "*", kind: "file" };
    await useStore.getState().saveRunningHubWorkflow(incoming);
    expect(useStore.getState().runningHubWorkflows[0].runninghub?.executionContract).toBeUndefined();
  });
  it("updates only the dedicated catalog and preserves the current execution definition", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const before = useStore.getState(), saved = before.runningHubWorkflows[0];
    await useStore.getState().updateRunningHubWorkflowMetadata(saved.id, { name: "平台标题", coverUrl: cover });
    const after = useStore.getState();
    expect(after.runningHubWorkflows[0]).toMatchObject({ name: "平台标题", runninghub: { coverUrl: cover } });
    expect(after.runningHubWorkflows[0].template).toBe(saved.template);
    expect(after.project).toBe(before.project); expect(after.workflows).toBe(before.workflows);
    expect(storage.records.get("runninghub-workflows")).toEqual(after.runningHubWorkflows);
    expect(new Set(storage.write.mock.calls.map(([key]) => key))).toEqual(new Set(["runninghub-workflows"]));
  });
  it("merges after a queued user edit and retains the latest custom name and graph", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    let release!: () => void;
    storage.write.mockImplementationOnce(async (key: string, value: unknown) => { await new Promise<void>(resolve => { release = resolve; }); storage.records.set(key, structuredClone(value)); });
    const edited = workflow({ name: "我的改名", runninghub: { ...workflow().runninghub!, nameSource: "custom" }, template: { "new": { class_type: "LatestGraph", inputs: { value: 123 } } } });
    const edit = useStore.getState().saveRunningHubWorkflow(edited);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const refresh = useStore.getState().updateRunningHubWorkflowMetadata(edited.id, { name: "平台标题", coverUrl: cover });
    release(); await Promise.all([edit, refresh]);
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: "我的改名", template: edited.template, runninghub: { platformName: "平台标题", coverUrl: cover } });
  });
  it("never recreates a workflow removed while metadata was being read", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const remove = useStore.getState().removeRunningHubWorkflow(workflow().id);
    const update = useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台标题", coverUrl: cover });
    await Promise.all([remove, update]);
    expect(useStore.getState().runningHubWorkflows).toEqual([]);
    expect(storage.records.get("runninghub-workflows")).toEqual([]);
    expect(storage.write).toHaveBeenCalledTimes(2);
  });
  it("keeps durable state on failure, then allows a later metadata retry", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    const saved = useStore.getState().runningHubWorkflows;
    storage.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台标题" })).rejects.toThrow("disk full");
    expect(useStore.getState().runningHubWorkflows).toBe(saved);
    await useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台标题" });
    expect(useStore.getState().runningHubWorkflows[0].name).toBe("平台标题");
  });
  it("keeps known platform presentation when an old generic project snapshot saves a newer graph", async () => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    await useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台标题", coverUrl: "https://cdn.runninghub.cn/cover.mp4", coverMediaType: "video" });
    const incoming = workflow({ template: { "new": { class_type: "CurrentGraph", inputs: { steps: 55 } } } });
    await useStore.getState().saveRunningHubWorkflow(incoming);
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: "平台标题", template: incoming.template,
      runninghub: { platformName: "平台标题", coverUrl: "https://cdn.runninghub.cn/cover.mp4", coverMediaType: "video", nameSource: "platform" } });
  });
  it("retains a current custom name when a metadata-less generic snapshot returns", async () => {
    const custom = applyRunningHubWorkflowMetadata(workflow({ name: "我命名的工作流" }), { name: "平台标题", coverUrl: cover });
    await useStore.getState().saveRunningHubWorkflow(custom);
    await useStore.getState().saveRunningHubWorkflow(workflow());
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: "我命名的工作流", runninghub: { nameSource: "custom", platformName: "平台标题", coverUrl: cover } });
  });
  it.each([false, true])("preserves a real custom rename when incoming metadata is %s", async keepsMetadata => {
    await useStore.getState().saveRunningHubWorkflow(workflow());
    await useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台标题", coverUrl: cover });
    const original = keepsMetadata ? useStore.getState().runningHubWorkflows[0] : workflow();
    await useStore.getState().saveRunningHubWorkflow({ ...original, name: "用户刚改的新名称" });
    await useStore.getState().updateRunningHubWorkflowMetadata(workflow().id, { name: "平台下一版标题" });
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: "用户刚改的新名称", runninghub: { nameSource: "custom", platformName: "平台下一版标题", coverUrl: cover } });
  });
});
