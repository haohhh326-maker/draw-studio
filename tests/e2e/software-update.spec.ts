import { expect, test, type Page } from "@playwright/test";
import { openCanvasAddMenu } from "./helpers";

interface CheckResult {
  currentVersion?: string;
  latestVersion?: string;
  configured?: boolean;
  available?: boolean;
  releaseNotes?: string;
  error?: string;
}
interface UpdateFixture {
  calls: { command: string; args: Record<string, unknown>; savedNames?: string[] }[];
  status: CheckResult & { phase: string; downloadedBytes?: number; totalBytes?: number; percent?: number; message?: string };
  autoFinish: boolean;
  complete?: () => void;
  fail?: (message: string) => void;
  saveCalls?: number;
  releaseSave?: () => void;
}
type ExitNavigationWindow = Window & {
  exitNavigationGate: { locked: boolean; release: () => void };
  exitNavigationOutcome: string;
  exitNavigationPromise: Promise<void>;
};

async function desktopHost(page: Page, results: CheckResult[]) {
  await page.addInitScript(checkResults => {
    const fixture: UpdateFixture = { calls: [], status: { currentVersion: "0.1.0", configured: false, available: false, phase: "idle" }, autoFinish: true };
    (window as Window & { updateFixture?: UpdateFixture }).updateFixture = fixture;
    window.drawStudioHost = { async invoke(command, args) {
      const call: UpdateFixture["calls"][number] = { command, args };
      fixture.calls.push(call);
      if (command === "get_software_update_status") return { ...fixture.status };
      if (command === "check_software_update") {
        const result = checkResults.length > 1 ? checkResults.shift()! : checkResults[0];
        if (result.error) { fixture.status = { ...fixture.status, phase: "error", error: result.error }; throw new Error(result.error); }
        fixture.status = { ...result, phase: "idle" };
        return fixture.status;
      }
      if (command === "open_software_update") {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("clearframe-canvas", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          call.savedNames = await new Promise<string[]>((resolve, reject) => {
            const transaction = database.transaction("records", "readonly");
            const request = transaction.objectStore("records").get("project-library");
            request.onsuccess = () => resolve(Object.values(request.result ?? {}).map(value => (value as { project: { name: string } }).project.name));
            request.onerror = () => reject(request.error);
          });
        } finally { database.close(); }
        fixture.status = { ...fixture.status, phase: "downloading", downloadedBytes: 0, totalBytes: 100 * 1024 * 1024, percent: 0, error: undefined, message: "正在下载安装包…" };
        if (!fixture.autoFinish) await new Promise<void>((resolve, reject) => {
          fixture.complete = resolve;
          fixture.fail = message => { fixture.status = { ...fixture.status, phase: "error", error: message }; reject(new Error(message)); };
        });
        fixture.status = { ...fixture.status, phase: "installing", message: "已启动新版安装程序。", percent: 100 };
        return { message: "已启动新版安装程序。" };
      }
      return {};
    } };
  }, results);
}

async function openProject(page: Page) {
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Software update fixture");
  await page.getByRole("button", { name: "创建并打开", exact: true }).click();
  await expect(page.locator(".canvas-shell")).toBeVisible();
}

async function commands(page: Page) {
  return page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.calls.filter(call => call.command.includes("software_update") && call.command !== "get_software_update_status"));
}

