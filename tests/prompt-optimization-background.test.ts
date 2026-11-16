import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Project, WorkflowDefinition } from "../src/types";
import type { OptimizationContext, OptimizationResult, OptimizationSettings } from "../src/prompt-optimization/types";
vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: object) => value, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { createOptimizationOperations } from "../src/prompt-optimization/operations";
import { createPromptDraftSessions } from "../src/prompt-optimization/prompt-drafts";
import { readOptimizationPrompt } from "../src/prompt-optimization/context";
import type { OptimizationScope } from "../src/prompt-optimization/operation-context";
import type { OptimizationRoute } from "../src/prompt-optimization/client";

const scope: OptimizationScope = { projectId: "project", canvasId: "canvas-a", nodeId: "node", field: "generation" };
const registries: ReturnType<typeof createOptimizationOperations>[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.dispose(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const optimized = (prompt = "optimized prompt"): OptimizationResult => ({ prompt, modelId: "model", analyzedImages: 0,
  skill: { id: "common.text", name: "Shared writing", level: "generic" }, warnings: [] });
const workflow: WorkflowDefinition = { id: "workflow", family: "Text Model", name: "Text generation", description: "", mode: "text-tool", requiredInputs: [], optionalInputs: [],
  parameters: [{ key: "seed", label: "Seed", type: "number", default: 42 }], mapping: [{ semantic: "prompt", nodeId: "prompt", field: "value" }],
  output: { nodeId: "out", field: "text", kind: "text" }, template: { prompt: { class_type: "StringConstant", inputs: { value: "original prompt" } }, out: { class_type: "PreviewTextNode", inputs: { text: ["prompt", 0] } } } };
function target(prompt = "original prompt", text = "original note"): CanvasNode {
  return { id: "node", position: { x: 0, y: 0 }, data: { kind: "text", title: "Text", text,
    generation: { workflowId: "workflow", prompt, negativePrompt: "keep negative", params: { seed: 42 }, taskId: null } } };
}
function harness() {
  type State = ReturnType<typeof useStore.getState>;
  const project: Project = { version: 2, id: "project", name: "Test", scenes: [], activeCanvasId: "canvas-a", updatedAt: 1, history: [], tasks: {},
    assets: { portrait: { id: "portrait", name: "portrait.png", kind: "image", mime: "image/png", size: 10, createdAt: 1 } }, canvases: [
      { id: "canvas-a", name: "A", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [target(),
        { id: "reference", position: { x: 100, y: 0 }, data: { kind: "reference", title: "Portrait", assetId: "portrait" } },
        { id: "other", position: { x: 300, y: 0 }, data: { kind: "text", title: "Other", text: "unrelated" } },
      ], edges: [{ id: "edge", source: "reference", target: "node", data: { order: 0, role: "characterReference" } }] },
      { id: "canvas-b", name: "B", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [target("canvas B prompt", "canvas B note")], edges: [] },
    ] };
  const stateListeners = new Set<() => void>();
  let state: State;
  const change = (fn: (current: State) => State) => { state = fn(state); for (const listener of [...stateListeners]) listener(); };
  const checkpoint = vi.fn();
  const patchNode = vi.fn((id: string, patch: Partial<CanvasNode["data"]>, canvasId?: string) => change(current => ({ ...current, project: { ...current.project,
    canvases: current.project.canvases.map(canvas => canvas.id !== (canvasId ?? current.project.activeCanvasId) ? canvas : { ...canvas, nodes: canvas.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node) }),
  } })));
  state = { ...useStore.getState(), project, projectOpen: true, selectedId: "node", workflows: [structuredClone(workflow)],
    connection: { ...useStore.getState().connection, baseUrl: "https://current.example", token: "private-token" }, past: [], future: [], checkpoint, patchNode };
  const drafts = createPromptDraftSessions();
  const settings = vi.fn(async (_signal?: AbortSignal) => ({ readMedia: true }) as OptimizationSettings);
  const collect = vi.fn(async (canvas, nodeId, _workflow, _assets, options): Promise<OptimizationContext> => ({ prompt: readOptimizationPrompt(canvas.nodes.find(node => node.id === nodeId)!, options?.promptField),
    target: { model: "Text", family: "", workflowId: "workflow", workflowName: "Text", mode: "text-tool", kind: "text" }, negativePrompt: "", references: [], mentions: {} }));
  const requests: (ReturnType<typeof deferred<OptimizationResult>> & { signal: AbortSignal; context: OptimizationContext; textOnly: boolean })[] = [];
  const optimize = vi.fn((context: OptimizationContext, textOnly: boolean, signal: AbortSignal, _route?: OptimizationRoute) => {
    const request = { ...deferred<OptimizationResult>(), signal, context, textOnly }; requests.push(request); return request.promise;
  });
  const registry = createOptimizationOperations({ readState: () => state, subscribe: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; }, settings, collect, optimize, drafts });
  registries.push(registry);
  const node = (canvasId = "canvas-a") => state.project.canvases.find(canvas => canvas.id === canvasId)!.nodes.find(item => item.id === "node")!;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { registry, requests, settings, collect, optimize, drafts, change, node, checkpoint, patchNode, stateListeners, read: () => state, flush };
}

