import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuseBrowserService, museConversationUrl } from "../scripts/muse-browser-service";

const fixtures = vi.hoisted(() => ({ media: vi.fn(), upload: vi.fn(), delivery: vi.fn(), readiness: vi.fn(), activity: vi.fn() }));
vi.mock("../scripts/muse-turn-media", () => ({ readMuseTurnMedia: fixtures.media }));
vi.mock("../scripts/muse-delivery-state", () => ({ readMuseDeliveryState: fixtures.delivery }));
vi.mock("../scripts/muse-send-readiness", () => ({ readMuseSendReadiness: fixtures.readiness }));
vi.mock("../scripts/muse-activity-state", () => ({ readMuseActivity: fixtures.activity }));
vi.mock("../scripts/muse-upload", async original => ({
  ...await original<typeof import("../scripts/muse-upload")>(), uploadMuseReferences: fixtures.upload,
}));

const jobId = "muse-reconnect-001";
const originalUrl = "https://muse.ai/thread/original-001";
const turnAnchor = { promptHash: "a".repeat(64), precedingUserHashes: [] };
const pollingSignals = {
  revision: () => 0,
  wait: () => new Promise<void>(resolve => { setTimeout(resolve, 1500); }),
};
function savedJob(conversationUrl = originalUrl, status = "interrupted") {
  return { id: jobId, kind: "image", hash: "stored-hash", submitted: true, baseline: [], status,
    conversationUrl, turnAnchor, createdAt: 1, recovery: "reconnect" };
}

// No browser process is launched: these fakes model page and context close events.
function browser(initialUrl = "about:blank", closeContextWithLastPage = true) {
  const context = new EventEmitter() as any;
  const pages: any[] = [];
  const events: string[] = [];
  let closed = false;
  context.setDefaultTimeout = vi.fn();
  context.setDefaultNavigationTimeout = vi.fn();
  const addPage = (start: string) => {
    const page = new EventEmitter() as any;
    let url = start, pageClosed = false;
    page.url = () => url;
    page.isClosed = () => pageClosed;
    page.goto = vi.fn(async (next: string) => { url = next; page.emit("framenavigated"); });
    page.bringToFront = vi.fn(async () => {});
    page.evaluate = vi.fn(async () => undefined);
    page.hiddenStopPresent = false;
    page.composer = { count: vi.fn(async () => 1), evaluate: vi.fn(async () => ""), fill: vi.fn(async () => {}) };
    page.send = { count: vi.fn(async () => 1), isEnabled: vi.fn(async () => true), click: vi.fn(async () => {}) };
    const locator: any = { count: vi.fn(async () => 0), allTextContents: vi.fn(async () => []), first: () => page.composer };
    locator.filter = () => locator;
    page.locator = vi.fn((selector: string) => {
      if (selector.includes("hatch-composer-stop-button")) return {
        count: vi.fn(async () => page.hiddenStopPresent ? 1 : 0),
        filter: vi.fn(() => ({ count: vi.fn(async () => 0) })),
      };
      return locator;
    });
    page.getByRole = vi.fn(() => ({ first: () => page.send }));
    page.close = vi.fn(async () => {
      if (pageClosed) return;
      events.push("close-page"); pageClosed = true; page.emit("close");
      if (closeContextWithLastPage && !pages.some(p => !p.isClosed())) await context.close();
    });
    pages.push(page);
    return page;
  };
  context.pages = () => pages.filter(p => !p.isClosed());
  context.newPage = vi.fn(async () => { events.push("new-page"); return addPage("about:blank"); });
  context.close = vi.fn(async () => {
    if (closed) return;
    closed = true; events.push("close-context");
    for (const page of [...context.pages()]) await page.close();
    context.emit("close");
  });
  const page = addPage(initialUrl);
  return { context, page, pages, events };
}

