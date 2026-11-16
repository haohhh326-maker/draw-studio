/** ComfyUI-Manager 3.41 catalog and queue protocol. Only called while importing. */
type Data = Record<string, unknown>;
const record = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const registered = (info: Data, classType: string) => Object.hasOwn(info, classType) && record(info[classType]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const semver = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
export type ManagerMissingNode = { classType: string; nodeId?: string; cnrId?: string; auxId?: string; version?: string; metadataConflict?: boolean };
export type ManagerNodeResolution = ManagerMissingNode & {
  status: "available" | "installed-pending-restart" | "not-installed" | "not-found" | "ambiguous" | "installed-unavailable" | "disabled" | "failed";
  packageId?: string; title?: string; message: string;
};
export type ManagerRepairResult = { nodes: ManagerNodeResolution[]; installedPackageIds: string[]; restartRequired: boolean; objectInfo: Data; managerError?: string };
export type ManagerRepairClient = {
  request(path: string, init?: RequestInit, timeout?: number | null): Promise<Response>;
  getObjectInfo(): Promise<Data>;
  connection?: { baseUrl: string };
};
export type ManagerOnlineDiscovery = {
  matches: { classType: string; nodeId?: string; packageId: string; pack: Data; source: string }[];
  unresolved: { classType: string; nodeId?: string; message: string; status: "not-found" | "failed" | "ambiguous" }[];
};
export type ManagerRepairOptions = {
  signal?: AbortSignal; onProgress?: (message: string) => void; pollIntervalMs?: number; initialObjectInfo?: Data;
  discoverOnline?: (missing: readonly ManagerMissingNode[], signal: AbortSignal, onProgress?: (message: string) => void) => Promise<ManagerOnlineDiscovery>;
};
type CatalogMode = "local" | "cache" | "remote";
type Catalog = { channel: string; mode: CatalogMode; packs: Map<string, Data>; mappings: Data; mappingError?: string };
const catalogModes: readonly CatalogMode[] = ["local", "cache", "remote"];
const catalogLabel = (mode: CatalogMode) => mode === "local" ? "Manager 随附插件索引" : mode === "cache" ? "Manager 缓存插件索引" : "Manager 在线插件索引";
type Action = { id: string; pack: Data; nodes: ManagerNodeResolution[]; kind: "install" | "enable" | "fix"; selectedVersion?: string };
const mutationLocks = new Set<unknown>();

/** Saved package metadata disambiguates classes exported by multiple plugins. */
export function collectMissingManagerNodes(source: unknown, missing: readonly { classType: string; nodeId?: string }[]): ManagerMissingNode[] {
  const saved: (ManagerMissingNode & { nodeId: string })[] = [];
  const seenObjects = new Set<object>();
  function visit(value: unknown, key = "") {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, String(index))); return; }
    if (!record(value) || seenObjects.has(value)) return;
    seenObjects.add(value);
    const classType = text(value.type) || text(value.class_type);
    if (classType) {
      const properties = record(value.properties) ? value.properties : {};
      saved.push({ classType, nodeId: String(value.id ?? key), ...(text(properties.cnr_id) ? { cnrId: text(properties.cnr_id) } : {}), ...(text(properties.aux_id) ? { auxId: text(properties.aux_id) } : {}), ...(text(properties.ver) ? { version: text(properties.ver) } : {}) });
    }
    Object.entries(value).forEach(([name, item]) => { if (name !== "properties" && name !== "widgets_values" && name !== "inputs") visit(item, name); });
  }
  visit(source);
  const unique = new Map<string, ManagerMissingNode>();
  for (const item of missing) {
    if (!text(item.classType)) continue;
    let candidates = saved.filter(node => node.classType === item.classType);
    const exact = candidates.filter(node => node.nodeId === item.nodeId);
    if (exact.length) candidates = exact;
    const identities = new Set(candidates.map(node => JSON.stringify([node.cnrId ?? "", node.auxId ?? "", node.version ?? ""])));
    const hint = identities.size === 1 ? candidates[0] : undefined;
    unique.set(item.classType + "\0" + (item.nodeId ?? ""), { ...item, ...(hint?.cnrId ? { cnrId: hint.cnrId } : {}), ...(hint?.auxId ? { auxId: hint.auxId } : {}), ...(hint?.version ? { version: hint.version } : {}), ...(identities.size > 1 ? { metadataConflict: true } : {}) });
  }
  return [...unique.values()];
}

