import { describe, expect, it } from "vitest";
import { classifyMusePage, isMusePageUrl } from "../scripts/muse-session-state";

describe("Muse official page URLs", () => {
  it.each([
    "https://muse.ai",
    "https://muse.ai/",
    "https://muse.ai/thread/new",
    "https://muse.ai/library?view=images#recent",
    "https://www.muse.ai/",
    "https://www.muse.ai/thread/existing-123",
    "https://muse.ai:443/thread/new",
  ])("accepts the official HTTPS origin: %s", url => {
    expect(isMusePageUrl(url)).toBe(true);
  });

  it.each([
    "https://muse.ai.evil.test/thread/new",
    "https://muse.ai-example.test/thread/new",
    "https://accounts.muse.ai/thread/new",
    "https://evil.test/muse.ai/thread/new",
    "https://muse.ai:8443/thread/new",
    "http://muse.ai/thread/new",
    "https://user@muse.ai/thread/new",
    "https://user:password@www.muse.ai/thread/new",
    "https://muse.ai@evil.test/thread/new",
    "about:blank",
    "javascript:void(0)",
    "/thread/new",
    "not a URL",
    "",
  ])("rejects unofficial, credential-bearing or invalid URLs: %s", url => {
    expect(isMusePageUrl(url)).toBe(false);
    expect(classifyMusePage({ url, composer: true }).status).toBe("login-required");
  });
});

describe("Muse page session evidence", () => {
  it.each([
    ["signed-in root homepage", "https://muse.ai/"],
    ["new conversation", "https://muse.ai/thread/new"],
    ["existing conversation", "https://muse.ai/thread/existing-123"],
    ["library with an available composer", "https://muse.ai/library"],
    ["official www homepage", "https://www.muse.ai/"],
  ])("recognizes an available composer on the %s", (_description, url) => {
    expect(classifyMusePage({ url, composer: true }).status).toBe("connected");
  });

  it("accepts available contenteditable composer evidence without requiring a textarea or thread route", () => {
    expect(classifyMusePage({ url: "https://muse.ai/", composer: true, workspace: true }).status).toBe("connected");
  });

  it("keeps an old login page requiring login when its composer is hidden", () => {
    expect(classifyMusePage({ url: "https://muse.ai/login", composer: false, login: true }).status).toBe("login-required");
  });

  it("lets an explicit login gate override a composer left underneath it", () => {
    expect(classifyMusePage({ url: "https://muse.ai/thread/new", composer: true, login: true }).status).toBe("login-required");
  });

  it.each([false, true])("reports loading as checking when composer evidence is %s", composer => {
    expect(classifyMusePage({ url: "https://muse.ai/thread/new", composer, loading: true }).status).toBe("checking");
  });

  it("waits for the composer to mount in a recognized workspace", () => {
    expect(classifyMusePage({ url: "https://muse.ai/", composer: false, workspace: true }).status).toBe("checking");
  });

  it.each([
    { composer: false },
    { composer: true },
    { composer: false, workspace: true },
    { composer: true, login: true },
  ])("keeps a restriction authoritative over other page evidence %#", evidence => {
    expect(classifyMusePage({ url: "https://muse.ai/", restricted: true, ...evidence }).status).toBe("waiting-list");
  });

  it("does not mistake a known thread path for an authenticated session by itself", () => {
    expect(classifyMusePage({ url: "https://muse.ai/thread/new", composer: false }).status).toBe("checking");
  });

  it("requires login evidence to be resolved even when workspace chrome remains visible", () => {
    expect(classifyMusePage({ url: "https://muse.ai/", composer: false, workspace: true, login: true }).status).toBe("login-required");
  });
});
