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
