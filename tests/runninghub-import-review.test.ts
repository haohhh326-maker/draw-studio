import { readRunningHubWorkflowFixture, withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { expect, it } from "vitest";
import type { ApiWorkflow, WorkflowDefinition } from "../src/types";
import { analyzeRunningHubImport } from "../src/runninghub/import-analysis";
import { prepareRunningHubApp, prepareRunningHubWorkflow, prepareRunningHubWorkflowCandidates, runningHubAppGraph, runningHubAppOutputNode } from "../src/runninghub/workflows";
import { reviewRunningHubImportBindings } from "../src/runninghub/import-review";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
import type { RunningHubAiApp } from "../src/runninghub/client";
const graph: ApiWorkflow = {
    "1": { class_type: "LoadImage", inputs: { image: "example.png" } },
    "2": { class_type: "EditImage", inputs: { image: ["1", 0], prompt: "example" } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
};
const saved = async () => prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Fixture", outputs: [{ nodeId: "3", field: "images", kind: "image" }] })).workflow;
it("retains explicitly reviewed bindings when only labels and values change", async () => {
    const fresh = structuredClone(graph);
    fresh["2"].inputs.prompt = "a new example";
    fresh["2"]._meta = { title: "renamed display label" };
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(false);
    expect(review.promptKey).toBe("2.prompt");
    expect(review.media).toMatchObject([{ nodeId: "1", field: "image" }]);
    expect(review.outputs).toEqual([{ nodeId: "3", field: "images", kind: "image" }]);
});
it("does not reuse a prompt after the same node ID acquires a different class", async () => {
    const fresh = structuredClone(graph);
    fresh["2"].class_type = "UnrelatedTextOperation";
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(true);
    expect(review.promptKey).toBe("");
    expect(review.warnings.join(" ")).toContain("主提示词");
});
it("clears a prompt that became a graph edge instead of replacing that edge", async () => {
    const fresh = structuredClone(graph);
    fresh["2"].inputs.prompt = ["1", 0];
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.promptKey).toBe("");
    expect(fresh["2"].inputs.prompt).toEqual(["1", 0]);
});
it("requires output review after a removed output, keeping the full fresh graph", async () => {
    const fresh = structuredClone(graph);
    fresh["9"] = fresh["3"];
    delete fresh["3"];
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(true);
    expect(review.outputs).toEqual([{ nodeId: "9", field: "*", kind: "file" }]);
    expect(Object.keys(fresh)).toEqual(["1", "2", "9"]);
});
it("retains the user's wildcard field and file type on an unchanged known output node", async () => {
    const explicit = await saved();
    explicit.output = { nodeId: "3", field: "*", kind: "file" };
    const review = reviewRunningHubImportBindings(explicit.template!, await readAnalysis(explicit.template!), explicit);
    expect(review.changed).toBe(false);
    expect(review.warnings).toEqual([]);
    expect(review.outputs).toEqual([explicit.output]);
});
it("retains a reviewed concrete output field instead of replacing it with the analyzer's guessed field", async () => {
    const explicit = await saved();
    explicit.output = { nodeId: "3", field: "platform_results", kind: "image" };
    const review = reviewRunningHubImportBindings(graph, await readAnalysis(graph), explicit);
    expect(review.changed).toBe(false);
    expect(review.outputs).toEqual([explicit.output]);
});
it("adds a newly introduced HD save node when every previous save port used the ordinary contract", async () => {
    const original = await saved(), originalBefore = structuredClone(original);
    const fresh = structuredClone(graph);
    fresh["4"] = { class_type: "ImageScale", inputs: { image: ["2", 0], width: 2048, height: 3072 } };
    fresh["5"] = { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "hd" } };
    const before = structuredClone(fresh), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), original);
    expect(review.changed).toBe(true);
    expect(review.outputs).toEqual([original.output, { nodeId: "5", field: "*", kind: "file" }]);
    expect(review.warnings.join(" ")).toContain("新增的保存输出");
    expect(fresh).toEqual(before); expect(original).toEqual(originalBefore);
});
it("keeps an existing unselected HD branch and later additions out of an explicitly narrowed legacy output set", async () => {
    const complete = structuredClone(graph);
    complete["4"] = { class_type: "ImageScale", inputs: { image: ["2", 0] } };
    complete["5"] = { class_type: "SaveImage", inputs: { images: ["4", 0] } };
    const explicit = prepareRunningHubWorkflowCandidates(complete, await withRunningHubWorkflowReader(complete, {
      workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Chosen ordinary branch",
      outputs: [{ nodeId: "3", field: "images", kind: "image" }],
    })).workflow;
    const fresh = structuredClone(complete);
    fresh["6"] = { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "new" } };
    const before = structuredClone(fresh), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), explicit);
    expect(review.changed).toBe(false);
    expect(review.outputs).toEqual([explicit.output]);
    expect(fresh).toEqual(before); expect(explicit.template).toEqual(complete);
});
it("preserves custom output fields when a new known save node appears", async () => {
    const explicit = await saved();
    explicit.output = { nodeId: "3", field: "platform_results", kind: "image" };
    const fresh = structuredClone(graph);
    fresh["4"] = { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "hd" } };
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), explicit);
    expect(review.changed).toBe(false);
    expect(review.outputs).toEqual([explicit.output]);
});
it("invalidates the old output when the same node ID changes its class", async () => {
    const fresh = structuredClone(graph);
    fresh["3"].class_type = "SaveAudio";
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(true);
    expect(review.outputs).toEqual([{ nodeId: "3", field: "*", kind: "file" }]);
});
it("adds an actually new media input while retaining the complete graph and existing reviewed binding", async () => {
    const fresh = structuredClone(graph);
    fresh["4"] = { class_type: "LoadAudio", inputs: { audio: "new-example.wav" } };
    const before = structuredClone(fresh);
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(true);
    expect(review.media).toMatchObject([{ nodeId: "1", field: "image", kind: "image" }, { nodeId: "4", field: "audio", kind: "audio" }]);
    expect(fresh).toEqual(before);
});
it("restores an excluded legacy media field from the original reader without rewriting its authored value", async () => {
    const complete = structuredClone(graph);
    complete["4"] = { class_type: "LoadAudio", inputs: { audio: "internal-example.wav" } };
    const explicit = prepareRunningHubWorkflowCandidates(complete, await withRunningHubWorkflowReader(complete, { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Fixture",
        outputs: [{ nodeId: "3", field: "*", kind: "file" }] })).workflow;
    excludeMedia(explicit, "4", "audio");
    const review = reviewRunningHubImportBindings(complete, await readAnalysis(complete), explicit);
    expect(review.changed).toBe(true);
    expect(review.media.map(input => input.nodeId)).toEqual(["1", "4"]);
    expect(complete["4"].inputs.audio).toBe("internal-example.wav");
});
it("restores old source inputs and adds new inputs while preserving the complete legacy graph", async () => {
    const complete = structuredClone(graph);
    complete["4"] = { class_type: "LoadAudio", inputs: { audio: "internal.wav" } };
    const explicit = prepareRunningHubWorkflowCandidates(complete, await withRunningHubWorkflowReader(complete, { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Fixture",
        outputs: [{ nodeId: "3", field: "images", kind: "image" }] })).workflow;
    excludeMedia(explicit, "4", "audio");
    const fresh = structuredClone(complete);
    fresh["5"] = { class_type: "LoadVideo", inputs: { video: "new.mp4" } };
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), explicit);
    expect(review.changed).toBe(true);
    expect(review.media.map(input => input.nodeId)).toEqual(["1", "4", "5"]);
    expect(review.media[0].required).toBe(false);
});
it("does not mistake a full workflow's local optional override for a newly required platform input", async () => {
    const explicit = await saved();
    explicit.inputSlots![0].required = false;
    const review = reviewRunningHubImportBindings(graph, await readAnalysis(graph), explicit);
    expect(review.changed).toBe(false);
    expect(review.media[0].required).toBe(false);
});
it("replaces only an invalidated media target after its node and field change type", async () => {
    const fresh = structuredClone(graph);
    fresh["1"] = { class_type: "LoadAudio", inputs: { audio: "new.wav" } };
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), await saved());
    expect(review.changed).toBe(true);
    expect(review.media).toMatchObject([{ nodeId: "1", field: "audio", kind: "audio" }]);
    expect(review.media).toHaveLength(1);
});
function app(): RunningHubAiApp {
    return { apiVersion: "v1", outputKind: "image", nodeInfoList: [
            { nodeId: "1", fieldName: "prompt", fieldValue: "example", fieldType: "STRING" },
            { nodeId: "2", fieldName: "source", fieldValue: "author.png", fieldType: "IMAGE", required: false, mediaEmptyValue: "" },
        ] };
}
const appOptions = { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "App Fixture" };
it("retains an app's reviewed wildcard even when its published output class implies an image", async () => {
    const original = app(), explicit = prepareRunningHubApp(await withRunningHubAppReader(original), { ...appOptions, outputs: [{ nodeId: runningHubAppOutputNode, field: "*", kind: "file" }] }).workflow;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(original));
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, original), explicit);
    expect(review.changed).toBe(false);
    expect(review.outputs).toEqual([explicit.output]);
});
it("preserves the reviewed app output when metadata changes but the upstream output node contract does not", async () => {
    const original = app(), explicit = prepareRunningHubApp(await withRunningHubAppReader(original), { ...appOptions, outputs: [{ nodeId: runningHubAppOutputNode, field: "*", kind: "file" }] }).workflow;
    const updated = { ...original, outputKind: "video" as const }, fresh = runningHubAppGraph(await withRunningHubAppReader(updated));
    const review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(false);
    expect(review.outputs).toEqual([explicit.output]);
});
it("reviews a new public app media input without rewriting a legacy excluded public field", async () => {
    const original = app();
    original.nodeInfoList.push({ nodeId: "3", fieldName: "clip", fieldValue: "old.mp4", fieldType: "VIDEO", required: false, mediaEmptyValue: "" });
    // Reconstruct a saved pre-selection definition. New imports must bind every
    // recognized media field; review still reads old snapshots without rewriting them.
    const legacy = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    const excludedSemantic = legacy.mapping.find(binding => binding.nodeId === "3" && binding.field === "clip")!.semantic;
    legacy.mapping = legacy.mapping.filter(binding => binding.semantic !== excludedSemantic);
    legacy.inputSlots = legacy.inputSlots!.filter(slot => slot.semantic !== excludedSemantic);
    legacy.optionalInputs = legacy.optionalInputs.filter(semantic => semantic !== excludedSemantic);
    legacy.runninghub!.mediaInputs = legacy.runninghub!.mediaInputs!.filter(input => input.nodeId !== "3");
    delete legacy.runninghub!.bindingMode;
    const explicit = await attachRunningHubExecutionContract(legacy, original);
    const updated = structuredClone(original);
    updated.nodeInfoList.push({ nodeId: "4", fieldName: "voice", fieldValue: "new.wav", fieldType: "AUDIO", required: true });
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(true);
    expect(review.media.map(input => input.nodeId)).toEqual(["2", "4"]);
    expect(review.media[1]).toMatchObject({ field: "voice", kind: "audio", required: true });
});
it("requires review and upgrades an app media field when its published optional contract becomes required", async () => {
    const original = app(), explicit = await attachRunningHubExecutionContract(prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow, original);
    const updated = structuredClone(original);
    updated.nodeInfoList[1].required = true;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(true);
    expect(review.warnings.join(" ")).toContain("必填");
    expect(review.media).toMatchObject([{ nodeId: "2", field: "source", kind: "image", required: true }]);
});
it("detects an app's optional-to-required change through legacy media metadata without a read snapshot", async () => {
    const original = app(), explicit = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    const updated = structuredClone(original);
    updated.nodeInfoList[1].required = true;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(true);
    expect(review.media[0].required).toBe(true);
});
it("replaces an app media type that changed on the same public field", async () => {
    const original = app(), explicit = await attachRunningHubExecutionContract(prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow, original);
    const updated = structuredClone(original);
    updated.nodeInfoList[1].fieldType = "VIDEO";
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(true);
    expect(review.media).toMatchObject([{ nodeId: "2", field: "source", kind: "video", required: false }]);
});
it("drops a stale app media binding if its formerly published media field is now ordinary text", async () => {
    const original = app(), explicit = await attachRunningHubExecutionContract(prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow, original);
    const updated = structuredClone(original);
    updated.nodeInfoList[1].fieldType = "STRING";
    updated.nodeInfoList[1].fieldValue = "ordinary setting";
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), explicit);
    expect(review.changed).toBe(true);
    expect(review.media).toEqual([]);
});
it("selects the declared first main prompt when an old app lacks a prompt mapping, even with several published text fields", async () => {
    const original = app();
    original.nodeInfoList.push({ nodeId: "4", fieldName: "negative_prompt", fieldValue: "author negative", fieldType: "STRING" });
    const legacy = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    legacy.mapping = legacy.mapping.filter(mapping => mapping.semantic !== "prompt");
    delete legacy.runninghub!.parameterSchemaVersion;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(original)), analysis = await readAnalysis(fresh, original);
    analysis.prompts = [{ nodeId: "1", field: "prompt", label: "Main", value: "example" }, { nodeId: "4", field: "negative_prompt", label: "Negative", value: "author negative" }];
    const review = reviewRunningHubImportBindings(fresh, analysis, legacy);
    expect(review.promptKey).toBe("1.prompt");
    expect(review.changed).toBe(true);
    expect(review.warnings.join(" ")).toContain("主提示词");
});
it("keeps an explicitly mapped app main prompt instead of replacing it with the new first candidate", async () => {
    const original = app();
    original.nodeInfoList.push({ nodeId: "4", fieldName: "alternate", fieldValue: "my authored prompt", fieldType: "STRING" });
    const legacy = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    legacy.mapping = legacy.mapping.map(mapping => mapping.semantic === "prompt" ? { ...mapping, nodeId: "4", field: "alternate" } : mapping);
    const fresh = runningHubAppGraph(await withRunningHubAppReader(original)), analysis = await readAnalysis(fresh, original);
    analysis.prompts = [{ nodeId: "1", field: "prompt", label: "Main", value: "example" }, { nodeId: "4", field: "alternate", label: "Alternate", value: "my authored prompt" }];
    expect(reviewRunningHubImportBindings(fresh, analysis, legacy).promptKey).toBe("4.alternate");
});
it("retains a version 2 app's explicit decision not to bind a main prompt", async () => {
    const original = app(), current = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    Object.assign(current.runninghub!, { parameterSchemaVersion: 2 });
    current.mapping = current.mapping.filter(mapping => mapping.semantic !== "prompt");
    const fresh = runningHubAppGraph(await withRunningHubAppReader(original));
    expect(reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, original), current).promptKey).toBe("");
});
it("corrects both legacy required image inputs when the new public app contract explicitly declares them optional", async () => {
    const original = app();
    original.nodeInfoList[1].required = true;
    original.nodeInfoList.push({ nodeId: "3", fieldName: "second_image", fieldValue: "second.png", fieldType: "IMAGE", required: true });
    const legacy = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    const updated = structuredClone(original);
    updated.nodeInfoList[1].required = false;
    updated.nodeInfoList[2].required = false;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(updated)), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh, updated), legacy);
    expect(review.changed).toBe(true);
    expect(review.media).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "2", required: false }), expect.objectContaining({ nodeId: "3", required: false })]));
    expect(review.media).toHaveLength(2);
});
it("never invents an optional declaration for an existing app input when fresh required metadata is missing", async () => {
    const original = app();
    original.nodeInfoList[1].required = true;
    const legacy = prepareRunningHubApp(await withRunningHubAppReader(original), appOptions).workflow;
    const fresh = runningHubAppGraph(await withRunningHubAppReader(original)), analysis = await readAnalysis(fresh, original);
    delete analysis.inputs[0].required;
    const review = reviewRunningHubImportBindings(fresh, analysis, legacy);
    expect(review.media[0].required).toBe(true);
});

