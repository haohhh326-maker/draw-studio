import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyUIClient, collectWorkflowOutputs, outputFiles, outputText } from "../src/comfyui/client";
import { taskDirectories, outputKey } from "../src/comfyui/files";
import { catalog, defaultConnection } from "../src/workflow/catalog";

const connection = { ...defaultConnection, baseUrl: "http://127.0.0.1:8188" };
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("direct standard ComfyUI transport", () => {
  it("automatically reads nested custom history results while ignoring progress, configuration and metadata URLs", () => {
    const workflow = { ...catalog[0], output: { nodeId: "unknown", field: "*", kind: "file" as const } };
    const image = { filename: "image.avif", subfolder: "task", type: "output" as const };
    const result = collectWorkflowOutputs({ outputs: { unknown: {
      filename_prefix: "infinite-canvas/task/result", progress: { value: 0.5, max: 1 }, settings: { seed: 123, enabled: true }, media_url: "https://foreign.example/remote.png",
      arbitrary_result: { generated: [image, image], notes: { texts: ["Caption", "https://example.com/document"] } },
      other_result: [{ clips: [{ filename: "clip.mkv", type: "output" }] }, { sound: { filename: "song.flac", type: "temp" } }, { bundle: { files: [{ filename: "report.pdf", type: "output" }, { filename: "captions.vtt", type: "output" }] } }],
    } } }, workflow);
    expect(result.files.map(file => file.filename)).toEqual(["image.avif", "clip.mkv", "song.flac", "report.pdf", "captions.vtt"]);
    expect(result.files.map(file => result.fileKinds[outputKey(file)])).toEqual(["image", "video", "audio", "file", "text"]);
    expect(result.automaticFiles).toEqual(result.files.map(outputKey)); expect(result.text).toBe("Caption\nhttps://example.com/document");
    expect(result.textFirst).toBe(false); expect(result.warnings).toEqual([]);
  });
  it("preserves actual JSON and numeric tool results, but reports empty or metadata-only automatic results", () => {
    const workflow = { ...catalog[0], output: { nodeId: "detect", field: "*", kind: "file" as const } };
    const result = collectWorkflowOutputs({ outputs: { detect: { progress: 1, filename_prefix: "result", result: { boxes: [[0, 1, 2, 3]], confidence: .9, valid: true } } } }, workflow);
    expect(JSON.parse(result.text ?? "null")).toEqual({ result: { boxes: [[0, 1, 2, 3]], confidence: .9, valid: true } });
    expect(result.files).toEqual([]); expect(result.textFirst).toBe(true);
    expect(() => collectWorkflowOutputs({ outputs: { detect: { progress: 1, filename_prefix: "result", settings: { enabled: true }, url: "https://foreign.example/result.mp4" } } }, workflow)).toThrow("没有可读取的生成结果");
    expect(() => collectWorkflowOutputs({ outputs: { detect: {} } }, workflow)).toThrow("没有可读取的生成结果");
  });
  it("never turns nested unsafe paths or remote URL descriptors into automatic downloads", () => {
    const workflow = { ...catalog[0], output: { nodeId: "unknown", field: "*", kind: "file" as const } };
    expect(() => collectWorkflowOutputs({ outputs: { unknown: { result: { nested: [{ filename: "../private.png" }] } } } }, workflow)).toThrow("路径");
    expect(() => collectWorkflowOutputs({ outputs: { unknown: { result: { filename: "https://foreign.example/file.png" } } } }, workflow)).toThrow("路径");
    expect(() => collectWorkflowOutputs({ outputs: { unknown: { result: { filename: "private.png", type: "input" } } } }, workflow)).toThrow("output 或 temp");
    const result = collectWorkflowOutputs({ outputs: { unknown: { text: "https://example.com/generated-reference" } } }, workflow);
    expect(result.text).toBe("https://example.com/generated-reference"); expect(result.files).toEqual([]);
  });
  it("keeps recognized media from other automatic outputs when one branch only supplies metadata", () => {
    const workflow = { ...catalog[0], output: { nodeId: "image", field: "*", kind: "file" as const }, additionalOutputs: [{ nodeId: "metadata", field: "*", kind: "file" as const }] };
    const result = collectWorkflowOutputs({ outputs: { image: { unknown: { filename: "result.png" } }, metadata: { progress: 1 } } }, workflow);
    expect(result.files).toHaveLength(1); expect(result.warnings).toHaveLength(1);
    expect(result.fileKinds[outputKey(result.files[0])]).toBe("image");
  });
  it("collects selected custom history fields in primary order, including mixed media, inline text and generic files", () => {
    const workflow = { ...catalog[0], output: { nodeId: "image", field: "custom_images", kind: "image" as const }, additionalOutputs: [
      { nodeId: "video", field: "clips", kind: "video" as const }, { nodeId: "audio", field: "sound", kind: "audio" as const },
      { nodeId: "text", field: "caption", kind: "text" as const }, { nodeId: "file", field: "documents", kind: "file" as const },
      { nodeId: "duplicate", field: "same", kind: "file" as const },
    ] };
    const descriptor = { filename: "result.png", subfolder: "task", type: "output" as const };
    const history = { outputs: {
      image: { custom_images: [descriptor] }, video: { clips: [{ filename: "result.mp4", type: "output" }] },
      audio: { sound: [{ filename: "result.wav", type: "temp" }] }, text: { caption: ["Caption", "Second line"] },
      file: { documents: { filename: "report.pdf", type: "output" } }, duplicate: { same: [descriptor] },
    } };
    const results = collectWorkflowOutputs(history, workflow);
    expect(results.files.map(file => file.filename)).toEqual(["result.png", "result.mp4", "result.wav", "report.pdf"]);
    expect(results.text).toBe("Caption\nSecond line"); expect(results.textFirst).toBe(false);
    expect(results.fileKinds[outputKey(results.files[0])]).toBe("image");
    expect(results.files.map(file => results.fileKinds[outputKey(file)])).toEqual(["image", "video", "audio", "file"]);
    expect(outputFiles(history, workflow)).toEqual([descriptor]);
    expect(outputText(history, { ...workflow, output: workflow.additionalOutputs[2] })).toBe("Caption\nSecond line");
  });
  it("keeps output and temp descriptors distinct and retains a primary inline text result", () => {
    const workflow = { ...catalog[0], output: { nodeId: "text", field: "content", kind: "text" as const }, additionalOutputs: [
      { nodeId: "files", field: "attachments", kind: "file" as const },
    ] };
    const result = collectWorkflowOutputs({ outputs: { text: { content: "Primary text" }, files: { attachments: [
      { filename: "same.bin", type: "output" }, { filename: "same.bin", type: "temp" }, { filename: "same.bin", type: "output" },
    ] } } }, workflow);
    expect(result.textFirst).toBe(true); expect(result.text).toBe("Primary text");
    expect(result.files).toHaveLength(2); expect(result.files.map(file => file.type)).toEqual(["output", "temp"]);
    expect(() => collectWorkflowOutputs({ outputs: { text: { content: "Valid" }, files: { attachments: [{ filename: "../private.bin" }] } } }, workflow)).toThrow("路径");
    expect(() => collectWorkflowOutputs({ outputs: { text: { content: "Valid" } } }, workflow)).toThrow("files.attachments");
  });
  it.each(["image/png", "video/mp4", "audio/wav"])(
    "stages %s with the standard multipart contract and server-returned name",
    async (mime) => {
      const client = new ComfyUIClient({
        ...defaultConnection,
        baseUrl: "https://compute.example/comfy",
        token: "session-secret",
      });
      const folder = taskDirectories("task-1").inputSubfolder;
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://compute.example/comfy/upload/image");
        expect(init.method).toBe("POST");
        const form = init.body as FormData;
        expect(form.get("subfolder")).toBe(folder);
        expect(form.get("type")).toBe("input");
        expect(form.get("overwrite")).toBe("false");
        const file = form.get("image") as File;
        expect(file.type).toBe(mime);
        expect(await file.text()).toBe("media-content");
        return json({
          name: "server-renamed (1).bin",
          subfolder: folder,
          type: "input",
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const result = await client.uploadAsset(
        new Blob(["media-content"], { type: mime }),
        "source.bin",
        folder,
      );
      expect(result.inputName).toBe(folder + "/server-renamed (1).bin");
      expect(JSON.stringify(result)).not.toContain("session-secret");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("isolates two tasks and rejects upload responses outside the requested task directory", async () => {
    const a = taskDirectories("task-a"),
      b = taskDirectories("task-b");
    expect(a.inputSubfolder).not.toBe(b.inputSubfolder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ name: "asset.png", subfolder: b.inputSubfolder, type: "input" }),
      ),
    );
    await expect(
      new ComfyUIClient(connection).uploadAsset(
        new Blob(["image"]),
        "asset.png",
        a.inputSubfolder,
      ),
    ).rejects.toThrow("本次任务");
  });

  it.each(["../other", "/etc", "C:\\files", "a/../b", "a//b"])(
    "rejects non-relative staging path %s before networking",
    async (folder) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        new ComfyUIClient(connection).uploadAsset(
          new Blob(["image"]),
          "asset.png",
          folder,
        ),
      ).rejects.toThrow("路径");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("downloads the exact history descriptor with encoded query parameters", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/view");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        filename: "result #1.mp4",
        subfolder: "infinite-canvas/task-1",
        type: "output",
      });
      expect(init.signal).toBeDefined();
      return new Response("video-bytes", {
        headers: { "Content-Type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const blob = await new ComfyUIClient(connection).getOutput({
      filename: "result #1.mp4",
      subfolder: "infinite-canvas/task-1",
      type: "output",
    });
    expect(await blob.text()).toBe("video-bytes");
    expect(blob.type).toBe("video/mp4");
  });

  it("rejects malformed or input-directory output descriptors", () => {
    const w = {
      ...catalog[0],
      output: { nodeId: "9", field: "videos", kind: "video" as const },
    };
    expect(() =>
      outputFiles(
        { outputs: { "9": { videos: [{ filename: "../../private.mp4" }] } } },
        w,
      ),
    ).toThrow();
    expect(() =>
      outputFiles(
        {
          outputs: { "9": { videos: [{ filename: "a.mp4", type: "input" }] } },
        },
        w,
      ),
    ).toThrow();
  });

  it("submits only to /prompt with client identity for recovery", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe("/prompt");
      expect(JSON.parse(init.body as string)).toMatchObject({
        client_id: "client-1",
        prompt_id: "request-1",
        extra_data: { infinite_canvas: { requestId: "request-1" } },
      });
      return json({ prompt_id: "server-id" });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      await new ComfyUIClient(connection, "client-1").queuePrompt(
        { "1": { class_type: "Test", inputs: {} } },
        "request-1",
      ),
    ).toBe("server-id");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("native cancellation without a Bridge dependency", () => {
  it("does not treat cancelled=false as successful cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ cancelled: false })),
    );
    await expect(
      new ComfyUIClient(connection).cancel("done-task"),
    ).rejects.toThrow("未取消");
  });
  it("uses standard queue deletion when the native job route is unavailable", async () => {
    let deleted = false;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.startsWith("/api/jobs/"))
          return new Response("missing", { status: 404 });
        if (path === "/queue" && init.method === "POST") {
          expect(JSON.parse(init.body as string)).toEqual({
            delete: ["pending-task"],
          });
          deleted = true;
          return new Response("");
        }
        if (path === "/queue")
          return json({
            queue_running: [],
            queue_pending: deleted ? [] : [[1, "pending-task"]],
          });
        if (path === "/history/pending-task") return json({});
        throw new Error("Unexpected endpoint: " + path);
      }),
    );
    await new ComfyUIClient(connection).cancel("pending-task");
    expect(deleted).toBe(true);
    expect(calls).not.toContain("/interrupt");
  });
});

