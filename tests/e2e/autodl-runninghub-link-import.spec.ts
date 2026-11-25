import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAIFisherWorkflow, type AIFisherWorkflowReaderRequest } from "../../scripts/aifisher-workflow-reader";
import { readWorkflowLibrary } from "../../scripts/workflow-library-reader";
import { readWorkflowLibraryImportSource, writeWorkflowLibraryImport } from "../../scripts/workflow-library-writer";

const workflowId = "2115791287499706370";
const appId = "2115791287499706371";
const aiSite = "https://www.runninghub.ai";
const cnSite = "https://www.runninghub.cn";
const links: { description: string; url: string; useKey: boolean; liveSchema?: boolean; textOnly?: boolean; editorFallback?: boolean }[] = [
  { description: "workflow link", url: `${aiSite}/workflow/${workflowId}`, useKey: true },
  { description: "AI app with a published workflow", url: `${aiSite}/ai-detail/${appId}`, useKey: true },
  { description: "AI app with a published workflow and no API Key", url: `${cnSite}/ai-detail/${appId}?aiSource=click_ai_app`, useKey: false, textOnly: true },
  { description: "CN post link", url: `${cnSite}/post/${workflowId}`, useKey: false, liveSchema: true },
  { description: "AI post link", url: `${aiSite}/post/${workflowId}`, useKey: false },
  { description: "bare workflow ID on the default CN site", url: workflowId, useKey: false },
  { description: "AI post with an editor-only export and later schema recheck", url: `${aiSite}/post/${workflowId}`, useKey: false, editorFallback: true },
];
const publishAccess = { accessType: 0, publishScope: 0, encrypted: false, granted: true, needPassword: false };
const samplerInputs = { steps: 20, cfg: 5, denoise: 1, sampler_name: "euler", scheduler: "normal", model: ["18", 0], negative: ["16", 0] };
const finalSeed = 358401234567890;

