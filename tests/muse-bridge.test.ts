import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { MuseBrowserService, validateMuseRequest, sniffMuseMedia, museConversationUrl, museMediaUrl, museGenerationPrompt } from "../scripts/muse-browser-service";
import { museRequestAllowed, museViewRequestAllowed, museSessionExportAllowed } from "../scripts/muse-bridge-plugin";
import { MuseUploadError } from "../scripts/muse-upload";

const browserFixtures = vi.hoisted(() => ({ readMedia: vi.fn(), upload: vi.fn(), uploadPending: vi.fn(), uploadError: vi.fn(), delivery: vi.fn(), readiness: vi.fn(), prepare: vi.fn(), activity: vi.fn() }));
vi.mock("../scripts/muse-turn-media", () => ({ readMuseTurnMedia: browserFixtures.readMedia }));
vi.mock("../scripts/muse-delivery-state", () => ({ readMuseDeliveryState: browserFixtures.delivery }));
vi.mock("../scripts/muse-send-readiness", () => ({ readMuseSendReadiness: browserFixtures.readiness }));
vi.mock("../scripts/muse-turn-anchor", () => ({ prepareMuseTurnAnchor: browserFixtures.prepare }));
vi.mock("../scripts/muse-activity-state", () => ({ readMuseActivity: browserFixtures.activity }));
vi.mock("../scripts/muse-upload", async importOriginal => ({
  ...await importOriginal<typeof import("../scripts/muse-upload")>(),
  uploadMuseReferences: browserFixtures.upload, museUploadPending: browserFixtures.uploadPending, museUploadError: browserFixtures.uploadError,
}));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const mp4 = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
const wav = Buffer.from("524946462800000057415645666d7420100000000100010044ac00008858010002001000646174610400000000000000", "hex");
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
const request = (extra = {}) => ({ id: "muse-test-0001", kind: "image", prompt: "A blue vase", aspectRatio: "auto", references: [], ...extra });
const privateAnchor = { promptHash: "a".repeat(64), precedingUserHashes: ["b".repeat(64)] };
const pollingSignals = {
  revision: () => 0,
  wait: () => new Promise<void>(resolve => { setTimeout(resolve, 1500); }),
};
let root: string;
let service: MuseBrowserService;
const internal = () => service as any;
function online() {
  vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
  return vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
}
function reusablePage(initialUrl = "https://muse.ai/thread/original-123") {
  let url = initialUrl;
  const composer = { count: vi.fn().mockResolvedValue(1), fill: vi.fn(), waitFor: vi.fn(), evaluate: vi.fn().mockResolvedValue("") };
  const send = { count: vi.fn().mockResolvedValue(1), waitFor: vi.fn(), isEnabled: vi.fn().mockResolvedValue(true), click: vi.fn() };
  const locator = { filter: vi.fn(), first: () => composer, count: vi.fn().mockResolvedValue(0), allTextContents: vi.fn().mockResolvedValue([]) };
  locator.filter.mockReturnValue(locator);
  const page = {
    goto: vi.fn(async (next: string) => { url = next; }), url: () => url,
    on: vi.fn(), off: vi.fn(), close: vi.fn(), isClosed: () => false,
    locator: vi.fn(() => locator), getByRole: vi.fn(() => ({ first: () => send })), evaluate: vi.fn(),
  };
  const spare = { isClosed: () => false, url: () => "about:blank" };
  const context = { pages: vi.fn(() => [page, spare]), newPage: vi.fn(async () => { throw new Error("The existing Muse page and cancellation guard must be reused"); }), close: vi.fn() };
  internal().context = context;
  vi.spyOn(internal(), "pageSession").mockResolvedValue({ status: "connected" });
  const acceptance = vi.spyOn(internal(), "waitForAcceptance").mockResolvedValue(undefined);
  return { page, context, send, composer, acceptance, setUrl: (value: string) => { url = value; } };
}
beforeEach(async () => {
  for (const mock of Object.values(browserFixtures)) mock.mockReset();
  browserFixtures.readMedia.mockResolvedValue([]);
  browserFixtures.uploadPending.mockResolvedValue(false);
  browserFixtures.uploadError.mockResolvedValue(undefined);
  browserFixtures.delivery.mockResolvedValue({ state: "accepted" });
  browserFixtures.readiness.mockResolvedValue({ ready: true });
  browserFixtures.prepare.mockResolvedValue(privateAnchor);
  browserFixtures.activity.mockResolvedValue({ working: false });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "draw-muse-test-"));
  service = new MuseBrowserService(root);
  await service.session();
});
afterEach(async () => {
  await service.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved).toLowerCase() === (await fs.realpath(os.tmpdir())).toLowerCase() && path.basename(resolved).startsWith("draw-muse-test-"))
    await fs.rm(resolved, { recursive: true, force: true });
});

