import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ native: true, invoke: vi.fn() }));
vi.mock("../src/services/native-webview-bridge", () => ({
  hasNativeWebview: () => bridge.native,
  nativeWebviewInvoke: bridge.invoke,
}));

import { primeNativeServiceAuth, syncNativeServiceAuth } from "../src/services/service-auth";

const auth = (domain: string, origin: string) => ({
  cookies: [{ name: "session", value: "private-value", domain, path: "/" }],
  origins: [{ origin, localStorage: [{ name: "session", value: "private-storage" }] }],
});

beforeEach(() => { bridge.native = true; bridge.invoke.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("native service login sync", () => {
  it("primes a native Muse view with anonymous cookies from the authenticated backend profile only once", async () => {
    const previous = { ...auth(".muse.ai", "https://muse.ai"), cookies: [
      { name: "hatch_sess", value: "private-value", domain: ".muse.ai", path: "/" },
    ] };
    bridge.invoke.mockImplementation(async (command: string) => command === "export_service_webview_auth"
      ? { cookies: [{ name: "theme", value: "dark", domain: "muse.ai", path: "/" }], origins: [] } : undefined);
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/session")
      ? { status: "connected" } : previous), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await Promise.all([primeNativeServiceAuth("muse"), primeNativeServiceAuth("muse")]);
    await primeNativeServiceAuth("muse");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bridge.invoke).toHaveBeenCalledWith("import_service_webview_auth", "muse", { snapshot: previous });
  });

  it("preserves a native DeepSeek account that already has its own login credential", async () => {
    bridge.invoke.mockResolvedValue({ cookies: [{ name: "ds_session_id", value: "other-account", domain: "chat.deepseek.com", path: "/" }], origins: [] });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await primeNativeServiceAuth("deepseek");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("imports the latest native DeepSeek session before optimization", async () => {
    const current = { ...auth(".deepseek.com", "https://chat.deepseek.com"), cookies: [
      { name: "ds_session_id", value: "private-value", domain: ".deepseek.com", path: "/" },
    ] };
    bridge.invoke.mockResolvedValue(current);
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/export")
      ? { cookies: [], origins: [] } : {}), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await syncNativeServiceAuth("deepseek");
    const [url, options] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain("/__canvas/deepseek/session/import");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual(current);
  });

  it("skips reimport for a concurrent Muse task when both browsers share the same login", async () => {
    const current = { cookies: [{ name: "hatch_sess", value: "same-login", domain: "muse.ai", path: "/" }], origins: [] };
    bridge.invoke.mockResolvedValue(current);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(current), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await syncNativeServiceAuth("muse");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/api/muse/session/export");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ "X-Canvas-Session": "1" });
  });

  it("keeps the backend profile when the native view has not been opened", async () => {
    bridge.invoke.mockResolvedValue(null);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await syncNativeServiceAuth("muse");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
