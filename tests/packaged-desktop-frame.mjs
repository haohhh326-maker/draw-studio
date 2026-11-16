import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { expect } from "@playwright/test";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(projectRoot, "..", "packaged-desktop-verification");
const baseline = JSON.parse(await readFile(process.env.DRAW_STUDIO_SMOKE_PREVIOUS_REPORT ?? path.join(artifacts, "packaged-desktop-verification.json"), "utf8"));
const executable = path.join(baseline.isolatedPackage, "Draw studio.exe");
const ffmpeg = path.join(baseline.isolatedPackage, "resources", "draw-studio", "tools", "ffmpeg.exe");
const report = { executable, userData: baseline.userData, rounds: [], finished: false };
let application;

async function nativeScreenshot(handle, filename, expectedColor) {
  const output = path.join(artifacts, filename);
  const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "gdigrab", "-draw_mouse", "0", "-i", "hwnd=0x" + handle,
    "-frames:v", "1", "-vf", "scale=1600:-2", "-update", "1", output], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", bytes => { errors += bytes; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, errors);
  const metadata = await sharp(output).metadata();
  const center = await sharp(output).extract({ left: Math.round(metadata.width * .3), top: 5, width: Math.round(metadata.width * .4), height: 22 }).removeAlpha().raw().toBuffer();
  const captionMean = [0, 0, 0];
  for (let index = 0; index < center.length; index += 3) {
    captionMean[0] += center[index]; captionMean[1] += center[index + 1]; captionMean[2] += center[index + 2];
  }
  for (let channel = 0; channel < 3; channel++) captionMean[channel] /= center.length / 3;
  assert(captionMean.every((value, channel) => Math.abs(value - expectedColor[channel]) < 3), "The actual native caption must match the canvas toolbar surface");
  return { output, width: metadata.width, height: metadata.height, captionMean };
}

async function nativeInput(entry, action) {
  const code = `
$ErrorActionPreference = "Stop"
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class FrameNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static void Act(IntPtr window, uint expectedProcess, double scale, string action) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    uint process; GetWindowThreadProcessId(window, out process);
    if (process != expectedProcess) throw new Exception("The native window does not belong to the isolated application.");
    SetForegroundWindow(window);
    if (GetForegroundWindow() != window) throw new Exception("The isolated window is not in the foreground.");
    Rect bounds; if (!GetWindowRect(window, out bounds)) throw new Exception("The isolated window bounds are unavailable.");
    Point previous; GetCursorPos(out previous);
    Point origin = new Point(); ClientToScreen(window, ref origin);
    int x = origin.X + (int)(240 * scale), y = origin.Y + (int)(18 * scale);
    if (action == "minimize") x = bounds.Right - (int)(115 * scale);
    if (action == "maximize") x = bounds.Right - (int)(69 * scale);
    if (action == "close") x = bounds.Right - (int)(23 * scale);
    if (action == "doubleclick") Thread.Sleep((int)GetDoubleClickTime() + 100);
    SetCursorPos(x, y); mouse_event(2, 0, 0, 0, UIntPtr.Zero);
    try {
      if (action == "drag") {
        for (int step = 1; step <= 20; step++) {
          int targetX = x + (int)(50 * scale * step / 20), targetY = y + (int)(24 * scale * step / 20);
          uint absoluteX = (uint)Math.Round((targetX - GetSystemMetrics(76)) * 65535.0 / (GetSystemMetrics(78) - 1));
          uint absoluteY = (uint)Math.Round((targetY - GetSystemMetrics(77)) * 65535.0 / (GetSystemMetrics(79) - 1));
          mouse_event(0xC001, absoluteX, absoluteY, 0, UIntPtr.Zero);
          Thread.Sleep(15);
        }
      } else if (action == "doubleclick") {
        Thread.Sleep(60); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(80); mouse_event(2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(60);
      } else Thread.Sleep(60);
    } finally { mouse_event(4, 0, 0, 0, UIntPtr.Zero); if (action == "drag") Thread.Sleep(200); SetCursorPos(previous.X, previous.Y); }
  }
}
'@
[FrameNativeInput]::Act([IntPtr]::new([Convert]::ToInt64("${entry.handle}",16)), [uint32]${entry.pid}, [double]${entry.scaleFactor}, "${action}")
`;
  const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", bytes => { errors += bytes; }); child.stdout.resume();
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exitCode, 0, errors);
  return { action, method: "native mouse input", processId: entry.pid };
}

