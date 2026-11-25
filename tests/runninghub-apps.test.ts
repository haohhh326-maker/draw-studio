import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Connection } from "../src/types";
import { ApiError, collectWorkflowOutputs, ExecutionError } from "../src/comfyui/client";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { isRunningHubReferenceNotFound, runningHubAppFromRead, RunningHubClient, validateRunningHubMediaInputs } from "../src/runninghub/client";
import { parseRunningHubReference, prepareRunningHubApp, prepareRunningHubWorkflow, runningHubAppGraph, runningHubAppMediaInputs, runningHubAppOutputNode } from "../src/runninghub/workflows";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { createRunningHubWebAppProjection } from "../vendor/aifisher/server/workflowRuntime/runningHubWebApp.js";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";

const baseUrl = "https://www.runninghub.cn", token = "fixture-runninghub-account-key";
const connection: Connection = { name: "RunningHub CN", baseUrl, token, authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 2 };
const options = { baseUrl, workflowId: "1234567890123456789", name: "自己的千问图像编辑", outputs: [{ nodeId: runningHubAppOutputNode, field: "files", kind: "image" as const }] };
const data = () => ({ webappName: "千问图像编辑", nodeInfoList: [
  { nodeId: "1", nodeName: "LoadImage", fieldName: "image", fieldValue: "sample.jpg", fieldType: "IMAGE", required: true, description: "参考图片" },
  { nodeId: "2", nodeName: "QwenEdit", fieldName: "prompt", fieldValue: "sample prompt", fieldType: "STRING", description: "修改内容" },
  { nodeId: "2", fieldName: "model", fieldValue: "qwen_image.safetensors", fieldType: "LIST", fieldData: '[["qwen_image.safetensors","other.safetensors"],{}]' },
  { nodeId: "3", fieldName: "seed", fieldValue: 9, fieldType: "INT", min: 0, max: 2147483647 },
] });
async function readSource(source: unknown = data()) {
  return await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: options.workflowId, source });
}
async function app(source: unknown = data()) { return runningHubAppFromRead(await readSource(source) as unknown as AifisherWorkflowReadResult); }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ok = (data: unknown) => response({ code: 0, msg: "success", data });
function fetches(...responses: Response[]) { const mock = vi.fn(async (_url: unknown, _init?: RequestInit) => { const result = responses.shift(); if (!result) throw new Error("unexpected fetch"); return result; }); vi.stubGlobal("fetch", mock); return mock; }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["v1", "v2"] as const)("explains %s balance rejection without resubmitting or fabricating a task ID", async apiVersion => {
  const workflow = prepareRunningHubApp(await app(), options).workflow;
  workflow.runninghub!.apiVersion = apiVersion;
  const fetcher = fetches(response(apiVersion === "v1"
    ? { code: 605, msg: "NOT_ENOUGH_BALANCE", data: null, apiKey: token }
    : { errorCode: "605", errorMessage: "NOT_ENOUGH_BALANCE", status: "FAILED", apiKey: token }));
  const client = new RunningHubClient(connection, crypto.randomUUID(), workflow);
  const graph = structuredClone(workflow.template!); graph["1"].inputs.image = "openapi/uploaded.png";
  const failure = await client.queuePrompt(graph, "balance-rejection").catch(error => error);
  expect(failure).toBeInstanceOf(ExecutionError);
  expect(failure.message).toContain("账户余额不足（605）");
  expect(failure.details).toContain("NOT_ENOUGH_BALANCE");
  expect(failure.message + failure.details).not.toContain(token);
  expect(await client.findSubmittedPrompt("balance-rejection")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("RunningHub AI app original reads and references", () => {
  it("recognizes app/workflow references without turning long IDs into numbers or crossing sites", () => {
    expect(parseRunningHubReference(options.workflowId, baseUrl)).toEqual({ id: options.workflowId });
    for (const [path, kind] of [["ai-detail", "app"], ["webapp", "app"], ["workflow", "workflow"], ["post", "workflow"]])
      expect(parseRunningHubReference(baseUrl + "/" + path + "/42", baseUrl)).toEqual({ id: "42", kind });
    expect(parseRunningHubReference(baseUrl + "/openapi/v2/run/ai-app/42", baseUrl)).toEqual({ id: "42", kind: "app", apiVersion: "v2" });
    expect(parseRunningHubReference(baseUrl + "/call-api/api-detail/42?apiType=4", baseUrl)).toEqual({ id: "42", kind: "app" });
    expect(() => parseRunningHubReference("https://www.runninghub.ai/ai-detail/42", baseUrl)).toThrow("中国站和国际站");
    expect(() => parseRunningHubReference(baseUrl + "/wrong?workflowId=42", baseUrl)).toThrow("ID");
    expect(() => prepareRunningHubWorkflow({}, { ...options, workflowId: baseUrl + "/ai-detail/42" })).toThrow();
  });

  it("recognizes language-prefixed official references without changing source kinds or sites", () => {
    for (const prefix of ["en", "zh-CN", "en-us"]) {
      expect(parseRunningHubReference(baseUrl + "/" + prefix + "/workflow/42", baseUrl)).toEqual({ id: "42", kind: "workflow" });
      expect(parseRunningHubReference(baseUrl + "/" + prefix + "/ai-detail/42?workflowId=99", baseUrl)).toEqual({ id: "42", kind: "app" });
      expect(parseRunningHubReference(baseUrl + "/" + prefix + "/webapp?webappId=42", baseUrl)).toEqual({ id: "42", kind: "app" });
    }
    expect(parseRunningHubReference("https://www.runninghub.ai/en/ai-detail/42", "https://runninghub.ai")).toEqual({ id: "42", kind: "app" });
    expect(() => parseRunningHubReference("https://www.runninghub.ai/en/workflow/42", baseUrl)).toThrow("不同");
    expect(() => parseRunningHubReference(baseUrl + "/en/openapi/v2/run/workflow/42", baseUrl)).toThrow("不会自动改用 V1");
    expect(() => parseRunningHubReference(baseUrl + "/en/call-api/api-detail/42?apiType=1", baseUrl)).toThrow("ID");
    expect(() => parseRunningHubReference("https://www.runninghub.cn.evil.example/en/ai-detail/42", baseUrl)).toThrow("站点");
  });

  it("uses exactly the original projection for primitive and object option values", async () => {
    const source = { appName: "原版选项", nodeInfoList: [
      { nodeId: "1", fieldName: "ratio", fieldType: "LIST", fieldValue: "16:9", options: ["original", "16:9", "9:16"] },
      { nodeId: "1", fieldName: "enabled", fieldType: "LIST", fieldValue: false, options: [{ label: "关", value: false }, { label: "开", value: true }] },
      { nodeId: "1", fieldName: "scale", fieldType: "LIST", fieldValue: 1, options: [0.5, 1, 2] },
      { nodeId: "1", fieldName: "name", fieldType: "LIST", fieldValue: "b", options: [{ label: "同名", value: "a" }, { label: "同名", value: "b" }] },
    ] };
    const before = structuredClone(source), read = await readSource(source), original = createRunningHubWebAppProjection(options.workflowId, source);
    expect(read.projection).toEqual(original);
    expect(source).toEqual(before);
    const converted = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult), workflow = prepareRunningHubApp(converted, options).workflow;
    for (const parameter of workflow.parameters) {
      const binding = read.parameterBindings!.find(binding => binding.key === parameter.key)!;
      const published = read.parameterBindingDto!.bindings.find((binding: { key: string }) => binding.key === parameter.key)!;
      expect(parameter.default).toBe(binding.control.defaultValue);
      expect(parameter.options).toEqual(published.control.options.map((option: { id: string }) => option.id));
      expect(parameter.options!.map(option => parameter.optionValues![option])).toEqual(binding.control.options);
    }
  });

  it("retains the original choice default policy without a second decoder", async () => {
    const source = { nodeInfoList: [
      { nodeId: "1", fieldName: "missing", fieldType: "LIST", options: ["a", "b"] },
      { nodeId: "1", fieldName: "unlisted", fieldType: "LIST", fieldValue: "legacy", options: ["a", "b"] },
    ] };
    const read = await readSource(source), original = createRunningHubWebAppProjection(options.workflowId, source);
    expect(read.projection).toEqual(original);
    expect(read.parameterBindings!.map(binding => binding.control.defaultValue)).toEqual(["a", "a"]);
  });

  it("keeps the original text limits and retains undecodable public fieldData without new decoding", async () => {
    const source = { nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "prompt ".repeat(12000), description: "details ".repeat(500), label: "prompt", fieldData: "{not-valid-json" }] };
    const read = await readSource(source), original = createRunningHubWebAppProjection(options.workflowId, source);
    expect(read.projection).toEqual(original);
    expect(read.runninghubSource?.rawInfo?.nodeInfoList[0].fieldData).toBe("{not-valid-json");
    expect(runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult).nodeInfoList[0].fieldValue).toBe(original.snapshot.fields[0].value);
  });

  it("requires a complete original reader result instead of accepting a hand-built app graph", () => {
    expect(() => prepareRunningHubApp({ apiVersion: "v1", nodeInfoList: [] }, options)).toThrow("AIFISHER");
    expect(() => runningHubAppGraph({ apiVersion: "v1", nodeInfoList: [] })).toThrow("AIFISHER");
  });

  it("keeps output type unconfirmed when the original projection only declares ANY", async () => {
    const source = await app(), workflow = prepareRunningHubApp(source, { ...options, outputs: undefined }).workflow;
    expect(source.outputKind).toBeUndefined();
    expect(workflow.output).toMatchObject({ nodeId: runningHubAppOutputNode, kind: "file", field: "*" });
  });

  it.each([
    { nodeId: "9", fieldName: "provider_api_key", fieldValue: "private-provider-key", fieldData: '["private-provider-key"]', description: "模型 API Key" },
    { nodeId: "9", fieldName: "value", fieldValue: "private-provider-key", fieldType: "PASSWORD" },
    { nodeId: "9", fieldName: "prompt", fieldValue: "private-provider-key", secret: true },
  ])("clears provider credentials and explicit secret defaults before the original projection: $fieldName", async field => {
    const read = await readSource({ nodeInfoList: [field] });
    expect(JSON.stringify(read)).not.toContain("private-provider-key");
    const converted = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    expect(converted.nodeInfoList[0]).toMatchObject({ fieldValue: "", secret: true });
    expect(converted.nodeInfoList[0].fieldData).toBeUndefined();
    const workflow = prepareRunningHubApp(converted, options).workflow;
    expect(workflow.parameters[0]).toMatchObject({ secret: true, default: "" });
  });

  it("keeps token counts as ordinary numeric controls", async () => {
    const converted = await app({ nodeInfoList: [{ nodeId: "1", fieldName: "token_count", fieldValue: 512, fieldType: "INT" }, { nodeId: "1", fieldName: "max_tokens", fieldValue: 2048, fieldType: "INT" }] });
    expect(converted.nodeInfoList.map(field => field.fieldValue)).toEqual([512, 2048]);
    expect(converted.nodeInfoList.every(field => !field.secret)).toBe(true);
  });

  it("uses the original numeric and boolean default behavior", async () => {
    const source = { nodeInfoList: [{ nodeId: "1", fieldName: "steps", fieldValue: "20", fieldType: "INT" }, { nodeId: "1", fieldName: "cfg", fieldValue: "3.5", fieldType: "FLOAT" }, { nodeId: "1", fieldName: "enabled", fieldValue: "false", fieldType: "BOOLEAN" }] };
    const read = await readSource(source), original = createRunningHubWebAppProjection(options.workflowId, source);
    expect(read.projection).toEqual(original);
    expect(runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult).nodeInfoList.map(field => field.fieldValue)).toEqual([20, 3.5, false]);
  });

  it.each(["cn", "ai"])("reads every published indexed option, toggle and numeric bound and sends each exact value on %s", async site => {
    const origin = "https://www.runninghub." + site, appId = "2037066655557226498";
    const menu = (values: (string | number | boolean)[]) => JSON.stringify(values.map((index, i) => ({ index, name: "option " + i })));
    const nodeInfoList = [
      { nodeId: "2", fieldName: "image", fieldType: "IMAGE", fieldValue: "None" },
      { nodeId: "3", fieldName: "file", fieldType: "VIDEO", fieldValue: "None" },
      { nodeId: "1", fieldName: "real_person_mode", fieldType: "BOOLEAN", fieldValue: "true" },
      { nodeId: "1", fieldName: "duration", fieldType: "LIST", fieldValue: "15", fieldData: menu(["4", "10", "15"]) },
      { nodeId: "1", fieldName: "ratio", fieldType: "LIST", fieldValue: "16:9", fieldData: menu(["adaptive", "16:9", "9:16"]) },
      { nodeId: "1", fieldName: "resolution", fieldType: "LIST", fieldValue: "720p", fieldData: menu(["480p", "720p", "native1080p"]) },
      { nodeId: "1", fieldName: "scale", fieldType: "FLOAT", fieldValue: "1.2", fieldData: '["FLOAT",{"min":0.5,"max":2,"step":0.1}]' },
      { nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "[authored prompt]" },
    ];
    const before = structuredClone(nodeInfoList);
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remote: { baseUrl: origin, remoteId: appId, apiKey: token } }, {
      fetcher: vi.fn(async (url, init) => {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe(origin);
        expect(parsed.pathname).toBe(site === "cn" ? "/api/webapp/apiCallDemo" : "/api/webapp/detail");
        expect(init?.method).toBe(site === "cn" ? "GET" : "POST");
        return ok(site === "cn" ? { name: "Indexed controls", nodeInfoList } : { id: appId, name: "Indexed controls", inputNodes: nodeInfoList });
      }),
    });
    expect(read.bindingCandidates).toHaveLength(nodeInfoList.length);
    expect(read.parameterBindings).toHaveLength(nodeInfoList.length);
    const source = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    const { workflow } = prepareRunningHubApp(source, { ...options, baseUrl: origin, workflowId: appId,
      outputs: [{ nodeId: runningHubAppOutputNode, field: "files", kind: "video" }] });
    expect(workflow.template?.["1"].inputs).toEqual({ real_person_mode: true, duration: "15", ratio: "16:9", resolution: "720p", scale: 1.2, prompt: "[authored prompt]" });
    const key = (field: string) => workflow.mapping.find(binding => binding.nodeId === "1" && binding.field === field)!.semantic;
    const ratio = workflow.parameters.find(parameter => parameter.key === key("ratio"))!;
    expect(ratio.options?.map(option => ratio.optionValues![option])).toEqual(["adaptive", "16:9", "9:16"]);
    expect(workflow.parameters.find(parameter => parameter.key === key("scale"))).toMatchObject({ min: 0.5, max: 2, step: 0.1 });
    const node = { data: { generation: { workflowId: workflow.id, prompt: "read all inputs", negativePrompt: "", taskId: null,
      params: { [ratio.key]: ratio.optionValues![ratio.options![2]] } } } } as CanvasNode;
    const prompt = buildWorkflow(workflow, node, [], {}).workflow;
    const fetcher = fetches(ok({ taskId: "read-complete", taskStatus: "RUNNING" }));
    await expect(new RunningHubClient({ ...connection, baseUrl: origin }, "field-parity", workflow).queuePrompt(prompt, "typed-values")).resolves.toBe("read-complete");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe(origin + "/task/openapi/ai-app/run");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).nodeInfoList).toEqual([
      { nodeId: "1", fieldName: "duration", fieldValue: "15" },
      { nodeId: "1", fieldName: "prompt", fieldValue: "read all inputs" },
      { nodeId: "1", fieldName: "ratio", fieldValue: "9:16" },
      { nodeId: "1", fieldName: "real_person_mode", fieldValue: true },
      { nodeId: "1", fieldName: "resolution", fieldValue: "720p" },
      { nodeId: "1", fieldName: "scale", fieldValue: 1.2 },
      { nodeId: "2", fieldName: "image", fieldValue: "None" },
      { nodeId: "3", fieldName: "file", fieldValue: "None" },
    ]);
    expect(nodeInfoList).toEqual(before);
  });

  it("preserves a published Unicode field through binding and submits its exact field name", async () => {
    const fieldName = "预设说话人", id = "613";
    const source = { appName: "TTS 字段", nodeInfoList: [
      { nodeId: id, fieldName, fieldType: "LIST", fieldValue: "Vivian",
        fieldData: '[{"name":"Vivian","index":"Vivian"},{"name":"Eric","index":"Eric"}]' },
      { nodeId: id, fieldName: "__proto__", fieldType: "STRING", fieldValue: "unsafe prototype" },
      { nodeId: id, fieldName: "nested.constructor", fieldType: "STRING", fieldValue: "unsafe property" },
      { nodeId: id, fieldName: "路径/unsafe", fieldType: "STRING", fieldValue: "unsafe path" },
    ] };
    const before = structuredClone(source), read = await readSource(source);
    const appSource = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    expect(appSource.nodeInfoList.map(field => field.fieldName)).toEqual([fieldName]);
    expect(read.projection?.snapshot.fields.map((field: { fieldName: string }) => field.fieldName)).toEqual([fieldName]);
    expect(read.workflow?.[id].inputs).toEqual({ [fieldName]: "Vivian" });
    expect(read.bindingCandidates).toEqual([expect.objectContaining({ nodeId: id, fieldName })]);
    const prepared = prepareRunningHubApp(appSource, { ...options, outputs: [{ nodeId: runningHubAppOutputNode, field: "files", kind: "audio" }] });
    const workflow = await attachRunningHubExecutionContract(prepared.workflow, appSource);
    const binding = workflow.mapping.find(item => item.nodeId === id && item.field === fieldName)!;
    const parameter = workflow.parameters.find(item => item.key === binding.semantic)!;
    expect(parameter.label).toBe(fieldName);
    expect(parameter.options?.map(option => parameter.optionValues![option])).toEqual(["Vivian", "Eric"]);
    const node = { data: { generation: { workflowId: workflow.id, prompt: "", negativePrompt: "", taskId: null,
      params: { [parameter.key]: "Eric" } } } } as CanvasNode;
    const graph = buildWorkflow(workflow, node, [], {}).workflow;
    const fetcher = fetches(ok({ taskId: "unicode-field", taskStatus: "RUNNING" }));
    await expect(new RunningHubClient(connection, "unicode-field", workflow).queuePrompt(graph, "unicode-field")).resolves.toBe("unicode-field");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).nodeInfoList).toEqual([{ nodeId: id, fieldName, fieldValue: "Eric" }]);
    expect(source).toEqual(before);
  });

  it("does not hide auth/server/network errors behind an app fallback", () => {
    expect(isRunningHubReferenceNotFound(new ApiError("missing", 404))).toBe(true);
    for (const error of [new ApiError("denied", 403), new ApiError("invalid", 401), new ApiError("server", 500), new Error("network"), new ExecutionError("not found")]) expect(isRunningHubReferenceNotFound(error)).toBe(false);
  });

  it("sends account credentials only in the local original reader POST body", async () => {
    const read = await readSource(), fetcher = fetches(response(read));
    const result = await new RunningHubClient(connection).getAiApp(options.workflowId);
    expect(result.reader?.upstream).toEqual(read.upstream);
    expect(String(fetcher.mock.calls[0][0])).toBe("/__canvas/workflow-reader");
    expect(String(fetcher.mock.calls[0][0])).not.toContain(token);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ environment: "runninghub-webapp", remote: { baseUrl, remoteId: options.workflowId, apiKey: token } });
    expect(fetcher.mock.calls[0][1]?.signal).toBeUndefined();
  });
});

