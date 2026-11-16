import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/workflow/import-schema", () => ({ loadImportSchema: vi.fn() }));
vi.mock("../src/workflow/aifisher-reader-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/aifisher-reader-client")>();
  const { readAIFisherWorkflow } = await import("../scripts/aifisher-workflow-reader");
  return { ...actual, readAifisherWorkflow: vi.fn(readAIFisherWorkflow) };
});
vi.mock("../src/workflow/manager-plugins", () => ({
  collectMissingManagerNodes: vi.fn((_source, missing) => [...new Map(missing.map((node: { classType: string; nodeId?: string }) => [node.classType + "\0" + node.nodeId, node])).values()]),
  repairMissingManagerPlugins: vi.fn(),
}));
vi.mock("../src/workflow/import-pipeline", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/import-pipeline")>();
  return { ...actual, prepareWorkflowImport: vi.fn(actual.prepareWorkflowImport) };
});
import { prepareAutomaticWorkflowImport as prepareImport } from "../src/workflow/automatic-import";
const prepareAutomaticWorkflowImport = (...args: Parameters<typeof prepareImport>) => prepareImport(args[0], args[1], args[2], args[3], args[4], { installMissingPlugins: true });
import { loadImportSchema } from "../src/workflow/import-schema";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { collectMissingManagerNodes, repairMissingManagerPlugins, type ManagerRepairResult } from "../src/workflow/manager-plugins";
import { defaultConnection } from "../src/workflow/catalog";
import { discoverOnlineManagerPlugins } from "../src/workflow/manager-online-discovery";

const connection = { ...defaultConnection, baseUrl: "https://engine.example", token: "private-token" };
const managerIdle = { is_processing: false, total_count: 1, done_count: 1, in_progress_count: 0 };
const known = {
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const full = { ...known,
  OwnMaker: { input: { required: { width: ["INT"], model_name: [["own.safetensors"]] } }, output: ["IMAGE"] },
};
const source = () => ({ version: 0.4, nodes: [
  { id: 1, type: "OwnMaker", widgets_values: { width: 512, model_name: "own.safetensors" }, inputs: [], outputs: [{ type: "IMAGE", links: [1] }], properties: { cnr_id: "author-own", ver: "1.2.3", retain: "metadata" } },
  { id: 2, type: "SaveImage", widgets_values: { filename_prefix: "original-prefix" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
], links: [[1, 1, 0, 2, 0, "IMAGE"]], extra: { custom: "retain me" } });
const signal = () => new AbortController().signal;

it("never installs plugins against a native RunningHub shared catalog, even if the installation option is set", async () => {
  vi.mocked(loadImportSchema).mockResolvedValue({ info: known, warnings: [] });
  const original = { "1": { class_type: "PrivateImageNode", inputs: {} }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "test" } } };
  const value = await prepareAutomaticWorkflowImport(original, "native.json", { ...connection, baseUrl: "https://www.runninghub.cn/proxy" }, signal());
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
  expect(value.prepared.importState.environmentReport?.capabilities).toBe("platform");
  expect(value.prepared.importState.environmentReport?.issues.find(issue => issue.category === "missing-node")?.severity).toBe("warning");
  expect(value.prepared.graph).toEqual(original);
});
function result(status: ManagerRepairResult["nodes"][number]["status"], objectInfo: Record<string, unknown> = known): ManagerRepairResult {
  return { nodes: [{ classType: "OwnMaker", nodeId: "1", status, packageId: "author-own", message: "Manager: " + status }],
    objectInfo, installedPackageIds: status === "installed-pending-restart" ? ["author-own"] : [], restartRequired: status === "installed-pending-restart" };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadImportSchema).mockResolvedValue({ info: known, warnings: [] });
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("available", full));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("automatically finds missing plugins, then reparses only the original file with registered contracts", async () => {
  const original = source(), bytes = JSON.stringify(original), progress = vi.fn();
  const preparedBefore = await prepareWorkflowImport(original, "author.json", known);
  vi.mocked(prepareWorkflowImport).mockClear();
  const repaired = await prepareAutomaticWorkflowImport(original, "author.json", connection, signal(), progress);
  expect(repaired.prepared.importState.status).toBe("ready");
  expect(repaired.prepared.config.id).toBe(preparedBefore.config.id);
  expect(repaired.prepared.graph?.["1"].inputs).toEqual({ width: 512, model_name: "own.safetensors" });
  expect(repaired.prepared.source).toBe(original);
  expect(JSON.stringify(original)).toBe(bytes);
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(2);
  for (const [input] of vi.mocked(prepareWorkflowImport).mock.calls) expect(input).toBe(original);
  expect(repairMissingManagerPlugins).toHaveBeenCalledTimes(1);
  expect(repairMissingManagerPlugins).toHaveBeenCalledWith(expect.objectContaining({ connection }), [{ classType: "OwnMaker", nodeId: "1" }], expect.objectContaining({ initialObjectInfo: known, onProgress: progress, discoverOnline: discoverOnlineManagerPlugins }));
  expect(repaired.prepared.importState.diagnostics).toEqual([]);
  expect(repaired.schema).toEqual({ info: full, warnings: [] });
});

