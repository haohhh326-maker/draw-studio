import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { attachMusePageSignals, type MusePageSignals } from "../scripts/muse-page-signals";

function eventPage() {
  const page = new EventEmitter() as EventEmitter & { isClosed(): boolean; evaluate: ReturnType<typeof vi.fn> };
  page.isClosed = () => false;
  page.evaluate = vi.fn();
  return page;
}

describe("Muse page signal waits", () => {
  let page: ReturnType<typeof eventPage>;
  let signals: MusePageSignals;
  beforeEach(async () => {
    vi.useFakeTimers();
    page = eventPage();
    signals = await attachMusePageSignals(page as unknown as Page);
  });
  afterEach(async () => { await signals.dispose(); vi.useRealTimers(); });

  it("retains the 1500ms fallback for pages without DOM binding support", async () => {
    let finished = false;
    const waiting = signals.wait(signals.revision()).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(finished).toBe(true);
    expect(signals.revision()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("keeps an event received between reading and waiting from being lost", async () => {
    const beforeRead = signals.revision();
    page.emit("requestfinished");
    await signals.wait(beforeRead);
    expect(signals.revision()).toBe(beforeRead + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["requestfinished", "framenavigated", "close"])("wakes a pending observation on %s", async event => {
    const beforeRead = signals.revision();
    const waiting = signals.wait(beforeRead);
    page.emit(event);
    await waiting;
    expect(signals.revision()).toBe(beforeRead + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes on opaque WebSocket frames without reading their payload", async () => {
    const socket = new EventEmitter();
    page.emit("websocket", socket);
    const beforeRead = signals.revision();
    const waiting = signals.wait(beforeRead);
    const frame = Object.defineProperty({}, "payload", { get() { throw new Error("Encrypted payload must remain opaque"); } });
    expect(() => socket.emit("framereceived", frame)).not.toThrow();
    await waiting;
    expect(signals.revision()).toBe(beforeRead + 1);
    socket.emit("socketerror", "Connection interrupted");
    expect(signals.revision()).toBe(beforeRead + 2);
    socket.emit("close");
    expect(signals.revision()).toBe(beforeRead + 3);
    expect(socket.listenerCount("framereceived")).toBe(0);
    expect(socket.listenerCount("socketerror")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("releases aborted waits and removes their timers", async () => {
    const controller = new AbortController();
    const waiting = signals.wait(signals.revision(), controller.signal);
    controller.abort();
    await waiting;
    await signals.wait(signals.revision(), controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(signals.revision()).toBe(0);
  });

  it("disposes waiters and its own page and socket listeners without removing other listeners", async () => {
    const otherListener = vi.fn();
    page.on("requestfinished", otherListener);
    const socket = new EventEmitter();
    page.emit("websocket", socket);
    const beforeDispose = signals.revision();
    const waiting = signals.wait(beforeDispose);
    await signals.dispose();
    await signals.dispose();
    await waiting;
    await signals.wait(beforeDispose);
    page.emit("requestfinished");
    socket.emit("framereceived", { payload: Buffer.from([0, 255, 19]) });
    expect(otherListener).toHaveBeenCalledTimes(1);
    expect(signals.revision()).toBe(beforeDispose);
    expect(page.listenerCount("requestfinished")).toBe(1);
    expect(page.listenerCount("websocket")).toBe(0);
    expect(page.listenerCount("framenavigated")).toBe(0);
    expect(page.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("framereceived")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Muse DOM page signals", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let signals: MusePageSignals;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  });
  beforeEach(async () => {
    context = await browser.newContext();
    await context.route("**/*", route => new URL(route.request().url()).hostname === "muse-signals.test"
      ? route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><main><section id="assistant">Generating</section><img id="result"><video id="video"></video><form><span id="draft">Draft</span><img id="upload"></form></main>' })
      : route.abort());
    page = await context.newPage();
    await page.goto("https://muse-signals.test/one");
    signals = await attachMusePageSignals(page);
  });
  afterEach(async () => { await signals.dispose(); await context.close(); });
  afterAll(async () => { await browser.close(); });

  async function changed(before: number) {
    await signals.wait(before);
    expect(signals.revision()).toBeGreaterThan(before);
  }

  it("observes transcript insertion, text changes and relevant media attributes", async () => {
    let before = signals.revision();
    await page.evaluate(() => document.querySelector("main")!.append(document.createElement("section")));
    await changed(before);
    before = signals.revision();
    await page.evaluate(() => { document.querySelector("#assistant")!.firstChild!.nodeValue = "Result ready"; });
    await changed(before);
    for (const attribute of ["src", "srcset", "aria-busy"]) {
      before = signals.revision();
      await page.evaluate(name => document.querySelector("#assistant")!.setAttribute(name, "changed"), attribute);
      await changed(before);
    }
  });

  it("ignores composer mutations and unrelated attributes", async () => {
    const before = signals.revision();
    await page.evaluate(async () => {
      document.querySelector("#draft")!.textContent = "Keep my draft";
      document.querySelector("#upload")!.setAttribute("aria-busy", "true");
      document.querySelector("#assistant")!.setAttribute("title", "Hover hint");
      const form = document.createElement("form");
      form.append(document.createElement("img"));
      document.querySelector("main")!.append(form);
      document.querySelector("#upload")!.dispatchEvent(new Event("load"));
      await new Promise<void>(resolve => queueMicrotask(resolve));
    });
    expect(signals.revision()).toBe(before);
  });

  it("observes image and video readiness events without requiring DOM mutations", async () => {
    for (const [selector, event] of [["#result", "load"], ["#video", "loadedmetadata"], ["#video", "loadeddata"], ["#video", "canplay"], ["#video", "error"], ["#video", "emptied"]]) {
      const before = signals.revision();
      await page.evaluate(({ selector, event }) => document.querySelector(selector)!.dispatchEvent(new Event(event)), { selector, event });
      await changed(before);
    }
  });

  it("coalesces one DOM mutation batch into a single wake", async () => {
    const before = signals.revision();
    await page.evaluate(() => {
      const assistant = document.querySelector("#assistant")!;
      assistant.textContent = "Completed";
      assistant.setAttribute("src", "media");
      assistant.setAttribute("srcset", "full-size");
      assistant.setAttribute("aria-busy", "false");
    });
    await changed(before);
    expect(signals.revision()).toBe(before + 1);
  });

  it("installs observers in a new document and removes bindings and init scripts on dispose", async () => {
    await page.goto("https://muse-signals.test/two");
    const before = signals.revision();
    await page.evaluate(() => { document.querySelector("#assistant")!.textContent = "After navigation"; });
    await changed(before);
    await signals.dispose();
    const afterDispose = signals.revision();
    const globals = () => page.evaluate(() => Object.getOwnPropertyNames(window).filter(name => name.startsWith("__drawstudioMuseSignal")));
    expect(await globals()).toEqual([]);
    await page.goto("https://muse-signals.test/three");
    expect(await globals()).toEqual([]);
    await page.evaluate(() => { document.querySelector("#assistant")!.textContent = "Disposed"; });
    expect(signals.revision()).toBe(afterDispose);
  });

  it("uses distinct binding names and disposes each attachment independently", async () => {
    const second = await attachMusePageSignals(page);
    try {
      const names = await page.evaluate(() => Object.getOwnPropertyNames(window).filter(name => name.startsWith("__drawstudioMuseSignal_")));
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      await signals.dispose();
      const beforeFirst = signals.revision();
      const beforeSecond = second.revision();
      await page.evaluate(() => { document.querySelector("#assistant")!.textContent = "Second observer"; });
      await second.wait(beforeSecond);
      expect(second.revision()).toBeGreaterThan(beforeSecond);
      expect(signals.revision()).toBe(beforeFirst);
    } finally { await second.dispose(); }
  });
});
