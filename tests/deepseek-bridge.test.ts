import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { deepSeekRequestAllowed, deepSeekViewRequestAllowed, deepSeekSessionExportAllowed } from "../scripts/deepseek-bridge-plugin";
import { DeepSeekBrowserService, deepSeekWebPrompt, sameDeepSeekConversation, validateDeepSeekMessages, validateDeepSeekViewInput, validateWebOptimizationRequest } from "../scripts/deepseek-browser-service";

function request(host: string, origin?: string, address = "127.0.0.1", site?: string) {
  return { headers: { host, origin, "sec-fetch-site": site }, socket: { remoteAddress: address } } as Parameters<typeof deepSeekRequestAllowed>[0];
}

describe("DeepSeek browser bridge", () => {
  it("allows the local canvas and Tauri shell without exposing the browser session to other sites", () => {
    expect(deepSeekRequestAllowed(request("127.0.0.1:1420", "http://127.0.0.1:1420"))).toBe(true);
    expect(deepSeekRequestAllowed(request("127.0.0.1:1420", "tauri://localhost", "127.0.0.1", "cross-site"))).toBe(true);
    expect(deepSeekRequestAllowed(request("127.0.0.1:1420", "https://unrelated.example"))).toBe(false);
    expect(deepSeekRequestAllowed(request("public.example", undefined))).toBe(false);
    expect(deepSeekRequestAllowed(request("127.0.0.1:1420", undefined, "192.0.2.2"))).toBe(false);
    expect(deepSeekViewRequestAllowed(request("127.0.0.1:1420", "http://127.0.0.1:1420"))).toBe(true);
    expect(deepSeekViewRequestAllowed(request("127.0.0.1:1420", "tauri://localhost", "127.0.0.1", "cross-site"))).toBe(true);
    expect(deepSeekViewRequestAllowed(request("127.0.0.1:1420"))).toBe(false);
    expect(deepSeekViewRequestAllowed(request("127.0.0.1:1420", "https://unrelated.example"))).toBe(false);
  });

  it("allows Origin-free same-origin export only with the canvas header on loopback", () => {
    const requestWithHeader = (address: string, site: string, header?: string, origin?: string) => ({
      headers: { host: "127.0.0.1:1420", "sec-fetch-site": site,
        ...(header ? { "x-canvas-session": header } : {}), ...(origin ? { origin } : {}) },
      socket: { remoteAddress: address },
    }) as any;
    expect(deepSeekSessionExportAllowed(requestWithHeader("127.0.0.1", "same-origin", "1"))).toBe(true);
    expect(deepSeekSessionExportAllowed(requestWithHeader("127.0.0.1", "same-origin"))).toBe(false);
    expect(deepSeekSessionExportAllowed(requestWithHeader("127.0.0.1", "cross-site", "1"))).toBe(false);
    expect(deepSeekSessionExportAllowed(requestWithHeader("192.0.2.2", "same-origin", "1"))).toBe(false);
    expect(deepSeekSessionExportAllowed(requestWithHeader("127.0.0.1", "cross-site", "1", "https://evil.example"))).toBe(false);
  });

  it("keeps rule and input boundaries in the message sent to the visible chat", () => {
    const messages = validateDeepSeekMessages([
      { role: "system", content: "Preserve references." },
      { role: "user", content: "@参考 1 的人物在街上走。" },
    ]);
    expect(deepSeekWebPrompt(messages)).toContain("【优化规则】\nPreserve references.");
    expect(deepSeekWebPrompt(messages)).toContain("【待优化内容】\n@参考 1 的人物在街上走。");
    expect(() => validateDeepSeekMessages([{ role: "tool", content: "bad" }])).toThrow();
  });

  it("accepts rule files as attachments and leaves the visible chat message concise", () => {
    const request = validateWebOptimizationRequest({
      prompt: "请根据附件规则优化这段提示词：街头人像。",
      attachments: [
        { name: "规则.md", mimeType: "text/markdown", content: "# 保留人物设定" },
        { name: "模板.txt", mimeType: "text/plain", content: "输出一段提示词" },
      ],
    });
    expect(request.prompt).not.toContain(request.attachments[0].content);
    expect(request.attachments.map(file => file.name)).toEqual(["规则.md", "模板.txt"]);
    expect(() => validateWebOptimizationRequest({ prompt: "ok", attachments: [{ name: "../secret", mimeType: "text/plain", content: "x" }] })).toThrow();
  });

  it("distinguishes the saved canvas thread from another visible conversation", () => {
    const saved = "https://chat.deepseek.com/a/chat/s/canvas-owned";
    expect(sameDeepSeekConversation(saved, saved + "?source=history")).toBe(true);
    expect(sameDeepSeekConversation("https://chat.deepseek.com/a/chat/s/unrelated", saved)).toBe(false);
    expect(sameDeepSeekConversation("https://chat.deepseek.com/", saved)).toBe(false);
  });

  it("shows and controls the existing DeepSeek page without opening another window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-view-"));
    try {
      const service = new DeepSeekBrowserService(root);
      const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const page = {
        screenshot: vi.fn(async () => image),
        mouse: { click: vi.fn(async () => {}), move: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
        keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
      };
      const ensurePage = vi.fn(async () => page);
      Object.defineProperty(service, "ensurePage", { value: ensurePage });
      expect(await service.viewFrame()).toBe(image);
      await service.viewInput({ type: "click", x: 120, y: 75 });
      await service.viewInput({ type: "wheel", x: 120, y: 75, deltaX: 0, deltaY: 260 });
      await service.viewInput({ type: "key", key: "Control+A" });
      await service.viewInput({ type: "text", text: "中文提示词" });
      expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "jpeg", scale: "css" }));
      expect(page.mouse.click).toHaveBeenCalledWith(120, 75, { button: "left" });
      expect(page.mouse.move).toHaveBeenCalledWith(120, 75);
      expect(page.mouse.wheel).toHaveBeenCalledWith(0, 260);
      expect(page.keyboard.press).toHaveBeenCalledWith("Control+A");
      expect(page.keyboard.insertText).toHaveBeenCalledWith("中文提示词");
      expect(ensurePage).toHaveBeenCalledTimes(5);
      expect(() => validateDeepSeekViewInput({ type: "click", x: -1, y: 0 })).toThrow();
      expect(() => validateDeepSeekViewInput({ type: "key", key: "Enter\nmalicious" })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("shows an OAuth popup and returns to the chat page after it closes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-popup-"));
    try {
      const service = new DeepSeekBrowserService(root);
      let popupClosed = false;
      const chatImage = Buffer.from("chat"), popupImage = Buffer.from("popup");
      const chat = { isClosed: () => false, screenshot: vi.fn(async () => chatImage), opener: vi.fn(async () => null),
        mouse: { click: vi.fn(async () => {}) } };
      const popup = { isClosed: () => popupClosed, screenshot: vi.fn(async () => popupImage), opener: vi.fn(async () => chat),
        mouse: { click: vi.fn(async () => {}) } };
      Object.defineProperty(service, "ensurePage", { value: async () => chat });
      Object.defineProperty(service, "context", { value: { pages: () => [chat, popup] } });
      expect(await service.viewFrame()).toBe(popupImage);
      await service.viewInput({ type: "click", x: 1, y: 2 });
      expect(popup.mouse.click).toHaveBeenCalledOnce();
      popupClosed = true;
      expect(await service.viewFrame()).toBe(chatImage);
      await service.viewInput({ type: "click", x: 3, y: 4 });
      expect(chat.mouse.click).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("streams an attachment into the existing chat input and removes the temporary copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-view-upload-"));
    try {
      const service = new DeepSeekBrowserService(root);
      let temporary = "";
      const setInputFiles = vi.fn(async (filePath: string) => {
        temporary = filePath;
        expect(await readFile(filePath, "utf8")).toBe("image-data");
      });
      const page = { url: () => "https://chat.deepseek.com/", locator: () => ({ first: () => ({ count: async () => 1, setInputFiles }) }) };
      Object.defineProperty(service, "activeViewPage", { value: async () => page });
      await service.viewUpload("reference.png", "image/png", Readable.from([Buffer.from("image-data")]));
      expect(setInputFiles).toHaveBeenCalledOnce();
      await expect(readFile(temporary)).rejects.toThrow();
      await expect(service.viewUpload("../secret.png", "image/png", Readable.from([]))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uploads in-memory rule files before sending only the short request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-upload-"));
    try {
      const service = new DeepSeekBrowserService(root);
      let draft = "";
      const events: string[] = [];
      const setInputFiles = vi.fn(async () => { events.push("upload"); });
      const composer = {
        filter: () => composer,
        first: () => composer,
        inputValue: async () => draft,
        fill: async (value: string) => { draft = value; events.push(`fill:${value}`); },
        press: async () => { draft = ""; events.push("send"); },
      };
      const fileInput = { first: () => fileInput, count: async () => 1, setInputFiles };
      const page = {
        url: () => "https://chat.deepseek.com/",
        isClosed: () => false,
        locator: (selector: string) => selector.startsWith("textarea") ? composer
          : selector.startsWith("input[type") ? fileInput : { count: async () => 0 },
        evaluate: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
          .mockResolvedValueOnce({ ready: true, found: 1, busy: false, missingArea: false, error: "" })
          .mockResolvedValueOnce({ count: 1, text: "完成", idle: true, missingButton: false, alerts: [], url: "https://chat.deepseek.com/" }),
      };
      Object.defineProperty(service, "ensurePage", { value: async () => page });
      Object.defineProperty(service, "session", { value: async () => ({ status: "connected" }) });
      const request = { prompt: "优化街头人像。", attachments: [{ name: "规则.md", mimeType: "text/markdown" as const, content: "保留人物设定" }] };
      const result = await service.complete(request);
      expect(result.choices[0].message.content).toBe("完成");
      expect(events).toEqual(["upload", "fill:优化街头人像。", "send"]);
      expect(setInputFiles).toHaveBeenCalledWith([{ name: "规则.md", mimeType: "text/markdown", buffer: Buffer.from("保留人物设定") }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts a completed reply after DeepSeek remounts older chat messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-remount-"));
    try {
      const service = new DeepSeekBrowserService(root);
      let draft = "";
      const composer = {
        filter: () => composer,
        first: () => composer,
        inputValue: async () => draft,
        fill: async (value: string) => { draft = value; },
        press: async () => { draft = ""; },
      };
      const assistants = { count: async () => 2, last: () => ({ innerText: async () => "Previous answer" }) };
      const page = {
        url: () => "https://chat.deepseek.com/",
        isClosed: () => false,
        locator: (selector: string) => selector.startsWith("textarea") ? composer : assistants,
        evaluate: vi.fn().mockResolvedValueOnce(true)
          .mockResolvedValueOnce({ count: 1, text: "Previous answer", idle: false, missingButton: false, alerts: [], url: "https://chat.deepseek.com/" })
          .mockResolvedValueOnce({ count: 2, text: "New optimized prompt", idle: true, missingButton: false, alerts: [], url: "https://chat.deepseek.com/" }),
      };
      Object.defineProperty(service, "ensurePage", { value: async () => page });
      Object.defineProperty(service, "session", { value: async () => ({ status: "connected" }) });
      const result = await service.complete({ prompt: "Optimize the current prompt", attachments: [] });
      expect(result.choices[0].message.content).toBe("New optimized prompt");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns to the canvas thread, or a fresh chat when none has been saved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-thread-"));
    try {
      const service = new DeepSeekBrowserService(root);
      const saved = "https://chat.deepseek.com/a/chat/s/canvas-owned";
      let currentUrl = "https://chat.deepseek.com/a/chat/s/unrelated";
      const goto = vi.fn(async (url: string) => { currentUrl = url; });
      const page = { url: () => currentUrl, goto, bringToFront: async () => {} };
      Object.defineProperty(service, "ensurePage", { value: async () => page });
      Object.defineProperty(service, "session", { value: async () => ({ status: "login-required" }) });
      const run = (service as unknown as { run: (request: { prompt: string; attachments: [] }) => Promise<unknown> }).run.bind(service);
      Object.defineProperty(service, "threadUrl", { value: saved, writable: true });
      await expect(run({ prompt: "first", attachments: [] })).rejects.toMatchObject({ status: 401 });
      expect(goto).toHaveBeenLastCalledWith(saved, { waitUntil: "domcontentloaded" });
      Object.defineProperty(service, "threadUrl", { value: undefined, writable: true });
      currentUrl = "https://chat.deepseek.com/a/chat/s/unrelated";
      await expect(run({ prompt: "second", attachments: [] })).rejects.toMatchObject({ status: 401 });
      expect(goto).toHaveBeenLastCalledWith("https://chat.deepseek.com/", { waitUntil: "domcontentloaded" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("releases the serialized queue and closes its page when an operation is cancelled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-deepseek-cancel-"));
    try {
      const service = new DeepSeekBrowserService(root);
      const close = vi.fn(async () => {});
      const result = { model: "deepseek-web" as const, choices: [{ finish_reason: "stop" as const, message: { role: "assistant" as const, content: "done" } }] };
      let started = 0;
      Object.defineProperty(service, "run", { value: vi.fn((_messages, _signal, operation: { page?: unknown }) => {
        started++;
        if (started === 1) {
          operation.page = { close };
          return new Promise(() => {});
        }
        return Promise.resolve(result);
      }) });
      const controller = new AbortController();
      const first = service.complete({ prompt: "first", attachments: [] }, controller.signal);
      await vi.waitFor(() => expect(started).toBe(1));
      controller.abort();
      await expect(first).rejects.toMatchObject({ status: 499 });
      await expect(service.complete({ prompt: "second", attachments: [] })).resolves.toEqual(result);
      expect(started).toBe(2);
      expect(close).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
