const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu } = require("electron");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { prepareWorkspace } = require("./desktop-workspace.cjs");
const { createSoftwareUpdates } = require("./desktop-updates.cjs");

const root = path.resolve(__dirname, "..");
const resources = app.isPackaged ? path.join(process.resourcesPath, "draw-studio") : path.join(root, ".desktop-package", "resources");
if (process.env.DRAW_STUDIO_USER_DATA) app.setPath("userData", path.resolve(process.env.DRAW_STUDIO_USER_DATA));
app.setAppUserModelId("studio.clearframe.canvas");
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let canvasUrl = "";
const sites = Object.freeze({ muse: "https://muse.ai/", deepseek: "https://chat.deepseek.com/" });
const allowedDomains = Object.freeze({ muse: new Set(["muse.ai", ".muse.ai"]), deepseek: new Set(["deepseek.com", ".deepseek.com", "chat.deepseek.com", ".chat.deepseek.com"]) });
const views = new Map();
let mainWindow;
let ownedServer;
let closing = false;
let updates;
let savedForExit = false;

async function ensureServer() {
  const workspace = await prepareWorkspace(resources, app.getPath("userData"));
  const runtime = app.isPackaged ? resources : path.join(root, ".desktop-package", "resources");
  const browser = path.join(runtime, "browser", "chrome-win64", "chrome.exe");
  const instanceId = randomUUID();
  const logs = path.join(app.getPath("userData"), "logs");
  await fs.mkdir(logs, { recursive: true });
  const serverFile = path.join(runtime, "desktop-server.cjs");
  ownedServer = fork(serverFile, [], {
    cwd: workspace, execPath: process.execPath, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CANVAS_ROOT: workspace,
      CANVAS_DIST: path.join(runtime, "dist"), CANVAS_PORT: process.env.DRAW_STUDIO_PORT ?? "14320",
      CANVAS_INSTANCE_ID: instanceId, DRAW_STUDIO_DATA_HOME: path.join(app.getPath("userData"), "services"),
      DRAW_STUDIO_BROWSER_EXECUTABLE: browser,
      CANVAS_TRANSFER_ROOT: path.join(workspace, "workflows"),
      CANVAS_TRANSFER_ENGINE_BINARY: path.join(runtime, "seed", ".cache", "native-filezilla-official", "bridge", "cloud-transfer-bridge"),
      CANVAS_TRANSFER_ENGINE_LIBRARIES: path.join(runtime, "seed", ".cache", "native-filezilla-official", "prefix", "lib"),
      PATH: path.join(runtime, "tools") + path.delimiter + (process.env.PATH ?? ""),
    },
  });
  ownedServer.stdout.resume();
  ownedServer.stderr.on("data", bytes => { void fs.appendFile(path.join(logs, "server.log"), bytes).catch(() => {}); });
  canvasUrl = await new Promise((resolve, reject) => {
    const ready = message => {
      if (message?.type !== "draw-studio-server-ready" || message.instanceId !== instanceId) return;
      ownedServer.off("error", failed); ownedServer.off("exit", stopped); ownedServer.off("message", ready);
      resolve(message.url);
    };
    const failed = error => { ownedServer.off("message", ready); reject(error); };
    const stopped = code => failed(new Error("Draw studio 本机服务启动失败（" + code + "）。"));
    ownedServer.on("message", ready); ownedServer.once("error", failed); ownedServer.once("exit", stopped);
  });
  ownedServer.on("exit", () => {
    if (!closing && mainWindow && !mainWindow.isDestroyed())
      void dialog.showMessageBox(mainWindow, { type: "error", title: "本机服务已停止", message: "请重新打开 Draw studio 恢复本机服务。" });
  });
}
function requireCanvas(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.sender.getURL().startsWith(canvasUrl))
    throw new Error("Only the local canvas may control its service views.");
}
function validService(service) {
  if (service !== "muse" && service !== "deepseek") throw new Error("Unknown browser service.");
  return service;
}
function boundsOf(args) {
  const values = [args?.x, args?.y, args?.width, args?.height];
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value)) || args.width <= 0 || args.height <= 0)
    throw new Error("Invalid browser bounds.");
  return { x: Math.max(0, Math.round(args.x)), y: Math.max(0, Math.round(args.y)), width: Math.max(1, Math.round(args.width)), height: Math.max(1, Math.round(args.height)) };
}
function viewFor(service) {
  const existing = views.get(service);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  const view = new WebContentsView({ webPreferences: {
    partition: `persist:draw-studio-${service}`, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true,
  } });
  view.setBackgroundColor("#ffffff");
  view.webContents.setWindowOpenHandler(({ url }) => {
    // OAuth stays in the same in-canvas browser surface.
    if (url.startsWith("https://")) void view.webContents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  views.set(service, view);
  void view.webContents.loadURL(sites[service]).catch(() => {});
  return view;
}
async function waitForSite(view, origin) {
  if (view.webContents.isDestroyed()) throw new Error("Browser view was closed.");
  try { if (new URL(view.webContents.getURL()).origin === origin && !view.webContents.isLoading()) return; }
  catch { /* The first navigation has not started. */ }
  await new Promise((resolve, reject) => {
    const webContents = view.webContents;
    const cleanup = () => {
      webContents.removeListener("did-finish-load", check);
      webContents.removeListener("did-fail-load", fail);
      webContents.removeListener("destroyed", destroyed);
    };
    const check = () => {
      try {
        if (new URL(webContents.getURL()).origin !== origin) return;
        cleanup(); resolve();
      } catch { /* Keep waiting for the expected site. */ }
    };
    const fail = (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      cleanup(); reject(new Error(`Browser navigation failed: ${description}`));
    };
    const destroyed = () => { cleanup(); reject(new Error("Browser view was closed.")); };
    webContents.on("did-finish-load", check);
    webContents.on("did-fail-load", fail);
    webContents.on("destroyed", destroyed);
    check();
  });
}
async function exportAuth(service) {
  const view = views.get(service);
  if (!view || view.webContents.isDestroyed()) return { cookies: [], origins: [] };
  const target = new URL(sites[service]);
  const cookies = (await view.webContents.session.cookies.get({ url: target.href }))
    .filter(cookie => allowedDomains[service].has(cookie.domain))
    .map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || "/",
      httpOnly: cookie.httpOnly, secure: cookie.secure,
      ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
      ...(cookie.sameSite === "strict" ? { sameSite: "Strict" } : cookie.sameSite === "lax" ? { sameSite: "Lax" } : cookie.sameSite === "no_restriction" ? { sameSite: "None" } : {}),
    }));
  let localStorage = [];
  try {
    const current = new URL(view.webContents.getURL());
    if (current.origin === target.origin) {
      localStorage = await view.webContents.executeJavaScript(`(() => {
        try { return Object.keys(localStorage).map(name => ({ name, value: localStorage.getItem(name) ?? "" })); }
        catch { return []; }
      })()`, true);
    }
  } catch { /* The page may still be navigating. Cookies remain available. */ }
  return { cookies, origins: localStorage.length ? [{ origin: target.origin, localStorage }] : [] };
}
async function importAuth(service, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.cookies) || !Array.isArray(snapshot.origins)) return;
  const view = viewFor(service);
  const target = new URL(sites[service]);
  for (const cookie of snapshot.cookies) {
    if (!allowedDomains[service].has(cookie.domain)) continue;
    const hostCookie = cookie.name.startsWith("__Host-");
    await view.webContents.session.cookies.set({
      url: target.href, name: cookie.name, value: cookie.value,
      ...(hostCookie ? {} : { domain: cookie.domain }),
      path: hostCookie ? "/" : cookie.path || "/",
      secure: hostCookie || !!cookie.secure, httpOnly: !!cookie.httpOnly,
      ...(cookie.expires === undefined || cookie.expires < 0 ? {} : { expirationDate: cookie.expires }),
      ...(cookie.sameSite === "Strict" ? { sameSite: "strict" } : cookie.sameSite === "Lax" ? { sameSite: "lax" } : cookie.sameSite === "None" ? { sameSite: "no_restriction" } : {}),
    });
  }
  const storage = snapshot.origins.find(item => item.origin === target.origin)?.localStorage;
  if (storage?.length) {
    await waitForSite(view, target.origin);
    const pairs = JSON.stringify(storage.filter(item => typeof item.name === "string" && typeof item.value === "string"));
    await view.webContents.executeJavaScript(`(() => { for (const item of ${pairs}) localStorage.setItem(item.name, item.value); })()`, true);
  }
  if (snapshot.cookies.length || storage?.length) view.webContents.reload();
}

