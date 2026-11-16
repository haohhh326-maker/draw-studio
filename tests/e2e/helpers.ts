import { expect, type Page } from "@playwright/test";

export async function openCanvasAddMenu(page: Page, position = { x: 250, y: 260 }) {
  const pane = page.locator(".react-flow__pane");
  await pane.click({ button: "right", position });
  await expect(page.getByRole("menu", { name: "添加到画布" })).toBeVisible();
}

export async function dropFileOnCanvas(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const shell = await page.locator(".canvas-shell").boundingBox();
  if (!shell) throw new Error("Canvas shell is not visible");
  await page.evaluate(({ name, mimeType, bytes, x, y }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
    document.querySelector(".canvas-shell")?.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: x,
      clientY: y,
    }));
  }, {
    name: file.name,
    mimeType: file.mimeType,
    bytes: Array.from(file.buffer),
    x: shell.x + 220,
    y: shell.y + 520,
  });
}
