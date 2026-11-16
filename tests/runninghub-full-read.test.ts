import { readRunningHubWorkflowFixture, withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode } from "../src/types";
import { analyzeRunningHubImport } from "../src/runninghub/import-analysis";
import { prepareRunningHubWorkflow, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { analyzeWorkflowImport, buildWorkflowImport, type ImportOutputBinding } from "../src/workflow/import-analyzer";
const output: ImportOutputBinding = { nodeId: "2", field: "images", kind: "image" };
const options = { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn", name: "Complete remote workflow", outputs: [output], promptKey: "1.prompt" };
const graph = (): ApiWorkflow => ({
    "1": { class_type: "SyntheticGenerator", _meta: { title: "Primary generator" }, inputs: { prompt: "Original prompt", seed: 17, model_name: "primary.safetensors" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "original-output" } },
    "3": { class_type: "SyntheticModelLoader", _meta: { title: "Secondary model" }, inputs: { model_name: "secondary.gguf" } },
    "4": { class_type: "LoadImage", inputs: { image: "secondary-reference.png" } },
    "5": { class_type: "SecondaryGenerator", inputs: { model: ["3", 0], image: ["4", 0], strength: 0.75, enabled: true } },
    "6": { class_type: "PreviewImage", inputs: { images: ["5", 0] } },
});
describe("RunningHub complete graph reading", () => {
    it("keeps every original node, link, value and model while binding only the selected results", async () => {
        const original = graph(), before = structuredClone(original);
        const parsed = (await readRunningHubWorkflowFixture(JSON.stringify(original))).workflow!;
        const { workflow } = prepareRunningHubWorkflow(parsed, await withRunningHubWorkflowReader(parsed, options));
        expect(workflow.template).toEqual(before);
        expect(original).toEqual(before);
        expect(parsed).toEqual(before);
        expect(Object.keys(workflow.template!)).toHaveLength(6);
        expect(workflow.output).toEqual(output);
        expect(workflow.additionalOutputs).toBeUndefined();
        expect(workflow.template!["1"].inputs.model_name).toBe("primary.safetensors");
        expect(workflow.template!["3"].inputs.model_name).toBe("secondary.gguf");
        const targets = workflow.mapping.map(item => item.nodeId + "." + item.field);
        expect(targets).toEqual(expect.arrayContaining(["1.prompt", "1.seed", "4.image", "1.model_name", "3.model_name", "5.strength", "5.enabled", "2.filename_prefix"]));
        expect(new Set(targets).size).toBe(targets.length);
        expect(workflow.inputSlots).toEqual([expect.objectContaining({ semantic: "slot:input1", kind: "image" })]);
        const candidates = prepareRunningHubWorkflowCandidates(parsed, await withRunningHubWorkflowReader(parsed, options)).workflow;
        for (const target of ["3.model_name", "5.strength", "5.enabled"])
            expect(candidates.mapping.some(item => item.nodeId + "." + item.field === target)).toBe(true);
    });
    it("applies explicitly selected edits and uploads outside the selected output branch without discarding its graph", async () => {
        const source = graph(), candidates = prepareRunningHubWorkflowCandidates(source, await withRunningHubWorkflowReader(source, options)).workflow;
        const strength = candidates.mapping.find(item => item.nodeId === "5" && item.field === "strength")!;
        const enabled = candidates.mapping.find(item => item.nodeId === "5" && item.field === "enabled")!;
        const { workflow } = prepareRunningHubWorkflow(source, await withRunningHubWorkflowReader(source, { ...options, canvasParameterKeys: [strength.semantic, enabled.semantic] }));
        const node = { data: { generation: { workflowId: workflow.id, prompt: "Edited prompt", negativePrompt: "", params: { [strength.semantic]: 0.25, [enabled.semantic]: false }, taskId: null } } } as CanvasNode;
        const inputs = [{ semantic: "slot:input1", asset: { id: "reference", kind: "image", name: "reference.png" }, edgeId: "reference-edge" }] as Parameters<typeof buildWorkflow>[2];
        const built = buildWorkflow(workflow, node, inputs, { reference: "uploaded/reference.png" });
        expect(Object.keys(built.workflow)).toEqual(Object.keys(source));
        expect(built.workflow["4"].inputs.image).toBe("uploaded/reference.png");
        expect(built.workflow["5"].inputs).toEqual({ model: ["3", 0], image: ["4", 0], strength: 0.25, enabled: false });
        expect(built.workflow["6"]).toEqual(source["6"]);
        expect(workflow.template).toEqual(source);
    });
    it("includes fields and media from the full graph even when it discovers only one output", async () => {
        const source = graph();
        source["6"] = { class_type: "Note", inputs: { source: ["5", 0], note: "Supporting branch metadata" } };
        const normal = analyzeWorkflowImport(source);
        const remote = await readAnalysis(source);
        expect(normal.outputs).toHaveLength(1);
        expect(normal.fields.some(field => field.nodeId === "3")).toBe(false);
        expect(normal.inputs).toEqual([]);
        expect(remote.outputs).toMatchObject([{ nodeId: "2", field: "*", kind: "file", needsBinding: true }]);
        expect(remote.errors).toEqual([]);
        expect(remote.fields.map(field => field.nodeId + "." + field.field)).toEqual(expect.arrayContaining(["3.model_name", "5.strength", "5.enabled", "6.note"]));
        expect(remote.inputs).toEqual([expect.objectContaining({ nodeId: "4", field: "image", kind: "image" })]);
    });
    it("preserves ordinary ComfyUI output-branch pruning unless complete reading is requested", () => {
        const source = graph(), common = { id: "test.complete-reading", name: "Import graph", family: "Image", bindings: { outputs: [output] } };
        const normal = buildWorkflowImport(source, common);
        const complete = buildWorkflowImport(source, { ...common, preserveFullGraph: true });
        expect(Object.keys(normal.graph)).toEqual(["1", "2"]);
        expect(normal.requirements.items).toEqual([expect.objectContaining({ name: "primary.safetensors" })]);
        expect(Object.keys(complete.graph)).toEqual(Object.keys(source));
        expect(complete.requirements.items).toEqual([expect.objectContaining({ name: "primary.safetensors" }), expect.objectContaining({ name: "secondary.gguf" })]);
        expect((complete.config.parameters as {
            binding: {
                nodeId: string;
                path: string;
            };
        }[]).some(parameter => parameter.binding.nodeId === "5" && parameter.binding.path === "inputs.strength")).toBe(true);
    });
});

async function readAnalysis(graph: ApiWorkflow, app?: import("../src/runninghub/client").RunningHubAiApp) {if(app){const next=await withRunningHubAppReader(app);return analyzeRunningHubImport(graph,next);}await readRunningHubWorkflowFixture(graph);return analyzeRunningHubImport(graph);}
