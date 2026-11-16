import { afterEach, expect, it, vi } from "vitest";
import { discoverOnlineManagerPlugins } from "../src/workflow/manager-online-discovery";
import type { ManagerMissingNode } from "../src/workflow/manager-plugins";

type Data = Record<string, unknown>;
type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
const active = "NodeVersionStatusActive";
const artist = {
  id: "comfyui-art-venture", name: "ComfyUI ArtVenture", status: "NodeStatusActive",
  repository: "https://github.com/sipherxyz/comfyui-art-venture",
  latest_version: { version: "1.1.7", status: active },
};
const missingArtist: ManagerMissingNode = { classType: "ColorCorrect", nodeId: "252", cnrId: artist.id, version: "1.1.4" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => json({ message: "Not found" }, 404);

function harness(route: Route = () => undefined, freshMap: Data = {}, freshPacks: Data[] = []) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init });
    const response = await route(url, init);
    if (response) return response;
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/extension-node-map.json")) return json(freshMap);
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/custom-node-list.json")) return json({ custom_nodes: freshPacks });
    if (url.pathname === "/nodes/search") return json({ nodes: [], page: Number(url.searchParams.get("page") ?? "1"), totalPages: 1, total: 0, limit: 100 });
    return notFound();
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}
function artistRoute(url: URL): Response | undefined {
  if (url.pathname === "/nodes/" + artist.id) return json(artist);
  if (url.pathname === `/nodes/${artist.id}/versions/1.1.4`) return json({ version: "1.1.4", node_id: artist.id, status: active });
  if (url.pathname === `/nodes/${artist.id}/versions/1.1.4/comfy-nodes/ColorCorrect`) return json({ comfy_node_name: "ColorCorrect", node_id: artist.id, status: active });
  return undefined;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("discovers an exact workflow CNR version and confirms the missing class belongs to it", async () => {
  const { requests } = harness(artistRoute);
  const result = await discoverOnlineManagerPlugins([missingArtist], new AbortController().signal);
  expect(result.unresolved).toEqual([]);
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({ classType: "ColorCorrect", nodeId: "252", packageId: artist.id });
  expect(requests.some(({ url }) => url.pathname === `/nodes/${artist.id}/versions/1.1.4/comfy-nodes/ColorCorrect`)).toBe(true);
  expect(requests.some(({ url }) => url.pathname === `/nodes/${artist.id}/versions/1.1.7/comfy-nodes/ColorCorrect`)).toBe(false);
});

it("returns not-found when Registry search candidates do not export the exact class", async () => {
  harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [artist], totalPages: 1 });
    return url.pathname.endsWith("/comfy-nodes/ColorCorrect") ? notFound() : artistRoute(url);
  });
  const result = await discoverOnlineManagerPlugins([{ ...missingArtist, cnrId: undefined }], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0]).toMatchObject({ classType: "ColorCorrect", nodeId: "252", status: "not-found" });
});

it("keeps Registry service failures distinct from proof that a class is absent", async () => {
  harness(url => url.pathname.endsWith("/comfy-nodes/ColorCorrect") ? json({ message: "Registry unavailable" }, 503) : artistRoute(url));
  const result = await discoverOnlineManagerPlugins([missingArtist], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0].status).toBe("failed");
  expect(result.unresolved[0].message).toContain("503");
});

it("does not send workstation credentials or cookies to public discovery services", async () => {
  const { requests } = harness(artistRoute);
  const signal = new AbortController().signal;
  await discoverOnlineManagerPlugins([missingArtist], signal);
  expect(requests.length).toBeGreaterThan(2);
  for (const { url, init } of requests) {
    expect(["raw.githubusercontent.com", "api.comfy.org"]).toContain(url.hostname);
    expect(url.username).toBe(""); expect(url.password).toBe("");
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    expect(init?.signal).toBe(signal);
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
  }
});

it("keeps waiting without a deadline and stops only when the caller cancels", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let waiting = 0;
  const { requests } = harness(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    waiting++;
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const work = discoverOnlineManagerPlugins([missingArtist], controller.signal);
  let settled = false;
  const observed = work.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(waiting).toBeGreaterThan(0); expect(settled).toBe(false);
  expect(requests.every(({ init }) => init?.signal === controller.signal)).toBe(true);
  controller.abort(new DOMException("User stopped discovery", "AbortError"));
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  await observed;
});

it("aborts before issuing a request when cancellation is already requested", async () => {
  const { fetch } = harness();
  const controller = new AbortController(); controller.abort();
  await expect(discoverOnlineManagerPlugins([missingArtist], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not substitute a same-named class from a repository that conflicts with saved aux_id", async () => {
  harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [artist], page: 1, totalPages: 1, total: 1, limit: 100 });
    return artistRoute(url);
  });
  const result = await discoverOnlineManagerPlugins([{ ...missingArtist, cnrId: undefined, auxId: "other-owner/comfyui-art-venture" }], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0].status).toBe("not-found");
});

