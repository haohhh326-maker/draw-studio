import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ComfyUIClient, collectWorkflowOutputs, ExecutionError } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { catalog } from "../src/workflow/catalog";
import { clearCommunicationLog, communicationSnapshot } from "../src/comfyui/diagnostics";
import { getNativeRunningHubEndpoint, isRunningHubNativeConnection, NativeRunningHubAccountError, normalizeRunningHubNativeConnection, redactNativeRunningHubText, validateNativeRunningHubAccount } from "../src/runninghub/native-connection";
import type { Connection, TaskState } from "../src/types";

const native = vi.hoisted(() => ({ tauri: false, fetch: vi.fn(), connect: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.tauri }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: native.fetch }));
vi.mock("@tauri-apps/plugin-websocket", () => ({ default: { connect: native.connect } }));
const token = "fixture-native-private-key";
const endpoint = "https://www.runninghub.cn/proxy-plus";
const connection: Connection = { name: "RH native", baseUrl: endpoint, token, authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 0 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const account = (apiType: unknown = "NORMAL") => json({ code: 0, data: { apiType, remainCoins: "100.250", remainMoney: "0", currentTaskCounts: 0, currency: "CNY", apiKey: token } });
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

beforeEach(() => { native.tauri = false; native.fetch.mockReset(); native.connect.mockReset(); clearCommunicationLog(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native RunningHub connection normalization", () => {
  it("splits a pasted official key into private token before any URL is used", () => {
    const result = normalizeRunningHubNativeConnection({ ...connection, token: "", baseUrl: endpoint + "/" + token });
    expect(result).toEqual(connection);
    expect(normalizeRunningHubNativeConnection({ ...connection, baseUrl: endpoint + "/" + token })).toEqual(connection);
    expect(getNativeRunningHubEndpoint(result)).toEqual({ baseUrl: endpoint, site: "https://www.runninghub.cn", tier: "proxy-plus", token });
    const client = new ComfyUIClient({ ...connection, token: "", baseUrl: endpoint + "/" + token });
    expect(client.connection).toEqual(connection);
    expect(client.url("/queue")).toBe(endpoint + "/queue");
  });
  it.each([
    "http://www.runninghub.cn/proxy", "https://evil.example/proxy", "https://www.runninghub.ai/proxy",
    "https://www.runninghub.cn.evil.example/proxy", "https://user@www.runninghub.cn/proxy", "https://www.runninghub.cn/proxy?key=private",
    "https://www.runninghub.cn/proxy#key", "https://www.runninghub.cn/proxy/key/extra", "https://www.runninghub.cn/proxy/key%2Fextra",
  ])("rejects noncanonical or ambiguous endpoint %s", baseUrl => {
    expect(() => normalizeRunningHubNativeConnection({ ...connection, baseUrl })).toThrow();
  });
  it("rejects mismatched pasted and configured keys without exposing either", () => {
    expect(() => normalizeRunningHubNativeConnection({ ...connection, baseUrl: endpoint + "/different-key" })).toThrow("不一致");
    expect(isRunningHubNativeConnection({ baseUrl: endpoint + "/key/extra" })).toBe(true);
    expect(isRunningHubNativeConnection({ baseUrl: "https://www.runninghub.cn" })).toBe(false);
  });
  it("redacts raw, encoded, doubly encoded and escaped upstream secrets", () => {
    const url = endpoint + "/" + token;
    const value = [token, url, encodeURIComponent(url), encodeURIComponent(encodeURIComponent(url)), url.replaceAll("/", "\\/")].join(" ");
    const safe = redactNativeRunningHubText(value, connection);
    expect(safe).not.toContain(token);
    expect(safe).not.toContain(encodeURIComponent(url));
  });
});

describe("native RunningHub HTTP", () => {
  it("routes browser traffic only through the local bridge with separate auth and endpoint headers", async () => {
    vi.stubGlobal("window", { location: { origin: "https://canvas.example" } });
    const fetcher = vi.fn(async () => json({ queue_running: [], queue_pending: [] }));
    vi.stubGlobal("fetch", fetcher);
    const timer = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const client = new ComfyUIClient(connection);
    await client.request("/queue", { signal: controller.signal, headers: { Authorization: "malicious-override", "X-RunningHub-Native-Endpoint": "https://evil.example" } }, 1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://canvas.example/api/runninghub-comfy/queue");
    expect(url).not.toContain(token);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer " + token);
    expect(new Headers(init.headers).get("X-RunningHub-Native-Endpoint")).toBe(endpoint);
    expect(init.signal).toBe(controller.signal);
    expect(init.redirect).toBe("error");
    expect(timer).not.toHaveBeenCalled();
  });
  it("checks the NORMAL billing mode before each prompt submission", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(new URL(url).pathname); return url.endsWith("/account") ? account() : json({ prompt_id: "native-task" }); }));
    const client = new ComfyUIClient(connection);
    await client.queuePrompt({}, "request-1");
    await client.queuePrompt({}, "request-2");
    expect(calls).toEqual(["/api/runninghub-comfy/account", "/api/runninghub-comfy/prompt", "/api/runninghub-comfy/account", "/api/runninghub-comfy/prompt"]);
  });
  it.each(["SHARED", "EXCLUSIVE", "normal", "", null, undefined])("blocks unknown or incompatible account type %s without submitting", async apiType => {
    const fetcher = vi.fn(async () => json({ code: 0, data: { apiType } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).queuePrompt({}, "request")).rejects.toThrow("NORMAL");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(token);
  });
  it("returns only validated account balances including zero wallet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => account()));
    expect(await validateNativeRunningHubAccount(connection)).toEqual({ valid: true, apiType: "NORMAL", remainCoins: "100.250", remainMoney: "0", currentTaskCounts: "0", currency: "CNY" });
  });
  it("marks preflight transport failure as definitely not submitted and does not send a prompt", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch " + endpoint + "/" + token));
    vi.stubGlobal("fetch", fetcher);
    const error = await new ComfyUIClient(connection).queuePrompt({}, "request").catch(error => error);
    expect(error).toBeInstanceOf(NativeRunningHubAccountError);
    expect(error).toMatchObject({ aborted: false });
    expect(error.message).toContain("未提交任务");
    expect(error.message).not.toContain(token);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain("/account");
  });
  it("retains ordinary transport uncertainty after the account preflight passes and a prompt request fails", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(account()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetcher);
    const error = await new ComfyUIClient(connection).queuePrompt({}, "request").catch(error => error);
    expect(error).not.toBeInstanceOf(NativeRunningHubAccountError);
    expect(fetcher.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(["/api/runninghub-comfy/account", "/api/runninghub-comfy/prompt"]);
  });
  it("preserves token-like schema field names, arrays and numeric values while scrubbing reflected secrets", async () => {
    const schema = { Node: { input: { required: { apiKey: ["STRING", {}], token: ["INT", { default: 123 }], authorization: ["BOOLEAN", { default: false }] } } }, token: 123, apikey: null, privateMessage: token };
    vi.stubGlobal("fetch", vi.fn(async () => json(schema)));
    expect(await new ComfyUIClient(connection).getObjectInfo()).toEqual({ ...schema, privateMessage: "[已隐藏]" });
  });
  it("sanitizes HTTP error bodies, thrown messages, JSON success bodies and diagnostics", async () => {
    const raw = endpoint + "/" + token + "/prompt";
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: raw, encoded: encodeURIComponent(raw) }, 403))
      .mockRejectedValueOnce(new TypeError("Failed to fetch " + raw))
      .mockResolvedValueOnce(json({ message: raw, encoded: encodeURIComponent(raw) }));
    vi.stubGlobal("fetch", fetcher);
    const client = new ComfyUIClient(connection);
    try { await client.request("/queue"); throw new Error("did not reject"); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).body).not.toContain(token); expect((error as Error).message).not.toContain(token); expect((error as ApiError).status).toBe(403); }
    await expect(client.getQueue()).rejects.toThrow("[已隐藏]");
    expect(JSON.stringify(await client.json("/queue"))).not.toContain(token);
    expect(JSON.stringify(communicationSnapshot())).not.toContain(token);
  });
  it("accepts server-selected safe input folders and preserves the exact upload reference", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "server-renamed.png", subfolder: "uploads/actual", type: "input" })));
    const client = new ComfyUIClient(connection);
    expect(await client.uploadAsset(new Blob(["image"]), "image.png", "infinite-canvas/request")).toEqual({ name: "server-renamed.png", subfolder: "uploads/actual", type: "input", inputName: "uploads/actual/server-renamed.png" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "root.png", subfolder: "", type: "input" })));
    expect((await client.uploadAsset(new Blob(["image"]), "image.png", "infinite-canvas/request")).inputName).toBe("root.png");
  });
  it.each(["../escape", "/absolute", "C:\\escape", "safe//bad"]) ("rejects unsafe native upload folder %s", async subfolder => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "file.png", subfolder, type: "input" })));
    await expect(new ComfyUIClient(connection).uploadAsset(new Blob(["image"]), "image.png", "safe")).rejects.toThrow();
  });
  it("leaves ordinary ComfyUI folder verification and request deadlines unchanged", async () => {
    const timer = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => json({ name: "file.png", subfolder: "renamed", type: "input" })));
    await expect(new ComfyUIClient({ ...connection, baseUrl: "https://comfy.example" }).uploadAsset(new Blob(["image"]), "image.png", "expected")).rejects.toThrow("本次任务");
    expect(timer).toHaveBeenCalledWith(300000);
  });
  it("uses native plugin HTTP with upstream path only in Tauri and disables redirect following", async () => {
    native.tauri = true;
    const browserFetch = vi.fn(); vi.stubGlobal("fetch", browserFetch);
    native.fetch.mockResolvedValueOnce(account()).mockResolvedValueOnce(json({ prompt_id: "native-task" }));
    await new ComfyUIClient(connection).queuePrompt({}, "request");
    expect(browserFetch).not.toHaveBeenCalled();
    expect(native.fetch.mock.calls[0][0]).toBe("https://www.runninghub.cn/uc/openapi/accountStatus");
    expect(JSON.parse(native.fetch.mock.calls[0][1].body)).toEqual({ apikey: token });
    expect(native.fetch.mock.calls[1][0]).toBe(endpoint + "/" + token + "/prompt");
    expect(native.fetch.mock.calls[1][1]).toMatchObject({ redirect: "error", maxRedirections: 0 });
    expect(native.fetch.mock.calls[1][1]).not.toHaveProperty("connectTimeout");
  });
  it("preserves binary output bytes and removes native Response URL metadata", async () => {
    native.tauri = true;
    const bytes = new Uint8Array([0, 255, 17, 22]);
    native.fetch.mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    const result = await new ComfyUIClient(connection).getOutput({ filename: "result.png", type: "output" });
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  });
  it("sanitizes failures while consuming a native binary output stream", async () => {
    native.tauri = true;
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("download failed " + endpoint + "/" + token)); } });
    native.fetch.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "image/png" } }));
    await expect(new ComfyUIClient(connection).getOutput({ filename: "result.png", type: "output" })).rejects.toThrow("[已隐藏]");
  });
});

