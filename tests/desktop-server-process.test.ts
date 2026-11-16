import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
let folder: string, entry: string;
beforeAll(async () => {
  const cache = path.resolve(".cache"); await mkdir(cache, { recursive: true });
  folder = await mkdtemp(path.join(cache, "desktop-server-process-test-"));
  entry = path.join(folder, "desktop-server.cjs");
  await build({ entryPoints: [path.resolve("scripts/desktop-server.ts")], outfile: entry, bundle: true,
    platform: "node", format: "cjs", target: "node22", logLevel: "silent",
    external: ["playwright", "sharp", "ws", "form-data", "node-fetch"],
    define: { "import.meta.url": "__filename_url" },
    banner: { js: 'const __filename_url = require("node:url").pathToFileURL(__filename).href;' },
  });
  await mkdir(path.join(folder, "dist"));
  await writeFile(path.join(folder, "dist", "index.html"), "<!doctype html><title>Compiled desktop fixture</title>");
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
});
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });
function ready(child: ChildProcess) {
  return new Promise<{ type: string; instanceId: string; pid: number; port: number; url: string }>((resolve, reject) => {
    const cleanup = () => { child.off("message", message); child.off("error", failed); child.off("exit", exited); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null) => failed(new Error("Compiled desktop service exited before ready, code " + code));
    const message = (value: any) => {
      if (value?.type === "draw-studio-server-ready") { cleanup(); resolve(value); }
      else if (value?.type === "draw-studio-server-error") failed(new Error(value.error));
    };
    child.on("message", message); child.once("error", failed); child.once("exit", exited);
  });
}
describe.each(["stop message", "parent disconnect"])("compiled desktop Node child, %s", stopMode => {
  it.each([0, 1, 2])("starts from a separate writable workspace and releases its listener, round %i", async repetition => {
      const workspace = path.join(folder, stopMode.replaceAll(" ", "-") + repetition); await mkdir(workspace);
      const instanceId = "compiled-fixture-" + repetition;
      const child = fork(entry, [], { cwd: workspace, silent: true, env: { ...process.env,
        CANVAS_ROOT: workspace, CANVAS_DIST: path.join(folder, "dist"), CANVAS_PORT: "0", CANVAS_INSTANCE_ID: instanceId,
        DRAW_STUDIO_DATA_HOME: path.join(workspace, "services"), CANVAS_TRANSFER_ROOT: path.join(workspace, "workflows"),
      } });
      children.push(child); child.stdout?.resume(); child.stderr?.resume();
      const started = await ready(child);
      expect(started).toMatchObject({ type: "draw-studio-server-ready", instanceId, pid: child.pid }); expect(started.port).toBeGreaterThan(0);
      const health = await fetch(started.url + "__canvas/desktop-health");
      expect(await health.json()).toMatchObject({ ok: true, service: "draw-studio-desktop", instanceId, pid: child.pid });
      expect(await (await fetch(started.url)).text()).toContain("Compiled desktop fixture");
      const reader = await fetch(started.url + "__canvas/workflow-reader", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "comfyui", source: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "compiled-fixture" } } } }) });
      expect(reader.status).toBe(200); expect((await reader.json()).upstream.revision).toBe("bdcf3bec054594fcab591952a8c5acef858d6de4");
      const exit = once(child, "exit");
      if (stopMode === "stop message") child.send({ type: "draw-studio-server-stop" }); else child.disconnect();
      expect(await exit).toEqual([0, null]);
      await expect(fetch(started.url)).rejects.toThrow();
  });
});
