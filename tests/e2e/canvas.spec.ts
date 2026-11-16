import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dropFileOnCanvas, openCanvasAddMenu } from "./helpers";
import { promptOptimizationHandler } from "../../scripts/prompt-optimization-plugin";
import { createOptimizationService } from "../../scripts/prompt-optimization-service";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
type ControlledPromptMetadata = {
  editable_prompt: string;
  protected_mentions: Record<string, { label: string; nodeId: string; occurrences: number }>;
};

/** Real HTTP transport and the production optimizer handler, with a controlled
 * completion endpoint. This verifies UI ownership, not actual model inference. */
async function controlledOptimizationHttp(page: Page, api: APIRequestContext) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, "canvas-optimize-ui-"));
  const skillDirectory = path.join(root, "skills");
  await mkdir(path.join(skillDirectory, "common"), { recursive: true });
  await writeFile(path.join(skillDirectory, "common", "SKILL.md"),
    "---\nname: controlled-prompt-editing\ndescription: Preserve the current prompt and its reference roles.\n---\n仅优化当前正文，保留素材标记与用户意图。\n");
  await writeFile(path.join(skillDirectory, "skill-index.json"), JSON.stringify({ schemaVersion: 1, profiles: [
    { id: "controlled-common", name: "Controlled common writing", entry: "common/SKILL.md", generic: true, match: { tasks: ["*"] } },
  ] }));
  const calls: { metadata: ControlledPromptMetadata; release: (content: string) => void; released: boolean }[] = [];
  let handler: ReturnType<typeof promptOptimizationHandler> | undefined;
  let completedApiResponses = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/__canvas/prompt-optimization/")) {
        if (request.url.endsWith("/optimize")) response.once("finish", () => completedApiResponses++);
        await handler!(request, response, () => { response.statusCode = 404; response.end("{}"); });
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "controlled-text" }] }));
        return;
      }
      if (request.url === "/api/v1/models") {
        response.end(JSON.stringify({ models: [{ key: "controlled-text", type: "llm", capabilities: { vision: false } }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
        response.statusCode = 404; response.end("{}"); return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const packet = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const user = packet.messages.find(message => message.role === "user");
      if (!user || typeof user.content !== "string") throw new Error("The controlled fixture expects text-only metadata.");
      let release!: (content: string) => void;
      const ready = new Promise<string>(resolve => { release = resolve; });
      const call = { metadata: JSON.parse(user.content) as ControlledPromptMetadata, released: false,
        release: (content: string) => { if (!call.released) { call.released = true; release(content); } } };
      calls.push(call);
      const content = await ready;
      if (!response.destroyed) response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    } catch (error) {
      if (!response.destroyed) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Controlled HTTP fixture failure" }));
      }
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await createOptimizationService(root).saveSettings({ provider: "openai-compatible", baseUrl: base + "/v1",
    modelId: "controlled-text", visionModelId: "", readMedia: false, language: "zh", maxTokens: 512,
    skillDirectory, capabilities: { "controlled-text": "text" } });
  handler = promptOptimizationHandler(root);
  // Only this isolated page is redirected. Its requests still cross HTTP and
  // exercise the real service validation; the user's settings are never edited.
  await page.route("**/__canvas/prompt-optimization/**", async route => {
    const request = route.request();
    try {
      const upstream = await api.fetch(base + new URL(request.url()).pathname, {
        method: request.method(), headers: { "Content-Type": "application/json" },
        data: request.postData() ?? undefined, failOnStatusCode: false,
      });
      await route.fulfill({ status: upstream.status(), contentType: "application/json", body: await upstream.body() });
    } catch (error) {
      if (!page.isClosed() && !request.failure()) throw error;
    }
  });
  return { calls, completedApiResponses: () => completedApiResponses, async close() {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const call of calls) call.release("");
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Delete only this fixture's newly created directory under the OS temp root.
    if (path.dirname(path.resolve(root)) !== temporaryParent || !path.basename(root).startsWith("canvas-optimize-ui-"))
      throw new Error("Refusing to remove a directory outside the controlled fixture.");
    await rm(root, { recursive: true, force: true });
  } };
}

async function clickEmptyCanvas(page: Page) {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.click(pane.x + pane.width - 25, pane.y + 35);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("测试项目");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await openCanvasAddMenu(page, { x: 490, y: 234 });
  await page.getByRole("menuitem", { name: "视频" }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
});

test("controlled HTTP optimization continues behind a dismissed panel and retains reference chips and drafts", async ({ page, request }) => {
  test.setTimeout(60_000);
  const transport = await controlledOptimizationHttp(page, request);
  try {
    const target = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
    await target.click();
    await page.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await dropFileOnCanvas(page, {
      name: "optimization-ref.png", mimeType: "image/png", buffer: png,
    });
    const source = page.locator(".react-flow__node").filter({ has: page.locator('img[alt="optimization-ref.png"]') });
    const sourceId = await source.getAttribute("data-id");
    expect(sourceId).toBeTruthy();
    const from = (await source.locator(".react-flow__handle-right").boundingBox())!;
    const to = (await target.locator(".react-flow__handle-left").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await target.click();
    const panel = page.getByRole("region", { name: "视频 1生成面板" });
    const prompt = panel.getByRole("textbox", { name: "提示词", exact: true });
    await prompt.fill("原始动作：");
    await prompt.press("End");
    await prompt.pressSequentially("@");
    await page.getByRole("listbox", { name: "已连接素材" }).getByRole("option", { name: "参考 1", exact: true }).click();
    await prompt.pressSequentially(" 向前走。");
    const chip = prompt.locator("[data-prompt-mention]");
    await expect(chip).toHaveCount(1);
    const originalToken = await chip.getAttribute("data-prompt-mention");
    await panel.getByRole("button", { name: "AI 优化", exact: true }).click();
    await expect.poll(() => transport.calls.length).toBe(1);
    const first = transport.calls[0];
    expect(Object.values(first.metadata.protected_mentions)).toEqual([{ label: "参考 1", nodeId: sourceId, occurrences: 1 }]);
    const marker = Object.keys(first.metadata.protected_mentions)[0];
    expect(marker).toMatch(/^__DRAW_MENTION_\d+__$/);
    const escapedMarker = marker.replaceAll("_", "\\_");
    await clickEmptyCanvas(page);
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    expect(first.released).toBe(false);
    await target.click();
    await expect(panel.getByRole("button", { name: "取消提示词优化", exact: true })).toHaveAttribute("aria-busy", "true");
    await clickEmptyCanvas(page);
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    first.release("优化动作：" + escapedMarker + " 缓步向前走，镜头跟随。");
    await expect.poll(transport.completedApiResponses).toBe(1);
    await target.click();
    await expect(prompt).toContainText("优化动作：");
    await expect(chip).toHaveAttribute("data-prompt-mention", originalToken!);
    await expect(panel.locator(".optimization-feedback.error")).toHaveCount(0);
    await panel.getByRole("button", { name: "切换到原文", exact: true }).click();
    await expect(prompt).toContainText("原始动作：");
    await expect(prompt).not.toContainText("优化动作：");
    await prompt.press("End");
    await prompt.pressSequentially(" 保持衣服。");
    await panel.getByRole("button", { name: "AI 优化", exact: true }).click();
    await expect.poll(() => transport.calls.length).toBe(2);
    const second = transport.calls[1];
    expect(second.metadata.editable_prompt).toContain("原始动作：");
    expect(second.metadata.editable_prompt).toContain("保持衣服。");
    expect(second.metadata.editable_prompt).not.toContain("优化动作：");
    await clickEmptyCanvas(page);
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    expect(second.released).toBe(false);
    second.release("再次优化：" + Object.keys(second.metadata.protected_mentions)[0] + " 向前行走，服装保持一致。");
    await expect.poll(transport.completedApiResponses).toBe(2);
    await target.click();
    await expect(prompt).toContainText("再次优化：");
    await expect(chip).toHaveAttribute("data-prompt-mention", originalToken!);
    await panel.getByRole("button", { name: "切换到原文", exact: true }).click();
    await expect(prompt).toContainText("保持衣服。");
    await clickEmptyCanvas(page);
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    await target.click();
    await expect(panel.getByRole("button", { name: "切换到优化提示词", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    await target.click();
    await expect(prompt).toContainText("原始动作：");
    await expect(prompt).toContainText("保持衣服。");
    await panel.getByRole("button", { name: "切换到优化提示词", exact: true }).click();
    await expect(prompt).toContainText("再次优化：");
    expect(transport.calls).toHaveLength(2);
  } finally { await transport.close(); }
});

test("controlled HTTP background results stay on their source node and only explicit cancellation discards them", async ({ page, request }) => {
  test.setTimeout(60_000);
  const transport = await controlledOptimizationHttp(page, request);
  try {
    const firstNode = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
    await firstNode.click();
    const firstPanel = page.getByRole("region", { name: "视频 1生成面板" });
    const firstPrompt = firstPanel.getByRole("textbox", { name: "提示词", exact: true });
    await firstPrompt.fill("第一节点原文");
    await firstPanel.getByRole("button", { name: "AI 优化", exact: true }).click();
    await expect.poll(() => transport.calls.length).toBe(1);
    await clickEmptyCanvas(page);
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    expect(transport.calls[0].released).toBe(false);
    await page.mouse.click(1120, 200, { button: "right" });
    await page.getByRole("menuitem", { name: "视频" }).click();
    const secondNode = page.locator(".react-flow__node").filter({ hasText: "视频 2" });
    await secondNode.click();
    const secondPanel = page.getByRole("region", { name: "视频 2生成面板" });
    const secondPrompt = secondPanel.getByRole("textbox", { name: "提示词", exact: true });
    await secondPrompt.fill("第二节点原文，不应被修改");
    transport.calls[0].release("第一个节点后台完成的优化结果");
    await expect.poll(transport.completedApiResponses).toBe(1);
    await expect(secondPrompt).toHaveText("第二节点原文，不应被修改");
    await secondPanel.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await firstNode.click();
    await expect(firstPrompt).toHaveText("第一个节点后台完成的优化结果");
    await firstPanel.getByRole("button", { name: "切换到原文", exact: true }).click();
    await expect(firstPrompt).toHaveText("第一节点原文");
    await firstPanel.getByRole("button", { name: "AI 优化", exact: true }).click();
    await expect.poll(() => transport.calls.length).toBe(2);
    await firstPanel.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await expect(page.locator(".generation-panel")).toHaveCount(0);
    expect(transport.calls[1].released).toBe(false);
    transport.calls[1].release("关闭面板后后台完成的优化结果");
    await expect.poll(transport.completedApiResponses).toBe(2);
    await firstNode.click();
    await expect(firstPrompt).toHaveText("关闭面板后后台完成的优化结果");
    await firstPanel.getByRole("button", { name: "切换到原文", exact: true }).click();
    await expect(firstPrompt).toHaveText("第一节点原文");
    await firstPanel.getByRole("button", { name: "AI 优化", exact: true }).click();
    await expect.poll(() => transport.calls.length).toBe(3);
    await firstPanel.getByRole("button", { name: "取消提示词优化", exact: true }).click();
    await expect(firstPanel.getByRole("button", { name: "AI 优化", exact: true })).toBeEnabled();
    transport.calls[2].release("已经主动取消的请求不得写回");
    await expect.poll(transport.completedApiResponses).toBe(3);
    await expect(firstPrompt).toHaveText("第一节点原文");
    await firstPanel.getByRole("button", { name: "切换到优化提示词", exact: true }).click();
    await expect(firstPrompt).toHaveText("关闭面板后后台完成的优化结果");
    await firstPanel.getByRole("button", { name: "关闭生成面板", exact: true }).click();
    await secondNode.click();
    await expect(secondPrompt).toHaveText("第二节点原文，不应被修改");
    expect(transport.calls).toHaveLength(3);
  } finally { await transport.close(); }
});

test("DFCine H3 recipes expose supported parameters and persist selection", async ({ page }) => {
  await page.locator(".react-flow__node .node-empty").click();
  await page.locator(".workflow-button").click();
  const selector = page.getByRole("dialog", { name: "选择视频画布工作流" });
  await expect(selector.getByRole("navigation", { name: "模型 / 工具系列" })).toBeVisible();
  await selector.getByRole("button", { name: /MiniMax H3 极速/ }).click();
  await selector.getByRole("button", { name: /H3.*多参视频.*4步/ }).click();
  await expect(page.getByRole("group", { name: "生成参数", exact: true }).getByRole("spinbutton", { name: "时长" })).toBeVisible();
  await expect(page.getByRole("group", { name: "生成参数", exact: true }).getByRole("spinbutton", { name: "百万像素" })).toBeVisible();
  await expect(page.getByLabel("负面提示词", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await page.locator(".react-flow__node .node-empty").click();
  await expect(page.locator(".workflow-button")).toContainText("H3多参视频（4步）");
});

test("panel, selector, tabs, persistence, and honest unbound state", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").click();
  await page
    .getByRole("textbox", { name: "提示词", exact: true })
    .fill("A quiet sea at sunrise");
  await page.locator(".generation-header").click();
  await expect(page.locator(".generation-panel")).toBeVisible();
  await page.locator(".workflow-button").click();
  const selector = page.getByRole("dialog", { name: "选择视频画布工作流" });
  await expect(selector.getByRole("navigation", { name: "模型 / 工具系列" })).toBeVisible();
  await expect(page.getByText("管理与导入工作流", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("导入工作流后即可生成", { exact: true }),
  ).toHaveCount(0);
  await selector.getByRole("button", { name: /MiniMax H3 极速/ }).click();
  await selector.getByRole("button", { name: /H3.*文生视频.*8步/ }).click();
  await page.mouse.click(1300, 200);
  await expect(page.locator(".generation-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "画布 1", exact: true }).click();
  await page.locator(".react-flow__node .node-empty").click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveText("A quiet sea at sunrise");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await page.locator(".react-flow__node .node-empty").click();
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveText("A quiet sea at sunrise");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.getByRole("status", { name: "生成执行状态" })).toContainText(
    "请在设置中填写有效的 ComfyUI 地址。",
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});
test("local media upload, graph connection, roles, and portable archive", async ({
  page,
}) => {
  await page.goto("/");
  await dropFileOnCanvas(page, {
    name: "reference.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const nodes = page.locator(".react-flow__node");
  const source = nodes.filter({ has: page.locator('img[alt="reference.png"]') }),
    target = nodes.filter({ hasText: "视频 1" });
  const from = await source.locator(".react-flow__handle-right").boundingBox(),
    to = await target.locator(".react-flow__handle-left").boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await target.click();
  await expect(
    page.locator('.media-input-icon img[alt="reference.png"]'),
  ).toBeVisible();
  await page.locator(".media-input-icon").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭生成面板", exact: true }).click();
  await page.locator(".react-flow__edge").click();
  await expect(page.getByLabel("连线角色")).toBeVisible();
  await expect(page.getByLabel("连线角色")).toHaveValue("auto");
  await expect(
    page.getByLabel("连线角色").locator('option[value="firstFrame"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目", exact: true }).click();
  const file = await exported;
  expect(file.suggestedFilename()).toMatch(/\.aicanvas$/);
  await page
    .locator('input[accept=".aicanvas,.zip"]')
    .setInputFiles((await file.path())!);
  await expect(page.getByRole("status")).toContainText("项目与素材已恢复");
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator('img[alt="reference.png"]')).toBeVisible();
});
test("500 nodes are persisted while offscreen nodes are virtualized", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("clearframe-canvas", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const library: any = await new Promise((resolve, reject) => {
      const r = db
        .transaction("records")
        .objectStore("records")
        .get("project-library");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const p =
      library[sessionStorage.getItem("clearframe-open-project")!].project;
    p.canvases[0].nodes = Array.from({ length: 500 }, (_, i) => ({
      id: "n-" + i,
      type: "media",
      position: { x: 130 + (i % 25) * 250, y: 180 + Math.floor(i / 25) * 230 },
      data: { title: "素材 " + i, kind: "image" },
    }));
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(library, "project-library");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByText("素材 0", { exact: false }).first().waitFor();
  const count = await page.locator(".react-flow__node").count();
  expect(count).toBeLessThan(100);
  expect(count).toBeGreaterThan(1);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "算力设置" }),
  ).toBeVisible();
});
test("HTTP protocol fixture returns to same node and persists the new task schema", async ({
  page,
}) => {
  // This test uses an isolated browser context and a mocked transport only. No fixture is bundled into production.
  let queued = 0,
    uploads = 0,
    offline = false,
    inputFolder = "",
    finishGeneration = false;
  let submitted: any;
  await page.route("http://127.0.0.1:18188/**", async (route) => {
    if (offline) {
      await route.abort();
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/history/contract-prompt" && !finishGeneration) {
      await route.fulfill({ json: {} });
      return;
    }
    if (path === "/upload/image") {
      const request = new Request(route.request().url(), {
        method: "POST",
        headers: route.request().headers(),
        body: new Uint8Array(route.request().postDataBuffer()!).buffer,
      });
      const form = await request.formData();
      expect(form.get("type")).toBe("input");
      expect(form.get("overwrite")).toBe("false");
      inputFolder = String(form.get("subfolder"));
      expect(inputFolder).toMatch(new RegExp("^infinite-canvas/[a-f0-9-]+$"));
      expect((form.get("image") as File).size).toBe(png.length);
      uploads++;
      await route.fulfill({
        json: {
          name: "server-renamed.png",
          subfolder: inputFolder,
          type: "input",
        },
      });
      return;
    }
    if (path === "/prompt") {
      submitted = route.request().postDataJSON();
      expect(submitted.prompt["2"].inputs.image).toBe(
        inputFolder + "/server-renamed.png",
      );
      expect(submitted.prompt["9"].inputs.filename_prefix).toBe(
        inputFolder + "/result",
      );
    }
    expect([
      "/system_stats",
      "/object_info",
      "/prompt",
      "/queue",
      "/history/contract-prompt",
      "/view",
    ]).toContain(path);
    const json =
      path === "/system_stats"
        ? { system: { comfyui_version: "contract-test" } }
        : path === "/object_info"
          ? { Prompt: {}, Save: {}, LoadImage: {} }
          : path === "/prompt"
            ? (queued++, { prompt_id: "contract-prompt" })
            : path === "/queue"
              ? { queue_running: [], queue_pending: [] }
              : path === "/history/contract-prompt"
                ? {
                    "contract-prompt": {
                      outputs: {
                        "9": {
                          images: [
                            {
                              filename: "output.png",
                              subfolder: inputFolder,
                              type: "output",
                            },
                          ],
                        },
                      },
                      status: { completed: true, status_str: "success" },
                    },
                  }
                : {};
    if (path === "/view")
      await route.fulfill({ status: 200, contentType: "image/png", body: png });
    else
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(json),
      });
  });
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  const workflow = {
    id: "contract-workflow",
    name: "受控图生图工作流",
    family: "E2E fixture",
    description: "仅供隔离浏览器测试",
    mode: "image-to-image",
    requiredInputs: ["image"],
    optionalInputs: [],
    parameters: [],
    template: {
      "1": { class_type: "Prompt", inputs: { text: "" } },
      "2": { class_type: "LoadImage", inputs: { image: "original.png" } },
      "9": { class_type: "Save", inputs: { images: ["2", 0], filename_prefix: "test" } },
    },
    mapping: [
      { semantic: "prompt", nodeId: "1", field: "text" },
      { semantic: "image", nodeId: "2", field: "image" },
    ],
    output: { nodeId: "9", field: "images", kind: "image" },
  };
  await page.evaluate(
    async ({ workflow, connection, inputBytes }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("clearframe-canvas", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const library: any = await new Promise((resolve) => {
        const r = db
          .transaction("records")
          .objectStore("records")
          .get("project-library");
        r.onsuccess = () => resolve(r.result);
      });
      const p =
        library[sessionStorage.getItem("clearframe-open-project")!].project;
      library[p.id].workflows = [workflow];
      p.canvases[0].nodes[0].data.kind = "image-generation";
      p.canvases[0].nodes[0].data.generation = {
        prompt: "protocol fixture",
        negativePrompt: "",
        workflowId: workflow.id,
        params: {},
        taskId: null,
      };
      p.assets["input-fixture"] = {
        id: "input-fixture",
        name: "input.png",
        kind: "image",
        mime: "image/png",
        size: inputBytes.length,
        createdAt: 0,
      };
      p.canvases[0].nodes.push({
        id: "source",
        type: "media",
        position: { x: 180, y: 260 },
        data: { title: "input.png", kind: "image", assetId: "input-fixture" },
      });
      p.canvases[0].edges.push({
        id: "input-edge",
        source: "source",
        target: p.canvases[0].nodes[0].id,
        data: { role: "auto", order: 1 },
      });
      p.canvases[0].nodes.push({
        id: "downstream",
        type: "media",
        position: { x: 920, y: 260 },
        data: {
          title: "结果接收节点",
          kind: "image-generation",
          generation: { ...p.canvases[0].nodes[0].data.generation },
        },
      });
      p.canvases[0].edges.push({
        id: "result-edge",
        source: p.canvases[0].nodes[0].id,
        target: "downstream",
        data: { role: "auto", order: 1 },
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction(["records", "assets"], "readwrite"),
          store = tx.objectStore("records");
        tx.objectStore("assets").put(
          new Blob([new Uint8Array(inputBytes)], { type: "image/png" }),
          "input-fixture",
        );
        store.put(library, "project-library");
        store.put([workflow], "workflows");
        store.put(connection, "connection");
        tx.oncomplete = () => resolve();
      });
      db.close();
    },
    {
      workflow,
      inputBytes: Array.from(png),
      connection: {
        name: "E2E ComfyUI mock",
        baseUrl: "http://127.0.0.1:18188",
        token: "",
        authHeader: "Authorization",
        authPrefix: "Bearer ",
        timeoutMinutes: 1,
      },
    },
  );
  await page.reload();
  await page.locator(".react-flow__node").filter({ hasText: "视频 1" }).click();
  await page.getByRole("button", { name: "生成", exact: true }).click();
  const timer = page.getByRole("timer", { name: "生成用时" });
  await expect(timer).toHaveText(/用时 \d{2}:\d{2}/);
  await page.getByRole("button", { name: "关闭生成面板", exact: true }).click();
  const workingNode = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
  const workingBefore = (await workingNode.boundingBox())!;
  await page.mouse.move(workingBefore.x + 40, workingBefore.y + 24);
  await page.mouse.down();
  await page.mouse.move(workingBefore.x + 110, workingBefore.y + 64, { steps: 10 });
  await page.mouse.up();
  const workingAfter = (await workingNode.boundingBox())!;
  expect(workingAfter.x - workingBefore.x).toBeGreaterThan(40);
  expect(workingAfter.y - workingBefore.y).toBeGreaterThan(20);
  expect(queued).toBe(1);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "结果接收节点" })
    .click();
  await expect(page.locator(".media-input-icon svg")).toBeVisible();
  finishGeneration = true;
  await expect(page.locator(".node-status")).toContainText("已完成", {
    timeout: 20000,
  });
  await expect(
    page.locator('.media-input-icon img[alt="output.png"]'),
  ).toBeVisible();
  await expect(page.locator(".media-input-icon svg")).toHaveCount(0);
  expect(queued).toBe(1);
  expect(uploads).toBe(1);
  const finalTime = await timer.textContent();
  await page.clock.install();
  await page.clock.fastForward(3000);
  await expect(timer).toHaveText(finalTime!);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByText("任务详情", { exact: true }).click();
  await expect(page.locator(".task-details")).toContainText("contract-prompt");
  await expect(page.locator(".task-details")).toContainText("comfyui");
  await expect(page.locator(".task-details")).toContainText("completed");
  offline = true;
  await page.reload();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByText("任务详情", { exact: true }).click();
  await expect(page.locator(".task-details")).toContainText("contract-prompt");
  expect(queued).toBe(1);
  expect(uploads).toBe(1);
  await expect(page.locator('img[alt="output.png"]')).toBeVisible();
  await expect(page.getByRole("timer", { name: "生成用时" })).toHaveText(
    finalTime!,
  );
});

test("right-click adds at the canvas position without a plus or workflow manager", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await expect(
    page.getByRole("button", { name: "添加节点", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  // Pan and zoom before adding: screen coordinates must be converted to graph coordinates.
  await page.mouse.move(700, 330);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(880, 440, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  const viewport = page.locator(".react-flow__viewport");
  await expect
    .poll(() =>
      viewport.evaluate(
        (el) => new DOMMatrix(getComputedStyle(el).transform).a,
      ),
    )
    .toBeGreaterThan(1);
  const menu = page.getByRole("menu", { name: "添加到画布" });
  await page.mouse.click(1000, 360, { button: "right" });
  await expect(menu).toBeVisible();
  await page.getByRole("menuitem", { name: "参考" }).click();
  await expect(menu).toHaveCount(0);
  const node = page.locator(".react-flow__node");
  await expect(node).toHaveCount(1);
  const box = await node.boundingBox();
  expect(Math.abs(box!.x - 1000)).toBeLessThan(2);
  expect(Math.abs(box!.y - 360)).toBeLessThan(2);
  await node.click({ button: "right" });
  await expect(menu).toHaveCount(0);
  await page.mouse.click(700, 650, { button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.mouse.click(700, 650, { button: "right" });
  await page.mouse.click(650, 320);
  await expect(menu).toHaveCount(0);
  // At the lower right edge the menu stays in the canvas, but the new node keeps the click location.
  const shell = (await page.locator(".canvas-shell").boundingBox())!;
  const point = {
    x: shell.x + shell.width - 12,
    y: shell.y + shell.height - 100,
  };
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(shell.x + shell.width);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(
    shell.y + shell.height,
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const video = page
    .locator(".react-flow__node")
    .filter({ hasText: "VIDEO / AI" });
  const videoBox = (await video.boundingBox())!;
  expect(Math.abs(videoBox.x - point.x)).toBeLessThan(2);
  expect(Math.abs(videoBox.y - point.y)).toBeLessThan(2);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "算力设置" }),
  ).toBeVisible();
  await expect(page.getByText("工作流管理", { exact: true })).toHaveCount(0);
  await expect(page.getByText("WebSocket URL", { exact: false })).toHaveCount(
    0,
  );
  await expect(page.getByRole("dialog", { name: "算力设置" }).getByRole("tab", { name: "云端 ComfyUI" })).toHaveAttribute("aria-selected", "true");
});

test("left and middle drag pan the canvas, Shift selects, and nodes remain draggable", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  const viewport = page.locator(".react-flow__viewport");
  const position = () =>
    viewport.evaluate((el) => {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return { x: m.e, y: m.f };
    });
  for (const button of ["left", "middle"] as const) {
    const before = await position();
    await page.mouse.move(1050, 260);
    await page.mouse.down({ button });
    await page.mouse.move(1150, 310, { steps: 10 });
    await page.mouse.up({ button });
    const after = await position();
    expect(after.x - before.x).toBeCloseTo(100, 0);
    expect(after.y - before.y).toBeCloseTo(50, 0);
  }
  const node = page.locator(".react-flow__node");
  const box = (await node.boundingBox())!;
  const before = await position();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 + 40,
    { steps: 10 },
  );
  await page.mouse.up();
  const moved = (await node.boundingBox())!;
  // Drag activation plus the 10px grid may consume one movement step.
  expect(Math.abs(moved.x - box.x - 60)).toBeLessThanOrEqual(10);
  expect(await position()).toEqual(before);
  await page.mouse.click(1300, 200);
  await page.keyboard.down("Shift");
  await page.mouse.move(moved.x - 30, moved.y - 40);
  await page.mouse.down();
  await page.mouse.move(
    moved.x + moved.width + 30,
    moved.y + moved.height + 20,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(node).toHaveClass(/selected/);
  expect(await position()).toEqual(before);
});

test("wheel zoom keeps the cursor anchor and undo redo restores a canvas node", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  const paneBox = (await pane.boundingBox())!;
  const cursor = { x: paneBox.x + paneBox.width * 0.57, y: paneBox.y + paneBox.height * 0.47 };
  const graphPointUnderCursor = () => viewport.evaluate((element, point) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return {
      x: (point.x - matrix.e) / matrix.a,
      y: (point.y - matrix.f) / matrix.d,
      zoom: matrix.a,
    };
  }, { x: cursor.x - paneBox.x, y: cursor.y - paneBox.y });
  const before = await graphPointUnderCursor();
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -350);
  await expect.poll(async () => (await graphPointUnderCursor()).zoom).toBeGreaterThan(before.zoom);
  const after = await graphPointUnderCursor();
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);

  await openCanvasAddMenu(page);
  await page.getByRole("menuitem", { name: "参考" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

test("one video menu entry and text-to-video connections survive reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await page.mouse.click(190, 350, { button: "right" });
  await expect(page.getByRole("menuitem", { name: /视频/ })).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "视频" })).toBeVisible();
  await page.getByRole("menuitem", { name: "文本" }).click();
  const note = page.locator(".note");
  await note.fill("清晨的森林，阳光穿过薄雾");
  const source = page.locator(".react-flow__node").filter({ has: note });
  const target = page
    .locator(".react-flow__node")
    .filter({ hasText: "视频 1" });
  const from = (await source
    .locator(".react-flow__handle-right")
    .boundingBox())!;
  const to = (await target.locator(".react-flow__handle-left").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await target.click();
  await expect(page.locator(".text-input-icon")).toHaveCount(1);
  await expect(page.locator(".input-text-preview")).toHaveCount(0);
  await expect(page.locator(".text-input-icon")).toHaveText("");
  await page.mouse.move(1400, 100);
  const removeText = page.getByRole("button", { name: "移除连接：文本 1" });
  await expect(removeText).toHaveCSS("opacity", "0");
  await page.locator(".text-input-icon").hover();
  await expect(removeText).toHaveCSS("opacity", "1");
  await page.locator(".text-input-icon").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".input-text-preview")).toHaveCount(0);
  await page.mouse.move(1400, 100);
  await expect(removeText).toHaveCSS("opacity", "0");
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveText("");
  await page
    .getByRole("textbox", { name: "提示词", exact: true })
    .fill("镜头缓慢推进");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await target.click();
  await page.locator(".text-input-icon").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".note")).toHaveValue("清晨的森林，阳光穿过薄雾");
  await expect(
    page.getByRole("textbox", { name: "提示词", exact: true }),
  ).toHaveText("镜头缓慢推进");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".input-chip")).toHaveCount(0);
  await expect(page.locator(".text-input-icon svg")).toHaveClass(
    /lucide-notebook-text/,
  );
  await page.locator(".text-input-icon").hover();
  await page.getByRole("button", { name: "移除连接：文本 1" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".input-text-preview")).toHaveCount(0);
  await expect(page.locator(".note")).toHaveValue("清晨的森林，阳光穿过薄雾");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await target.click();
  await expect(page.locator(".text-input-icon")).toHaveCount(1);
  await page.locator(".text-input-icon").hover();
  await page.getByRole("button", { name: "移除连接：文本 1" }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await target.click();
  await expect(page.locator(".text-input-icon")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});

test("reference accepts all media types, replacement keeps connections and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await page.mouse.click(190, 350, { button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "参考↗",
    "视频↗",
    "文本↗",
    "音频↗",
    "图像↗",
  ]);
  await page.getByRole("menuitem", { name: "参考" }).click();
  const source = page
    .locator(".react-flow__node")
    .filter({ hasText: "参考 1" });
  const target = page
    .locator(".react-flow__node")
    .filter({ hasText: "视频 1" });
  const input = source.getByLabel("上传素材");
  await expect(input).toHaveAttribute("accept", "image/*,video/*,audio/*");
  const from = (await source
    .locator(".react-flow__handle-right")
    .boundingBox())!;
  const to = (await target.locator(".react-flow__handle-left").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  // Video/audio payloads are import fixtures; this checks routing and persistence, not codec playback.
  for (const media of [
    { name: "photo.png", mimeType: "image/png", buffer: png, selector: "img" },
    {
      name: "clip.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("video-import-fixture"),
      selector: "video",
    },
    {
      name: "sound.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("audio-import-fixture"),
      selector: "audio",
    },
  ]) {
    await input.setInputFiles(media);
    await expect(source.locator(media.selector)).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await source.click({ button: "right" });
    await expect(
      source.getByRole("button", { name: "更换素材" }),
    ).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await source.getByRole("button", { name: "更换素材" }).click();
    await (await chooser).setFiles(media);
    await expect(source.locator(media.selector)).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
    await page.reload();
    await expect(source.locator(media.selector)).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await source.click();
    await expect(page.locator(".generation-panel")).toHaveCount(0);
  }
});

test("text has a drag bar and empty upstream inputs no longer show automatic dropdowns by default", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".react-flow__node .node-empty").waitFor();
  await page.mouse.click(190, 450, { button: "right" });
  await page.getByRole("menuitem", { name: "文本" }).click();
  const note = page.locator(".react-flow__node").filter({ hasText: "文本 1" });
  await note.getByLabel("文本内容").fill("可以编辑，也方便拖动");
  await expect(note.locator(".text-drag-bar")).toHaveText("");
  await expect(note.locator("textarea")).toHaveCSS("outline-style", "none");
  const frame = await note.locator(".media-node").evaluate((el) => ({
    border: getComputedStyle(el, "::after").borderTopWidth,
    color: getComputedStyle(el, "::after").borderTopColor,
    radius: getComputedStyle(el, "::after").borderRadius,
    nodeRadius: getComputedStyle(el).borderRadius,
  }));
  expect(frame.border).toBe("3px");
  expect(frame.color).toBe("rgb(215, 255, 0)");
  expect(frame.radius).toBe(frame.nodeRadius);
  const before = (await note.boundingBox())!;
  const bar = (await note.locator(".text-drag-bar").boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bar.x + bar.width / 2 + 80,
    bar.y + bar.height / 2 + 40,
    { steps: 12 },
  );
  await page.mouse.up();
  const moved = (await note.boundingBox())!;
  expect(moved.x - before.x).toBeGreaterThan(60);
  expect(moved.y - before.y).toBeGreaterThan(20);
  const textbox = (await note.locator("textarea").boundingBox())!;
  expect(textbox.y).toBeGreaterThan(moved.y + 30);
  await page.mouse.move(textbox.x + 20, textbox.y + 20);
  await page.mouse.down();
  await page.mouse.move(textbox.x + 90, textbox.y + 20, { steps: 8 });
  await page.mouse.up();
  expect((await note.boundingBox())!.x).toBe(moved.x);
  await expect(note.locator("textarea")).toHaveValue("可以编辑，也方便拖动");
  for (const [i, x] of [100, 850].entries()) {
    await page.mouse.click(x, 200, { button: "right" });
    await page.getByRole("menuitem", { name: "视频" }).click();
    const source = page
      .locator(".react-flow__node")
      .filter({ hasText: "视频 " + (i + 2) });
    const target = page
      .locator(".react-flow__node")
      .filter({ hasText: "视频 1" });
    const from = (await source
      .locator(".react-flow__handle-right")
      .boundingBox())!;
    const to = (await target
      .locator(".react-flow__handle-left")
      .boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
  }
  await page.locator(".react-flow__node").filter({ hasText: "视频 1" }).click();
  await expect(page.locator(".media-input-icon")).toHaveCount(2);
  await expect(page.locator(".media-input-icon")).toHaveText(["", ""]);
  await expect(page.locator(".media-input-icon").nth(0)).toHaveAttribute(
    "title",
    "视频 2 · 等待上游生成",
  );
  await expect(page.locator(".media-input-icon").nth(1)).toHaveAttribute(
    "title",
    "视频 3 · 等待上游生成",
  );
  await expect(page.getByLabel(/素材 \d 角色/)).toHaveCount(0);
  await page.locator(".react-flow__edge").first().click();
  await expect(page.getByLabel("连线角色")).toHaveValue("auto");
  await page.getByRole("button", { name: "关闭角色编辑", exact: true }).click();
  await page.locator(".react-flow__node").filter({ hasText: "视频 1" }).click();
  await page.mouse.move(1400, 100);
  const removeVideo = page.getByRole("button", { name: "移除连接：视频 2" });
  await expect(removeVideo).toHaveCSS("opacity", "0");
  await page.locator(".media-input-icon").nth(0).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(removeVideo).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "移除连接：视频 2" }).click();
  await expect(page.locator(".media-input-icon")).toHaveCount(1);
  await expect(page.locator(".input-media-preview")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.locator(".react-flow__node").filter({ hasText: "视频 1" }).click();
  await expect(page.locator(".media-input-icon")).toHaveCount(2);
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await expect(page.locator(".react-flow, .generation-panel")).toHaveCount(0);
  await expect(page.locator(".project-home")).toHaveCSS(
    "background-color",
    "rgb(24, 26, 28)",
  );
  await expect(page.locator(".project-home")).toHaveCSS("opacity", "1");
  const home = (await page.locator(".project-home").boundingBox())!;
  expect(home.x).toBe(0);
  expect(home.y).toBe(0);
  expect(home.width).toBe(1600);
  expect(home.height).toBe(1000);
});