try {
  for (let round = 0; round < 3; round++) {
    const env = { ...process.env, DRAW_STUDIO_USER_DATA: baseline.userData, DRAW_STUDIO_PORT: String(baseline.port) };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: executable, env, timeout: 120000 });
    const page = await application.firstWindow({ timeout: 120000 });
    await page.waitForURL(`http://127.0.0.1:${baseline.port}/`);
    await page.locator(".project-card").click();
    await expect(page.locator(".canvas-shell")).toBeVisible();
    await expect(page.getByLabel("Draw studio 标题栏", { exact: true })).toBeVisible();
    const entry = await application.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows()[0], handle = main.getNativeWindowHandle();
      return { title: main.getTitle(), id: main.id, pid: process.pid, bounds: main.getBounds(), scaleFactor: screen.getDisplayMatching(main.getBounds()).scaleFactor,
        handle: handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16) };
    });
    report.rounds.push(entry);
    assert.equal(entry.title, "Draw studio");
    entry.frontend = await page.locator('script[type="module"][src]').getAttribute("src");
    entry.caption = await page.getByLabel("Draw studio 标题栏", { exact: true }).evaluate(element => ({ height: element.getBoundingClientRect().height,
      background: getComputedStyle(element).backgroundColor, toolbarBackground: getComputedStyle(document.querySelector(".floating-toolbar")).backgroundColor,
      drag: getComputedStyle(element).getPropertyValue("-webkit-app-region") }));
    assert.equal(entry.caption.height, 36);
    assert.equal(entry.caption.background, entry.caption.toolbarBackground);
    assert.equal(entry.caption.drag, "drag");
    const expectedColor = entry.caption.background.match(/\d+/g).slice(0, 3).map(Number);
    entry.native = await nativeScreenshot(entry.handle, round ? `packaged-titlebar-${round + 1}.png` : "packaged-titlebar.png", expectedColor);
    console.log("Actual native caption verified", entry.native.output);
    await expect(page.getByRole("img", { name: "packaged-reference.png", exact: true })).toBeVisible();
    const assets = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("clearframe-canvas", 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const library = await new Promise((resolve, reject) => {
          const request = database.transaction("records").objectStore("records").get("project-library");
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        return Object.keys(library[sessionStorage.getItem("clearframe-open-project")].project.assets);
      } finally { database.close(); }
    });
    assert.deepEqual(assets.sort(), baseline.launches[0].assets.map(asset => asset.id).sort());
    entry.assets = assets;
    if (round === 0) {
      entry.controls = [await nativeInput(entry, "maximize")];
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
      entry.maximizedNative = await nativeScreenshot(entry.handle, "packaged-titlebar-maximized.png", expectedColor);
      entry.controls.push(await nativeInput(entry, "maximize"));
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
      entry.controls.push(await nativeInput(entry, "minimize"));
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
      await application.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]; main.restore(); main.focus(); });
      entry.minimizeRestore = true;
      entry.controls.push(await nativeInput(entry, "doubleclick"));
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
      entry.controls.push(await nativeInput(entry, "doubleclick"));
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 20, width: 1200, height: 760 }));
      const beforeDrag = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      entry.controls.push(await nativeInput(entry, "drag"));
      const afterDrag = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      entry.drag = { before: beforeDrag, after: afterDrag };
      assert(Math.abs(afterDrag.x - beforeDrag.x) > 15 || Math.abs(afterDrag.y - beforeDrag.y) > 15, "Dragging the real caption must move the window");
      await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), entry.bounds);
    }
    const closed = application.waitForEvent("close", { timeout: 30000 });
    entry.close = await nativeInput(entry, "close");
    await closed; application = undefined;
  }
  report.finished = true;
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(error); process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  await writeFile(path.join(artifacts, "packaged-titlebar-verification.json"), JSON.stringify(report, null, 2) + "\n");
}
