import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readMuseDeliveryState } from "../scripts/muse-delivery-state";

// Isolated synthetic DOM only: no user profile, Muse navigation or generation.
let browser: Browser, context: BrowserContext, page: Page;
const marker = "[DrawStudio task: delivery-test-0001]";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const user = (text = marker, status = "", attributes = "") => `<section ${attributes}><div class="hatch-chat-groupable-bubble chat-user-bubble">${text}</div>${status}</section>`;
const assistant = (content = "I am working on your request.", attributes = "") => `<section ${attributes}><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">${content}</div></section>`;
const status = (text: string, attributes = "") => `<span ${attributes}>${text}</span>`;
async function fixture(content: string) {
  await page.setContent(`<!doctype html><title>Local delivery fixture</title><style>section, .hatch-chat-groupable-bubble { min-height: 20px; } img, video, audio { width: 40px; height: 40px; }</style><main>${content}</main>`);
}
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); });
beforeEach(async () => { context = await browser.newContext(); page = await context.newPage(); });
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("Muse marked-turn delivery", () => {
  it("keeps an optimistic user bubble pending, even on an existing conversation", async () => {
    await fixture(user());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it.each(["未确认送达", "Delivery not confirmed", "Still sending..."])("reports %s as unconfirmed rather than accepted or failed", async label => {
    await fixture(user(marker, status(label)));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "unconfirmed", message: label });
  });

  it.each(["发送失败", "Send failed", "Not delivered"])("recognizes an explicit %s delivery failure", async label => {
    await fixture(user(marker, status(label)));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "failed", message: label });
  });

  it.each(["已送达", "Sent", "Message delivered"])("accepts the explicit row status %s", async label => {
    await fixture(user(marker, status(label)));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted", message: label });
  });

  it("reads visible status labels on adjacent icons and nested row wrappers", async () => {
    await fixture(`<section><div>${user()}</div><span aria-label="Delivery not confirmed">!</span></section>`);
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "unconfirmed", message: "Delivery not confirmed" });
  });

  it.each(["未确认送达", "Still sending", "Send failed", "Sent"])("reads %s beside a real group/msg user bubble", async label => {
    await fixture(`<div class="group/msg">${user(marker, status(label))}</div>` + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({
      state: label === "Sent" ? "accepted" : label === "Send failed" ? "failed" : "unconfirmed", message: label,
    });
  });

  it("does not treat status-like text inside group/msg prompt content as a row status", async () => {
    await fixture(`<div class="group/msg">${user(marker + '<span role="status">Send failed</span>')}</div>` + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted" });
  });

  it.each(["未确认送达", "发送失败", "Delivery not confirmed", "Still sending", "Send failed", "Not delivered", "Message delivered"])("does not interpret prompt text %s as a delivery status", async label => {
    await fixture(user(`${marker}<span role="status" title="${label}" aria-label="${label}">${label}</span>`));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it("gives a delivery failure precedence over optimistic success and assistant content", async () => {
    await fixture(user(marker, status("Sent") + status("未确认送达") + status("Send failed")) + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "failed", message: "Send failed" });
  });

  it("does not accept an unconfirmed row merely because assistant content also appears", async () => {
    await fixture(user(marker, status("未确认送达")) + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "unconfirmed", message: "未确认送达" });
  });

  it("accepts meaningful assistant content after the unique marked user message", async () => {
    await fixture(user() + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted" });
  });

  it("supports role classes nested within the groupable bubbles", async () => {
    await fixture(`<section><div class="hatch-chat-groupable-bubble"><div class="chat-user-bubble">${marker}</div></div></section><section><div class="hatch-chat-groupable-bubble"><div class="hatch-agent-bubble-bg">Generating your video.</div></div></section>`);
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted" });
  });

  it("accepts an assistant media attachment without text", async () => {
    await fixture(user() + assistant(`<img src="${image}" alt="Generated image">`));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted" });
  });

  it.each(["", "   ", "...", "Thinking...", '<button>Copy</button>', '<span role="status">Loading...</span>', `<img src="${image}#avatar">`])("ignores empty assistant scaffolding %s", async content => {
    await fixture(user() + assistant(content));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it("ignores earlier responses, earlier failures and next-turn responses", async () => {
    await fixture(user("Earlier prompt", status("Send failed")) + assistant("Earlier response") + user() + user("Later prompt", status("Sent")) + assistant("Later response"));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it.each(['hidden', 'style="display:none"', 'style="visibility:hidden"', 'aria-hidden="true"'])("ignores hidden status, duplicate and assistant nodes: %s", async attributes => {
    await fixture(user(marker, status("Send failed", attributes)) + user(marker, "", attributes) + assistant("Hidden response", attributes));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it("does not treat a marker inside a hidden prompt fragment as an anchor", async () => {
    await fixture(user(`Visible prompt<span hidden>${marker}</span>`) + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "missing" });
  });

  it("fails closed for missing, duplicate, assistant-only and partial markers", async () => {
    await fixture(user("No marker") + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "missing" });
    await fixture(user() + user() + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "ambiguous" });
    await fixture(assistant(marker));
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "missing" });
    await fixture(user("[DrawStudio task: delivery-test-0001-other]") + assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "missing" });
    expect(await readMuseDeliveryState(page, "")).toMatchObject({ state: "missing" });
  });

  it("ignores unrelated global status text even when only one message exists", async () => {
    await fixture(user() + '<aside>Send failed</aside>');
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
    await fixture(`<div>${user()}<aside><span>Send failed</span></aside></div>`);
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
  });

  it("observes pending, unconfirmed and accepted transitions without sending", async () => {
    await fixture(user() + '<form><textarea></textarea><button type="button">Send</button></form>');
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "pending" });
    await page.locator("section").evaluate(element => element.insertAdjacentHTML("beforeend", '<span id="delivery-status">Still sending</span>'));
    expect((await readMuseDeliveryState(page, marker)).state).toBe("unconfirmed");
    await page.locator("#delivery-status").evaluate(element => element.remove());
    await page.locator("main").evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), assistant());
    expect(await readMuseDeliveryState(page, marker)).toMatchObject({ state: "accepted" });
    expect(await page.locator("textarea").inputValue()).toBe("");
  });
});
