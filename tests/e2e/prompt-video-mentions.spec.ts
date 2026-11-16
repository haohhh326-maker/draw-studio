import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import type { Project } from "../../src/types";
import { encodePromptMention, parsePromptMentions } from "../../src/semantic/mentions";
import { openCanvasAddMenu } from "./helpers";

async function storedPrompt(page: Page, nodeId: string) {
  return page.evaluate(async nodeId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const library = await new Promise<Record<string, { project: Project }>>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get("project-library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const project = library[sessionStorage.getItem("clearframe-open-project")!].project;
    return project.canvases.flatMap(canvas => canvas.nodes).find(node => node.id === nodeId)?.data.generation?.prompt;
  }, nodeId);
}

async function setPosterCache(page: Page, assetId: string, cache: "valid" | "missing" | "transparent") {
  await page.evaluate(async ({ assetId, cache }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (cache !== "valid") {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      const transparent = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/webp"));
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("assets", "readwrite");
        if (cache === "missing") transaction.objectStore("assets").delete("thumb-" + assetId);
        else transaction.objectStore("assets").put(transparent, "thumb-" + assetId);
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
    }
    db.close();
  }, { assetId, cache });
}

async function expectPosterMedia(media: Locator) {
  await expect(media).toBeVisible();
  await expect.poll(() => media.evaluate(element => element instanceof HTMLImageElement
    ? element.complete && element.naturalWidth > 0 : !!(element as HTMLVideoElement).poster)).toBe(true);
  await expect.poll(() => media.evaluate(async element => {
    try {
      const source = element instanceof HTMLImageElement ? element.src : (element as HTMLVideoElement).poster;
      const bitmap = await createImageBitmap(await (await fetch(source)).blob());
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
      return count;
    } catch { return 0; }
  })).toBeGreaterThan(0);
  await expect.poll(async () => {
    const pixels = await sharp(await media.screenshot()).stats();
    return pixels.channels[2].mean - pixels.channels[0].mean;
  }).toBeGreaterThan(15);
}