function repositoryIdentity(value: unknown) {
  const raw = text(value).replace(/\.git\/?$/i, "").replace(/\/$/, "");
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return url.hostname.toLowerCase() === "github.com" && path.split("/").length === 2 ? path.toLowerCase() : url.origin.toLowerCase() + "/" + path;
  } catch { return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw.toLowerCase() : ""; }
}
function packageMatches(packId: string, pack: Data, mappingKey: string) {
  if (mappingKey === packId) return true;
  const identity = repositoryIdentity(mappingKey);
  return !!identity && [pack.repository, pack.reference, ...(Array.isArray(pack.files) ? pack.files : [])].some(value => repositoryIdentity(value) === identity);
}
function matchPackage(node: ManagerMissingNode, catalog: Catalog): string[] {
  if (node.metadataConflict) return [...catalog.packs.keys()].filter(id => {
    const map = catalog.mappings[id];
    return Array.isArray(map) && Array.isArray(map[0]) && map[0].includes(node.classType);
  });
  // Explicit package metadata must not silently select a different plugin.
  if (node.cnrId) return [...catalog.packs.keys()].filter(id => id.trim().toLowerCase() === node.cnrId!.trim().toLowerCase());
  if (node.auxId) return [...catalog.packs].filter(([, pack]) => [pack.repository, pack.reference, ...(Array.isArray(pack.files) ? pack.files : [])].some(value => repositoryIdentity(value) === repositoryIdentity(node.auxId) && !!repositoryIdentity(value))).map(([id]) => id);
  const mapped = Object.entries(catalog.mappings).filter(([, value]) => Array.isArray(value) && Array.isArray(value[0]) && value[0].includes(node.classType)).map(([key]) => key);
  return [...catalog.packs].filter(([id, pack]) => mapped.some(key => packageMatches(id, pack, key))).map(([id]) => id);
}
function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, reason => { signal.removeEventListener("abort", abort); reject(reason); });
  });
}

/** Manager queue completion is never treated as proof that a node is registered. */
export async function repairMissingManagerPlugins(client: ManagerRepairClient, missing: readonly ManagerMissingNode[], options: ManagerRepairOptions = {}): Promise<ManagerRepairResult> {
  return repairManagerPlugins(client, missing, options, "local");
}

