import { build } from "esbuild";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const runtime = path.join(root, ".desktop-package", "resources");
await build({ entryPoints: [path.join(root, "scripts", "desktop-server.ts")],
  outfile: path.join(runtime, "desktop-server.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["playwright", "sharp", "ws", "form-data", "node-fetch"],
  define: { "import.meta.url": "__filename_url", "import.meta.env.BASE_URL": JSON.stringify("/") },
  banner: { js: 'const __filename_url = require("node:url").pathToFileURL(__filename).href;' },
});
const cache = await fs.realpath(path.join(root, ".cache"));
const temporary = await fs.mkdtemp(path.join(cache, "desktop-archive-smoke-"));
let child;
try {
  await fs.mkdir(path.join(temporary, "workflows"));
  await fs.cp(path.join(runtime, "seed", "workflows", "library"), path.join(temporary, "workflows", "library"), { recursive: true });
  await fs.cp(path.join(runtime, "seed", "resources"), path.join(temporary, "resources"), { recursive: true });
  await fs.writeFile(path.join(temporary, "workflow-library.settings.json"), JSON.stringify({ sourcePath: path.join(temporary, "workflows", "library") }));
  for (let round = 0; round < 3; round++) {
    child = fork(path.join(runtime, "desktop-server.cjs"), [], {
      execPath: path.join(root, "release", "win-unpacked", "Draw studio.exe"), cwd: temporary, silent: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CANVAS_ROOT: temporary, CANVAS_DIST: path.join(runtime, "dist"),
        CANVAS_PORT: "0", CANVAS_INSTANCE_ID: "archive-round-" + round, DRAW_STUDIO_DATA_HOME: path.join(temporary, "services"),
        CANVAS_TRANSFER_ROOT: path.join(temporary, "workflows") },
    });
    child.stdout.resume(); child.stderr.resume();
    const started = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("exit", code => reject(new Error("Archive service exited " + code)));
      child.on("message", value => { if (value.type === "draw-studio-server-ready") resolve(value); });
    });
    const response = await fetch(started.url + "__canvas/workflow-library");
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    const encrypted = snapshot.workflows.filter(workflow => workflow.original?.executionStatus === "encrypted");
    const ready = encrypted.filter(workflow => workflow.template && !workflow.library?.executionIssue);
    assert.equal(snapshot.workflows.length, 79); assert.equal(snapshot.scanned, 79);
    assert.equal(snapshot.issues.length, 7); assert.equal(encrypted.length, 69); assert.equal(ready.length, 69);
    const exited = once(child, "exit");
    child.send({ type: "draw-studio-server-stop" });
    assert.deepEqual(await exited, [0, null]);
    console.log(JSON.stringify({ round: round + 1, total: snapshot.workflows.length, encryptedReady: ready.length, diagnostics: snapshot.issues.length }));
  }
} finally {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  if (path.dirname(temporary) !== cache || !path.basename(temporary).startsWith("desktop-archive-smoke-")) throw new Error("测试目录超出范围。" );
  await fs.rm(temporary, { recursive: true, force: true });
}