for (const cache of ["valid", "missing", "transparent"] as const) {
  test(`video mention candidates and copied chips show real poster pixels with ${cache} cache`, async ({ page }, testInfo) => {
    const failures: string[] = [], unexpectedCalls: string[] = [];
    page.on("pageerror", error => failures.push(error.message));
    await page.route("**/api/muse/**", route => {
      if (new URL(route.request().url()).pathname === "/api/muse/session") return route.fulfill({ json: { status: "connected" } });
      unexpectedCalls.push(route.request().url()); return route.abort();
    });
    await page.route(/https:\/\/(?:[^/]+\.)?muse\.ai\/.*/, route => { unexpectedCalls.push(route.request().url()); return route.abort(); });
    await page.route("**/api/runninghub/**", route => route.abort());
    await page.goto("/");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称").fill("Isolated video mention " + cache);
    await page.getByRole("button", { name: "创建并打开" }).click();
    await page.getByRole("button", { name: "远程连接", exact: true }).click();
    await page.getByRole("dialog", { name: "选择算力", exact: true }).getByRole("radio", { name: /Muse/ }).click();
    await openCanvasAddMenu(page, { x: 200, y: 230 });
    await page.getByRole("menuitem", { name: "参考" }).click();
    const source = page.locator(".react-flow__node").filter({ hasText: "参考 1" });
    const sourceId = (await source.getAttribute("data-id"))!;
    await source.getByLabel("上传素材").setInputFiles({ name: "视频参考.mp4", mimeType: "video/mp4", buffer: await readFile(new URL("../live/reference.mp4", import.meta.url)) });
    const sourceVideo = source.locator("video[data-asset-id]");
    await expect(sourceVideo).toHaveAttribute("poster", /^blob:/);
    const assetId = (await sourceVideo.getAttribute("data-asset-id"))!;
    await openCanvasAddMenu(page, { x: 850, y: 260 });
    await page.getByRole("menuitem", { name: "视频" }).click();
    const target = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
    const targetId = (await target.getAttribute("data-id"))!;
    const from = (await source.locator(".react-flow__handle-right").boundingBox())!;
    const to = (await target.locator(".react-flow__handle-left").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await target.click();
    await page.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await page.mouse.move(1200, 160);
    await page.mouse.down();
    await page.mouse.move(450, 160, { steps: 15 });
    await page.mouse.up();
    await expect(source).toHaveCount(0);
    // Isolate mention rendering from the canvas source and input-strip preview.
    // Both would otherwise populate the cache before the mention loads it.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ".input-strip{display:none!important}";
        document.head.append(style);
      }, { once: true });
    });
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
    await setPosterCache(page, assetId, cache);
    await page.reload();
    await expect(source).toHaveCount(0);
    await page.locator(`.react-flow__node[data-id="${targetId}"]`).click();
    const panel = page.getByRole("region", { name: "视频 1生成面板", exact: true });
    await expect(panel.locator(".input-strip")).toBeHidden();
    const prompt = panel.getByRole("textbox", { name: "提示词", exact: true });
    await prompt.fill("起始动作 ");
    await prompt.press("End");
    await prompt.pressSequentially("@视频");
    const option = page.getByRole("listbox", { name: "已连接素材", exact: true }).getByRole("option", { name: "参考 1", exact: true });
    const candidateMedia = option.locator(".prompt-mention-preview").locator("img, video").first();
    await expectPosterMedia(candidateMedia);
    await option.click();
    const chip = prompt.locator("[data-prompt-mention]");
    const token = encodePromptMention(sourceId, "参考 1");
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expect(chip).not.toHaveClass(/unavailable/);
    const chipMedia = chip.locator(".prompt-mention-preview").locator("img, video").first();
    await expectPosterMedia(chipMedia);
    await prompt.pressSequentially(" 延续动作");
    await prompt.press("ControlOrMeta+A");
    const copied = await prompt.evaluate(element => {
      const data = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return { plain: data.getData("text/plain"), rich: data.getData("application/x-draw-studio-prompt") };
    });
    expect(copied.plain).toContain("@参考 1");
    expect(parsePromptMentions(copied.rich).filter(part => part.type === "mention")).toEqual([{ type: "mention", nodeId: sourceId, label: "参考 1", token }]);
    await prompt.press("Backspace");
    await prompt.evaluate((element, copied) => {
      const data = new DataTransfer();
      data.setData("text/plain", copied.plain); data.setData("application/x-draw-studio-prompt", copied.rich);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, copied);
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expectPosterMedia(chipMedia);
    await prompt.press("End");
    await prompt.pressSequentially("，保持服装");
    await prompt.focus();
    await chip.evaluate(element => {
      const range = document.createRange(); range.selectNode(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
    });
    await prompt.press("Backspace");
    await expect(chip).toHaveCount(0);
    await prompt.press("ControlOrMeta+Z");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expect(chip.locator(".prompt-mention-preview").locator("img, video")).toHaveCount(1);
    await expectPosterMedia(chipMedia);
    await expect(chip.locator(".prompt-mention-preview").locator("img, video")).toHaveCount(1);
    await prompt.press("ControlOrMeta+Shift+Z");
    await expect(chip).toHaveCount(0);
    await prompt.press("ControlOrMeta+Z");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expectPosterMedia(chipMedia);
    await expect(chip.locator(".prompt-mention-preview").locator("img, video")).toHaveCount(1);
    await panel.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await page.locator(`.react-flow__node[data-id="${targetId}"]`).click();
    await expect(prompt).toContainText("保持服装");
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expectPosterMedia(chipMedia);
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
    expect(await storedPrompt(page, targetId)).toContain(token);
    await setPosterCache(page, assetId, cache);
    await page.reload();
    await expect(source).toHaveCount(0);
    await page.locator(`.react-flow__node[data-id="${targetId}"]`).click();
    await expect(panel.locator(".input-strip")).toBeHidden();
    await expect(chip).toHaveAttribute("data-prompt-mention", token);
    await expectPosterMedia(chipMedia);
    await expect(prompt).toContainText("保持服装");
    await prompt.press("End");
    await prompt.pressSequentially(" @视频");
    await expectPosterMedia(candidateMedia);
    const screenshot = testInfo.outputPath("prompt-video-mention.png");
    await page.screenshot({ path: screenshot });
    if (cache === "valid" && testInfo.repeatEachIndex === 0) await copyFile(screenshot, path.resolve(process.cwd(), "..", "prompt-video-mention-verified.png"));
    expect(unexpectedCalls).toEqual([]);
    expect(failures).toEqual([]);
  });
}
