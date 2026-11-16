import { readRunningHubWorkflowFixture, withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { describe, expect, it } from "vitest";
import type { ApiWorkflow } from "../src/types";
import type { RunningHubAiApp } from "../src/runninghub/client";
import { analyzeRunningHubImport, runningHubImportCredentialIdentities } from "../src/runninghub/import-analysis";
import { prepareRunningHubWorkflow, runningHubAppGraph, runningHubAppOutputNode } from "../src/runninghub/workflows";
import { analyzeWorkflowImport } from "../src/workflow/import-analyzer";
const app = (overrides: Partial<RunningHubAiApp> = {}): RunningHubAiApp => ({ apiVersion: "v1", outputKind: "image", nodeInfoList: [{ nodeId: "1", nodeName: "CLIPTextEncode", fieldName: "text", fieldType: "STRING", fieldValue: "清晨海边" }], ...overrides });
const videoWithPreviews = (): ApiWorkflow => ({
    "1": { class_type: "SyntheticVideoGenerator", inputs: { prompt: "test prompt", seed: 1 } },
    "21": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], save_output: false, filename_prefix: "test-video" } },
    "30": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
    "99": { class_type: "PreviewAny", inputs: { preview: "", source: ["1", 0] } },
});
describe("RunningHub canvas import analysis", () => {
    it("reads an app's public inputs without requiring its hidden ComfyUI graph", async () => {
        const source = app();
        const result = await readAnalysis(runningHubAppGraph(await withRunningHubAppReader(source)), source);
        expect(result.errors).toEqual([]);
        expect(result.prompts.map(field => [field.nodeId, field.field])).toEqual([["1", "text"]]);
        expect(result.outputs).toMatchObject([{ nodeId: runningHubAppOutputNode, kind: "image", field: "files" }]);
    });
    it("leaves unknown app outputs unconfirmed instead of guessing an image", async () => {
        const source = app({ outputKind: undefined });
        const result = await readAnalysis(runningHubAppGraph(await withRunningHubAppReader(source)), source);
        expect(result.outputs).toMatchObject([{ nodeId: runningHubAppOutputNode, kind: "file", field: "*" }]);
    });
    it("preserves typed optional media and keeps it out of the prompt", async () => {
        const source = app({ nodeInfoList: [
                { nodeId: "1", fieldName: "prompt", fieldValue: "海浪" },
                { nodeId: "2", fieldName: "image", fieldType: "IMAGE", fieldValue: "author-example.png", required: false },
                { nodeId: "3", fieldName: "audio", fieldType: "AUDIO", fieldValue: "author-example.wav", required: true },
            ] });
        const result = await readAnalysis(runningHubAppGraph(await withRunningHubAppReader(source)), source);
        expect(result.inputs).toMatchObject([{ nodeId: "2", kind: "image", required: false }, { nodeId: "3", kind: "audio", required: true }]);
        expect(result.prompts.map(field => field.field)).toEqual(["prompt"]);
    });
    it("keeps nullable optional media bindings and all published choice diagnostics", async () => {
        const source = await withRunningHubAppReader({ apiVersion: "v1", outputKind: "image", nodeInfoList: [
                { nodeId: "1", fieldName: "prompt", fieldValue: "海浪" },
                { nodeId: "2", fieldName: "image", fieldType: "IMAGE", fieldValue: null, required: false },
                { nodeId: "3", fieldName: "ratio", fieldType: "LIST", fieldData: { choices: ["16:9", "9:16"] } },
            ] } as RunningHubAiApp);
        const result = await readAnalysis(runningHubAppGraph(await withRunningHubAppReader(source)), source);
        expect(result.inputs).toMatchObject([{ nodeId: "2", field: "image", kind: "image", required: false }]);
        expect(result.prompts.map(field => field.field)).toEqual(["prompt"]);
        expect(result.warnings.join("\n")).toContain("INVALID_INPUT_VALUE");
        expect(result.errors).toEqual([]);
    });
    it("keeps all original text candidates with the original primary first", async () => {
        const source = app({ nodeInfoList: [{ nodeId: "1", fieldName: "text", fieldValue: "" }, { nodeId: "2", fieldName: "instruction", fieldValue: "" }] });
        const result = await readAnalysis(runningHubAppGraph(await withRunningHubAppReader(source)), source);
        expect(result.prompts).toHaveLength(2);
        expect(result.prompts[0]).toMatchObject({ nodeId: "1", field: "text" });
        expect(result.warnings).not.toContain("检测到多个提示词输入，请选择画布主提示词。");
    });
    it("does not invent missing required input declarations without the remote object_info", async () => {
        const graph: ApiWorkflow = { "1": { class_type: "SaveImage", inputs: {} } };
        const analysis = await readAnalysis(graph);
        expect(analysis.errors).toEqual([]);
        expect(analysis.outputs).toMatchObject([{ nodeId: "1", kind: "file", field: "*", needsBinding: true }]);
    });
    it("preserves the analyzer's validation result for a malformed full graph", async () => {
        await expect(readAnalysis(null as unknown as ApiWorkflow)).rejects.toThrow("JSON 对象");
    });
    it("exposes the final publisher without class-name media guesses and excludes auxiliary preview routes", async () => {
        const result = await readAnalysis(videoWithPreviews());
        expect(result.errors).toEqual([]);
        expect(result.outputs).toMatchObject([
            { nodeId: "21", kind: "file", field: "*" },
        ]);
        expect(result.outputs.every(output => output.needsBinding === true)).toBe(true);
        expect(result.warnings.join("\n")).not.toMatch(/ComfyUI|补充 SaveImage|执行副本/);
        expect(result.warnings.join("\n")).toContain("AIFISHER 未声明");
    });
    it("preserves the complete video workflow and its primary output when PreviewAny is present", async () => {
        const graph = videoWithPreviews(), before = structuredClone(graph);
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { workflowId: "123456789012345678", baseUrl: "https://www.runninghub.cn", name: "Video with previews", outputs: [
          { nodeId: "21", kind: "video", field: "gifs" }, { nodeId: "30", kind: "image", field: "images" }, { nodeId: "99", kind: "text", field: "text" }
        ] }));
        expect(workflow.output).toEqual({ nodeId: "21", kind: "video", field: "gifs" });
        expect(workflow.additionalOutputs).toEqual([
            { nodeId: "30", kind: "image", field: "images" },
            { nodeId: "99", kind: "text", field: "text" },
        ]);
        expect(workflow.template).toEqual(before);
        expect(graph).toEqual(before);
    });
    it("does not turn an inferred terminal helper into an extra canvas output beside recognized outputs", async () => {
        const graph = videoWithPreviews();
        graph["100"] = { class_type: "UnknownPublisher", inputs: { source: ["1", 0] } };
        const before = structuredClone(graph);
        const result = await readAnalysis(graph);
        expect(result.outputs.map(output => output.nodeId)).toEqual(["21"]);
        expect(result.warnings.join("\n")).not.toMatch(/UnknownPublisher|自定义输出将在执行后/);
        // Generic/local import retains its existing fallback; only RunningHub defaults change.
        expect(analyzeWorkflowImport(graph, undefined, undefined, undefined, true).outputs).toContainEqual(expect.objectContaining({ nodeId: "100", kind: "file", field: "*" }));
        expect(graph).toEqual(before);
    });
    it("preserves all source nodes when preparing recognized outputs with isolated internal helpers", async () => {
        const graph = videoWithPreviews();
        graph["100"] = { class_type: "InternalLLMConversion", inputs: { model_name: "qwen-helper", device: "cuda", settings: "helper configuration" } };
        const before = structuredClone(graph);
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { workflowId: "123456789012345678", baseUrl: "https://www.runninghub.cn", name: "Video with internal helper" }));
        expect(workflow.output.nodeId).toBe("21");
        expect(workflow.additionalOutputs).toBeUndefined();
        expect(workflow.template).toEqual(before);
        expect(graph).toEqual(before);
    });
    it("does not fabricate terminal outputs absent from the original analysis", async () => {
        const graph: ApiWorkflow = {
            "1": { class_type: "CustomGenerator", inputs: { seed: 1 } },
            "9": { class_type: "UnregisteredResultWriter", inputs: { source: ["1", 0] } },
        };
        const result = await readAnalysis(graph);
        expect(result.outputs).toEqual([]);
        await expect((async () => prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { workflowId: "123456789012345678", baseUrl: "https://www.runninghub.cn", name: "Custom output" })))()).rejects.toThrow("未识别到输出");
    });
    it.each([
        ["ModelSelector", "value", "qwen-helper"],
        ["DeviceSelector", "text", "cuda"],
        ["InternalConverter", "value", "float16"],
    ])("preserves the original first-text fallback for %s.%s without applying our role exclusion", async (classType, field, value) => {
        const graph: ApiWorkflow = {
            "1": { class_type: "CustomImageMaker", inputs: { seed: 1 } },
            "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
            "100": { class_type: classType, inputs: { [field]: value } },
        };
        const before = structuredClone(graph);
        const generic = analyzeWorkflowImport(graph, undefined, undefined, undefined, true);
        expect(generic.prompts).toEqual([expect.objectContaining({ nodeId: "100", field, value })]);
        const result = await readAnalysis(graph);
        expect(result.prompts).toEqual([expect.objectContaining({ nodeId: "100", field, value })]);
        expect(result.fields).toContainEqual(expect.objectContaining({ nodeId: "100", field, value }));
        expect(result.outputs.map(output => output.nodeId)).toEqual(["9"]);
        expect(graph).toEqual(before);
    });
    it.each([
        ["ModelSelector", "qwen-helper"],
        ["DeviceSelector", "cuda"],
    ])("uses the original %s first-text binding while keeping the complete authored source", async (classType, value) => {
        const graph: ApiWorkflow = {
            "1": { class_type: "CustomImageMaker", inputs: { seed: 1 } },
            "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
            "100": { class_type: classType, inputs: { text: value } },
        };
        const before = structuredClone(graph);
        expect(analyzeWorkflowImport(graph, undefined, undefined, undefined, true).prompts)
            .toEqual([expect.objectContaining({ nodeId: "100", field: "text", value })]);
        const { workflow } = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, {
            workflowId: "123456789012345678", baseUrl: "https://www.runninghub.cn", name: "Configuration text",
        }));
        expect(workflow.mapping).toContainEqual({ semantic: "prompt", nodeId: "100", field: "text" });
        expect(workflow.promptRequired).toBe(true);
        expect(workflow.parameters).not.toContainEqual(expect.objectContaining({ default: value }));
        expect(workflow.template!["100"].inputs.text).toBe(value);
        expect(workflow.template).toEqual(before);
        expect(graph).toEqual(before);
    });
    it("retains explicit prompt and recognized media inputs even when values resemble configuration", async () => {
        const graph: ApiWorkflow = {
            "1": { class_type: "LoadImage", inputs: { image: "author.png" } },
            "2": { class_type: "LoadAudio", inputs: { audio: "author.wav" } },
            "3": { class_type: "LoadVideo", inputs: { video: "author.mp4" } },
            "4": { class_type: "CustomGenerator", inputs: { image: ["1", 0], prompt: "auto" } },
            "9": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
        };
        const result = await readAnalysis(graph);
        expect(result.prompts).toEqual([expect.objectContaining({ nodeId: "4", field: "prompt", value: "auto" })]);
        expect(result.inputs.map(input => [input.nodeId, input.field, input.kind])).toEqual([["1", "image", "image"], ["2", "audio", "audio"], ["3", "video", "video"]]);
    });
    it("retains a primitive string explicitly connected to a prompt even when its value is auto", async () => {
        const graph: ApiWorkflow = {
            "1": { class_type: "PrimitiveString", inputs: { value: "auto" } },
            "2": { class_type: "CustomGenerator", inputs: { prompt: ["1", 0] } },
            "9": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
        };
        expect((await readAnalysis(graph)).prompts).toEqual([expect.objectContaining({ nodeId: "1", field: "value", value: "auto" })]);
    });
    it("preserves an ordinary prompt fallback when it is not a model or device configuration", async () => {
        const graph: ApiWorkflow = {
            "1": { class_type: "PromptSelector", inputs: { value: "晨雾中的山" } },
            "2": { class_type: "CustomGenerator", inputs: { prompt: ["1", 0] } },
            "9": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
        };
        expect((await readAnalysis(graph)).prompts).toEqual([expect.objectContaining({ nodeId: "1", field: "value", value: "晨雾中的山" })]);
    });
    it("continues to use the app's published prompt and media contracts rather than full-graph heuristics", async () => {
        const source = app({ nodeInfoList: [
                { nodeId: "1", nodeName: "ModelSelector", fieldName: "content", fieldType: "STRING", fieldValue: "auto" },
                { nodeId: "2", nodeName: "DeviceSelector", fieldName: "file", fieldType: "IMAGE", fieldValue: "author.png", required: true },
            ] });
        const graph = runningHubAppGraph(await withRunningHubAppReader(source)), before = structuredClone(graph);
        const result = await readAnalysis(graph, source);
        expect(result.prompts).toEqual([expect.objectContaining({ nodeId: "1", field: "content", value: "auto" })]);
        expect(result.inputs).toEqual([expect.objectContaining({ nodeId: "2", field: "file", kind: "image", required: true })]);
        expect(result.outputs).toMatchObject([{ nodeId: runningHubAppOutputNode, kind: "image" }]);
        expect(graph).toEqual(before);
    });
    it("identifies credential ports exactly while preserving ordinary token and keyframe controls", () => {
        const graph: ApiWorkflow = { "1": { class_type: "RemoteGenerator", inputs: { api_key: "author-key", access_token: "author-token", token_count: 50, keyframes: "0,10", max_tokens: "500" } } };
        expect([...runningHubImportCredentialIdentities(graph)]).toEqual([JSON.stringify(["1", "api_key"]), JSON.stringify(["1", "access_token"])]);
    });
    it("honors explicit app secret metadata even when the field name resembles a prompt", async () => {
        const source = app({ nodeInfoList: [{ nodeId: "1", fieldName: "text", fieldType: "PASSWORD", fieldValue: "author-secret" }, { nodeId: "2", fieldName: "prompt", fieldValue: "海边" }] });
        const graph = runningHubAppGraph(await withRunningHubAppReader(source));
        expect(runningHubImportCredentialIdentities(graph, source).has(JSON.stringify(["1", "text"]))).toBe(true);
        expect((await readAnalysis(graph, source)).prompts.map(field => field.nodeId)).toEqual(["2"]);
    });
});

async function readAnalysis(graph: ApiWorkflow, app?: import("../src/runninghub/client").RunningHubAiApp) {if(app){const next=await withRunningHubAppReader(app);return analyzeRunningHubImport(graph,next);}await readRunningHubWorkflowFixture(graph);return analyzeRunningHubImport(graph);}
