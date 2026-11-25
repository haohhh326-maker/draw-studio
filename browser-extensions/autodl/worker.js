import { runAutoDLCommand } from "./autodl-page.js";

const deployUrl = "https://www.autodl.art/app/deploy";
const pairingKey = "drawStudioAutoDLPairing";
const wakeAlarm = "drawStudioAutoDLBridge";
let loop;
let connection = "disconnected";
let pendingPoll;
let pairingRevision = 0;
let pairing = false;

function localOrigin(address) {
  const url = new URL(address);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("此地址不是本机画布。");
  }
  return url.origin;
}

function canvasSenderOrigin(sender) {
  if (!sender.tab || sender.id || sender.frameId !== 0 || typeof sender.url !== "string") return;
  try {
    const page = new URL(sender.url);
    if (page.pathname !== "/" || page.search || page.hash) return;
    const origin = localOrigin(page.origin);
    if (sender.origin === origin && ["1420", "14320"].includes(page.port)) return origin;
  } catch { /* Only the top-level page of a supported local canvas can connect. */ }
}

async function post(origin, route, data, signal) {
  const timeout = AbortSignal.timeout(27000);
  return fetch(origin + "/__canvas/autodl/bridge/" + route, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function deploymentTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.autodl.art/*" });
  const consoleTab = tabs.find(tab => {
    if (!tab.url) return false;
    const url = new URL(tab.url);
    return url.origin === "https://www.autodl.art" && url.pathname.replace(/\/$/, "") === "/app/deploy";
  });
  if (consoleTab?.id !== undefined) return consoleTab.id;

  const tab = await chrome.tabs.create({ url: deployUrl, active: false });
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") return current.id;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return tab.id;
}

async function execute(command) {
  try {
    const tabId = await deploymentTab();
    const [response] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: runAutoDLCommand,
      args: [command.operation, command.instanceUuid ?? null, command.expiresAt ?? null],
    });
    return response?.result ?? { ok: false, errorCode: "NO_AUTODL_TAB" };
  } catch {
    return { ok: false, errorCode: "NO_AUTODL_TAB" };
  }
}

async function work() {
  for (;;) {
    // Reading extension storage also resets the service worker's inactivity timer.
    const { [pairingKey]: pair } = await chrome.storage.local.get(pairingKey);
    if (!pair) { connection = "disconnected"; return; }
    let origin;
    try { origin = localOrigin(pair.origin); }
    catch { connection = "disconnected"; return; }
    const revision = pairingRevision;
    try {
      const poll = new AbortController();
      pendingPoll = poll;
      const response = await post(origin, "poll", { bridgeKey: pair.bridgeKey }, poll.signal)
        .finally(() => { if (pendingPoll === poll) pendingPoll = undefined; });
      if (revision !== pairingRevision) continue;
      if (response.status === 401 || response.status === 403) {
        connection = "pair-again";
        return;
      }
      if (!response.ok) throw new Error("Bridge unavailable");
      connection = "connected";
      const command = await response.json();
      if (command.idle) continue;
      if (typeof command.id !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(command.id)) throw new Error("Invalid command");
      const result = await execute(command);
      // Only retry delivering the response. Never repeat the cloud operation.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const delivered = await post(origin, "result", { bridgeKey: pair.bridgeKey, id: command.id, ...result });
          if (delivered.status < 500) break;
        } catch { /* The local service independently reconciles remote state. */ }
      }
    } catch {
      if (revision !== pairingRevision) continue;
      connection = "waiting";
      return; // The alarm or browser startup will reconnect.
    }
  }
}

function wake() {
  loop ??= work().catch(() => { connection = "waiting"; }).finally(() => { loop = undefined; });
}

async function start() {
  if (!await chrome.alarms.get(wakeAlarm)) await chrome.alarms.create(wakeAlarm, { periodInMinutes: 0.5 });
  wake();
}
chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === wakeAlarm) wake(); });

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.url !== chrome.runtime.getURL("popup.html") || message?.action !== "read") return;
  chrome.storage.local.get(pairingKey).then(value => {
    wake();
    reply({ connection, origin: value[pairingKey]?.origin });
  }, () => reply({ connection: "disconnected" }));
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  const origin = canvasSenderOrigin(sender);
  if (!origin) return;
  if (message?.action !== "pair-canvas") return;
  if (typeof message.code !== "string" || !/^[a-f0-9]{8}$/i.test(message.code)
      || Object.keys(message).some(key => key !== "action" && key !== "code")) {
    reply({ error: "连接请求已失效，请在画布上重试。" });
    return;
  }
  if (pairing) {
    reply({ error: "正在连接，请稍等。" });
    return;
  }
  pairing = true;
  (async () => {
    const { [pairingKey]: saved } = await chrome.storage.local.get(pairingKey);
    if (saved) {
      const previousOrigin = localOrigin(saved.origin);
      const sameCanvas = new URL(previousOrigin).port === new URL(origin).port;
      const route = sameCanvas ? "verify" : "disconnect";
      const previous = await post(previousOrigin, route, { bridgeKey: saved.bridgeKey }, AbortSignal.timeout(3000))
        .catch(() => { throw new Error("请打开原来连接的 Draw studio 后再重试。"); });
      if (sameCanvas && previous.ok) {
        await start();
        reply({ connected: true });
        return;
      }
      if (previous.status === 409) throw new Error("原画布有未结束的 AutoDL 任务，请等结果保存并确认关机后再切换。");
      if (!previous.ok && previous.status !== 401) throw new Error("无法确认原画布的连接状态，请重试。");
      if (!sameCanvas) {
        await chrome.storage.local.remove(pairingKey);
        pairingRevision++;
        pendingPoll?.abort();
      }
    }
    const response = await post(origin, "pair", { code: message.code }, AbortSignal.timeout(5000));
    if (!response.ok) {
      if (response.status === 409) throw new Error("有任务正在使用 AutoDL，请等待结果保存并确认关机后再连接。");
      throw new Error("连接未完成，请在画布上重试。");
    }
    const { bridgeKey } = await response.json();
    if (typeof bridgeKey !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/.test(bridgeKey)) throw new Error("配对响应无效。");
    await chrome.storage.local.set({ [pairingKey]: { origin, bridgeKey } });
    pairingRevision++;
    pendingPoll?.abort();
    connection = "connected";
    await start();
    reply({ connected: true });
  })().catch(error => reply({ error: error.name === "TimeoutError" ? "本机画布没有及时响应，请重试。" : error.message || "连接未完成，请重试。" }))
    .finally(() => { pairing = false; });
  return true;
});
