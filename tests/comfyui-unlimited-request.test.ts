import { afterEach, expect, it, vi } from "vitest";
import { ComfyUIClient } from "../src/comfyui/client";
import { defaultConnection } from "../src/workflow/catalog";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps an unlimited import request waiting until it succeeds, without creating a timer", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout"), controller = new AbortController();
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
    expect(init.signal).toBe(controller.signal);
    return new Promise<Response>(resolve => { finish = resolve; });
  }));
  const client = new ComfyUIClient({ ...defaultConnection, baseUrl: "https://workstation.example" });
  const pending = client.request("/object_info", { signal: controller.signal }, null);
  let completed = false; void pending.then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(completed).toBe(false); expect(timeout).not.toHaveBeenCalled();
  finish(Response.json({ CustomNode: {} }));
  expect(await (await pending).json()).toEqual({ CustomNode: {} });
});

it("still lets the user cancel a request that has no time limit", async () => {
  const controller = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })));
  const client = new ComfyUIClient({ ...defaultConnection, baseUrl: "https://workstation.example" });
  const pending = client.request("/object_info", { signal: controller.signal }, null);
  const rejected = expect(pending).rejects.toThrow("User stopped waiting");
  controller.abort(new Error("User stopped waiting")); await rejected;
  expect(timeout).not.toHaveBeenCalled();
});