describe("prompt optimization jobs survive hidden editors", () => {
  it("routes and writes each card independently while the default provider and the other card change", async () => {
    const h = harness();
    const rhWorkflow: WorkflowDefinition = { ...workflow, id: "rh-workflow", runninghub: { kind: "app", workflowId: "123456789", baseUrl: "https://www.runninghub.cn" } };
    h.change(state => ({ ...state, computeProvider: "muse", runningHubWorkflows: [rhWorkflow], project: { ...state.project,
      canvases: state.project.canvases.map(canvas => ({ ...canvas, nodes: canvas.nodes.map(node => node.id !== "node" ? node : { ...node, data: { ...node.data, generation: {
        ...node.data.generation!, computeProvider: canvas.id === "canvas-a" ? "comfyui" : "runninghub", workflowId: canvas.id === "canvas-a" ? workflow.id : rhWorkflow.id,
      } } }) })),
    } }));
    const settings = deferred<OptimizationSettings>(); h.settings.mockReturnValueOnce(settings.promise);
    const a = h.registry.start(scope);
    const bScope = { ...scope, canvasId: "canvas-b" }, b = h.registry.start(bScope);
    await h.flush();
    expect(h.requests[0].context.prompt).toBe("canvas B prompt");
    expect(h.optimize.mock.calls[0][3]?.computeProvider).toBe("runninghub");
    expect(h.requests[0].textOnly).toBe(true);
    h.change(state => ({ ...state, computeProvider: "runninghub-workflow", project: { ...state.project, activeCanvasId: "canvas-b" } }));
    settings.resolve({ readMedia: true } as OptimizationSettings); await h.flush();
    expect(h.requests[1].context.prompt).toBe("original prompt");
    expect(h.optimize.mock.calls[1][3]).toMatchObject({ computeProvider: "comfyui", connection: { baseUrl: "https://current.example" } });
    expect(h.requests[1].textOnly).toBe(false);
    expect(h.requests.every(request => !request.signal.aborted)).toBe(true);
    h.requests[0].resolve(optimized("RH optimized")); await b;
    expect(h.requests[1].signal.aborted).toBe(false);
    h.requests[1].resolve(optimized("AutoDL optimized")); await a;
    expect(h.node("canvas-a").data.generation!.prompt).toBe("AutoDL optimized");
    expect(h.node("canvas-b").data.generation!.prompt).toBe("RH optimized");
  });

  it("keeps stable idle snapshots and a pending job after every UI observer unmounts", async () => {
    const h = harness(), ui = vi.fn(), stop = h.registry.subscribe(ui);
    expect(h.registry.get(scope)).toBe(h.registry.get(scope));
    const running = h.registry.start(scope); await h.flush();
    const pending = h.registry.get(scope);
    expect(pending.loading).toBe(true); expect(pending).toBe(h.registry.get(scope));
    stop(); h.change(state => ({ ...state, selectedId: null }));
    const notifications = ui.mock.calls.length;
    expect(h.requests[0].signal.aborted).toBe(false);
    h.requests[0].resolve(optimized()); await running;
    expect(ui).toHaveBeenCalledTimes(notifications);
    expect(h.node().data.generation!.prompt).toBe("optimized prompt");
    expect(h.registry.get(scope)).toMatchObject({ loading: false, result: { prompt: "optimized prompt" } });
    expect(h.drafts.get(h.registry.key(scope))).toEqual({ original: "original prompt", optimized: "optimized prompt", version: "optimized" });
    const returningUi = vi.fn(), unsubscribe = h.registry.subscribe(returningUi);
    expect(h.registry.get(scope).result?.prompt).toBe("optimized prompt"); unsubscribe();
  });
  it("finishes on the original inactive canvas after selection, viewport and unrelated edits", async () => {
    const h = harness(), running = h.registry.start(scope); await h.flush();
    h.change(state => ({ ...state, selectedId: "other", selectedEdgeId: "edge", project: { ...state.project, activeCanvasId: "canvas-b", canvases: state.project.canvases.map(canvas => ({ ...canvas, viewport: { x: 200, y: -500, zoom: 0.4 }, nodes: canvas.nodes.map(node => node.id === "other" ? { ...node, data: { ...node.data, text: "unrelated edit" } } : { ...node, position: { x: 500, y: 500 }, selected: false }) })) } }));
    expect(h.requests[0].signal.aborted).toBe(false); h.requests[0].resolve(optimized()); await running;
    expect(h.node("canvas-a").data.generation!.prompt).toBe("optimized prompt");
    expect(h.node("canvas-b").data.generation!.prompt).toBe("canvas B prompt");
    expect(h.patchNode).toHaveBeenCalledWith("node", expect.any(Object), "canvas-a");
    expect(h.checkpoint).toHaveBeenLastCalledWith("canvas-a");
    h.registry.switchVersion(scope, "original"); expect(h.node("canvas-a").data.generation!.prompt).toBe("original prompt");
    h.registry.switchVersion(scope, "optimized"); expect(h.node("canvas-a").data.generation!.prompt).toBe("optimized prompt");
    expect(h.checkpoint.mock.calls).toEqual([["canvas-a"], ["canvas-a"], ["canvas-a"]]);
  });
  it("continues settings and context collection after the editor is hidden", async () => {
    const h = harness(), settings = deferred<OptimizationSettings>(); h.settings.mockReturnValueOnce(settings.promise);
    const running = h.registry.start(scope);
    const settingsSignal = h.settings.mock.calls[0][0];
    h.change(state => ({ ...state, selectedId: null, project: { ...state.project, activeCanvasId: "canvas-b" } }));
    expect(settingsSignal?.aborted).toBe(false);
    settings.resolve({ readMedia: true } as OptimizationSettings); await h.flush();
    expect(h.collect.mock.calls[0][0].id).toBe("canvas-a");
    h.requests[0].resolve(optimized()); await running;
    expect(h.node().data.generation!.prompt).toBe("optimized prompt");
  });
  it("deduplicates starts for one scope without cancelling or resetting its pending result", async () => {
    const h = harness(), running = h.registry.start(scope); await h.flush();
    await h.registry.start(scope); expect(h.optimize).toHaveBeenCalledOnce();
    expect(h.registry.get(scope).loading).toBe(true); h.requests[0].resolve(optimized()); await running;
  });
});

