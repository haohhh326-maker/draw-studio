import { readRunningHubWorkflowFixture, withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode } from "../src/types";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { parseRunningHubWorkflowReference, prepareRunningHubWorkflow, runningHubWorkflowId, runningHubWorkflowsForSite } from "../src/runninghub/workflows";
const cn = "https://www.runninghub.cn", ai = "https://www.runninghub.ai";
const options = { workflowId: "1234567890123456789", baseUrl: cn, name: "我的图像工作流", promptKey: "2.prompt" };
function fixture(): ApiWorkflow {
    return {
        "1": { class_type: "LoadImage", inputs: { image: "platform-source.png" } },
        "2": { class_type: "CustomEdit", inputs: { image: ["1", 0], prompt: "平台示例提示词", seed: 17, steps: 12, model_name: "qwen_image.safetensors" } },
        "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "platform/original" } },
    };
}
describe("RunningHub workflow identifiers and sites", () => {
    it("keeps long IDs as strings and accepts the configured site's share link", () => {
        expect(parseRunningHubWorkflowReference(" 1234567890123456789 ", cn)).toBe("1234567890123456789");
        expect(parseRunningHubWorkflowReference("https://runninghub.cn/workflow/1234567890123456789", cn)).toBe("1234567890123456789");
        expect(parseRunningHubWorkflowReference("https://www.runninghub.ai/workflow/42?from=share", ai)).toBe("42");
        expect(parseRunningHubWorkflowReference("https://www.runninghub.cn/workflow?workflowId=42", cn)).toBe("42");
    });
    it("rejects cross-site links, unrelated sites, credentials and malformed IDs", () => {
        expect(() => parseRunningHubWorkflowReference("https://www.runninghub.ai/workflow/42", cn)).toThrow("中国站和国际站");
        expect(() => parseRunningHubWorkflowReference("https://example.com/workflow/42", cn)).toThrow("支持的 RunningHub");
        expect(() => parseRunningHubWorkflowReference("https://key@www.runninghub.cn/workflow/42", cn)).toThrow("账号");
        for (const value of ["abc", "0.5", "https://www.runninghub.cn/workflow/no-id", "http://www.runninghub.cn/workflow/42"])
            expect(() => parseRunningHubWorkflowReference(value, cn)).toThrow();
    });
    it("isolates same-numbered workflows by site and never includes the cloud directory", async () => {
        const china = prepareRunningHubWorkflow(fixture(), await withRunningHubWorkflowReader(fixture(), options)).workflow;
        const international = prepareRunningHubWorkflow(fixture(), await withRunningHubWorkflowReader(fixture(), { ...options, baseUrl: ai })).workflow;
        const cloud = { ...china, id: "cloud-original", runninghub: undefined };
        expect(china.id).not.toBe(international.id);
        expect(runningHubWorkflowId("https://runninghub.cn/", options.workflowId)).toBe(china.id);
        expect(runningHubWorkflowsForSite([cloud, china, international], cn)).toEqual([china]);
        expect(runningHubWorkflowsForSite([cloud, china, international], ai)).toEqual([international]);
    });
});
describe("RunningHub canvas workflow bindings", () => {
    it("binds prompt, image, seed and steps while preserving the deployed graph and its metadata", async () => {
        const source = fixture(), before = structuredClone(source);
        const reader = await readRunningHubWorkflowFixture(source);
        const seed = reader.parameterBindings!.find(binding => binding.target.nodeId === "2" && binding.target.fieldName === "seed")!.key;
        const steps = reader.parameterBindings!.find(binding => binding.target.nodeId === "2" && binding.target.fieldName === "steps")!.key;
        const { workflow } = prepareRunningHubWorkflow(source, { ...options, reader, canvasParameterKeys: [seed, steps], outputs: [{ nodeId: "3", field: "images", kind: "image" }] });
        expect(source).toEqual(before);
        expect(workflow.template).toEqual(before);
        expect(workflow.runninghub).toMatchObject({ workflowId: options.workflowId, baseUrl: cn, sourceFormat: "api-workflow", parameterSchemaVersion: 2, bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: [seed, steps] });
        expect(workflow.mapping).toContainEqual({ semantic: "prompt", nodeId: "2", field: "prompt" });
        expect(workflow.mapping).toContainEqual({ semantic: seed, nodeId: "2", field: "seed" });
        expect(workflow.mapping).toContainEqual({ semantic: "slot:input1", nodeId: "1", field: "image" });
        expect(workflow.parameters.find(parameter => parameter.key === steps)?.default).toBe(12);
        expect(workflow.defaultPrompt).toBeUndefined();
        expect(workflow.library).toBeUndefined();
        expect(workflow.directory).toBeUndefined();
        expect(workflow.template!["2"].inputs.model_name).toBe("qwen_image.safetensors");
        expect(workflow.runninghub?.sourceBindings).toEqual(reader.parameterBindings);
        expect(workflow.mediaInputMode).toBe("explicit");
        expect(workflow.output).toEqual({ nodeId: "3", field: "images", kind: "image" });
    });
    it("uses the existing adapter to write the user's prompt and uploaded media into original node fields", async () => {
        const { workflow } = prepareRunningHubWorkflow(fixture(), await withRunningHubWorkflowReader(fixture(), options));
        const seed = workflow.mapping.find(mapping => mapping.nodeId === "2" && mapping.field === "seed")!.semantic;
        const steps = workflow.mapping.find(mapping => mapping.nodeId === "2" && mapping.field === "steps")!.semantic;
        const node = { id: "canvas-image", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "图像 1", generation: { prompt: "我自己的提示词", negativePrompt: "", workflowId: workflow.id, params: { [seed]: 78, [steps]: 20 }, taskId: null } } } as CanvasNode;
        const built = buildWorkflow(workflow, node, [{ semantic: "slot:input1", asset: { id: "input-a", name: "素材.png", kind: "image" }, edgeId: "edge-a" }] as Parameters<typeof buildWorkflow>[2], { "input-a": "runninghub-upload.png" });
        expect(built.workflow["1"].inputs.image).toBe("runninghub-upload.png");
        expect(built.workflow["2"].inputs.prompt).toBe("我自己的提示词");
        expect(built.workflow["2"].inputs.seed).toBe(78);
        expect(built.workflow["2"].inputs.steps).toBe(20);
        expect(built.workflow["3"].inputs.filename_prefix).toBe("platform/original");
        expect(workflow.template?.["2"].inputs.prompt).toBe("平台示例提示词");
    });
    it("keeps PreviewImage as the real platform output without creating synthetic SaveImage nodes", async () => {
        const graph = fixture();
        graph["3"] = { class_type: "PreviewImage", inputs: { images: ["2", 0] } };
        const { workflow, warnings } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options));
        expect(workflow.template).toEqual(graph);
        expect(Object.keys(workflow.template!)).toEqual(["1", "2", "3"]);
        expect(workflow.output.nodeId).toBe("3");
        expect(warnings.some(warning => warning.includes("补充 SaveImage"))).toBe(false);
    });
    it("does not toggle platform save_output or discard other branches", async () => {
        const graph = fixture();
        graph["4"] = { class_type: "VHS_VideoCombine", inputs: { images: ["2", 0], save_output: false, filename_prefix: "keep-video" } };
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options));
        expect(workflow.template).toEqual(graph);
        expect(workflow.additionalOutputs).toEqual([expect.objectContaining({ nodeId: "4", field: "*", kind: "file", needsBinding: true })]);
        expect(workflow.template?.["4"].inputs.save_output).toBe(false);
    });
    it("requires an explicit contract for custom terminal outputs", async () => {
        const graph = fixture();
        graph["3"] = { class_type: "PrivatePublisher", inputs: { source: ["2", 0] } };
        await expect((async () => prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options)))()).rejects.toThrow("未识别到输出");
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { ...options, outputs: [{ nodeId: "3", field: "*", kind: "image" }] }));
        expect(workflow.output).toEqual({ nodeId: "3", field: "*", kind: "image" });
    });
    it("supports explicit main prompt but refuses to invent a custom loader contract missing from the original reader", async () => {
        const graph: ApiWorkflow = {
            "1": { class_type: "PrivateImageLoader", inputs: { file_path: "in.jpg" } },
            "2": { class_type: "CustomEdit", inputs: { source: ["1", 0], instruction: "示例", system_prompt: "保留系统规则" } },
            "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "original" } },
        };
        await expect((async () => prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { ...options, promptKey: "2.instruction", mediaInputs: [{ nodeId: "1", field: "file_path", kind: "image", required: true }] })))()).rejects.toThrow("必须来自 AIFISHER");
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { ...options, promptKey: "2.instruction" }));
        expect(workflow.mapping).toContainEqual({ semantic: "prompt", nodeId: "2", field: "instruction" });
        expect(workflow.inputSlots).toEqual([]);
        expect(workflow.mapping.some(mapping => mapping.nodeId === "2" && mapping.field === "system_prompt")).toBe(true);
        expect(workflow.template!["2"].inputs.system_prompt).toBe("保留系统规则");
        expect(workflow.template).toEqual(graph);
    });
    it("rejects broken graphs, input collisions and unavailable output targets with full diagnostics", async () => {
        const graph = fixture();
        graph["3"].inputs.images = ["missing-42", 0];
        await expect((async () => prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options)))()).rejects.toThrow("missing-42");
        await expect((async () => prepareRunningHubWorkflow(fixture(), await withRunningHubWorkflowReader(fixture(), { ...options, outputs: [{ nodeId: "missing-99", field: "images", kind: "image" }] })))()).rejects.toThrow("missing-99");
        await expect((async () => prepareRunningHubWorkflow(fixture(), await withRunningHubWorkflowReader(fixture(), { ...options, promptKey: "1.image", mediaInputs: [{ nodeId: "1", field: "image", kind: "image" }] })))()).rejects.toThrow("主提示词必须绑定");
    });
    it("does not silently convert editor JSON without the platform's schema", async () => {
        await expect((async () => prepareRunningHubWorkflow({ nodes: [{ id: 1, type: "CustomEdit", widgets_values: ["text"] }] }, await withRunningHubWorkflowReader({ nodes: [{ id: 1, type: "CustomEdit", widgets_values: ["text"] }] }, options)))()).rejects.toThrow("API Format");
    });
    it("keeps all declared output kinds including explicitly confirmed text output", async () => {
        const graph: ApiWorkflow = { "1": { class_type: "TextMaker", inputs: { prompt: "sample", seed: 1 } }, "2": { class_type: "TextPublisher", inputs: { source: ["1", 0] } } };
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { ...options, promptKey: "1.prompt", outputs: [{ nodeId: "2", field: "text", kind: "text" }] }));
        expect(workflow.mode).toBe("text-tool");
        expect(workflow.output.kind).toBe("text");
        expect(workflow.defaultPrompt).toBeUndefined();
    });
});
