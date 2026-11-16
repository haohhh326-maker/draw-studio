import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { dropFileOnCanvas } from "./helpers";

test("cached video posters remain visible between hovers and after reopening the canvas", async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/api/muse/**", route => route.abort());
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Isolated video poster preview");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await dropFileOnCanvas(page, { name: "poster-preview.mp4", mimeType: "video/mp4", buffer: await readFile(new URL("../live/reference.mp4", import.meta.url)) });
  const node = page.locator(".react-flow__node");
  await expect(node).toHaveCount(1);
  await node.hover();
  const video = node.locator("video[data-asset-id]");
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const assetId = (await video.getAttribute("data-asset-id"))!;

  async function expectPoster() {
    await page.mouse.move(1200, 850);
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("data-asset-id", assetId);
    await expect(video).toHaveAttribute("poster", /^blob:/);
    await expect(video).toHaveAttribute("preload", "none");
    await expect(video).not.toHaveAttribute("src");
  }
  async function expectVisiblePosterPixels() {
    const opaquePixels = await video.evaluate(async element => {
      const response = await fetch((element as HTMLVideoElement).poster);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) opaque++;
      return opaque;
    });
    expect(opaquePixels).toBeGreaterThan(0);
    const pixels = await sharp(await video.screenshot()).stats();
    expect(pixels.channels[2].mean - pixels.channels[0].mean).toBeGreaterThan(15);
  }
  await expectPoster();
  await expectVisiblePosterPixels();
  await page.screenshot({ path: testInfo.outputPath("video-poster-visible.png") });
  for (let cycle = 0; cycle < 3; cycle++) {
    await video.hover();
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
    await expectPoster();
  }

  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await expect(node).toHaveCount(1);
  await expectPoster();
  await expectVisiblePosterPixels();
  await video.hover();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await expectPoster();

  // Emulate a poster created by the old loadeddata capture before its first
  // presented frame. Reopening must replace this transparent cache from MP4.
  await page.evaluate(async id => {
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    const transparent = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/webp"));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("assets", "readwrite");
      tx.objectStore("assets").put(transparent, "thumb-" + id);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, assetId);
  await page.reload();
  await expect(node).toHaveCount(1);
  await expectPoster();
  await expectVisiblePosterPixels();
  await page.reload();
  await expectPoster();
  await expectVisiblePosterPixels();
  expect(failures).toEqual([]);
});