describe("background jobs reject actual input changes", () => {
  it.each(["prompt", "prompt-changed-back", "workflow", "parameters", "reference", "reference-role", "edge-remove", "upstream-text", "connection-url", "connection-token", "delete-node", "delete-canvas", "close-project", "switch-project"])("cancels on %s and ignores a late model response", async reason => {
    const h = harness();
    if (reason === "upstream-text") h.change(state => ({ ...state, project: { ...state.project, canvases: state.project.canvases.map(canvas => canvas.id !== "canvas-a" ? canvas : { ...canvas, nodes: canvas.nodes.map(node => node.id !== "reference" ? node : { ...node, data: { ...node.data, kind: "text", assetId: undefined, text: "connected original" } }) }) } }));
    const running = h.registry.start(scope); await h.flush();
    if (reason.startsWith("prompt")) {
      h.patchNode("node", { generation: { ...h.node().data.generation!, prompt: "new user draft" } }, "canvas-a");
      if (reason === "prompt-changed-back") h.patchNode("node", { generation: { ...h.node().data.generation!, prompt: "original prompt" } }, "canvas-a");
    }
    if (reason === "workflow") h.change(state => ({ ...state, workflows: state.workflows.map(item => ({ ...item, mode: "different-task" })) }));
    if (reason === "parameters") h.patchNode("node", { generation: { ...h.node().data.generation!, params: { seed: 43 } } }, "canvas-a");
    if (reason === "reference") h.change(state => ({ ...state, project: { ...state.project, assets: { ...state.project.assets, portrait: { ...state.project.assets.portrait, size: 11 } } } }));
    if (reason === "reference-role" || reason === "edge-remove") h.change(state => ({ ...state, project: { ...state.project, canvases: state.project.canvases.map(canvas => canvas.id !== "canvas-a" ? canvas : { ...canvas, edges: reason === "edge-remove" ? [] : canvas.edges.map(edge => ({ ...edge, data: { ...edge.data, order: 0, role: "styleReference" } })) }) } }));
    if (reason === "upstream-text") h.patchNode("reference", { text: "changed source text" }, "canvas-a");
    if (reason === "connection-url") h.change(state => ({ ...state, connection: { ...state.connection, baseUrl: "https://another.example" } }));
    if (reason === "connection-token") h.change(state => ({ ...state, connection: { ...state.connection, token: "changed-private-token" } }));
    if (reason === "delete-node") h.change(state => ({ ...state, project: { ...state.project, canvases: state.project.canvases.map(canvas => canvas.id === "canvas-a" ? { ...canvas, nodes: canvas.nodes.filter(node => node.id !== "node") } : canvas) } }));
    if (reason === "delete-canvas") h.change(state => ({ ...state, project: { ...state.project, canvases: state.project.canvases.filter(canvas => canvas.id !== "canvas-a") } }));
    if (reason === "close-project") h.change(state => ({ ...state, projectOpen: false }));
    if (reason === "switch-project") h.change(state => ({ ...state, project: { ...state.project, id: "another-project" } }));
    expect(h.requests[0].signal.aborted).toBe(true); expect(h.registry.get(scope).loading).toBe(false);
    h.requests[0].resolve(optimized("late overwrite")); await running;
    expect(h.registry.get(scope).result).toBeNull(); expect(h.checkpoint).not.toHaveBeenCalled();
    const originalNode = h.read().project.canvases.find(canvas => canvas.id === "canvas-a")?.nodes.find(node => node.id === "node");
    expect(originalNode?.data.generation?.prompt).not.toBe("late overwrite");
    expect(h.drafts.get(h.registry.key(scope))?.original).toBe(reason === "prompt" ? "new user draft" : "original prompt");
  });
  it("ignores the first cancelled job's result and finally while a replacement job is still running", async () => {
    const h = harness(), old = h.registry.start(scope); await h.flush(); h.registry.cancel(scope);
    expect(h.requests[0].signal.aborted).toBe(true);
    const replacement = h.registry.start(scope); await h.flush();
    h.requests[0].resolve(optimized("stale")); await old;
    expect(h.registry.get(scope).loading).toBe(true); expect(h.registry.get(scope).result).toBeNull();
    expect(h.requests[1].signal.aborted).toBe(false); expect(h.node().data.generation!.prompt).toBe("original prompt");
    h.requests[1].resolve(optimized("new result")); await replacement;
    expect(h.node().data.generation!.prompt).toBe("new result");
  });
  it("keeps a background failure available when its editor is reopened, preserving the original draft", async () => {
    const h = harness(), running = h.registry.start(scope); await h.flush();
    h.change(state => ({ ...state, selectedId: null })); h.requests[0].reject(new Error("remote model unavailable")); await running;
    expect(h.registry.get(scope)).toMatchObject({ loading: false, error: { message: "remote model unavailable" }, result: null });
    expect(h.node().data.generation!.prompt).toBe("original prompt"); expect(h.drafts.get(h.registry.key(scope))?.original).toBe("original prompt");
    h.change(state => ({ ...state, selectedId: "node" })); expect(h.registry.get(scope).error?.message).toBe("remote model unavailable");
  });
});

