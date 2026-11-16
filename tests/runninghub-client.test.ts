import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningHubClient, normalizeRunningHubBaseUrl, runningHubNodeInfoList } from "../src/runninghub/client";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { ApiError, collectWorkflowOutputs, ExecutionError, friendlyError } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
import type { ApiWorkflow, Connection, TaskState, WorkflowDefinition } from "../src/types";

const token = "secret-rh-fixture-key";
const connection: Connection = { name: "RunningHub", baseUrl: "https://www.runninghub.cn", token, authHeader: "Other", authPrefix: "wrong ", timeoutMinutes: 2 };
const graph: ApiWorkflow = {
  "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "example prompt" } },
  "3": { class_type: "KSampler", inputs: { positive: ["2", 0], seed: 1, steps: 4 } },
  "9": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "ComfyUI" } },
};
const definition: WorkflowDefinition = { id: "rh.test", name: "自己的图像", description: "", family: "测试模型", mode: "image-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [{ semantic: "prompt", nodeId: "2", field: "text" }, { semantic: "image", nodeId: "1", field: "image" }], output: { nodeId: "9", field: "images", kind: "image" }, template: graph, runninghub: { workflowId: "1234567890123456789", baseUrl: connection.baseUrl } };
const client = (workflow: WorkflowDefinition | undefined = definition, options: Partial<Connection> = {}) => new RunningHubClient({ ...connection, ...options }, crypto.randomUUID(), workflow);
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const success = (data: unknown) => response({ code: 0, msg: "success", data });
const readResponse = async (source: ApiWorkflow) => response(await readAIFisherWorkflow({ environment: "runninghub-workflow", source, remoteId: definition.runninghub!.workflowId }));
function mockFetch(...responses: (Response | (() => Response))[]) {
  const mock = vi.fn(async (_url: unknown, _init?: RequestInit): Promise<Response> => { const item = responses.shift(); if (!item) throw new Error("unexpected fetch"); return typeof item === "function" ? item() : item; });
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("RunningHub request failure stages", () => {
  it.each([
    ["/openapi/v2/media/upload/binary", "素材上传连接中断"],
    ["/uc/openapi/accountStatus", "账户检测连接中断"],
    ["/task/openapi/create", "提交请求连接中断"],
    ["/task/openapi/ai-app/run", "提交请求连接中断"],
    ["/openapi/v2/run/ai-app/123456789", "提交请求连接中断"],
    ["/task/openapi/outputs", "任务查询连接中断"],
    ["/task/openapi/status", "任务查询连接中断"],
    ["/openapi/v2/query", "任务查询连接中断"],
    ["/task/openapi/cancel", "取消请求连接中断"],
  ])("keeps %s transport failures specific to RunningHub and redacts diagnostic credentials", async (path, stage) => {
    const transport = vi.fn().mockRejectedValue(new TypeError("Failed to fetch; apiKey=" + token + "; Authorization: Bearer " + token));
    vi.stubGlobal("fetch", transport);
    const error = await client().request(path, { method: "POST" }).catch(reason => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error).not.toBeInstanceOf(ExecutionError);
    const feedback = friendlyError(error);
    expect(feedback.error).toContain(stage);
    expect(feedback.error).not.toContain("工作站");
    expect(feedback.details).toContain("Failed to fetch");
    expect(JSON.stringify(feedback)).not.toContain(token);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps a lost submission response uncertain without retrying or inventing a task ID", async () => {
    const transport = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", transport);
    const c = client(), error = await c.queuePrompt(graph, "lost-submit-response").catch(reason => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error).not.toBeInstanceOf(ExecutionError);
    expect(friendlyError(error).error).toContain("是否已接受任务尚未确认");
    expect(await c.findSubmittedPrompt("lost-submit-response")).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("passes caller cancellation into the paid submit request", async () => {
    const controller = new AbortController();
    const transport = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const c = client(), submission = c.queuePrompt(graph, "abort-submit", controller.signal);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport.mock.calls[0][1]!.signal?.aborted).toBe(false);
    controller.abort();
    expect(transport.mock.calls[0][1]!.signal?.aborted).toBe(true);
    await expect(submission).rejects.toMatchObject({ name: "AbortError" });
    expect(await c.findSubmittedPrompt("abort-submit")).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reports an interrupted upload without creating a generation task", async () => {
    const transport = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", transport);
    const error = await client().uploadAsset(new Blob(["image-data"]), "input.png", "", new AbortController().signal).catch(reason => reason);
    expect(friendlyError(error).error).toContain("素材上传连接中断，尚未提交生成任务");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toContain("/openapi/v2/media/upload/binary");
  });

  it("preserves explicit cancellation instead of treating it as a transport failure", async () => {
    const cancelled = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cancelled));
    await expect(client().request("/openapi/v2/media/upload/binary")).rejects.toBe(cancelled);
  });

  it("keeps an upload pending beyond five minutes and only cancels on the caller signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const transport = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const uploading = client().uploadAsset(new Blob(["image-data"]), "input.png", "", controller.signal);
    const cancelled = expect(uploading).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(600000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]!.signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await cancelled;
  });
  it("leaves consumer workflow requests pending until caller cancellation with no local request timeout", async () => {
    vi.useFakeTimers();
    const workflow = structuredClone(definition); workflow.runninghub!.billingMode = "consumer";
    const controller = new AbortController();
    const transport = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const pending = client(workflow).request("/task/openapi/outputs", { method: "POST", signal: controller.signal });
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(600000);
    expect(transport.mock.calls[0][1]!.signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
    controller.abort(); await cancelled;
  });
  it("keeps consumer workflow result polling active beyond the saved task time limit", async () => {
    vi.useFakeTimers();
    const workflow = structuredClone(definition); workflow.runninghub!.billingMode = "consumer";
    const controller = new AbortController(), onState = vi.fn();
    const transport = vi.fn(async () => response({ code: 804, msg: "running" }));
    vi.stubGlobal("fetch", transport);
    const pending = client(workflow, { timeoutMinutes: 1 }).waitForCompletion("accepted-task", onState, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(180000);
    expect(transport.mock.calls.length).toBeGreaterThan(50);
    expect(controller.signal.aborted).toBe(false);
    expect(onState).toHaveBeenLastCalledWith({ status: "generating", progress: undefined });
    controller.abort(); await cancelled;
  });
});

describe("RunningHub selected binding submissions", () => {
  const selectedDefinition = (): WorkflowDefinition => ({
    ...structuredClone(definition),
    template: { ...structuredClone(graph), "7": { class_type: "ProviderTextAPI", inputs: { provider_api_key: "", model: "internal-model" } } },
    runninghub: { ...definition.runninghub!, bindingMode: "selected" },
  });
  it("checks the consumer account and submits only workflowId plus bindings without a local workflow", async () => {
    const source = selectedDefinition();
    source.runninghub!.billingMode = "consumer";
    source.runninghub!.includeWorkflowJson = false;
    const workflow = await attachRunningHubExecutionContract(source);
    const fetcher = mockFetch(success({ apiType: "NORMAL", remainCoins: "15", remainMoney: "2.50" }), success({ taskId: "remote-consumer-task" }));
    await expect(client(workflow).queuePrompt(workflow.template!, "consumer-run")).resolves.toBe("remote-consumer-task");
    expect(String(fetcher.mock.calls[0][0])).toContain("/uc/openapi/accountStatus");
    expect(String(fetcher.mock.calls[1][0])).toContain("/task/openapi/create");
    const body = JSON.parse(String(fetcher.mock.calls[1][1]!.body));
    expect(body.workflowId).toBe(source.runninghub!.workflowId);
    expect(body.nodeInfoList).toBeInstanceOf(Array);
    expect(body).not.toHaveProperty("workflow");
  });
  it("omits unconnected sample media overrides while submitting edited secondary text and parameters with all grouped connections intact", async () => {
    const source = selectedDefinition();
    source.runninghub!.billingMode = "consumer";
    source.runninghub!.includeWorkflowJson = false;
    source.inputSlots = [{ semantic: "image", label: "Reference", kind: "image", required: false }];
    source.template!["2"].inputs.secondary_prompt = "author secondary prompt";
    source.template!["3"].inputs.config = { sampling: { enabled: true }, stages: [1, 2, 3] };
    source.template!["8"] = { class_type: "ReferenceCollection", inputs: { "ref_images.image0": ["1", 0], "ref_images.image1": ["1", 0] } };
    source.mapping.push({ semantic: "secondary", nodeId: "2", field: "secondary_prompt" }, { semantic: "steps", nodeId: "3", field: "steps" });
    const workflow = await attachRunningHubExecutionContract(source), runtime = structuredClone(workflow.template!);
    runtime["2"].inputs.text = "User main prompt";
    runtime["2"].inputs.secondary_prompt = "User secondary prompt";
    runtime["3"].inputs.steps = 19;
    const before = structuredClone(runtime);
    const fetcher = mockFetch(success({ apiType: "NORMAL" }), success({ taskId: "remote-overrides-only" }));
    await expect(client(workflow).queuePrompt(runtime, "remote-overrides-only")).resolves.toBe("remote-overrides-only");
    const body = JSON.parse(String(fetcher.mock.calls[1][1]!.body));
    expect(body.nodeInfoList).toContainEqual({ nodeId: "2", fieldName: "text", fieldValue: "User main prompt" });
    expect(body.nodeInfoList).toContainEqual({ nodeId: "2", fieldName: "secondary_prompt", fieldValue: "User secondary prompt" });
    expect(body.nodeInfoList).toContainEqual({ nodeId: "3", fieldName: "steps", fieldValue: 19 });
    expect(body.nodeInfoList.some((field: { nodeId: string; fieldName: string }) => field.nodeId === "1" && field.fieldName === "image")).toBe(false);
    expect(body.nodeInfoList.some((field: { nodeId: string; fieldName: string }) => field.nodeId === "8" || field.fieldName === "config")).toBe(false);
    expect(body).not.toHaveProperty("workflow");
    expect(runtime).toEqual(before);
    expect(workflow.template!["8"].inputs).toEqual({ "ref_images.image0": ["1", 0], "ref_images.image1": ["1", 0] });
  });
  it("sends an actual uploaded media override without changing original sample values", () => {
    const source = selectedDefinition(); source.runninghub!.billingMode = "consumer";
    source.inputSlots = [{ semantic: "image", label: "Reference", kind: "image", required: false }];
    const runtime = structuredClone(source.template!); runtime["1"].inputs.image = "openapi/user-uploaded.png";
    expect(runningHubNodeInfoList(runtime, source)).toContainEqual({ nodeId: "1", fieldName: "image", fieldValue: "openapi/user-uploaded.png" });
    expect(source.template!["1"].inputs.image).toBe("example.png");
  });
  it.each(["SHARED", "EXCLUSIVE", undefined])("refuses consumer workflow submission for account type %s", async apiType => {
    const source = selectedDefinition(); source.runninghub!.billingMode = "consumer";
    const workflow = await attachRunningHubExecutionContract(source);
    const fetcher = mockFetch(success({ apiType }));
    await expect(client(workflow).queuePrompt(workflow.template!, "consumer-block")).rejects.toThrow("不是 NORMAL");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/uc/openapi/accountStatus");
  });
  it("keeps a failed account check before the submission boundary", async () => {
    const source = selectedDefinition(); source.runninghub!.billingMode = "consumer";
    const workflow = await attachRunningHubExecutionContract(source);
    const fetcher = mockFetch(response({ code: 401, msg: "invalid key" }));
    await expect(client(workflow).queuePrompt(workflow.template!, "consumer-account-failed")).rejects.toThrow("尚未提交任务");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("includes only mapped scalars and independent credentials without a changed-field fallback", () => {
    const workflow = selectedDefinition(), runtime = structuredClone(workflow.template!);
    runtime["2"].inputs.text = "User prompt";
    runtime["3"].inputs.seed = 99;
    runtime["9"].inputs.filename_prefix = "not-an-authorized-binding";
    runtime["7"].inputs.provider_api_key = "fixture-node-key";
    expect(runningHubNodeInfoList(runtime, workflow)).toEqual([
      { nodeId: "1", fieldName: "image", fieldValue: "example.png" },
      { nodeId: "2", fieldName: "text", fieldValue: "User prompt" },
      { nodeId: "7", fieldName: "provider_api_key", fieldValue: "fixture-node-key" },
    ]);
  });

  it.each([undefined, false, true])("sends full workflow JSON only for an explicit selected-mode override: %s", async includeWorkflowJson => {
    const source = selectedDefinition();
    if (includeWorkflowJson !== undefined) source.runninghub!.includeWorkflowJson = includeWorkflowJson;
    const workflow = await attachRunningHubExecutionContract(source), runtime = structuredClone(workflow.template!);
    runtime["1"].inputs.image = "openapi/user-image.png";
    runtime["2"].inputs.text = "User prompt";
    runtime["7"].inputs.provider_api_key = "fixture-node-key";
    const before = structuredClone(runtime), fetcher = mockFetch(success({ taskId: "selected-accepted", taskStatus: "QUEUED" }));
    await expect(client(workflow).queuePrompt(runtime, "selected-" + String(includeWorkflowJson))).resolves.toBe("selected-accepted");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(body).toMatchObject({ workflowId: source.runninghub!.workflowId, instanceType: "default", nodeInfoList: [
      { nodeId: "1", fieldName: "image", fieldValue: "openapi/user-image.png" },
      { nodeId: "2", fieldName: "text", fieldValue: "User prompt" },
      { nodeId: "7", fieldName: "provider_api_key", fieldValue: "fixture-node-key" },
    ] });
    if (includeWorkflowJson === true) expect(JSON.parse(body.workflow)).toEqual(before);
    else expect(body).not.toHaveProperty("workflow");
    expect(runtime).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an unselected scalar edit before either submission mode reaches transport", async () => {
    const fetcher = mockFetch();
    for (const includeWorkflowJson of [false, true]) {
      const source = selectedDefinition(); source.runninghub!.includeWorkflowJson = includeWorkflowJson;
      const workflow = await attachRunningHubExecutionContract(source), runtime = structuredClone(workflow.template!);
      runtime["3"].inputs.seed = 99;
      await expect(client(workflow).queuePrompt(runtime, "unselected-seed")).rejects.toMatchObject({ status: "failed", message: expect.stringContaining("未选字段") });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains the legacy full JSON path when an old record has no selected binding marker", async () => {
    const workflow = structuredClone(definition); workflow.runninghub!.includeWorkflowJson = false;
    const fetcher = mockFetch(success({ taskId: "legacy-json-accepted" }));
    await expect(client(workflow).queuePrompt(workflow.template!, "legacy-json-path")).resolves.toBe("legacy-json-accepted");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(JSON.parse(body.workflow)).toEqual(workflow.template);
  });

  it("reads and verifies the entire remote template before an ID-only selected submission", async () => {
    const workflow = await attachRunningHubExecutionContract(selectedDefinition()), remote = structuredClone(workflow.template!);
    remote["7"].inputs.provider_api_key = "remote-author-example";
    const fetcher = mockFetch(await readResponse(remote), success({ taskId: "verified-selected-task" }));
    const c = client(workflow);
    await c.connect();
    await expect(c.queuePrompt(workflow.template!, "verified-selected")).resolves.toBe("verified-selected-task");
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(["/__canvas/workflow-reader", connection.baseUrl + "/task/openapi/create"]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toEqual({ environment: "runninghub-workflow", remote: { apiKey: token, baseUrl: connection.baseUrl, remoteId: workflow.runninghub!.workflowId } });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body))).not.toHaveProperty("workflow");
  });

  it("stops before submission when the remote template's unselected defaults changed", async () => {
    const workflow = await attachRunningHubExecutionContract(selectedDefinition()), remote = structuredClone(workflow.template!);
    remote["3"].inputs.steps = 99;
    const fetcher = mockFetch(await readResponse(remote)), c = client(workflow);
    await expect((async () => { await c.connect(); await c.queuePrompt(workflow.template!, "changed-remote"); })())
      .rejects.toMatchObject({ status: "failed", message: expect.stringContaining("重新读取并确认绑定") });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).not.toContain("/create");
  });

  it("retains an unreadable remote API's 810 error and never silently enables a full override", async () => {
    const workflow = await attachRunningHubExecutionContract(selectedDefinition());
    const fetcher = mockFetch(response({ code: "RUNNINGHUB_WORKFLOW_READ_FAILED", error: "RunningHub 读取失败（810）：WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" }, 409)), c = client(workflow);
    await expect((async () => { await c.connect(); await c.queuePrompt(workflow.template!, "unreadable-remote"); })())
      .rejects.toMatchObject({ status: "failed", message: expect.stringContaining("810") });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(workflow.runninghub!.includeWorkflowJson).toBeUndefined();
    expect(String(fetcher.mock.calls[0][0])).toBe("/__canvas/workflow-reader");
  });

  it("does not add a remote template read to the explicitly enabled full JSON override", async () => {
    const source = selectedDefinition(); source.runninghub!.includeWorkflowJson = true;
    const workflow = await attachRunningHubExecutionContract(source), fetcher = mockFetch();
    await expect(client(workflow).connect()).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains every public application scalar even when it is not a selected mapping", async () => {
    const workflow: WorkflowDefinition = { ...structuredClone(definition),
      template: { "1": { class_type: "RunningHubAppInput", inputs: { prompt: "User prompt", steps: 20 } }, "__rh_app_output": { class_type: "SaveImage", inputs: {} } },
      mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }],
      output: { nodeId: "__rh_app_output", field: "images", kind: "image" },
      runninghub: { ...definition.runninghub!, kind: "app", bindingMode: "selected", includeWorkflowJson: true },
    };
    const fetcher = mockFetch(success({ taskId: "public-app-accepted" }));
    await expect(client(workflow).queuePrompt(workflow.template!, "public-app-fields")).resolves.toBe("public-app-accepted");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(body.nodeInfoList).toEqual([{ nodeId: "1", fieldName: "prompt", fieldValue: "User prompt" }, { nodeId: "1", fieldName: "steps", fieldValue: 20 }]);
    expect(body).not.toHaveProperty("workflow");
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/task/openapi/ai-app/run");
  });
});

