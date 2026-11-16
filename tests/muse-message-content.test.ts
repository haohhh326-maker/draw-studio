import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { prepareMuseTurnAnchor, readMuseTurnSnapshot, type MuseTurnAnchor } from "../scripts/muse-turn-anchor";

// The observed Muse user bubble contains a speaker label in span.sr-only and
// the visible prompt in p.whitespace-pre-wrap. Only this isolated fixture runs.
let browser: Browser, context: BrowserContext, page: Page;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const hash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
const userMessage = (body: string, speaker = "用户") => `<section><div class="hatch-chat-groupable-bubble bg-chat-user-bubble"><span class="sr-only">${speaker}</span><p class="text-[16px] leading-[22px] whitespace-pre-wrap">${body}</p></div></section>`;
const assistant = (name: string) => `<section><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg"><img src="${png}#${name}"></div></section>`;
const legacyUser = (body: string) => `<section><div class="hatch-chat-groupable-bubble chat-user-bubble">${body}</div></section>`;
async function fixture(content: string) {
  await page.setContent(`<!doctype html><title>Muse message content fixture</title><style>
    section, .hatch-chat-groupable-bubble { min-height: 20px; }
    img { width: 40px; height: 40px; }
    .whitespace-pre-wrap { white-space: pre-wrap; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border-width: 0; }
  </style><main>${content}</main>`);
}
function persistedAnchor(prompt: string, preceding: string[] = []): MuseTurnAnchor {
  return JSON.parse(JSON.stringify({ promptHash: hash(prompt), precedingUserHashes: preceding.map(hash) }));
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

describe("Muse visible prompt content with compatible history anchors", () => {
  it("recovers an existing anchor whose two history hashes include sr-only labels", async () => {
    const anchor = persistedAnchor("生成三视图", ["用户 第一条", "用户 第二条"]);
    await fixture(userMessage("第一条") + assistant("old-one") + userMessage("第二条") + assistant("old-two")
      + userMessage("生成三视图") + assistant("current"));
    const result = await readMuseTurnSnapshot(page, anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: {
      expectedIndex: 2, prefixMatches: true, candidateHashMatches: true, targetTextLength: 5, targetRawTextLength: 7,
    } });
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("prepares canonical history while retaining legacy whole-bubble hashes", async () => {
    await fixture(userMessage("第一条", "图像") + userMessage("第二条", "视频"));
    expect(await prepareMuseTurnAnchor(page, "下一条")).toEqual({ ...persistedAnchor("下一条", ["图像 第一条", "视频 第二条"]),
      precedingUserPromptHashes: [hash("第一条"), hash("第二条")], preparationId: expect.any(String), pageUrl: "https://muse-fixture.test/" });
  });

  it("rebinds after server receipt replaces the prompt and speaker-label rendering", async () => {
    await fixture(userMessage("第一条", "用户"));
    const anchor = await prepareMuseTurnAnchor(page, "生成三视图");
    await fixture(userMessage("第一条", "图像") + userMessage("生成三视图", "用户"));
    expect((await readMuseTurnSnapshot(page, anchor)).delivery.state).toBe("pending");
    await fixture(userMessage("第一条", "用户") + userMessage("生成三视图", "图像") + assistant("current"));
    const result = await readMuseTurnSnapshot(page, anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: { prefixMatches: true, candidateHashMatches: true } });
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("recovers a unique shifted target while retaining whole-bubble history hashes with speaker labels", async () => {
    const anchor = persistedAnchor("生成三视图", ["用户 第一条", "图像 第二条"]);
    await fixture(userMessage("第二条", "图像") + userMessage("生成三视图") + assistant("current"));
    const result = await readMuseTurnSnapshot(page, anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: { expectedIndex: 2, candidateHashMatches: true, prefixMatches: true } });
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("reports canonical visible prompt matches when repeated labeled prompts prevent shifted recovery", async () => {
    const anchor = persistedAnchor("生成三视图", ["用户 第一条", "用户 第二条", "用户 第三条"]);
    await fixture(userMessage("生成三视图") + assistant("earlier") + userMessage("生成三视图") + assistant("later"));
    const result = await readMuseTurnSnapshot(page, anchor);
    expect(result.delivery).toMatchObject({ state: "missing", diagnostic: { reason: "target-absent", matchingPromptIndices: [0, 1] } });
    expect(result.media).toEqual([]);
  });

  it.each(["图像", "视频", "用户", "保留图像和视频文字", "正文里的 sr-only 不是辅助标签"])("preserves literal prompt wording: %s", async prompt => {
    await fixture(userMessage(prompt, "图像") + assistant("current"));
    expect((await readMuseTurnSnapshot(page, persistedAnchor(prompt))).delivery.state).toBe("accepted");
  });

  it("does not accept the speaker label when the actual visible prompt differs", async () => {
    await fixture(userMessage("不同的正文", "图像") + assistant("unrelated"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("图像"));
    expect(result.delivery).toMatchObject({ state: "missing", diagnostic: { reason: "prompt-mismatch" } });
    expect(result.media).toEqual([]);
  });

  it("does not fall back to the whole bubble when its label and body together match", async () => {
    await fixture(userMessage("风景", "图像") + assistant("unrelated"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("图像 风景"));
    expect(result.delivery.state).toBe("missing"); expect(result.media).toEqual([]);
  });

  it("does not use a speaker label as an empty visible prompt", async () => {
    await fixture(userMessage("", "图像") + assistant("unrelated"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("图像"));
    expect(result.delivery.state).toBe("missing"); expect(result.media).toEqual([]);
  });

  it("does not accept a matching leaf inside a longer visible prompt", async () => {
    await fixture(userMessage("请先<span>生成三视图</span>再添加说明") + assistant("unrelated"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("生成三视图"));
    expect(result.delivery.state).toBe("missing"); expect(result.media).toEqual([]);
  });

  it("keeps visible tool-like labels instead of stripping words from the prompt", async () => {
    await fixture(legacyUser('<span>图像</span><p class="whitespace-pre-wrap">生成三视图</p>') + assistant("unrelated"));
    expect((await readMuseTurnSnapshot(page, persistedAnchor("生成三视图"))).delivery.state).toBe("missing");
    expect((await readMuseTurnSnapshot(page, persistedAnchor("图像 生成三视图"))).delivery.state).toBe("accepted");
  });

  it("isolates the middle of three identical prompts with speaker labels", async () => {
    const prompt = "生成三视图", previous = userMessage(prompt) + assistant("previous");
    await fixture(previous); const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(previous + userMessage(prompt) + assistant("current") + userMessage(prompt) + assistant("later"));
    const result = await readMuseTurnSnapshot(page, anchor);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });

  it("does not move to a later matching prompt when the expected candidate differs", async () => {
    await fixture(userMessage("第一条") + userMessage("错误的当前正文") + assistant("wrong")
      + userMessage("生成三视图") + assistant("later"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("生成三视图", ["用户 第一条"]));
    expect(result.delivery).toMatchObject({ state: "missing", diagnostic: { expectedIndex: 1, prefixMatches: true } });
    expect(result.media).toEqual([]);
  });

  it("still rejects a changed legacy history label", async () => {
    await fixture(userMessage("第一条", "变更") + userMessage("生成三视图") + assistant("unrelated"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("生成三视图", ["用户 第一条"]));
    expect(result.delivery).toMatchObject({ state: "missing", diagnostic: { candidateHashMatches: true, reason: "prefix-mismatch" } });
    expect(result.media).toEqual([]);
  });

  it("retains legacy plain user-message matching", async () => {
    await fixture(legacyUser("旧消息") + legacyUser("生成三视图") + assistant("current"));
    const result = await readMuseTurnSnapshot(page, persistedAnchor("生成三视图", ["旧消息"]));
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(media => media.src)).toEqual([png + "#current"]);
  });
});
