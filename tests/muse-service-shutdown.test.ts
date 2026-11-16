import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { MuseBrowserService } from "../scripts/muse-browser-service";

it("waits for an in-flight browser launch before closing its context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "draw-muse-shutdown-test-"));
  const service = new MuseBrowserService(root);
  const context = new EventEmitter() as any;
  context.setDefaultTimeout = vi.fn(); context.setDefaultNavigationTimeout = vi.fn();
  context.close = vi.fn(async () => { context.emit("close"); });
  let release!: (value: any) => void, entered!: () => void;
  const pending = new Promise<any>(resolve => { release = resolve; });
  const launchEntered = new Promise<void>(resolve => { entered = resolve; });
  const launchMock = vi.spyOn(chromium, "launchPersistentContext").mockImplementation(() => { entered(); return pending; });
  try {
    await service.session();
    const launch = (service as any).launch();
    await launchEntered;
    let stopped = false;
    const closing = service.close().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false); expect(context.close).not.toHaveBeenCalled();
    release(context);
    await launch; await closing;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect((service as any).context).toBeUndefined();
    expect((service as any).closing).toBe(true);
    expect(launchMock).toHaveBeenCalledTimes(1);
  } finally {
    release(context); await service.close(); launchMock.mockRestore();
    const resolved = await fs.realpath(root);
    if (path.dirname(resolved).toLowerCase() === (await fs.realpath(os.tmpdir())).toLowerCase() && path.basename(resolved).startsWith("draw-muse-shutdown-test-")) await fs.rm(resolved, { recursive: true, force: true });
  }
});
