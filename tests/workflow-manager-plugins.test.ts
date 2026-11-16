import { expect, it, vi } from "vitest";
import { collectMissingManagerNodes, repairMissingManagerPlugins, type ManagerRepairClient } from "../src/workflow/manager-plugins";

type Data = Record<string, unknown>;
const art = { title: "comfyui-art-venture", repository: "https://github.com/sipherxyz/comfyui-art-venture", install_type: "cnr", version: "1.1.7", state: "not-installed" };
const legacy = { title: "Catalog legacy", files: ["https://github.com/example/catalog-plugin"], install_type: "git-clone", version: "unknown", state: "not-installed" };
const idle = { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false };
const missing = [{ classType: "ColorCorrect", nodeId: "92", cnrId: "comfyui-art-venture", version: "1.1.4" }];
function harness(options: { packs?: Data; localPacks?: Data; remotePacks?: Data; mappings?: Data; remoteMappings?: Data; status?: Data; versionStatus?: string; failPath?: string; failStatus?: number; register?: boolean; installFailed?: boolean; mappingFailed?: boolean; startup?: Data; cacheFailed?: boolean; remoteFailed?: boolean; noQueueProgress?: boolean } = {}) {
  let started = false, queuePolls = 0;
  const submitted: Data[] = [];
  const packs = options.packs ?? { "comfyui-art-venture": art };
  const request = vi.fn(async (path: string, init?: RequestInit, timeout?: number | null) => {
    expect(timeout).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (path === options.failPath) return new Response("Manager security policy rejected this action", { status: options.failStatus ?? 403 });
    let response: unknown;
    if (path === "/customnode/getlist?mode=cache&skip_update=true" && options.cacheFailed) throw new TypeError("cache connection failed");
    if (path === "/customnode/getlist?mode=remote&skip_update=true" && options.remoteFailed) throw new TypeError("remote connection failed");
    if (["local", "cache", "remote"].some(mode => path === "/customnode/getlist?mode=" + mode + "&skip_update=true")) response = { channel: path.includes("mode=local") ? "local" : "default", node_packs: Object.fromEntries(Object.entries(path.includes("mode=local") ? options.localPacks ?? packs : path.includes("mode=remote") ? options.remotePacks ?? packs : packs).map(([id, value]) => { const posted = submitted.find(body => body.id === id); return [id, started && !options.installFailed && posted ? { ...(value as Data), state: "enabled", ...(posted.selected_version ? { version: posted.selected_version, active_version: posted.selected_version } : {}) } : value]; })) };
    else if (["local", "cache", "remote"].some(mode => path === "/customnode/getmappings?mode=" + mode)) {
      if (options.mappingFailed) throw new Error("mapping offline");
      response = (path.includes("mode=remote") ? options.remoteMappings : undefined) ?? options.mappings ?? { "comfyui-art-venture": [["ColorCorrect", "OtherArtNode"], { title_aux: "comfyui-art-venture" }] };
    }
    else if (path === "/customnode/installed?mode=imported") response = options.startup ?? Object.fromEntries(Object.entries(packs).filter(([, pack]) => (pack as Data).state !== "not-installed").map(([id, pack]) => [id, { cnr_id: id, aux_id: "", enabled: (pack as Data).state === "enabled", ver: (pack as Data).active_version ?? (pack as Data).version }]));
    else if (path === "/customnode/installed") response = Object.fromEntries(submitted.filter(() => started && !options.installFailed).map(body => [String(body.id), { cnr_id: body.id, aux_id: "", enabled: true, ver: body.selected_version ?? body.version }]));
    else if (path.startsWith("/customnode/versions/")) response = [{ version: "1.1.7", status: options.versionStatus ?? "NodeVersionStatusActive" }, { version: "1.1.4", status: options.versionStatus ?? "NodeVersionStatusActive" }];
    else if (path === "/manager/queue/status") response = !started ? options.status ?? idle : !options.noQueueProgress && queuePolls++ === 0 ? { total_count: submitted.length, done_count: 0, in_progress_count: submitted.length, is_processing: true } : { total_count: submitted.length, done_count: submitted.length, in_progress_count: 0, is_processing: false };
    else if (path === "/manager/queue/install" || path === "/manager/queue/fix") { submitted.push(JSON.parse(String(init?.body))); response = {}; }
    else if (path === "/manager/queue/start") { started = true; response = {}; }
    else if (path === "/object_info") response = options.register && started ? { ColorCorrect: { input: {} } } : {};
    else throw new Error("Unexpected request " + path);
    return new Response(JSON.stringify(response));
  });
  const client: ManagerRepairClient = { request, getObjectInfo: vi.fn(async () => ({})), connection: { baseUrl: "https://workstation.example" } };
  return { client, request, submitted };
}
const runOptions = { initialObjectInfo: {}, pollIntervalMs: 1 };

