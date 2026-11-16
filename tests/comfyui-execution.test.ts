import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ComfyUIClient, ExecutionError } from "../src/comfyui/client";
import { clearCommunicationLog, communicationSnapshot } from "../src/comfyui/diagnostics";
import { defaultConnection } from "../src/workflow/catalog";

const connection = { ...defaultConnection, baseUrl: "https://compute.example/canvas/comfy", token: "private-token" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const queue = (running: string[] = [], pending: string[] = []) => ({ queue_running: running.map(id => [0, id]), queue_pending: pending.map(id => [1, id]) });
beforeEach(clearCommunicationLog);
afterEach(() => vi.unstubAllGlobals());

describe("standard workstation execution controls", () => {
  it("checks current queue and sends the standard interrupt through the same authenticated proxy", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/compute\.example\/canvas\/comfy\//);
      expect(init.headers).toMatchObject({ Authorization: "Bearer private-token" });
      if (url.endsWith("/queue")) return json(queue(["current"]));
      expect(url).toContain("/interrupt"); expect(init.method).toBe("POST"); expect(JSON.parse(init.body as string)).toEqual({});
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    await new ComfyUIClient(connection).interruptCurrent();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(communicationSnapshot().map(entry => entry.route)).toEqual(["/queue", "/queue", "/interrupt", "/interrupt"]);
  });

  it("does not send interrupt when the current queue has no executing task", async () => {
    const fetcher = vi.fn(async () => json(queue([], ["pending"]))); vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).interruptCurrent()).rejects.toThrow("没有正在执行");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requests unload and memory cleanup only after a freshly empty queue", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/queue")) return json(queue());
      expect(url).toBe(connection.baseUrl + "/free"); expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ unload_models: true, free_memory: true });
      return new Response(null, { status: 200 });
    }); vi.stubGlobal("fetch", fetcher);
    await new ComfyUIClient(connection).freeMemory(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([queue(["running"]), queue([], ["pending"])])("does not clean memory while running or pending tasks exist", async state => {
    const fetcher = vi.fn(async () => json(state)); vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).freeMemory()).rejects.toThrow("队列清空"); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["interruptCurrent", "freeMemory"] as const)("does not report %s as successful after an HTTP rejection", async method => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? json(method === "interruptCurrent" ? queue(["task"]) : queue()) : new Response("private server error", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection)[method]()).rejects.toBeInstanceOf(ApiError);
    expect(communicationSnapshot().at(-1)).toMatchObject({ stage: "response", status: 503 });
    expect(JSON.stringify(communicationSnapshot())).not.toContain("private server error");
  });

  it("deletes only the selected pending task and ends its waiter after queue/history confirmation", async () => {
    let deleted = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/queue") && init.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ delete: ["remove-verified"] }); deleted = true; return new Response(null);
      }
      if (url.endsWith("/queue")) return json(queue(["other-running"], deleted ? ["keep-pending"] : ["remove-verified", "keep-pending"]));
      expect(url).toContain("/history/remove-verified"); return json({});
    }); vi.stubGlobal("fetch", fetcher);
    const control = new ComfyUIClient(connection), waiter = new ComfyUIClient(connection);
    await control.deleteQueuedPrompt("remove-verified");
    const before = fetcher.mock.calls.length;
    const error = await waiter.waitForCompletion("remove-verified", vi.fn(), new AbortController().signal).catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError); expect(error.status).toBe("cancelled"); expect(fetcher).toHaveBeenCalledTimes(before);
    expect(fetcher.mock.calls.some(([url]) => url.includes("/interrupt"))).toBe(false);
  });

  it.each(["running", "missing"])("does not post queue deletion when the selected task is %s", async state => {
    const fetcher = vi.fn(async () => json(state === "running" ? queue(["cannot-delete"]) : queue())); vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).deleteQueuedPrompt("cannot-delete")).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["still-pending", "started", "finished"])("rejects queue deletion race %s without global interruption", async state => {
    let deleted = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/queue") && init.method === "POST") { deleted = true; return new Response(null); }
      if (url.endsWith("/queue")) return json(!deleted || state === "still-pending" ? queue([], ["race-" + state]) : state === "started" ? queue(["race-" + state]) : queue());
      if (url.includes("/history/")) return json({ ["race-" + state]: { status: { completed: true }, outputs: {} } });
      throw new Error("unexpected endpoint");
    }); vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).deleteQueuedPrompt("race-" + state)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => url.includes("/interrupt"))).toBe(false);
  });

  it("does not reuse a confirmed deletion receipt for a newly submitted identical prompt ID", async () => {
    let deleted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/prompt")) return json({ prompt_id: "reused-id" });
      if (url.endsWith("/queue") && init.method === "POST") { deleted = true; return new Response(null); }
      if (url.endsWith("/queue")) return json(queue([], deleted ? [] : ["reused-id"]));
      return json({});
    }));
    const client = new ComfyUIClient(connection); await client.deleteQueuedPrompt("reused-id"); await client.queuePrompt({}, "request-reused");
    vi.stubGlobal("fetch", vi.fn(async () => json({ "reused-id": { status: { completed: true }, outputs: {} } })));
    await expect(client.waitForCompletion("reused-id", vi.fn(), new AbortController().signal)).resolves.toMatchObject({ status: { completed: true } });
  });

  it("recognizes actual interrupted history in authenticated HTTP polling rather than treating it as failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ "http-interrupted": { outputs: {}, status: { status_str: "error", messages: [["execution_interrupted", { prompt_id: "http-interrupted", exception_message: "private text" }]] } } })));
    const error = await new ComfyUIClient(connection).waitForCompletion("http-interrupted", vi.fn(), new AbortController().signal).catch(reason => reason);
    expect(error).toBeInstanceOf(ExecutionError); expect(error.status).toBe("cancelled");
    expect(JSON.stringify(communicationSnapshot())).not.toContain("private text");
  });
});
