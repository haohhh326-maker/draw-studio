import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/comfyui/client";
import { RunningHubClient } from "../src/runninghub/client";
import type { Connection } from "../src/types";

const nativeFetch = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeFetch }));

const connection: Connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token: "fixture-private-api-key", timeoutMinutes: 2 };
const signedUrl = "https://cdn.example/result.png?signature=private-output-signature&credential=a%2Fb%2Bc";
const file = { filename: "result.png", url: signedUrl, type: "output" as const };
const makeClient = () => new RunningHubClient(connection, "download-diagnostics");
const failure = (error: unknown, status: number) => new Response(JSON.stringify({ error, extra: signedUrl }), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); nativeFetch.mockReset(); vi.useRealTimers(); });

describe("RunningHub result download diagnostics", () => {
  it.each([
    [400, "结果下载仅支持公开 HTTPS 地址。"],
    [400, "结果下载地址不允许访问本地网络。"],
    [400, "结果下载地址不允许访问本地或保留网络。"],
    [403, "RunningHub 代理仅允许画布同源访问。"],
    [502, "RunningHub 官方结果域名解析暂时失败，请稍后恢复原任务。"],
  ] as const)("reports the fixed local proxy reason for HTTP %s: %s", async (status, reason) => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => failure(reason, status));
    vi.stubGlobal("fetch", fetcher);

    const error = await makeClient().getOutput(file).catch(value => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, body: reason });
    expect(error.message).toContain("本地下载代理：" + reason);
    expect(error.message).toContain("可恢复查询原任务");
    expect(JSON.stringify(error)).not.toContain("private-output-signature");
    expect(JSON.stringify(error)).not.toContain(connection.token);
    const target = new URL(String(fetcher.mock.calls[0][0]));
    expect(target.origin).toBe("http://localhost:5173");
    expect(target.pathname).toBe("/api/runninghub-result");
    expect(target.searchParams.get("url")).toBe(signedUrl);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(status === 502 ? 3 : 1);
  });

  it("does not expose unknown, appended, malformed or wrong-status proxy bodies", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const known = "结果下载仅支持公开 HTTPS 地址。";
    const bodies = [
      failure(signedUrl + " " + connection.token, 400),
      failure(known + signedUrl, 400),
      new Response(known + signedUrl, { status: 400 }),
      failure(known, 403),
    ];
    const fetcher = vi.fn(async () => bodies.shift()!);
    vi.stubGlobal("fetch", fetcher);

    for (let index = 0; index < 4; index++) {
      const error = await makeClient().getOutput(file).catch(value => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error.body).toBeUndefined();
      expect(error.message).not.toContain("本地下载代理");
      expect(error.message).not.toContain("private-output-signature");
      expect(error.message).not.toContain(connection.token);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["node", "tauri"])("does not trust even a matching proxy message from a direct %s storage response", async environment => {
    if (environment === "tauri") {
      vi.stubGlobal("isTauri", true);
      vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    }
    const response = failure("结果下载仅支持公开 HTTPS 地址。", 400);
    const readBody = vi.spyOn(response, "json");
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    nativeFetch.mockResolvedValue(response);

    const error = await makeClient().getOutput(file).catch(value => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400 });
    expect(error.body).toBeUndefined();
    expect(error.message).not.toContain("本地下载代理");
    expect(readBody).not.toHaveBeenCalled();
    const transport = environment === "tauri" ? nativeFetch : fetcher;
    expect(transport).toHaveBeenCalledExactlyOnceWith(signedUrl, expect.objectContaining({ method: "GET", credentials: "omit" }));
    expect(error.message).not.toContain("private-output-signature");
  });

  it("retries a transient DNS proxy failure using the exact same signed result GET", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1
      ? failure("RunningHub 官方结果域名解析暂时失败，请稍后恢复原任务。", 502)
      : new Response("original-media", { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    const pending = makeClient().getOutput(file);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(await (await pending).text()).toBe("original-media");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(call[0]).searchParams.get("url")).toBe(signedUrl);
      expect(call[1]).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
      expect(call[1].headers).toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an interrupted response body without resubmitting a workflow", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error(signedUrl)); } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(new Response("complete-media"));
    vi.stubGlobal("fetch", fetcher);
    const pending = makeClient().getOutput(file);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(await (await pending).text()).toBe("complete-media");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => call[0] === signedUrl && call[1].method === "GET")).toBe(true);
  });

  it("cancels a download backoff immediately and does not start another request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const pending = makeClient().getOutput(file, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a long transfer alive until the caller explicitly cancels", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const pending = makeClient().getOutput(file, abort.signal);
    await vi.advanceTimersByTimeAsync(301000);
    expect(fetcher.mock.calls[0][1].signal).toBe(abort.signal);
    expect(abort.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    finish(new Response("original"));
    expect(await (await pending).text()).toBe("original");
  });

  it("resumes a truncated large result from its last byte with the same object validator", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("first-"));
      else controller.error(new TypeError("connection reset"));
    } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: {
      "content-type": "video/mp4", "content-length": "12", etag: '"same-video"',
    } })).mockResolvedValueOnce(new Response("second", { status: 206, headers: {
      "content-type": "video/mp4", "content-range": "bytes 6-11/12", "content-length": "6", etag: '"same-video"',
    } }));
    vi.stubGlobal("fetch", fetcher);
    const events: number[] = [];
    const pending = makeClient().getOutput(file, undefined, received => events.push(received));
    await vi.advanceTimersByTimeAsync(400);
    const result = await pending;
    expect(await result.text()).toBe("first-second");
    expect(result.type).toBe("video/mp4");
    expect(fetcher.mock.calls[1][1].headers).toEqual({ Range: "bytes=6-", "If-Range": '"same-video"' });
    expect(events.at(-1)).toBe(12);
  });

  it("replaces partial bytes when the storage server declines a range request", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("old"));
      else controller.error(new TypeError("connection reset"));
    } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: { etag: '"old"', "content-length": "20" } }))
      .mockResolvedValueOnce(new Response("new-complete-video", { headers: { etag: '"new"', "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    const pending = makeClient().getOutput(file);
    await vi.advanceTimersByTimeAsync(400);
    expect(await (await pending).text()).toBe("new-complete-video");
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ Range: "bytes=3-" });
  });

  it("discards an inconsistent range instead of appending different video bytes", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("old"));
      else controller.error(new TypeError("connection reset"));
    } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: { etag: '"old"', "content-length": "6" } }))
      .mockResolvedValueOnce(new Response("bad", { status: 206, headers: { "content-range": "bytes 3-5/6", etag: '"new"' } }))
      .mockResolvedValueOnce(new Response("new-complete", { headers: { etag: '"new"' } }));
    vi.stubGlobal("fetch", fetcher);
    const pending = makeClient().getOutput(file);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await (await pending).text()).toBe("new-complete");
    expect(fetcher.mock.calls[2][1].headers).toBeUndefined();
  });

  it("rejects a cleanly closed but truncated response and retries the original download", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("short", { headers: { "content-length": "16" } }))
      .mockResolvedValueOnce(new Response("complete-content", { headers: { "content-length": "16" } }));
    vi.stubGlobal("fetch", fetcher);
    const pending = makeClient().getOutput(file);
    await vi.advanceTimersByTimeAsync(400);
    expect(await (await pending).text()).toBe("complete-content");
    expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
  });

  it("retains a fully received object when the connection fails after its final byte", async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("complete"));
      else controller.error(new TypeError("connection reset after final byte"));
    } });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-length": "8", etag: '"complete"' } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await makeClient().getOutput(file)).text()).toBe("complete");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled response body immediately without a local time limit", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel: cancelled });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const pending = makeClient().getOutput(file, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