describe("RunningHub AI app canvas bindings", () => {
  it("binds the original prompt, uploaded media, typed choices and seed without changing the source graph", async () => {
    const source = await app(), before = structuredClone(source), { workflow } = prepareRunningHubApp(source, options);
    expect(source).toEqual(before);
    expect(runningHubAppMediaInputs(source)).toEqual([{ nodeId: "1", field: "image", kind: "image", required: true, label: "参考图片" }]);
    expect(runningHubAppGraph(source)).toEqual(source.reader!.workflow);
    expect(workflow.runninghub).toMatchObject({ workflowId: options.workflowId, baseUrl, kind: "app", apiVersion: "v1", apiVersionSource: "platform" });
    expect(workflow.family).toBe("图像工具"); expect(workflow.mode).toBe("image-to-image");
    expect(workflow.output).toEqual(options.outputs[0]);
    const model = workflow.parameters.find(parameter => workflow.mapping.some(binding => binding.semantic === parameter.key && binding.field === "model"))!;
    expect(model).toMatchObject({ type: "select", default: "qwen_image.safetensors" });
    expect(model.options!.map(option => model.optionValues![option])).toEqual(["qwen_image.safetensors", "other.safetensors"]);
    const seed = workflow.parameters.find(parameter => parameter.sourceControl?.kind === "seed")!;
    const node = { id: "image", data: { generation: { prompt: "用户的新提示词", negativePrompt: "", params: { [seed.key]: 72 } } } } as CanvasNode;
    const built = buildWorkflow(workflow, node, [{ semantic: "slot:input1", asset: { id: "asset-1", kind: "image", name: "图.png" }, edgeId: "e" }] as Parameters<typeof buildWorkflow>[2], { "asset-1": "openapi/uploaded-name.png" });
    expect(built.workflow["1"].inputs.image).toBe("openapi/uploaded-name.png");
    expect(built.workflow["2"].inputs.prompt).toBe("用户的新提示词"); expect(built.workflow["3"].inputs.seed).toBe(72);
  });

  it("accepts explicit prompt and output selections from the original candidates", async () => {
    const source = await app({ nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "a" }, { nodeId: "2", fieldName: "text", fieldType: "STRING", fieldValue: "b" }] });
    for (const kind of ["image", "video", "audio", "text", "file"] as const) {
      const { workflow } = prepareRunningHubApp(source, { ...options, promptKey: "2.text", outputs: [{ nodeId: runningHubAppOutputNode, field: kind === "text" ? "text" : "files", kind }] });
      expect(workflow.output.kind).toBe(kind); expect(workflow.mapping).toContainEqual({ nodeId: "2", field: "text", semantic: "prompt" });
    }
    expect(prepareRunningHubApp(source, { ...options, promptKey: "" }).workflow.promptRequired).toBe(false);
  });

  it("isolates application/workflow identities and explicitly selected v2 protocol", async () => {
    const source = await app(), workflow = prepareRunningHubApp(source, { ...options, workflowId: baseUrl + "/openapi/v2/run/ai-app/42" }).workflow;
    expect(workflow.id).toContain("runninghub-app-"); expect(workflow.runninghub?.apiVersion).toBe("v2");
    expect(workflow.runninghub?.apiVersionSource).toBe("explicit");
    expect(() => prepareRunningHubApp(source, { ...options, workflowId: baseUrl + "/workflow/42" })).toThrow("工作流链接");
  });
});