for (const link of links) test(`AutoDL imports a RunningHub ${link.description} in one click with the instance ${link.liveSchema ? "reachable" : "offline"}`, async ({ page, baseURL }) => {
  const tempParent = path.resolve(os.tmpdir());
  const tempPrefix = "canvas-autodl-link-test-";
  const root = await mkdtemp(path.join(tempParent, tempPrefix));
  const title = "AutoDL 链接测试";
  const textOnly = link.textOnly === true;
  const graph = textOnly ? {
    "11": { class_type: "VAELoader", inputs: { vae_name: "fixture-vae.safetensors" } },
    "12": { class_type: "CLIPLoader", inputs: { clip_name: "fixture-clip.safetensors", type: "qwen_image" } },
    "16": { class_type: "CLIPTextEncode", inputs: { text: "fixed negative instruction", clip: ["12", 0] } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["22", 0], vae: ["11", 0] } },
    "18": { class_type: "UNETLoader", inputs: { unet_name: "fixture-unet.safetensors", weight_dtype: "default" } },
    "21": { class_type: "EmptyLatentImage", inputs: { width: ["60", 0], height: ["61", 0], batch_size: 1 } },
    "22": { class_type: "KSampler", inputs: { ...samplerInputs, positive: ["24", 0], latent_image: ["21", 0], seed: 874731702354943 } },
    "24": { class_type: "CLIPTextEncode", inputs: { text: ["49", 0], clip: ["12", 0] } },
    "49": { class_type: "CR Text", inputs: { text: "reference description" } },
    "60": { class_type: "INTConstant", inputs: { value: 1024 } },
    "61": { class_type: "INTConstant", inputs: { value: 1536 } },
    "70": { class_type: "CR Prompt Text", inputs: { prompt: "second instruction" } },
    "72": { class_type: "FixtureImageEdit", inputs: { prompt: ["70", 0], image: ["17", 0] } },
    "74": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "4:3", megapixels: 2.2 } },
    "75": { class_type: "EmptyLatentImage", inputs: { width: ["74", 0], height: ["74", 1], batch_size: 1 } },
    "77": { class_type: "KSampler", inputs: { ...samplerInputs, positive: ["72", 0], latent_image: ["75", 0], seed: finalSeed } },
    "78": { class_type: "VAEDecode", inputs: { samples: ["77", 0], vae: ["11", 0] } },
    "79": { class_type: "SaveImage", inputs: { images: ["78", 0], filename_prefix: "Example" } },
  } : {
    "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "Example" } },
  };
  const autoDL = "https://comfy-fixture.invalid";
  const objectInfo = {
    LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } }, output: ["IMAGE", "MASK"], output_node: false },
    SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } }, output: [], output_node: true },
    ...(link.editorFallback ? { FixtureSource: { input: { required: { seed: ["INT", {}], prompt: ["STRING", {}] } },
      input_order: { required: ["seed", "prompt"] }, output: ["IMAGE"], output_node: false } } : {}),
  };
  const editor = { version: 0.4, nodes: [
    { id: 1, type: "FixtureSource", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [5] }], widgets_values: { seed: 314, prompt: "fixture prompt" } },
    { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 5 }], outputs: [], widgets_values: { filename_prefix: "Example" } },
  ], links: [[5, 1, 0, 2, 0, "IMAGE"]] };
  const expectedSource = link.editorFallback ? editor : graph;
  const sourceSite = link.url.startsWith("https://") ? new URL(link.url).origin : cnSite;
  const origin = new URL(baseURL!).origin;
  const fakeKey = "isolated-runninghub-ai-key";
  const readerRequests: AIFisherWorkflowReaderRequest[] = [];
  const savedIds: string[] = [];
  const appDetails: unknown[] = [];
  const workflowDetails: unknown[] = [];
  let schemaReads = 0;
  let reachable = !!link.liveSchema;
  try {
    const remoteRead = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph, remoteId: workflowId }, { projectRoot: root });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === autoDL && url.pathname === "/object_info") {
        schemaReads++;
        return reachable ? route.fulfill({ json: objectInfo }) : route.fulfill({ status: 503, json: { error: "Offline fixture" } });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__canvas/"))
        return route.fulfill({ status: 503, json: { error: "Isolated browser test" } });
      return route.continue();
    });
    await page.route("**/api/runninghub/api/webapp/detail", route => {
      appDetails.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({ json: { code: 0, data: { id: appId, workflowId, workflowState: 1, publishAccess,
        ...(textOnly ? { inputNodes: [{ nodeId: "49", fieldName: "text", fieldType: "STRING", description: "提示词" }] } : {}),
      } } });
    });
    await page.route("**/api/runninghub/api/workflow/getDetail", route => {
      workflowDetails.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({ json: { code: 0, data: { id: workflowId, name: title, workflowState: 1, webappId: appId, publishAccess } } });
    });
    await page.route("**/__canvas/workflow-reader", async route => {
      const request = route.request().postDataJSON() as AIFisherWorkflowReaderRequest;
      readerRequests.push(request);
      expect(request.environment).not.toBe("runninghub-webapp");
      const read = request.environment === "runninghub-workflow"
        ? link.editorFallback ? { ...remoteRead, format: "comfy-ui-0.4", workflow: null, editorWorkflow: editor } : remoteRead
        : await readAIFisherWorkflow(request, { projectRoot: root });
      return route.fulfill({ json: read });
    });
    await page.route("**/__canvas/workflow-library", async route => route.fulfill({ json: await readWorkflowLibrary(root) }));
    await page.route("**/__canvas/workflow-library/source", async route => {
      const { workflowId } = route.request().postDataJSON();
      return route.fulfill({ json: await readWorkflowLibraryImportSource(root, workflowId) });
    });
    await page.route("**/__canvas/workflow-library/import", async route => {
      const imported = await writeWorkflowLibraryImport(root, route.request().postDataJSON());
      savedIds.push(imported.workflowId);
      return route.fulfill({ json: imported });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称").fill("AutoDL 链接导入验证");
    await page.getByRole("button", { name: "创建并打开" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "算力设置", exact: true });
    if (link.useKey) {
      await settings.getByRole("tab", { name: "RunningHub 工作流", exact: true }).click();
      await settings.getByLabel("RunningHub AI 海外站 API Key", { exact: true }).fill(fakeKey);
      await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
    }
    await settings.getByRole("tab", { name: "云端 ComfyUI", exact: true }).click();
    await settings.getByLabel("云端远程地址", { exact: true }).fill(autoDL);
    await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
    await settings.getByRole("button", { name: "工作流目录", exact: true }).click();
    await page.getByRole("dialog", { name: "更新工作流", exact: true }).getByRole("button", { name: "添加工作流", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加工作流", exact: true });
    await dialog.getByLabel("RunningHub 链接", { exact: true }).fill(link.url);
    await dialog.getByRole("button", { name: "读取并添加", exact: true }).click();
    await expect(dialog.getByText("已添加", { exact: true })).toBeVisible();
    await expect(dialog.getByText(link.liveSchema ? /已读取当前节点定义/ : /待校验|当前云端能力未确认/)).toBeVisible();
    expect(schemaReads).toBe(1);
    expect(appDetails).toEqual([{ webappId: appId }]);
    expect(workflowDetails).toEqual([{ workflowId }]);
    expect(readerRequests).toEqual([
      { environment: "runninghub-workflow", remote: {
        baseUrl: sourceSite, remoteId: workflowId, ...(link.useKey ? { apiKey: fakeKey } : { publicExport: true }),
      } },
      { environment: "comfyui", source: expectedSource, ...(link.liveSchema ? { objectInfo } : {}) },
    ]);
    expect(savedIds).toHaveLength(1);
    const savedImport = await readWorkflowLibraryImportSource(root, savedIds[0]);
    expect(savedImport.source).toStrictEqual(expectedSource);
    expect(savedImport).toMatchObject({
      ...(textOnly ? { config: { prompt: { binding: { nodeId: "49", path: "inputs.text" } }, inputs: [] } } : {}),
    });
    if (link.editorFallback) {
      await expect(dialog.getByText("原文件已保留，转换待完成", { exact: true })).toBeVisible();
      reachable = true;
      await dialog.getByRole("button", { name: "重新读取并检查", exact: true }).click();
      await expect(dialog.getByText("普通 JSON 已自动转换 · 1 个输出", { exact: true })).toBeVisible();
      expect(savedIds).toEqual([savedIds[0], savedIds[0]]);
      expect(readerRequests.slice(2)).toEqual([{ environment: "comfyui", source: editor, objectInfo }]);
      expect((await readWorkflowLibraryImportSource(root, savedIds[0])).source).toStrictEqual(editor);
      expect((await readWorkflowLibrary(root)).workflows[0].template).toStrictEqual({
        "1": { class_type: "FixtureSource", inputs: { seed: 314, prompt: "fixture prompt" }, _meta: { title: "FixtureSource" } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "Example" }, _meta: { title: "SaveImage" } },
      });
    }
    if (textOnly) await expect(dialog.getByText("3 个提示词字段 · 0 个素材输入", { exact: true })).toBeVisible();
    expect((await readWorkflowLibrary(root)).workflows).toEqual([expect.objectContaining({ name: title, original: expect.objectContaining({ id: savedIds[0] }) })]);
    await dialog.getByRole("button", { name: "在画布中使用", exact: true }).click();
    await expect(dialog).toBeHidden();
    const node = page.locator(".react-flow__node");
    await expect(node).toHaveCount(1);
    if (textOnly) {
      const prompt = page.getByRole("textbox", { name: "提示词", exact: true });
      if (!(await prompt.isVisible())) await node.click();
      await expect(prompt).toBeVisible();
      await expect(prompt).toHaveText("");
      const second = page.getByRole("textbox", { name: "CR Prompt Text · prompt", exact: true });
      const negative = page.getByRole("textbox", { name: "CLIPTextEncode · text", exact: true });
      await expect(second).toBeHidden();
      await expect(negative).toBeHidden();

      await page.setViewportSize({ width: 640, height: 900 });
      const parameters = page.getByRole("group", { name: "生成参数" });
      await expect(parameters.locator(".parameter > span")).toHaveText(["比例", "百万像素", "种子"]);
      await expect(parameters.getByLabel("种子", { exact: true })).toHaveValue(String(finalSeed));
      const footer = page.locator(".generation-panel .generation-footer");
      await expect.poll(() => footer.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const group = element.querySelector(".basic-parameters")!;
        return element.scrollWidth <= element.clientWidth + 1 && group.scrollWidth <= group.clientWidth + 1
          && [...group.children, ...element.children].every(child => {
            const item = child.getBoundingClientRect();
            return item.left >= bounds.left - 1 && item.right <= bounds.right + 1;
          });
      })).toBe(true);

      await page.getByRole("button", { name: "生成设置", exact: true }).click();
      const nodeParameters = page.getByRole("tab", { name: /节点参数/ });
      if (await nodeParameters.isVisible()) await nodeParameters.click();
      await expect(second).toHaveValue("second instruction");
      await expect(negative).toHaveValue("fixed negative instruction");
      await second.fill("updated independently");
      await expect(second).toHaveValue("updated independently");
    }
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== tempParent || !path.basename(absolute).startsWith(tempPrefix))
      throw new Error("Refusing to remove a path outside this test's temporary root.");
    await rm(absolute, { recursive: true, force: true });
  }
});
