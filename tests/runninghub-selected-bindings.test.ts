import { readRunningHubWorkflowFixture, withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode, WorkflowDefinition } from "../src/types";
import { prepareRunningHubApp, prepareRunningHubWorkflow, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";
import { selectRunningHubBindings, selectedRunningHubParameterValues } from "../src/runninghub/selected-bindings";
import { applyWorkflowCredentials, detectWorkflowCredentials } from "../src/workflow/credentials";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
const options = { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn", name: "Selected bindings", promptKey: "generator.prompt" };
const graph = (): ApiWorkflow => ({
    image: { class_type: "LoadImage", inputs: { image: "author-reference.png" } },
    generator: { class_type: "ImageGenerator", inputs: { image: ["image", 0], prompt: "author prompt", seed: 17, steps: 24, internal_control: "keep", model_name: "model.safetensors" } },
    save: { class_type: "SaveImage", inputs: { images: ["generator", 0], filename_prefix: "original" } },
});
const candidate = async () => prepareRunningHubWorkflowCandidates(graph(), await withRunningHubWorkflowReader(graph(), options)).workflow;
function keyFor(workflow: WorkflowDefinition, nodeId: string, field: string) {
    const key = workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field)?.semantic;
    if (!key)
        throw new Error("Fixture binding missing");
    return key;
}
describe("RunningHub selected execution bindings", () => {
    it("retains all candidates separately and saves only selected parameter bindings with the full source", async () => {
        const source = graph(), before = structuredClone(source), all = prepareRunningHubWorkflowCandidates(source, await withRunningHubWorkflowReader(source, options)).workflow;
        const internal = keyFor(all, "generator", "internal_control"), steps = keyFor(all, "generator", "steps");
        expect(all.parameters.some(parameter => parameter.key === internal)).toBe(true);
        const signed = await attachRunningHubExecutionContract(all), signedBefore = structuredClone(signed);
        const selected = selectRunningHubBindings(signed, [steps, steps, "missing-key"]);
        expect(selected.parameters.map(parameter => parameter.key)).toEqual([steps]);
        expect(selected.mapping).toEqual(all.mapping.filter(mapping => ["prompt", "slot:input1", steps].includes(mapping.semantic)));
        expect(selected.mapping.filter(mapping => !["prompt", "slot:input1"].includes(mapping.semantic)).map(mapping => mapping.semantic)).toEqual([steps]);
        expect(selected.runninghub).toMatchObject({ bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: [steps] });
        expect(selected.runninghub!.executionContract).toBeUndefined();
        expect(selected.template).toEqual(before);
        expect(source).toEqual(before);
        expect(signed).toEqual(signedBefore);
    });
    it("keeps every upstream parameter by default, honors stored choices and permits no optional controls", async () => {
        const all = await candidate(), seed = keyFor(all, "generator", "seed"), steps = keyFor(all, "generator", "steps"), internal = keyFor(all, "generator", "internal_control");
        const prepared = prepareRunningHubWorkflow(graph(), await withRunningHubWorkflowReader(graph(), options)).workflow;
        expect(prepared.parameters.map(parameter => parameter.key)).toEqual(all.parameters.map(parameter => parameter.key));
        expect(prepared.parameters.map(parameter => parameter.key)).toEqual(expect.arrayContaining([seed, steps, internal]));
        all.runninghub!.canvasParameterKeys = [internal];
        expect(selectRunningHubBindings(all).parameters.map(parameter => parameter.key)).toEqual([internal]);
        const empty = selectRunningHubBindings(all, []);
        expect(empty.parameters).toEqual([]);
        expect(empty.mapping.map(mapping => mapping.semantic)).toEqual(["prompt", "slot:input1"]);
        expect(empty.template).toEqual(graph());
    });
    it("keeps declared text, negative prompt and independent credential routes while cleaning author secrets", async () => {
        const all = await candidate();
        all.template!.generator.inputs.negative_prompt = "negative example";
        all.template!.generator.inputs.extra_text = "text example";
        all.template!.generator.inputs.api_key = "author-secret";
        all.template!.generator.inputs.private_auth = "explicit-author-secret";
        all.parameters.push({ key: "negativePrompt", label: "Negative", type: "text", default: "negative example" }, { key: "slot:text1", label: "Text", type: "text", default: "", inputText: true, required: true }, { key: "providerKey", label: "Provider Key", type: "text", default: "author-secret", secret: true });
        all.mapping.push({ semantic: "negativePrompt", nodeId: "generator", field: "negative_prompt" }, { semantic: "slot:text1", nodeId: "generator", field: "extra_text" }, { semantic: "providerKey", nodeId: "generator", field: "api_key" });
        all.credentials = [{ id: "separate-auth", nodeId: "generator", field: "private_auth", label: "Separate auth", required: true }];
        const selected = selectRunningHubBindings(all, []);
        expect(selected.parameters.map(parameter => parameter.key)).toEqual(["negativePrompt", "slot:text1", "providerKey"]);
        expect(selected.mapping.map(mapping => mapping.semantic)).toEqual(["prompt", "slot:input1", "negativePrompt", "slot:text1", "providerKey"]);
        expect(detectWorkflowCredentials(selected).map(field => field.id)).toEqual(["generator:api_key", "separate-auth"]);
        expect(JSON.stringify(selected)).not.toContain("author-secret");
        const runtime = applyWorkflowCredentials(selected, { "generator:api_key": "own-node-key", "separate-auth": "own-extra-key" });
        expect(runtime.template!.generator.inputs.api_key).toBe("own-node-key");
        expect(runtime.template!.generator.inputs.private_auth).toBe("own-extra-key");
        expect(selected.template!.generator.inputs.api_key).toBe("");
    });
    it("keeps PrimitiveString credential sources without exposing their source value as a normal control", async () => {
        const source = graph();
        source.key = { class_type: "PrimitiveString", inputs: { value: "author-primitive-key" } };
        source.generator.inputs.api_key = ["key", 0];
        const selected = prepareRunningHubWorkflow(source, await withRunningHubWorkflowReader(source, { ...options, promptKey: "generator.prompt", canvasParameterKeys: [] })).workflow;
        expect(selected.parameters).toEqual([expect.objectContaining({ secret: true, default: "" })]);
        expect(selected.template!.key.inputs.value).toBe("");
        expect(selected.template!.generator.inputs.api_key).toEqual(["key", 0]);
        expect(detectWorkflowCredentials(selected)).toMatchObject([{ nodeId: "key", field: "value", parameterKey: selected.parameters[0].key }]);
    });
    it("whitelists current selected values and cannot reapply an old hidden scalar override", async () => {
        const all = await candidate(), steps = keyFor(all, "generator", "steps"), internal = keyFor(all, "generator", "internal_control");
        const selected = selectRunningHubBindings(all, [steps]);
        const params = { [steps]: 40, [internal]: "old override", removed: 99 }, before = { ...params };
        expect(selectedRunningHubParameterValues(selected, params)).toEqual({ [steps]: 40 });
        const node = { data: { generation: { prompt: "Own prompt", negativePrompt: "", params, taskId: null } } } as CanvasNode;
        const inputs = [{ semantic: "slot:input1", asset: { id: "reference", kind: "image", name: "reference.png" }, edgeId: "reference" }] as Parameters<typeof buildWorkflow>[2];
        const built = buildWorkflow(selected, node, inputs, { reference: "uploaded.png" });
        expect(built.workflow.generator.inputs.steps).toBe(40);
        expect(built.workflow.generator.inputs.internal_control).toBe("keep");
        expect(params).toEqual(before);
        for (const workflow of [all, { ...all, runninghub: undefined }]) {
            const copy = selectedRunningHubParameterValues(workflow, params);
            expect(copy).toEqual(params);
            expect(copy).not.toBe(params);
        }
    });
    it("preserves an explicit whole-JSON deployment choice when rebinding an existing definition", async () => {
        const all = await candidate();
        all.runninghub!.includeWorkflowJson = true;
        expect(selectRunningHubBindings(all, []).runninghub!.includeWorkflowJson).toBe(true);
        expect(() => selectRunningHubBindings({ ...all, runninghub: undefined }, [])).toThrow("RunningHub");
    });
    it("rejects omitting a detected full-workflow media port instead of running author sample media", async () => {
        await expect((async () => prepareRunningHubWorkflow(graph(), await withRunningHubWorkflowReader(graph(), { ...options, mediaInputs: [] })))()).rejects.toThrow("素材输入不能取消绑定");
        const prepared = prepareRunningHubWorkflow(graph(), await withRunningHubWorkflowReader(graph(), { ...options, mediaInputs: [{ nodeId: "image", field: "image", kind: "image", required: false }], canvasParameterKeys: [] })).workflow;
        expect(prepared.inputSlots).toEqual([expect.objectContaining({ semantic: "slot:input1", kind: "image", required: false })]);
    });
    it("keeps every published app field and rejects omission of even optional media", async () => {
        const app = { outputKind: "image" as const, apiVersion: "v1" as const, nodeInfoList: [
                { nodeId: "1", fieldName: "prompt", fieldValue: "example" },
                { nodeId: "2", fieldName: "opaque_business", fieldValue: "", required: true },
                { nodeId: "3", fieldName: "image", fieldValue: "sample.jpg", fieldType: "IMAGE", required: false, mediaEmptyValue: "none" },
                { nodeId: "4", fieldName: "api_key", fieldValue: "author-app-key", secret: true },
            ] };
        const prepared = prepareRunningHubApp(await withRunningHubAppReader(app), { ...options, promptKey: "1.prompt", canvasParameterKeys: [] }).workflow;
        const ordinary = keyFor(prepared, "2", "opaque_business"), apiKey = keyFor(prepared, "4", "api_key");
        expect(prepared.runninghub).toMatchObject({ bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: [ordinary] });
        expect(prepared.parameters).toMatchObject([{ key: ordinary, required: true }, { key: apiKey, secret: true, default: "" }]);
        expect(prepared.mapping).toHaveLength(4);
        expect(prepared.template!["3"].inputs.image).toBe("sample.jpg");
        expect(JSON.stringify(prepared)).not.toContain("author-app-key");
        await expect((async () => prepareRunningHubApp(await withRunningHubAppReader(app), { ...options, mediaInputs: [] }))()).rejects.toThrow("素材输入不能取消绑定");
        await expect((async () => prepareRunningHubApp(await withRunningHubAppReader(app), { ...options, mediaInputs: [{ nodeId: "3", field: "image", kind: "video", required: false }] }))()).rejects.toThrow("类型和必填要求不能修改");
        await expect((async () => prepareRunningHubApp(await withRunningHubAppReader(app), { ...options, mediaInputs: [{ nodeId: "3", field: "image", kind: "image", required: true }] }))()).rejects.toThrow("类型和必填要求不能修改");
        expect(app.nodeInfoList[3].fieldValue).toBe("author-app-key");
    });
});
