import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseBrowserService } from "../scripts/muse-browser-service";

const browserFixtures = vi.hoisted(() => ({ media: vi.fn(), delivery: vi.fn(), readiness: vi.fn(), upload: vi.fn(), uploadPending: vi.fn(), uploadError: vi.fn(), prepare: vi.fn() }));
vi.mock("../scripts/muse-turn-media", () => ({ readMuseTurnMedia: browserFixtures.media }));
vi.mock("../scripts/muse-delivery-state", () => ({ readMuseDeliveryState: browserFixtures.delivery }));
vi.mock("../scripts/muse-send-readiness", () => ({ readMuseSendReadiness: browserFixtures.readiness }));
vi.mock("../scripts/muse-turn-anchor", () => ({ prepareMuseTurnAnchor: browserFixtures.prepare }));
vi.mock("../scripts/muse-upload", async importOriginal => ({
  ...await importOriginal<typeof import("../scripts/muse-upload")>(),
  uploadMuseReferences: browserFixtures.upload, museUploadPending: browserFixtures.uploadPending, museUploadError: browserFixtures.uploadError,
}));

const id = "muse-cancel-0001";
const request = (extra = {}) => ({ id, kind: "image", prompt: "An exact user prompt", aspectRatio: "auto", references: [], ...extra });
const anchor = { promptHash: "a".repeat(64), precedingUserHashes: [] };
let root: string, service: MuseBrowserService;
let releasePending: (() => void)[];
const internal = () => service as any;
const records = async () => JSON.parse(await fs.readFile(path.join(root, "jobs.json"), "utf8"));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function queued() {
  vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
  return vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
}
function browserPage() {
  let closed = false;
  const composer = { count: vi.fn().mockResolvedValue(1), fill: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn().mockResolvedValue("") };
  const send = { count: vi.fn().mockResolvedValue(1), isEnabled: vi.fn().mockResolvedValue(true), click: vi.fn().mockResolvedValue(undefined) };
  const locator = { filter: vi.fn(), first: () => composer, count: vi.fn().mockResolvedValue(0), allTextContents: vi.fn().mockResolvedValue([]) };
  locator.filter.mockReturnValue(locator);
  const page = {
    url: () => "https://muse.ai/thread/original-123", isClosed: () => closed,
    on: vi.fn(), off: vi.fn(), goto: vi.fn(), evaluate: vi.fn(),
    close: vi.fn(async () => { closed = true; }),
    locator: vi.fn(() => locator), getByRole: vi.fn(() => ({ first: () => send })),
  };
  const otherPage = { ...page, close: vi.fn(), isClosed: () => false, url: () => "https://muse.ai/thread/unrelated-456" };
  const context = { pages: () => [page, otherPage], newPage: vi.fn(), close: vi.fn() };
  internal().context = context;
  internal().workPage = page;
  vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
  vi.spyOn(internal(), "pageSession").mockResolvedValue({ status: "connected" });
  return { page, otherPage, context, composer, send };
}

beforeEach(async () => {
  releasePending = [];
  for (const mock of Object.values(browserFixtures)) mock.mockReset();
  browserFixtures.media.mockResolvedValue([]);
  browserFixtures.delivery.mockResolvedValue({ state: "accepted" });
  browserFixtures.readiness.mockResolvedValue({ ready: true });
  browserFixtures.upload.mockResolvedValue(undefined);
  browserFixtures.uploadPending.mockResolvedValue(false);
  browserFixtures.uploadError.mockResolvedValue(undefined);
  browserFixtures.prepare.mockResolvedValue(anchor);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "draw-muse-cancel-test-"));
  service = new MuseBrowserService(root);
  await service.session();
});
afterEach(async () => {
  for (const release of releasePending) release();
  await service.close();
  vi.useRealTimers();
  if (internal().running) await vi.waitFor(() => expect(internal().running).toBe(false), { timeout: 2500 }).catch(() => {});
  await internal().writes.catch(() => {});
  vi.restoreAllMocks();
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved).toLowerCase() === (await fs.realpath(os.tmpdir())).toLowerCase() && path.basename(resolved).startsWith("draw-muse-cancel-test-"))
    await fs.rm(resolved, { recursive: true, force: true });
});