class BrowserSocket {
  static current: BrowserSocket;
  readonly messages: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: URL) { BrowserSocket.current = this; }
  send(text: string) { this.messages.push(text); }
  close() { this.onclose?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("native RunningHub realtime channel", () => {
  it("keeps secrets off browser URLs, sends credentials in first frame and awaits upstream ready without a timer", async () => {
    vi.useFakeTimers(); vi.stubGlobal("WebSocket", BrowserSocket);
    const client = new ComfyUIClient(connection, "client-id");
    let resolved = false; const connected = client.connect().then(() => { resolved = true; });
    const socket = BrowserSocket.current;
    expect(String(socket.url)).toBe("ws://localhost/api/runninghub-comfy/ws?clientId=client-id");
    expect(String(socket.url)).not.toContain(token);
    socket.onopen?.(); await tick();
    expect(socket.messages.map(message => JSON.parse(message))).toEqual([{ type: "authenticate", endpoint, token }]);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(resolved).toBe(false); expect(vi.getTimerCount()).toBe(0);
    socket.message({ type: "rh_native_ready" }); await connected;
    expect(resolved).toBe(true);
    client.disconnect();
    expect(socket.onmessage).toBeNull();
  });
  it("rejects bridge auth failures with sanitized messages", async () => {
    vi.stubGlobal("WebSocket", BrowserSocket);
    const client = new ComfyUIClient(connection);
    const connected = client.connect();
    BrowserSocket.current.onopen?.();
    BrowserSocket.current.message({ type: "rh_native_error", message: "failed " + endpoint + "/" + token });
    await expect(connected).rejects.toThrow("[已隐藏]");
    expect(BrowserSocket.current.onmessage).toBeNull();
  });
  it.each(["close", "disconnect"])("settles connection promise on %s before ready", async operation => {
    vi.stubGlobal("WebSocket", BrowserSocket);
    const client = new ComfyUIClient(connection);
    const connected = client.connect();
    if (operation === "close") BrowserSocket.current.close(); else client.disconnect();
    await expect(connected).rejects.toThrow();
  });
  it("sanitizes task error events before they enter task history or diagnostics", async () => {
    vi.stubGlobal("WebSocket", BrowserSocket);
    const client = new ComfyUIClient(connection);
    const connected = client.connect(); BrowserSocket.current.onopen?.(); BrowserSocket.current.message({ type: "rh_native_ready" }); await connected;
    BrowserSocket.current.message({ type: "execution_error", data: { prompt_id: "task", node: "1", exception_message: "upstream " + endpoint + "/" + token, traceback: [encodeURIComponent(endpoint + "/" + token)] } });
    const states: unknown[] = [];
    try { await client.waitForCompletion("task", value => states.push(value), new AbortController().signal); throw new Error("did not reject"); }
    catch (error) { expect(error).toBeInstanceOf(ExecutionError); expect((error as ExecutionError).details).not.toContain(token); }
    expect(JSON.stringify(states)).not.toContain(token); expect(JSON.stringify(communicationSnapshot())).not.toContain(token);
    client.disconnect();
  });
  it("does not impose the ordinary generation deadline on native history recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ task: { status: { completed: true }, outputs: {} } })));
    expect(await new ComfyUIClient(connection).waitForCompletion("task", () => {}, new AbortController().signal)).toEqual({ status: { completed: true }, outputs: {} });
  });
  it.each([{}, { "92": { images: [{ filename: "result.mp4", type: "output", subfolder: "infinite-canvas/task" }] } }])("accepts native success without the optional completed flag", async outputs => {
    const history = { status: { status_str: "success" }, outputs };
    const client = new ComfyUIClient(connection);
    vi.spyOn(client, "getHistory").mockResolvedValue({ task: history });
    const queue = vi.spyOn(client, "getQueue");
    expect(await client.waitForCompletion("task", () => {}, new AbortController().signal)).toEqual(history);
    expect(queue).not.toHaveBeenCalled();
  });
  it("keeps native execution errors terminal even when history contains outputs", async () => {
    const client = new ComfyUIClient(connection);
    vi.spyOn(client, "getHistory").mockResolvedValue({ task: { status: { status_str: "error" }, outputs: { "92": { images: [{ filename: "partial.mp4" }] } } } });
    await expect(client.waitForCompletion("task", () => {}, new AbortController().signal)).rejects.toBeInstanceOf(ExecutionError);
  });
  it("waits for explicit success when native history still reports partial running outputs", async () => {
    vi.useFakeTimers();
    const client = new ComfyUIClient(connection);
    const outputs = { "92": { images: [{ filename: "result.mp4", type: "output" }] } };
    const success = { status: { status_str: "success" }, outputs };
    vi.spyOn(client, "getHistory").mockResolvedValueOnce({ task: { status: { status_str: "running" }, outputs } }).mockResolvedValueOnce({ task: success });
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [[0, "task"]], queue_pending: [] });
    let resolved = false;
    const result = client.waitForCompletion("task", () => {}, new AbortController().signal).then(value => { resolved = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual(success);
  });
  it("stops reporting queued when a native task leaves both queues while history catches up", async () => {
    vi.useFakeTimers();
    const client = new ComfyUIClient(connection);
    const success = { status: { status_str: "success" }, outputs: {} };
    vi.spyOn(client, "getHistory").mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ task: success });
    vi.spyOn(client, "getQueue").mockResolvedValueOnce({ queue_running: [], queue_pending: [[0, "task"]] }).mockResolvedValueOnce({ queue_running: [], queue_pending: [] });
    const states: Partial<TaskState>[] = [];
    const result = client.waitForCompletion("task", state => states.push(state), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: "queued", execution: { queueRemaining: 1 } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toMatchObject({ status: "loading", details: "平台队列中未找到该任务，正在查询原任务结果。" });
    expect(states.at(-1)?.execution?.queueRemaining).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual(success);
  });
  it("preserves the last native node progress when the socket closes and the task is absent from the queue", async () => {
    vi.useFakeTimers(); vi.stubGlobal("WebSocket", BrowserSocket);
    const client = new ComfyUIClient(connection);
    const connected = client.connect();
    BrowserSocket.current.onopen?.(); BrowserSocket.current.message({ type: "rh_native_ready" }); await connected;
    BrowserSocket.current.message({ type: "progress", data: { prompt_id: "task", node: "92", value: 6, max: 10 } });
    BrowserSocket.current.close();
    vi.spyOn(client, "getHistory").mockResolvedValueOnce({}).mockResolvedValueOnce({ task: { status: { status_str: "success" }, outputs: {} } });
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [], queue_pending: [] });
    const states: Partial<TaskState>[] = [];
    const result = client.waitForCompletion("task", state => states.push(state), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: "generating", execution: { nodeId: "92", value: 6, max: 10 } });
    expect(states.some(state => state.status === "queued")).toBe(false);
    await vi.advanceTimersByTimeAsync(1500); await result;
    client.disconnect();
  });
  it("recognizes a native mp4 returned under images as a video in automatic output mapping", () => {
    const file = { filename: "result.mp4", type: "output" as const, subfolder: "infinite-canvas/task" };
    const workflow = { ...catalog[0], output: { nodeId: "92", field: "*", kind: "video" as const } };
    const result = collectWorkflowOutputs({ status: { status_str: "success" }, outputs: { "92": { images: [file] } } }, workflow);
    expect(result.files).toEqual([file]);
    expect(result.fileKinds[outputKey(file)]).toBe("video");
  });
  it("cancels a browser realtime handshake immediately through the caller signal", async () => {
    vi.stubGlobal("WebSocket", BrowserSocket);
    const controller = new AbortController(), client = new ComfyUIClient(connection);
    const connected = client.connect(controller.signal);
    controller.abort();
    await expect(connected).rejects.toThrow();
    expect(BrowserSocket.current.onmessage).toBeNull();
  });
  it("forwards cancellation through the account preflight and history polling requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const client = new ComfyUIClient(connection);
    const queued = client.queuePrompt({}, "request", controller.signal);
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "NativeRunningHubAccountError", aborted: true });
    const pollingController = new AbortController();
    const polling = client.waitForCompletion("task", () => {}, pollingController.signal);
    expect(fetcher.mock.calls[1][1]?.signal).toBe(pollingController.signal);
    pollingController.abort();
    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
  });
  it("cancels a pending native plugin handshake and disconnects it if it opens later", async () => {
    native.tauri = true;
    let complete: (socket: unknown) => void = () => {};
    native.connect.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const disconnect = vi.fn(async () => {}), controller = new AbortController();
    const connected = new ComfyUIClient(connection).connect(controller.signal);
    await vi.waitFor(() => expect(native.connect).toHaveBeenCalledOnce()); controller.abort();
    await expect(connected).rejects.toMatchObject({ name: "AbortError" });
    complete({ disconnect });
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  });
  it("uses native plugin websocket directly and hides errors containing its private URL", async () => {
    native.tauri = true;
    const browserSocket = vi.fn(); vi.stubGlobal("WebSocket", browserSocket);
    native.connect.mockRejectedValueOnce(new Error("upstream " + endpoint + "/" + token));
    await expect(new ComfyUIClient(connection, "client-id").connect()).rejects.toThrow("[已隐藏]");
    expect(browserSocket).not.toHaveBeenCalled();
    expect(native.connect.mock.calls[0][0]).toBe("wss://www.runninghub.cn/proxy-plus/" + token + "/ws?clientId=client-id");
  });
});