ipcMain.handle("draw-studio:service-webview", async (event, command, args = {}) => {
  requireCanvas(event);
  if (["check_software_update", "get_software_update_status", "open_software_update", "install_software_update"].includes(command)) {
    try {
      if (command === "check_software_update") return await updates.check();
      if (command === "get_software_update_status") return updates.getStatus();
      if (command === "open_software_update") return await updates.downloadAndInstall();
      return await updates.install();
    } catch (error) {
      savedForExit = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
      throw error;
    }
  }
  const service = validService(args.service);
  if (command === "show_service_webview") {
    for (const [other, view] of views) if (other !== service) mainWindow.contentView.removeChildView(view);
    const view = viewFor(service);
    mainWindow.contentView.addChildView(view);
    view.setBounds(boundsOf(args));
    view.webContents.focus();
    return;
  }
  if (command === "set_service_webview_bounds") {
    const view = views.get(service);
    if (view) view.setBounds(boundsOf(args));
    return;
  }
  if (command === "hide_service_webview") {
    const view = views.get(service);
    if (view) mainWindow.contentView.removeChildView(view);
    return;
  }
  if (command === "reload_service_webview") { views.get(service)?.webContents.reload(); return; }
  if (command === "set_service_webview_zoom") {
    if (typeof args.zoom !== "number" || !Number.isFinite(args.zoom) || args.zoom < 0.5 || args.zoom > 2.5) throw new Error("Invalid zoom.");
    views.get(service)?.webContents.setZoomFactor(args.zoom); return;
  }
  if (command === "export_service_webview_auth") return exportAuth(service);
  if (command === "import_service_webview_auth") return importAuth(service, args.snapshot);
  throw new Error("Unknown browser command.");
});

