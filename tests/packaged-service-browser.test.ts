import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBrowserService } from "../scripts/muse-browser-service";
import { DeepSeekBrowserService } from "../scripts/deepseek-browser-service";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture(Service: typeof MuseBrowserService | typeof DeepSeekBrowserService) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "canvas-packaged-browser-")); folders.push(folder);
  const service = new Service(folder);
  await (service as any).ready;
  const context = Object.assign(new EventEmitter(), {
    pages: () => [], setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => context.emit("close")),
  });
  const launch = vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context as any);
  return { service, context, launch, profile: path.join(folder, "browser-profile") };
}
describe.each([["Muse", MuseBrowserService], ["DeepSeek", DeepSeekBrowserService]] as const)("%s packaged browser launch", (_name, Service) => {
  it("uses the bundled executable directly while retaining sandbox, headless mode and no deadline", async () => {
    const { service, launch, context, profile } = await fixture(Service);
    const executablePath = path.resolve("resources", "chromium", "chrome.exe");
    vi.stubEnv("DRAW_STUDIO_BROWSER_EXECUTABLE", executablePath);
    try {
      await (service as any).launch();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledWith(profile, expect.objectContaining({ executablePath, chromiumSandbox: true, headless: true, timeout: 0 }));
      expect(launch.mock.calls[0][1]).not.toHaveProperty("channel");
      expect(context.setDefaultTimeout).toHaveBeenCalledWith(0); expect(context.setDefaultNavigationTimeout).toHaveBeenCalledWith(0);
    } finally { await service.close(); }
  });
  it("retains the system-channel then Playwright fallback when the override is absent", async () => {
    const { service, launch, context, profile } = await fixture(Service);
    vi.stubEnv("DRAW_STUDIO_BROWSER_EXECUTABLE", "");
    launch.mockRejectedValueOnce(new Error("synthetic system browser unavailable")).mockResolvedValueOnce(context as any);
    try {
      await (service as any).launch();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(launch.mock.calls[0]).toEqual([profile, expect.objectContaining({ channel: process.platform === "win32" ? "msedge" : "chrome" })]);
      expect(launch.mock.calls[1][1]).not.toHaveProperty("channel"); expect(launch.mock.calls[1][1]).not.toHaveProperty("executablePath");
    } finally { await service.close(); }
  });
  it("reports a broken bundled executable without switching to an unrelated installed browser", async () => {
    const { service, launch } = await fixture(Service);
    vi.stubEnv("DRAW_STUDIO_BROWSER_EXECUTABLE", path.resolve("missing", "chrome.exe"));
    launch.mockRejectedValue(new Error("synthetic missing packaged executable"));
    try {
      await expect((service as any).launch()).rejects.toMatchObject({ status: 503 });
      expect(launch).toHaveBeenCalledTimes(1);
    } finally { await service.close(); }
  });
});
