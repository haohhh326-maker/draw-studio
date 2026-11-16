import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readMuseSendReadiness } from "../scripts/muse-send-readiness";

// Isolated local fixtures; never uses the user's browser profile or Muse account.
let browser: Browser, context: BrowserContext, page: Page;
const composer = '<form><textarea aria-label="Message"></textarea><button>Send</button></form>';
async function fixture(content = composer) {
  await page.setContent(`<!doctype html><title>Local readiness fixture</title><main>${content}</main>`);
}
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); });
beforeEach(async () => { context = await browser.newContext(); page = await context.newPage(); });
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

describe("Muse send readiness", () => {
  it("accepts a ready page without requiring a shell attribute or a thread route", async () => {
    await fixture();
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
  });

  it.each(["loading", "interactive"])("waits while document state is %s even if the input already exists", async state => {
    await fixture();
    await page.evaluate(value => Object.defineProperty(document, "readyState", { configurable: true, value }), state);
    expect(await readMuseSendReadiness(page)).toMatchObject({ ready: false, message: expect.stringContaining("加载完成") });
  });

  it("waits for an observed shell to become hydrated without navigating", async () => {
    await fixture(`<div data-hatch-shell-hydration-state="hydrating">${composer}</div>`);
    expect(await readMuseSendReadiness(page)).toMatchObject({ ready: false, message: expect.stringContaining("初始化") });
    await page.locator('[data-hatch-shell-hydration-state]').evaluate(element => element.setAttribute("data-hatch-shell-hydration-state", "hydrated"));
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
    expect(page.url()).toBe("about:blank");
  });

  it.each(["Connecting...", "Reconnecting…", "正在连接", "正在重新连接…", "连接中", "Offline", "You're offline", "Connection lost", "连接失败", "网络连接已断开"])("waits for a visible transport status: %s", async text => {
    await fixture(`<div role="status"><span>${text}</span></div>${composer}`);
    expect(await readMuseSendReadiness(page)).toMatchObject({ ready: false, message: expect.stringMatching(/连接|中断/) });
  });

  it("recognizes the upstream standalone Connecting label without relying on status roles", async () => {
    await fixture(`<div><span>Connecting...</span></div>${composer}`);
    expect(await readMuseSendReadiness(page)).toMatchObject({ ready: false });
  });

  it.each(["Connecting...", "Reconnecting…", "Offline", "连接失败"])("ignores %s in prompts and past replies", async text => {
    await fixture(`<section class="hatch-chat-groupable-bubble chat-user-bubble"><div role="status">${text}</div></section><section class="hatch-agent-bubble-bg"><span>${text}</span></section><form><textarea>${text}</textarea></form>`);
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
  });

  it("ignores a connection word quoted as part of ordinary page copy", async () => {
    await fixture(`<p>Ask Muse why the previous page said Connecting...</p>${composer}`);
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
  });

  it.each(['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"'])("ignores hidden stale banners and shells: %s", async attributes => {
    await fixture(`<section ${attributes}><div data-hatch-shell-hydration-state="hydrating"><span role="status">Connecting...</span></div></section>${composer}`);
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
  });

  it.each([
    '<textarea disabled></textarea>',
    '<textarea readonly></textarea>',
    '<fieldset disabled><textarea></textarea></fieldset>',
    '<div aria-disabled="true"><textarea></textarea></div>',
    '<div inert><textarea></textarea></div>',
    '<div hidden><textarea></textarea></div>',
    '<textarea style="width:0;height:0;padding:0;border:0"></textarea>',
    '<div class="chat-user-bubble"><textarea></textarea></div>',
    '<p>No input yet</p>',
  ])("waits for a visible enabled input: %#", async content => {
    await fixture(content);
    expect(await readMuseSendReadiness(page)).toMatchObject({ ready: false, message: expect.stringContaining("输入框") });
  });

  it("supports the visible contenteditable composer without treating its draft as a connection banner", async () => {
    await fixture('<div role="textbox" contenteditable="true">Connecting...</div>');
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
  });

  it("observes reconnection without clicking, clearing the draft, or imposing a deadline", async () => {
    await fixture(`<div id="connection" role="status">Connecting...</div><form><textarea>Keep my draft</textarea><button>Send</button></form>`);
    expect((await readMuseSendReadiness(page)).ready).toBe(false);
    await page.locator('#connection').evaluate(element => element.remove());
    expect(await readMuseSendReadiness(page)).toEqual({ ready: true });
    expect(await page.locator('textarea').inputValue()).toBe("Keep my draft");
  });

  it("returns an actionable closed state without leaking browser details", async () => {
    await page.close();
    expect(await readMuseSendReadiness(page)).toEqual({ ready: false, message: "Muse 浏览器连接已关闭，尚未发送。" });
  });
});