async function savedProjectIds(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const request = database.transaction("records").objectStore("records").get("project-library");
        request.onsuccess = () => resolve(Object.keys(request.result ?? {}));
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

test("the desktop exit hook preserves the home project list and waits for navigation to finish", async ({ page }) => {
  await desktopHost(page, [{ currentVersion: "0.1.0", configured: false, available: false }]);
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
  await page.evaluate(() => window.drawStudioSaveBeforeExit!());
  expect(await savedProjectIds(page)).toEqual([]);

  await page.evaluate(() => {
    const fixtureWindow = window as ExitNavigationWindow;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { release = resolve; });
    fixtureWindow.exitNavigationGate = { locked: false, release };
    void navigator.locks.request("clearframe-project-library", async () => {
      fixtureWindow.exitNavigationGate.locked = true;
      await locked;
    });
  });
  await expect.poll(() => page.evaluate(() => (window as ExitNavigationWindow).exitNavigationGate.locked)).toBe(true);
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Exit waits for project navigation");
  await page.getByRole("button", { name: "创建并打开", exact: true }).click();
  await expect(page.locator(".project-transition")).toBeVisible();
  const outcome = await page.evaluate(async () => {
    const fixtureWindow = window as ExitNavigationWindow;
    fixtureWindow.exitNavigationOutcome = "pending";
    fixtureWindow.exitNavigationPromise = window.drawStudioSaveBeforeExit!().then(() => {
      fixtureWindow.exitNavigationOutcome = "saved";
    });
    await Promise.resolve();
    return fixtureWindow.exitNavigationOutcome;
  });
  expect(outcome).toBe("pending");
  await page.evaluate(() => (window as ExitNavigationWindow).exitNavigationGate.release());
  await page.evaluate(() => (window as ExitNavigationWindow).exitNavigationPromise);
  await expect(page.locator(".project-transition")).toHaveCount(0);
  await expect(page.locator(".canvas-shell")).toBeVisible();
  const ids = await savedProjectIds(page);
  expect(ids).toHaveLength(1);
  await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
  await page.evaluate(() => window.drawStudioSaveBeforeExit!());
  expect(await savedProjectIds(page)).toEqual(ids);
  await page.reload();
  await expect(page.getByRole("button", { name: "打开项目：Exit waits for project navigation", exact: true })).toBeVisible();
  expect(await savedProjectIds(page)).toEqual(ids);
});