describe("durable Muse cancellation", () => {
  it("persists cancellation of a valid unknown ID without starting a browser", async () => {
    const launch = vi.spyOn(internal(), "launch").mockResolvedValue(undefined);
    const result = await service.cancel(id);
    expect(result).toMatchObject({ id, status: "cancelled" });
    expect(await service.get(id)).toMatchObject({ id, status: "cancelled" });
    expect((await records()).find((job: any) => job.id === id)).toMatchObject({ id, status: "cancelled", submitted: false });
    expect(internal().pending.has(id)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["bad", "../escape", "x".repeat(101)])("rejects invalid cancellation ID %s", async invalid => {
    await expect(service.cancel(invalid)).rejects.toThrow();
    expect(internal().jobs.size).toBe(0);
  });

  it("returns a cancelled tombstone before input hashes, login or uploaded-handle resolution can revive it", async () => {
    await service.cancel(id);
    const session = vi.spyOn(service, "session").mockRejectedValue(new Error("Login must not be inspected"));
    const resolve = vi.spyOn(service.references, "resolve").mockRejectedValue(new Error("Old uploads no longer exist"));
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    const first = await service.create(request());
    const second = await service.create(request({ prompt: "Changed prompt", references: [
      { uploadId: "12345678-1234-4234-8234-123456789abc", name: "missing.png", mime: "image/png" },
    ] }));
    expect(first.status).toBe("cancelled"); expect(second.status).toBe("cancelled");
    expect(session).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
    expect(internal().pending.has(id)).toBe(false);
  });

  it("keeps cancellation terminal across reload, repeated cancel and resume", async () => {
    await service.cancel(id);
    await service.close(); service = new MuseBrowserService(root);
    expect((await service.get(id)).status).toBe("cancelled");
    const launch = vi.spyOn(internal(), "launch").mockResolvedValue(undefined);
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    expect((await service.cancel(id)).status).toBe("cancelled");
    expect((await service.resume(id)).status).toBe("cancelled");
    expect(internal().pending.has(id)).toBe(false);
    expect(launch).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
  });

  it("removes a queued job before it can reach run", async () => {
    const drain = queued();
    await service.create(request());
    expect(internal().pending.has(id)).toBe(true);
    await service.cancel(id);
    expect(internal().pending.has(id)).toBe(false);
    drain.mockRestore();
    const run = vi.spyOn(internal(), "run").mockResolvedValue(undefined);
    await internal().drain();
    expect(run).not.toHaveBeenCalled();
    expect((await service.get(id)).status).toBe("cancelled");
  });

  it.each(["completed", "failed"])("leaves an already %s job unchanged", async status => {
    queued(); await service.create(request());
    const job = internal().jobs.get(id);
    Object.assign(job, { status, submitted: true, message: "Original terminal result", error: status === "failed" ? "Original failure" : undefined,
      outputs: status === "completed" ? [{ id: "output-result", name: "result.png", mime: "image/png", url: "/result" }] : undefined });
    internal().pending.delete(id);
    await internal().persist();
    const before = await service.get(id);
    expect(await service.cancel(id)).toEqual(before);
    expect(await service.get(id)).toEqual(before);
    expect((await records())[0]).toMatchObject({ status, message: "Original terminal result" });
  });

  it("reports that submitted work may continue on Muse while stopping local tracking", async () => {
    queued(); await service.create(request());
    Object.assign(internal().jobs.get(id), { submitted: true, status: "generating", conversationUrl: "https://muse.ai/thread/original-123" });
    const result = await service.cancel(id);
    expect(result.status).toBe("cancelled");
    expect(result.message).toMatch(/可能.*继续|继续.*可能/);
    expect(result.conversationUrl).toBe("https://muse.ai/thread/original-123");
    expect(internal().jobs.get(id).submitted).toBe(true);
    expect((await records())[0].status).toBe("cancelled");
  });

  it("lets cancellation win when an in-flight create is still checking the session", async () => {
    const ready = deferred<{ status: "connected" }>();
    releasePending.push(() => ready.resolve({ status: "connected" }));
    const session = vi.spyOn(service, "session").mockReturnValue(ready.promise);
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    const creating = service.create(request());
    await vi.waitFor(() => expect(session).toHaveBeenCalled());
    await service.cancel(id);
    ready.resolve({ status: "connected" });
    expect((await creating).status).toBe("cancelled");
    expect((await service.get(id)).status).toBe("cancelled");
    expect(internal().pending.has(id)).toBe(false);
    expect(drain).not.toHaveBeenCalled();
  });
});

describe("active Muse cancellation", () => {
  it("interrupts a hanging composer operation by closing only that job's page and never sends after it settles", async () => {
    const { page, otherPage, context, composer, send } = browserPage();
    const filling = deferred<void>();
    releasePending.push(() => filling.resolve());
    composer.fill.mockReturnValue(filling.promise);
    await service.create(request());
    await vi.waitFor(() => expect(composer.fill).toHaveBeenCalledTimes(1));
    const result = await service.cancel(id);
    expect(result.status).toBe("cancelled");
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(otherPage.close).not.toHaveBeenCalled(); expect(context.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(internal().running).toBe(false));
    filling.resolve(); await Promise.resolve();
    expect(send.click).not.toHaveBeenCalled();
    expect(browserFixtures.media).not.toHaveBeenCalled();
    expect((await service.get(id)).status).toBe("cancelled");
  });

  it("preserves the submitted checkpoint when cancellation interrupts the single send click", async () => {
    const { page, otherPage, send } = browserPage();
    const clicking = deferred<void>();
    releasePending.push(() => clicking.resolve());
    send.click.mockReturnValue(clicking.promise);
    await service.create(request());
    await vi.waitFor(() => expect(send.click).toHaveBeenCalledTimes(1));
    expect(internal().jobs.get(id).submitted).toBe(true);
    const result = await service.cancel(id);
    expect(result.status).toBe("cancelled"); expect(result.message).toMatch(/可能.*继续|继续.*可能/);
    expect(page.close).toHaveBeenCalledTimes(1); expect(otherPage.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(internal().running).toBe(false));
    clicking.resolve(); await Promise.resolve();
    expect(send.click).toHaveBeenCalledTimes(1);
    expect(browserFixtures.media).not.toHaveBeenCalled();
    expect((await service.get(id)).status).toBe("cancelled");
  });

  it("does not overwrite cancelled with completed after an already-started download resolves late", async () => {
    vi.useFakeTimers();
    browserPage();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    browserFixtures.media.mockResolvedValue([{ src: "https://media.fbcdn.net/result.png", kind: "image", width: 1, height: 1 }]);
    const saving = deferred<void>();
    releasePending.push(() => saving.resolve());
    const download = vi.spyOn(internal(), "download").mockReturnValue(saving.promise);
    await service.create(request());
    await vi.advanceTimersByTimeAsync(4500);
    expect(download).toHaveBeenCalledTimes(1);
    expect((await service.cancel(id)).status).toBe("cancelled");
    saving.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect((await service.get(id)).status).toBe("cancelled");
    expect(internal().running).toBe(false);
  });

  it("does not record output bytes that arrive after cancelling a real download step", async () => {
    vi.useFakeTimers();
    const { page } = browserPage();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    browserFixtures.media.mockResolvedValue([{ src: "https://media.fbcdn.net/result.png", kind: "image", width: 1, height: 1 }]);
    const incoming = deferred<Buffer>();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    releasePending.push(() => incoming.resolve(png));
    const response = { ok: () => true, status: () => 200, headers: () => ({}), body: vi.fn(() => incoming.promise), dispose: vi.fn() };
    Object.assign(page, { context: () => ({ request: { get: vi.fn().mockResolvedValue(response) } }) });
    await service.create(request());
    await vi.advanceTimersByTimeAsync(4500);
    await vi.waitFor(() => expect(response.body).toHaveBeenCalledTimes(1));
    expect((await service.cancel(id)).status).toBe("cancelled");
    incoming.resolve(png);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(internal().running).toBe(false));
    expect((await service.get(id)).status).toBe("cancelled");
    expect((await service.get(id)).outputs).toBeUndefined();
    expect(await fs.readdir(path.join(root, "media", id))).toEqual([]);
  });
});
