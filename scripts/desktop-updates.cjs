const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");

function newer(version, current) {
  const parse = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const next = parse(version), previous = parse(current);
  if (!next || !previous) throw new Error("软件版本号无效。" );
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

function createSoftwareUpdates({ app, dialog, userData, owner, defaultFeedUrl, defaultsFile, beforeInstall = async () => {}, fetcher = fetch, launch = spawn }) {
  let release;
  let checking;
  let action;
  let status = { currentVersion: app.getVersion(), available: false, configured: false, phase: "idle", downloadedBytes: 0 };
  const getStatus = () => ({ ...status });
  const updateStatus = patch => { status = { ...status, ...patch }; };
  function failed(error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus({ phase: "error", message, error: message });
    throw error;
  }
  function secureUrl(value) {
    let address;
    try { address = new URL(value); } catch { throw new Error("软件更新地址必须为有效的 HTTPS 地址。"); }
    if (address.protocol !== "https:" || address.username || address.password) throw new Error("软件更新地址必须为 HTTPS。");
    return address;
  }
  async function readSettings(file) {
    if (!file) return;
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("无法读取软件更新配置。");
    }
  }
  async function checkRelease() {
    release = undefined;
    updateStatus({ phase: "checking", available: false, latestVersion: undefined, releaseNotes: "", error: undefined,
      downloadedBytes: 0, totalBytes: undefined, percent: undefined, message: "正在检查更新…" });
    const config = await readSettings(path.join(userData, "software-update.json"));
    let feedUrl = typeof config?.feedUrl === "string" ? config.feedUrl.trim() : config?.feedUrl;
    if (!feedUrl) {
      const defaults = await readSettings(defaultsFile);
      feedUrl = defaults?.feedUrl || defaultFeedUrl;
    }
    if (!feedUrl) {
      updateStatus({ phase: "idle", configured: false, message: "软件更新服务尚未启用，请稍后检查。" });
      return getStatus();
    }
    const feed = secureUrl(feedUrl);
    updateStatus({ configured: true });
    const response = await fetcher(feed, { cache: "no-store" });
    if (!response.ok) throw new Error("检查软件更新失败（HTTP " + response.status + "）。");
    if (response.url) secureUrl(response.url);
    const manifest = await response.json();
    const available = newer(manifest.version, status.currentVersion);
    if (typeof manifest.windows?.url !== "string" || !manifest.windows.url.trim()) throw new Error("软件更新清单缺少安装包地址。" );
    const download = secureUrl(new URL(manifest.windows.url, feed));
    const size = manifest.windows.size;
    if (!/^[a-f0-9]{64}$/i.test(manifest.windows?.sha256 ?? "") ||
        size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) throw new Error("软件更新清单无效。" );
    release = available ? { version: manifest.version, url: download.href, sha256: manifest.windows.sha256.toLowerCase(), size } : undefined;
    updateStatus({ phase: "idle", latestVersion: manifest.version, available, configured: true, totalBytes: size,
      releaseNotes: typeof manifest.notes === "string" ? manifest.notes : "",
      message: available ? "发现新版本，可下载安装更新。" : "当前已是最新版本。" });
    return getStatus();
  }
  function requestCheck() {
    if (!checking) checking = checkRelease().catch(failed).finally(() => { checking = undefined; });
    return checking;
  }
  function check() {
    return action || status.phase === "installing" ? Promise.resolve(getStatus()) : requestCheck();
  }
  async function validateExecutable(file) {
    const handle = await fs.open(file, "r");
    try {
      const magic = Buffer.alloc(2);
      await handle.read(magic, 0, 2, 0);
      if (magic.toString("ascii") !== "MZ") throw new Error("文件不是有效的 Windows 软件安装程序。");
    } finally { await handle.close(); }
  }
  async function verifyFile(file, selected) {
    await validateExecutable(file);
    const digest = createHash("sha256");
    let size = 0;
    for await (const bytes of createReadStream(file)) { digest.update(bytes); size += bytes.length; }
    if (digest.digest("hex") !== selected.sha256 || selected.size !== undefined && size !== selected.size)
      throw new Error("安装包校验失败，请重新下载。");
  }
  async function runInstaller(file) {
    if (path.extname(file).toLowerCase() !== ".exe") throw new Error("请选择 Windows 软件安装程序（.exe）。");
    await validateExecutable(file);
    updateStatus({ phase: "saving", message: "正在保存项目，准备安装更新…" });
    await beforeInstall();
    updateStatus({ phase: "installing", message: "正在启动新版安装程序…" });
    await new Promise((resolve, reject) => {
      const child = launch(file, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    setImmediate(() => app.quit());
    return { message: "已启动新版安装程序。" };
  }
  function startAction(work) {
    if (action) return action;
    if (status.phase === "installing") return Promise.resolve({ message: status.message });
    action = Promise.resolve().then(work).catch(failed).finally(() => { action = undefined; });
    return action;
  }
  function install() {
    return startAction(async () => {
      const result = await dialog.showOpenDialog(owner(), {
        title: "选择 Draw studio 新版安装包", properties: ["openFile"],
        filters: [{ name: "Windows 安装程序", extensions: ["exe"] }],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return runInstaller(result.filePaths[0]);
    });
  }
  function downloadAndInstall() {
    return startAction(async () => {
      if (!release) await requestCheck();
      if (!release) throw new Error("当前没有可下载的新版，请重新检查更新。" );
      const selected = { ...release };
      const directory = path.join(userData, "updates", selected.version);
      await fs.mkdir(directory, { recursive: true });
      const partial = path.join(directory, "Draw-studio-Setup.exe.partial");
      const destination = path.join(directory, "Draw-studio-Setup.exe");
      const existing = await fs.stat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (existing?.isFile()) {
        updateStatus({ phase: "verifying", downloadedBytes: existing.size, totalBytes: existing.size, percent: 100,
          error: undefined, message: "正在校验已下载的安装包…" });
        let valid = false;
        try { await verifyFile(destination, selected); valid = true; } catch { /* Re-fetch a damaged cached installer. */ }
        if (valid) return runInstaller(destination);
        await fs.unlink(destination);
      }
      try {
        updateStatus({ phase: "downloading", downloadedBytes: 0, totalBytes: selected.size,
          percent: selected.size ? 0 : undefined, error: undefined, message: "正在下载安装包…" });
        const response = await fetcher(selected.url);
        if (!response.ok || !response.body) throw new Error("新版安装包下载失败。" );
        if (response.url) secureUrl(response.url);
        const encoding = response.headers.get("content-encoding");
        const length = encoding && encoding !== "identity" ? undefined : Number(response.headers.get("content-length"));
        const totalBytes = selected.size ?? (Number.isSafeInteger(length) && length > 0 ? length : undefined);
        let downloadedBytes = 0;
        const progress = () => updateStatus({ downloadedBytes, totalBytes,
          percent: totalBytes ? Math.min(100, downloadedBytes / totalBytes * 100) : undefined });
        const counter = new Transform({ transform(bytes, _encoding, done) {
          downloadedBytes += bytes.length;
          progress();
          done(null, bytes);
        } });
        await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial));
        if (totalBytes !== undefined && downloadedBytes !== totalBytes) throw new Error("安装包下载不完整，请重试。");
        progress();
        updateStatus({ phase: "verifying", message: "正在校验安装包…" });
        await verifyFile(partial, selected);
        await fs.rename(partial, destination);
        return runInstaller(destination);
      } finally { await fs.unlink(partial).catch(() => {}); }
    });
  }
  return { check, install, downloadAndInstall, getStatus };
}

module.exports = { createSoftwareUpdates, newer };
