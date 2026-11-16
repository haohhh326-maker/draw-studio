import { describe, expect, it } from "vitest";
import { workflowForCanvasEdge } from "../src/canvas/edge-workflow";
import { defaultRunningHubConnections } from "../src/compute/providers";
import { museWorkflows } from "../src/muse/catalog";
import { resolveInputs, workflowInputRoleOptions } from "../src/semantic/resolver";
import type { Asset, CanvasNode, ComputeProvider, Project, WorkflowDefinition } from "../src/types";

function workflow(id: string, kind: "image" | "video" | "audio", provider: ComputeProvider, baseUrl = "https://www.runninghub.cn"): WorkflowDefinition {
  const semantic = "slot:" + id;
  return { id, name: id, family: "Test", description: "", mode: kind === "audio" ? "text-to-audio" : kind === "video" ? "text-to-video" : "text-to-image",
    parameters: [], requiredInputs: [semantic], optionalInputs: [], mapping: [],
    inputSlots: [{ semantic, label: id + "素材", kind, required: true }], output: { nodeId: "out", field: "media", kind },
    ...(provider === "comfyui" ? {} : { runninghub: { workflowId: id, baseUrl, kind: provider === "runninghub" ? "app" : "workflow" } }) };
}

function fixture() {
  const local = workflow("local-image", "image", "comfyui");
  const remote = workflow("remote-video", "video", "runninghub-workflow");
  const app = workflow("app-audio", "audio", "runninghub", "https://www.runninghub.ai");
  const assets: Record<string, Asset> = Object.fromEntries((["image", "video", "audio"] as const).map(kind => [kind,
    { id: kind, name: kind, kind, mime: kind + "/test", size: 1, createdAt: 1 }]));
  const targets: CanvasNode[] = [
    { id: "image-target", data: { title: "图像", kind: "image-generation", generation: { workflowId: local.id, computeProvider: "comfyui", prompt: "", params: {} } }, position: { x: 0, y: 0 } },
    { id: "video-target", data: { title: "视频", kind: "video", generation: { workflowId: remote.id, computeProvider: "runninghub-workflow", prompt: "", params: {} } }, position: { x: 0, y: 0 } },
    { id: "audio-target", data: { title: "音频", kind: "audio", generation: { workflowId: app.id, computeProvider: "runninghub", prompt: "", params: {} } }, position: { x: 0, y: 0 } },
    { id: "muse-target", data: { title: "Muse", kind: "video", generation: { workflowId: "muse-video", computeProvider: "muse", prompt: "", params: {} } }, position: { x: 0, y: 0 } },
  ];
  const project: Project = { version: 2, id: "project", name: "Mixed cards", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "scene" }],
    assets, tasks: {}, history: [], updatedAt: 1, canvases: [{ id: "canvas", name: "canvas", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [...targets, ...Object.keys(assets).map(kind => ({ id: kind + "-source", data: { kind: "reference" as const, title: kind, assetId: kind }, position: { x: 0, y: 0 } }))],
      edges: ["image", "video", "audio"].map(kind => ({ id: kind + "-edge", source: kind + "-source", target: kind + "-target", data: { role: "auto", order: 1 } }))
        .concat([{ id: "muse-edge", source: "audio-source", target: "muse-target", data: { role: "auto", order: 1 } }]),
    }] };
  return { project, workflows: [local], runningHubWorkflows: [remote, app], computeProvider: "muse" as ComputeProvider,
    connection: { ...defaultRunningHubConnections.cn, baseUrl: "https://comfy.example" },
    runningHubConnection: defaultRunningHubConnections.cn, runningHubConnections: defaultRunningHubConnections };
}

describe("mixed-provider edge workflow ownership", () => {
  it.each(["comfyui", "runninghub", "runninghub-workflow", "muse"] as const)("keeps image, video and audio input bindings when the default becomes %s", computeProvider => {
    const state = { ...fixture(), computeProvider };
    for (const [kind, id] of [["image", "local-image"], ["video", "remote-video"], ["audio", "app-audio"]] as const) {
      const definition = workflowForCanvasEdge(state, "canvas", kind + "-edge")!;
      expect(definition.id).toBe(id);
      expect(workflowInputRoleOptions(definition, kind)).toEqual([{ value: "auto", label: "自动分配" }, { value: "slot:" + id, label: id + "素材 · 必需" }]);
      expect(resolveInputs(state.project.canvases[0], kind + "-target", definition, state.project.assets))
        .toMatchObject([{ semantic: "slot:" + id, asset: { id: kind } }]);
      expect(workflowForCanvasEdge(state, "canvas", kind + "-edge")).toBe(definition);
    }
  });

  it("retains Muse's audio references beside RunningHub audio cards", () => {
    const state = { ...fixture(), computeProvider: "runninghub-workflow" as const };
    const definition = workflowForCanvasEdge(state, "canvas", "muse-edge")!;
    expect(definition).toBe(museWorkflows.find(workflow => workflow.id === "muse-video"));
    expect(workflowInputRoleOptions(definition, "audio")).toEqual([{ value: "auto", label: "自动分配" }, { value: "referenceAudio", label: "参考音频" }]);
    expect(resolveInputs(state.project.canvases[0], "muse-target", definition, state.project.assets))
      .toMatchObject([{ semantic: "referenceAudios", asset: { id: "audio" } }]);
  });

  it("does not borrow a different provider's definition when a card's workflow is absent", () => {
    const state = fixture();
    state.project.canvases[0].nodes[0].data.generation!.workflowId = state.runningHubWorkflows[0].id;
    expect(workflowForCanvasEdge(state, "canvas", "image-edge")).toBeUndefined();
    expect(workflowForCanvasEdge(state, "canvas", "missing-edge")).toBeUndefined();
    expect(workflowForCanvasEdge(state, "missing-canvas", "image-edge")).toBeUndefined();
  });
});