describe("Muse request and media boundaries", () => {
  it("validates actual image bytes and canonicalizes upload names", () => {
    const parsed = validateMuseRequest(request({ references: [{ name: "../private.png", mime: "image/png", dataBase64: png.toString("base64") }] }));
    expect(parsed.references[0].name).toBe("reference-1.png");
    expect(() => validateMuseRequest(request({ references: [{ mime: "image/png", dataBase64: Buffer.from("<html>login</html>").toString("base64") }] }))).toThrow();
    expect(() => validateMuseRequest(request({ id: "../../secret" }))).toThrow();
    expect(() => validateMuseRequest(request({ prompt: " " }))).toThrow();
  });
  it("identifies binary images/video without treating HTML as media", () => {
    expect(sniffMuseMedia(png)).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffMuseMedia(Buffer.from("0000ftypmp42"))).toEqual({ mime: "video/mp4", ext: "mp4" });
    expect(sniffMuseMedia(Buffer.from("<html>download.mp4</html>"))).toBeUndefined();
  });
  it("accepts ordered PNG, MP4, WAV and MP3 references without the former four-file limit", () => {
    const inputs = [
      { bytes: png, mime: "image/png" }, { bytes: mp4, mime: "video/mp4" },
      { bytes: wav, mime: "audio/wav" }, { bytes: mp3, mime: "audio/mpeg" },
      { bytes: png, mime: "image/png" }, { bytes: wav, mime: "audio/wav" },
    ];
    const parsed = validateMuseRequest(request({ references: inputs.map(input => ({ name: "original", mime: input.mime, dataBase64: input.bytes.toString("base64") })) }));
    expect(parsed.references.map(ref => [ref.name, ref.mime])).toEqual([
      ["reference-1.png", "image/png"], ["reference-2.mp4", "video/mp4"],
      ["reference-3.wav", "audio/wav"], ["reference-4.mp3", "audio/mpeg"],
      ["reference-5.png", "image/png"], ["reference-6.wav", "audio/wav"],
    ]);
    expect(parsed.references.map(ref => Buffer.from(ref.dataBase64!, "base64"))).toEqual(inputs.map(input => input.bytes));
    const marker = "[DrawStudio task: muse-test-0001]";
    const prompt = museGenerationPrompt(parsed, marker);
    expect(prompt).toBe(parsed.prompt);
    expect(() => validateMuseRequest(request({ references: [{ mime: "image/png", dataBase64: wav.toString("base64") }] }))).toThrow("类型不符");
    expect(() => validateMuseRequest(request({ references: [{ mime: "video/mp4", dataBase64: mp3.toString("base64") }] }))).toThrow("类型不符");
  });
  it("accepts only original official conversation and media locations", () => {
    expect(museConversationUrl("https://muse.ai/thread/abc-123?share=1")).toBe("https://muse.ai/thread/abc-123");
    expect(museConversationUrl("https://muse.ai/thread/new")).toBeUndefined();
    expect(museConversationUrl("https://muse.ai.evil.test/thread/abc")).toBeUndefined();
    expect(museMediaUrl("https://video.xx.fbcdn.net/result.mp4")).toBe(true);
    expect(museMediaUrl("https://fbcdn.net.evil.test/result.mp4")).toBe(false);
    expect(museMediaUrl("http://127.0.0.1/private")).toBe(false);
  });
  it("rejects foreign sites, spoofed hosts and cross-site requests", () => {
    expect(museRequestAllowed({ headers: { host: "127.0.0.1:1420", origin: "http://127.0.0.1:1420" } })).toBe(true);
    expect(museRequestAllowed({ headers: { host: "127.0.0.1:1420", origin: "https://evil.test" } })).toBe(false);
    expect(museRequestAllowed({ headers: { host: "evil.test", origin: "https://evil.test" } })).toBe(false);
    expect(museRequestAllowed({ headers: { host: "127.0.0.1:1420", "sec-fetch-site": "cross-site" } })).toBe(false);
  });
});

