import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { prepareMuseTurnAnchor, readMuseTurnSnapshot, type MuseTurnAnchor } from "../scripts/muse-turn-anchor";
import { readMuseDeliveryState } from "../scripts/muse-delivery-state";
import { readMuseTurnMedia } from "../scripts/muse-turn-media";

// Intercepted HTTPS gives this isolated fixture WebCrypto; no external requests,
// user profile, Muse navigation, login or generation are involved.
let browser: Browser, context: BrowserContext, page: Page;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const image = (name: string) => `<img src="${png}#${name}">`;
const user = (text: string, extra = "", attributes = "") => `<section ${attributes}><div class="hatch-chat-groupable-bubble chat-user-bubble">${text}</div>${extra}</section>`;
const assistant = (content: string, attributes = "") => `<section ${attributes}><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">${content}</div></section>`;
const hash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
async function fixture(content: string) {
  await page.setContent(`<!doctype html><title>Private Muse anchor fixture</title><style>section, .hatch-chat-groupable-bubble { min-height: 20px; } img, video, audio { width: 40px; height: 40px; }</style><main>${content}</main>`);
}
async function read(anchor: MuseTurnAnchor) {
  return { delivery: await readMuseDeliveryState(page, anchor), media: await readMuseTurnMedia(page, anchor) };
}
async function trackObservers() {
  // Initialize Playwright's own selector/polling helpers before instrumenting
  // native observers, so their internal observers are not counted as ours.
  await page.locator("body").count();
  await page.waitForFunction(() => true);
  await page.evaluate(() => {
    const NativeObserver = MutationObserver, active = new Set<MutationObserver>();
    globalThis.MutationObserver = class extends NativeObserver {
      observe(target: Node, options?: MutationObserverInit) { super.observe(target, options); active.add(this); }
      disconnect() { super.disconnect(); active.delete(this); }
    };
    (globalThis as unknown as { fixtureObserverCount: () => number }).fixtureObserverCount = () => active.size;
  });
}
const observerCount = () => page.evaluate(() => (globalThis as unknown as { fixtureObserverCount: () => number }).fixtureObserverCount());
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); });
beforeEach(async () => {
  context = await browser.newContext();
  await context.route("**/*", route => route.request().url() === "https://muse-fixture.test/"
    ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Private fixture</title>" }) : route.abort());
  page = await context.newPage(); await page.goto("https://muse-fixture.test/");
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("private Muse turn anchors", () => {
  it("stores only SHA-256 hashes of normalized prompt and prior visible user text without changing the page", async () => {
    await fixture(user("First\n  request") + assistant("Not a user message") + user("第二条请求"));
    const before = await page.content();
    const anchor = await prepareMuseTurnAnchor(page, "  Exact\nuser  prompt\t");
    expect(anchor).toEqual({ promptHash: hash("Exact user prompt"), precedingUserHashes: [hash("First request"), hash("第二条请求")],
      precedingUserPromptHashes: [hash("First request"), hash("第二条请求")], preparationId: expect.any(String), pageUrl: "https://muse-fixture.test/" });
    expect(JSON.stringify(anchor)).not.toContain("Exact");
    expect(await page.content()).toBe(before);
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it("isolates a new identical prompt from earlier identical prompts and later turns", async () => {
    const prompt = "Make the same image again";
    const prefix = user(prompt) + assistant(image("old-one")) + user(prompt) + assistant(image("old-two"));
    await fixture(prefix);
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(prefix + user(prompt) + assistant(image("current")) + user(prompt) + assistant(image("later")));
    const result = await read(anchor);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(item => item.src)).toEqual([png + "#current"]);
    expect(anchor.precedingUserHashes).toEqual([hash(prompt), hash(prompt)]);
  });

  it("keeps the exact next user turn pending until its own response exists", async () => {
    const prefix = user("Old prompt") + assistant(image("old"));
    await fixture(prefix);
    const anchor = await prepareMuseTurnAnchor(page, "New prompt");
    await fixture(prefix + user("New prompt"));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "pending" }, media: [] });
    await fixture(prefix + user("New prompt") + user("Next prompt") + assistant(image("next")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "pending" }, media: [] });
  });

  it.each(["changed", "inserted", "reordered"])("fails closed when the preceding transcript is %s", async change => {
    const original = user("First") + assistant(image("old")) + user("Second");
    await fixture(original);
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    const prefixes = {
      changed: user("Changed first") + user("Second"),
      inserted: user("Inserted") + user("First") + user("Second"),
      reordered: user("Second") + user("First"),
    };
    await fixture(prefixes[change as keyof typeof prefixes] + user("Target") + assistant(image("must-not-return")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it.each(["removed", "hidden", "all-removed"])("recovers a unique first observation after preceding rows are %s", async change => {
    await fixture(user("First") + user("Second"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    const prefix = change === "removed" ? user("Second") : change === "hidden" ? user("First", "", "hidden") + user("Second") : "";
    await fixture(prefix + user("Target") + assistant(image("current")) + user("Next") + assistant(image("later")));
    const result = await read(anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: { expectedIndex: 2, candidateHashMatches: true, prefixMatches: true } });
    expect(result.media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it("rejects multiple matching visible prompts after prefix virtualization", async () => {
    await fixture(user("First") + user("Second") + user("Third"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target") + assistant(image("earlier")) + user("Target") + assistant(image("later")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it("distinguishes an existing identical prompt from a new repeated turn after history is trimmed", async () => {
    await fixture(user("Target", "", 'id="prior"') + assistant(image("old")) + user("Other", "", 'id="other"'));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await page.locator("#other").evaluate(element => element.remove());
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
    await page.locator("#prior").evaluate(element => element.remove());
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user("Target") + assistant(image("current")));
    expect((await read(anchor)).media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it("does not search later messages when another message occupies the expected next position", async () => {
    await fixture(user("Prefix"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Prefix") + user("Intervening user input") + assistant(image("wrong")) + user("Target") + assistant(image("also-not-selected")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it("does not fall back to global media for a missing target, invalid anchor or wrong prompt", async () => {
    await fixture(user("Prefix") + assistant(image("old")));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
    await fixture(user("Prefix") + user("Different target") + assistant(image("wrong")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
    expect(await read({ ...anchor, promptHash: "invalid" })).toMatchObject({ delivery: { state: "missing" }, media: [] });
    expect(await read({ ...anchor, precedingUserHashes: ["invalid"] })).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it("normalizes whitespace and rendered block boundaries without changing the actual prompt", async () => {
    await fixture("");
    const prompt = "  Hello\nworld\n\n朋友\t";
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(user("<p>Hello</p><div>world<br>朋友</div>") + assistant(image("current")));
    expect((await read(anchor)).media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it("ignores hidden messages and composer previews when preparing the prefix", async () => {
    await fixture(user("Real prior") + user("Hidden prior", "", "hidden") + `<form>${user("Draft")}<div class="group/msg">${user("Preview")}</div></form>`);
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    expect(anchor.precedingUserHashes).toEqual([hash("Real prior")]);
    await fixture(user("Real prior") + user("Target") + assistant("Accepted"));
    expect((await read(anchor)).delivery.state).toBe("accepted");
  });

  it("counts genuine group/msg user rows and follows their reply without collecting uploaded media", async () => {
    const prompt = "Use the same reference again";
    const previous = `<div class="group/msg">${user(prompt)}</div>` + assistant(image("old"));
    await fixture(previous);
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    expect(anchor.precedingUserHashes).toEqual([hash(prompt)]);
    await fixture(previous + `<div class="group/msg">${user(prompt + `<div data-testid="hatch-chat-attachment-presentation-image">${image("upload")}</div>`)}</div>`
      + assistant(image("current")) + `<div class="group/msg">${user(prompt)}</div>` + assistant(image("later")));
    const result = await read(anchor);
    expect(result.delivery).toMatchObject({ state: "accepted" });
    expect(result.media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it("follows a verified repeated prompt when preceding rows are virtualized away", async () => {
    const prompt = "Repeat this image";
    const prefix = user(prompt, "", 'id="prior-one"') + assistant(image("old-one")) + user(prompt, "", 'id="prior-two"') + assistant(image("old-two"));
    await fixture(prefix);
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user(prompt, "", 'id="current"'));
    expect((await read(anchor)).delivery.state).toBe("pending");
    await page.locator("#prior-one").evaluate(element => element.remove());
    await page.locator("#prior-two").evaluate(element => element.remove());
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), assistant(image("current")) + user(prompt) + assistant(image("later")));
    const result = await read(anchor);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it("allows only the original visible prefix suffix around a continuously verified target", async () => {
    await fixture(user("First", "", 'id="first"') + user("Second", "", 'id="second"'));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user("Target") + assistant(image("current")));
    expect((await read(anchor)).delivery.state).toBe("accepted");
    await page.locator("#first").evaluate(element => element.remove());
    expect((await read(anchor)).delivery.state).toBe("accepted");
    await page.locator("#second .chat-user-bubble").evaluate(element => { element.textContent = "Unrelated transcript"; });
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing" }, media: [] });
  });

  it("keeps a verified target through ordinary attribute changes after prefix virtualization", async () => {
    await fixture(user("First", "", 'id="first"') + user("Second"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user("Target", "", 'id="current"'));
    expect((await read(anchor)).delivery.state).toBe("pending");
    await page.locator("#first").evaluate(element => element.remove());
    expect((await read(anchor)).delivery.state).toBe("pending");
    await page.locator("#current .chat-user-bubble").evaluate(element => {
      element.setAttribute("data-hovered", "true");
      element.classList.add("message-complete");
      element.setAttribute("style", "opacity: 1");
    });
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), assistant(image("current")));
    const result = await read(anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: { continuing: true, candidateHashMatches: true, prefixMatches: true } });
    expect(result.media.map(item => item.src)).toEqual([png + "#current"]);
  });

  it.each(["removed", "recycled", "changed", "replaced"])("revalidates a repeated prompt after its rendered node is %s", async change => {
    const prompt = "Repeat this image";
    await fixture(user(prompt, "", 'id="prior"'));
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user(prompt, "", 'id="current"'));
    expect((await read(anchor)).delivery.state).toBe("pending");
    await page.locator("#prior").evaluate(element => element.remove());
    await page.locator("#current").evaluate((element, variant) => {
      if (variant === "changed") {
        const bubble = element.querySelector(".chat-user-bubble")!;
        const text = bubble.textContent; bubble.textContent = "Other prompt"; bubble.textContent = text;
      } else if (variant === "replaced") {
        element.replaceWith(element.cloneNode(true));
      } else {
        const parent = element.parentElement!; element.remove();
        if (variant === "recycled") parent.append(element);
      }
    }, change);
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), assistant(image("current")));
    const result = await read(anchor);
    expect(result.delivery.state).toBe(change === "removed" ? "missing" : "accepted");
    expect(result.media.map(item => item.src)).toEqual(change === "removed" ? [] : [png + "#current"]);
  });

  it.each(["changed", "recycled"])("retries a settled candidate %s during the initial hash before binding", async change => {
    await fixture(user("Prior"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Prior") + user("Target", "", 'id="current"') + assistant(image("unproven")));
    await page.evaluate(variant => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let changed = false;
      crypto.subtle.digest = (algorithm, data) => {
        if (!changed) {
          changed = true;
          const row = document.querySelector("#current")!;
          if (variant === "changed") {
            const bubble = row.querySelector(".chat-user-bubble")!;
            bubble.textContent = "Different"; bubble.textContent = "Target";
          } else {
            const parent = row.parentElement!, following = row.nextSibling;
            row.remove(); parent.insertBefore(row, following);
          }
        }
        return digest(algorithm, data);
      };
    }, change);
    expect(await readMuseTurnSnapshot(page, anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: { reason: "binding-invalidated" } }, media: [] });
    const result = await read(anchor);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(item => item.src)).toEqual([png + "#unproven"]);
  });

  it("gives repeated preparations independent private identities and keeps them in their original conversation", async () => {
    await fixture(user("Prior"));
    const first = await prepareMuseTurnAnchor(page, "Target");
    const second = await prepareMuseTurnAnchor(page, "Target");
    expect(first.preparationId).not.toBe(second.preparationId);
    await fixture(user("Prior") + user("Target") + assistant(image("current")));
    expect((await read(second)).delivery.state).toBe("accepted");
    await page.evaluate(() => history.replaceState(null, "", "/another-conversation"));
    expect(await read(second)).toMatchObject({ delivery: { state: "missing", diagnostic: { reason: "page-changed" } }, media: [] });
  });

  it("does not include uploaded attachment names or controls in the prompt hash", async () => {
    await fixture("");
    const anchor = await prepareMuseTurnAnchor(page, "Use my reference");
    const content = 'Use my reference<div data-testid="hatch-chat-attachment-presentation-image">private-reference.png' + image("reference") + '</div><button>Copy message</button>';
    await fixture(user(content) + assistant(`<button aria-label="Open image">${image("result")}</button>`));
    const result = await read(anchor);
    expect(result.delivery.state).toBe("accepted");
    expect(result.media.map(item => item.src)).toEqual([png + "#result"]);
  });

  it.each(["未确认送达", "Delivery not confirmed", "Send failed"])("keeps adjacent delivery state %s scoped to the private anchor", async label => {
    await fixture(user("Prior", '<span>Sent</span>'));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Prior", '<span>Sent</span>') + user("Target", `<span>${label}</span>`) + assistant(image("not-yet-confirmed")));
    const result = await read(anchor);
    expect(result.delivery).toMatchObject({ state: label === "Send failed" ? "failed" : "unconfirmed", message: label });
    expect(result.media).toEqual([]);
  });

  it.each(["Still sending...", "仍在发送…"])("accepts a decoded result from the original turn despite a stale %s badge", async label => {
    await fixture(user("Prior"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Prior") + user("Target", `<span>${label}</span>`) + assistant(image("finished")));
    const result = await read(anchor);
    expect(result.delivery).toMatchObject({ state: "accepted", diagnostic: { reason: "assistant-content" } });
    expect(result.media.map(item => item.src)).toEqual([png + "#finished"]);
  });

  it("keeps Still sending pending for placeholders, uploads and a later turn's result", async () => {
    await fixture("");
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user(`Target<div data-testid="hatch-chat-attachment-presentation-image">${image("upload")}</div>`, '<span>Still sending</span>')
      + assistant('<img>') + user("Next") + assistant(image("later")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "unconfirmed" }, media: [] });
  });

  it("never interprets status-like prompt text as a delivery status", async () => {
    const prompt = "未确认送达 Send failed Still sending Message delivered";
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(user(prompt));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "pending" }, media: [] });
    await fixture(user(prompt, '<span>Sent</span>'));
    expect((await read(anchor)).delivery).toMatchObject({ state: "accepted", message: "Sent" });
  });

  it("retains legacy marker support in delivery and media readers", async () => {
    const marker = "[DrawStudio task: legacy-job-0001]";
    await fixture(user(marker) + assistant(image("legacy")) + user("Next") + assistant(image("next")));
    expect((await readMuseDeliveryState(page, marker)).state).toBe("accepted");
    expect((await readMuseTurnMedia(page, marker)).map(item => item.src)).toEqual([png + "#legacy"]);
  });

  it("returns only actual image/video media and excludes thumbnails, previews and uploads", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user(`Target<div data-testid="hatch-chat-attachment-presentation-image">${image("upload")}</div>`)
      + assistant(`<div data-testid="hatch-chat-attachment-presentation-video">${image("thumbnail")}</div>` + image("result")
        + `<form>${image("composer")}</form><div class="group/msg">${image("preview")}</div>`)
      + assistant(image("result")));
    expect((await read(anchor)).media.map(item => item.src)).toEqual([png + "#result"]);
  });

  it("keeps one verified observer across repeated reads and releases it on prepare or target removal", async () => {
    await trackObservers(); await fixture("");
    for (let turn = 0; turn < 3; turn++) {
      const anchor = await prepareMuseTurnAnchor(page, "Prompt " + turn);
      expect(await observerCount()).toBe(0);
      await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), user("Prompt " + turn, "", 'id="turn-' + turn + '"'));
      for (let poll = 0; poll < 3; poll++) expect((await read(anchor)).delivery.state).toBe("pending");
      expect(await observerCount()).toBe(1);
    }
    await page.locator("#turn-2").evaluate(element => element.remove());
    expect(await observerCount()).toBe(0);
  });

  it("disconnects provisional observers when hashing rejects", async () => {
    await trackObservers(); await fixture("");
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target"));
    await page.evaluate(() => { crypto.subtle.digest = () => Promise.reject(new Error("Fixture hash rejection")); });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(readMuseDeliveryState(page, anchor)).rejects.toThrow("Fixture hash rejection");
      expect(await observerCount()).toBe(0);
    }
  });

  it("does not publish a stale observer when a new prepare overtakes an outstanding read", async () => {
    await trackObservers(); await fixture("");
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target"));
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let delayed = false;
      crypto.subtle.digest = (algorithm, data) => {
        if (delayed) return digest(algorithm, data);
        delayed = true;
        return new Promise<ArrayBuffer>((resolve, reject) => {
          (globalThis as unknown as { releaseFixtureDigest: () => void }).releaseFixtureDigest = () => { void digest(algorithm, data).then(resolve, reject); };
        });
      };
    });
    const outstanding = readMuseDeliveryState(page, anchor);
    await page.waitForFunction(() => typeof (globalThis as unknown as { releaseFixtureDigest?: unknown }).releaseFixtureDigest === "function");
    await prepareMuseTurnAnchor(page, "Next prompt");
    await page.evaluate(() => (globalThis as unknown as { releaseFixtureDigest: () => void }).releaseFixtureDigest());
    expect(await outstanding).toMatchObject({ state: "missing", diagnostic: { reason: "preparation-changed" } });
    expect(await observerCount()).toBe(0);
  });

  it("diagnoses a mismatched candidate and later matching prompt without selecting the later turn", async () => {
    const prompt = "Private request that must not enter diagnostics";
    await fixture(user("Prior"));
    const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(user("Prior") + assistant("Prior reply") + user("Other request") + assistant(image("wrong")) + user(prompt) + assistant(image("later")));
    const result = await read(anchor);
    expect(result).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", userCount: 3, bubbleCount: 6, expectedIndex: 1,
      candidateHashMatches: false, prefixMatches: true, matchingPromptIndices: [2],
      assistantCount: 1, attachmentCount: 0, mediaCount: 1, continuing: false,
    } }, media: [] });
    const encoded = JSON.stringify(result.delivery.diagnostic);
    for (const secret of [prompt, anchor.promptHash, ...anchor.precedingUserHashes, png, "wrong", "Other request"])
      expect(encoded).not.toContain(secret);
  });

  it("distinguishes a changed prefix from a matching candidate", async () => {
    await fixture(user("Prior"));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Changed prior") + user("Target") + assistant(image("must-not-return")));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prefix-mismatch", expectedIndex: 1, candidateHashMatches: true, prefixMatches: false, matchingPromptIndices: [1],
    } }, media: [] });
  });

  it("reports absent target position, empty user bubbles and nested groupable bubbles", async () => {
    await fixture('<div class="hatch-chat-groupable-bubble chat-user-bubble"><div class="hatch-chat-groupable-bubble chat-user-bubble">Nested prior</div></div>' + user(""));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "target-absent", userCount: 3, bubbleCount: 3, expectedIndex: 3,
      emptyUserBubbleCount: 1, nestedBubbleCount: 1, prefixMatches: true, matchingPromptIndices: [],
    } }, media: [] });
  });

  it("reports a standalone result in the verified turn and preserves its binding", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target") + `<div data-testid="hatch-chat-attachment-presentation-image">${image("standalone")}</div>`);
    const first = await readMuseDeliveryState(page, anchor);
    expect(first).toMatchObject({ state: "accepted", diagnostic: {
      reason: "assistant-content", expectedIndex: 0, candidateHashMatches: true, prefixMatches: true,
      assistantCount: 0, attachmentCount: 1, mediaCount: 1, matchingPromptIndices: [0], continuing: false,
    } });
    expect((await readMuseDeliveryState(page, anchor)).diagnostic?.continuing).toBe(true);
    expect((await readMuseTurnMedia(page, anchor)).map(item => item.src)).toEqual([png + "#standalone"]);
  });

  it("provides reasons for invalid and missing or ambiguous legacy references", async () => {
    await fixture(user("Earlier"));
    expect(await readMuseDeliveryState(page, { promptHash: "invalid", precedingUserHashes: [] })).toMatchObject({
      state: "missing", diagnostic: { reason: "invalid-reference", userCount: 1, bubbleCount: 1, expectedIndex: -1 },
    });
    expect(await readMuseDeliveryState(page, "")).toMatchObject({ state: "missing", diagnostic: { reason: "invalid-reference" } });
    expect(await readMuseDeliveryState(page, "unique-marker")).toMatchObject({ state: "missing", diagnostic: { reason: "marker-missing" } });
    await fixture(user("unique-marker") + user("unique-marker"));
    expect(await readMuseDeliveryState(page, "unique-marker")).toMatchObject({ state: "ambiguous", diagnostic: { reason: "marker-ambiguous" } });
  });

  it("does not let optional later-prompt diagnostic hashing change a valid result", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Target") + assistant("Accepted response") + user("Later"));
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (algorithm, data) => new TextDecoder().decode(data).includes("Later")
        ? Promise.reject(new Error("Optional diagnostic digest failed")) : digest(algorithm, data);
    });
    expect(await readMuseDeliveryState(page, anchor)).toMatchObject({ state: "accepted", diagnostic: {
      reason: "assistant-content", candidateHashMatches: true, prefixMatches: true,
    } });
  });

  it("diagnoses inserted block separators without accepting the alternative text", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "中文连续文字");
    await fixture(user("<div>中文</div><div>连续文字</div>") + assistant("Response"));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", targetTextLength: 7, targetRawTextLength: 6, targetRawNormalizedTextLength: 6,
      targetTextVariantMatches: { rawTextContent: true, withoutLayoutSeparators: true, includingButtonText: false },
      targetFormat: { blockElements: 2, lineBreakElements: 0, buttons: 0 },
    } }, media: [] });
  });

  it("diagnoses a possible at-reference button without treating its text as a match", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "参照@图1生成视频");
    await fixture(user('参照<button type="button">@图1</button>生成视频') + assistant("Response"));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", targetTextLength: 6, targetRawTextLength: 9,
      targetTextVariantMatches: { rawTextContent: true, withoutLayoutSeparators: false, includingButtonText: true, includingButtonTextWithoutLayout: true },
      targetFormat: { buttons: 1, asciiAtSigns: 1, fullWidthAtSigns: 0 },
    } }, media: [] });
  });

  it("counts zero-width characters and compares their removal without changing matching", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "制作图片");
    await fixture(user("制\u200b作图片") + assistant("Response"));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", targetTextLength: 5,
      targetTextVariantMatches: { rawTextContent: false, withoutZeroWidthCharacters: true },
      targetFormat: { zeroWidthCharacters: 1 },
    } }, media: [] });
  });

  it("compares a user-role subtree when the groupable wrapper contains other text", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "制作图片");
    await fixture('<div class="hatch-chat-groupable-bubble"><div class="chat-user-bubble">制作图片</div><span>Extra wrapper label</span></div>' + assistant("Response"));
    expect(await read(anchor)).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", targetTextVariantMatches: { rawTextContent: false, userRoleText: true },
      targetFormat: { userRoleElements: 1 },
    } }, media: [] });
  });

  it("keeps normal newline and BR normalization accepted with format counts only", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "制作\n图片");
    await fixture(user("制作<br>图片") + assistant("Response"));
    const result = await readMuseDeliveryState(page, anchor);
    expect(result).toMatchObject({ state: "accepted", diagnostic: {
      candidateHashMatches: true, targetTextLength: 5, targetRawTextLength: 4,
      targetFormat: { lineBreakElements: 1, sourceNewlines: 0 },
    } });
    expect(result.diagnostic?.targetTextVariantMatches).toBeUndefined();
  });

  it("locates an exact content subtree beside an action footer without accepting it", async () => {
    const prompt = "生成三视图";
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(user('<div class="whitespace-pre-wrap break-words" data-testid="prompt-content">生成三视图</div><div class="message-actions">编辑</div>') + assistant("Response"));
    const result = await read(anchor);
    expect(result).toMatchObject({ delivery: { state: "missing", diagnostic: {
      reason: "prompt-mismatch", targetTextLength: 8, targetRawTextLength: 7, targetPlainLeafMatches: 1,
      targetSubtreeMatches: [{ tag: "div", className: "whitespace-pre-wrap break-words", testId: "prompt-content", textLength: 5, childCount: 1 }],
      targetStructure: { tag: "div", textLength: 8, childCount: 2, children: [
        { tag: "div", testId: "prompt-content", textLength: 5, children: [{ tag: "#text", textLength: 5, childCount: 0 }] },
        { tag: "div", className: "message-actions", textLength: 2, children: [{ tag: "#text", textLength: 2, childCount: 0 }] },
      ] },
    } }, media: [] });
    expect(JSON.stringify(result.delivery.diagnostic)).not.toContain(prompt);
    expect(JSON.stringify(result.delivery.diagnostic)).not.toContain("编辑");
  });

  it("excludes hidden, attachment and control text from exact diagnostic matches and redacts unsafe attributes", async () => {
    const prompt = "生成三视图", secretHash = "a".repeat(64), secretUrl = "https://private.example/media";
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, prompt);
    await fixture(user(`<div class="content ${secretUrl} ${secretHash}" data-testid="${secretUrl}" title="${prompt}">${prompt}</div><div>编辑</div>`
      + `<button>${prompt}</button><span role="button">${prompt}</span><span hidden>${prompt}</span><div data-testid="hatch-chat-attachment-presentation-image">${prompt}</div>`));
    const result = await readMuseDeliveryState(page, anchor);
    expect(result).toMatchObject({ state: "missing", diagnostic: { targetPlainLeafMatches: 1,
      targetSubtreeMatches: [{ tag: "div", className: "content [redacted] [redacted]", testId: "[redacted]" }],
    } });
    const encoded = JSON.stringify(result.diagnostic);
    for (const secret of [prompt, secretHash, secretUrl, anchor.promptHash]) expect(encoded).not.toContain(secret);
  });

  it("bounds structure and exact-match diagnostic samples", async () => {
    await fixture(""); const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user(Array.from({ length: 160 }, () => '<span class="content">Target</span>').join("") + "Footer"));
    const result = await readMuseDeliveryState(page, anchor);
    const count = (node: NonNullable<typeof result.diagnostic>["targetStructure"]): number => node ? 1 + (node.children ?? []).reduce((total, child) => total + count(child), 0) : 0;
    expect(result.state).toBe("missing");
    expect(count(result.diagnostic?.targetStructure)).toBeLessThanOrEqual(24);
    expect(result.diagnostic?.targetSubtreeMatches).toHaveLength(12);
    expect(result.diagnostic?.targetPlainLeafMatches).toBe(128);
    expect(result.diagnostic?.targetDiagnosticSample).toMatchObject({ sampledLeaves: 128, sampledSubtrees: 96, structureTruncated: true });
  });

  it("counts scoped media placement and exclusion reasons without exposing sources or taking later results", async () => {
    const card = (name: string) => `<div data-testid="hatch-chat-attachment-presentation-image">${image(name)}</div>`;
    await fixture(user("Prior") + assistant(card("old")));
    const anchor = await prepareMuseTurnAnchor(page, "Target");
    await fixture(user("Prior") + assistant(card("old")) + user("Target" + card("upload") + "<div>编辑</div>")
      + assistant(card("current") + `<span hidden>${image("hidden")}</span><video></video>`)
      + card("standalone") + `<div class="group/msg">${image("grouped")}</div><div class="chat-user-bubble">${image("user-role")}</div>`
      + user("Next") + assistant(card("later")));
    const result = await read(anchor);
    expect(result).toMatchObject({ delivery: { state: "missing", diagnostic: { targetMediaRange: {
      attachmentCards: 3, images: 6, videos: 1, inAssistantRoots: 4, outsideAssistantRoots: 6,
      standaloneAttachmentCards: 1, insideUserAnchor: 2, excludedByGroupMessage: 1,
      excludedByUserRole: 3, excludedByComposer: 0, hidden: 1, withoutSource: 1, zeroDimensions: 1,
    } } }, media: [] });
    expect(JSON.stringify(result.delivery.diagnostic)).not.toContain(png);
    expect(JSON.stringify(result.delivery.diagnostic)).not.toContain("#later");
  });
});
