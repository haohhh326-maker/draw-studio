import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { prepareMuseTurnAnchor, readMuseTurnSnapshot, type MuseTurnReference } from "../scripts/muse-turn-anchor";
import { readMuseTurnMedia } from "../scripts/muse-turn-media";

// All pages and media are synthetic. No account, user profile or Muse request.
let browser: Browser, context: BrowserContext, page: Page;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const video = "data:video/mp4;base64,AAAA";
const image = (name: string) => `<img src="${png}#${name}">`;
const imageCard = (name: string, extra = "") => `<div data-testid="hatch-chat-attachment-presentation-image">${extra}${image(name)}</div>`;
const videoCard = (name: string, media = true) => `<div data-testid="hatch-chat-attachment-presentation-video">${image(name + "-poster")}${media ? `<video src="${video}#${name}"></video>` : ""}</div>`;
const resultButton = (kind: "image" | "video", name: string, busy = false) => `<button class="hatch-chat-groupable-bubble" data-pel-click="chat_media_click" aria-busy="${busy}" aria-label="打开生成的${kind === "image" ? "图片" : "视频"}${name}.artifact" title="${name}.artifact">${kind === "video" ? image(name + "-poster") + `<video src="${video}#${name}"></video>` : image(name)}</button>`;
const videoWrapper = (name: string, source = video + "#" + name, attributes = "") => `<div class="hatch-chat-groupable-bubble group rounded-22 relative overflow-hidden bg-black/5" role="button" tabindex="0" aria-label="Open animated video ${name}.mp4" data-hatch-video-wrapper="true" data-hatch-video-src="${video}#${name}" data-hatch-video-poster="${png}#${name}-poster" style="aspect-ratio:1/1;width:80px" ${attributes}><div class="relative h-full w-full"><video hidden src="${source}"></video><img aria-hidden="true" src="${png}#${name}-poster"></div></div>`;
const user = (prompt: string, upload = "", label = "") => `<section><div class="hatch-chat-groupable-bubble bg-chat-user-bubble"><span class="sr-only">用户</span><p class="whitespace-pre-wrap">${prompt}</p>${upload}</div>${label}</section>`;
const anchor = (prompt: string) => ({ promptHash: createHash("sha256").update(prompt).digest("hex"), precedingUserHashes: [] });
async function fixture(content: string) {
  await page.setContent(`<!doctype html><title>Muse standalone media fixture</title><style>
    section, .hatch-chat-groupable-bubble { min-height: 20px; }
    img, video { width: 40px; height: 40px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
  </style><main>${content}</main>`);
  // Decoding an external video is unnecessary for DOM ownership tests. Give
  // these inert data-URL elements the metadata of a loaded local fixture.
  await page.locator("video").evaluateAll(elements => {
    for (const element of elements) {
      Object.defineProperty(element, "videoWidth", { configurable: true, value: 640 });
      Object.defineProperty(element, "videoHeight", { configurable: true, value: 360 });
    }
  });
}
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
});
beforeEach(async () => {
  context = await browser.newContext();
  await context.route("**/*", route => route.request().url() === "https://muse-fixture.test/"
    ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }) : route.abort());
  page = await context.newPage(); await page.goto("https://muse-fixture.test/");
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("Muse standalone attachment results within one verified turn", () => {
  it.each(["private-anchor", "legacy-marker"])("reads metadata from the visible video wrapper with a hidden child for %s", async mode => {
    await fixture(user("Target", videoWrapper("upload")) + videoWrapper("current") + user("Next") + videoWrapper("later"));
    await page.locator("video").evaluateAll(elements => {
      for (const element of elements) {
        Object.defineProperty(element, "videoWidth", { configurable: true, value: 960 });
        Object.defineProperty(element, "videoHeight", { configurable: true, value: 960 });
      }
    });
    const reference = mode === "private-anchor" ? anchor("Target") : "Target";
    const result = await readMuseTurnSnapshot(page, reference);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media).toEqual([{ src: video + "#current", kind: "video", width: 960, height: 960 }]);
    expect((await readMuseTurnMedia(page, reference))).toEqual(result.media);
  });

  it("reads the visible wrapper in the unanchored reader while retaining only video media", async () => {
    await fixture(user("Reference", videoWrapper("upload")) + videoWrapper("current")
      + `<div class="hatch-agent-bubble-bg"><img data-hatch-media-owner="avatar-layer" data-hatch-avatar-layer="ready" aria-hidden="true" src="${png}#cover"></div>`);
    expect(await readMuseTurnMedia(page)).toEqual([{ src: video + "#current", kind: "video", width: 640, height: 360 }]);
  });

  it("rejects hidden wrappers, mismatched video sources, missing metadata and avatar posters", async () => {
    await fixture(user("Target") + videoWrapper("hidden", undefined, "hidden") + videoWrapper("mismatch", video + "#different")
      + videoWrapper("metadata") + `<div class="hatch-agent-bubble-bg"><img data-hatch-media-owner="avatar-layer" data-hatch-avatar-layer="ready" aria-hidden="true" src="${png}#cover"></div>`);
    await page.locator('[data-hatch-video-src$="#metadata"] video').evaluate(element => {
      Object.defineProperty(element, "videoWidth", { configurable: true, value: 0 });
      Object.defineProperty(element, "videoHeight", { configurable: true, value: 0 });
    });
    expect((await readMuseTurnSnapshot(page, anchor("Target"))).media).toEqual([]);
    expect(await readMuseTurnMedia(page)).toEqual([]);
  });

  it.each(["image", "video"] as const)("reads an observed generated %s BUTTON within the recovered original turn", async kind => {
    await fixture(user("Earlier"));
    const reference = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target", imageCard("upload")) + resultButton(kind, "current") + user("Next") + resultButton(kind, "later"));
    const result = await readMuseTurnSnapshot(page, reference);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => [media.kind, media.src])).toEqual([[kind, (kind === "video" ? video : png) + "#current"]]);
  });

  it("keeps unfinished and uploaded BUTTON media outside the generated response", async () => {
    await fixture(user("Target", resultButton("image", "upload")) + resultButton("image", "unfinished", true)
      + `<button class="hatch-chat-groupable-bubble" data-pel-click="chat_media_click" aria-label="打开图片参考.png">${image("ordinary-upload")}</button>`);
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("pending");
    expect(result.media).toEqual([]);
  });

  it("keeps uploaded media BUTTON controls out of the user-message chronology", async () => {
    const previous = user("Earlier", resultButton("image", "previous-upload"));
    await fixture(previous);
    const reference = await prepareMuseTurnAnchor(page, "Target");
    expect(reference.precedingUserHashes).toHaveLength(1);
    await fixture(previous + user("Target", resultButton("image", "current-upload")) + resultButton("image", "current"));
    const result = await readMuseTurnSnapshot(page, reference);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("reads observed generated BUTTON media for the legacy unanchored reader", async () => {
    await fixture(user("Reference", resultButton("image", "upload")) + resultButton("image", "image-result")
      + resultButton("video", "video-result") + resultButton("image", "unfinished", true));
    expect((await readMuseTurnMedia(page)).map(media => [media.kind, media.src])).toEqual([
      ["image", png + "#image-result"], ["video", video + "#video-result"],
    ]);
  });

  it("accepts a standalone image card after the user without an assistant bubble", async () => {
    await fixture(user("Target") + imageCard("current"));
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("accepted");
    expect(result.media).toEqual([{ src: png + "#current", kind: "image", width: 1, height: 1 }]);
  });

  it("accepts a standalone video and excludes its image poster", async () => {
    await fixture(user("Target") + videoCard("current"));
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("accepted");
    expect(result.media).toEqual([{ src: video + "#current", kind: "video", width: 640, height: 360 }]);
  });

  it("does not let a hidden video placeholder mask an image card's visible result", async () => {
    await fixture(user("Target") + imageCard("current", `<video hidden src="${video}#placeholder"></video>`));
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => [media.kind, media.src])).toEqual([["image", png + "#current"]]);
  });

  it("does not turn a video card containing only its poster into an image result", async () => {
    await fixture(user("Target") + videoCard("poster-only", false));
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.media).toEqual([]); expect(result.delivery.state).toBe("pending");
  });

  it("keeps only the current result across repeated prompts, uploads and side previews", async () => {
    const prompt = "Repeat", previous = user(prompt) + imageCard("previous");
    await fixture(previous); const reference = await prepareMuseTurnAnchor(page, prompt);
    await fixture(previous
      + `<div class="group/msg">${user(prompt, imageCard("current-upload"))}</div>`
      + `<form>${imageCard("composer-preview")}</form><aside>${imageCard("side-preview")}</aside>`
      + image("unowned-inline-preview") + imageCard("current")
      + `<div class="group/msg">${imageCard("next-upload-before-text")}${user(prompt)}</div>`
      + imageCard("later"));
    const result = await readMuseTurnSnapshot(page, reference);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("does not mistake upload or aside/form previews alone for an assistant response", async () => {
    await fixture(user("Target", imageCard("current-upload"))
      + `<div class="group/msg">${imageCard("pending-next-upload")}</div>`
      + `<form>${imageCard("composer-preview")}</form><aside>${imageCard("side-preview")}</aside>`);
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.media).toEqual([]); expect(result.delivery.state).toBe("pending");
  });

  it.each(["absent", "wrong", "invalid"])("never takes standalone media with an %s anchor", async variant => {
    await fixture((variant === "absent" ? "" : user("Different")) + imageCard("unrelated") + videoCard("unrelated"));
    const reference: MuseTurnReference = variant === "invalid" ? "" : anchor("Target");
    const result = await readMuseTurnSnapshot(page, reference);
    expect(result.delivery.state).toBe("missing"); expect(result.media).toEqual([]);
  });

  it("keeps a screen-reader-only assistant label and loading placeholder pending", async () => {
    await fixture(user("Target") + '<section><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg"><span class="sr-only">助手</span><p>Loading</p></div></section>');
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("pending"); expect(result.media).toEqual([]);
  });

  it("does not override explicit unconfirmed delivery with a standalone media card", async () => {
    await fixture(user("Target", "", "<span>未确认送达</span>") + imageCard("unconfirmed"));
    const result = await readMuseTurnSnapshot(page, anchor("Target"));
    expect(result.delivery.state).toBe("unconfirmed"); expect(result.media).toEqual([]);
  });
});
