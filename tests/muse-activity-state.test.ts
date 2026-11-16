import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readMuseActivity } from "../scripts/muse-activity-state";

describe("Muse avatar work activity", () => {
  let browser: Browser, context: BrowserContext, page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  });
  beforeEach(async () => {
    context = await browser.newContext();
    await context.route("**/*", route => route.abort());
    page = await context.newPage();
  });
  afterEach(async () => { await context.close(); });
  afterAll(async () => { await browser.close(); });

  function pill(status = "", name = "Marigold", attributes = "") {
    return `<div data-hatch-avatar-accessory="status-pill" data-hatch-avatar-status-pill-visible="true" aria-label="${name}" ${attributes}>
      <span><span title="${name}">${name}</span></span><div><svg width="20" height="20"></svg><span>${status}</span></div>
    </div>`;
  }

  it.each(["努力工作中", "正在工作", "工作中", "Working hard", "Working", "Working..."])("reads the visible work status %s", async text => {
    await page.setContent(pill(text));
    expect(await readMuseActivity(page)).toEqual({ working: true, message: text });
  });

  it("returns an idle observation without declaring a generated task complete", async () => {
    await page.setContent(pill() + '<video data-hatch-avatar-layer="ready" data-hatch-media-owner="avatar-layer" autoplay></video>');
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("reads inline status text beside its icon and a status tooltip", async () => {
    await page.setContent(pill().replace('<span></span>', '<span title="努力工作中">努力工作中</span>'));
    expect(await readMuseActivity(page)).toEqual({ working: true, message: "努力工作中" });
    await page.setContent(pill().replace('<span></span>', '正在工作'));
    expect(await readMuseActivity(page)).toEqual({ working: true, message: "正在工作" });
  });

  it.each(['hidden', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'aria-hidden="true"'])("ignores a hidden status pill with %s", async attributes => {
    await page.setContent(pill("努力工作中", "Marigold", attributes));
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("ignores a pill whose visibility flag is false", async () => {
    await page.setContent(pill("努力工作中").replace('status-pill-visible="true"', 'status-pill-visible="false"'));
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it.each(["Working", "Working hard", "努力工作中"])("does not confuse the avatar name %s with activity", async name => {
    await page.setContent(pill("", name));
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("ignores matching phrases in the user's prompt, an old response and composer", async () => {
    await page.setContent('<main><div class="hatch-chat-groupable-bubble bg-chat-user-bubble">努力工作中</div><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">Working hard</div><form><span>正在工作</span></form></main>' + pill());
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("does not use an old response that imitates the avatar pill markup", async () => {
    await page.setContent('<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">' + pill("努力工作中") + '</div>');
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("reads the status row in the visible avatar profile card", async () => {
    await page.setContent('<div role="dialog"><section><div role="img" data-hatch-avatar-interaction="true" aria-label="Muse虚拟形象" style="width:128px;height:128px"></div><h1>Marigold</h1><p><svg width="20" height="20"></svg><span>努力工作中</span></p></section></div>');
    expect(await readMuseActivity(page)).toEqual({ working: true, message: "努力工作中" });
  });

  it("reads a profile activity row beside its avatar without widening to the transcript", async () => {
    await page.setContent('<div><section><div role="img" data-hatch-avatar-interaction="true" aria-label="Muse avatar" style="width:128px;height:128px"></div><h1>Marigold</h1><p><span>Working hard</span></p></section><main><div class="hatch-chat-groupable-bubble">Another user prompt</div></main></div>');
    expect(await readMuseActivity(page)).toEqual({ working: true, message: "Working hard" });
  });

  it("does not confuse the profile heading with work activity", async () => {
    await page.setContent('<div role="dialog"><div role="img" data-hatch-avatar-interaction="true" aria-label="Muse avatar" style="width:128px;height:128px"></div><h1>Working hard</h1></div>');
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });

  it("does not treat a disconnected status pill with longer narrative text as work activity", async () => {
    await page.setContent(pill("我昨天一直努力工作中，现在结束了"));
    expect(await readMuseActivity(page)).toEqual({ working: false });
  });
});