it("never looks up or installs a plugin when all node contracts already exist", async () => {
  vi.mocked(loadImportSchema).mockResolvedValue({ info: full, warnings: [] });
  const value = await prepareAutomaticWorkflowImport(source(), "known.json", connection, signal());
  expect(value.prepared.importState.status).toBe("ready");
  expect(value.manager).toBeUndefined();
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(1);
});

it("keeps positional editor widgets pending even when every node is registered", async () => {
  vi.mocked(loadImportSchema).mockResolvedValue({ info: full, warnings: [] });
  const original = { ...source(), nodes: source().nodes.map(node => ({ ...node,
    widgets_values: node.id === 1 ? [512, "own.safetensors"] : ["original-prefix"],
  })) }, bytes = JSON.stringify(original);
  const value = await prepareAutomaticWorkflowImport(original, "positional.json", connection, signal());
  expect(value.prepared.importState.status).toBe("pending");
  expect(value.prepared.config.importReader).toMatchObject({ compileStatus: "needs-confirmation" });
  expect(value.prepared.graph).toBeUndefined();
  expect(value.prepared.source).toBe(original);
  expect(JSON.stringify(original)).toBe(bytes);
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
});

it("keeps an unmatched plugin explicit without substituting a different node or modifying source", async () => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("not-found"));
  const original = source(), bytes = JSON.stringify(original);
  const value = await prepareAutomaticWorkflowImport(original, "private.json", connection, signal());
  expect(value.prepared.importState.status).toBe("pending");
  expect(value.prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ code: "manager-plugin-not-found", classType: "OwnMaker", nodeId: "1" }));
  expect(value.prepared.importState.diagnostics.filter(item => item.classType === "OwnMaker")).toHaveLength(1);
  expect(value.prepared.config.importState).toBe(value.prepared.importState);
  expect(JSON.stringify(original)).toBe(bytes);
  expect(value.warnings).toContain("Manager: not-found");
});

it.each(["failed", "ambiguous", "disabled", "installed-unavailable"] as const)("retains Manager %s as a structured diagnostic", async status => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result(status));
  const value = await prepareAutomaticWorkflowImport(source(), "failed.json", connection, signal());
  expect(value.prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ code: "manager-plugin-" + status, classType: "OwnMaker" }));
});

it("preserves the original file during an outage and does not claim a missing remote plugin", async () => {
  vi.mocked(loadImportSchema).mockResolvedValue({ warnings: ["offline"] });
  const original = source(), bytes = JSON.stringify(original);
  const value = await prepareAutomaticWorkflowImport(original, "offline.json", connection, signal());
  expect(value.prepared.source).toBe(original);
  expect(value.warnings).toContain("offline");
  expect(JSON.stringify(original)).toBe(bytes);
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
});

