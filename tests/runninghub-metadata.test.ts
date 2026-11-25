import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningHubClient, parseRunningHubWorkflowMetadata } from "../src/runninghub/client";
import type { Connection } from "../src/types";

const id = "2104519856463900674";
const video = "https://rh-images.xiaoyaoyou.com/public/cover.mp4";
const connection: Connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token: "private-key", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 2 };
const client = (token = connection.token) => new RunningHubClient({ ...connection, token }, crypto.randomUUID());
afterEach(() => vi.unstubAllGlobals());

describe("RunningHub published workflow card metadata", () => {
  it("reads the real public title and handles a video disguised as a thumbnail", () => {
    expect(parseRunningHubWorkflowMetadata({ code: 0, data: { id, name: "【MINIMAX H3】武戏-高动态|极速高清| 全自动输出", covers: [{ url: video, thumbnailUri: video + "?imageMogr2/format/jpeg/ignore-error/1" }] } }, id)).toEqual({ name: "【MINIMAX H3】武戏-高动态|极速高清| 全自动输出", coverUrl: video, coverMediaType: "video" });
  });
  it("uses an image thumbnail and keeps title-only private or uncovered records valid", () => {
    const image = "https://rh-images.xiaoyaoyou.com/public/cover.webp";
    expect(parseRunningHubWorkflowMetadata({ id, name: "  我的图像\n  ", covers: [{ url: image, thumbnailUri: image + "?imageMogr2/thumbnail/600x" }] }, id)).toEqual({ name: "我的图像", coverUrl: image + "?imageMogr2/thumbnail/600x", coverMediaType: "image" });
    expect(parseRunningHubWorkflowMetadata({ id, name: "我的工作流", covers: [] }, id)).toEqual({ name: "我的工作流" });
    expect(() => parseRunningHubWorkflowMetadata({ id: "999", name: "Other workflow" }, id)).toThrow("ID 不一致");
  });
  it("never accepts executable, credential-bearing or foreign cover URLs", () => {
    for (const url of ["javascript:alert(1)", "data:image/svg+xml,x", "http://rh-images.xiaoyaoyou.com/x.png", "https://private-key@rh-images.xiaoyaoyou.com/x.png", "https://rh-images.xiaoyaoyou.com.evil.example/x.png", "https://127.0.0.1/x.png"]) expect(parseRunningHubWorkflowMetadata({ id, name: "Title", covers: [{ url, thumbnailUri: url }] }, id)).toEqual({ name: "Title" });
  });
  it.each(["workflow", "app"] as const)("requests only the fixed public %s detail contract without account credentials", async kind => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { id, name: "Published name", covers: [] } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(client("").getWorkflowMetadata(id, kind)).resolves.toEqual({ name: "Published name" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(connection.baseUrl + (kind === "app" ? "/api/webapp/detail" : "/api/workflow/getDetail"));
    expect(JSON.parse(String(init.body))).toEqual(kind === "app" ? { webappId: id } : { workflowId: id });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
  });
  it("does not fall back to a paid execution request when public metadata is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("upstream private text", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().getWorkflowMetadata(id)).rejects.toThrow("名称和封面");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client().getWorkflowMetadata("../123")).rejects.toThrow("ID");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps public card metadata separate from workflow reading and output classification", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify({ code: 0, data: { id, name: "MiniMax H3_电影质感V2", covers: [],
        tags: [{ name: "文生视频" }, { name: "图生视频" }], inputNodes: [{ nodeId: "199", fieldName: "image", fieldType: "IMAGE", fieldValue: "" }] } }));
    });
    vi.stubGlobal("fetch", fetcher);
    const metadata = await client("").getWorkflowMetadata(id, "app");
    expect(metadata).toEqual({ name: "MiniMax H3_电影质感V2" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.stringify(init)).not.toContain(connection.token);
    }
  });
});

describe("RunningHub AI app public workflow links", () => {
  const sourceId = "1935238341434462209";
  const app = { id, workflowId: sourceId, workflowState: 1 };
  const input = { nodeId: "49", fieldName: "text", fieldType: "STRING", description: "提示词", fieldValue: "sample prompt" };
  const source = { id: sourceId, name: "公开工作流", workflowState: 1, webappId: id,
    publishAccess: { granted: true, encrypted: false, needPassword: false } };
  const detail = (data: object) => new Response(JSON.stringify({ code: 0, data }));

  it("resolves the officially linked workflow with its exact ID and no credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(detail(app)).mockResolvedValueOnce(detail(source));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(client().getPublishedAppWorkflow(id, signal)).resolves.toEqual({ id: sourceId, name: source.name });
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      [connection.baseUrl + "/api/webapp/detail", { webappId: id }],
      [connection.baseUrl + "/api/workflow/getDetail", { workflowId: sourceId }],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", signal });
    }
  });

  it("carries the publisher's sole prompt node and field without copying the sample text", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(detail({ ...app, inputNodes: [input] })).mockResolvedValueOnce(detail(source)));
    await expect(client().getPublishedAppWorkflow(id)).resolves.toEqual({ id: sourceId, name: source.name,
      publishedPrompt: { nodeId: "49", field: "text" } });
  });

  it.each([
    [{ ...input, fieldType: "IMAGE" }],
    [{ ...input, fieldName: "prompt", description: "负向提示词" }],
    [{ ...input, fieldName: "prompt", secret: true }],
    [input, { ...input, nodeId: "70", fieldName: "prompt" }],
  ].map(inputNodes => ({ inputNodes })))
    ("keeps the workflow importable without a hint for unsafe or ambiguous prompt metadata", async ({ inputNodes }) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(detail({ ...app, inputNodes })).mockResolvedValueOnce(detail(source)));
      await expect(client().getPublishedAppWorkflow(id)).resolves.toEqual({ id: sourceId, name: source.name });
    });

  it("reads the same prompt evidence from a workflow link through its verified public app", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(detail(source)).mockResolvedValueOnce(detail({ ...app, inputNodes: [input] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().getWorkflowImportMetadata(sourceId)).resolves.toEqual({ name: source.name, publishedPrompt: { nodeId: "49", field: "text" } });
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      [connection.baseUrl + "/api/workflow/getDetail", { workflowId: sourceId }],
      [connection.baseUrl + "/api/webapp/detail", { webappId: id }],
    ]);
  });

  it.each([() => detail({ ...app, workflowId: "10", inputNodes: [input] }), () => new Response(null, { status: 503 })])
    ("keeps the workflow title when linked app evidence is unavailable or mismatched", async response => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(detail(source)).mockResolvedValueOnce(response()));
      await expect(client().getWorkflowImportMetadata(sourceId)).resolves.toEqual({ name: source.name });
    });

  it.each([
    { ...app, workflowId: null },
    { ...app, workflowState: 0 },
    { ...app, id: "1" },
    { ...app, workflowId: Number(sourceId) },
    { ...app, publishAccess: { granted: false } },
  ])("stops before reading a source when the app card cannot verify a published source", async appCard => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(detail(appCard));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().getPublishedAppWorkflow(id)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...source, id: "1" },
    { ...source, webappId: "1" },
    { ...source, workflowState: 0 },
    { ...source, publishAccess: { granted: false } },
    { ...source, publishAccess: { encrypted: true } },
    { ...source, publishAccess: { needPassword: true } },
  ])("rejects an unrelated, private or password-protected workflow card", async sourceCard => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(detail(app)).mockResolvedValueOnce(detail(sourceCard));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().getPublishedAppWorkflow(id)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
