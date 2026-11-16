import { test, expect } from "@playwright/test";

test("canvas docks use circular actions and the service menu contains Muse and DeepSeek", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".project-home-settings")).toHaveCount(0);
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("工具栏检查");
  await page.getByRole("button", { name: "创建并打开", exact: true }).click();
  const dock = page.getByRole("navigation", { name: "画布工具栏", exact: true });
  await expect(dock.getByRole("button")).toHaveCount(4);
  await expect(dock.getByRole("button", { name: "资产库", exact: true })).toBeVisible();
  const shape = await dock.getByRole("button", { name: "资产库", exact: true }).evaluate(element => {
    const button = getComputedStyle(element), circle = getComputedStyle(element, "::before");
    return { buttonRadius: button.borderRadius, circleRadius: circle.borderRadius, circleVisible: circle.content,
      dockBackground: getComputedStyle(element.closest(".floating-toolbar")!).backgroundColor,
      buttonBackground: button.backgroundColor, circleBackground: circle.backgroundColor, iconColor: button.color };
  });
  expect(shape.buttonRadius).toBe("21px");
  expect(shape.circleRadius).toBe("50%");
  expect(shape.circleVisible).not.toBe("none");
  expect(shape.dockBackground).toBe("rgb(38, 40, 42)");
  expect(shape.buttonBackground).toBe("rgba(0, 0, 0, 0)");
  expect(shape.circleBackground).toBe("rgb(30, 32, 34)");
  expect(shape.iconColor).toBe("rgb(245, 245, 245)");
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  const services = page.getByRole("menu", { name: "网页服务", exact: true });
  await expect(services.getByRole("menuitem")).toHaveText(["Muse", "DeepSeek"]);
  await expect(page.getByRole("menuitem", { name: "切换全屏", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 800 });
  const top = page.locator(".top-actions");
  const bounds = await top.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100);
  await expect(page.getByRole("button", { name: "远程连接", exact: true })).toBeVisible();
});