it("does not install based on a cached node snapshot when the live workstation was unavailable", async () => {
  vi.mocked(loadImportSchema).mockResolvedValue({ info: known, warnings: ["使用此前缓存"] });
  const value = await prepareAutomaticWorkflowImport(source(), "cached.json", connection, signal());
  expect(value.prepared.importState.status).toBe("pending");
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
});

it("includes unknown API classes even when another known node has a separate input error", async () => {
  const original = {
    "1": { class_type: "OwnMaker", inputs: { untouched: "original" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("not-found"));
  await prepareAutomaticWorkflowImport(original, "author-api.json", connection, signal());
  expect(collectMissingManagerNodes).toHaveBeenCalledWith(original, expect.arrayContaining([{ classType: "OwnMaker", nodeId: "1" }]));
  expect(repairMissingManagerPlugins).toHaveBeenCalledTimes(1);
  expect(original["1"].inputs).toEqual({ untouched: "original" });
});

it("does not issue duplicate repair requests for diagnostics and graph references to the same missing node", async () => {
  const original = {
    "1": { class_type: "OwnMaker", inputs: { prompt: "retain" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "keep" } },
  };
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("not-found"));
  await prepareAutomaticWorkflowImport(original, "dedupe-api.json", connection, signal());
  expect(repairMissingManagerPlugins).toHaveBeenCalledTimes(1);
  expect(vi.mocked(repairMissingManagerPlugins).mock.calls[0][1]).toEqual([{ classType: "OwnMaker", nodeId: "1" }]);
});

it("propagates cancellation before any model, Manager, or restart request", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(prepareAutomaticWorkflowImport(source(), "cancel.json", connection, controller.signal)).rejects.toThrow();
  expect(loadImportSchema).not.toHaveBeenCalled();
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
});

it("does not reparse or restart after a cancelled installation", async () => {
  const controller = new AbortController();
  vi.mocked(repairMissingManagerPlugins).mockImplementation(async () => { controller.abort(); return result("installed-pending-restart"); });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(prepareAutomaticWorkflowImport(source(), "cancel.json", connection, controller.signal)).rejects.toThrow();
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["running", "pending"])("leaves installed plugins pending while the workstation has a %s generation", async busy => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async () => Response.json({ queue_running: busy === "running" ? [["active"]] : [], queue_pending: busy === "pending" ? [["queued"]] : [] }));
  vi.stubGlobal("fetch", fetcher);
  const value = await prepareAutomaticWorkflowImport(source(), "busy.json", connection, signal());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toContain("/queue");
  expect(value.prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ code: "manager-plugin-installed-pending-restart", message: "自动安装完成，工作站有任务运行，需任务结束后重启完成接入。" }));
});

it("does not reboot when queue state is invalid or unavailable", async () => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal("fetch", fetcher);
  const value = await prepareAutomaticWorkflowImport(source(), "queue.json", connection, signal());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(value.warnings.join(" ")).toContain("未自动重启");
});

it.each([
  { ...managerIdle, is_processing: true },
  { ...managerIdle, total_count: 2, done_count: 1 },
  { ...managerIdle, in_progress_count: 1 },
  { is_processing: false },
  { ...managerIdle, total_count: -1 },
  { ...managerIdle, done_count: 1.5 },
  null,
])("does not reboot when Manager queue is busy or invalid: %j", async status => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? Response.json({ queue_running: [], queue_pending: [] }) : Response.json(status));
  vi.stubGlobal("fetch", fetcher);
  const value = await prepareAutomaticWorkflowImport(source(), "manager-busy.json", connection, signal());
  expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/queue", "/manager/queue/status"]);
  expect(value.manager?.restartRequired).toBe(true);
  expect(value.prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ code: "manager-plugin-installed-pending-restart", message: expect.stringContaining("安装") }));
});