test("software update opens from the canvas and explains the browser preview", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openProject(page);
  await openCanvasAddMenu(page, { x: 480, y: 190 });
  await page.getByRole("menuitem", { name: "文本" }).click();
  await expect(page.getByLabel("文本内容", { exact: true })).toBeVisible();
  const entry = page.getByRole("button", { name: "软件更新", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("请从桌面版使用软件更新。");
  await expect(dialog.getByRole("button", { name: /选择.*安装包/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
  expect(await page.evaluate(() => typeof window.drawStudioSaveBeforeExit)).toBe("undefined");
  expect(pageErrors).toEqual([]);
});

test("an unconfigured update service is reported without an installer path chooser", async ({ page }) => {
  await desktopHost(page, [{ currentVersion: "0.1.0", configured: false, available: false }]);
  await openProject(page);
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await expect(dialog.getByRole("status")).toHaveText("软件更新服务尚未启用，请稍后检查。");
  await expect(dialog.getByRole("button", { name: /选择.*安装包|下载并更新/ })).toHaveCount(0);
  expect((await commands(page)).every(call => call.command === "check_software_update")).toBe(true);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Saved by desktop exit hook");
  await page.evaluate(() => window.drawStudioSaveBeforeExit!());
  await page.reload();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("Saved by desktop exit hook");
});

test("a failed startup check can retry and downloads only after confirmation", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await desktopHost(page, [
    { error: "更新服务暂时不可用" },
    { currentVersion: "0.1.0", latestVersion: "0.2.0", configured: true, available: true, releaseNotes: "改进视频引用预览\n保留工作流与项目数据" },
  ]);
  await openProject(page);
  await page.getByLabel("项目名称", { exact: true }).fill("Saved before online update");
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText("更新服务暂时不可用");
  await expect(dialog.getByRole("button", { name: /选择.*安装包/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText("0.2.0", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "更新内容", exact: true })).toContainText("改进视频引用预览");
  expect((await commands(page)).some(call => call.command === "open_software_update")).toBe(false);
  await dialog.getByRole("button", { name: "下载并更新", exact: true }).click();
  await expect(dialog.locator(".software-update-feedback")).toHaveText("已启动新版安装程序。");
  const calls = await commands(page);
  expect(calls.map(call => call.command)).toEqual(["check_software_update", "check_software_update", "open_software_update"]);
  expect(calls.every(call => Object.keys(call.args).length === 0)).toBe(true);
  expect(calls[2].savedNames).toContain("Saved before online update");
  await dialog.screenshot({ path: testInfo.outputPath("software-update.png") });
  expect(pageErrors).toEqual([]);
});

test("startup notifies once and an in-progress update survives closing and reopening the dialog", async ({ page }, testInfo) => {
  await desktopHost(page, [
    { currentVersion: "0.1.0", latestVersion: "0.2.0", configured: true, available: true },
    { currentVersion: "0.1.0", latestVersion: "0.3.0", configured: true, available: true, releaseNotes: "优化画布移动和视频保存" },
  ]);
  await openProject(page);
  const notice = page.getByRole("complementary", { name: "发现软件更新", exact: true });
  await expect(notice).toContainText("0.2.0");
  expect((await commands(page)).filter(call => call.command === "open_software_update")).toHaveLength(0);
  await page.evaluate(() => { (window as Window & { updateFixture: UpdateFixture }).updateFixture.autoFinish = false; });
  await notice.getByRole("button", { name: "查看更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByText("0.3.0", { exact: true })).toBeVisible();
  expect((await commands(page)).filter(call => call.command === "check_software_update")).toHaveLength(2);
  await dialog.getByRole("button", { name: "下载并更新", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "0");
  await page.evaluate(() => {
    const fixture = (window as Window & { updateFixture: UpdateFixture }).updateFixture;
    fixture.status = { ...fixture.status, downloadedBytes: 42 * 1024 * 1024, percent: 42 };
  });
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "42");
  await expect(dialog).toContainText("42.0 MB / 100.0 MB");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const background = page.getByRole("complementary", { name: "软件更新进度", exact: true });
  await expect(background).toBeVisible();
  await expect(background).toContainText("0.3.0");
  await expect(background.getByRole("progressbar")).toHaveAttribute("value", "42");
  await expect(background).toContainText("42.0 MB / 100.0 MB");
  await expect(background.getByRole("button", { name: "稍后提醒", exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = (window as Window & { updateFixture: UpdateFixture }).updateFixture;
    fixture.status = { ...fixture.status, downloadedBytes: 51 * 1024 * 1024, percent: 51 };
  });
  await expect(background.getByRole("progressbar")).toHaveAttribute("value", "51");
  await expect(background).toContainText("51.0 MB / 100.0 MB");
  await page.screenshot({ path: testInfo.outputPath("background-update-in-canvas.png") });
  await background.screenshot({ path: testInfo.outputPath("background-update-progress.png") });
  async function expectUpdateClearOfCanvasControls(bottom: number) {
    const geometry = await page.evaluate(() => {
      const progress = document.querySelector(".software-update-transfer")!.getBoundingClientRect();
      const overlaps = [".react-flow__minimap", ".react-flow__controls"].filter(selector => {
        const element = document.querySelector(`.canvas-shell ${selector}`);
        if (!element) return false;
        const control = element.getBoundingClientRect();
        return progress.left < control.right && progress.right > control.left
          && progress.top < control.bottom && progress.bottom > control.top;
      });
      return { overlaps, bottom: innerHeight - progress.bottom,
        insideViewport: progress.left >= 0 && progress.top >= 0 && progress.right <= innerWidth && progress.bottom <= innerHeight };
    });
    expect(geometry.overlaps).toEqual([]);
    expect(geometry.insideViewport).toBe(true);
    expect(geometry.bottom).toBe(bottom);
  }
  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await expectUpdateClearOfCanvasControls(200);
  for (const viewport of [{ width: 1000, height: 720 }, { width: 640, height: 480 }]) {
    await page.setViewportSize(viewport);
    await expectUpdateClearOfCanvasControls(200);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "添加画布工具", exact: true }).click();
  await page.getByRole("button", { name: "切换缩略图", exact: true }).click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await expectUpdateClearOfCanvasControls(76);
  await page.getByRole("button", { name: "切换缩略图", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".more-menu")).toHaveCount(0);
  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await expectUpdateClearOfCanvasControls(200);
  await background.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(dialog).toHaveCount(1);
  await expect(background).toHaveCount(0);
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "51");
  await expect(dialog.getByRole("button", { name: "正在更新…", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  for (const [phase, message] of [["verifying", "正在校验安装包…"], ["saving", "正在保存项目，准备安装更新…"], ["installing", "正在启动新版安装程序…"]]) {
    await page.evaluate(({ phase, message }) => {
      const fixture = (window as Window & { updateFixture: UpdateFixture }).updateFixture;
      fixture.status = { ...fixture.status, phase, message, downloadedBytes: 100 * 1024 * 1024, percent: 100 };
    }, { phase, message });
    await expect(background.getByRole("status")).toContainText(message);
  }
  await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.complete!());
  expect((await commands(page)).filter(call => call.command === "check_software_update")).toHaveLength(2);
  expect((await commands(page)).filter(call => call.command === "open_software_update")).toHaveLength(1);
  await background.getByRole("button", { name: "查看进度", exact: true }).click();
  await dialog.screenshot({ path: testInfo.outputPath("update-progress-restored.png") });
});

test("saving before an update remains a single operation when the dialog closes and reopens", async ({ page }) => {
  await desktopHost(page, [{ currentVersion: "0.1.0", latestVersion: "0.2.0", configured: true, available: true }]);
  await openProject(page);
  await page.evaluate(() => {
    const fixture = (window as Window & { updateFixture: UpdateFixture }).updateFixture;
    fixture.autoFinish = false;
    fixture.saveCalls = 0;
    const saveBeforeExit = window.drawStudioSaveBeforeExit!;
    window.drawStudioSaveBeforeExit = async () => {
      fixture.saveCalls!++;
      await new Promise<void>(resolve => { fixture.releaseSave = resolve; });
      await saveBeforeExit();
    };
  });
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await dialog.getByRole("button", { name: "下载并更新", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("正在保存当前项目…");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const background = page.getByRole("complementary", { name: "软件更新进度", exact: true });
  await expect(background.getByRole("status")).toContainText("正在保存当前项目…");
  await background.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在更新…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("status")).toHaveText("正在保存当前项目…");
  expect(await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.saveCalls)).toBe(1);
  expect((await commands(page)).filter(call => call.command === "open_software_update")).toHaveLength(0);
  await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.releaseSave!());
  await expect(dialog.getByRole("status")).toHaveText("正在下载安装包…");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await background.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在更新…", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.saveCalls)).toBe(1);
  expect((await commands(page)).filter(call => call.command === "open_software_update")).toHaveLength(1);
  await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.complete!());
});

test("a download or verification failure exposes a retry without asking for a file", async ({ page }) => {
  await desktopHost(page, [{ currentVersion: "0.1.0", latestVersion: "0.2.0", configured: true, available: true }]);
  await openProject(page);
  await page.evaluate(() => { (window as Window & { updateFixture: UpdateFixture }).updateFixture.autoFinish = false; });
  await page.getByRole("button", { name: "软件更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  await dialog.getByRole("button", { name: "下载并更新", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as Window & { updateFixture: UpdateFixture }).updateFixture.fail!("安装包校验失败，请重新下载。"));
  const background = page.getByRole("complementary", { name: "软件更新进度", exact: true });
  await expect(background.getByRole("alert")).toContainText("安装包校验失败，请重新下载。");
  await background.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("安装包校验失败，请重新下载。");
  await page.evaluate(() => { (window as Window & { updateFixture: UpdateFixture }).updateFixture.autoFinish = true; });
  await dialog.getByRole("button", { name: "重试更新", exact: true }).click();
  await expect(dialog.locator(".software-update-feedback")).toHaveText("已启动新版安装程序。");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect((await commands(page)).filter(call => call.command === "open_software_update")).toHaveLength(2);
  expect((await commands(page)).some(call => call.command === "install_software_update")).toBe(false);
});
