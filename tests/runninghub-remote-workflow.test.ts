import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiWorkflow, CanvasNode } from "../src/types";
import { readRunningHubWorkflowFixture } from "./runninghub-test-reader";
import { readRunningHubRemoteWorkflow, prepareRunningHubRemoteWorkflow, remoteWorkflowPromptChoices } from "../src/runninghub/remote-workflow";
import { buildWorkflow } from "../src/workflow-adapter/adapter";

const site = "https://www.runninghub.cn", id = "2115791287499706370";
const fixture = (): ApiWorkflow => ({
  "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
  "2": { class_type: "CustomEdit", inputs: { image: ["1", 0], prompt: "example prompt", seed: 123, model_name: "model.safetensors" } },
  "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "keep-original" } },
});
afterEach(() => vi.restoreAllMocks());

describe("remote RunningHub ComfyUI reference imports", () => {
  it("reads an existing ID and stores only a remote API execution definition, with an unchanged original graph", async () => {
    const source = fixture(), before = structuredClone(source);
    await readRunningHubWorkflowFixture(source);
    const client = { getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => ({ name: "Remote image workflow" })) };
    const controller = new AbortController();
    const draft = await readRunningHubRemoteWorkflow(client, `${site}/workflow/${id}`, site, controller.signal);
    expect(client.getWorkflow).toHaveBeenCalledExactlyOnceWith(id, controller.signal);
    expect(client.getWorkflowMetadata).toHaveBeenCalledExactlyOnceWith(id, "workflow", controller.signal);
    expect(draft.sourceUrl).toBe(`${site}/workflow/${id}`);
    expect(draft.outputs).toEqual([{ nodeId: "3", field: "images", kind: "image" }]);
    const prepared = await prepareRunningHubRemoteWorkflow(draft);
    expect(prepared.runninghub).toMatchObject({ workflowId: id, baseUrl: site, kind: "workflow", billingMode: "consumer", bindingMode: "selected", includeWorkflowJson: false });
    expect(prepared.runninghub?.executionContract).toBeDefined();
    expect(prepared.template).toEqual(before); expect(source).toEqual(before);
    expect(prepared.defaultPrompt).toBeUndefined(); expect(prepared.library).toBeUndefined(); expect(prepared.directory).toBeUndefined();
    expect(prepared.mapping).toContainEqual({ semantic: "prompt", nodeId: "2", field: "prompt" });
    expect(prepared.output).toEqual({ nodeId: "3", field: "images", kind: "image" });
  });

  it.each([`${site}/ai-detail/${id}`, `${site}/webapp/${id}`])("rejects the separate AI app entry before any network request: %s", async reference => {
    const client = { getWorkflow: vi.fn(), getWorkflowMetadata: vi.fn() };
    await expect(readRunningHubRemoteWorkflow(client, reference, site)).rejects.toThrow("AI 应用");
    expect(client.getWorkflow).not.toHaveBeenCalled(); expect(client.getWorkflowMetadata).not.toHaveBeenCalled();
  });

  it("does not query local model/node schemas, save files, or fetch any example media", async () => {
    const source = fixture(); await readRunningHubWorkflowFixture(source);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const client = { getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => { throw new Error("public card missing"); }) };
    const draft = await readRunningHubRemoteWorkflow(client, id, site);
    const workflow = await prepareRunningHubRemoteWorkflow(draft);
    expect(workflow.runninghub?.workflowId).toBe(id); expect(fetch).not.toHaveBeenCalled();
    expect(workflow.template?.["1"].inputs.image).toBe("example.png");
  });

  it("keeps unknown outputs explicit instead of inferring their type from an image input or title", async () => {
    const source = fixture(); source["3"] = { class_type: "PrivatePublisher", inputs: { source: ["2", 0] } };
    // The original reader does not publish this unknown output, so the import must not invent one.
    await readRunningHubWorkflowFixture(source);
    const draft = await readRunningHubRemoteWorkflow({ getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => ({})) }, id, site);
    expect(draft.outputs).toEqual([]);
    await expect(prepareRunningHubRemoteWorkflow(draft)).rejects.toThrow("未识别到输出");
  });

  it("honors cancellation even if the optional card lookup fails", async () => {
    const source = fixture(); await readRunningHubWorkflowFixture(source);
    const controller = new AbortController();
    const client = { getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => { controller.abort(); throw new Error("aborted"); }) };
    await expect(readRunningHubRemoteWorkflow(client, id, site, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("writes the main prompt to the positive conditioning branch when the negative text is listed first", async () => {
    const source: ApiWorkflow = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "authored negative conditioning" } },
      "2": { class_type: "PrimitiveString", inputs: { value: "authored positive example" } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: ["2", 0] } },
      "4": { class_type: "KSampler", inputs: { positive: ["3", 0], negative: ["1", 0], seed: 123 } },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "original-output" } },
    };
    const original = structuredClone(source);
    await readRunningHubWorkflowFixture(source);
    const client = { getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => ({})) };
    const draft = await readRunningHubRemoteWorkflow(client, id, site);
    expect(draft.promptKey).toBe(JSON.stringify(["2", "value"]));
    const workflow = await prepareRunningHubRemoteWorkflow(draft);
    const node = { data: { generation: { workflowId: workflow.id, prompt: "new main prompt", negativePrompt: "", params: {}, taskId: null } } } as CanvasNode;
    const request = buildWorkflow(workflow, node, [], {}).workflow;
    expect(request).toEqual({ ...original, "2": { class_type: "PrimitiveString", inputs: { value: "new main prompt" } } });
    expect(workflow.template).toEqual(original);
    expect(source).toEqual(original);
  });

  it("clears secondary positive/negative authored prompt defaults without mutating source text or model defaults", async () => {
    const source = fixture();
    source["2"].inputs.negative_prompt = "author negative example";
    source["4"] = { class_type: "CLIPTextEncode", inputs: { text: "author second prompt" } };
    const before = structuredClone(source);
    await readRunningHubWorkflowFixture(source);
    const draft = await readRunningHubRemoteWorkflow({ getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => ({})) }, id, site);
    const workflow = await prepareRunningHubRemoteWorkflow(draft);
    const parameterFor = (nodeId: string, field: string) => workflow.parameters.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === nodeId && mapping.field === field));
    expect(parameterFor("2", "negative_prompt")).toBeUndefined();
    expect(parameterFor("4", "text")).toBeUndefined();
    expect(parameterFor("2", "model_name")).toBeUndefined();
    expect(parameterFor("3", "filename_prefix")).toBeUndefined();
    expect(workflow.template).toEqual(before); expect(source).toEqual(before);
    const choices = remoteWorkflowPromptChoices(draft.reader);
    expect(choices.map(field => JSON.stringify([field.nodeId, field.field]))).toContain(draft.promptKey);
    expect(choices.some(field => field.field === "model_name" || field.field === "filename_prefix")).toBe(false);
  });

  it("selects and reopens either published text port when their legacy keys are identical", async () => {
    const source: ApiWorkflow = {
      "镜头": { class_type: "PromptText", inputs: { "配置.prompt": "甲" } },
      "镜头.配置": { class_type: "PromptText", inputs: { prompt: "乙" } },
      generate: { class_type: "ImageGenerator", inputs: { scene: ["镜头", 0], prompt: ["镜头.配置", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["generate", 0] } },
    };
    const original = structuredClone(source);
    await readRunningHubWorkflowFixture(source);
    const client = { getWorkflow: vi.fn(async () => source), getWorkflowMetadata: vi.fn(async () => ({})) };
    const draft = await readRunningHubRemoteWorkflow(client, id, site);
    const choices = remoteWorkflowPromptChoices(draft.reader);
    const pairs = [["镜头", "配置.prompt"], ["镜头.配置", "prompt"]] as const;
    expect(choices.map(field => [field.nodeId, field.field])).toEqual(expect.arrayContaining(pairs));
    await expect(prepareRunningHubRemoteWorkflow({ ...draft, promptKey: "镜头.配置.prompt" })).rejects.toThrow("唯一文本参数");
    for (const [nodeId, field] of pairs) {
      const promptKey = JSON.stringify([nodeId, field]);
      const workflow = await prepareRunningHubRemoteWorkflow({ ...draft, promptKey });
      expect(workflow.mapping.filter(item => item.semantic === "prompt")).toEqual([{ semantic: "prompt", nodeId, field }]);
      expect((await readRunningHubRemoteWorkflow(client, id, site, undefined, workflow)).promptKey).toBe(promptKey);
      const canvas = { data: { generation: { workflowId: workflow.id, prompt: "画布提示词", negativePrompt: "", params: {}, taskId: null } } } as CanvasNode;
      const expected = structuredClone(original);
      expected[nodeId].inputs[field] = "画布提示词";
      expect(buildWorkflow(workflow, canvas, [], {}).workflow).toEqual(expected);
      expect(workflow.template).toEqual(original);
    }
    expect(source).toEqual(original);
  });
});