async function saveBeforeExit() {
  if (savedForExit || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setEnabled(false);
  try {
    await mainWindow.webContents.executeJavaScript("window.drawStudioSaveBeforeExit ? window.drawStudioSaveBeforeExit() : Promise.resolve()", true);
    savedForExit = true;
  } catch (error) {
    mainWindow.setEnabled(true);
    throw error;
  }
}

app.on("second-instance", () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

if (hasLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await ensureServer();
  mainWindow = new BrowserWindow({
    title: "Draw studio", width: 1600, height: 1000, minWidth: 1000, minHeight: 720,
    backgroundColor: "#26282a", show: false, autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#26282a", symbolColor: "#f5f5f5", height: 36 },
    icon: path.join(resources, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "desktop-preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(canvasUrl)) event.preventDefault(); });
  updates = createSoftwareUpdates({ app, dialog, userData: app.getPath("userData"), owner: () => mainWindow,
    defaultsFile: path.join(resources, "software-update.defaults.json"), beforeInstall: saveBeforeExit });
  mainWindow.on("close", event => {
    if (closing) return;
    event.preventDefault();
    void saveBeforeExit().then(() => { closing = true; mainWindow.close(); }).catch(error => {
      void dialog.showMessageBox(mainWindow, { type: "error", title: "保存失败", message: "项目保存失败，请重试。", detail: String(error.message) });
    });
  });
  await mainWindow.loadURL(canvasUrl);
  mainWindow.show();
}).catch(error => { dialog.showErrorBox("Draw studio 启动失败", error.message); closing = true; app.quit(); });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", event => {
  if (!closing && !savedForExit && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    void saveBeforeExit().then(() => { closing = true; app.quit(); }).catch(error => {
      void dialog.showMessageBox(mainWindow, { type: "error", title: "保存失败", message: "项目保存失败，请重试。", detail: String(error.message) });
    });
    return;
  }
  closing = true;
  for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
  if (ownedServer && ownedServer.exitCode === null) {
    if (ownedServer.connected) {
      ownedServer.send({ type: "draw-studio-server-stop" }, () => {});
      ownedServer.disconnect();
    }
  }
});