it("uses saved cnr_id and version instead of confusing two ColorCorrect plugins", () => {
  const source = { nodes: [{ id: 92, type: "ColorCorrect", properties: { cnr_id: "comfyui-art-venture", ver: "1.1.4" } }] };
  expect(collectMissingManagerNodes(source, [{ classType: "ColorCorrect", nodeId: "92" }])).toEqual(missing);
});
it("deduplicates diagnostics and preserves conflicting metadata without guessing", () => {
  const source = { nodes: [{ id: 1, type: "ColorCorrect", properties: { cnr_id: "one" } }, { id: 2, type: "ColorCorrect", properties: { cnr_id: "two" } }] };
  expect(collectMissingManagerNodes(source, [{ classType: "ColorCorrect" }, { classType: "ColorCorrect" }])).toEqual([{ classType: "ColorCorrect", metadataConflict: true }]);
  expect(collectMissingManagerNodes(source, [{ classType: "ColorCorrect", nodeId: "2" }])).toEqual([{ classType: "ColorCorrect", nodeId: "2", cnrId: "two" }]);
});
it("finds metadata in nested subgraphs and API workflow records", () => {
  expect(collectMissingManagerNodes({ definitions: { subgraphs: [{ nodes: [{ id: 4, type: "Nested", properties: { aux_id: "Example/Plugin" } }] }] } }, [{ classType: "Nested", nodeId: "2:4" }])[0].auxId).toBe("Example/Plugin");
  expect(collectMissingManagerNodes({ prompt: { "12": { class_type: "API", inputs: {}, properties: { cnr_id: "api-pack" } } } }, [{ classType: "API", nodeId: "12" }])[0].cnrId).toBe("api-pack");
});
it("installs the exact Active workflow version via the verified Manager queue protocol", async () => {
  const { client, request, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted).toEqual([{ id: "comfyui-art-venture", version: "1.1.7", selected_version: "1.1.4", channel: "local", mode: "local", ui_id: "draw-studio:comfyui-art-venture", skip_post_install: false, repository: art.repository, install_type: "cnr" }]);
  expect(request.mock.calls.findIndex(([path]) => path === "/manager/queue/start")).toBeGreaterThan(request.mock.calls.findIndex(([path]) => path === "/manager/queue/install"));
  expect(result.nodes[0].status).toBe("installed-pending-restart");
  expect(result.restartRequired).toBe(true);
  expect(result.installedPackageIds).toEqual(["comfyui-art-venture"]);
  expect(request.mock.calls.every(([path]) => !path.includes("reboot") && !path.includes("reset") && !path.includes("git_url") && !path.includes("/pip"))).toBe(true);
});
it("only confirms availability from actual object_info, never queue success", async () => {
  const { client } = harness({ register: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.nodes[0].status).toBe("available"); expect(result.restartRequired).toBe(false);
  expect(result.objectInfo.ColorCorrect).toBeTruthy();
});
it("does nothing when the live node is already available", async () => {
  const { client, request } = harness();
  const result = await repairMissingManagerPlugins(client, missing, { initialObjectInfo: { ColorCorrect: {} } });
  expect(result.nodes[0].status).toBe("available"); expect(request).not.toHaveBeenCalled();
});
it("loads object_info with cancellation when no initial schema is supplied", async () => {
  const { client, request } = harness();
  await repairMissingManagerPlugins(client, [], {});
  expect(request.mock.calls[0][0]).toBe("/object_info");
});
it("does not install a same-named plugin when explicit cnr_id is absent from Manager", async () => {
  const { client, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, [{ classType: "ColorCorrect", cnrId: "private-plugin" }], runOptions);
  expect(result.nodes[0].status).toBe("not-found"); expect(submitted).toEqual([]);
});
it("uses Manager's case-insensitive normalized package ID matching", async () => {
  const { client, submitted } = harness();
  await repairMissingManagerPlugins(client, [{ ...missing[0], cnrId: "ComfyUI-Art-Venture" }], runOptions);
  expect(submitted[0].id).toBe("comfyui-art-venture");
});
it("keeps a genuine duplicate class mapping ambiguous without metadata", async () => {
  const other = { ...legacy, files: ["https://github.com/EllangoK/ComfyUI-post-processing-nodes"] };
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": art, other }, mappings: { "comfyui-art-venture": [["ColorCorrect"], {}], "https://github.com/EllangoK/ComfyUI-post-processing-nodes": [["ColorCorrect"], {}] } });
  const result = await repairMissingManagerPlugins(client, [{ classType: "ColorCorrect" }], runOptions);
  expect(result.nodes[0].status).toBe("ambiguous"); expect(submitted).toEqual([]);
});
it("matches aux_id against the full exact repository identity, not basename", async () => {
  const other = { ...legacy, files: ["https://github.com/imposter/catalog-plugin"] };
  const { client, submitted } = harness({ packs: { actual: legacy, impostor: other } });
  await repairMissingManagerPlugins(client, [{ classType: "Legacy", auxId: "example/catalog-plugin" }], runOptions);
  expect(submitted.map(body => body.id)).toEqual(["actual"]);
});
it("does not treat a workflow URL as an install target", async () => {
  const { client, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, [{ classType: "Unknown", auxId: "https://evil.example/plugin" }], runOptions);
  expect(result.nodes[0].status).toBe("not-found"); expect(submitted).toEqual([]);
});
it("uses exact class mapping to a catalog legacy URL and ignores regex guesses", async () => {
  const { client, submitted } = harness({ packs: { actual: legacy }, mappings: { "https://github.com/example/catalog-plugin": [["Legacy"], { nodename_pattern: ".*" }] } });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Legacy" }, { classType: "NotListed" }], runOptions);
  expect(submitted.map(body => body.id)).toEqual(["actual"]); expect(result.nodes[1].status).toBe("not-found");
});
it("deduplicates two missing classes from the same package", async () => {
  const { client, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, [...missing, { classType: "OtherArtNode", cnrId: "comfyui-art-venture", version: "1.1.4" }], runOptions);
  expect(submitted).toHaveLength(1); expect(result.nodes).toHaveLength(2);
});
it("preserves another user's active or unstarted Manager queue", async () => {
  for (const status of [{ ...idle, is_processing: true }, { ...idle, total_count: 1 }]) {
    const { client, request, submitted } = harness({ status });
    const result = await repairMissingManagerPlugins(client, missing, runOptions);
    expect(result.managerError).toContain("其他安装任务"); expect(submitted).toEqual([]);
    expect(request.mock.calls.some(([path]) => path.includes("reset") || path.includes("/start"))).toBe(false);
  }
});
it("rejects malformed queue statistics before modifying Manager", async () => {
  const { client, submitted } = harness({ status: { is_processing: false } });
  expect((await repairMissingManagerPlugins(client, missing, runOptions)).managerError).toContain("状态无效"); expect(submitted).toEqual([]);
});
it("never lowers Manager security or retries a rejected install through a different endpoint", async () => {
  const { client, request } = harness({ failPath: "/manager/queue/install" });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.nodes[0].message).toContain("HTTP 403"); expect(result.restartRequired).toBe(false);
  expect(request.mock.calls.filter(([path, init]) => init?.method === "POST").map(([path]) => path)).toEqual(["/manager/queue/install"]);
});
it("does not install Flagged, Pending or unknown CNR versions", async () => {
  for (const versionStatus of ["NodeVersionStatusFlagged", "NodeVersionStatusPending", ""]) {
    const { client, submitted } = harness({ versionStatus });
    const result = await repairMissingManagerPlugins(client, missing, runOptions);
    expect(result.nodes[0].message).toContain("Active"); expect(submitted).toEqual([]);
  }
});
it("does not silently downgrade a blocked catalog latest release to another Active version", async () => {
  const { client, submitted } = harness({ versionStatus: "NodeVersionStatusFlagged" });
  const result = await repairMissingManagerPlugins(client, [{ classType: "ColorCorrect", cnrId: "comfyui-art-venture" }], runOptions);
  expect(result.nodes[0].message).toContain("1.1.7"); expect(submitted).toEqual([]);
});
it("rejects incompatible version requirements from the same workflow", async () => {
  const { client, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, [...missing, { classType: "OtherArtNode", cnrId: "comfyui-art-venture", version: "1.1.7" }], runOptions);
  expect(result.nodes.every(node => node.message.includes("版本要求"))).toBe(true); expect(submitted).toEqual([]);
});
it("does not reinstall or upgrade an enabled plugin just because a class is absent", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, state: "enabled" } } });
  const result = await repairMissingManagerPlugins(client, [{ classType: "ColorCorrect", cnrId: "comfyui-art-venture" }], runOptions);
  expect(result.nodes[0].status).toBe("installed-unavailable"); expect(submitted).toEqual([]);
});
it("enables a disabled catalog package through Manager's existing skip_post_install operation", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, state: "disabled" } } });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted[0].skip_post_install).toBe(true); expect(submitted[0].selected_version).toBeUndefined(); expect(result.restartRequired).toBe(true);
});
it("uses Manager dependency fix for a catalog package with an import failure", async () => {
  const { client, request } = harness({ packs: { "comfyui-art-venture": { ...art, version: "1.1.4", state: "enabled", "import-fail": true } } });
  await repairMissingManagerPlugins(client, missing, runOptions);
  expect(request.mock.calls.some(([path]) => path === "/manager/queue/fix")).toBe(true);
  expect(request.mock.calls.some(([path]) => path === "/manager/queue/install")).toBe(false);
});
it("does not call a successful queue completion a successful installation when the catalog is unchanged", async () => {
  const { client } = harness({ installFailed: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.nodes[0].status).toBe("failed"); expect(result.restartRequired).toBe(false); expect(result.installedPackageIds).toEqual([]);
});
it("uses saved exact package metadata when node mapping is offline", async () => {
  const { client, submitted } = harness({ mappingFailed: true });
  await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted).toHaveLength(1);
});
it("does not call a failed mapping lookup proof that no Manager plugin exists", async () => {
  const { client, submitted } = harness({ mappingFailed: true });
  const result = await repairMissingManagerPlugins(client, [{ classType: "ColorCorrect" }], runOptions);
  expect(result.nodes[0].status).toBe("failed"); expect(result.nodes[0].message).toContain("映射读取失败"); expect(submitted).toEqual([]);
});
it("does not install a guessed package when all Manager index modes fail", async () => {
  const { client, submitted } = harness({ failPath: "/customnode/getlist?mode=local&skip_update=true", failStatus: 404, cacheFailed: true, remoteFailed: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.managerError).toContain("HTTP 404"); expect(submitted).toEqual([]);
});
it("installs an exact bundled local match without waiting for the complete online catalog", async () => {
  const { client, submitted, request } = harness({ cacheFailed: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted[0].channel).toBe("local"); expect(submitted[0].mode).toBe("local"); expect(result.restartRequired).toBe(true);
  expect(request.mock.calls.some(([path]) => path.includes("mode=cache"))).toBe(false);
});
it("does not call a partial local catalog proof that a pure Registry plugin is missing", async () => {
  const { client, submitted } = harness({ cacheFailed: true, remoteFailed: true });
  const result = await repairMissingManagerPlugins(client, [{ classType: "T8", cnrId: "pure-registry-package" }], runOptions);
  expect(result.nodes[0].status).toBe("failed"); expect(result.nodes[0].message).toContain("未能完成 Manager 在线搜索"); expect(submitted).toEqual([]);
});
it("installs exact local matches before waiting for the complete catalog and still resolves pure Registry packages", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": art, pure: { ...art, title: "Pure Registry", repository: "https://github.com/example/pure" } }, localPacks: { "comfyui-art-venture": art } });
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedFullCatalog = new Promise<void>(resolve => { reached = resolve; });
  const original = client.request;
  client.request = async (path, init, timeout) => { if (path === "/customnode/getlist?mode=cache&skip_update=true") { reached(); await held; } return original(path, init, timeout); };
  const pending = repairMissingManagerPlugins(client, [...missing, { classType: "PureClass", cnrId: "pure", version: "1.1.4" }], runOptions);
  try {
    await reachedFullCatalog;
    expect(submitted.map(body => body.id)).toEqual(["comfyui-art-venture"]);
    release();
    const result = await pending;
    expect(submitted.map(body => body.id)).toEqual(["comfyui-art-venture", "pure"]);
    expect(submitted.map(body => body.mode)).toEqual(["local", "cache"]);
    expect(result.nodes.every(node => node.status === "installed-pending-restart")).toBe(true);
    expect(result.installedPackageIds).toEqual(["comfyui-art-venture", "pure"]);
  } finally { release(); }
});
it("searches Manager remote mode after both bundled and cached indexes miss", async () => {
  const { client, request, submitted } = harness({ packs: {}, localPacks: {}, remotePacks: { actual: legacy }, mappings: {}, remoteMappings: { "https://github.com/example/catalog-plugin": [["NewOnlineClass"], {}] } });
  const result = await repairMissingManagerPlugins(client, [{ classType: "NewOnlineClass" }], runOptions);
  expect(request.mock.calls.filter(([path]) => path.startsWith("/customnode/getlist?")).map(([path]) => path)).toEqual([
    "/customnode/getlist?mode=local&skip_update=true", "/customnode/getlist?mode=cache&skip_update=true", "/customnode/getlist?mode=remote&skip_update=true", "/customnode/getlist?mode=remote&skip_update=true",
  ]);
  expect(request.mock.calls.some(([path]) => path === "/customnode/getmappings?mode=remote")).toBe(true);
  expect(submitted.map(body => [body.id, body.mode])).toEqual([["actual", "remote"]]);
  expect(result.restartRequired).toBe(true);
});
it("only reports no reliable match after requesting online Manager search", async () => {
  const { client, request, submitted } = harness({ packs: {}, mappings: {} });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Unavailable" }], runOptions);
  expect(request.mock.calls.some(([path]) => path.includes("mode=remote"))).toBe(true);
  expect(result.nodes[0].status).toBe("not-found");
  expect(result.nodes[0].message).toContain("在线更新并搜索");
  expect(result.nodes[0].message).toContain("可能回退");
  expect(result.nodes[0].message).not.toContain("当前目录");
  expect(submitted).toEqual([]);
});
it("retains a real online request failure instead of calling it a missing plugin", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {}, remoteFailed: true });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Unavailable" }], runOptions);
  expect(result.nodes[0].status).toBe("failed");
  expect(result.nodes[0].message).toContain("remote connection failed");
  expect(submitted).toEqual([]);
});
it("can recover through remote search when both faster Manager indexes fail", async () => {
  const { client, submitted } = harness({ failPath: "/customnode/getlist?mode=local&skip_update=true", cacheFailed: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted[0].mode).toBe("remote");
  expect(result.restartRequired).toBe(true);
});
it("installs exact remote matches only once after processing known local packages", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": art }, remotePacks: { "comfyui-art-venture": art, new: legacy }, remoteMappings: { new: [["OnlineClass"], {}] } });
  const result = await repairMissingManagerPlugins(client, [...missing, { classType: "OnlineClass" }], runOptions);
  expect(submitted.map(body => [body.id, body.mode])).toEqual([["comfyui-art-venture", "local"], ["new", "remote"]]);
  expect(result.installedPackageIds).toEqual(["comfyui-art-venture", "new"]);
});
it("uses verified direct online discovery before requesting Manager remote refresh and verifies disk state after install", async () => {
  const { client, request, submitted } = harness({ packs: {}, mappings: {} });
  const discoverOnline = vi.fn(async () => ({ matches: [{ classType: "ColorCorrect", nodeId: "92", packageId: "comfyui-art-venture", pack: art, source: "Comfy Registry exact class + version" }], unresolved: [] }));
  const result = await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline });
  expect(discoverOnline).toHaveBeenCalledTimes(1);
  expect(discoverOnline.mock.calls[0][0]).toMatchObject(missing);
  expect(request.mock.calls.some(([path]) => path === "/customnode/installed")).toBe(true);
  expect(request.mock.calls.filter(([path]) => path === "/customnode/installed")).toHaveLength(2);
  expect(request.mock.calls.some(([path]) => path.includes("mode=remote"))).toBe(false);
  expect(request.mock.calls.some(([path]) => path.includes("mode=cache"))).toBe(false);
  expect(submitted.map(body => [body.id, body.mode, body.selected_version])).toEqual([["comfyui-art-venture", "remote", "1.1.4"]]);
  expect(result.installedPackageIds).toEqual(["comfyui-art-venture"]);
  expect(result.nodes[0].status).toBe("installed-pending-restart");
});
it("skips Manager cache after a local catalog failure when direct official discovery is available", async () => {
  const { client, request, submitted } = harness({ packs: {}, mappings: {}, failPath: "/customnode/getlist?mode=local&skip_update=true", failStatus: 503 });
  const discoverOnline = vi.fn(async () => ({ matches: [{ ...missing[0], packageId: "comfyui-art-venture", pack: art, source: "Official Registry" }], unresolved: [] }));
  const result = await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline });
  expect(discoverOnline).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.some(([path]) => path.includes("mode=cache"))).toBe(false);
  expect(request.mock.calls.some(([path]) => path.includes("mode=remote"))).toBe(false);
  expect(submitted).toHaveLength(1);
  expect(result.nodes[0].status).toBe("installed-pending-restart");
});
it("never assumes a verified online package is uninstalled", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const original = client.request;
  client.request = (path, init, timeout) => path === "/customnode/installed" ? Promise.resolve(new Response(JSON.stringify({ art: { cnr_id: "comfyui-art-venture", aux_id: "", enabled: true, ver: "1.1.4" } }))) : original(path, init, timeout);
  const result = await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline: async () => ({ matches: [{ ...missing[0], packageId: "comfyui-art-venture", pack: art, source: "Official Registry" }], unresolved: [] }) });
  expect(result.nodes[0].status).toBe("installed-pending-restart"); expect(submitted).toEqual([]);
});
it("enables an online-discovered disabled package using its exact installed state", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const original = client.request;
  client.request = (path, init, timeout) => path === "/customnode/installed" ? Promise.resolve(new Response(JSON.stringify({ art: { cnr_id: "comfyui-art-venture", aux_id: "", enabled: submitted.length > 0, ver: "1.1.4" } }))) : original(path, init, timeout);
  await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline: async () => ({ matches: [{ ...missing[0], packageId: "comfyui-art-venture", pack: art, source: "Official Registry" }], unresolved: [] }) });
  expect(submitted[0].skip_post_install).toBe(true); expect(submitted[0].selected_version).toBeUndefined();
});
it("uses authoritative online not-found details instead of ambiguous directory wording", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Unavailable" }], { ...runOptions, discoverOnline: async () => ({ matches: [], unresolved: [{ classType: "Unavailable", status: "not-found", message: "已搜索官方实时节点映射及 Registry，没有该节点的可验证发布。" }] }) });
  expect(result.nodes[0].status).toBe("not-found"); expect(result.nodes[0].message).toContain("官方实时"); expect(submitted).toEqual([]);
});
it("keeps discovery network failures distinct from verified absence", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Unavailable" }], { ...runOptions, discoverOnline: async () => { throw new TypeError("Registry network offline"); } });
  expect(result.nodes[0].status).toBe("failed"); expect(result.nodes[0].message).toContain("Registry network offline"); expect(submitted).toEqual([]);
});
it("falls back to Manager remote search after a real direct search failure and can install its exact match", async () => {
  const { client, request, submitted } = harness({ packs: {}, mappings: {}, remotePacks: { actual: legacy }, remoteMappings: { actual: [["OnlineClass"], {}] } });
  const discoverOnline = vi.fn(async () => { throw new TypeError("Registry network offline"); });
  const result = await repairMissingManagerPlugins(client, [{ classType: "OnlineClass" }], { ...runOptions, discoverOnline });
  expect(discoverOnline).toHaveBeenCalled();
  expect(request.mock.calls.some(([path]) => path.includes("mode=remote"))).toBe(true);
  expect(submitted.map(body => body.id)).toEqual(["actual"]);
  expect(result.nodes[0].status).toBe("installed-pending-restart");
});
it("does not install a discovery package until Manager's real installation state is readable", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {}, failPath: "/customnode/installed" });
  const result = await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline: async () => ({ matches: [{ ...missing[0], packageId: "comfyui-art-venture", pack: art, source: "Official Registry" }], unresolved: [] }) });
  expect(result.nodes[0].status).toBe("failed"); expect(result.nodes[0].message).toContain("HTTP 403"); expect(submitted).toEqual([]);
});
it("rejects an online source that conflicts with the workflow's saved plugin identity", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const result = await repairMissingManagerPlugins(client, missing, { ...runOptions, discoverOnline: async () => ({ matches: [{ ...missing[0], packageId: "impostor", pack: legacy, source: "Search candidate" }], unresolved: [] }) });
  expect(result.nodes[0].status).toBe("failed"); expect(result.nodes[0].message).toContain("来源不一致"); expect(submitted).toEqual([]);
});
it("does not infer another class is provided just because direct discovery found its saved package", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const second = { classType: "OtherMissingClass", cnrId: "comfyui-art-venture" };
  const result = await repairMissingManagerPlugins(client, [...missing, second], { ...runOptions, discoverOnline: async () => ({ matches: [{ ...missing[0], packageId: "comfyui-art-venture", pack: art, source: "Official Registry" }], unresolved: [{ ...second, status: "not-found", message: "该版本未发布此类。" }] }) });
  expect(submitted).toHaveLength(1);
  expect(result.nodes[1].status).toBe("not-found"); expect(result.nodes[1].message).toBe("该版本未发布此类。");
});
it("preserves a genuine multiple-source ambiguity returned by online discovery", async () => {
  const { client, submitted } = harness({ packs: {}, mappings: {} });
  const result = await repairMissingManagerPlugins(client, [{ classType: "Duplicate" }], { ...runOptions, discoverOnline: async () => ({ matches: ["one", "two"].map(packageId => ({ classType: "Duplicate", packageId, pack: legacy, source: "Official node mapping" })), unresolved: [] }) });
  expect(result.nodes[0].status).toBe("ambiguous"); expect(submitted).toEqual([]);
});
it("does not impose a time limit on remote Manager refresh", async () => {
  vi.useFakeTimers();
  const { client, submitted } = harness({ packs: {}, remotePacks: { actual: legacy }, mappings: {}, remoteMappings: { actual: [["OnlineClass"], {}] }, noQueueProgress: true });
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedRemote = new Promise<void>(resolve => { reached = resolve; });
  const original = client.request;
  client.request = async (path, init, timeout) => { if (path === "/customnode/getlist?mode=remote&skip_update=true") { expect(timeout).toBeNull(); reached(); await held; expect(init?.signal?.aborted).toBe(false); } return original(path, init, timeout); };
  const pending = repairMissingManagerPlugins(client, [{ classType: "OnlineClass" }], runOptions);
  try { await reachedRemote; await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000); expect(submitted).toEqual([]); release(); expect((await pending).restartRequired).toBe(true); }
  finally { release(); vi.useRealTimers(); }
});
it("does not replace missing ComfyUI core nodes with custom plugins", async () => {
  const { client, submitted } = harness();
  const result = await repairMissingManagerPlugins(client, [{ classType: "SaveVideo", cnrId: "comfy-core" }], runOptions);
  expect(result.nodes[0].message).toContain("内置节点"); expect(submitted).toEqual([]);
});
it("honors cancellation without enqueueing or resetting any Manager task", async () => {
  const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
  const { client, request } = harness();
  await expect(repairMissingManagerPlugins(client, missing, { ...runOptions, signal: controller.signal })).rejects.toThrow("Cancelled");
  expect(request).not.toHaveBeenCalled();
});
it("does not mistake inherited object properties for registered ComfyUI nodes", async () => {
  const { client } = harness();
  const result = await repairMissingManagerPlugins(client, [{ classType: "__proto__" }], runOptions);
  expect(result.nodes[0].status).toBe("not-found");
});
it("keeps waiting for a long installation without a total or per-request timeout or resubmission", async () => {
  vi.useFakeTimers();
  const { client, request, submitted } = harness();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedPoll = new Promise<void>(resolve => { reached = resolve; });
  const original = client.request;
  client.request = async (path, init, timeout) => {
    if (path === "/manager/queue/status" && submitted.length) { expect(timeout).toBeNull(); reached(); await held; expect(init?.signal?.aborted).toBe(false); return new Response(JSON.stringify({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false })); }
    return original(path, init, timeout);
  };
  const pending = repairMissingManagerPlugins(client, missing, runOptions);
  let completed = false; void pending.then(() => { completed = true; });
  try {
    await reachedPoll;
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
    expect(completed).toBe(false); expect(submitted).toHaveLength(1);
    release();
    const result = await pending;
    expect(result.managerError).toBeUndefined(); expect(result.restartRequired).toBe(true);
    expect(request.mock.calls.filter(([path]) => path === "/manager/queue/install")).toHaveLength(1);
  } finally { release(); vi.useRealTimers(); }
});
it("does not abandon a complete catalog lookup merely because it is slow", async () => {
  vi.useFakeTimers();
  const { client, request } = harness({ noQueueProgress: true, localPacks: {} });
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedCatalog = new Promise<void>(resolve => { reached = resolve; });
  const original = client.request;
  client.request = async (path, init, timeout) => { if (path === "/customnode/getlist?mode=cache&skip_update=true") { reached(); await held; expect(init?.signal?.aborted).toBe(false); } return original(path, init, timeout); };
  const pending = repairMissingManagerPlugins(client, missing, runOptions);
  try {
    await reachedCatalog;
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
    expect(request.mock.calls.filter(([path]) => path === "/customnode/getlist?mode=local&skip_update=true")).toHaveLength(1);
    release(); expect((await pending).restartRequired).toBe(true);
  } finally { release(); vi.useRealTimers(); }
});
it("still honors explicit cancellation while an unlimited catalog request is pending", async () => {
  const { client, submitted } = harness({ localPacks: {} });
  const controller = new AbortController();
  let reached!: () => void;
  const reachedCatalog = new Promise<void>(resolve => { reached = resolve; });
  const original = client.request;
  client.request = async (path, init, timeout) => {
    if (path === "/customnode/getlist?mode=cache&skip_update=true") {
      expect(timeout).toBeNull(); reached();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    }
    return original(path, init, timeout);
  };
  const pending = repairMissingManagerPlugins(client, missing, { ...runOptions, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("Cancelled");
  await reachedCatalog; controller.abort(new DOMException("Cancelled", "AbortError"));
  await rejected; expect(submitted).toEqual([]);
});
it("prevents concurrent import repair mutations against the same workstation", async () => {
  const first = harness(), second = harness();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedInstall = new Promise<void>(resolve => { reached = resolve; });
  const original = first.client.request;
  first.client.request = async (path, init, timeout) => { if (path === "/manager/queue/install") { reached(); await held; } return original(path, init, timeout); };
  const pending = repairMissingManagerPlugins(first.client, missing, runOptions);
  await reachedInstall;
  try {
    const result = await repairMissingManagerPlugins(second.client, missing, runOptions);
    expect(result.managerError).toContain("另一份工作流"); expect(second.submitted).toEqual([]);
  } finally { release(); }
  expect((await pending).restartRequired).toBe(true);
});
it("switches only to an explicit different Active workflow version to restore a missing class", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, state: "enabled", version: "1.0.0" } } });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted[0].selected_version).toBe("1.1.4"); expect(result.restartRequired).toBe(true);
});
it("does not switch an enabled plugin to a blocked workflow version", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, state: "enabled", version: "1.0.0" } }, versionStatus: "NodeVersionStatusPending" });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(submitted).toEqual([]); expect(result.nodes[0].message).toContain("Active");
});
it("allows Manager's deferred CNR switch to be verified after restart without claiming its target is installed", async () => {
  const { client } = harness({ packs: { "comfyui-art-venture": { ...art, state: "enabled", version: "1.0.0" } }, installFailed: true });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.nodes[0].status).toBe("installed-pending-restart"); expect(result.nodes[0].message).toContain("目标版本和节点尚未确认"); expect(result.restartRequired).toBe(true); expect(result.installedPackageIds).toEqual([]);
});
it("starts an accepted batch with a separate unlimited signal if dialog cancellation interrupts enqueueing", async () => {
  const controller = new AbortController();
  const { client, request, submitted } = harness({ packs: { "comfyui-art-venture": art, next: legacy } });
  await expect(repairMissingManagerPlugins(client, [...missing, { classType: "Legacy", cnrId: "next" }], { ...runOptions, signal: controller.signal, onProgress: message => { if (message.includes("正在安装 Catalog legacy")) controller.abort(); } })).rejects.toThrow("安装将继续");
  expect(submitted).toHaveLength(1);
  const starts = request.mock.calls.filter(([path]) => path === "/manager/queue/start");
  expect(starts).toHaveLength(1); expect(starts[0][1]?.signal?.aborted).toBe(false); expect(starts[0][2]).toBeNull();
  expect(request.mock.calls.some(([path]) => path.includes("reset"))).toBe(false);
});
it("returns cancellation immediately while the accepted queue start continues in the background", async () => {
  const controller = new AbortController();
  const { client } = harness({ packs: { "comfyui-art-venture": art, next: legacy } });
  let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reachedStart = new Promise<void>(resolve => { reached = resolve; });
  const backgroundFinished = new Promise<void>(resolve => { finished = resolve; });
  let startSignal: AbortSignal | null | undefined;
  const original = client.request;
  client.request = async (path, init, timeout) => {
    if (path === "/manager/queue/start") { startSignal = init?.signal; expect(timeout).toBeNull(); reached(); await held; }
    const response = await original(path, init, timeout);
    if (path === "/manager/queue/start") finished();
    return response;
  };
  const pending = repairMissingManagerPlugins(client, [...missing, { classType: "Legacy", cnrId: "next" }], { ...runOptions, signal: controller.signal, onProgress: message => { if (message.includes("正在安装 Catalog legacy")) controller.abort(); } });
  const rejected = expect(pending).rejects.toThrow("安装将继续");
  try { await reachedStart; await rejected; expect(startSignal?.aborted).toBe(false); }
  finally { release(); await backgroundFinished; await Promise.resolve(); }
});
it("recovers a package installed after startup without reinstalling it after cancellation", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, version: "1.1.4", state: "enabled" } }, startup: {} });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.restartRequired).toBe(true); expect(result.nodes[0].message).toContain("未重复安装"); expect(submitted).toEqual([]);
});
it("recovers a CNR version changed since startup without a second version switch", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, version: "1.1.4", state: "enabled" } }, startup: { art: { cnr_id: "comfyui-art-venture", aux_id: "", enabled: true, ver: "1.0.0" } } });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.restartRequired).toBe(true); expect(submitted).toEqual([]);
});
it("does not infer a pending restart from an unavailable startup snapshot", async () => {
  const { client, submitted } = harness({ packs: { "comfyui-art-venture": { ...art, version: "1.1.4", state: "enabled" } }, failPath: "/customnode/installed?mode=imported" });
  const result = await repairMissingManagerPlugins(client, missing, runOptions);
  expect(result.nodes[0].status).toBe("installed-unavailable"); expect(result.restartRequired).toBe(false); expect(submitted).toEqual([]);
});
