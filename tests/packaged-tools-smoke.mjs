import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.DRAW_STUDIO_SMOKE_APP || path.join(root, "release", "win-unpacked"));
const resources = path.join(appDirectory, "resources", "draw-studio");
const requireRuntime = createRequire(path.join(resources, "desktop-server.cjs"));
const { chromium } = requireRuntime("playwright");
const sharp = requireRuntime("sharp");
const tools = path.join(resources, "tools");
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const environment = { ...process.env, PATH: [tools, path.join(systemRoot, "System32"), systemRoot].join(path.delimiter) };
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "draw-studio-packaged-tools-"));
const instanceId = "packaged-tools-" + process.pid;
let browser, child;
let stderr = "";

async function command(binary, args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(binary, args, { env: environment, cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [], errors = [];
    processHandle.stdout.on("data", value => output.push(value));
    processHandle.stderr.on("data", value => errors.push(value));
    processHandle.once("error", reject);
    processHandle.once("close", code => {
      if (code !== 0) reject(new Error(path.basename(binary) + " failed with code " + code + ": " + Buffer.concat(errors).toString().slice(-2000)));
      else resolve(Buffer.concat(output).toString());
    });
  });
}
function waitReady(processHandle) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { processHandle.off("message", message); processHandle.off("error", error); processHandle.off("exit", exit); };
    const error = reason => { cleanup(); reject(reason); };
    const exit = code => error(new Error("Packaged Electron Node server exited before readiness " + code + ": " + stderr));
    const message = value => {
      if (value?.type === "draw-studio-server-ready" && value.instanceId === instanceId) { cleanup(); resolve(value); }
      if (value?.type === "draw-studio-server-error") error(new Error(value.error + ": " + stderr));
    };
    processHandle.on("message", message); processHandle.once("error", error); processHandle.once("exit", exit);
  });
}
try {
  const ffmpeg = path.join(tools, "ffmpeg.exe"), ffprobe = path.join(tools, "ffprobe.exe");
  const ffmpegVersion = (await command(ffmpeg, ["-version"])).split(/\r?\n/)[0];
  const ffprobeVersion = (await command(ffprobe, ["-version"])).split(/\r?\n/)[0];
  assert.match(ffmpegVersion, /^ffmpeg version /); assert.match(ffprobeVersion, /^ffprobe version /);
  const input = path.join(workspace, "hevc-source.mp4");
  await command(ffmpeg, ["-nostdin", "-v", "error", "-i", path.join(root, "tests", "live", "reference.mp4"),
    "-t", "0.6", "-vf", "scale=128:128", "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-x265-params", "log-level=error:pools=1:frame-threads=1", "-an", "-y", input]);
  const source = JSON.parse(await command(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", input]));
  assert.equal(source.streams[0].codec_name, "hevc");

  // A stale writable copy must not shadow the engine shipped by an update.
  const staleBridge = path.join(workspace, ".cache", "native-filezilla-official", "bridge");
  await fs.mkdir(staleBridge, { recursive: true });
  await fs.writeFile(path.join(staleBridge, "cloud-transfer-bridge"), "outdated fixture engine");
  child = fork(path.join(resources, "desktop-server.cjs"), [], {
    execPath: path.join(appDirectory, "Draw studio.exe"), cwd: workspace, silent: true,
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1", CANVAS_ROOT: workspace, CANVAS_DIST: path.join(resources, "dist"),
      CANVAS_PORT: "0", CANVAS_INSTANCE_ID: instanceId, DRAW_STUDIO_DATA_HOME: path.join(workspace, "services"),
      DRAW_STUDIO_BROWSER_EXECUTABLE: path.join(resources, "browser", "chrome-win64", "chrome.exe"),
      CANVAS_TRANSFER_ROOT: path.join(workspace, "workflows"),
      CANVAS_TRANSFER_ENGINE_BINARY: path.join(resources, "seed", ".cache", "native-filezilla-official", "bridge", "cloud-transfer-bridge"),
      CANVAS_TRANSFER_ENGINE_LIBRARIES: path.join(resources, "seed", ".cache", "native-filezilla-official", "prefix", "lib"),
    },
  });
  child.stdout.resume(); child.stderr.on("data", value => { stderr += value.toString(); });
  const ready = await waitReady(child);
  assert.equal((await (await fetch(ready.url + "__canvas/desktop-health")).json()).instanceId, instanceId);
  const response = await fetch(ready.url + "__canvas/video-playback", {
    method: "POST", headers: { "Content-Type": "video/mp4" }, body: await fs.readFile(input),
  });
  if (response.status !== 200) throw new Error("Packaged compatibility API failed " + response.status + ": " + await response.text());
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("x-video-source-codec"), "hevc");
  const compatible = Buffer.from(await response.arrayBuffer()), output = path.join(workspace, "compatible-h264.mp4");
  await fs.writeFile(output, compatible);
  const transcoded = JSON.parse(await command(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", output]));
  assert.deepEqual(transcoded.streams[0], { codec_name: "h264", width: 128, height: 128, pix_fmt: "yuv420p" });

  browser = await chromium.launch({ executablePath: path.join(resources, "browser", "chrome-win64", "chrome.exe"),
    headless: true, chromiumSandbox: true, timeout: 0, env: environment });
  const context = await browser.newContext({ viewport: { width: 600, height: 400 }, offline: true });
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Draw studio offline tools</title><body style="margin:0;background:rgb(42,211,119)"><h1>Bundled Chromium renders offline</h1></body>');
  assert.equal(await page.title(), "Draw studio offline tools");
  const screenshot = await page.screenshot();
  const pixels = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (350 * pixels.info.width + 550) * 4;
  assert.deepEqual([...pixels.data.subarray(offset, offset + 4)], [42, 211, 119, 255]);
  const playback = await page.evaluate(async bytes => {
    const video = document.createElement("video"); video.muted = true; video.playsInline = true;
    document.body.append(video);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }));
    try {
      const loaded = new Promise((resolve, reject) => {
        video.addEventListener("loadeddata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("Bundled Chromium cannot decode converted video: " + video.error?.code)), { once: true });
      });
      video.src = url; video.load(); await loaded; await video.play();
      await new Promise(resolve => video.requestVideoFrameCallback(resolve));
      const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const drawing = canvas.getContext("2d"); drawing.drawImage(video, 0, 0);
      const rgba = drawing.getImageData(0, 0, 1, 1).data;
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState, alpha: rgba[3] };
    } finally { video.pause(); video.removeAttribute("src"); video.load(); video.remove(); URL.revokeObjectURL(url); }
  }, [...compatible]);
  assert.equal(playback.width, 128); assert.equal(playback.height, 128); assert.equal(playback.alpha, 255);
  assert.ok(playback.readyState >= 2 && playback.duration > 0);

  // This endpoint executes only the local engine's --version operation.
  const engineResponse = await fetch(ready.url + "__canvas/cloud-files/status");
  assert.equal(engineResponse.status, 200);
  const engine = await engineResponse.json();
  assert.equal(engine.available, true, "The packaged FileZilla bridge did not report a usable local engine");
  assert.ok(engine.version);
  assert.equal(engine.localRoot, path.join(workspace, "workflows"));
  assert.deepEqual(engine.buckets.map(bucket => bucket.id), ["comfyui_nodes", "loras", "cloud_upload"]);
  await context.close(); await browser.close(); browser = undefined;
  const exited = once(child, "exit"); child.send({ type: "draw-studio-server-stop" });
  assert.deepEqual(await exited, [0, null]); child = undefined;
  console.log(JSON.stringify({ passed: true, ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion,
    browser: "bundled Chromium, offline screenshot pixel verified", conversion: { source: "hevc", output: transcoded.streams[0], playback },
    fileTransfer: { available: engine.available, engine: engine.engine, version: engine.version, probe: "local --version only" },
    runtime: "packaged Electron Node", isolatedPath: true, serverExitCode: 0 }, null, 2));
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (child.connected) child.disconnect(); else child.kill();
    await exited;
  }
  await fs.rm(workspace, { recursive: true, force: true });
}
