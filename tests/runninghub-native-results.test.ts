import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIClient } from "../src/comfyui/client";
import { defaultConnection } from "../src/workflow/catalog";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
const connection = { ...defaultConnection, baseUrl: "https://www.runninghub.cn/proxy", token: "private-key" };
const file = { filename: "result.mp4", subfolder: "job", type: "output" as const };
const context = { promptId: "2114862033085362177", onlyOutput: true };
const signed = "https://rh-images.xiaoyaoyou.com/actual.mp4?signature=temporary";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:1420" } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native result address recovery", () => {
  it("recovers one known output from its original task and downloads without credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: "upstream HTTP 404" }, 502))
      .mockResolvedValueOnce(json({ code: 0, data: [{ fileUrl: signed, nodeId: "92" }] }))
      .mockResolvedValueOnce(new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    expect(await (await new ComfyUIClient(connection).getOutput(file, abort.signal, context)).text()).toBe("video");
    expect(String(fetcher.mock.calls[1][0])).toContain("/task-outputs/" + context.promptId);
    expect(fetcher.mock.calls[1][1].signal).toBe(abort.signal);
    expect(String(fetcher.mock.calls[2][0])).toContain("/api/runninghub-result?url=");
    expect(fetcher.mock.calls[2][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", signal: abort.signal });
    expect(fetcher.mock.calls[2][1].headers).toBeUndefined();
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("/prompt");
  });
  it.each([
    [{ fileUrl: "https://evil.example/video.mp4" }],
    [{ fileUrl: "https://rh-images.xiaoyaoyou.com/video.mp4?key=private-key" }],
    [{ fileUrl: signed }, { fileUrl: "https://rh-images.xiaoyaoyou.com/other.mp4" }],
  ])("never substitutes an unsafe or ambiguous result", async data => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 502)).mockResolvedValueOnce(json({ code: 0, data }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).getOutput(file, undefined, context)).rejects.toThrow("502");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not query a task when normal /view already returns video", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await new ComfyUIClient(connection).getOutput(file, undefined, context)).text()).toBe("video");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
