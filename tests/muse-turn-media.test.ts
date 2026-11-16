import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readMuseTurnMedia } from "../scripts/muse-turn-media";
import { readMuseDeliveryState } from "../scripts/muse-delivery-state";

// Exercise the actual serialized browser functions, with every request intercepted.
let browser: Browser, context: BrowserContext, page: Page;
const marker = "[DrawStudio task: task-current]";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const videoData = "data:video/mp4;base64,AAAA";
const image = (name: string) => `<img src="${png}#${name}">`;
const video = (name: string) => `<video src="${videoData}#${name}"></video>`;
const attachment = (type: string, ...media: string[]) => `<div data-testid="hatch-chat-attachment-presentation-${type}">${media.join("")}</div>`;
const bubble = (role: "user" | "assistant", text: string, ...children: string[]) => `<section><div class="hatch-chat-groupable-bubble"><div class="${role === "user" ? "chat-user-bubble" : "hatch-agent-bubble-bg"}">${text}${children.join("")}</div></div></section>`;
const grouped = (...children: string[]) => `<div class="group/msg">${children.join("")}</div>`;
async function fixture(...children: string[]) {
  await page.setContent(`<!doctype html><title>Muse media reader fixture</title><style>
    section, .hatch-chat-groupable-bubble { min-height: 20px; }
    img, video { width: 40px; height: 40px; }
  </style><main>${children.join("")}</main>`);
  await page.locator("img, video").evaluateAll(elements => {
    for (const element of elements) {
      const properties = element instanceof HTMLVideoElement ? { videoWidth: 1280, videoHeight: 720 } : { naturalWidth: 640, naturalHeight: 480 };
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(element, key, { configurable: true, value });
    }
  });
}
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); });
beforeEach(async () => {
  context = await browser.newContext();
  await context.route("**/*", route => route.request().url() === "https://muse-fixture.test/"
    ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }) : route.abort());
  page = await context.newPage(); await page.goto("https://muse-fixture.test/");
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("Muse turn media", () => {
  it("isolates this turn's image and video from old and next-turn outputs", async () => {
    await fixture(
      bubble("user", "Old prompt"), bubble("assistant", "Old result", attachment("image", image("old"))),
      bubble("user", "Current prompt " + marker, attachment("image", image("reference"))),
      bubble("assistant", "Current results", attachment("image", image("current-image")), attachment("video", video("current-video"))),
      bubble("user", "Next prompt"), bubble("assistant", "Next result", attachment("image", image("next"))),
    );
    expect(await readMuseTurnMedia(page, marker)).toEqual([
      { src: png + "#current-image", kind: "image", width: 640, height: 480 },
      { src: videoData + "#current-video", kind: "video", width: 1280, height: 720 },
    ]);
  });

  it("uses the same standalone results for legacy-marker delivery and media collection", async () => {
    await fixture(
      bubble("user", "Old prompt"), attachment("image", image("old")),
      grouped(bubble("user", marker, attachment("image", image("reference")))),
      attachment("image", image("current-image")), attachment("video", image("poster"), video("current-video")),
      grouped(attachment("image", image("next-upload-before-text")), bubble("user", "Next prompt")),
      attachment("image", image("later")),
    );
    expect((await readMuseDeliveryState(page, marker)).state).toBe("accepted");
    expect((await readMuseTurnMedia(page, marker)).map(media => [media.kind, media.src])).toEqual([
      ["image", png + "#current-image"], ["video", videoData + "#current-video"],
    ]);
  });

  it("keeps unanchored legacy jobs compatible with all assistant outputs in the conversation", async () => {
    await fixture(
      bubble("assistant", "Old", attachment("image", image("old"))),
      bubble("user", marker, attachment("video", video("user-upload"))),
      bubble("assistant", "Current", attachment("video", video("current"))),
      bubble("user", "Next"), bubble("assistant", "Next", attachment("image", image("next"))),
    );
    expect((await readMuseTurnMedia(page)).map(media => media.src)).toEqual([
      png + "#old", videoData + "#current", png + "#next",
    ]);
  });

  it.each(["missing", "duplicate", "assistant-only", "empty"])("fails closed for a %s anchor", async scenario => {
    await fixture(
      bubble("assistant", scenario === "assistant-only" ? marker : "Old", attachment("image", image("old"))),
      bubble("user", scenario === "duplicate" ? marker : "[DrawStudio task: task-current-other]"),
      bubble("assistant", "Result", attachment("image", image("current"))), attachment("image", image("standalone-current")),
      ...(scenario === "duplicate" ? [bubble("user", marker), attachment("video", video("later"))] : []),
    );
    expect(await readMuseTurnMedia(page, scenario === "empty" ? "" : marker)).toEqual([]);
  });

  it("requires assistant ownership for unclassified bubbles and stops at the next user", async () => {
    await fixture(
      bubble("user", marker),
      `<div class="hatch-chat-groupable-bubble">${attachment("image", image("unclassified"))}</div>`,
      bubble("assistant", "Accepted", image("assistant")),
      bubble("user", "Next prompt"), bubble("assistant", "Excluded", image("next")),
    );
    expect((await readMuseTurnMedia(page, marker)).map(media => media.src)).toEqual([png + "#assistant"]);
  });

  it("finds a legacy marker inside a real group/msg user row and stops at the next grouped user", async () => {
    await fixture(
      grouped(bubble("user", "Old prompt")), bubble("assistant", "Old result", image("old")),
      grouped(bubble("user", marker, attachment("image", image("uploaded")))),
      bubble("assistant", "Current result", attachment("image", image("current"))),
      grouped(bubble("user", "Next prompt")), bubble("assistant", "Later result", image("later")),
    );
    expect((await readMuseTurnMedia(page, marker)).map(media => media.src)).toEqual([png + "#current"]);
  });

  it.each([undefined, marker])("excludes forms, previews and user uploads with marker %s", async taskMarker => {
    await fixture(
      `<form>${attachment("image", image("composer"))}</form>`, grouped(attachment("video", video("preview"))),
      bubble("user", marker, attachment("image", image("uploaded"))),
      bubble("assistant", "Answer", attachment("image", image("output")),
        `<form>${attachment("image", image("nested-form"))}</form>`, grouped(attachment("video", video("nested-preview")))),
    );
    expect((await readMuseTurnMedia(page, taskMarker)).map(media => media.src)).toEqual([png + "#output"]);
  });

  it.each([undefined, marker])("deduplicates URLs and never returns video thumbnails with marker %s", async taskMarker => {
    await fixture(bubble("user", marker), bubble("assistant", "Result",
      attachment("video", image("thumbnail"), video("result")), attachment("video", image("still-generating")),
      attachment("image", image("duplicate")), image("duplicate"), image("avatar"), image("emoji"),
    ));
    expect((await readMuseTurnMedia(page, taskMarker)).map(media => [media.src, media.kind])).toEqual([
      [videoData + "#result", "video"], [png + "#duplicate", "image"],
    ]);
  });

  it("uses currentSrc and intrinsic dimensions, leaving readiness checks to the caller", async () => {
    await fixture(bubble("user", marker), bubble("assistant", "Result", image("unloaded"), video("unloaded")));
    await page.locator("img, video").evaluateAll(elements => {
      for (const element of elements) {
        const keys = element instanceof HTMLVideoElement ? ["videoWidth", "videoHeight"] : ["naturalWidth", "naturalHeight"];
        for (const key of keys) Object.defineProperty(element, key, { configurable: true, value: 0 });
        if (element instanceof HTMLImageElement) Object.defineProperty(element, "currentSrc", { configurable: true, value: "https://media.fbcdn.net/selected.png" });
      }
    });
    expect(await readMuseTurnMedia(page, marker)).toEqual([
      { src: "https://media.fbcdn.net/selected.png", kind: "image", width: 0, height: 0 },
      { src: videoData + "#unloaded", kind: "video", width: 0, height: 0 },
    ]);
  });
});