it("does not silently downgrade a Flagged latest Registry release", async () => {
  const flagged = { ...artist, latest_version: { version: "1.94.0", status: "NodeVersionStatusFlagged" } };
  const { requests } = harness(url => {
    if (url.pathname === "/nodes/" + artist.id) return json(flagged);
    if (url.pathname === `/nodes/${artist.id}/versions/1.94.0`) return json({ node_id: artist.id, version: "1.94.0", status: "NodeVersionStatusFlagged" });
    return artistRoute(url);
  });
  const result = await discoverOnlineManagerPlugins([{ classType: "ColorCorrect", cnrId: artist.id }], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0].status).toBe("failed");
  expect(result.unresolved[0].message).toMatch(/Flagged|Active|1\.94\.0/);
  expect(requests.some(({ url }) => /versions\/(1\.1\.4|1\.1\.7)/.test(url.pathname))).toBe(false);
});

it("does not bypass a Flagged Registry release through the same repository's legacy Git listing", async () => {
  const repo = artist.repository;
  const flagged = { ...artist, latest_version: { version: "1.94.0", status: "NodeVersionStatusFlagged" } };
  const { requests } = harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [flagged], totalPages: 1 });
    if (url.pathname === `/nodes/${artist.id}/versions/1.94.0`) return json({ node_id: artist.id, version: "1.94.0", status: "NodeVersionStatusFlagged" });
    return undefined;
  }, { [repo]: [["ColorCorrect"], { title_aux: "ComfyUI ArtVenture" }] }, [
    { title: "ComfyUI ArtVenture", reference: repo, files: [repo], install_type: "git-clone" },
  ]);
  const result = await discoverOnlineManagerPlugins([{ classType: "ColorCorrect" }], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0]).toMatchObject({ classType: "ColorCorrect", status: "failed" });
  expect(result.unresolved[0].message).toContain("1.94.0");
  expect(requests.some(({ url }) => url.pathname.endsWith("/versions/1.94.0"))).toBe(true);
});

it("keeps two Registry packages with the exact same class ambiguous", async () => {
  const other = { ...artist, id: "other-art", repository: "https://github.com/other/art", latest_version: { version: "2.0.0", status: active } };
  harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [artist, other], page: 1, totalPages: 1, total: 2, limit: 100 });
    for (const pack of [artist, other]) {
      if (url.pathname === "/nodes/" + pack.id) return json(pack);
      if (url.pathname === `/nodes/${pack.id}/versions/${pack.latest_version.version}`) return json({ version: pack.latest_version.version, node_id: pack.id, status: active });
      if (url.pathname === `/nodes/${pack.id}/versions/${pack.latest_version.version}/comfy-nodes/ColorCorrect`) return json({ comfy_node_name: "ColorCorrect", node_id: pack.id, status: active });
    }
    return undefined;
  });
  const result = await discoverOnlineManagerPlugins([{ classType: "ColorCorrect" }], new AbortController().signal);
  expect(result.matches).toEqual([]); expect(result.unresolved[0].status).toBe("ambiguous");
});

it("does not choose the first verified provider when another candidate cannot be verified", async () => {
  const other = { ...artist, id: "other-art", repository: "https://github.com/other/art", latest_version: { version: "2.0.0", status: active } };
  harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [artist, other], totalPages: 1 });
    if (url.pathname === `/nodes/${artist.id}/versions/1.1.7`) return json({ version: "1.1.7", node_id: artist.id, status: active });
    if (url.pathname === `/nodes/${artist.id}/versions/1.1.7/comfy-nodes/ColorCorrect`) return json({ comfy_node_name: "ColorCorrect", node_id: artist.id, status: active });
    if (url.pathname === "/nodes/other-art/versions/2.0.0") return json({ message: "Registry temporarily unavailable" }, 503);
    return undefined;
  });
  const result = await discoverOnlineManagerPlugins([{ classType: "ColorCorrect", nodeId: "252" }], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0]).toMatchObject({ classType: "ColorCorrect", nodeId: "252", status: "failed" });
  expect(result.unresolved[0].message).toContain("503");
});