describe("background scope ownership", () => {
  it("keeps generation and canvas text editors independent on the same node", async () => {
    const h = harness(), textScope = { ...scope, field: "text" as const };
    const generation = h.registry.start(scope), text = h.registry.start(textScope); await h.flush();
    expect(h.requests).toHaveLength(2);
    h.requests[0].resolve(optimized("optimized generation")); await generation;
    expect(h.requests[1].signal.aborted).toBe(false);
    h.requests[1].resolve(optimized("optimized note")); await text;
    expect(h.node().data.generation).toMatchObject({ prompt: "optimized generation", negativePrompt: "keep negative", params: { seed: 42 }, taskId: null });
    expect(h.node().data.text).toBe("optimized note");
    expect(h.drafts.get(h.registry.key(scope))?.original).toBe("original prompt"); expect(h.drafts.get(h.registry.key(textScope))?.original).toBe("original note");
  });
  it("keeps equal node IDs on separate canvases isolated and supports parallel jobs", async () => {
    const h = harness(), other = { ...scope, canvasId: "canvas-b" };
    const first = h.registry.start(scope), second = h.registry.start(other); await h.flush();
    h.requests[1].resolve(optimized("B optimized")); await second; expect(h.requests[0].signal.aborted).toBe(false);
    h.requests[0].resolve(optimized("A optimized")); await first;
    expect(h.node("canvas-a").data.generation!.prompt).toBe("A optimized"); expect(h.node("canvas-b").data.generation!.prompt).toBe("B optimized");
  });
  it("releases background guards on completion or cancellation, while UI unsubscribe does not own them", async () => {
    const h = harness(); expect(h.stateListeners.size).toBe(1);
    const ui = h.registry.subscribe(() => {}), running = h.registry.start(scope); await h.flush(); expect(h.stateListeners.size).toBe(2);
    ui(); expect(h.stateListeners.size).toBe(2); h.requests[0].resolve(optimized()); await running; expect(h.stateListeners.size).toBe(1);
    const next = h.registry.start(scope); await h.flush(); h.registry.cancel(scope); expect(h.stateListeners.size).toBe(1);
    h.requests[1].resolve(optimized("discard")); await next; h.registry.dispose(); expect(h.stateListeners.size).toBe(0);
  });
});
