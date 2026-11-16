import { beforeEach, describe, expect, it } from "vitest";
import type { Asset, Canvas, GenerationTask, Project, WorkflowDefinition } from "../src/types";
import { createNode, useStore } from "../src/stores/store";
import { migrateProject } from "../src/projects/migrate";
import { defaultConnection } from "../src/workflow/catalog";
import { categoryForKind } from "../src/workflow/dfcine-directory";
import { createLibraryRegistration, convertLibraryWorkflow } from "../src/workflow/library-converter";
import { resolvePrompt } from "../src/semantic/prompt";
import { resolveInputs } from "../src/semantic/resolver";

const config = {
  id: "Qwen3.5PromptReverse", version: "1", nameLabel: { "zh-CN": "Qwen3.5 提示词反推" }, primaryCategoryLabel: { "zh-CN": "文本工具" },
  nodeKind: "text", runnerType: "comfyui", inputs: [], parameters: [], prompt: { binding: { target: "comfyui", nodeId: "1", path: "inputs.prompt" } }, execution: { file: "execution.api.json" },
};
const source = { sourcePath: "E:/library", folder: "Qwen3.5PromptReverse", configSha256: "config", executionSha256: "execution", executionStatus: "plain" as const };
const textWorkflow = (): WorkflowDefinition => convertLibraryWorkflow(config, {
  "1": { class_type: "TextPrompt", inputs: { prompt: "" } },
  "2": { class_type: "easy showAnything", inputs: { anything: ["1", 0], text: "" } },
}, undefined, source);
function project(nodes: Canvas["nodes"] = []): Project {
  return { version: 2, id: "project", name: "测试", scenes: [{ id: "scene", name: "测试" }], canvases: [{ id: "canvas", name: "画布", sceneId: "scene", nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], activeCanvasId: "canvas", assets: {}, tasks: {}, history: [], updatedAt: 0 };
}

beforeEach(() => useStore.setState({ project: project(), workflows: [textWorkflow()], ready: false, projectOpen: false, past: [], future: [] }));

describe("text output workflows", () => {
  it("classifies both configured and unadapted text workflows in the independent text canvas", () => {
    expect(categoryForKind("text")).toBe("text");
    expect(textWorkflow().directory?.canvas).toBe("text");
    expect(createLibraryRegistration({ ...config, runnerType: "python" }, undefined, source).directory?.canvas).toBe("text");
  });

  it("creates text generation nodes from the current library and permits handwriting with an empty library", () => {
    const workflow = textWorkflow();
    const note = createNode("text", 1, 10, 20, [workflow]);
    expect(note.data.kind).toBe("text");
    expect(note.data.generation?.workflowId).toBe(workflow.id);
    expect(createNode("text", 1, 10, 20, []).data.generation).toEqual({ workflowId: "", prompt: "", negativePrompt: "", params: {}, taskId: null });
  });

  it("restores old handwritten text nodes without replacing text or existing generation settings", () => {
    const existing = createNode("text", 2, 10, 20, [textWorkflow()]);
    existing.data.text = "已有文本";
    existing.data.generation!.workflowId = "custom-reference";
    existing.data.generation!.params = { seed: 123 };
    const raw = project([{ id: "old", position: { x: 0, y: 0 }, data: { kind: "text", title: "文本", text: "手写分镜" } }, existing]);
    const restored = migrateProject(raw, [textWorkflow()]);
    expect(restored.canvases[0].nodes[0].data).toMatchObject({ kind: "text", text: "手写分镜", generation: { workflowId: textWorkflow().id } });
    expect(restored.canvases[0].nodes[1].data).toEqual(existing.data);
    expect(raw.canvases[0].nodes[0].data.generation).toBeUndefined();
  });

  it("writes generated text into the original text node and uses its editable content as downstream prompt", () => {
    const workflow = textWorkflow();
    const note = createNode("text", 1, 0, 0, [workflow]); note.id = "note";
    note.data.generation!.prompt = "此前的生成指令";
    note.data.generation!.taskId = "task";
    const state = project([note]);
    const task: GenerationTask = { taskId: "task", promptId: "remote", executorType: "comfyui", requestId: "request", clientId: "client", canvasId: "canvas", nodeId: "note", nodeTitle: "文本", createdAt: 1, updatedAt: 1, status: "saving", connection: defaultConnection, workflow, outputs: [], input: { prompt: "此前的生成指令", negativePrompt: "", params: {}, assets: [] } };
    state.tasks.task = task;
    useStore.setState({ project: state });
    const output: Asset = { id: "result", name: "result.txt", kind: "text", text: "生成的提示词", mime: "text/plain", size: 30, createdAt: 2 };
    useStore.getState().complete("task", [output], { id: "history", canvasId: "canvas", nodeId: "note", nodeTitle: "文本", workflowId: workflow.id, prompt: "此前的生成指令", negativePrompt: "", params: {}, inputs: [], outputs: [output.id], promptId: "remote", createdAt: 2 });
    const written = useStore.getState().project.canvases[0].nodes[0];
    expect(written.id).toBe("note");
    expect(written.data.kind).toBe("text");
    expect(written.data.text).toBe("生成的提示词");
    useStore.getState().patchNode("note", { text: "用户编辑后的提示词" });
    const canvas = structuredClone(useStore.getState().project.canvases[0]);
    canvas.nodes.push({ id: "target", position: { x: 1, y: 1 }, data: { kind: "video", title: "视频" } });
    canvas.edges.push({ id: "edge", source: "note", target: "target", data: { role: "prompt", order: 0 } });
    expect(resolvePrompt(canvas, "target", "补充描述").prompt).toBe("用户编辑后的提示词\n\n补充描述");
    expect(resolveInputs(canvas, "target", { ...workflow, inputSlots: [] }, { result: output })).toEqual([]);
  });
});