it("does not reboot when Manager queue status cannot be fetched", async () => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
    throw new TypeError("Manager unavailable");
  });
  vi.stubGlobal("fetch", fetcher);
  const value = await prepareAutomaticWorkflowImport(source(), "manager-unavailable.json", connection, signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(value.warnings.join(" ")).toContain("无法确认 Manager 安装队列；未自动重启");
  expect(value.manager?.restartRequired).toBe(true);
});

it("restarts an idle workstation once and waits for actual node registration before reparsing", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  let reads = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
    if (url.endsWith("/manager/queue/status")) return Response.json(managerIdle);
    if (url.endsWith("/manager/reboot")) {
      expect(init).toMatchObject({ method: "POST", headers: expect.objectContaining({ "Content-Type": "application/json", Authorization: "Bearer private-token" }) });
      return Response.json({});
    }
    if (url.endsWith("/object_info")) return Response.json(++reads === 1 ? known : full);
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "restart.json", connection, signal());
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(2500);
  const value = await running;
  expect(reads).toBe(2);
  expect(fetcher.mock.calls.slice(0, 3).map(([url]) => new URL(url).pathname)).toEqual(["/queue", "/manager/queue/status", "/manager/reboot"]);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/manager/reboot"))).toHaveLength(1);
  expect(value.prepared.importState.status).toBe("ready");
  expect(value.manager?.restartRequired).toBe(false);
  expect(value.manager?.nodes[0].status).toBe("available");
  expect(value.prepared.importState.diagnostics).toEqual([]);
});

it("does not treat a Manager security refusal as a successful restart", async () => {
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? Response.json({ queue_running: [], queue_pending: [] }) : url.endsWith("/manager/queue/status") ? Response.json(managerIdle) : new Response("Security policy", { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  const value = await prepareAutomaticWorkflowImport(source(), "refused.json", connection, signal());
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(value.warnings.join(" ")).toContain("拒绝重启");
  expect(value.prepared.importState.status).toBe("pending");
});

it("recovers a reboot transport disconnect only after the new node is actually registered", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
    if (url.endsWith("/manager/queue/status")) return Response.json(managerIdle);
    if (url.endsWith("/manager/reboot")) throw new TypeError("Network connection closed during execv");
    return Response.json(full);
  });
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "disconnect.json", connection, signal());
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(1500);
  const value = await running;
  expect(value.prepared.importState.status).toBe("ready");
  expect(value.manager?.nodes[0].status).toBe("available");
});

it("stops polling and does not reparse after cancellation during restart", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? Response.json({ queue_running: [], queue_pending: [] }) : Response.json(url.endsWith("/manager/queue/status") ? managerIdle : known));
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "abort-restart.json", connection, controller.signal);
  const rejected = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(1);
});

it("keeps waiting beyond 90 seconds and resolves only when the node actually registers", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  let registered = false, settled = false;
  const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? Response.json({ queue_running: [], queue_pending: [] }) : Response.json(url.endsWith("/manager/queue/status") ? managerIdle : registered ? full : known));
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "not-loaded.json", connection, signal());
  void running.then(() => { settled = true; });
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(301000);
  expect(settled).toBe(false);
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(1);
  registered = true;
  await vi.advanceTimersByTimeAsync(1000);
  const value = await running;
  expect(value.prepared.importState.status).toBe("ready");
  expect(value.manager?.nodes[0].status).toBe("available");
});

it("lets the user cancel a long restart wait without a deadline or request timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? Response.json({ queue_running: [], queue_pending: [] }) : Response.json(url.endsWith("/manager/queue/status") ? managerIdle : known));
  vi.stubGlobal("fetch", fetcher);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const running = prepareAutomaticWorkflowImport(source(), "long-wait.json", connection, controller.signal);
  const rejected = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(301000);
  controller.abort();
  await rejected;
  expect(timeout).not.toHaveBeenCalled();
  timeout.mockRestore();
  expect(prepareWorkflowImport).toHaveBeenCalledTimes(1);
});