async function readAnalysis(graph: ApiWorkflow, app?: RunningHubAiApp) {
 if(app) {const next=await withRunningHubAppReader(app);return analyzeRunningHubImport(graph,next);}
 await readRunningHubWorkflowFixture(graph);return analyzeRunningHubImport(graph);
}

function excludeMedia(workflow: WorkflowDefinition, nodeId: string, field: string) {
    const semantic = workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field)!.semantic;
    workflow.mapping = workflow.mapping.filter(mapping => mapping.semantic !== semantic);
    workflow.inputSlots = workflow.inputSlots!.filter(slot => slot.semantic !== semantic);
    workflow.requiredInputs = workflow.requiredInputs.filter(value => value !== semantic);
    workflow.optionalInputs = workflow.optionalInputs.filter(value => value !== semantic);
}

it("preserves the confirmed type when an older app virtual output is replaced by the original ANY port", async () => {
    const original = await withRunningHubAppReader(app());
    const explicit = prepareRunningHubApp(original, { ...appOptions, outputs: [{ nodeId: runningHubAppOutputNode, field: "images", kind: "image" }] }).workflow;
    const legacyNode = "__rh_app_output";
    explicit.template![legacyNode] = { class_type: "SaveImage", inputs: {} };
    delete explicit.template![runningHubAppOutputNode];
    explicit.output = { nodeId: legacyNode, field: "images", kind: "image" };
    const fresh = runningHubAppGraph(original), review = reviewRunningHubImportBindings(fresh, await readAnalysis(fresh), explicit);
    expect(review.outputs).toEqual([{ nodeId: runningHubAppOutputNode, field: "images", kind: "image" }]);
    expect(review.warnings.join(" ")).not.toContain("输出");
});