describe("RunningHub optional app media contracts", () => {
  it.each(["", "none", "null"])("preserves the original declared optional empty sentinel %s", async emptyValue => {
    const source = await app({ nodeInfoList: [{ nodeId: "1", fieldName: "image", fieldType: "IMAGE", required: false, fieldValue: emptyValue }] });
    const { workflow } = prepareRunningHubApp(source, options);
    expect(workflow.template!["1"].inputs.image).toBe(emptyValue);
    expect(workflow.runninghub?.mediaInputs).toEqual([{ nodeId: "1", field: "image", required: false, emptyValue }]);
    const fetcher = fetches(ok({ taskId: "empty-media-task" }));
    await new RunningHubClient(connection, "optional", workflow).queuePrompt(workflow.template!, "empty-media");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).nodeInfoList).toContainEqual({ nodeId: "1", fieldName: "image", fieldValue: emptyValue });
  });

  it("does not invent a null media sentinel that the original projection did not declare", async () => {
    const source = await app({ nodeInfoList: [{ nodeId: "1", fieldName: "image", fieldType: "IMAGE", required: false, fieldValue: null }] });
    const { workflow } = prepareRunningHubApp(source, options);
    expect(workflow.runninghub?.mediaInputs?.[0]).not.toHaveProperty("emptyValue");
    const fetcher = fetches();
    await expect(new RunningHubClient(connection, "optional-null", workflow).queuePrompt(workflow.template!, "unknown-null")).rejects.toThrow("未公开空值规则");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves advertised empty options without using an example filename as the sentinel", async () => {
    const source = await app({ nodeInfoList: [
      { nodeId: "1", fieldName: "reference", fieldType: "STRING", fieldValue: "example.png", fieldData: { image_upload: true, required: false, options: ["none", "example.png"] } },
      { nodeId: "2", fieldName: "audio", fieldType: "AUDIO", fieldValue: "example.wav", fieldData: { required: false, default: "null" } },
      { nodeId: "3", fieldName: "video", fieldType: "VIDEO", fieldValue: "example.mp4", required: false },
    ] });
    const { workflow } = prepareRunningHubApp(source, options);
    expect(workflow.runninghub?.mediaInputs).toEqual([
      { nodeId: "1", field: "reference", required: false, emptyValue: "none" },
      { nodeId: "2", field: "audio", required: false, emptyValue: "null" },
      { nodeId: "3", field: "video", required: false },
    ]);
    const node = { id: "node", data: { generation: { prompt: "", params: {} } } } as CanvasNode;
    expect(() => buildWorkflow(workflow, node, [], {})).toThrow("未公开空值规则");
    const semantic = workflow.mapping.find(binding => binding.nodeId === "3" && binding.field === "video")!.semantic;
    const graph = buildWorkflow(workflow, node, [{ semantic, asset: { id: "video-asset", kind: "video", name: "video.mp4" }, edgeId: "e" }] as Parameters<typeof buildWorkflow>[2], { "video-asset": "openapi/uploaded.mp4" }).workflow;
    expect(graph["1"].inputs.reference).toBe("none"); expect(graph["2"].inputs.audio).toBe("null");
    expect(graph["3"].inputs.video).toBe("openapi/uploaded.mp4");
    expect(() => validateRunningHubMediaInputs(workflow, graph)).not.toThrow();
  });

  it("blocks undeclared optional empty media before a task request", async () => {
    const source = await app({ nodeInfoList: [{ nodeId: "1", fieldName: "image", fieldType: "IMAGE", fieldValue: "author-example.png", required: false }] });
    const { workflow } = prepareRunningHubApp(source, options), fetcher = fetches();
    const graph = structuredClone(workflow.template!); graph["1"].inputs.image = "";
    await expect(new RunningHubClient(connection, "optional-unknown", workflow).queuePrompt(graph, "unknown-empty")).rejects.toThrow("未公开空值规则");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("RunningHub app submission and original-task recovery", () => {
  it("checks a saved public schema using the original reader while ignoring changed examples and titles", async () => {
    const initial = { name: "Old title", nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "old example" }, { nodeId: "2", fieldName: "steps", fieldType: "INT", fieldValue: 10, min: 1, max: 30 }] };
    const source = await app(initial), workflow = await attachRunningHubExecutionContract(prepareRunningHubApp(source, options).workflow, source);
    const current = await readSource({ ...initial, name: "New title", nodeInfoList: [{ ...initial.nodeInfoList[1], fieldValue: 20 }, { ...initial.nodeInfoList[0], fieldValue: "new example" }] });
    const fetcher = fetches(response(current));
    await expect(new RunningHubClient(connection, "schema-same", workflow).connect()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("/__canvas/workflow-reader");
  });

  it("stops before a paid submission when the public schema changes", async () => {
    const source = await app(), workflow = await attachRunningHubExecutionContract(prepareRunningHubApp(source, options).workflow, source);
    const fetcher = fetches(response(await readSource({ ...data(), nodeInfoList: data().nodeInfoList.filter(field => field.fieldName !== "seed") })));
    const failure = await new RunningHubClient(connection, "schema-changed", workflow).connect().catch(error => error);
    expect(failure).toBeInstanceOf(ExecutionError); expect(failure.message).toContain("尚未提交任务");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][0])).toBe("/__canvas/workflow-reader");
  });

  it("checks local source integrity before even reading remote metadata", async () => {
    const source = await app(), workflow = await attachRunningHubExecutionContract(prepareRunningHubApp(source, options).workflow, source);
    workflow.template!["2"].class_type = "ChangedClass";
    const fetcher = fetches();
    await expect(new RunningHubClient(connection, "source-changed", workflow).connect()).rejects.toThrow("尚未提交任务");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never downgrades a saved unsupported v2 workflow to a v1 task endpoint", async () => {
    const graph = { "1": { class_type: "SyntheticImage", inputs: { prompt: "x" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph, remoteId: options.workflowId });
    const { workflow } = prepareRunningHubWorkflow(graph, { ...options, reader, outputs: [{ nodeId: "2", field: "images", kind: "image" }] });
    workflow.runninghub!.apiVersion = "v2";
    const fetcher = fetches();
    await expect(new RunningHubClient(connection, "workflow-v2", workflow).queuePrompt(workflow.template!, "unsupported")).rejects.toThrow("不会自动改用 V1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits v1 public fields without synthetic output nodes or a replacement workflow", async () => {
    const { workflow } = prepareRunningHubApp(await app(), options), graph = structuredClone(workflow.template!);
    graph["1"].inputs.image = "openapi/the-uploaded-name.png"; graph["2"].inputs.prompt = "the user's prompt";
    const fetcher = fetches(ok({ taskId: "app-task", taskStatus: "RUNNING" }));
    const client = new RunningHubClient(connection, "app-client", workflow);
    expect(await client.queuePrompt(graph, "original-request")).toBe("app-task");
    expect(String(fetcher.mock.calls[0][0])).toBe(baseUrl + "/task/openapi/ai-app/run");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ apiKey: token, webappId: options.workflowId }); expect(body.workflow).toBeUndefined(); expect(body.workflowId).toBeUndefined();
    expect(body.nodeInfoList).toHaveLength(4); expect(body.nodeInfoList).toContainEqual({ nodeId: "1", fieldName: "image", fieldValue: "openapi/the-uploaded-name.png" });
    expect(body.nodeInfoList.some((item: { nodeId: string }) => item.nodeId === runningHubAppOutputNode)).toBe(false);
    expect(await client.findSubmittedPrompt("original-request")).toBe("app-task");
  });

  it("submits and polls v2 using Bearer-only JSON and accepts outputs without original node IDs", async () => {
    const source = await app(), workflow = prepareRunningHubApp({ ...source, apiVersion: "v2" }, options).workflow;
    vi.useFakeTimers();
    const fetcher = fetches(response({ taskId: "v2-task", status: "QUEUED", errorCode: "" }), response({ taskId: "v2-task", status: "RUNNING", errorCode: "", results: [] }), response({ taskId: "v2-task", status: "SUCCESS", errorCode: "", results: [{ nodeId: "unexpected-real-platform-node", url: "https://cdn.example/generated.png", outputType: "png" }] }));
    const client = new RunningHubClient(connection, "v2-client", workflow);
    const graph = structuredClone(workflow.template!); graph["1"].inputs.image = "openapi/uploaded.png";
    expect(await client.queuePrompt(graph, "v2-request")).toBe("v2-task");
    expect(String(fetcher.mock.calls[0][0])).toBe(baseUrl + "/openapi/v2/run/ai-app/" + options.workflowId);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).apiKey).toBeUndefined();
    const states: string[] = [], run = client.waitForCompletion("v2-task", state => { if (state.status) states.push(state.status); }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000); const history = await run;
    expect(collectWorkflowOutputs(history, workflow).files[0]).toMatchObject({ filename: "generated.png", url: "https://cdn.example/generated.png" }); expect(states).toContain("generating");
    for (const call of fetcher.mock.calls.slice(1)) { expect(String(call[0])).toBe(baseUrl + "/openapi/v2/query"); expect(JSON.parse(String(call[1]?.body))).toEqual({ taskId: "v2-task" }); }
  });

  it("treats v1 code813 as queued and binds node-less app outputs", async () => {
    const workflow = prepareRunningHubApp(await app(), options).workflow;
    vi.useFakeTimers();
    fetches(response({ code: 813, data: null }), ok([{ fileUrl: "https://cdn.example/output.jpg", fileType: "jpg" }]));
    const states: string[] = [], client = new RunningHubClient(connection, "v1", workflow);
    const run = client.waitForCompletion("queued-task", state => { if (state.status) states.push(state.status); }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000);
    expect(collectWorkflowOutputs(await run, workflow).files[0].filename).toBe("output.jpg"); expect(states).toContain("queued");
  });

  it("keeps accepted v2 task IDs recoverable on malformed success and never resubmits", async () => {
    const source = await app(), workflow = prepareRunningHubApp({ ...source, apiVersion: "v2" }, options).workflow;
    const fetcher = fetches(response({ taskId: "accepted-id", status: "QUEUED", errorCode: "bad", errorMessage: token }));
    const client = new RunningHubClient(connection, "v2-recover", workflow), graph = structuredClone(workflow.template!); graph["1"].inputs.image = "openapi/uploaded.png";
    await expect(client.queuePrompt(graph, "accepted-request")).rejects.not.toThrow(token);
    expect(await client.findSubmittedPrompt("accepted-request")).toBe("accepted-id"); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports v2 backend errors on the original task with credentials redacted", async () => {
    const source = await app(), workflow = prepareRunningHubApp({ ...source, apiVersion: "v2" }, options).workflow;
    fetches(response({ taskId: "failed-task", status: "FAILED", errorCode: "500", errorMessage: "bad apiKey=" + token }));
    try { await new RunningHubClient(connection, "v2-failed", workflow).waitForCompletion("failed-task", () => {}, new AbortController().signal); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(ExecutionError); expect(String(error)).toContain("bad"); expect(String(error)).not.toContain(token); expect((error as ExecutionError).details).not.toContain(token); }
  });
});