it("uses a fresh exact official Manager class map for a legacy Git package", async () => {
  const repo = "https://github.com/example/legacy-plugin";
  harness(() => undefined, { [repo]: [["LegacyNode"], { title_aux: "Legacy Plugin" }] }, [{ title: "Legacy Plugin", reference: repo, files: [repo], install_type: "git-clone" }]);
  const result = await discoverOnlineManagerPlugins([{ classType: "LegacyNode", nodeId: "8" }], new AbortController().signal);
  expect(result.unresolved).toEqual([]);
  expect(result.matches[0]).toMatchObject({ classType: "LegacyNode", nodeId: "8", packageId: "legacy-plugin" });
  expect(result.matches[0].pack).toMatchObject({ files: [repo], install_type: "git-clone", version: "unknown" });
});

it("does not install a fresh legacy map prefix or nodename_pattern guess", async () => {
  const repo = "https://github.com/example/legacy-plugin";
  harness(() => undefined, { [repo]: [["LegacyNode"], { nodename_pattern: "Legacy.*" }] }, [{ title: "Legacy", files: [repo], install_type: "git-clone" }]);
  const result = await discoverOnlineManagerPlugins([{ classType: "LegacyNodeExtra" }], new AbortController().signal);
  expect(result.matches).toEqual([]); expect(result.unresolved[0].status).toBe("not-found");
});

it("checks all Registry search pages instead of treating the first page as exhaustive", async () => {
  const { requests } = harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: url.searchParams.get("page") === "2" ? [artist] : [], page: Number(url.searchParams.get("page") ?? "1"), totalPages: 2, total: 1, limit: 100 });
    if (url.pathname === `/nodes/${artist.id}/versions/1.1.7`) return json({ version: "1.1.7", node_id: artist.id, status: active });
    if (url.pathname === `/nodes/${artist.id}/versions/1.1.7/comfy-nodes/ColorCorrect`) return json({ comfy_node_name: "ColorCorrect", node_id: artist.id, status: active });
    return artistRoute(url);
  });
  const result = await discoverOnlineManagerPlugins([{ classType: "ColorCorrect" }], new AbortController().signal);
  expect(result.matches[0]?.packageId).toBe(artist.id);
  expect(requests.some(({ url }) => url.pathname === "/nodes/search" && url.searchParams.get("page") === "2")).toBe(true);
  expect(requests.filter(({ url }) => url.pathname === "/nodes/search").every(({ url }) => url.searchParams.get("comfy_node_search") === "ColorCorrect")).toBe(true);
});

it("does not accept a class endpoint that returns a different class name", async () => {
  harness(url => {
    if (url.pathname === "/nodes/search") return json({ nodes: [artist], totalPages: 1 });
    return url.pathname.endsWith("/comfy-nodes/ColorCorrect") ? json({ comfy_node_name: "ColorCorrectExtra", node_id: artist.id, status: active }) : artistRoute(url);
  });
  const result = await discoverOnlineManagerPlugins([{ ...missingArtist, cnrId: undefined }], new AbortController().signal);
  expect(result.matches).toEqual([]); expect(result.unresolved[0].status).toBe("not-found");
});

it("does not reinterpret transport errors as a completed negative online search", async () => {
  harness(url => {
    if (url.pathname === "/nodes/" + artist.id) throw new TypeError("Network connection interrupted");
    return undefined;
  });
  const result = await discoverOnlineManagerPlugins([missingArtist], new AbortController().signal);
  expect(result.matches).toEqual([]); expect(result.unresolved[0].status).toBe("failed");
  expect(result.unresolved[0].message).toContain("Network connection interrupted");
});

it("rejects a Registry class whose policy is not Active", async () => {
  harness(url => url.pathname.endsWith("/comfy-nodes/ColorCorrect")
    ? json({ comfy_node_name: "ColorCorrect", node_id: artist.id, policy: "ComfyNodePolicyBanned" }) : artistRoute(url));
  const result = await discoverOnlineManagerPlugins([missingArtist], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(result.unresolved[0].message).toContain("未确认包含节点");
});

it("never changes package identity when an explicit CNR lookup returns another package", async () => {
  const { requests } = harness(url => url.pathname === "/nodes/" + artist.id ? json({ ...artist, id: "different-package" }) : artistRoute(url));
  const result = await discoverOnlineManagerPlugins([missingArtist], new AbortController().signal);
  expect(result.matches).toEqual([]);
  expect(requests.some(({ url }) => url.pathname.startsWith("/nodes/different-package/"))).toBe(false);
});

it("does not report not-found when the fresh official Manager index cannot be read", async () => {
  harness(url => url.pathname.endsWith("/extension-node-map.json") ? json({ message: "unavailable" }, 503) : undefined);
  const result = await discoverOnlineManagerPlugins([{ classType: "NotInRegistry" }], new AbortController().signal);
  expect(result.matches).toEqual([]); expect(result.unresolved[0].status).toBe("failed");
  expect(result.unresolved[0].message).toContain("503");
});