describe("Muse canvas chat mirror", () => {
  function mirrorPage() {
    const page = {
      url: () => "https://muse.ai/thread/original-123",
      isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue({ width: 900, height: 600 }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("jpeg-frame")),
      mouse: { move: vi.fn(), click: vi.fn(), wheel: vi.fn() },
      keyboard: { press: vi.fn(), insertText: vi.fn() },
    };
    vi.spyOn(internal(), "viewerPage").mockResolvedValue(page);
    return page;
  }
  it("allows account viewing only from an explicit canvas origin over loopback", () => {
    const request = (origin: string | undefined, remoteAddress: string, host = "127.0.0.1:1420") => ({
      headers: { host, ...(origin ? { origin } : {}) }, socket: { remoteAddress },
    }) as any;
    expect(museViewRequestAllowed(request("http://127.0.0.1:1420", "127.0.0.1"))).toBe(true);
    expect(museViewRequestAllowed(request("tauri://localhost", "::1"))).toBe(true);
    expect(museViewRequestAllowed({ headers: { host: "127.0.0.1:1420", origin: "http://tauri.localhost", "sec-fetch-site": "cross-site" }, socket: { remoteAddress: "::ffff:127.0.0.1" } } as any)).toBe(true);
    expect(museViewRequestAllowed(request(undefined, "127.0.0.1"))).toBe(false);
    expect(museViewRequestAllowed(request("https://evil.test", "127.0.0.1"))).toBe(false);
    expect(museViewRequestAllowed(request("http://127.0.0.1:1420", "192.168.1.2"))).toBe(false);
    expect(museViewRequestAllowed(request("http://127.0.0.1:1420", "127.0.0.1", "evil.test"))).toBe(false);
  });
  it("allows Origin-free same-origin export only with the canvas header on loopback", () => {
    const request = (address: string, site: string, header?: string, origin?: string) => ({
      headers: { host: "127.0.0.1:1420", "sec-fetch-site": site,
        ...(header ? { "x-canvas-session": header } : {}), ...(origin ? { origin } : {}) },
      socket: { remoteAddress: address },
    }) as any;
    expect(museSessionExportAllowed(request("127.0.0.1", "same-origin", "1"))).toBe(true);
    expect(museSessionExportAllowed(request("127.0.0.1", "same-origin"))).toBe(false);
    expect(museSessionExportAllowed(request("127.0.0.1", "cross-site", "1"))).toBe(false);
    expect(museSessionExportAllowed(request("192.0.2.2", "same-origin", "1"))).toBe(false);
    expect(museSessionExportAllowed(request("127.0.0.1", "cross-site", "1", "https://evil.example"))).toBe(false);
  });
  it("keeps an OAuth popup as the canvas page until that popup closes", async () => {
    const original = { url: () => "https://muse.ai/", isClosed: () => false };
    const oauth = { url: () => "https://accounts.google.com/signin", isClosed: () => false };
    const context = { pages: () => [original, oauth] };
    vi.spyOn(internal(), "launch").mockResolvedValue(context);
    internal().loginPage = original;
    internal().viewerFocusedPage = oauth;
    expect(await internal().viewerPage()).toBe(oauth);
  });
  it("returns the original page pixels and forwards bounded mouse and keyboard input", async () => {
    const page = mirrorPage();
    expect(await service.viewerFrame()).toEqual({ bytes: Buffer.from("jpeg-frame"), width: 900, height: 600 });
    expect(page.screenshot).toHaveBeenCalledWith({ type: "jpeg", quality: 90, scale: "css" });
    await service.viewerInput({ type: "click", x: 10, y: 20, button: "right" });
    expect(page.mouse.click).toHaveBeenCalledWith(10, 20, { button: "right" });
    await service.viewerInput({ type: "wheel", x: 25, y: 30, deltaY: 100 });
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 100);
    await service.viewerInput({ type: "key", key: "ControlOrMeta+A" });
    await service.viewerInput({ type: "key", key: "Shift+Enter" });
    expect(page.keyboard.press).toHaveBeenCalledWith("ControlOrMeta+A");
    expect(page.keyboard.press).toHaveBeenCalledWith("Shift+Enter");
    await service.viewerInput({ type: "text", text: "你好，Muse" });
    expect(page.keyboard.insertText).toHaveBeenCalledWith("你好，Muse");
  });
  it("rejects out-of-view clicks, browser address shortcuts, oversized text and concurrent mutation", async () => {
    const page = mirrorPage();
    await expect(service.viewerInput({ type: "click", x: 901, y: 1 })).rejects.toThrow("坐标无效");
    await expect(service.viewerInput({ type: "key", key: "Control+L" })).rejects.toThrow("按键无效");
    await expect(service.viewerInput({ type: "text", text: "x".repeat(65537) })).rejects.toThrow("文字无效");
    internal().mutatingPages.add(page);
    await expect(service.viewerInput({ type: "click", x: 2, y: 2 })).rejects.toThrow("接收画布任务");
  });
  it("appends an attachment to the same original chat page", async () => {
    const page = mirrorPage();
    browserFixtures.upload.mockResolvedValue(undefined);
    expect(await service.viewerUpload({ path: "C:\\safe\\image.png", name: "image.png", mime: "image/png" })).toEqual({ ok: true });
    expect(browserFixtures.upload).toHaveBeenCalledWith(page, [{ path: "C:\\safe\\image.png", name: "image.png", mime: "image/png" }], expect.any(Function), { append: true });
  });
  it("returns the website attachment rejection to the canvas", async () => {
    mirrorPage();
    browserFixtures.upload.mockRejectedValue(new MuseUploadError("Unsupported file"));
    await expect(service.viewerUpload({ path: "C:\\safe\\image.png", name: "image.png", mime: "image/png" }))
      .rejects.toMatchObject({ message: "Unsupported file", status: 422 });
  });
});

