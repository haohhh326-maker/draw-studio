import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ connection: { name: "Test", baseUrl: "https://engine.example", token: "", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 }, connectionState: "offline", connectionInfo: "" }));
vi.mock("../src/stores/store", () => ({ useStore: { getState: () => state, setState: (patch: object) => Object.assign(state, patch) } }));
import { cancelWorkstationCheck, connectWorkstation } from "../src/settings/connection-actions";
import { ComfyUIClient } from "../src/comfyui/client";
const response = (url: string) => new Response(JSON.stringify(url.endsWith("/queue") ? { queue_pending: [], queue_running: [] } : { system: { comfyui_version: "test" } }));
beforeEach(() => { vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue(); state.connectionState = "offline"; state.connectionInfo = ""; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("saves connection fields and checks the standard engine endpoints without requiring the popover to remain open", async () => {
  const fetcher = vi.fn(async (url: string) => response(url)); vi.stubGlobal("fetch", fetcher);
  await connectWorkstation({ ...state.connection, baseUrl: "https://ready.example/comfy", name: "My engine" });
  expect(state.connection.name).toBe("My engine"); expect(state.connectionState).toBe("connected");
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://ready.example/comfy/system_stats", "https://ready.example/comfy/queue"]);
});

it("keeps HTTP usable if the optional live channel cannot connect", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url)));
  vi.mocked(ComfyUIClient.prototype.connect).mockRejectedValueOnce(new Error("No WebSocket"));
  await connectWorkstation({ ...state.connection, baseUrl: "https://http.example" });
  expect(state.connectionState).toBe("connected"); expect(state.connectionInfo).toContain("查询进度");
});

it("does not report a non-ComfyUI or failed endpoint as connected", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  await connectWorkstation({ ...state.connection, baseUrl: "https://other.example" });
  expect(state.connectionState).toBe("offline"); expect(state.connectionInfo).toContain("有效的 ComfyUI");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network down"); }));
  await connectWorkstation({ ...state.connection, baseUrl: "https://unavailable.example" });
  expect(state.connectionState).toBe("offline"); expect(state.connectionInfo).toContain("连接失败");
});

it("prevents a slower previous address from replacing the newest result", async () => {
  const deferred: (() => void)[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith("https://slow.example")
    ? new Promise<Response>(resolve => deferred.push(() => resolve(response(url)))) : Promise.resolve(response(url))));
  const slow = connectWorkstation({ ...state.connection, baseUrl: "https://slow.example" });
  await connectWorkstation({ ...state.connection, baseUrl: "https://new.example" });
  deferred.forEach(resolve => resolve()); await slow;
  expect(state.connection.baseUrl).toBe("https://new.example"); expect(state.connectionState).toBe("connected");
});

const nativeConnection = { name: "Native", baseUrl: "https://www.runninghub.cn/proxy", token: "native-test-key", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 };
const account = (apiType: string) => new Response(JSON.stringify({ code: 0, data: { apiType, remainCoins: "3.500", remainMoney: "2.10", currency: "CNY" } }), { headers: { "Content-Type": "application/json" } });

it("validates NORMAL before native engine checks and reports the returned balances without adding a timeout", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetcher = vi.fn(async (url: string) => url.endsWith("/account") ? account("NORMAL") : response(url));
  vi.stubGlobal("fetch", fetcher);
  await connectWorkstation(nativeConnection);
  expect(fetcher.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
    "/api/runninghub-comfy/account", "/api/runninghub-comfy/system_stats", "/api/runninghub-comfy/queue",
  ]);
  expect(state.connectionState).toBe("connected");
  expect(state.connectionInfo).toContain("NORMAL（RH 币 / 钱包）已确认");
  expect(state.connectionInfo).toContain("RH 币余额 3.500");
  expect(state.connectionInfo).toContain("钱包余额 2.10 CNY");
  expect(timeout).not.toHaveBeenCalled();
  expect(vi.mocked(ComfyUIClient.prototype.connect).mock.calls[0][0]).toBeInstanceOf(AbortSignal);
});

it("does not probe the native engine when the account reports an unsupported billing type", async () => {
  const fetcher = vi.fn(async () => account("SHARED")); vi.stubGlobal("fetch", fetcher);
  await connectWorkstation(nativeConnection);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.connectionState).toBe("offline");
  expect(state.connectionInfo).toContain("不是 NORMAL");
  expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
});

it("reports an invalid native address safely without saving or requesting its key-bearing URL", async () => {
  const previous = state.connection;
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(connectWorkstation({ ...nativeConnection, baseUrl: "https://www.runninghub.cn/proxy/private-fixture?invalid=1", token: "" })).resolves.toBeUndefined();
  expect(state.connection).toBe(previous);
  expect(state.connectionState).toBe("offline");
  expect(state.connectionInfo).not.toContain("private-fixture");
  expect(fetcher).not.toHaveBeenCalled();
});

it("lets the user cancel a pending native live-channel check without a timer", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/account") ? account("NORMAL") : response(url)));
  let socketSignal: AbortSignal | undefined;
  vi.mocked(ComfyUIClient.prototype.connect).mockImplementationOnce(async signal => {
    socketSignal = signal;
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  const checking = connectWorkstation(nativeConnection);
  await vi.waitFor(() => expect(socketSignal).toBeDefined());
  cancelWorkstationCheck(); await checking;
  expect(socketSignal!.aborted).toBe(true);
  expect(state.connectionState).toBe("offline");
  expect(state.connectionInfo).toBe("连接检测已取消。");
});
