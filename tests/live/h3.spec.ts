import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalog, defaultConnection } from "../../src/workflow/catalog";

const endpoint = process.env.COMFY_LIVE_URL;
const workflowId = process.env.COMFY_LIVE_WORKFLOW ?? "preset-1-1";
test.skip(
  !endpoint || process.env.COMFY_LIVE_CONFIRM !== "1",
  "Real GPU test requires COMFY_LIVE_URL and explicit COMFY_LIVE_CONFIRM=1",
);

test("real workflow upload, generation, download, same-node writeback and offline reload", async ({
  page,
  request,
}) => {
  const baseUrl = endpoint!.replace(/\/$/, "");
  const authorization = process.env.COMFY_AUTHORIZATION ?? "";
  const headers = authorization ? { Authorization: authorization } : {};
  const queueResponse = await request.get(baseUrl + "/queue", { headers });
  expect(queueResponse.ok()).toBe(true);
  const queue = await queueResponse.json();
  expect(queue.queue_running).toHaveLength(0);
  expect(queue.queue_pending).toHaveLength(0);
  const output = resolve(
    "live-results",
    new Date().toISOString().replace(/[:.]/g, "-") + "-" + workflowId,
  );
  await mkdir(output, { recursive: true });
  let submissions = 0;
  page.on("request", (req) => {
    if (req.url() === baseUrl + "/prompt" && req.method() === "POST")
      submissions++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("H3 云端验收");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await page.locator(".canvas-shell").waitFor();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByText("已保存到本机", { exact: true })).toBeVisible();
  const inputBytes = Array.from(
    await readFile(resolve("tests/live/reference.png")),
  );
  const definition = catalog.find((w) => w.id === workflowId)!;
  expect(definition?.template).toBeTruthy();
  const media: {
    id: string;
    name: string;
    kind: string;
    mime: string;
    bytes: number[];
    role: string;
  }[] = [];
  const addMedia = async (kind: string, name: string, role = "auto") => {
    media.push({
      id: "input" + media.length,
      kind,
      name,
      role,
      mime:
        kind +
        "/" +
        (kind === "image" ? "png" : kind === "audio" ? (name.endsWith(".mp3") ? "mpeg" : "wav") : "mp4"),
      bytes:
        name === "reference.png"
          ? inputBytes
          : Array.from(await readFile(resolve("tests/live", name))),
    });
  };
  if (["audio-to-audio", "audio-to-text"].includes(definition.mode))
    await addMedia("audio", "reference-speech.mp3");
  else if (definition.mode === "reference-video")
    await addMedia("video", "reference.mp4");
  else if (definition.mode === "first-last-frame") {
    await addMedia("image", "reference.png", "firstFrame");
    await addMedia("image", "last-frame.png", "lastFrame");
  } else if (!["text-to-video", "text-to-image", "text-to-audio", "text-tool"].includes(definition.mode)) {
    await addMedia("image", "reference.png");
    if (definition.requiredInputs.includes("referenceAudio"))
      await addMedia("audio", "reference.wav");
    else if (definition.mode === "multi-reference")
      await addMedia("image", "last-frame.png");
  }
  await page.evaluate(
    async ({ inputBytes, workflows, connection, workflowId, media, outputKind }) => {
      const db = await new Promise<IDBDatabase>((ok, fail) => {
        const r = indexedDB.open("clearframe-canvas", 1);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      const library: any = await new Promise((ok, fail) => {
        const r = db
          .transaction("records")
          .objectStore("records")
          .get("project-library");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      const entry = library[sessionStorage.getItem("clearframe-open-project")!];
      const p = entry.project,
        canvas = p.canvases[0];
      entry.workflows = workflows;
      p.assets.reference = {
        id: "reference",
        name: "reference.png",
        kind: "image",
        mime: "image/png",
        size: inputBytes.length,
        createdAt: Date.now(),
      };
      canvas.nodes = [
        {
          id: "ref",
          type: "media",
          position: { x: 80, y: 120 },
          data: { kind: "reference", title: "测试参考", assetId: "reference" },
        },
        {
          id: "text",
          type: "media",
          position: { x: 80, y: 490 },
          data: {
            kind: "text",
            title: "测试文本",
            text: workflowId.startsWith("voxcpm2-") ? "Hello from our canvas. This is a short voice generation test." : outputKind === "audio" ? "A gentle instrumental piano melody, calm studio recording, soft warm sound, no vocals." : "A blue cube slowly rotates on a clean studio surface. Static camera, soft lighting, smooth gentle movement, no text.",
          },
        },
        {
          id: "result",
          type: "media",
          position: { x: 570, y: 120 },
          data: {
            kind: outputKind === "image" ? "image-generation" : outputKind === "text" ? "tool" : outputKind,
            title: "云端验收视频",
            generation: {
              workflowId,
              prompt: "",
              negativePrompt: "",
              params: outputKind === "image" ? { width: 512, height: 512, outputWidth: 768, outputHeight: 768, seed: 58 } : outputKind === "audio" ? { duration: 8, seed: 58, tuning: "Fast Draft", transcript: "Hello from our canvas. This is a short voice generation test." } : { duration: 5, seed: 58, megapixels: 0.6 },
              taskId: null,
            },
          },
        },
      ];
      canvas.edges = [
        {
          id: "ref-result",
          source: "ref",
          target: "result",
          data: { role: "auto", order: 0 },
        },
        {
          id: "text-result",
          source: "text",
          target: "result",
          data: { role: "prompt", order: 1 },
        },
      ];
      canvas.nodes = canvas.nodes.filter((n: any) => n.id !== "ref");
      canvas.edges = canvas.edges.filter((e: any) => e.id !== "ref-result");
      p.assets = {};
      for (const [i, item] of media.entries()) {
        p.assets[item.id] = {
          id: item.id,
          name: item.name,
          kind: item.kind,
          mime: item.mime,
          size: item.bytes.length,
          createdAt: Date.now(),
        };
        canvas.nodes.push({
          id: item.id,
          type: "media",
          position: { x: 80 + (i % 2) * 260, y: 100 + Math.floor(i / 2) * 300 },
          data: { kind: "reference", title: item.name, assetId: item.id },
        });
        canvas.edges.push({
          id: item.id + "-result",
          source: item.id,
          target: "result",
          data: { role: item.role, order: i + 2 },
        });
      }
      await new Promise<void>((ok, fail) => {
        const tx = db.transaction(["records", "assets"], "readwrite");
        for (const item of media)
          tx.objectStore("assets").put(
            new Blob([new Uint8Array(item.bytes)], { type: item.mime }),
            item.id,
          );
        tx.objectStore("records").put(library, "project-library");
        tx.objectStore("records").put(connection, "connection");
        tx.oncomplete = () => ok();
        tx.onerror = () => fail(tx.error);
      });
      db.close();
    },
    {
      inputBytes,
      workflowId,
      outputKind: definition.output.kind,
      media,
      workflows: catalog,
      connection: {
        ...defaultConnection,
        baseUrl,
        token: authorization,
        authPrefix: "",
        timeoutMinutes: 25,
      },
    },
  );
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "云端验收视频" })
    .click();
  await page.getByRole("button", { name: "生成", exact: true }).click();
  let project: any;
  let lastStatus = "";
  const deadline = Date.now() + 26 * 60_000;
  while (Date.now() < deadline) {
    project = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((ok, fail) => {
        const r = indexedDB.open("clearframe-canvas", 1);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      const library: any = await new Promise((ok, fail) => {
        const r = db
          .transaction("records")
          .objectStore("records")
          .get("project-library");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
      db.close();
      return library[sessionStorage.getItem("clearframe-open-project")!]
        .project;
    });
    const task: any = Object.values(project.tasks)[0];
    if (task) {
      const status = `${task.status} ${task.progress ?? ""}`;
      if (status !== lastStatus) {
        console.log("LIVE", status, task.promptId ?? "");
        lastStatus = status;
      }
      if (
        ["completed", "failed", "interrupted", "cancelled"].includes(
          task.status,
        )
      )
        break;
    }
    await page.waitForTimeout(2000);
  }
  const task: any = Object.values(project.tasks)[0];
  await writeFile(
    resolve(output, "task.json"),
    JSON.stringify(task ?? { error: "No persisted task" }, null, 2),
  );
  expect(task?.status, task?.details ?? task?.error).toBe("completed");
  expect(submissions).toBe(1);
  expect(task.executorType).toBe("comfyui");
  expect(task.promptId).toBeTruthy();
  expect(task.input.texts).toHaveLength(1);
  if (definition.output.kind !== "text") expect(task.remoteOutputs[0].filename).toMatch(definition.output.kind === "video" ? /\.mp4$/i : definition.output.kind === "audio" ? /\.(mp3|flac|wav|opus)$/i : /\.(png|jpg|webp)$/i);
  const result = project.canvases[0].nodes.find((n: any) => n.id === "result");
  expect(result.data.assetId).toBe(task.outputs[0]);
  expect(project.canvases[0].nodes).toHaveLength(2 + media.length);
  const asset = project.assets[result.data.assetId];
  expect(asset.kind).toBe(definition.output.kind);
  expect(asset.size).toBeGreaterThan(definition.output.kind === "text" ? 0 : 1024);
  const bytes = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((ok) => {
      const r = indexedDB.open("clearframe-canvas", 1);
      r.onsuccess = () => ok(r.result);
    });
    const blob = await new Promise<Blob>((ok) => {
      const r = db.transaction("assets").objectStore("assets").get(id);
      r.onsuccess = () => ok(r.result);
    });
    db.close();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, result.data.assetId);
  await writeFile(resolve(output, "result." + (definition.output.kind === "text" ? "txt" : task.remoteOutputs[0].filename.split(".").pop())), Buffer.from(bytes));
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目", exact: true }).click();
  await (await download).saveAs(resolve(output, "H3-live.aicanvas"));
  await page.route(baseUrl + "/**", (route) => route.abort());
  await page.reload();
  const preview = page
    .locator(".react-flow__node")
    .filter({ hasText: "云端验收视频" })
    .locator(definition.output.kind === "image" ? "img" : definition.output.kind === "text" ? ".text-result" : definition.output.kind);
  await expect(preview).toBeVisible();
  let duration: number | undefined;
  if (definition.output.kind === "text") {
    await expect(preview).toHaveText(task.outputText);
    expect(result.data.text).toBe(task.outputText);
  } else if (definition.output.kind === "image") {
    await expect.poll(() => preview.evaluate((v) => (v as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  } else {
    await expect.poll(() => preview.evaluate((v) => (v as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1);
    duration = await preview.evaluate((v) => (v as HTMLMediaElement).duration);
    expect(duration).toBeGreaterThan(0);
  }
  expect(submissions).toBe(1);
  await page.screenshot({ path: resolve(output, "offline-writeback.png") });
  await writeFile(
    resolve(output, "acceptance.json"),
    JSON.stringify(
      {
        status: "passed",
        workflowId,
        taskId: task.taskId,
        promptId: task.promptId,
        duration,
        bytes: bytes.length,
        submissions,
        offlineReload: true,
      },
      null,
      2,
    ),
  );
  console.log("LIVE_ACCEPTANCE", output);
});