it("reports an explicit authentication failure after reboot instead of waiting indefinitely", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
    if (url.endsWith("/manager/queue/status")) return Response.json(managerIdle);
    if (url.endsWith("/manager/reboot")) return Response.json({});
    return new Response("Authentication denied", { status: 403 });
  });
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "auth-after-restart.json", connection, signal());
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(1000);
  const value = await running;
  expect(value.warnings.join(" ")).toContain("读取节点定义被拒绝");
  expect(value.manager?.nodes[0].status).toBe("installed-unavailable");
});

it("stops waiting when Manager explicitly confirms plugin import failure and keeps its actual error", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue(result("installed-pending-restart"));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    if (path === "/manager/queue/status") return Response.json(managerIdle);
    if (path === "/manager/reboot") return Response.json({});
    if (path === "/object_info") return Response.json(known);
    if (path === "/customnode/getlist") return Response.json({ channel: "local", node_packs: { "author-own": { "import-fail": true } } });
    if (path === "/customnode/import_fail_info") {
      expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ cnr_id: "author-own" }), headers: expect.objectContaining({ "Content-Type": "application/json" }) });
      return Response.json({ msg: "ModuleNotFoundError: No module named 'own_dependency'; private-token" });
    }
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetcher);
  const original = source(), bytes = JSON.stringify(original);
  const running = prepareAutomaticWorkflowImport(original, "import-failed.json", connection, signal());
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(1000);
  const value = await running;
  expect(value.manager?.nodes[0].status).toBe("installed-unavailable");
  expect(value.warnings.join(" ")).toContain("ModuleNotFoundError: No module named 'own_dependency'");
  expect(value.warnings.join(" ")).not.toContain(connection.token);
  expect(value.prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ code: "manager-plugin-installed-unavailable", classType: "OwnMaker" }));
  expect(JSON.stringify(original)).toBe(bytes);
  const requests = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(requests);
});

it("keeps waiting for other plugins after one import fails and preserves their later availability", async () => {
  vi.useFakeTimers();
  vi.mocked(repairMissingManagerPlugins).mockResolvedValue({ ...result("installed-pending-restart"),
    nodes: [...result("installed-pending-restart").nodes, { classType: "OtherMaker", nodeId: "other", status: "installed-pending-restart", packageId: "author-other", message: "installed" }],
    installedPackageIds: ["author-own", "author-other"],
  });
  let reads = 0;
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
    if (path === "/manager/queue/status") return Response.json(managerIdle);
    if (path === "/manager/reboot") return Response.json({});
    if (path === "/object_info") return Response.json(++reads === 1 ? known : { ...known, OtherMaker: { input: { required: {} }, output: ["IMAGE"] } });
    if (path === "/customnode/getlist") return Response.json({ node_packs: { "author-own": { "import-fail": true }, "author-other": { "import-fail": false } } });
    if (path === "/customnode/import_fail_info") return new Response("No saved traceback", { status: 400 });
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetcher);
  const running = prepareAutomaticWorkflowImport(source(), "partial-import-failed.json", connection, signal());
  let settled = false; void running.then(() => { settled = true; });
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/manager/reboot"))).toBe(true));
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const value = await running;
  expect(value.manager?.nodes.map(node => node.status)).toEqual(["installed-unavailable", "available"]);
  expect(value.manager?.nodes[0].message).toContain("Manager 确认插件 author-own 导入失败");
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/customnode/import_fail_info"))).toHaveLength(1);
});


it("only reads and diagnoses missing nodes by default, without installing or restarting", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const result = await prepareImport(source(), "read-only.json", connection, signal());
  expect(repairMissingManagerPlugins).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(result.prepared.importState.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "manager-plugin-not-installed", classType: "OwnMaker" }),
  ]));
});