describe("durable Muse jobs", () => {
  it("recognizes the ready homepage in a second tab instead of the stale login tab", async () => {
    const stale = { url: () => "https://muse.ai/login", isClosed: () => false, evaluate: async () => ({ url: "https://muse.ai/login", composer: false, login: true }) };
    const ready = { url: () => "https://muse.ai/", isClosed: () => false, evaluate: async () => ({ url: "https://muse.ai/", composer: true }) };
    internal().context = { pages: () => [stale, ready], close: async () => {} };
    internal().loginPage = stale;
    expect((await service.session()).status).toBe("connected");
    expect(internal().loginPage).toBe(ready);
  });
  it("does not inspect an unrelated tab and does not report navigation as logged out", async () => {
    const foreign = { url: () => "https://muse.ai.evil.test/", isClosed: () => false, evaluate: vi.fn() };
    const navigating = { url: () => "https://muse.ai/", isClosed: () => false, evaluate: vi.fn().mockRejectedValue(new Error("Execution context destroyed")) };
    internal().context = { pages: () => [navigating, foreign], close: async () => {} };
    expect((await service.session()).status).toBe("checking");
    expect(foreign.evaluate).not.toHaveBeenCalled();
  });
  it("coalesces concurrent submissions and rejects changed inputs for an existing ID", async () => {
    const drain = online();
    const results = await Promise.all([service.create(request()), service.create(request())]);
    expect(results.map(r => r.id)).toEqual(["muse-test-0001", "muse-test-0001"]);
    expect(drain).toHaveBeenCalledTimes(1);
    await expect(service.create(request({ prompt: "Changed" }))).rejects.toThrow("输入发生变化");
    const saved = await fs.readFile(path.join(root, "jobs.json"), "utf8");
    expect(saved).not.toContain("A blue vase");
    expect(saved).not.toContain("dataBase64");
    expect(internal().jobs.get("muse-test-0001").turnMarker).toBeUndefined();
  });
  it("returns an existing job after its uploaded handles have been cleaned without resolving or submitting again", async () => {
    const drain = online();
    const stream = Readable.from([png]) as unknown as IncomingMessage;
    const uploaded = await service.references.save("muse-test-0001", stream, "original.png", "image/png");
    const input = request({ references: [uploaded] });
    const original = await service.create(input);
    await service.references.cleanup(input.id);
    const resolve = vi.spyOn(service.references, "resolve");
    expect(await service.create(input)).toEqual(original);
    expect(resolve).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(1);
    await expect(service.create({ ...input, prompt: "Changed" })).rejects.toThrow("输入发生变化");
    expect(resolve).not.toHaveBeenCalled();
    await expect(service.create({ ...input, id: "muse-test-0002" })).rejects.toThrow("参考素材");
    expect(drain).toHaveBeenCalledTimes(1);
  });
  it("never submits when checkpoint storage fails", async () => {
    const drain = online();
    vi.spyOn(internal(), "persist").mockRejectedValue(new Error("disk full"));
    await expect(service.create(request())).rejects.toThrow("尚未向 Muse 提交");
    expect(drain).not.toHaveBeenCalled();
    expect((await service.get("muse-test-0001")).status).toBe("failed");
  });
  it("restart restores accepted jobs as recoverable and never replays their prompt", async () => {
    await fs.writeFile(path.join(root, "jobs.json"), JSON.stringify([{
      id: "muse-test-0001", kind: "video", hash: "hash", submitted: true, baseline: [],
      status: "generating", createdAt: 1, conversationUrl: "https://muse.ai/thread/original-123", turnAnchor: privateAnchor,
    }]));
    await service.close(); service = new MuseBrowserService(root);
    expect((await service.get("muse-test-0001")).status).toBe("interrupted");
    expect(internal().jobs.get("muse-test-0001").turnAnchor).toEqual(privateAnchor);
    vi.spyOn(internal(), "launch").mockResolvedValue({ pages: () => [{ isClosed: () => false, url: () => "https://muse.ai/" }] });
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    await Promise.all([service.resume("muse-test-0001"), service.resume("muse-test-0001")]);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(internal().pending.has("muse-test-0001")).toBe(true);
    expect(internal().pending.get("muse-test-0001")).toBeUndefined();
    expect((await service.get("muse-test-0001")).conversationUrl).toContain("original-123");
  });
  it("preserves the uncertain-send checkpoint if the one send click loses its response", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { send, page, context } = reusablePage();
    send.click.mockImplementation(async () => {
      const checkpoint = JSON.parse(await fs.readFile(path.join(root, "jobs.json"), "utf8"))[0];
      expect(checkpoint).toMatchObject({ submitted: true, status: "submitting", conversationUrl: "https://muse.ai/thread/original-123", turnAnchor: privateAnchor });
      expect(checkpoint.turnMarker).toBeUndefined();
      throw new Error("navigation lost");
    });
    const run = vi.spyOn(internal(), "run");
    await service.create(request());
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("interrupted"));
    expect(send.click).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    const record = JSON.parse(await fs.readFile(path.join(root, "jobs.json"), "utf8"))[0];
    expect(record.submitted).toBe(true);
    expect(record.conversationUrl).toBe("https://muse.ai/thread/original-123");
    expect(record.turnAnchor).toEqual(privateAnchor);
    expect(record.turnMarker).toBeUndefined();
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    await service.resume("muse-test-0001");
    expect(drain).toHaveBeenCalledTimes(1);
    expect(internal().pending.has("muse-test-0001")).toBe(true);
    expect(internal().pending.get("muse-test-0001")).toBeUndefined();
    expect((await service.get("muse-test-0001")).conversationUrl).toBe("https://muse.ai/thread/original-123");
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("does not resend an uncertain homepage submission when no original thread URL was confirmed", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { send } = reusablePage("https://muse.ai/");
    send.click.mockRejectedValue(new Error("navigation lost"));
    await service.create(request());
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("interrupted"));
    browserFixtures.delivery.mockResolvedValue({ state: "missing" });
    const drain = vi.spyOn(internal(), "drain").mockResolvedValue(undefined);
    expect(await service.resume("muse-test-0001")).toMatchObject({ status: "queued", conversationUrl: "https://muse.ai/" });
    expect(internal().pending.get("muse-test-0001")).toBeUndefined();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("reports loading with an explanation before waiting for the webpage, while remaining unsubmitted", async () => {
    online();
    const { composer, send } = reusablePage();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    let finishSession!: (state: { status: string; message?: string }) => void;
    const waiting = new Promise(resolve => { finishSession = resolve; });
    internal().pageSession.mockReturnValue(waiting);
    internal().pending.delete(job.id);
    const running = internal().run(job, validateMuseRequest(request()));
    await vi.waitFor(async () => {
      const current = await service.get(job.id);
      expect(current.status).toBe("loading");
      expect(current.message).toEqual(expect.any(String));
      expect(current.message?.trim()).not.toBe("");
    });
    expect(job.submitted).toBe(false);
    expect(composer.fill).not.toHaveBeenCalled(); expect(send.click).not.toHaveBeenCalled();
    finishSession({ status: "login-required", message: "请完成官方登录" });
    await expect(running).rejects.toThrow("官方登录");
  });
  it("preserves an unsent user draft and stops before uploading, filling or sending", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { composer, send, page, context } = reusablePage();
    composer.evaluate.mockResolvedValue("My unfinished Muse prompt");
    await service.create(request({ references: [{ name: "reference.png", mime: "image/png", dataBase64: png.toString("base64") }] }));
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("failed"));
    expect((await service.get("muse-test-0001")).error).toContain("未发送的内容");
    expect(internal().jobs.get("muse-test-0001").submitted).toBe(false);
    expect(browserFixtures.upload).not.toHaveBeenCalled();
    expect(composer.fill).not.toHaveBeenCalled(); expect(send.click).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
  });
  it("sends only the exact user prompt and stores its private anchor before the single send click", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { page, composer, send, acceptance } = reusablePage();
    acceptance.mockRestore();
    const prompt = "  根据参考素材生成视频。\n保持原始对白与标点！\n  ";
    const input = request({ kind: "video", prompt, aspectRatio: "16:9", references: [
      { name: "reference.png", mime: "image/png", dataBase64: png.toString("base64") },
      { name: "reference.mp4", mime: "video/mp4", dataBase64: mp4.toString("base64") },
    ] });
    let checkpoint: any;
    send.click.mockImplementation(async () => { checkpoint = JSON.parse(await fs.readFile(path.join(root, "jobs.json"), "utf8"))[0]; });
    browserFixtures.readMedia.mockRejectedValue(new Error("Stop after observing the scoped read"));
    await service.create(input);
    await vi.waitFor(async () => expect((await service.get(input.id)).status).toBe("interrupted"));
    expect(composer.fill).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(browserFixtures.prepare).toHaveBeenCalledExactlyOnceWith(page, prompt);
    expect(browserFixtures.prepare.mock.invocationCallOrder[0]).toBeLessThan(composer.fill.mock.invocationCallOrder[0]);
    expect(composer.fill.mock.invocationCallOrder[0]).toBeLessThan(send.click.mock.invocationCallOrder[0]);
    expect(checkpoint).toMatchObject({ submitted: true, status: "submitting", turnAnchor: privateAnchor });
    expect(checkpoint.turnMarker).toBeUndefined();
    expect(JSON.stringify(checkpoint)).not.toContain("根据参考素材");
    expect(browserFixtures.delivery).toHaveBeenCalledWith(page, privateAnchor);
    expect(browserFixtures.readMedia).toHaveBeenCalledWith(page, privateAnchor);
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("reuses the same page and conversation for identical prompts while scoping results to each private anchor", async () => {
    vi.useFakeTimers();
    const drain = online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, context, send, composer, acceptance } = reusablePage();
    const media = [{ src: "https://media.fbcdn.net/new-result.png", kind: "image", width: 640, height: 480 }];
    browserFixtures.readMedia.mockResolvedValue(media);
    const anchors = [
      { promptHash: "a".repeat(64), precedingUserHashes: [] },
      { promptHash: "a".repeat(64), precedingUserHashes: ["a".repeat(64)] },
    ];
    browserFixtures.prepare.mockResolvedValueOnce(anchors[0]).mockResolvedValueOnce(anchors[1]);
    vi.spyOn(internal(), "download").mockImplementation(async (...args: any[]) => {
      const job = args[1]; job.outputs = [{ id: "output-" + job.id, name: "result.png", mime: "image/png", url: "/api/muse/jobs/" + job.id + "/media/result" }];
    });
    for (const [index, id] of ["muse-test-0001", "muse-test-0002"].entries()) {
      const input = request({ id });
      await service.create(input);
      internal().pending.delete(id);
      const job = internal().jobs.get(id);
      const running = internal().run(job, validateMuseRequest(input));
      await vi.advanceTimersByTimeAsync(4500);
      await running;
      expect((await service.get(id)).status).toBe("completed");
      expect(job.conversationUrl).toBe("https://muse.ai/thread/original-123");
      expect(composer.fill).toHaveBeenLastCalledWith(input.prompt);
      expect(job.turnMarker).toBeUndefined();
      expect(job.turnAnchor).toEqual(anchors[index]);
      expect(browserFixtures.readMedia).toHaveBeenCalledWith(page, anchors[index]);
      expect(browserFixtures.delivery).toHaveBeenCalledWith(page, anchors[index]);
    }
    expect(drain).toHaveBeenCalledTimes(2);
    expect(send.click).toHaveBeenCalledTimes(2);
    expect(acceptance).toHaveBeenCalledTimes(2);
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
    expect(internal().workPage).toBe(page);
    expect(browserFixtures.prepare).toHaveBeenCalledTimes(2);
    expect(browserFixtures.readMedia.mock.calls.every(([, anchor]) => anchors.includes(anchor))).toBe(true);
  });
  it("uses a ready login page instead of waiting forever on a stale work page", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, context, send } = reusablePage();
    const stale = { ...page, url: () => "https://muse.ai/stale", evaluate: vi.fn(), goto: vi.fn() };
    internal().workPage = stale;
    internal().loginPage = page;
    context.pages.mockReturnValue([stale, page]);
    internal().pageSession.mockImplementation(async (candidate: unknown) => candidate === stale ? { status: "checking" } : { status: "connected" });
    browserFixtures.readMedia.mockResolvedValue([{ src: "https://media.fbcdn.net/current.png", kind: "image", width: 1, height: 1 }]);
    vi.spyOn(internal(), "download").mockResolvedValue(undefined);
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    internal().pending.delete(job.id);
    const running = internal().run(job, validateMuseRequest(request()));
    await vi.advanceTimersByTimeAsync(4500);
    await running;
    expect(job.status).toBe("completed");
    expect(internal().workPage).toBe(page);
    expect(browserFixtures.readMedia).toHaveBeenCalledWith(page, job.turnAnchor);
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled(); expect(stale.goto).not.toHaveBeenCalled();
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("keeps an optimistic message submitting until positive acknowledgement without clicking send again", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, send, acceptance } = reusablePage();
    acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { submitted: true, status: "submitting", turnAnchor: privateAnchor });
    browserFixtures.delivery.mockResolvedValueOnce({ state: "pending" }).mockResolvedValue({ state: "accepted" });
    let accepted = false;
    const waiting = internal().waitForAcceptance(page, job, pollingSignals).then(() => { accepted = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(accepted).toBe(false);
    expect(browserFixtures.delivery).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("submitting");
    expect(job.deliveryConfirmed).not.toBe(true);
    await vi.advanceTimersByTimeAsync(4500);
    await waiting;
    expect(accepted).toBe(true);
    expect(browserFixtures.delivery).toHaveBeenCalledTimes(2);
    expect(browserFixtures.delivery).toHaveBeenCalledWith(page, privateAnchor);
    expect(job.deliveryConfirmed).toBe(true);
    expect(send.click).not.toHaveBeenCalled();
    expect(job.submitted).toBe(true);
  });
  it("acknowledges a fully matched latest pending turn when the Muse avatar is working without assistant text", async () => {
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, send, acceptance } = reusablePage();
    acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { submitted: true, status: "submitting", turnAnchor: privateAnchor });
    browserFixtures.delivery.mockResolvedValue({ state: "pending", diagnostic: {
      reason: "no-assistant-content", userCount: 2, bubbleCount: 2, expectedIndex: 1, targetIndex: 1,
      emptyUserBubbleCount: 0, nestedBubbleCount: 0, assistantCount: 0,
      candidateHashMatches: true, prefixMatches: true, matchingPromptIndices: [1],
    } });
    browserFixtures.activity.mockResolvedValue({ working: true, message: "努力工作中" });
    await internal().waitForAcceptance(page, job, pollingSignals);
    expect(job).toMatchObject({ deliveryConfirmed: true, message: "Muse 努力工作中" });
    expect(browserFixtures.delivery).toHaveBeenCalledExactlyOnceWith(page, privateAnchor);
    expect(browserFixtures.activity).toHaveBeenCalledExactlyOnceWith(page);
    expect(browserFixtures.readMedia).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();
  });
  it.each([
    { name: "missing target", state: "missing", diagnostic: {} },
    { name: "ambiguous target", state: "ambiguous", diagnostic: {} },
    { name: "a later user turn", state: "pending", diagnostic: { userCount: 3 } },
    { name: "a later repeated prompt", state: "pending", diagnostic: { userCount: 3, matchingPromptIndices: [1, 2] } },
    { name: "a different prompt", state: "pending", diagnostic: { candidateHashMatches: false } },
    { name: "a different context", state: "pending", diagnostic: { prefixMatches: false } },
  ])("does not acknowledge $name from global Muse avatar activity", async ({ state, diagnostic }) => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, send, acceptance } = reusablePage();
    acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { submitted: true, status: "submitting", turnAnchor: privateAnchor });
    browserFixtures.delivery.mockResolvedValue({ state, diagnostic: {
      reason: "no-assistant-content", userCount: 2, bubbleCount: 2, expectedIndex: 1, targetIndex: 1,
      emptyUserBubbleCount: 0, nestedBubbleCount: 0, assistantCount: 0,
      candidateHashMatches: true, prefixMatches: true, matchingPromptIndices: [1], ...diagnostic,
    } });
    browserFixtures.activity.mockResolvedValue({ working: true, message: "努力工作中" });
    let closed = false;
    vi.spyOn(page, "isClosed").mockImplementation(() => closed);
    const waiting = internal().waitForAcceptance(page, job, pollingSignals).then(
      () => ({ accepted: true }),
      () => ({ accepted: false }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const confirmed = job.deliveryConfirmed;
    closed = true;
    await vi.advanceTimersByTimeAsync(1500);
    const outcome = await waiting;
    expect(confirmed).not.toBe(true);
    expect(outcome.accepted).toBe(false);
    expect(job.status).toBe("submitting");
    expect(browserFixtures.readMedia).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();
  });
  it("leaves a submitted job recoverable when the page closes during acceptance observation", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, send, acceptance } = reusablePage();
    acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { submitted: true, status: "submitting", turnAnchor: privateAnchor, conversationUrl: "https://muse.ai/thread/original-123" });
    browserFixtures.delivery.mockResolvedValue({ state: "pending" });
    let closed = false;
    vi.spyOn(page, "isClosed").mockImplementation(() => closed);
    const waiting = internal().waitForAcceptance(page, job, pollingSignals);
    const rejected = expect(waiting).rejects.toThrow(/关闭|中断|恢复/);
    await vi.advanceTimersByTimeAsync(1);
    closed = true;
    await vi.advanceTimersByTimeAsync(4500);
    await rejected;
    expect(job.submitted).toBe(true);
    expect(job.conversationUrl).toBe("https://muse.ai/thread/original-123");
    expect(send.click).not.toHaveBeenCalled();
  });
  it("keeps temporary Still sending pending until it becomes accepted", async () => {
    vi.useFakeTimers(); online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, send, acceptance } = reusablePage(); acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    job.turnAnchor = privateAnchor;
    browserFixtures.delivery.mockResolvedValueOnce({ state: "unconfirmed", message: "Still sending..." }).mockResolvedValue({ state: "accepted" });
    const waiting = internal().waitForAcceptance(page, job, pollingSignals);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe("submitting"); expect(job.deliveryConfirmed).not.toBe(true);
    await vi.advanceTimersByTimeAsync(1500); await waiting;
    expect(job.deliveryConfirmed).toBe(true); expect(send.click).not.toHaveBeenCalled();
  });
  it.each(["https://muse.ai/thread/different-456", "https://accounts.example.test/login"])("stops receipt observation after leaving the original conversation: %s", async url => {
    online(); vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, acceptance, setUrl } = reusablePage(); acceptance.mockRestore();
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    job.turnAnchor = privateAnchor;
    job.conversationUrl = "https://muse.ai/thread/original-123"; setUrl(url);
    await expect(internal().waitForAcceptance(page, job, pollingSignals)).rejects.toThrow("离开原聊天");
  });
  it("does not bind a homepage submission to an unrelated thread after navigation", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { send, setUrl, acceptance } = reusablePage("https://muse.ai/");
    send.click.mockImplementation(async () => { setUrl("https://muse.ai/thread/unrelated-456"); });
    browserFixtures.delivery.mockResolvedValue({ state: "missing" });
    acceptance.mockRejectedValue(new Error("observation stopped"));
    await service.create(request());
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("interrupted"));
    expect((await service.get("muse-test-0001")).conversationUrl).toBe("https://muse.ai/");
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("surfaces unconfirmed delivery after one send instead of pretending to generate", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { send, acceptance } = reusablePage("https://muse.ai/");
    acceptance.mockRestore();
    browserFixtures.delivery.mockResolvedValue({ state: "unconfirmed", message: "未确认送达" });
    await service.create(request());
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("interrupted"));
    expect((await service.get("muse-test-0001")).error).toContain("未确认送达");
    expect(internal().jobs.get("muse-test-0001").submitted).toBe(true);
    expect(internal().jobs.get("muse-test-0001").deliveryConfirmed).not.toBe(true);
    expect(browserFixtures.readMedia).not.toHaveBeenCalled();
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("recovers a privately anchored homepage turn without a thread URL or resending", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { send, page, composer, context } = reusablePage("https://muse.ai/");
    vi.spyOn(internal(), "launch").mockResolvedValue(context);
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { status: "interrupted", submitted: true, turnAnchor: privateAnchor });
    browserFixtures.delivery.mockResolvedValue({ state: "accepted" });
    browserFixtures.readMedia.mockResolvedValue([{ src: "https://media.fbcdn.net/resumed.png", kind: "image", width: 1, height: 1 }]);
    vi.spyOn(internal(), "download").mockResolvedValue(undefined);
    await service.resume(job.id);
    internal().pending.delete(job.id);
    const running = internal().run(job, undefined);
    await vi.advanceTimersByTimeAsync(4500);
    await running;
    expect(job.status).toBe("completed");
    expect(browserFixtures.delivery).toHaveBeenCalledWith(page, privateAnchor);
    expect(browserFixtures.readMedia).toHaveBeenCalledWith(page, privateAnchor);
    expect(browserFixtures.prepare).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled(); expect(composer.fill).not.toHaveBeenCalled();
    expect(browserFixtures.upload).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled();
  });
  it("rechecks website delivery failure while observing generation", async () => {
    vi.spyOn(service, "session").mockResolvedValue({ status: "connected" });
    const { send } = reusablePage();
    browserFixtures.delivery.mockResolvedValue({ state: "failed" });
    await service.create(request());
    await vi.waitFor(async () => expect((await service.get("muse-test-0001")).status).toBe("interrupted"));
    expect((await service.get("muse-test-0001")).error).toContain("发送失败");
    expect(send.click).toHaveBeenCalledTimes(1);
    expect(browserFixtures.readMedia).not.toHaveBeenCalled();
  });
  it("waits for transport readiness before changing the composer or uploading", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { send, composer, acceptance } = reusablePage();
    browserFixtures.readiness.mockResolvedValue({ ready: false, message: "Muse 正在重连，尚未发送" });
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    internal().pending.delete(job.id);
    const running = internal().run(job, validateMuseRequest(request()));
    await vi.advanceTimersByTimeAsync(4500);
    expect(job.message).toContain("重连");
    expect(composer.fill).not.toHaveBeenCalled(); expect(send.click).not.toHaveBeenCalled();
    expect(browserFixtures.upload).not.toHaveBeenCalled();
    browserFixtures.readiness.mockResolvedValue({ ready: true });
    acceptance.mockRejectedValue(new Error("end observation"));
    const rejection = expect(running).rejects.toThrow("end observation");
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;
    expect(send.click).toHaveBeenCalledTimes(1);
  });
  it("resumes the original marked turn on the existing page without uploading, filling or sending again", async () => {
    vi.useFakeTimers();
    online();
    vi.spyOn(internal(), "persist").mockResolvedValue(undefined);
    const { page, context, send, composer } = reusablePage("https://muse.ai/thread/other-456");
    await service.create(request());
    const job = internal().jobs.get("muse-test-0001");
    Object.assign(job, { status: "interrupted", submitted: true, turnMarker: "[DrawStudio task: muse-test-0001]", conversationUrl: "https://muse.ai/thread/original-123" });
    browserFixtures.readMedia.mockResolvedValue([{ src: "https://media.fbcdn.net/resumed.png", kind: "image", width: 1, height: 1 }]);
    vi.spyOn(internal(), "download").mockResolvedValue(undefined);
    await service.resume(job.id);
    internal().pending.delete(job.id);
    const running = internal().run(job, undefined);
    await vi.advanceTimersByTimeAsync(4500);
    await running;
    expect(job.status).toBe("completed");
    expect(page.goto).toHaveBeenCalledExactlyOnceWith("https://muse.ai/thread/original-123", { waitUntil: "domcontentloaded" });
    expect(browserFixtures.readMedia).toHaveBeenCalledWith(page, "[DrawStudio task: muse-test-0001]");
    expect(browserFixtures.prepare).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
    expect(browserFixtures.upload).not.toHaveBeenCalled(); expect(composer.fill).not.toHaveBeenCalled(); expect(send.click).not.toHaveBeenCalled();
  });
  it("does not turn unfinished queued jobs into new generations after restarting", async () => {
    online(); await service.create(request());
    await service.close(); service = new MuseBrowserService(root);
    expect((await service.get("muse-test-0001")).status).toBe("failed");
    expect(internal().pending.size).toBe(0);
  });
});

