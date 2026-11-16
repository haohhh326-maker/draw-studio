import type { ManagerMissingNode, ManagerOnlineDiscovery } from "./manager-plugins";

type Data = Record<string, unknown>;
type Match = ManagerOnlineDiscovery["matches"][number];
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const semver = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const registry = "https://api.comfy.org";
const manager = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/";
function publicUrl(value: unknown) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.toString().replace(/\/$/, "") : "";
  } catch { return ""; }
}
function repository(value: unknown) {
  const raw = text(value).replace(/\.git\/?$/i, "").replace(/\/$/, "");
  const url = publicUrl(raw);
  if (url) { const parsed = new URL(url); return parsed.hostname === "github.com" ? parsed.pathname.slice(1).toLowerCase() : url.toLowerCase(); }
  return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw.toLowerCase() : "";
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Public discovery is intentionally independent of the authenticated workstation client. */
export async function discoverOnlineManagerPlugins(
  missing: readonly ManagerMissingNode[], signal: AbortSignal, onProgress?: (message: string) => void,
): Promise<ManagerOnlineDiscovery> {
  signal.throwIfAborted();
  const result: ManagerOnlineDiscovery = { matches: [], unresolved: [] };
  if (!missing.length) return result;
  const requests = new Map<string, Promise<unknown>>();
  async function json(url: string): Promise<unknown> {
    signal.throwIfAborted();
    let pending = requests.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url, { signal, credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
        signal.throwIfAborted();
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(new URL(url).hostname + " HTTP " + response.status);
        const value: unknown = await response.json(); signal.throwIfAborted(); return value;
      })();
      requests.set(url, pending);
    }
    return pending;
  }
  onProgress?.("正在联网读取官方 Manager 最新节点索引，并搜索 Comfy Registry…");
  const indexes = await Promise.allSettled([json(manager + "extension-node-map.json"), json(manager + "custom-node-list.json")]);
  signal.throwIfAborted();
  const mapping = indexes[0].status === "fulfilled" && record(indexes[0].value) ? indexes[0].value : undefined;
  const catalog = indexes[1].status === "fulfilled" && record(indexes[1].value) && Array.isArray(indexes[1].value.custom_nodes) ? indexes[1].value.custom_nodes.filter(record) : undefined;
  const managerError = !mapping || !catalog ? "官方 Manager 最新在线索引未完整读取" + indexes.filter(item => item.status === "rejected").map(item => "：" + errorText((item as PromiseRejectedResult).reason)).join("；") : "";

  async function searchRegistry(node: ManagerMissingNode): Promise<Data[]> {
    if (node.cnrId) {
      const value = await json(registry + "/nodes/" + encodeURIComponent(node.cnrId));
      if (value === undefined) return [];
      if (!record(value) || !text(value.id)) throw new Error("Registry 插件信息格式无效");
      return [value];
    }
    const found = new Map<string, Data>();
    let page = 1, pages = 1;
    do {
      const query = new URLSearchParams({ comfy_node_search: node.classType, page: String(page), limit: "100" });
      const value = await json(registry + "/nodes/search?" + query);
      if (!record(value) || !Array.isArray(value.nodes) || !Number.isInteger(value.totalPages) || Number(value.totalPages) < 0) throw new Error("Registry 在线搜索结果格式无效");
      pages = Number(value.totalPages);
      const before = found.size;
      for (const pack of value.nodes) if (record(pack) && text(pack.id)) found.set(text(pack.id), pack);
      if (page > 1 && value.nodes.length && found.size === before) throw new Error("Registry 搜索分页重复，未能确认完整结果");
      page++;
    } while (page <= pages);
    return [...found.values()];
  }
  function identity(node: ManagerMissingNode) { return { classType: node.classType, ...(node.nodeId ? { nodeId: node.nodeId } : {}) }; }
  function legacy(node: ManagerMissingNode): Match[] {
    if (!mapping || !catalog || node.cnrId) return [];
    const sources = Object.entries(mapping).filter(([, value]) => Array.isArray(value) && Array.isArray(value[0]) && value[0].includes(node.classType)).map(([source]) => source);
    const matches: Match[] = [];
    for (const source of sources) {
      const sourceIdentity = repository(source);
      if (!sourceIdentity || node.auxId && repository(node.auxId) !== sourceIdentity) continue;
      for (const pack of catalog) {
        const files = Array.isArray(pack.files) ? pack.files : [];
        if (!files.length || !files.every(file => !!publicUrl(file))) continue;
        if (![pack.reference, ...files].some(value => repository(value) === sourceIdentity)) continue;
        const first = publicUrl(files[0]);
        const id = files.length === 1 ? new URL(first).pathname.split("/").at(-1)! : first;
        if (!id) continue;
        matches.push({ ...identity(node), packageId: id,
          pack: { ...pack, id, repository: publicUrl(pack.reference) || first, version: "unknown", files: files.map(publicUrl) }, source: "官方 Manager 最新在线节点映射" });
      }
    }
    return matches;
  }
  async function discover(node: ManagerMissingNode) {
    signal.throwIfAborted();
    const id = identity(node);
    if (node.metadataConflict) { result.unresolved.push({ ...id, status: "ambiguous", message: "工作流中保存的插件来源互相冲突，无法唯一确定安装来源。" }); return; }
    const found = legacy(node), problems: string[] = [];
    const registryRepositories = new Set<string>();
    let registryError = "";
    onProgress?.("正在在线搜索节点 " + node.classType + " 对应的插件，并核验实际版本…");
    try {
      const candidates = await searchRegistry(node);
      for (const candidate of candidates) {
        const packageId = text(candidate.id), repo = publicUrl(candidate.repository);
        if (!/^[\w.-]+$/.test(packageId) || !repo) continue;
        if (node.cnrId && node.cnrId.toLowerCase() !== packageId.toLowerCase()) continue;
        if (node.auxId && repository(node.auxId) !== repository(repo)) continue;
        registryRepositories.add(repository(repo));
        if (candidate.status !== undefined && candidate.status !== "NodeStatusActive") {
          problems.push("已找到 " + packageId + "，但该插件当前未处于 Active 状态"); continue;
        }
        const latest = record(candidate.latest_version) ? candidate.latest_version : {};
        const version = node.version && semver.test(node.version) ? node.version : text(latest.version);
        if (!semver.test(version)) { problems.push("已找到 " + packageId + "，但没有明确可核验的发布版本"); continue; }
        const base = registry + "/nodes/" + encodeURIComponent(packageId) + "/versions/" + encodeURIComponent(version);
        const release = await json(base);
        if (!record(release) || release.version !== version || !["NodeVersionStatusActive", "Active"].includes(text(release.status))) {
          problems.push("已找到 " + packageId + "，但版本 " + version + " 未处于可安装的 Active 状态；未擅自降级或更换来源"); continue;
        }
        const provided = await json(base + "/comfy-nodes/" + encodeURIComponent(node.classType));
        if (!record(provided) || provided.comfy_node_name !== node.classType || provided.policy !== undefined && provided.policy !== "ComfyNodePolicyActive") {
          if (node.cnrId || found.some(match => repository(match.pack.repository) === repository(repo))) problems.push("已找到 " + packageId + "，但版本 " + version + " 未确认包含节点 " + node.classType);
          continue;
        }
        found.push({ ...id, packageId, pack: { id: packageId, title: text(candidate.name) || packageId, repository: repo, files: [repo], install_type: "cnr", version }, source: "官方 Comfy Registry 精确节点与版本核验" });
      }
    } catch (error) { signal.throwIfAborted(); registryError = "Registry 在线搜索或版本核验失败：" + errorText(error); }
    signal.throwIfAborted();
    // A Registry release and its legacy repository describe one source. Prefer
    // the verified published release rather than installing the same repo twice.
    const unique = new Map<string, Match>();
    for (const match of found) {
      const key = repository(match.pack.repository) || match.packageId;
      // Do not turn a rejected Registry release into a git/nightly install of
      // the same repository through its legacy listing.
      if (match.pack.version === "unknown" && registryRepositories.has(key)) continue;
      if (!unique.has(key) || match.pack.version !== "unknown") unique.set(key, match);
    }
    // A partially verified search cannot prove that one remaining candidate is
    // the unique source. Explicit workflow identity can resolve that question;
    // an unqualified class name cannot.
    if (registryError && !node.cnrId && !node.auxId) {
      result.unresolved.push({ ...id, status: "failed", message: [managerError, registryError].filter(Boolean).join("；") + "。在线候选未能完整核验，无法确认唯一插件来源，未自动安装。" }); return;
    }
    if (unique.size === 1) { result.matches.push([...unique.values()][0]); return; }
    if (unique.size > 1) { result.unresolved.push({ ...id, status: "ambiguous", message: "官方在线搜索找到多个提供同名节点的插件，工作流没有保存唯一来源，未自动选择其他插件。" }); return; }
    const failures = [managerError, registryError, ...problems].filter(Boolean);
    result.unresolved.push({ ...id, status: failures.length ? "failed" : "not-found", message: failures.length
      ? failures.join("；") + "。尚未找到可以确认并自动安装的对应插件。"
      : "已在线搜索官方 Manager 最新节点索引和 Comfy Registry，未匹配到可核验的插件来源；这不代表其他网站或私有仓库中不存在该插件。" });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (next < missing.length) await discover(missing[next++]);
  }));
  signal.throwIfAborted();
  return result;
}