describe("ambiguous submission and cancellation races", () => {
  it("keeps a successful HTTP response without prompt_id uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ number: 1 })),
    );
    const error = await new ComfyUIClient(connection)
      .queuePrompt({}, "request-1")
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain("恢复查询");
  });
  it.each(["still-pending", "already-completed"])(
    "does not confirm cancellation when %s",
    async (state) => {
      let deleted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path.startsWith("/api/jobs/"))
            return new Response("missing", { status: 404 });
          if (path === "/queue" && init.method === "POST") {
            deleted = true;
            return new Response("");
          }
          if (path === "/queue")
            return json({
              queue_running: [],
              queue_pending:
                !deleted || state === "still-pending" ? [[1, "task"]] : [],
            });
          if (path === "/history/task")
            return json({ task: { outputs: {}, status: { completed: true } } });
          throw new Error("Unexpected endpoint " + path);
        }),
      );
      await expect(
        new ComfyUIClient(connection).cancel("task"),
      ).rejects.toThrow(state === "still-pending" ? "未移除" : "执行结束");
    },
  );
});

describe("automatic realtime address", () => {
  it.each([
    ["http://compute.example:8188", "ws://compute.example:8188/ws"],
    ["https://compute.example/comfy", "wss://compute.example/comfy/ws"],
  ])(
    "derives the socket from %s without a separate setting",
    async (baseUrl, expected) => {
      const addresses: string[] = [];
      class Socket {
        onopen?: () => void;
        constructor(url: URL) {
          addresses.push(url.toString());
          queueMicrotask(() => this.onopen?.());
        }
        close() {}
      }
      vi.stubGlobal("WebSocket", Socket);
      const client = new ComfyUIClient(
        { ...connection, baseUrl },
        "client-automatic",
      );
      await client.connect();
      expect(addresses).toEqual([expected + "?clientId=client-automatic"]);
      client.disconnect();
    },
  );
});