describe("Muse result saving", () => {
  function response(bytes: Buffer, status = 200, headers = {}) {
    return { ok: () => status === 200, status: () => status, headers: () => headers, body: async () => bytes, dispose: vi.fn() };
  }
  const media = [{ src: "https://media.fbcdn.net/result.png", kind: "image", width: 1, height: 1 }];
  it("saves binary media by hash and exposes only this job's output", async () => {
    online(); await service.create(request());
    const get = vi.fn().mockResolvedValue(response(png));
    await internal().download({ context: () => ({ request: { get } }) }, internal().jobs.get("muse-test-0001"), media);
    const job = await service.get("muse-test-0001");
    expect(job.outputs![0].mime).toBe("image/png");
    const output = await service.media(job.id, job.outputs![0].id);
    expect(await fs.readFile(output.path)).toEqual(png);
    await expect(service.media(job.id, "../secret")).rejects.toThrow();
  });
  it("does not save login HTML or follow redirects to unrelated hosts", async () => {
    online(); await service.create(request());
    const get = vi.fn().mockResolvedValue(response(Buffer.from("<html>Login</html>")));
    const page = { context: () => ({ request: { get } }) };
    const job = internal().jobs.get("muse-test-0001");
    await expect(internal().download(page, job, media)).rejects.toThrow("有效的目标媒体");
    get.mockResolvedValue(response(Buffer.alloc(0), 302, { location: "https://unrelated.test/secret" }));
    await expect(internal().download(page, job, media)).rejects.toThrow("未识别的地址");
    expect(job.outputs).toBeUndefined();
  });
});