let root: string, service: MuseBrowserService;
let launches: ReturnType<typeof browser>[];
let launch: ReturnType<typeof vi.spyOn>;
const internal = () => service as any;
function readyPages() { vi.spyOn(internal(), "pageSession").mockResolvedValue({ status: "connected" }); }
async function restart() {
  await service.close();
  service = new MuseBrowserService(root);
  await internal().ready;
  readyPages();
}
async function seed(conversationUrl = originalUrl, status = "interrupted") {
  const job = savedJob(conversationUrl, status);
  internal().jobs.set(jobId, job);
  await internal().persist();
  return job;
}

beforeEach(async () => {
  Object.values(fixtures).forEach(mock => mock.mockReset());
  fixtures.media.mockResolvedValue([]);
  fixtures.upload.mockResolvedValue(undefined);
  fixtures.delivery.mockResolvedValue({ state: "accepted" });
  fixtures.readiness.mockResolvedValue({ ready: true });
  fixtures.activity.mockResolvedValue({ working: false });
  launches = [];
  launch = vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async () => {
    const next = browser(); launches.push(next); return next.context;
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "draw-muse-reconnect-test-"));
  service = new MuseBrowserService(root);
  await internal().ready;
  readyPages();
});
afterEach(async () => {
  for (const job of internal().jobs.values()) {
    if (!["completed", "failed", "cancelled"].includes(job.status)) await service.cancel(job.id);
  }
  await vi.waitFor(() => expect(internal().running).toBe(false));
  await service.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved).toLowerCase() === (await fs.realpath(os.tmpdir())).toLowerCase()
    && path.basename(resolved).startsWith("draw-muse-reconnect-test-")) await fs.rm(resolved, { recursive: true, force: true });
});

