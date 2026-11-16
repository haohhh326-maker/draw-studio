import { test, expect, type Page } from "@playwright/test";
import { dropFileOnCanvas, openCanvasAddMenu } from "./helpers";

async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill(name);
  await page.getByRole("button", { name: "创建并打开" }).click();
  await expect(page.locator(".canvas-shell")).toBeVisible();
}

test("home creates isolated projects and preserves assets, text and canvases after exit and reload", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await expect(page.locator(".canvas-shell")).toHaveCount(0);
  await create(page, "森林分镜");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.getByLabel("场景", { exact: true })).toHaveCount(0);
  await expect(page.locator(".canvas-heading")).toHaveCount(0);
  await openCanvasAddMenu(page);
  await page.getByRole("menuitem", { name: "文本" }).click();
  await page.locator(".note").fill("森林晨雾与缓慢推进的镜头");
  await dropFileOnCanvas(page, {
    name: "forest.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.locator('img[alt="forest.png"]')).toBeVisible();
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await expect(
    page.getByRole("button", { name: "打开项目：森林分镜" }),
  ).toBeVisible();
  await create(page, "海边分镜");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".project-card")).toHaveCount(2);
  await page.getByRole("button", { name: "打开项目：森林分镜" }).click();
  await expect(
    page.getByRole("button", { name: "画布 2", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "画布 1", exact: true }).click();
  await expect(page.locator(".note")).toHaveValue("森林晨雾与缓慢推进的镜头");
  await expect(page.locator('img[alt="forest.png"]')).toBeVisible();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await expect(page.getByLabel("项目名称")).toHaveValue("森林分镜");
  await expect(page.locator(".note")).toHaveValue("森林晨雾与缓慢推进的镜头");
  const fresh = await context.newPage();
  await fresh.goto("/");
  await expect(fresh.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await expect(fresh.locator(".project-card")).toHaveCount(2);
  await fresh.close();
});

test("old single-project save is listed on first visit and opens without losing its canvas", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "最近项目" }).waitFor();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("clearframe-canvas", 1);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(
        {
          version: 2,
          id: "legacy-project",
          name: "之前的创作",
          scenes: [{ id: "s", name: "场景 01" }],
          canvases: [
            {
              id: "c",
              sceneId: "s",
              name: "画布 1",
              nodes: [
                {
                  id: "old",
                  type: "media",
                  position: { x: 200, y: 150 },
                  data: {
                    kind: "text",
                    title: "笔记 1",
                    text: "保留旧画布内容",
                  },
                },
              ],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          ],
          activeCanvasId: "c",
          assets: {},
          tasks: {},
          history: [],
          updatedAt: Date.now(),
        },
        "project",
      );
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "打开项目：之前的创作" }).click();
  await expect(page.locator(".note")).toHaveValue("保留旧画布内容");
  await expect(page.locator(".node-caption")).toContainText("文本 1");
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await create(page, "新的创作");
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".project-card")).toHaveCount(2);
  await page.getByRole("button", { name: "打开项目：之前的创作" }).click();
  await expect(page.locator(".note")).toHaveValue("保留旧画布内容");
});

test("project deletion is permanent and storage location offers portable export", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "showDirectoryPicker", {
      value: undefined,
      configurable: true,
    }),
  );
  await page.goto("/");
  await create(page, "待删除的项目");
  await openCanvasAddMenu(page);
  await page.getByRole("menuitem", { name: "文本" }).click();
  await page.getByLabel("文本内容").fill("删除后不应恢复");
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await page.getByRole("heading", { name: "最近项目" }).waitFor();
  await page.getByRole("button", { name: "存放路径", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "存放路径" });
  await expect(dialog).toContainText("不支持直接选择文件夹");
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出项目文件" }).click();
  expect((await downloaded).suggestedFilename()).toBe("待删除的项目.aicanvas");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "删除项目：待删除的项目" }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开项目：待删除的项目" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "删除项目：待删除的项目" }).click();
  await page.getByRole("button", { name: "永久删除" }).click();
  await expect(
    page.getByRole("button", { name: "打开项目：待删除的项目" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开项目：待删除的项目" })).toHaveCount(0);
});