async function repairManagerPlugins(client: ManagerRepairClient, missing: readonly ManagerMissingNode[], options: ManagerRepairOptions, firstCatalogMode: CatalogMode): Promise<ManagerRepairResult> {
  const signal = options.signal ?? new AbortController().signal;
  const nodes: ManagerNodeResolution[] = missing.map(node => ({ ...node, status: "failed", message: "尚未搜索 Manager 插件索引。" }));
  const result: ManagerRepairResult = { nodes, installedPackageIds: [], restartRequired: false, objectInfo: options.initialObjectInfo ?? {} };
  const progress = (message: string) => { options.onProgress?.(message); signal.throwIfAborted(); };
  const request = async (path: string, init: RequestInit = {}) => {
    signal.throwIfAborted();
    const response = await client.request(path, { ...init, signal }, null);
    if (!response.ok) throw new Error("ComfyUI Manager HTTP " + response.status + "：" + (await response.text()).slice(0, 1000));
    return response;
  };
  const json = async (path: string) => (await request(path)).json() as Promise<unknown>;
  const post = (path: string, body: Data = {}) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let catalogMode: CatalogMode = firstCatalogMode;
  // Manager's cache refresh can also wait on its upstream. A direct official
  // discovery transport makes that intermediate network request unnecessary.
  const lookupModes: readonly CatalogMode[] = options.discoverOnline ? ["local", "remote"] : catalogModes;
  const discoveredPacks = new Map<string, Data>();
  const nodeKey = (node: { classType: string; nodeId?: string }) => node.classType + "\0" + (node.nodeId ?? "");
  const onlinePackageIds = new Map<string, string>();
  const onlineUnresolved = new Map<string, ManagerOnlineDiscovery["unresolved"][number]>();
  let directDiscoveryUsed = false;
  async function discoveredStates(): Promise<Map<string, Data>> {
    if (!discoveredPacks.size) return new Map();
    const installed = await json("/customnode/installed");
    if (!record(installed) || !Object.values(installed).every(value => record(value) && typeof value.enabled === "boolean" && typeof value.ver === "string")) throw new Error("Manager 已安装插件状态无效，未猜测在线搜索结果的安装状态。");
    return new Map([...discoveredPacks].map(([id, pack]) => {
      const repositories = [pack.repository, pack.reference, ...(Array.isArray(pack.files) ? pack.files : [])].map(repositoryIdentity).filter(Boolean);
      const matches = Object.values(installed).filter((value): value is Data => record(value) && (text(value.cnr_id).toLowerCase() === id.toLowerCase() || (!!repositoryIdentity(value.aux_id) && repositories.includes(repositoryIdentity(value.aux_id)))));
      const enabled = matches.filter(value => value.enabled === true);
      if (enabled.length > 1) throw new Error("Manager 报告在线搜索插件 " + id + " 的多个启用安装，无法确定应修复的版本。");
      const active = enabled[0] ?? matches[0];
      return [id, { ...pack, state: enabled.length ? "enabled" : matches.length ? "disabled" : "not-installed", ...(active ? { active_version: text(active.ver) } : {}) }];
    }));
  }
  async function readCatalog(mode: CatalogMode): Promise<Catalog> {
    let mappingError: string | undefined;
    const [raw, mappings] = await Promise.all([json("/customnode/getlist?mode=" + mode + "&skip_update=true"), json("/customnode/getmappings?mode=" + mode).catch(reason => { signal.throwIfAborted(); mappingError = "Manager 节点映射读取失败：" + errorMessage(reason); progress(mappingError + "；将仅使用工作流中明确的插件标识。"); return undefined; })]);
    if (!record(raw) || !record(raw.node_packs) || !text(raw.channel)) throw new Error("ComfyUI Manager 返回的插件索引格式无效。");
    if (!record(mappings)) mappingError ??= "Manager 节点映射格式无效，无法确认该节点是否在插件索引中。";
    const packs = new Map(Object.entries(raw.node_packs).filter((item): item is [string, Data] => record(item[1])));
    for (const [id, pack] of await discoveredStates()) packs.set(id, { ...packs.get(id), ...pack });
    return { channel: text(raw.channel), mode, packs, mappings: record(mappings) ? mappings : {}, ...(mappingError ? { mappingError } : {}) };
  }
  async function onlineCatalog(): Promise<Catalog> {
    const needsOnlineLookup = nodes.filter(node => node.status !== "available" && node.cnrId?.toLowerCase() !== "comfy-core" && !node.metadataConflict);
    // The cloud Manager may be unable to reach its upstream. Search official
    // sources before asking it to refresh; this avoids hiding a working direct
    // discovery behind a stalled Manager request.
    progress("正在直接搜索官方最新插件索引与注册中心…");
    const discovery = await options.discoverOnline!(needsOnlineLookup.map(node => ({ ...node })), signal, progress);
    const requested = new Map(needsOnlineLookup.map(node => [nodeKey(node), node]));
    const matches = new Map<string, typeof discovery.matches>();
    for (const match of discovery.matches) {
      const key = nodeKey(match), node = requested.get(key);
      if (!node || !text(match.packageId) || !record(match.pack)) continue;
      // Discovery verifies the exact class. Saved package identity still cannot
      // be replaced by a different plugin with the same exported class name.
      const matchesCnr = !node.cnrId || node.cnrId.toLowerCase() === match.packageId.toLowerCase();
      const matchesAux = !node.auxId || [match.pack.repository, match.pack.reference, ...(Array.isArray(match.pack.files) ? match.pack.files : [])].some(value => !!repositoryIdentity(value) && repositoryIdentity(value) === repositoryIdentity(node.auxId));
      if (!matchesCnr || !matchesAux) {
        onlineUnresolved.set(key, { ...node, status: "failed", message: "官方搜索结果与工作流保存的插件来源不一致，未安装其他来源替代。" });
        continue;
      }
      const items = matches.get(key) ?? []; items.push(match); matches.set(key, items);
    }
    const mappings: Data = {};
    for (const [key, items] of matches) {
      const ids = new Set(items.map(item => item.packageId));
      if (ids.size !== 1) { const node = requested.get(key)!; onlineUnresolved.set(key, { ...node, status: "ambiguous", message: "官方在线搜索返回多个同名节点插件，缺少唯一来源，未自动安装其他插件替代。" }); continue; }
      const match = items[0];
      discoveredPacks.set(match.packageId, match.pack);
      onlinePackageIds.set(key, match.packageId);
      onlineUnresolved.delete(key);
      const classes = Array.isArray(mappings[match.packageId]) ? (mappings[match.packageId] as unknown[])[0] : [];
      mappings[match.packageId] = [[...(Array.isArray(classes) ? classes : []), match.classType], {}];
      progress("在线搜索已匹配 " + (text(match.pack.title) || match.packageId) + "（" + match.source + "），正在通过 Manager 核实安装状态…");
    }
    for (const item of discovery.unresolved) if (requested.has(nodeKey(item)) && !onlinePackageIds.has(nodeKey(item)) && !onlineUnresolved.has(nodeKey(item))) onlineUnresolved.set(nodeKey(item), item);
    for (const [key, node] of requested) if (!onlinePackageIds.has(key) && !onlineUnresolved.has(key)) onlineUnresolved.set(key, { ...node, status: "failed", message: "官方在线搜索未返回该节点的确认结果，尚不能判定插件是否存在。" });
    const packs = await discoveredStates();
    directDiscoveryUsed = true;
    return { channel: "default", mode: "remote", packs, mappings };
  }
  async function catalog(): Promise<Catalog> {
    const errors: string[] = [];
    for (const mode of lookupModes.slice(Math.max(0, lookupModes.indexOf(catalogMode)))) {
      catalogMode = mode;
      try {
        if (mode === "remote" && options.discoverOnline) {
          try { return await onlineCatalog(); }
          catch (reason) {
            signal.throwIfAborted();
            const message = "官方插件在线搜索或安装状态核实失败：" + errorMessage(reason) + "；尚不能确认对应插件是否存在。";
            for (const node of nodes.filter(node => node.status !== "available")) { onlinePackageIds.delete(nodeKey(node)); onlineUnresolved.set(nodeKey(node), { ...node, status: "failed", message }); }
            discoveredPacks.clear();
            progress(message + " 正在继续请求 Manager 在线搜索…");
          }
        }
        return await readCatalog(mode);
      }
      catch (reason) {
        signal.throwIfAborted();
        errors.push(catalogLabel(mode) + "读取失败：" + errorMessage(reason));
        if (mode !== "remote") progress(errors.at(-1)! + "；正在继续搜索其他 Manager 插件索引…");
      }
    }
    throw new Error(errors.join("；") + "；未能完成 Manager 在线搜索，尚不能确认对应插件是否存在。");
  }
  const freshInfo = async () => {
    const info = await (await request("/object_info")).json() as unknown;
    if (!record(info)) throw new Error("工作站返回的节点定义格式无效。");
    result.objectInfo = info;
  };
  const lockKey: unknown = client.connection?.baseUrl.replace(/\/$/, "") || client;
  let ownsLock = false;
  const accepted: Action[] = [];
  const deferred: ManagerNodeResolution[] = [];
  let queueStarted = false;
  let continuingQueue: Promise<void> | undefined;
  async function completeRemainingLookup() {
    if (!deferred.length) return result;
    // Finish exact matches before waiting on the next source. A local/cache miss
    // is never final: mode=remote asks Manager to fetch its configured channel.
    if (ownsLock) { mutationLocks.delete(lockKey); ownsLock = false; }
    const nextMode = lookupModes[lookupModes.indexOf(catalogMode) + 1];
    if (!nextMode) return result;
    progress(nextMode === "remote" ? "正在请求 Manager 在线更新并搜索其余节点对应的插件…" : "已匹配的插件已处理，正在搜索其余节点的 Manager 缓存插件索引…");
    const remaining = await repairManagerPlugins(client, deferred, { ...options, initialObjectInfo: result.objectInfo }, nextMode);
    const key = (node: ManagerMissingNode) => node.classType + "\0" + (node.nodeId ?? "");
    const resolved = new Map(remaining.nodes.map(node => [key(node), node]));
    result.nodes = result.nodes.map(node => resolved.get(key(node)) ?? node);
    result.installedPackageIds = [...new Set([...result.installedPackageIds, ...remaining.installedPackageIds])];
    result.restartRequired ||= remaining.restartRequired;
    result.objectInfo = remaining.objectInfo;
    if (remaining.managerError) result.managerError = remaining.managerError;
    return result;
  }
  async function finishAcceptedQueue() {
    if (!accepted.length || queueStarted) return;
    // Enqueue is the point of no return: cancellation stops waiting, but must not
    // strand accepted work in Manager's global queue. Never reset other work.
    const response = await client.request("/manager/queue/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: new AbortController().signal }, null);
    if (!response.ok) throw new Error("Manager 已接收插件安装，但启动安装队列失败（HTTP " + response.status + "）。请在 Manager 中继续原队列；未重复提交。");
    queueStarted = true;
  }
  try {
    if (!options.initialObjectInfo) await freshInfo();
    for (const node of nodes) if (registered(result.objectInfo, node.classType)) { node.status = "available"; node.message = "工作站已注册该节点。"; }
    const unresolved = nodes.filter(node => node.status !== "available");
    if (!unresolved.length) return result;
    progress("正在 ComfyUI Manager 中查找缺失插件…");
    const current = await catalog();
    const actions = new Map<string, Action>();
    const packageNodes = new Map<string, ManagerNodeResolution[]>();
    for (const node of unresolved) {
      const onlineId = onlinePackageIds.get(nodeKey(node));
      const directFailure = directDiscoveryUsed && !onlineId ? onlineUnresolved.get(nodeKey(node)) : undefined;
      if (directFailure) { node.status = directFailure.status; node.message = directFailure.message; continue; }
      const matched = onlineId ? [onlineId] : matchPackage(node, current);
      if (node.cnrId?.toLowerCase() === "comfy-core") { node.status = "installed-unavailable"; node.message = "该节点属于 ComfyUI 内置节点；当前工作站版本未提供，不能通过安装其他插件替代。"; continue; }
      if (node.metadataConflict || matched.length > 1) { node.status = "ambiguous"; node.message = "Manager 存在多个同名节点来源，工作流未提供唯一插件标识，未安装其他来源替代。"; continue; }
      if (!matched.length) {
        if (current.mode !== "remote") {
          node.message = catalogLabel(current.mode) + "尚未匹配该插件，将继续自动搜索。";
          deferred.push(node); continue;
        }
        const onlineFailure = onlineUnresolved.get(nodeKey(node));
        if (onlineFailure) { node.status = onlineFailure.status; node.message = onlineFailure.message; continue; }
        const lookupError = current.mappingError && !node.cnrId && !node.auxId ? current.mappingError : undefined;
        node.status = lookupError ? "failed" : "not-found";
        // Manager 3.41 may internally fall back to its bundled data on a network
        // error without exposing that fact in HTTP. Do not claim an Internet-
        // wide absence, or that a successful 200 proves a freshly fetched index.
        node.message = lookupError || "已请求 ComfyUI Manager 在线更新并搜索插件索引，返回结果中未找到可可靠匹配的插件。Manager 网络异常时可能回退到随附索引，不能据此断言网上不存在该插件。";
        continue;
      }
      const id = matched[0], pack = current.packs.get(id)!;
      node.packageId = id; node.title = text(pack.title) || id;
      if (pack["invalid-installation"]) { node.status = "failed"; node.message = "Manager 检测到该插件安装损坏，无法可靠自动修复。"; continue; }
      const existing = packageNodes.get(id);
      if (existing) existing.push(node); else packageNodes.set(id, [node]);
    }
    let startupSnapshot: Data | undefined;
    let startupRead = false;
    async function changedSinceStartup(id: string, pack: Data) {
      if (!startupRead) {
        startupRead = true;
        try {
          const raw = await json("/customnode/installed?mode=imported");
          if (record(raw) && Object.values(raw).every(value => record(value) && typeof value.enabled === "boolean" && typeof value.ver === "string")) startupSnapshot = raw;
        } catch { signal.throwIfAborted(); /* Missing snapshot must not imply a pending restart. */ }
      }
      if (!startupSnapshot) return false;
      const identities = [pack.repository, pack.reference, ...(Array.isArray(pack.files) ? pack.files : [])].map(repositoryIdentity).filter(Boolean);
      const installed = Object.values(startupSnapshot).filter((value): value is Data => record(value) && (text(value.cnr_id).toLowerCase() === id.toLowerCase() || (!!repositoryIdentity(value.aux_id) && identities.includes(repositoryIdentity(value.aux_id)))));
      if (!installed.length || installed.every(value => value.enabled === false)) return true;
      const version = text(pack.active_version) || text(pack.version);
      return semver.test(version) && installed.length === 1 && semver.test(text(installed[0].ver)) && installed[0].ver !== version;
    }
    for (const [id, members] of packageNodes) {
      const pack = current.packs.get(id)!;
      const state = text(pack.state);
      const versions = new Set(members.map(node => node.version).filter((value): value is string => !!value && semver.test(value)));
      if (versions.size > 1) { members.forEach(node => { node.status = "failed"; node.message = "同一插件存在互相冲突的工作流版本要求，未替换插件版本。"; }); continue; }
      if (!["enabled", "disabled", "not-installed"].includes(state)) { members.forEach(node => { node.status = "failed"; node.message = "Manager 返回的插件安装状态无效，未猜测安装操作。"; }); continue; }
      const requested = versions.values().next().value;
      const needsExactVersion = state === "enabled" && text(pack.version) !== "unknown" && !!requested && requested !== (text(pack.active_version) || text(pack.version));
      const kind = state === "not-installed" || needsExactVersion ? "install" : state === "disabled" ? "enable" : state === "enabled" && pack["import-fail"] === true ? "fix" : undefined;
      if (!kind) {
        if (await changedSinceStartup(id, pack)) {
          members.forEach(node => { node.status = "installed-pending-restart"; node.message = "Manager 确认插件在本次工作站启动后才安装或启用；需要重启后读取节点定义，未重复安装。"; });
          result.installedPackageIds.push(id); result.restartRequired = true;
        } else members.forEach(node => { node.status = "installed-unavailable"; node.message = "插件已安装，但当前版本没有注册该节点；未自动替换已安装版本。"; });
        continue;
      }
      actions.set(id, { id, pack, kind, nodes: members });
    }
    if (!actions.size) return completeRemainingLookup();
    if (mutationLocks.has(lockKey)) throw new Error("当前工作站正在补齐另一份工作流的插件，请等待完成后重试。");
    mutationLocks.add(lockKey); ownsLock = true;
    const state = await json("/manager/queue/status");
    if (!record(state) || typeof state.is_processing !== "boolean" || ![state.total_count, state.done_count, state.in_progress_count].every(value => Number.isInteger(value) && Number(value) >= 0)) throw new Error("Manager 安装队列状态无效，未提交安装。");
    if (state.is_processing || Number(state.in_progress_count) > 0 || Number(state.total_count) > Number(state.done_count)) throw new Error("ComfyUI Manager 已有其他安装任务，未覆盖或启动其他任务，请等待完成后重试。");
    for (const action of actions.values()) {
      try {
        signal.throwIfAborted();
        const packVersion = text(action.pack.version);
        if (!packVersion) throw new Error("Manager 插件记录缺少版本信息，未猜测安装参数。");
        const versions = new Set(action.nodes.map(node => node.version).filter((value): value is string => !!value && semver.test(value)));
        if (versions.size > 1) throw new Error("同一插件存在互相冲突的工作流版本要求，未替换插件版本。");
        let selected = versions.values().next().value as string | undefined;
        if (action.kind === "install" && packVersion !== "unknown") {
          selected ??= packVersion;
          if (!semver.test(selected)) throw new Error("Manager 未提供可验证的发布版本，未自动安装未经确认的 nightly 版本。");
          const versionsResponse = await json("/customnode/versions/" + encodeURIComponent(action.id));
          if (!Array.isArray(versionsResponse)) throw new Error("Manager 未返回可验证的版本列表。");
          const version = versionsResponse.find(value => record(value) && value.version === selected);
          if (!record(version) || !["NodeVersionStatusActive", "Active"].includes(text(version.status))) throw new Error("插件版本 " + selected + " 未处于可安装的 Active 状态；未绕过 Manager 安全限制或擅自降级。");
          action.selectedVersion = selected;
        }
        if (packVersion === "unknown" && (!Array.isArray(action.pack.files) || !action.pack.files.length || !action.pack.files.every(value => { try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }))) throw new Error("Manager 插件索引没有提供有效的下载地址。");
        const body: Data = { id: action.id, version: packVersion, channel: current.channel, mode: current.mode, ui_id: "draw-studio:" + action.id, skip_post_install: action.kind === "enable" };
        for (const field of ["repository", "files", "pip", "install_type"]) if (action.pack[field] !== undefined) body[field] = action.pack[field];
        if (action.kind === "install" && selected) body.selected_version = selected;
        progress((action.kind === "enable" ? "正在启用 " : action.kind === "fix" ? "正在修复依赖 " : "正在安装 ") + (text(action.pack.title) || action.id) + "…");
        await post(action.kind === "fix" ? "/manager/queue/fix" : "/manager/queue/install", body);
        accepted.push(action);
      } catch (reason) {
        signal.throwIfAborted();
        action.nodes.forEach(node => { node.status = "failed"; node.message = errorMessage(reason); });
      }
    }
    if (!accepted.length) return completeRemainingLookup();
    // Start only after enqueue; never reset a queue that may belong to another user.
    await post("/manager/queue/start");
    queueStarted = true;
    for (;;) {
      const raw = await json("/manager/queue/status");
      if (!record(raw) || typeof raw.is_processing !== "boolean" || ![raw.total_count, raw.done_count, raw.in_progress_count].every(value => Number.isInteger(value) && Number(value) >= 0)) throw new Error("Manager 安装队列状态无效，安装结果尚未确认。");
      if (!raw.is_processing && Number(raw.in_progress_count) === 0 && Number(raw.total_count) <= Number(raw.done_count)) break;
      progress("Manager 正在补齐插件（" + raw.done_count + "/" + raw.total_count + "）…");
      await pause(Math.max(1, options.pollIntervalMs ?? 1000), signal);
    }
    // A discovered package already has a verified catalog record. Refresh its
    // real disk state directly instead of blocking on Manager upstream again.
    const installed = discoveredPacks.size ? { ...current, packs: await discoveredStates() } : await catalog();
    await freshInfo();
    for (const action of accepted) {
      const pack = installed.packs.get(action.id);
      const confirmed = pack?.state === "enabled" && !pack["invalid-installation"] && (!action.selectedVersion || action.selectedVersion === (text(pack.active_version) || text(pack.version)));
      // Manager 3.41 reserves an existing CNR version switch for startup. Its
      // disk catalog can therefore still show the old version after queue idle.
      const deferredSwitch = action.kind === "install" && !!action.selectedVersion && action.pack.state === "enabled" && pack?.state === "enabled" && !pack["invalid-installation"];
      if (confirmed) result.installedPackageIds.push(action.id);
      for (const node of action.nodes) {
        if (registered(result.objectInfo, node.classType)) { node.status = "available"; node.message = "插件已补齐，工作站已注册该节点。"; }
        else if (confirmed) { node.status = "installed-pending-restart"; node.message = "Manager 处理已结束，插件索引显示已启用；需要重启工作站后重新读取节点定义，尚未确认该节点可用。"; result.restartRequired = true; }
        else if (deferredSwitch) { node.status = "installed-pending-restart"; node.message = "Manager 已处理版本切换请求，该操作可能在重启时应用；目标版本和节点尚未确认。"; result.restartRequired = true; }
        else { node.status = "failed"; node.message = "Manager 未确认插件已启用；下载、安装或依赖处理可能失败，请检查 Manager 安装日志。"; }
      }
    }
    return completeRemainingLookup();
  } catch (reason) {
    let finishError = "";
    continuingQueue = finishAcceptedQueue();
    const finishing = continuingQueue.catch(cleanupReason => {
      finishError = errorMessage(cleanupReason);
      if (signal.aborted) { try { options.onProgress?.(finishError); } catch { /* A closed dialog does not interrupt the accepted installation. */ } }
    });
    if (!signal.aborted) await untilCancelled(finishing, signal).catch(() => { /* Stop UI waiting while accepted work continues without a time limit. */ });
    if (options.signal?.aborted) {
      if (accepted.length) throw new DOMException(finishError || "已提交的插件安装将继续，界面已停止等待。", "AbortError");
      throw options.signal.reason;
    }
    const message = finishError || errorMessage(reason);
    result.managerError = message;
    for (const node of nodes) if (node.status === "failed" && node.message === "尚未搜索 Manager 插件索引。") node.message = message;
    return result;
  } finally {
    if (ownsLock) {
      const release = () => mutationLocks.delete(lockKey);
      if (continuingQueue) void continuingQueue.then(release, release); else release();
    }
  }
}