describe("Muse background connection", () => {
  it("preserves the main chat as a resumable original location", () => {
    expect(museConversationUrl("https://muse.ai/")).toBe("https://muse.ai/");
    expect(museConversationUrl(originalUrl)).toBe(originalUrl);
    expect(museConversationUrl("https://muse.ai/thread/new")).toBeUndefined();
    expect(museConversationUrl("https://muse.ai/?redirect=elsewhere")).toBeUndefined();
    expect(museConversationUrl("https://muse.ai/#another-chat")).toBeUndefined();
    expect(museConversationUrl("https://muse.ai.evil.test/")).toBeUndefined();
  });

  it("reopens the same persistent profile and chat when the sole page was closed", async () => {
    expect((await service.login()).status).toBe("connected");
    await launches[0].page.goto(originalUrl);
    await internal().writes;
    await launches[0].page.close();
    expect(internal().context).toBeUndefined();
    expect((await service.login()).status).toBe("connected");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls.map(call => call[0])).toEqual([path.join(root, "browser-profile"), path.join(root, "browser-profile")]);
    expect(launch.mock.calls.map(call => call[1].headless)).toEqual([true, true]);
    expect(launch.mock.calls.every(call => !call[1].args)).toBe(true);
    expect(launches[1].page.url()).toBe(originalUrl);
    expect(launches[1].page.bringToFront).not.toHaveBeenCalled();
    expect(launches[1].context.newPage).not.toHaveBeenCalled();
  });

  it("coalesces concurrent session checks after an accidental page close", async () => {
    await service.login();
    await launches[0].page.close();
    const states = await Promise.all([service.session(), service.session(), service.session()]);
    expect(states.map(s => s.status)).toEqual(["connected", "connected", "connected"]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launches[1].context.newPage).not.toHaveBeenCalled();
    expect(launches[1].page.goto).toHaveBeenCalledTimes(1);
  });

  it("restarts a surviving empty context without opening a visible window", async () => {
    const existing = browser("about:blank", false);
    launch.mockResolvedValueOnce(existing.context);
    await service.login();
    await existing.page.close();
    const states = await Promise.all([service.session(), service.session()]);
    expect(states.map(s => s.status)).toEqual(["connected", "connected"]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(existing.context.close).toHaveBeenCalledOnce();
    expect(existing.context.newPage).not.toHaveBeenCalled();
    expect(launches[0].page.url()).toBe("https://muse.ai/");
  });

  it("retries a blank background page after its first reconnect navigation fails", async () => {
    const existing = browser("about:blank", false);
    const reopened = browser("about:blank", false);
    launch.mockResolvedValueOnce(existing.context);
    await service.login();
    await existing.page.close();
    reopened.page.goto.mockRejectedValueOnce(new Error("Temporary navigation failure"));
    launch.mockResolvedValueOnce(reopened.context);
    expect((await service.session()).status).toBe("checking");
    const blank = reopened.page;
    expect(blank.url()).toBe("about:blank");
    await vi.waitFor(async () => expect((await service.session()).status).toBe("connected"));
    expect(blank.goto).toHaveBeenCalledTimes(2);
    expect(blank.url()).toBe("https://muse.ai/");
    expect(reopened.context.newPage).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("does not reopen after explicit disconnect, including after service restart", async () => {
    await service.login();
    expect((await service.disconnect()).status).toBe("disconnected");
    await Promise.all([service.session(), service.session()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(root, "browser-session.json"), "utf8")).reconnect).toBe(false);
    await restart();
    expect((await service.session()).status).toBe("disconnected");
    expect(launch).toHaveBeenCalledTimes(1);
    await service.login();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(["https://muse.ai/", originalUrl])("resumes %s by observing the saved turn without uploading or sending again", async conversationUrl => {
    await seed(conversationUrl);
    fixtures.media.mockImplementation(() => new Promise(() => {}));
    await service.resume(jobId);
    await vi.waitFor(() => expect(fixtures.media).toHaveBeenCalledOnce());
    const active = launches[0];
    expect(active.page.url()).toBe(conversationUrl);
    expect(fixtures.media).toHaveBeenCalledWith(active.page, turnAnchor);
    expect((await service.get(jobId)).status).toBe("generating");
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(active.page.composer.fill).not.toHaveBeenCalled();
    expect(active.page.send.click).not.toHaveBeenCalled();
    expect(active.page.getByRole).not.toHaveBeenCalled();
    expect(active.context.newPage).not.toHaveBeenCalled();
    // Stopping observation must leave the official conversation/window intact.
    expect((await service.cancel(jobId)).status).toBe("cancelled");
    await vi.waitFor(() => expect(internal().running).toBe(false));
    expect(active.page.close).not.toHaveBeenCalled();
    expect(active.context.close).not.toHaveBeenCalled();
    expect((await service.get(jobId)).recovery).toBeUndefined();
  });

  it("marks a submitted task reconnectable when its only window closes during observation", async () => {
    await seed();
    fixtures.media.mockImplementationOnce(async (page: any) => {
      await page.close();
      throw new Error("Target page, context or browser has been closed");
    });
    await service.resume(jobId);
    await vi.waitFor(async () => expect(await service.get(jobId)).toMatchObject({ status: "interrupted", recovery: "reconnect", conversationUrl: originalUrl }));
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(launches[0].page.send.click).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps the matched original thread when a homepage task acquired its own URL", async () => {
    await seed("https://muse.ai/");
    const existing = browser(originalUrl);
    launch.mockResolvedValueOnce(existing.context);
    fixtures.media.mockImplementation(() => new Promise(() => {}));
    await service.resume(jobId);
    await vi.waitFor(() => expect(fixtures.media).toHaveBeenCalledOnce());
    expect(existing.page.goto).not.toHaveBeenCalled();
    expect((await service.get(jobId)).conversationUrl).toBe(originalUrl);
    expect(fixtures.media).toHaveBeenCalledWith(existing.page, turnAnchor);
    expect(existing.page.send.click).not.toHaveBeenCalled();
    expect(fixtures.upload).not.toHaveBeenCalled();
  });

  it("verifies the original turn before accepting a root-to-thread URL transition", async () => {
    const job = await seed("https://muse.ai/", "submitting");
    const existing = browser(originalUrl);
    // Enter after navigation, before the asynchronous navigation listener has
    // persisted the new URL: this was incorrectly treated as leaving the chat.
    await internal().waitForAcceptance(existing.page, job, pollingSignals);
    expect(fixtures.delivery).toHaveBeenCalledWith(existing.page, turnAnchor);
    expect(job.conversationUrl).toBe(originalUrl);
    expect(job).toMatchObject({ deliveryConfirmed: true });
    expect(existing.page.goto).not.toHaveBeenCalled();
    expect(existing.page.send.click).not.toHaveBeenCalled();
  });

  it("does not adopt a different named thread while confirming delivery", async () => {
    const job = await seed(originalUrl, "submitting");
    const unrelated = browser("https://muse.ai/thread/unrelated-002");
    await expect(internal().waitForAcceptance(unrelated.page, job, pollingSignals)).rejects.toThrow();
    expect(job.conversationUrl).toBe(originalUrl);
    expect(job).not.toMatchObject({ deliveryConfirmed: true });
    expect(unrelated.page.send.click).not.toHaveBeenCalled();
  });

  it("keeps a delivery problem manual when its browser is still open", async () => {
    await seed();
    fixtures.delivery.mockResolvedValue({ state: "unconfirmed", message: "未确认送达" });
    await service.resume(jobId);
    await vi.waitFor(async () => expect(await service.get(jobId)).toMatchObject({ status: "interrupted", recovery: "manual" }));
    expect(launches[0].page.isClosed()).toBe(false);
    expect(launches[0].page.send.click).not.toHaveBeenCalled();
  });

  it("does not relaunch or enqueue a cancelled task on resume or restart", async () => {
    await seed();
    await service.cancel(jobId);
    expect((await service.resume(jobId)).status).toBe("cancelled");
    await restart();
    expect((await service.resume(jobId)).status).toBe("cancelled");
    expect(launch).not.toHaveBeenCalled();
    expect(internal().pending.size).toBe(0);
  });

  it("cancels a pending mutation without opening another browser window", async () => {
    await service.login();
    const active = launches[0];
    await active.page.goto(originalUrl);
    fixtures.upload.mockImplementation(() => new Promise(() => {}));
    await service.create({ id: jobId, kind: "image", prompt: "A blue vase", aspectRatio: "auto", references: [] });
    await vi.waitFor(() => expect(fixtures.upload).toHaveBeenCalledOnce());
    expect(active.context.newPage).not.toHaveBeenCalled();
    expect(active.context.pages()).toHaveLength(1);
    // Cancellation must not wait for another page before stopping the send.
    active.context.newPage.mockImplementation(() => new Promise(() => {}));
    expect((await service.cancel(jobId)).status).toBe("cancelled");
    await vi.waitFor(() => expect(internal().running).toBe(false));
    expect(active.events).toEqual(["close-page", "close-context"]);
    expect(active.context.newPage).not.toHaveBeenCalled();
    expect(active.context.pages()).toHaveLength(0);
    expect(active.page.composer.fill).not.toHaveBeenCalled();
    expect(active.page.send.click).not.toHaveBeenCalled();
    expect((await service.session()).status).toBe("connected");
    expect(launches[1].page.url()).toBe(originalUrl);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("does not restore a stopped login page when an older session check finishes after cancellation", async () => {
    await service.login();
    const active = launches[0];
    fixtures.upload.mockImplementation(() => new Promise(() => {}));
    await service.create({ id: jobId, kind: "image", prompt: "A blue vase", aspectRatio: "auto", references: [] });
    await vi.waitFor(() => expect(fixtures.upload).toHaveBeenCalledOnce());
    let resolveSession!: (value: { status: string }) => void;
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    internal().pageSession.mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { resolveSession = resolve; });
    });
    const staleSession = service.session();
    await checking;
    await service.cancel(jobId);
    expect(active.context.pages()).toHaveLength(0);
    resolveSession({ status: "connected" });
    await staleSession;
    expect(internal().loginPage).toBeUndefined();
    expect(active.page.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(internal().running).toBe(false));
    expect((await service.session()).status).toBe("connected");
    expect(internal().loginPage).toBe(launches[1].page);
  });

  it("uses page events to recheck delivery and waits three seconds plus a finished download before completing", async () => {
    vi.useFakeTimers();
    const job = await seed();
    const existing = browser(originalUrl);
    launch.mockResolvedValueOnce(existing.context);
    fixtures.delivery.mockResolvedValue({ state: "pending" });
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
    let releaseBody!: (value: Buffer) => void;
    const pendingBody = new Promise<Buffer>(resolve => { releaseBody = resolve; });
    const response = { ok: () => true, status: () => 200, headers: () => ({}), body: vi.fn(() => pendingBody), dispose: vi.fn() };
    existing.context.request = { get: vi.fn(async () => response) };
    existing.page.context = () => existing.context;
    await service.resume(jobId);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.status).toBe("submitting");
    expect(existing.page.listenerCount("websocket")).toBe(1);
    const socket = new EventEmitter();
    existing.page.emit("websocket", socket);
    const deliveryReads = fixtures.delivery.mock.calls.length;
    socket.emit("framereceived", { payload: Buffer.from([0, 255, 19]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.delivery.mock.calls.length).toBeGreaterThan(deliveryReads);
    expect(job.status).toBe("submitting");
    expect(job).not.toMatchObject({ deliveryConfirmed: true });
    expect(fixtures.media).not.toHaveBeenCalled();
    expect(existing.context.request.get).not.toHaveBeenCalled();

    const media = [{ src: "https://muse.ai/result.png", kind: "image", width: 512, height: 512 }];
    fixtures.delivery.mockResolvedValue({ state: "accepted" });
    fixtures.media.mockResolvedValue(media);
    socket.emit("framereceived", { payload: Buffer.from([1, 7, 255]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(job).toMatchObject({ status: "generating", deliveryConfirmed: true });
    expect(fixtures.media).toHaveBeenCalledWith(existing.page, turnAnchor);
    for (let event = 0; event < 5; event++) {
      existing.page.emit("requestfinished");
      socket.emit("framereceived", { payload: Buffer.from([event]) });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(existing.context.request.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2999);
    existing.page.emit("requestfinished");
    await vi.advanceTimersByTimeAsync(0);
    expect(job.status).toBe("generating");
    expect(existing.context.request.get).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    socket.emit("framereceived", { payload: Buffer.from([255]) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(response.body).toHaveBeenCalledOnce());
    expect(job.status).toBe("saving");
    expect((await service.get(jobId)).outputs).toBeUndefined();
    releaseBody(bytes);
    await vi.waitFor(() => expect(job.status).toBe("completed"));
    const completed = await service.get(jobId);
    expect(completed.outputs).toHaveLength(1);
    const output = await service.media(jobId, completed.outputs![0].id);
    expect(await fs.readFile(output.path)).toEqual(bytes);
    expect(existing.context.request.get).toHaveBeenCalledExactlyOnceWith(media[0].src, { timeout: 0, maxRedirects: 0 });
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(existing.page.send.click).not.toHaveBeenCalled();
    expect(socket.listenerCount("framereceived")).toBe(0);
  });

  it("keeps ready media pending while the avatar works and waits three seconds after idle before downloading", async () => {
    vi.useFakeTimers();
    const job = await seed();
    Object.assign(job, { deliveryConfirmed: true });
    const existing = browser(originalUrl);
    launch.mockResolvedValueOnce(existing.context);
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    fixtures.media.mockResolvedValue([{ src: "https://muse.ai/result.png", kind: "image", width: 512, height: 512 }]);
    fixtures.activity.mockResolvedValue({ working: true, message: "努力工作中" });
    let finishDownload!: () => void;
    const pendingDownload = new Promise<void>(resolve => { finishDownload = resolve; });
    const download = vi.spyOn(internal(), "download").mockImplementation(() => pendingDownload);
    await service.resume(jobId);
    await vi.advanceTimersByTimeAsync(7000);
    expect(job).toMatchObject({ status: "generating", message: "Muse 努力工作中" });
    expect(download).not.toHaveBeenCalled();
    fixtures.activity.mockResolvedValue({ working: false });
    existing.page.emit("requestfinished");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2999);
    existing.page.emit("requestfinished");
    await vi.advanceTimersByTimeAsync(0);
    expect(download).not.toHaveBeenCalled();
    expect(job.status).toBe("generating");
    await vi.advanceTimersByTimeAsync(1);
    existing.page.emit("requestfinished");
    await vi.advanceTimersByTimeAsync(0);
    expect(download).toHaveBeenCalledOnce();
    expect(job.status).toBe("saving");
    finishDownload();
    await vi.advanceTimersByTimeAsync(0);
    expect(job.status).toBe("completed");
    expect(existing.page.listenerCount("requestfinished")).toBe(0);
    expect(existing.page.listenerCount("websocket")).toBe(0);
    expect(existing.page.listenerCount("framenavigated")).toBe(1);
    expect(internal().activePages.size).toBe(0);
    expect(internal().cancellations.size).toBe(0);
    expect(existing.page.send.click).not.toHaveBeenCalled();
    expect(fixtures.upload).not.toHaveBeenCalled();
  });

  it("resumes confirmed delivery without another acceptance wait while retaining anchored media validation", async () => {
    vi.useFakeTimers();
    const job = await seed();
    Object.assign(job, { deliveryConfirmed: true });
    const existing = browser(originalUrl);
    launch.mockResolvedValueOnce(existing.context);
    const acceptance = vi.spyOn(internal(), "waitForAcceptance");
    const download = vi.spyOn(internal(), "download").mockResolvedValue(undefined);
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    fixtures.delivery.mockResolvedValue({ state: "missing" });
    fixtures.media.mockResolvedValue([
      { src: "https://muse.ai/other-video.mp4", kind: "video", width: 512, height: 512 },
      { src: "https://muse.ai/loading.png", kind: "image", width: 0, height: 0 },
    ]);
    await service.resume(jobId);
    await vi.advanceTimersByTimeAsync(4500);
    expect(acceptance).not.toHaveBeenCalled();
    expect(job.status).toBe("generating");
    expect(fixtures.media).toHaveBeenCalledWith(existing.page, turnAnchor);
    expect(download).not.toHaveBeenCalled();
    const media = [{ src: "https://muse.ai/owned-result.png", kind: "image", width: 512, height: 512 }];
    fixtures.media.mockResolvedValue(media);
    existing.page.emit("requestfinished");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(job.status).toBe("completed");
    expect(download).toHaveBeenCalledExactlyOnceWith(existing.page, job, media);
    expect(fixtures.media.mock.calls.every(([page, reference]) => page === existing.page && reference === turnAnchor)).toBe(true);
    expect(acceptance).not.toHaveBeenCalled();
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(existing.page.composer.fill).not.toHaveBeenCalled();
    expect(existing.page.send.click).not.toHaveBeenCalled();
  });

  it("saves ready media despite a hidden stop button and advances the next queued original task", async () => {
    vi.useFakeTimers();
    await service.login();
    launches[0].page.hiddenStopPresent = true;
    await seed("https://muse.ai/");
    const secondId = "muse-reconnect-002";
    internal().jobs.set(secondId, { ...savedJob("https://muse.ai/"), id: secondId });
    await internal().persist();
    fixtures.media.mockResolvedValue([{ src: "https://muse.ai/result.png", kind: "image", width: 512, height: 512 }]);
    const download = vi.spyOn(internal(), "download").mockImplementation(async () => {});
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    await service.resume(jobId);
    await service.resume(secondId);
    await vi.advanceTimersByTimeAsync(9000);
    await vi.waitFor(async () => {
      expect((await service.get(jobId)).status).toBe("completed");
      expect((await service.get(secondId)).status).toBe("completed");
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(internal().pending.size).toBe(0);
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(launches[0].page.send.click).not.toHaveBeenCalled();
  });
});
