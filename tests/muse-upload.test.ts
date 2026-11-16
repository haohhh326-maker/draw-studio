import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { museFileAccepts, museUploadPending, uploadMuseReferences, type MuseUploadFile } from "../scripts/muse-upload";

let engine: Browser, context: BrowserContext, page: Page;
const file = (name: string, mime: string): MuseUploadFile => ({ name, mime, dataBase64: Buffer.from("local fixture media bytes").toString("base64") });
const mixed = [file("first.png", "image/png"), file("second.mp4", "video/mp4"), file("third.mp3", "audio/mpeg")];
beforeAll(async () => { engine = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); });
beforeEach(async () => { context = await engine.newContext(); page = await context.newPage(); });
afterEach(async () => { await context?.close(); });
afterAll(async () => { await engine?.close(); });

async function composer(options: { accept?: string; multiple?: boolean; outside?: boolean; error?: string; pending?: boolean; existing?: boolean } = {}) {
  const accept = options.accept ?? "image/*,video/*,audio/*";
  await page.setContent(`<!doctype html><title>Local Muse upload fixture</title>
    ${options.outside ? '<aside><input id="avatar" type="file" accept="image/*"><button type="button" aria-label="Remove file">Unrelated sidebar file</button></aside>' : ""}
    <form id="composer"><span data-testid="hatch-composer-placeholder-overlay"></span>
    <textarea placeholder="消息"></textarea>
    <input id="reference" type="file" accept="${accept}" ${options.multiple === false ? "" : "multiple"}>
    <div id="attachments">${options.existing ? '<button type="button" aria-label="Remove attachment">Unsent file</button>' : ""}</div>
    <button type="button" id="send">Send</button></form>`);
  await page.evaluate(({ error, pending }) => {
    const state = window as typeof window & { received: { input: string; name: string; mime: string }[]; sent: number };
    state.received = []; state.sent = 0;
    document.querySelector("#send")!.addEventListener("click", () => { state.sent++; });
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="file"]')) input.addEventListener("change", () => {
      for (const file of Array.from(input.files ?? [])) {
        state.received.push({ input: input.id, name: file.name, mime: file.type });
        if (!error) {
          const remove = document.createElement("button"); remove.type = "button"; remove.setAttribute("aria-label", "Remove attachment"); remove.textContent = file.name;
          document.querySelector("#attachments")!.append(remove);
        }
      }
      if (error) { const alert = document.createElement("div"); alert.setAttribute("role", "alert"); alert.textContent = error; document.querySelector("form")!.append(alert); }
      if (pending) { const progress = document.createElement("div"); progress.setAttribute("role", "progressbar"); document.querySelector("form")!.append(progress); }
    });
  }, { error: options.error, pending: options.pending });
}
const received = () => page.evaluate(() => (window as unknown as { received: { input: string; name: string; mime: string }[] }).received);

describe("Muse live picker contract on an isolated local page", () => {
  it.each([
    ["clip.mp4", "video/mp4"], ["clip.mov", "video/quicktime"], ["clip.webm", "video/webm"],
  ])("passes %s to a video-enabled picker with its MIME type", async (name, mime) => {
    await composer({ accept: "image/*,video/*,audio/*" });
    await uploadMuseReferences(page, [file(name, mime)], () => false);
    expect(await received()).toEqual([{ input: "reference", name, mime }]);
  });
  it("matches MIME wildcards, exact MIME and filename extensions without widening accept", () => {
    expect(museFileAccepts("image/*, .MP3, video/mp4", mixed[0])).toBe(true);
    expect(museFileAccepts("image/*, .MP3, video/mp4", mixed[1])).toBe(true);
    expect(museFileAccepts("image/*, .MP3, video/mp4", mixed[2])).toBe(true);
    expect(museFileAccepts("image/png", mixed[1])).toBe(false);
    expect(museFileAccepts("", mixed[2])).toBe(true);
  });
  it("uploads mixed image/video/audio together in their original order", async () => {
    await composer();
    await uploadMuseReferences(page, mixed, () => false);
    expect(await received()).toEqual(mixed.map(f => ({ input: "reference", name: f.name, mime: f.mime })));
    expect(await page.locator("#reference").getAttribute("accept")).toBe("image/*,video/*,audio/*");
  });
  it("uploads sequentially when the website picker does not permit multiple files", async () => {
    await composer({ multiple: false });
    await uploadMuseReferences(page, mixed, () => false);
    expect((await received()).map(f => f.name)).toEqual(mixed.map(f => f.name));
    expect(await page.locator("#reference").getAttribute("multiple")).toBeNull();
  });
  it("does not impose the former four-reference count cap", async () => {
    await composer();
    const files = Array.from({ length: 9 }, (_, i) => file(`reference-${i}.png`, "image/png"));
    await uploadMuseReferences(page, files, () => false);
    expect((await received()).map(f => f.name)).toEqual(files.map(f => f.name));
  });
  it("rejects media outside the picker accept list before any upload or send", async () => {
    await composer({ accept: "image/*" });
    await expect(uploadMuseReferences(page, [mixed[1]], () => false)).rejects.toThrow("未接受此素材格式");
    expect(await received()).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { sent: number }).sent)).toBe(0);
    expect(await page.locator("#reference").getAttribute("accept")).toBe("image/*");
  });
  it("propagates an upload rejection without reaching the caller's send step", async () => {
    await composer({ error: "Upload failed: unsupported file" });
    const submit = async () => { await uploadMuseReferences(page, mixed, () => false); await page.locator("#send").click(); };
    await expect(submit()).rejects.toThrow("Upload failed");
    expect(await page.evaluate(() => (window as unknown as { sent: number }).sent)).toBe(0);
  });
  it("waits for upload completion even after attachment cards appear", async () => {
    await composer({ pending: true });
    let complete = false;
    const uploading = uploadMuseReferences(page, mixed, () => false).then(() => { complete = true; });
    await expect.poll(async () => (await received()).length).toBe(3);
    expect(await museUploadPending(page)).toBe(true); expect(complete).toBe(false);
    await page.locator('[role="progressbar"]').evaluateAll(elements => elements.forEach(el => el.remove()));
    await uploading; expect(complete).toBe(true);
  });
  it("ignores unrelated file controls outside the composer", async () => {
    await composer({ outside: true });
    await uploadMuseReferences(page, [mixed[0]], () => false);
    expect(await received()).toEqual([{ input: "reference", name: mixed[0].name, mime: mixed[0].mime }]);
  });
  it("blocks stale unsent attachments even for a text-only generation", async () => {
    await composer({ existing: true });
    await expect(uploadMuseReferences(page, [], () => false)).rejects.toThrow("未发送附件");
    expect(await received()).toEqual([]);
  });
  it("appends files selected in the canvas chat window without clearing earlier attachments", async () => {
    await composer();
    await uploadMuseReferences(page, [mixed[0]], () => false, { append: true });
    await uploadMuseReferences(page, [mixed[1]], () => false, { append: true });
    expect((await received()).map(item => item.name)).toEqual([mixed[0].name, mixed[1].name]);
    expect(await page.locator('[aria-label="Remove attachment"]').count()).toBe(2);
  });
  it("does not upload a combined batch after the connection has closed", async () => {
    await composer();
    await expect(uploadMuseReferences(page, mixed, () => true)).rejects.toThrow("连接已关闭");
    expect(await received()).toEqual([]);
  });
});
