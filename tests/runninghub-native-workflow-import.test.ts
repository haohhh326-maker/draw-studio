import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiWorkflow, Connection } from "../src/types";
import { aifisherReadResultFor } from "../src/workflow/aifisher-reader-client";
import { readNativeRunningHubWorkflow } from "../src/runninghub/native-workflow-import";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
const token = "fixture-native-key";
const id = "2101880819102081026";
const connection: Connection = { name: "RH native", baseUrl: "https://www.runninghub.cn/proxy-plus", token, authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 0 };
const graph: ApiWorkflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "source prompt", clip: ["2", 0] } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen.safetensors" } },
  "3": { class_type: "LoadImage", inputs: { image: "sample.png" } },
  "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const readResponse = () => response({ environment: "runninghub-workflow", upstream: { revision: "bdcf3bec054594fcab591952a8c5acef858d6de4" }, workflow: graph,
  analysis: {}, bindingCandidates: [], outputEvidence: {}, parameterBindings: [], parameterBindingDto: { bindings: [] } });
const metadata = () => response({ code: 0, data: { id, name: "【Qwen Image 2.1】图像生成大合集" } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native RunningHub link imports", () => {
  it.each([`https://www.runninghub.cn/post/${id}`, `https://www.runninghub.cn/workflow/${id}`, `https://runninghub.cn/zh-CN/post/${id}?share=1`, id])("reads %s through the original AIFISHER graph reader without submitting a task", async reference => {
    const fetcher = vi.fn().mockResolvedValueOnce(readResponse()).mockResolvedValueOnce(metadata());
    vi.stubGlobal("fetch", fetcher);
    const original = structuredClone(connection), controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout");
    const result = await readNativeRunningHubWorkflow(reference, connection, controller.signal);
    expect(result).toEqual({ source: graph, name: "【Qwen Image 2.1】图像生成大合集", fileName: "【Qwen Image 2.1】图像生成大合集.json", workflowId: id, sourceUrl: `https://www.runninghub.cn/post/${id}` });
    expect(aifisherReadResultFor(result.source)?.environment).toBe("runninghub-workflow");
    expect(connection).toEqual(original);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe("/__canvas/workflow-reader");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ environment: "runninghub-workflow", remote: { baseUrl: "https://www.runninghub.cn", remoteId: id, apiKey: token } });
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://www.runninghub.cn/api/workflow/getDetail");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ workflowId: id });
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal);
    expect(new Headers(fetcher.mock.calls[1][1].headers).has("Authorization")).toBe(false);
    expect(fetcher.mock.calls.every(call => !String(call[0]).includes(token))).toBe(true);
    expect(deadline).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("runninghub");
  });

  it("uses a key pasted in the native endpoint without retaining it in the imported source URL", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(readResponse()).mockResolvedValueOnce(metadata()); vi.stubGlobal("fetch", fetcher);
    const result = await readNativeRunningHubWorkflow(id, { ...connection, baseUrl: connection.baseUrl + "/" + token, token: "" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).remote.apiKey).toBe(token);
    expect(result.sourceUrl).not.toContain(token);
  });

  it.each([
    `https://www.runninghub.cn/ai-detail/${id}`, `https://www.runninghub.cn/webapp/${id}`, `https://www.runninghub.cn/openapi/v2/run/ai-app/${id}`,
    `https://www.runninghub.ai/post/${id}`, `https://evil.example/post/${id}`, `https://www.runninghub.cn.evil.example/post/${id}`,
    `http://www.runninghub.cn/post/${id}`, `https://user:password@www.runninghub.cn/post/${id}`, `https://www.runninghub.cn/proxy/${token}`,
  ])("rejects unsupported reference %s before transport", async reference => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readNativeRunningHubWorkflow(reference, connection)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects missing native key and cloud connections before transport", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readNativeRunningHubWorkflow(id, { ...connection, token: "" })).rejects.toThrow("API Key");
    await expect(readNativeRunningHubWorkflow(id, { ...connection, baseUrl: "https://comfy.example" })).rejects.toThrow("RunningHub");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the graph when public metadata is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(readResponse()).mockResolvedValueOnce(response({}, 503)));
    expect(await readNativeRunningHubWorkflow(id, connection)).toMatchObject({ source: graph, name: "RunningHub " + id, fileName: "RunningHub " + id + ".json" });
  });

  it("preserves upstream failure codes while hiding the native key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ error: "Reading failed " + token, code: "RUNNINGHUB_WORKFLOW_READ_FAILED" }, 409)));
    const error = await readNativeRunningHubWorkflow(id, connection).catch(reason => reason);
    expect(error).toMatchObject({ status: 409, code: "RUNNINGHUB_WORKFLOW_READ_FAILED" });
    expect(error.message).not.toContain(token);
  });

  it("does not return a completed import if cancellation happens during metadata reading", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(readResponse()).mockImplementationOnce(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }));
    await expect(readNativeRunningHubWorkflow(id, connection, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does no work for a cancelled read", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(readNativeRunningHubWorkflow(id, connection, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