describe("RunningHub workflow and authentication contract", () => {
  it("normalizes official CN/global sites and rejects credential-bearing or foreign API endpoints", () => {
    expect(normalizeRunningHubBaseUrl("https://runninghub.cn/")).toBe(connection.baseUrl);
    expect(normalizeRunningHubBaseUrl("https://runninghub.ai/")).toBe("https://www.runninghub.ai");
    for (const value of ["http://runninghub.cn", "https://wrong.example", "https://runninghub.cn/path", "https://user:pass@runninghub.cn", "https://runninghub.cn?apiKey=secret", "https://runninghub.cn#x"]) expect(() => normalizeRunningHubBaseUrl(value)).toThrow("RunningHub");
  });

  it("rejects a partial old parser response instead of silently accepting it as an original read", async () => {
    mockFetch(success({ prompt: JSON.stringify(graph) }));
    await expect(client().getWorkflow("123")).rejects.toThrow("AIFISHER");
  });

  it("validates an API Key using lowercase apikey and Bearer, without putting secrets in URL", async () => {
    const fetcher = mockFetch(success({ currency: "CNY", apiType: "NORMAL" }));
    expect(await client().validateKey()).toEqual({ valid: true, currency: "CNY", apiType: "NORMAL" });
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/uc/openapi/accountStatus");
    const init = fetcher.mock.calls[0][1]!;
    expect(init.headers).toMatchObject({ Authorization: "Bearer " + token });
    expect(JSON.parse(String(init.body))).toEqual({ apikey: token });
  });

  it("reads the selected ID through the complete original local reader", async () => {
    const fetcher = mockFetch(await readResponse(graph));
    expect(await client().getWorkflow("9876543210")).toEqual(graph);
    expect(String(fetcher.mock.calls[0][0])).toBe("/__canvas/workflow-reader");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toEqual({ environment: "runninghub-workflow", remote: { apiKey: token, baseUrl: connection.baseUrl, remoteId: "9876543210" } });
    expect(fetcher.mock.calls[0][1]!.signal).toBeUndefined();
    expect(String(fetcher.mock.calls[0][0])).not.toContain(token);
  });

  it("rejects invalid workflow IDs and missing API Key before transport", async () => {
    const fetcher = mockFetch();
    await expect(client().getWorkflow("../../123")).rejects.toThrow("ID");
    await expect(client(definition, { token: "" }).validateKey()).rejects.toThrow("API Key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains upload server filename including its folder for workflow inputs", async () => {
    const fetcher = mockFetch(success({ fileName: "openapi/uploaded-reference.mp4", download_url: "https://cdn.example/input.mp4" }));
    expect(await client().uploadAsset(new Blob(["video"], { type: "video/mp4" }), "clip.mp4", "local-task-folder")).toEqual({ name: "uploaded-reference.mp4", subfolder: "openapi", type: "input", inputName: "openapi/uploaded-reference.mp4" });
    expect(String(fetcher.mock.calls[0][0])).toContain("/openapi/v2/media/upload/binary");
    const form = fetcher.mock.calls[0][1]!.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.has("image")).toBe(false);
    expect(new Headers(fetcher.mock.calls[0][1]!.headers).has("Content-Type")).toBe(false);
  });

  it("does not accept uploaded traversal paths", async () => {
    mockFetch(success({ fileName: "../outside.png" }));
    await expect(client().uploadAsset(new Blob(["image"]), "image.png", "local")).rejects.toThrow("相对路径");
  });

  it("forwards explicit cancellation to the original reader without a deadline", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => { init.signal?.throwIfAborted(); return success({}); }); vi.stubGlobal("fetch", fetcher);
    await expect(client().getWorkflow("123", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("RunningHub paid task safety", () => {
  it("keeps the workflow route and independent node credentials after a SHARED account check", async () => {
    const providerKey = "fixture-independent-provider-key";
    const template: ApiWorkflow = { ...structuredClone(graph),
      "7": { class_type: "ProviderTextAPI", inputs: { provider_api_key: "", prompt: "辅助提示词" } },
      "8": { class_type: "PreviewAny", inputs: { source: ["7", 0] } },
    };
    const workflow: WorkflowDefinition = { ...structuredClone(definition), template,
      mapping: [...definition.mapping, { semantic: "providerKey", nodeId: "7", field: "provider_api_key" }],
    };
    const built = structuredClone(template); built["7"].inputs.provider_api_key = providerKey;
    const original = structuredClone(workflow), submittedGraph = structuredClone(built);
    const fetcher = mockFetch(success({ remainCoins: "763", currency: "CNY", apiType: "SHARED" }), success({ taskId: "rh-independent-credentials", taskStatus: "QUEUED" }));
    const c = client(workflow);
    expect(await c.validateKey()).toMatchObject({ remainCoins: "763", apiType: "SHARED" });
    expect(await c.queuePrompt(built, "independent-credentials-request")).toBe("rh-independent-credentials");
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([connection.baseUrl + "/uc/openapi/accountStatus", connection.baseUrl + "/task/openapi/create"]);
    const init = fetcher.mock.calls[1][1]!, body = JSON.parse(String(init.body));
    expect(init.headers).toMatchObject({ Authorization: "Bearer " + token });
    expect(body).toEqual({ apiKey: token, workflowId: workflow.runninghub!.workflowId, instanceType: "default",
      nodeInfoList: [
        { nodeId: "1", fieldName: "image", fieldValue: "example.png" },
        { nodeId: "2", fieldName: "text", fieldValue: "example prompt" },
        { nodeId: "7", fieldName: "provider_api_key", fieldValue: providerKey },
      ], workflow: JSON.stringify(submittedGraph),
    });
    expect(JSON.parse(body.workflow)).toEqual(submittedGraph);
    expect(workflow).toEqual(original); expect(built).toEqual(submittedGraph);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("submits actual mapped and changed fields, keeping uploaded media paths and full linked graph", async () => {
    const built = structuredClone(graph); built["1"].inputs.image = "openapi/my-reference.png"; built["2"].inputs.text = "my prompt"; built["3"].inputs.seed = 93; built["9"].inputs.filename_prefix = "infinite-canvas/task/result";
    const fetcher = mockFetch(success({ taskId: "rh-task-1", taskStatus: "RUNNING" }));
    const c = client(); expect(await c.queuePrompt(built, "request-1")).toBe("rh-task-1");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(body.workflowId).toBe(definition.runninghub!.workflowId);
    expect(JSON.parse(body.workflow)).toEqual(built);
    expect(body.nodeInfoList).toEqual(expect.arrayContaining([{ nodeId: "1", fieldName: "image", fieldValue: "openapi/my-reference.png" }, { nodeId: "2", fieldName: "text", fieldValue: "my prompt" }, { nodeId: "3", fieldName: "seed", fieldValue: 93 }, { nodeId: "9", fieldName: "filename_prefix", fieldValue: "infinite-canvas/task/result" }]));
    expect(body.nodeInfoList.some((item: { fieldName: string }) => ["images", "positive", "steps"].includes(item.fieldName))).toBe(false);
    expect(await c.findSubmittedPrompt("request-1")).toBe("rh-task-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("includes mapped scalar values even when unchanged, and omits linked inputs", () => {
    expect(runningHubNodeInfoList(graph, definition)).toEqual([{ nodeId: "1", fieldName: "image", fieldValue: "example.png" }, { nodeId: "2", fieldName: "text", fieldValue: "example prompt" }]);
  });

  it("never sends a cloud workflow or a workflow belonging to the other RH site", async () => {
    const fetcher = mockFetch();
    await expect(client({ ...definition, runninghub: undefined }).queuePrompt(graph, "r")).rejects.toThrow("RunningHub 工作流");
    await expect(client({ ...definition, runninghub: { ...definition.runninghub!, baseUrl: "https://www.runninghub.ai" } }).queuePrompt(graph, "r")).rejects.toThrow("另一个站点");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry an uncertain submit or invent a recovery task", async () => {
    const fetcher = mockFetch(success({ taskStatus: "RUNNING" }));
    const c = client();
    await expect(c.queuePrompt(graph, "unknown-request")).rejects.toThrow("缺少 taskId");
    expect(await c.findSubmittedPrompt("unknown-request")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves an accepted ID if a response reports running code, without resubmission", async () => {
    const fetcher = mockFetch(response({ code: 804, data: { taskId: "known-rh-id" } }));
    const c = client();
    expect(await c.queuePrompt(graph, "recoverable-request")).toBe("known-rh-id");
    expect(await c.findSubmittedPrompt("recoverable-request")).toBe("known-rh-id");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not treat a running response without a task ID as a definite rejection", async () => {
    const fetcher = mockFetch(response({ code: 804, data: null }));
    try { await client().queuePrompt(graph, "unknown-running"); throw new Error("expected uncertain state"); } catch (error) {
      expect(error).not.toBeInstanceOf(ExecutionError); expect(String(error)).toContain("不会自动重新提交");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes explicit submit rejection from unknown network state and redacts credentials", async () => {
    mockFetch(response({ code: 803, msg: "wrong apiKey=" + token, data: null }));
    try { await client().queuePrompt(graph, "rejected"); throw new Error("expected rejection"); } catch (error) {
      expect(error).toBeInstanceOf(ExecutionError); expect(String(error)).not.toContain(token); expect((error as ExecutionError).details).not.toContain(token);
    }
    mockFetch(response({ apiKey: token, message: "Bearer " + token }, 500));
    try { await client().queuePrompt(graph, "uncertain"); throw new Error("expected rejection"); } catch (error) {
      expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(500); expect(String(error)).not.toContain(token); expect((error as ApiError).body).not.toContain(token);
    }
  });

  it("has no ComfyUI websocket or queue side effect on connect/disconnect", async () => {
    const fetcher = mockFetch();
    const c = client(); await c.connect(); c.disconnect();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("RunningHub progress, outputs and cancellation", () => {
  it("polls 804 without retrying create and imports media through the existing output collector", async () => {
    vi.useFakeTimers();
    const fetcher = mockFetch(response({ code: 804, msg: "running", data: { taskStatus: "RUNNING" } }), success([{ nodeId: "9", fileUrl: "https://cdn.example/output/result.png?signature=fixture", fileType: "png" }]));
    const states: Partial<TaskState>[] = [];
    const run = client().waitForCompletion("rh-id", state => states.push(state), new AbortController().signal, graph);
    await vi.advanceTimersByTimeAsync(3000);
    const history = await run, collected = collectWorkflowOutputs(history, definition);
    expect(collected.files).toEqual([{ filename: "result.png", subfolder: "", type: "output", url: "https://cdn.example/output/result.png?signature=fixture", sourceNodeId: "9" }]);
    expect(states.some(state => state.status === "generating")).toBe(true);
    expect(states.every(state => state.progress === undefined)).toBe(true);
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith("/task/openapi/outputs"))).toBe(true);
  });

  it("imports inline text results, and media/text from automatic output nodes", async () => {
    const w = { ...definition, output: { nodeId: "9", field: "*", kind: "text" as const } };
    mockFetch(success([{ nodeId: "9", text: "优化后的正文" }, { nodeId: "9", fileUrl: "https://cdn.example/voice.wav", fileType: "wav" }]));
    const history = await client(w).waitForCompletion("rh-text", () => {}, new AbortController().signal, graph);
    const result = collectWorkflowOutputs(history, w);
    expect(result.text).toBe("优化后的正文"); expect(result.files[0].url).toBe("https://cdn.example/voice.wav"); expect(result.fileKinds[outputKey(result.files[0])]).toBe("audio");
  });

  it("keeps explicit text fields textual when RH includes a duplicate TXT download", async () => {
    const w = { ...definition, output: { nodeId: "9", field: "text", kind: "text" as const } };
    mockFetch(success([{ nodeId: "9", text: "返回正文", fileUrl: "https://cdn.example/result.txt", fileType: "txt" }]));
    const history = await client(w).waitForCompletion("rh-text-with-file", () => {}, new AbortController().signal, graph);
    expect(collectWorkflowOutputs(history, w).text).toBe("返回正文");
  });

  it("keeps polling the original task past four empty terminal results until output appears", async () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    let reads = 0;
    const fetcher = vi.fn(async () => success(++reads <= 6
      ? { taskStatus: "SUCCESS", outputs: [] }
      : { taskStatus: "SUCCESS", outputs: [{ nodeId: "9", fileUrl: "https://cdn.example/after-six.png", fileType: "png" }] }));
    vi.stubGlobal("fetch", fetcher);
    const pending = client().waitForCompletion("empty-id", onState, new AbortController().signal, graph);
    await vi.runAllTimersAsync();
    const history = await pending;
    expect(history.outputs["9"].images?.[0].filename).toBe("after-six.png");
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: "saving", details: expect.stringContaining("等待结果地址") }));
  });

  it("lets the caller stop waiting after repeated empty terminal results", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => success({ taskStatus: "SUCCESS", outputs: [] }));
    vi.stubGlobal("fetch", fetcher);
    const pending = client().waitForCompletion("empty-until-abort", () => {}, controller.signal, graph);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetcher.mock.calls.length).toBeGreaterThan(4);
    controller.abort();
    await cancelled;
    const callsAfterAbort = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(callsAfterAbort);
  });

  it("accepts results that appear shortly after a terminal status", async () => {
    vi.useFakeTimers();
    const fetcher = mockFetch(
      success({ taskStatus: "SUCCESS" }),
      success({ taskStatus: "SUCCESS", outputs: [] }),
      success({ taskStatus: "SUCCESS", results: [{ nodeId: "9", fileUrl: "https://cdn.example/late.png", fileType: "png" }] }),
    );
    const pending = client().waitForCompletion("late-result", () => {}, new AbortController().signal, graph);
    await vi.runAllTimersAsync();
    const history = await pending;
    expect(history.outputs["9"].images?.[0].filename).toBe("late.png");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports RH failure with actual node and a redacted backend reason", async () => {
    mockFetch(response({ code: 805, msg: "failed", data: { failedReason: { node_id: "3", exception_message: "CUDA out of memory; apiKey=" + token } } }));
    try { await client().waitForCompletion("failed-id", () => {}, new AbortController().signal, graph); throw new Error("expected failure"); } catch (error) {
      expect(error).toBeInstanceOf(ExecutionError); expect((error as ExecutionError).execution?.nodeId).toBe("3"); expect(String(error)).toContain("CUDA out of memory"); expect(String(error)).not.toContain(token);
    }
  });

  it("uses the legacy status response when outputs do not expose a state", async () => {
    vi.useFakeTimers();
    const fetcher = mockFetch(success(null), success("QUEUED"), success([{ nodeId: "9", fileUrl: "https://cdn.example/a.png", fileType: "png" }]));
    const states: Partial<TaskState>[] = [], run = client().waitForCompletion("queued-id", state => states.push(state), new AbortController().signal, graph);
    await vi.advanceTimersByTimeAsync(3000); await run;
    expect(String(fetcher.mock.calls[1][0])).toContain("/task/openapi/status"); expect(states.some(state => state.status === "queued")).toBe(true);
  });

  it("stops polling when aborted and never cancels unrelated server tasks", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), fetcher = mockFetch(response({ code: 804, data: { taskStatus: "RUNNING" } }));
    const run = client().waitForCompletion("abort-id", () => {}, controller.signal, graph);
    const check = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await check;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out without submitting again", async () => {
    const fetcher = mockFetch();
    await expect(client(definition, { timeoutMinutes: 0 }).waitForCompletion("timeout-id", () => {}, new AbortController().signal, graph)).rejects.toThrow("不会自动重新提交");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("downloads a signed result URL without API Key, cookies or connection auth headers", async () => {
    const fetcher = mockFetch(new Response(new Blob(["image-data"])));
    expect(await (await client().getOutput({ filename: "result.png", url: "https://cdn.example/result.png?signature=fixture", type: "output" })).text()).toBe("image-data");
    expect(String(fetcher.mock.calls[0][0])).toBe("https://cdn.example/result.png?signature=fixture");
    const init = fetcher.mock.calls[0][1]!;
    expect(init.headers).toBeUndefined(); expect(init.credentials).toBe("omit"); expect(JSON.stringify(init)).not.toContain(token);
  });

  it("rejects invalid result URLs without exposing the API Key", async () => {
    const fetcher = mockFetch();
    for (const url of [undefined, "file:///etc/passwd", "https://user:pass@cdn.example/a.png", "data:image/png,foo"]) await expect(client().getOutput({ filename: "a.png", url })).rejects.toThrow("地址");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels only the supplied task ID using RunningHub's own cancel endpoint", async () => {
    const fetcher = mockFetch(success(null));
    await client().cancel("rh-cancel-1");
    expect(String(fetcher.mock.calls[0][0])).toBe(connection.baseUrl + "/task/openapi/cancel");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toEqual({ apiKey: token, taskId: "rh-cancel-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
