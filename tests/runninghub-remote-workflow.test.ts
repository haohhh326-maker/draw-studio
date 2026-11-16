import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiWorkflow } from "../src/types";
import { readRunningHubWorkflowFixture } from "./runninghub-test-reader";
import { readRunningHubRemoteWorkflow, prepareRunningHubRemoteWorkflow, remoteWorkflowPromptChoices } from "../src/runninghub/remote-workflow";

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
    expect(choices.map(field => field.nodeId + "." + field.field)).toContain(draft.promptKey);
    expect(choices.some(field => field.field === "model_name" || field.field === "filename_prefix")).toBe(false);
  });
});
